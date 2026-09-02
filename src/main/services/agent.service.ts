import * as path from "path";
import * as crypto from "crypto";
import { eq, asc, desc } from "drizzle-orm";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { EVENTS } from "../events";
import { getDb, saveDatabase } from "../db";
import { agentConversations, agentMessages, agentToolCalls } from "../db/schema/agent";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { inboxMessages } from "../db/schema/inbox";
import {
  runHarnessTurn, resolveApproval, rejectPendingFor, hasPending,
  type PushFn, type ChatMsg, type TurnOutcome,
} from "./agent/harness";

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

/** 每次请求携带的历史条数上限（system 除外），防上下文膨胀 */
const HISTORY_LIMIT = 30;

/** 单回合墙钟硬上限：模型端点挂起/流停滞时看门狗强制中断，杜绝永久加载态 */
const TURN_HARD_LIMIT_MS = 150_000;

// ── Provider 配置 ────────────────────────────────────────

interface ProviderConfig {
  mode: "mock" | "live";
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 生效端点：统一走 endpoint.service 解析（界面激活 profile 后立即变化，无需重启）。
 *  live 需同时具备 BASE_URL + KEY，否则回落 mock。 */
function getProviderConfig(): ProviderConfig {
  const e = readActiveEndpoint();
  if (e.baseUrl && e.apiKey) return { mode: "live", baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model };
  return { mode: "mock", baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model };
}

/** 配置状态（不含密钥值），供 UI 显示模式横幅 */
export function status(): Result<{ mode: "mock" | "live"; model: string; hasBaseUrl: boolean; hasKey: boolean; thinking: boolean }> {
  const c = getProviderConfig();
  return okResult({
    mode: c.mode, model: c.model, hasBaseUrl: !!c.baseUrl, hasKey: !!c.apiKey,
    thinking: readActiveEndpoint().thinking,
  });
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

function appendMessage(convId: string, role: "user" | "assistant", content: string): void {
  const db = getDb();
  db.insert(agentMessages).values({ conversationId: convId, role, content, createdAt: nowIso() }).run();
  db.update(agentConversations).set({ updatedAt: nowIso() }).where(eq(agentConversations.id, convId)).run();
  saveDatabase();
}

/** 读会话消息（asc），仅带最近 HISTORY_LIMIT 条进上下文 */
function loadHistory(convId: string): ChatMsg[] {
  const rows = getDb().select().from(agentMessages)
    .where(eq(agentMessages.conversationId, convId))
    .orderBy(asc(agentMessages.id)).all();
  return rows.slice(-HISTORY_LIMIT).map(r => ({ role: r.role as "user" | "assistant", content: r.content }));
}

// ── Mock Provider：端点未配置时模拟流式，用于打通/演示链路 ──

async function streamMock(sessionId: string, userText: string, push: PushFn, signal: AbortSignal): Promise<string> {
  const full = [
    "（Mock 模式 — 没有可用的模型端点）",
    "",
    `我收到了你的消息：「${userText.slice(0, 200)}」，以下是模拟回复。`,
    "",
    "到「设置 → 模型与端点」新增一个端点（Agnes / DeepSeek / 本地 Ollama / 公司中转 都有模板），",
    "填好密钥后点「启用」——回到这个对话立刻生效，不需要重启应用。",
    "",
    "（想手改配置也可以：项目根目录 .env 里的 AGENT_API_BASE_URL / AGENT_API_KEY / AGENT_MODEL）",
  ].join("\n");
  for (let i = 0; i < full.length; i += 6) {
    if (signal.aborted) return full.slice(0, i);
    push(EVENTS.AGENT_CHUNK, { conversationId: sessionId, delta: full.slice(i, i + 6) });
    await new Promise(r => setTimeout(r, 20));
  }
  return full;
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
    const msg = db.select({ subject: inboxMessages.subject, fromEmail: inboxMessages.fromEmail })
      .from(inboxMessages).where(eq(inboxMessages.id, id)).get();
    return msg ? `邮件 #${id}「${msg.subject || "(无主题)"}」来自 ${msg.fromEmail}` : undefined;
  } catch (err) {
    Log.warn("agent.chat", `解析上下文失败 ${ctxRaw}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** 发起一轮对话。立即返回会话/消息 ID，正文与结束/错误状态走事件推送。 */
export function chat(push: PushFn, input: ChatInput): Result<{ conversationId: string; messageId: string }> {
  const text = input?.text?.trim();
  if (!text) return failResult("参数错误: text 必填");

  // live 但模型名没填 → 直接说清楚，别让端点回一个看不懂的 400/404（也不留下半截用户消息）
  const cfg0 = getProviderConfig();
  if (cfg0.mode === "live" && !cfg0.model) {
    return failResult("模型名未填：请到「设置 → 模型与端点」给当前端点补上 Model（如 gemini-2.5-flash、deepseek-chat）");
  }

  const conversationId = input.conversationId?.trim() || crypto.randomUUID();
  const messageId = crypto.randomUUID();

  ensureConversation(conversationId, text);
  appendMessage(conversationId, "user", text);

  let rt = runtime.get(conversationId);
  if (!rt) { rt = { abort: null, running: false }; runtime.set(conversationId, rt); }
  if (rt.running) return failResult("上一轮回答仍在进行中，请先停止");
  const state = rt;

  // 异步流式回合（不阻塞 IPC 返回）
  void (async () => {
    state.running = true;
    state.abort = new AbortController();
    // 墙钟看门狗：端点挂起/流停滞时最迟 TURN_HARD_LIMIT_MS 强制中断，
    // 消灭「永久转圈」。用户手动停止走同一 abort 通道，用 timedOut 区分语义。
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      Log.warn("agent.chat", `回合超时强制中断 conv=${conversationId.slice(0, 8)}（${TURN_HARD_LIMIT_MS / 1000}s）`);
      state.abort?.abort();
    }, TURN_HARD_LIMIT_MS);
    const cfg = getProviderConfig();
    Log.debug("agent.chat", `回合开始 conv=${conversationId.slice(0, 8)} mode=${cfg.mode}`);
    try {
      let answer = "";
      let outcomeUsage: TurnOutcomeUsage | undefined;
      if (cfg.mode === "mock") {
        answer = await streamMock(conversationId, text, push, state.abort.signal);
      } else {
        // live：harness 自带系统提示词（L0 规则）与工具集；历史只带 user/assistant 正文
        const outcome = await runHarnessTurn({
          baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
          history: loadHistory(conversationId),
          conversationId, push, signal: state.abort.signal,
          contextNote: resolveContextNote(input.context),
        });
        if (outcome.kind === "approval") { outcomeUsage = outcome.usage; return; } // 写操作等人工确认；续跑收尾在 resolveApprovalRequest
        answer = outcome.text;
        outcomeUsage = outcome.usage;
        if (outcome.usage) {
          totals.requests += outcome.usage.requests; totals.input += outcome.usage.input;
          totals.output += outcome.usage.output; totals.cached += outcome.usage.cached; totals.turns += 1;
          Log.info("agent.usage", `conv=${conversationId.slice(0, 8)} 调用${outcome.usage.requests}次 in=${outcome.usage.input} out=${outcome.usage.output} 缓存命中=${outcome.usage.cached}`);
        }
      }
      if (answer) appendMessage(conversationId, "assistant", answer);
      push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: state.abort.signal.aborted, usage: outcomeUsage });
    } catch (err: unknown) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      if (timedOut) {
        // 看门狗触发：明确告诉用户是端点卡住被强制中断，而非正常"停止"
        push(EVENTS.AGENT_ERROR, {
          conversationId,
          message: `模型响应超时，已强制中断（超过 ${Math.round(TURN_HARD_LIMIT_MS / 1000)} 秒无输出）。可在「设置」换用更稳定的端点。`,
        });
      } else if (aborted) {
        push(EVENTS.AGENT_DONE, { conversationId, messageId, stopped: true });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        Log.error("agent.chat", `模型调用失败 ${cfg.mode}`, err instanceof Error ? (err.stack ?? msg) : msg);
        push(EVENTS.AGENT_ERROR, { conversationId, message: cfg.mode === "live" ? `模型调用失败: ${msg}` : msg });
      }
    } finally {
      clearTimeout(watchdog);
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
  if (cfg.mode !== "live") return failResult("模型端点未配置");
  // 续跑同样受墙钟保护 + 异常显式推送，避免 rejected promise 被吞、UI 永远等待
  const ac = new AbortController();
  const watchdog = setTimeout(() => ac.abort(), TURN_HARD_LIMIT_MS);
  try {
    const outcome = await resolveApproval(approvalId, !!input.approved, {
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
      history: [], conversationId: "", push, signal: ac.signal,
    });
    if (outcome.kind === "approval") return okResult({ resumed: false });
    if (outcome.text) appendMessage(outcome.conversationId, "assistant", outcome.text);
    if (outcome.usage) {
      totals.requests += outcome.usage.requests; totals.input += outcome.usage.input;
      totals.output += outcome.usage.output; totals.cached += outcome.usage.cached; totals.turns += 1;
    }
    push(EVENTS.AGENT_DONE, { conversationId: outcome.conversationId, messageId: "", stopped: false, usage: outcome.usage });
    return okResult({ resumed: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.error("agent.approval", "续跑失败", err instanceof Error ? (err.stack ?? msg) : msg);
    push(EVENTS.AGENT_ERROR, { conversationId: "", message: ac.signal.aborted ? "续跑超时，已中断" : `续跑失败: ${msg}` });
    return failResult(msg);
  } finally {
    clearTimeout(watchdog);
  }
}

// ── 会话管理（左侧历史列表）──────────────────────────────

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export function listConversations(): Result<ConversationMeta[]> {
  const rows = getDb().select().from(agentConversations)
    .orderBy(desc(agentConversations.updatedAt)).all();
  return okResult(rows.map(r => ({ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt })));
}

export interface MessageDto { role: string; content: string; createdAt: string }

export function getMessages(conversationId: string): Result<MessageDto[]> {
  if (!conversationId) return failResult("参数错误: conversationId 必填");
  const rows = getDb().select().from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.id)).all();
  return okResult(rows.map(r => ({ role: r.role, content: r.content, createdAt: r.createdAt })));
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
  db.delete(agentConversations).where(eq(agentConversations.id, conversationId)).run();
  saveDatabase();
  runtime.delete(conversationId);
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
