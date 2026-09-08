import * as path from "path";
import * as crypto from "crypto";
import { eq, asc, desc, count, isNull, isNotNull, and } from "drizzle-orm";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { EVENTS } from "../events";
import { getDb, saveDatabase } from "../db";
import { agentConversations, agentMessages, agentToolCalls, agentFacts } from "../db/schema/agent";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { inboxMessages, inboxBounceMatches } from "../db/schema/inbox";
import {
  runHarnessTurn, resolveApproval, rejectPendingFor, hasPending,
  DEFAULT_PROFILE, type PushFn, type TurnOutcome,
} from "./agent/harness";
import { toolLabelMap, toolFollowUpMap } from "./agent/manifest";
import { reflectOnNumbers, selfCorrectNumbers } from "./agent/reflector";
import { readLocalBodyHtml, htmlToText } from "./inbox.service";
import { composeEmailNote } from "./agent/email-context";

type TurnOutcomeUsage = TurnOutcome["usage"];
import { executeAction, dropActionsForConversation } from "./agent/actions";
import { readActiveEndpoint } from "./endpoint.service";

export type { PushFn };

// .env 加载（与 ai.service 同源，dotenv 幂等，双处调用无冲突）
import * as dotenv from "dotenv";
dotenv.config({ path: path.join(APP_ROOT, ".env") });

// ── 会话存储：消息正文落库（agent_conversations / agent_messages），
//    运行态（中断控制器/防重入标志/待审批 RunState）仅存内存，重启自然清零 ──

interface RuntimeState {
  abort: AbortController | null;
  running: boolean;
}

const runtime = new Map<string, RuntimeState>();

// ── 本次运行的 token 累计（端点回 usage 才计，不猜数）──
export interface TokenTotals { requests: number; input: number; output: number; cached: number; turns: number }
const totals: TokenTotals = { requests: 0, input: 0, output: 0, cached: 0, turns: 0 };

/** 累计用量快照：设置页与评测据此换算成本，避免"感觉贵/感觉便宜"式争论 */
export function tokenTotals(): Result<TokenTotals> {
  return okResult({ ...totals });
}

/** 每次请求携带的历史条数上限在记忆模块维护（agent/memory.ts），此处仅转出口 */
export { HISTORY_LIMIT } from "./agent/memory";
import { loadConversation } from "./agent/memory";

/** 静默上限：连续这么久没有任何事件产出（流增量/工具过程/任务进度）才强制中断，杜绝永久加载态；
 *  有产出就重新计时 —— 只掐真挂起，不腰斩勤快干活的多步长任务 */
const TURN_IDLE_LIMIT_MS = 150_000;

// ── Provider 配置 ────────────────────────────────────────

interface ProviderConfig {
  /** 是否已配好可用端点；未配好时对话直接失败并给出指引（不再有假流式 Mock） */
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 生效端点：统一走 endpoint.service 解析（界面激活 profile 后立即变化，无需重启）。
 *  需同时具备 BASE_URL + KEY 才算就绪；未就绪时对话直接失败并给出配置指引。 */
function getProviderConfig(): ProviderConfig {
  const e = readActiveEndpoint();
  return { configured: !!(e.baseUrl && e.apiKey), baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model };
}

/** 配置状态（不含密钥值），供 UI 显示模式横幅 */
export function status(): Result<{ configured: boolean; model: string; baseUrl: string; identityOk: boolean }> {
  const c = getProviderConfig();
  return okResult({
    configured: c.configured, model: c.model, baseUrl: c.baseUrl,
    // 身份已固定为运去哪 agent 助手（恒有效），字段保留供前端状态聚合
    identityOk: true,
  });
}

/** 工具元数据（UI 中文名 + 追问引导）：从注册表派生，渲染端不再维护第二份工具清单 */
export function toolMeta(): Result<{ labels: Record<string, string>; followUps: Record<string, string[]> }> {
  return okResult({ labels: toolLabelMap(), followUps: toolFollowUpMap() });
}

// ── 会话读写 ─────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

/** 会话不存在则创建，标题取首条用户消息前 24 字（豆包式自动命名） */
function ensureConversation(id: string, firstUserText: string): void {
  const db = getDb();
  const existing = db.select().from(agentConversations).where(eq(agentConversations.id, id)).get();
  if (existing) return;
  const title = firstUserText.replace(/\s+/g, " ").trim().slice(0, 24) || "新对话";
  const now = nowIso();
  db.insert(agentConversations).values({ id, title, createdAt: now, updatedAt: now }).run();
  saveDatabase();
}

function appendMessage(convId: string, role: "user" | "assistant" | "error", content: string): void {
  const db = getDb();
  db.insert(agentMessages).values({ conversationId: convId, role, content, createdAt: nowIso() }).run();
  db.update(agentConversations).set({ updatedAt: nowIso() }).where(eq(agentConversations.id, convId)).run();
  saveDatabase();
}

// ── 对外：发起对话 / 停止 / 审批回执 ─────────────────────────────

export interface ChatInput {
  conversationId?: string;
  text: string;
  /** 页面上下文锚点，格式 `contact:12` / `company:3` / `message:45`；服务端解析成中文注记注入指令 */
  context?: string;
}

/** 解析页面上下文锚点 → 人话注记。实体不存在时返回 undefined（不阻塞对话）。 */
function resolveContextNote(ctxRaw: string | undefined): string | undefined {
  const m = /^(contact|company|message):(\d+)$/.exec((ctxRaw || "").trim());
  if (!m) return undefined;
  const kind = m[1]!;
  const id = Number(m[2]);
  try {
    const db = getDb();
    if (kind === "contact") {
      const r = db.select({
        firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
        companyId: contacts.companyId, stage: contacts.stage,
      }).from(contacts).where(eq(contacts.id, id)).get();
      if (!r) return undefined;
      const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email;
      const company = r.companyId
        ? db.select({ name: companies.name }).from(companies).where(eq(companies.id, r.companyId)).get()?.name
        : undefined;
      return `联系人 #${id} ${name}${company ? `（${company}）` : ""}${r.stage ? `，阶段 ${r.stage}` : ""}`;
    }
    if (kind === "company") {
      const c = db.select({ name: companies.name, country: companies.country }).from(companies)
        .where(eq(companies.id, id)).get();
      return c ? `公司 #${id} ${c.name}${c.country ? `（${c.country}）` : ""}` : undefined;
    }
    const msg = db.select({
      subject: inboxMessages.subject, fromEmail: inboxMessages.fromEmail, fromName: inboxMessages.fromName,
      bodyPreview: inboxMessages.bodyPreview, classification: inboxMessages.classification,
      receivedAt: inboxMessages.receivedAt, matchedContactId: inboxMessages.matchedContactId,
    }).from(inboxMessages).where(eq(inboxMessages.id, id)).get();
    if (!msg) return undefined;
    // 上下文必须带正文（模型手里没有内容就会自己去「找资料」，实测它会拿 company_backcheck 凑）；
    // 但标注必须与实给内容一致——注记组装在 email-context（纯函数，有单测钉三种口径），
    // 全文优先读本地落盘正文（纯 fs 毫秒级），拿不到就如实标「仅为预览，先 email_read_full」。
    const localHtml = readLocalBodyHtml(id);
    const who = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail;
    // 被退联系人可能多个（一封群发退信）：不给全，助手就只见单列那一个
    const matchIds = [...new Set([
      ...db.select({ cid: inboxBounceMatches.contactId }).from(inboxBounceMatches)
        .where(eq(inboxBounceMatches.messageId, id)).all().map(r => r.cid),
      ...(msg.matchedContactId ? [msg.matchedContactId] : []),
    ])];
    return composeEmailNote({
      id, subject: msg.subject, who, classification: msg.classification,
      receivedAt: msg.receivedAt, matchIds,
      bodyPreview: msg.bodyPreview,
      fullText: localHtml ? htmlToText(localHtml) : null,
    });
  } catch (err) {
    Log.warn("agent.chat", `解析上下文失败 ${ctxRaw}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** 发起一轮对话。立即返回会话/消息 ID，正文与结束/错误状态走事件推送。 */
export async function chat(push: PushFn, input: ChatInput): Promise<Result<{ conversationId: string; messageId: string }>> {
  const text = input?.text?.trim();
  if (!text) return failResult("参数错误: text 必填");

  // 配置不全时立刻失败并指路：不静默降级、也不留下半截用户消息
  const cfg0 = getProviderConfig();
  if (!cfg0.configured) {
    return failResult("未配置模型端点：请到「设置 → 模型与端点」新增端点、填入密钥并启用（Base URL / 模型名都要有）");
  }
  if (!cfg0.model) {
    return failResult("模型名未填：请到「设置 → 模型与端点」给当前端点补上 Model（如 gemini-2.5-flash、deepseek-chat）");
  }

  const conversationId = input.conversationId?.trim() || crypto.randomUUID();
  const messageId = crypto.randomUUID();

  // 豆包式插队（用户拍板）：生成中来新消息 → 立即打断当前回答（已生成内容保留），
  // 等它落定后接着处理新消息，不排队不给缓冲。打断必须发生在新用户消息落库之前，
  // 否则旧回合的 done 事件会晚于新消息，现场顺序就乱了。
  let rt = runtime.get(conversationId);
  if (!rt) { rt = { abort: null, running: false }; runtime.set(conversationId, rt); }
  if (rt.running) {
    rt.abort?.abort();
    const t0 = Date.now();
    while (rt.running && Date.now() - t0 < 5000) {
      await new Promise(r => setTimeout(r, 25));
    }
    if (rt.running) return failResult("打断上一轮超时，请稍后重试");
  }

  ensureConversation(conversationId, text);
  appendMessage(conversationId, "user", text);

  const state = rt;

  // 异步流式回合（不阻塞 IPC 返回）
  void (async () => {
    state.running = true;
    state.abort = new AbortController();
    // 静默看门狗：只在「连续 TURN_IDLE_LIMIT_MS 没有任何事件产出」时强制中断（端点真挂起），
    // 每次推送都重新计时 —— 合法的多步长任务不再被整回合墙钟腰斩。手动停止走同一 abort 通道。
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        Log.warn("agent.chat", `回合静默超时强制中断 conv=${conversationId.slice(0, 8)}（${TURN_IDLE_LIMIT_MS / 1000}s 无输出）`);
        state.abort?.abort();
      }, TURN_IDLE_LIMIT_MS);
    };
    armIdle();
    /** 带心跳的推送器：任何产出都算"还在干活" */
    const touchPush: PushFn = (channel, data) => { armIdle(); push(channel, data); };
    const cfg = getProviderConfig();
    Log.debug("agent.chat", `回合开始 conv=${conversationId.slice(0, 8)} model=${cfg.model || "（未填）"}`);
    try {
      let answer = "";
      let toolOutputs: string[] = [];
      let outcomeUsage: TurnOutcomeUsage | undefined;
      let cappedFlag = false;
      {
        // harness 自带系统提示词（L0 规则）与工具集；历史只带 user/assistant 正文
        const outcome = await runHarnessTurn(DEFAULT_PROFILE, {
          baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
          history: await loadConversation(conversationId),
          conversationId, push: touchPush, signal: state.abort.signal,
          contextNote: resolveContextNote(input.context),
        });
        if (outcome.kind === "approval") { outcomeUsage = outcome.usage; return; } // 写操作等人工确认；续跑收尾在 resolveApprovalRequest
        answer = outcome.text;
        toolOutputs = outcome.toolOutputs ?? [];
        outcomeUsage = outcome.usage;
        if (outcome.capped) cappedFlag = true;
        if (outcome.usage) {
          totals.requests += outcome.usage.requests; totals.input += outcome.usage.input;
          totals.output += outcome.usage.output; totals.cached += outcome.usage.cached; totals.turns += 1;
          Log.info("agent.usage", `conv=${conversationId.slice(0, 8)} 调用${outcome.usage.requests}次 in=${outcome.usage.input} out=${outcome.usage.output} 缓存命中=${outcome.usage.cached}`);
        }
      }
      // 反思校验：正文里的数量必须回溯得到本轮工具返回；对不上先自纠一次，
      // 纠后仍对不上就文末附注 —— 绝不静默放行，也不做校验死循环。
      // 只在本轮真调过工具时校验（纯闲聊没有数据依据，查了全是误伤）。
      // 用户输入里出现过的数字天然豁免（如用户自己说"8714 个联系人"，不能被纠成「若干」）。
      if (answer && toolOutputs.length && !state.abort.signal.aborted) {
        const bad = reflectOnNumbers(answer, toolOutputs, [text]);
        if (bad.length) {
          Log.warn("agent.reflect", `conv=${conversationId.slice(0, 8)} 数量回溯不过（${bad.join("、")}），尝试自纠`);
          const fixed = await selfCorrectNumbers(answer, bad, toolOutputs);
          if (fixed && reflectOnNumbers(fixed, toolOutputs, [text]).length === 0) {
            // 自纠成功：落库与推送各留一份终稿；推送只发一行更正说明，不整篇重发
            answer = fixed;
            const delta = `\n\n（已按工具数据更正正文中的：${bad.slice(0, 3).join("、")}。）`;
            push(EVENTS.AGENT_CHUNK, { conversationId, delta });
            Log.info("agent.reflect", `conv=${conversationId.slice(0, 8)} 自纠成功，正文已替换`);
          } else {
            const delta = `\n\n（注：正文中「${bad.slice(0, 3).join("、")}」等数量未能与工具数据核对一致，请以工具结果卡为准。）`;
            answer += delta;
            push(EVENTS.AGENT_CHUNK, { conversationId, delta });
          }
        }
      }
      if (answer) appendMessage(conversationId, "assistant", answer);
      push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: state.abort.signal.aborted, usage: outcomeUsage, ...(cappedFlag ? { capped: true } : {}) });
    } catch (err: unknown) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      if (timedOut) {
        // 看门狗触发：明确告诉用户是端点卡住被强制中断，而非正常"停止"
        const msg = `模型响应超时，已强制中断（超过 ${Math.round(TURN_IDLE_LIMIT_MS / 1000)} 秒无输出）。可在「设置」换用更稳定的端点。`;
        appendMessage(conversationId, "error", msg);
        push(EVENTS.AGENT_ERROR, { conversationId, message: msg });
      } else if (aborted) {
        push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: true });
      } else if ((err as { name?: string })?.name === "MaxTurnsExceededError"
        || /max\s*turns/i.test(err instanceof Error ? err.message : "")) {
        // 回合步数用尽 = 程序内部刹车，不该是报错脸：续一句自然收尾，按完成处理
        Log.warn("agent.chat", `conv=${conversationId.slice(0, 8)} 达 maxTurns，优雅收尾`);
        push(EVENTS.AGENT_CHUNK, { conversationId, delta: "\n\n这轮先说到这里 — 要接着做的话，回一句「继续」即可。" });
        push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: false });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        Log.error("agent.chat", "模型调用失败", err instanceof Error ? (err.stack ?? msg) : msg);
        const shown = `模型调用失败: ${msg}`;
        appendMessage(conversationId, "error", shown);
        push(EVENTS.AGENT_ERROR, { conversationId, message: shown });
      }
    } finally {
      clearTimeout(idleTimer);
      state.running = false;
      state.abort = null;
    }
  })();

  return okResult({ conversationId, messageId });
}

/** 中断指定会话的生成。无进行中回合时也算成功（幂等）。同时作废该会话待审批的写操作。 */
export function stop(conversationId: string): Result<void> {
  const rt = runtime.get(conversationId);
  if (rt?.abort) {
    Log.debug("agent.stop", conversationId.slice(0, 8));
    rt.abort.abort();
  }
  rejectPendingFor(conversationId);
  return okResult(undefined);
}

export interface ApprovalInput { approvalId?: string; approved?: boolean; }

/** 渲染端审批结论 → harness 恢复执行。续跑完成落消息 + DONE；链式再审批则继续等确认。 */
export async function resolveApprovalRequest(push: PushFn, input: ApprovalInput): Promise<Result<{ resumed: boolean }>> {
  const approvalId = input?.approvalId?.trim();
  if (!approvalId) return failResult("参数错误: approvalId 必填");
  if (!hasPending(approvalId)) return failResult("审批已不存在（可能已停止或重启作废）");
  const cfg = getProviderConfig();
  if (!cfg.configured) return failResult("未配置模型端点：请到「设置 → 模型与端点」配置并启用一个端点");
  // 续跑同样用静默计时保护（有产出就续命，只掐真挂起）+ 异常显式推送，避免 rejected promise 被吞、UI 永远等待
  const ac = new AbortController();
  let resumeIdle: ReturnType<typeof setTimeout> | undefined;
  const armResume = () => { clearTimeout(resumeIdle); resumeIdle = setTimeout(() => ac.abort(), TURN_IDLE_LIMIT_MS); };
  armResume();
  const touchPush: PushFn = (channel, data) => { armResume(); push(channel, data); };
  try {
    const outcome = await resolveApproval(approvalId, !!input.approved, {
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      history: [], conversationId: "", push: touchPush, signal: ac.signal,
    });
    if (outcome.kind === "approval") return okResult({ resumed: false });
    if (outcome.text) appendMessage(outcome.conversationId, "assistant", outcome.text);
    if (outcome.usage) {
      totals.requests += outcome.usage.requests; totals.input += outcome.usage.input;
      totals.output += outcome.usage.output; totals.cached += outcome.usage.cached; totals.turns += 1;
    }
    push(EVENTS.AGENT_DONE, { conversationId: outcome.conversationId, messageId: "", stopped: false, usage: outcome.usage, ...(outcome.capped ? { capped: true } : {}) });
    return okResult({ resumed: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.error("agent.approval", "续跑失败", err instanceof Error ? (err.stack ?? msg) : msg);
    push(EVENTS.AGENT_ERROR, { conversationId: "", message: ac.signal.aborted ? "续跑超时，已中断" : `续跑失败: ${msg}` });
    return failResult(msg);
  } finally {
    clearTimeout(resumeIdle);
  }
}

// ── 会话管理（左侧历史列表）──────────────────────────────

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数：管理页用来判断哪段值得留、哪段可以清 */
  messageCount: number;
}

export function listConversations(): Result<ConversationMeta[]> {
  const db = getDb();
  const rows = db.select().from(agentConversations)
    .where(isNull(agentConversations.archivedAt))          // 归档会话只出现在设置页归档区
    .orderBy(desc(agentConversations.updatedAt)).all();
  return okResult(withMessageCounts(rows));
}

/** 归档区列表（设置页「归档会话」）：只回 archivedAt 非空的会话 */
export function listArchivedConversations(): Result<ConversationMeta[]> {
  const db = getDb();
  const rows = db.select().from(agentConversations)
    .where(isNotNull(agentConversations.archivedAt))
    .orderBy(desc(agentConversations.archivedAt)).all();
  return okResult(withMessageCounts(rows));
}

/** 会话元数据 + 消息条数（list 两个出口共用） */
function withMessageCounts(rows: Array<{ id: string; title: string; createdAt: string; updatedAt: string }>): ConversationMeta[] {
  const db = getDb();
  const counts = db.select({ conversationId: agentMessages.conversationId, n: count() })
    .from(agentMessages).groupBy(agentMessages.conversationId).all();
  const countByConv = new Map(counts.map(c => [c.conversationId, Number(c.n ?? 0)]));
  return rows.map(r => ({
    id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt,
    messageCount: countByConv.get(r.id) ?? 0,
  }));
}

/** 移入归档（侧栏「删除」的实际动作）：不删任何数据，设置页可恢复或彻底清除 */
export function archiveConversation(conversationId: string): Result<void> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  getDb().update(agentConversations).set({ archivedAt: nowIso() })
    .where(and(eq(agentConversations.id, conversationId), isNull(agentConversations.archivedAt))).run();
  saveDatabase();
  runtime.delete(conversationId);
  Log.debug("agent.archive", conversationId.slice(0, 8));
  return okResult(undefined);
}

/** 从归档恢复到侧栏 */
export function unarchiveConversation(conversationId: string): Result<void> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  getDb().update(agentConversations).set({ archivedAt: null })
    .where(eq(agentConversations.id, conversationId)).run();
  saveDatabase();
  Log.debug("agent.unarchive", conversationId.slice(0, 8));
  return okResult(undefined);
}

/** 批量删除会话：复用单条删除（连同消息/事实/运行态/待审批/未点击动作卡一起清） */
export function deleteConversations(ids: string[]): Result<{ deleted: number }> {
  const list = (ids ?? []).filter((x): x is string => typeof x === "string" && !!x.trim());
  if (!list.length) return failResult("参数错误: 至少选择一个会话");
  for (const id of list) deleteConversation(id);
  return okResult({ deleted: list.length });
}

export interface MessageDto {
  role: string; content: string; createdAt: string;
  /** role=tool 时回带：来自 agent_tool_calls 的审计回放（前端重建过程/产物卡） */
  toolName?: string; argsJson?: string; resultJson?: string;
  /** role=tool 且本次调用失败（参数校验错/执行错）：前端据此画失败态而非「已{动词}」 */
  error?: string;
}

/** 两套时间戳统一按 UTC 解析：消息表是 ISO（…T…Z），审计表默认 CURRENT_TIMESTAMP（无时区） */
function tsOf(s: string): number {
  const n = Date.parse(/[Z+]|\d{2}:?\d{2}$/.test(s) || s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(n) ? 0 : n;
}

export function getMessages(conversationId: string): Result<MessageDto[]> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const db = getDb();
  const rows = db.select().from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.id)).all();
  // 工具过程回放：审计表按会话整取（与消息流按时间交织，页面切回后过程卡/产物卡/失败卡仍在）
  const calls = db.select().from(agentToolCalls)
    .where(eq(agentToolCalls.conversationId, conversationId))
    .orderBy(asc(agentToolCalls.id)).all();
  const merged: Array<MessageDto & { _t: number }> = [
    ...rows.map(r => ({ role: r.role, content: r.content, createdAt: r.createdAt, _t: tsOf(r.createdAt) })),
    ...calls.map(c => ({
      role: "tool", content: "", createdAt: c.createdAt, _t: tsOf(c.createdAt),
      toolName: c.toolName, argsJson: c.argsJson ?? undefined, resultJson: c.resultJson ?? undefined,
      error: c.error ?? undefined,
    })),
  ].sort((a, b) => a._t - b._t);
  return okResult(merged.map(({ _t, ...m }) => m));
}

export function renameConversation(conversationId: string, title: string): Result<void> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const t = title?.trim();
  if (!t) return failResult("标题不能为空");
  const db = getDb();
  const existing = db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)).get();
  if (!existing) return failResult(`会话不存在: ${conversationId.slice(0, 8)}`);
  db.update(agentConversations).set({ title: t.slice(0, 60), updatedAt: nowIso() })
    .where(eq(agentConversations.id, conversationId)).run();
  saveDatabase();
  Log.debug("agent.rename", `${conversationId.slice(0, 8)} → ${t.slice(0, 20)}`);
  return okResult(undefined);
}

export function deleteConversation(conversationId: string): Result<void> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const db = getDb();
  db.delete(agentMessages).where(eq(agentMessages.conversationId, conversationId)).run();
  db.delete(agentFacts).where(eq(agentFacts.conversationId, conversationId)).run();
  db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).run();
  saveDatabase();
  runtime.delete(conversationId);
  // 写操作审批为内存态：会话删除后待审批自然作废（无会话级豁免可清）
  dropActionsForConversation(conversationId);   // 该会话未点击的动作卡一并作废
  Log.debug("agent.delete", conversationId.slice(0, 8));
  return okResult(undefined);
}

/** 结果卡「写入类」动作：闭包留在主进程注册表，前端只回传 id，用户点击才执行 */
export function runAction(actionId: string): Promise<Result<{ label: string; message: string; target?: { label: string; href: string } }>> {
  if (!actionId) return Promise.resolve(failResult("参数错误: actionId 必填"));
  return executeAction(actionId);
}

// ── AI 活动审计（agent_tool_calls 可视化，供设置页排查）──

export interface ToolCallLog {
  id: number;
  conversationId: string;
  toolName: string;
  sideEffect: string;
  argsPreview: string;
  approval: string;
  error: string | null;
  createdAt: string;
}

/** 最近 N 条工具调用记录（新→旧），args 只回摘要，完整参数不外泄到 UI */
export function listToolCalls(limit = 100): Result<ToolCallLog[]> {
  const rows = getDb().select().from(agentToolCalls)
    .orderBy(desc(agentToolCalls.id)).limit(Math.min(Math.max(limit, 1), 300)).all();
  return okResult(rows.map(r => ({
    id: r.id,
    conversationId: r.conversationId,
    toolName: r.toolName,
    sideEffect: r.sideEffect,
    argsPreview: (r.argsJson || "").slice(0, 120),
    approval: r.approval,
    error: r.error,
    createdAt: r.createdAt,
  })));
}
