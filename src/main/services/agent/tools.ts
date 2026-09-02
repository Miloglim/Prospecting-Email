// ── Agent Harness 工具层 ──────────────────────────────────────────
// 每个工具 = @openai/agents tool() + policy 元数据（副作用分级/预算/审批）。
// execute 内强制：预算守卫 → 执行 → 审计落库。write 工具的 needsApproval 由
// SDK 中断流接管，execute 只在人工批准后才可能运行。
import { z } from "zod";
import { eq, like, or, and, desc } from "drizzle-orm";
import { tool } from "@openai/agents";
import { getDb, saveDatabase } from "../../db";
import { contacts } from "../../db/schema/contacts";
import { companies } from "../../db/schema/companies";
import { interactions } from "../../db/schema/interactions";
import { inboxMessages } from "../../db/schema/inbox";
import { emailAccounts } from "../../db/schema/accounts";
import { agentToolCalls } from "../../db/schema/agent";
import { Log } from "../../logger";
import { okResult, failResult } from "../../errors";
import { checkBudget, ToolBudgetError } from "./policy";
import { getBody, markRead } from "../inbox.service";
import { checkReminders, setStage } from "../crm.service";
import { getSendStatus, getQueueItems, startDynamicSend } from "../send.service";
import { summarizeEmail, generateBackcheckReport, generateEmailDraft, searchCompany, type BackcheckReport } from "../ai.service";
import { upsertCompany } from "../company.service";
import { upsertContact } from "../contact.service";
import { upsertTemplate } from "../template.service";
import { registerAction, type ActionCard } from "./actions";
import { lookupIdempotent, rememberResult, forget } from "./idempotency";
import { listQuotes, countQuotes, normalizeContainer } from "../rate-sync.service";

/** 同一工具连续失败达此数 → 本回合暂停该工具（Q5 熔断：不让模型换参数死磕） */
export const MAX_CONSECUTIVE_FAILURES = 2;

const SUSPENDED_NOTE = JSON.stringify({
  error: "tool_suspended",
  notice: "该工具本轮已连续失败 " + MAX_CONSECUTIVE_FAILURES + " 次，现在不可用（不是换个参数就能绕开的接口抖动）。"
    + "请基于本回合已取到的数据作答，并如实告诉用户这件事此刻没做成、原因是什么；不要再调用本工具。",
});

/** 回合内可用性门闸：先熔断后预算；返回 null 表示放行 */
function gate(ctx: ToolCtx, toolName: string): string | null {
  if ((ctx.failures?.get(toolName) ?? 0) >= MAX_CONSECUTIVE_FAILURES) return SUSPENDED_NOTE;
  return budgetNote(ctx.counts, toolName);
}

/** 动作卡三类：write（主进程持闭包，点击才执行）/ prompt（续问）/ navigate（跳转查看） */
const promptAction = (label: string, text: string) => ({ kind: "prompt" as const, label, text });
const navAction = (label: string, href: string) => ({ kind: "navigate" as const, label, href });
type AnyAction = ActionCard | ReturnType<typeof promptAction> | ReturnType<typeof navAction>;


/** CRM 发送阶段推进序（与 contacts.stage 及看板语义一致）：记完跟进给「下一步」建议用 */
const STAGE_SEQ: Array<{ key: string; label: string }> = [
  { key: "cold", label: "F1 首封触达" },
  { key: "f1", label: "F2 二次跟进" },
  { key: "f2", label: "F3 需求确认" },
  { key: "f3", label: "F4 报价推进" },
  { key: "f4", label: "合作洽谈" },
];
function nextStageAfter(current: string | null): { key: string; label: string } | null {
  const i = STAGE_SEQ.findIndex(s => s.key === (current ?? "cold"));
  if (i < 0 || i >= STAGE_SEQ.length - 1) return null;
  return STAGE_SEQ[i + 1]!;
}

const cell = (v: unknown): string => (v == null || v === "" ? "—" : String(v));

/** 按公司名模糊找库内记录：多命中时优先精确同名，其次首条（供背调联动判断「库里有没有」） */
function findCompanyByName(name: string) {
  const tokens = name.split(/\s+/).filter(Boolean).slice(0, 4);
  if (!tokens.length) return undefined;
  const rows = getDb().select().from(companies)
    .where(and(...tokens.map(t => like(companies.name, `%${t}%`)))).all();
  if (!rows.length) return undefined;
  const exact = rows.find(r => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact ?? rows[0];
}

/** 预算超限时不 throw（模型会把 tool error 当“接口故障”继续绕），改为明确引导语令其基于已有数据作答 */
function budgetNote(counts: Map<string, number>, toolName: string): string | null {
  try { checkBudget(counts, toolName); return null; }
  catch (e) {
    if (e instanceof ToolBudgetError) {
      return JSON.stringify({ error: "budget_exhausted", notice: "本工具本轮查询次数已达上限。这不是接口故障——请立即基于此前已返回的数据作答，不要再调用本工具。" });
    }
    throw e;
  }
}

export type { ToolCtx } from "./types";
import type { ToolCtx } from "./types";

// ── Schema 设计原则（live 评测两轮实锤）─────────────────────────
// ① 能用「钳制/归一」解决的，绝不用 .max()/.enum() 硬拒：zod 校验失败发生在 execute 之前，
//    预算守卫拦不住，模型会当成接口故障反复重试直到 max turns。
// ② 可选字段一律 .nullable().optional()：SDK 转 JSON Schema 要求可选字段以 nullable 表达
//    （否则报 "uses .optional() without .nullable()"）；而 DeepSeek 等模型确实会把没用上的
//    字段回传 null —— 声明可空后 null 能过校验，下游用 ?? / ?. / 真值判断天然按「未填」处理。
export const searchContactsSchema = z.object({
  query: z.string().min(1).max(80).describe("姓名/邮箱/公司名关键词"),
  limit: z.number().int().nullable().optional().describe("返回条数上限，默认 10"),
});

export const recordFollowupSchema = z.object({
  contactId: z.number().int().positive().describe("联系人 id（来自 search_contacts 返回）"),
  note: z.string().min(1).max(500).describe("跟进记录内容"),
});

// ── update_plan：界面任务清单（元工具，不读写任何业务数据）─────────────
export type PlanState = "pending" | "doing" | "done";
export interface PlanItem { text: string; state: PlanState }

const PLAN_DONE_RE = /^(done|completed|complete|finished|ok|已?完成|做完|已完成|已做)$/i;
const PLAN_DOING_RE = /^(doing|in[_\s-]?progress|running|active|wip|current|进行中|正在做|在做|当前)$/i;

/**
 * 归一模型给的清单：条数与文本长度在代码里钳制，状态词按同义词容错。
 * execute 与 harness 推 agent:plan 事件共用此口径，避免两处各写一套判据。
 */
export function normalizePlan(raw: unknown): PlanItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 8).map((entry): PlanItem => {
    const o = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const text = String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const st = String(o.state ?? "").trim();
    const state: PlanState = PLAN_DONE_RE.test(st) ? "done" : PLAN_DOING_RE.test(st) ? "doing" : "pending";
    return { text, state };
  }).filter(i => i.text.length > 0);
}

const planItemSchema = z.object({
  text: z.string().describe("这一步做什么，一句话（如「检索 ACME 的联系人」）"),
  state: z.string().nullable().optional()
    .describe("pending=待办 / doing=进行中 / done=已完成；写 completed、in_progress 也会被归一"),
});

export const updatePlanSchema = z.object({
  items: z.array(planItemSchema).describe("全量清单（每次调用覆盖上一次，不是增量），最多 8 步"),
});

export const quoteSearchSchema = z.object({
  lane: z.string().max(20).nullable().optional().describe("航线（加勒比/南美东/南美西/墨西哥/中美洲/欧地），不传则全航线"),
  carrier: z.string().max(10).nullable().optional().describe("船司三字码，如 CMA/MSK/MSC；不看船司就省略或传空"),
  pod: z.string().max(60).nullable().optional().describe("目的港关键词（英文港名，模糊匹配）；不限则省略或传空"),
  container: z.string().max(10).nullable().optional().describe("柜型，如 20GP/40GP/40HQ/NOR（写 40HC 也会自动归一）；不限则省略或传空"),
  includeExpired: z.boolean().nullable().optional().describe("是否包含已过有效期记录，默认 false"),
  limit: z.number().int().nullable().optional().describe("返回条数，默认 20，按价格升序"),
});

export const inboxSearchSchema = z.object({
  query: z.string().max(120).nullable().optional().describe("关键词，匹配发件人邮箱/主题/正文摘要；不传则返回最近邮件"),
  classification: z.string().max(20).nullable().optional()
    .describe("按系统分类过滤：inquiry=询盘 reply=回复 bounce=退信 auto_reply=自动回复；其他值视为不过滤"),
  unreadOnly: z.boolean().nullable().optional().describe("只看未读，默认 false"),
  limit: z.number().int().nullable().optional().describe("返回条数，默认 10，按时间倒序"),
});

export const emailSummarizeSchema = z.object({
  messageId: z.number().int().positive().describe("邮件 id（来自 inbox_search 返回）"),
});

export const companyBackcheckSchema = z.object({
  companyName: z.string().min(2).max(80).describe("公司名（英文优先，可用行业常见拼写）"),
  country: z.string().max(40).nullable().optional().describe("国家/地区，帮助收敛搜索"),
});

export const generateDraftSchema = z.object({
  companyName: z.string().min(1).max(80).describe("目标公司名"),
  contactName: z.string().max(60).describe("收件人姓名"),
  language: z.string().max(8).nullable().optional().describe("输出语言：EN 英语 / ES 西语 / PT 葡语；其他值按 EN 处理"),
  focus: z.string().max(300).nullable().optional().describe("内容侧重提示，如主推航线、客户痛点"),
  contactId: z.number().int().positive().nullable().optional().describe("收件联系人 id（来自 search_contacts；带上它才会出现「入队」按钮）"),
});

export const sendQueueAddSchema = z.object({
  contactIds: z.array(z.number().int().positive()).min(1).max(50)
    .describe("收件联系人 id 列表（来自 search_contacts 返回的 id）"),
  subject: z.string().min(1).max(150).describe("邮件主题（可含 {{company}}/{{firstName}} 变量）"),
  body: z.string().min(1).max(8000).describe("邮件正文（纯文本/简单 HTML，可含联系人变量）"),
});

function audit(ctx: ToolCtx, toolName: string, sideEffect: string, args: unknown,
               result: unknown, approval: string, error?: string): void {
  // 失败轨迹就地计数：带 error 的审计 = 这次没办成；办成立刻清零。
  // 空结果不算失败（那是真实数据，不是故障），因为空结果一律不带 error。
  const fails = ctx.failures ?? (ctx.failures = new Map());
  if (error) fails.set(toolName, (fails.get(toolName) ?? 0) + 1);
  else fails.set(toolName, 0);
  try {
    getDb().insert(agentToolCalls).values({
      conversationId: ctx.conversationId,
      toolName,
      sideEffect,
      argsJson: JSON.stringify(args),
      resultJson: result === undefined ? undefined : JSON.stringify(result).slice(0, 4000),
      approval,
      error,
    }).run();
    saveDatabase();
  } catch (err) {
    Log.warn("agent.audit", `工具留痕写入失败 ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 审计层对外暴露：审批被拒时由 dispatcher 记一行 rejected */
export function auditRejected(ctx: ToolCtx, toolName: string, argsJson: string | undefined): void {
  audit(ctx, toolName, "write", argsJson ? safeParse(argsJson) : undefined, undefined, "rejected", "用户拒绝执行");
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export function buildHarnessTools(ctx: ToolCtx) {
  const searchContacts = tool({
    name: "search_contacts",
    description: "在本地联系人库按姓名/邮箱/公司名关键词检索，返回结构化记录（含 id/姓名/邮箱/公司/国家/阶段）。涉及客户的事实性回答必须且只能基于本工具返回的数据。绝对不要用本工具查运价、邮件或公司公开背景（那是 quote_search / inbox_search / company_backcheck）。",
    parameters: searchContactsSchema,
    execute: async (args) => {
      const note = gate(ctx, "search_contacts");
      if (note) return note;
      // 按词切分匹配（live 评测实锤：模型常传全名 "Juan Garcia"，整串 LIKE 匹配不上单列 firstName/lastName → 误判查无此人）
      const perToken = args.query.split(/\s+/).filter(Boolean).slice(0, 4).map(tok => {
        const p = `%${tok}%`;
        return or(like(contacts.email, p), like(contacts.firstName, p), like(contacts.lastName, p), like(companies.name, p));
      });
      const rows = getDb()
        .select({
          id: contacts.id, email: contacts.email,
          firstName: contacts.firstName, lastName: contacts.lastName,
          country: contacts.country, stage: contacts.stage, status: contacts.status,
          companyName: companies.name,
        })
        .from(contacts)
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(and(...perToken))
        .limit(Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50))
        .all();
      const out = rows.map(r => ({
        id: r.id,
        name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
        email: r.email, company: r.companyName, country: r.country,
        stage: r.stage, status: r.status,
      }));
      audit(ctx, "search_contacts", "read", args, out, "auto");
      // 空结果给显式收敛信号：模型往往会换词重试直至 max turns（live 评测实锤）
      if (out.length === 0) {
        return JSON.stringify({ results: [], notice: "库中没有匹配该关键词的联系人。请直接如实告知用户查无此人，不要用相同参数重复调用本工具。" });
      }
      // 唯一命中 → 直接续问写开发信（带上 contactId，草稿结果卡才能长出「入队」按钮）
      if (out.length === 1) {
        const one = out[0]!;
        return JSON.stringify({
          results: out,
          actions: [promptAction(
            "给 TA 写一封开发信",
            `给联系人 #${one.id} ${one.name}（${one.company || "无公司名"}${one.country ? `，${one.country}` : ""}）写一封开发信，先想清楚切入点再动笔`,
          )],
        });
      }
      // P1-5：多命中 → 两种批量路径任选：整批各生成一封入队（写动作），或续问聚焦
      const batch = out.slice(0, 10);
      return JSON.stringify({
        results: out,
        actions: [
          registerAction({
            conversationId: ctx.conversationId, toolName: "search_contacts",
            label: `给这 ${batch.length} 位各生成一封跟进信`,
            confirm: `为检索到的前 ${batch.length} 位联系人各生成一封跟进信并加入发送队列`,
            detail: "入队 ≠ 发送：到「发送中心」核对后手动点开始；每人一封、按各自语言",
            diff: [
              { field: "targets", label: "收件人", from: "—", to: batch.slice(0, 5).map(c => `#${c.id} ${c.name}`).join("、") + (batch.length > 5 ? ` 等 ${batch.length} 人` : "") },
            ],
            target: { label: "去发送中心", href: "#/campaigns" },
            run: async () => {
              const queued: string[] = [];
              const failed: string[] = [];
              for (const c of batch) {
                const contact = getDb().select({
                  id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName,
                  language: contacts.language, companyId: contacts.companyId, email: contacts.email,
                }).from(contacts).where(eq(contacts.id, c.id)).get();
                if (!contact) { failed.push(`#${c.id}`); continue; }
                const companyName = contact.companyId
                  ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? "")
                  : "";
                const lang = ["ES", "PT"].includes(String(contact.language ?? "").toUpperCase())
                  ? (String(contact.language).toUpperCase() as "ES" | "PT") : "EN";
                const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email;
                const draft = await generateEmailDraft({ language: lang, companyName: companyName || c.company || name, contactName: name });
                if (!draft.success) { failed.push(name); continue; }
                const raw = draft.data.trim();
                const m = /^SUBJECT:\s*(.+)\s*$/im.exec(raw);
                const subject = (m?.[1] ?? `Following up — ${companyName || name}`).trim().slice(0, 150);
                const body = (m ? raw.slice(m.index + m[0].length) : raw).replace(/^\s+/, "").trim();
                const q = await startDynamicSend([contact.id], subject, body, false);
                if (q.success) queued.push(name); else failed.push(name);
              }
              return okResult(
                `批量成信完成：${queued.length} 封已入队${queued.length ? `（${queued.join("、")}）` : ""}`
                + (failed.length ? `；${failed.length} 位未成（${failed.join("、")}）` : "")
                + "。队列未启动，请到「发送中心」核对后点开始。",
              );
            },
          }),
          promptAction("先看清这批人再决定", `把刚才检索到的 ${batch.length} 位联系人按公司归组，说明各自阶段与国家，帮助判断该给谁写信`),
        ],
      });
    },
  });

  const recordFollowup = tool({
    name: "record_followup",
    description: "为指定联系人记录一条跟进备注。只用于「把刚发生的事写进这个人的跟进历史」；"
      + "绝对不要用本工具改客户阶段（那要在 CRM 里操作）、不要用它写开发信正文、也不要拿它代替用户确认发信。"
      + "写操作，执行前会请求人工确认；被拒绝则放弃。",
    parameters: recordFollowupSchema,
    needsApproval: true,
    execute: async (args) => {
      const gateNote = gate(ctx, "record_followup");
      if (gateNote) return gateNote;
      // 幂等：同一会话里相同内容 5 分钟内只落一次（模型重复提交/用户连点）
      const dup = lookupIdempotent(ctx, "record_followup", args);
      if (dup) return dup;
      const exists = getDb().select({ id: contacts.id }).from(contacts)
        .where(eq(contacts.id, args.contactId)).get();
      if (!exists) {
        audit(ctx, "record_followup", "write", args, undefined, "approved", `联系人 #${args.contactId} 不存在`);
        return `失败：联系人 #${args.contactId} 不存在，请先用 search_contacts 查询`;
      }
      getDb().insert(interactions).values({
        contactId: args.contactId, type: "note", direction: "outbound",
        channel: "manual", bodyPreview: args.note,
      }).run();
      saveDatabase();
      audit(ctx, "record_followup", "write", args, { ok: true }, "approved");
      rememberResult(ctx, "record_followup", args, `已为联系人 #${args.contactId} 记录跟进`);
      const stageRow = getDb().select({ stage: contacts.stage }).from(contacts).where(eq(contacts.id, args.contactId)).get();
      const nextStage = nextStageAfter(stageRow?.stage ?? null);
      return `已为联系人 #${args.contactId} 记录跟进。` + (nextStage
        ? `提示用户：TA 当前阶段是「${stageRow?.stage ?? "冷开发"}」，要不要顺手推进到「${nextStage.label}」？（可在 CRM 看板里改，或让我用动作卡来做）`
        : "（该联系人已是终态阶段，无需推进）");
    },
  });

  const quoteSearch = tool({
    name: "quote_search",
    description: "查询本地海运运价镜像库（源自钉钉《海运运价智能台账》，每日同步）。绝对不要用它回答客户、联系人、邮件内容或公司背景问题（那是 search_contacts / inbox_search / company_backcheck 的事）；查不到价格时直接说没有，不要编造。所有参数均可省略——用户只给目的港时仅传 pod 即可，省略的条件视为不限。返回 目的港/船司/柜型/USD价/有效期/备注 结构化列表，按价格升序。运价相关问题必须且只能基于本工具结果回答；结果为参考价，回答时须提醒以船司实时报价为准。",
    parameters: quoteSearchSchema,
    execute: async (args) => {
      const note = gate(ctx, "quote_search");
      if (note) return note;
      // 模型可传 null（字段已声明 nullable），统一在此收敛成 undefined，保证 QuoteFilters 契约干净
      const trimmed = (v: string | null | undefined): string | undefined => {
        const t = (v ?? "").trim();
        return t || undefined;                    // 空串与 null 都按「不过滤」处理
      };
      const filters = {
        // 去掉口语后缀（「加勒比线」「南美东航线」→ 加勒比 / 南美东），配合 like 模糊匹配
        lane: trimmed(args.lane)?.replace(/航线$/, "").replace(/线$/, "").trim() || undefined,
        carrier: trimmed(args.carrier)?.toUpperCase(),
        pod: trimmed(args.pod),
        // 脏柜型归一（40HC→40HQ 等），识别不了则原样大写透传
        container: normalizeContainer(trimmed(args.container) ?? null) ?? trimmed(args.container)?.toUpperCase() ?? undefined,
        includeExpired: args.includeExpired ?? undefined,
      };
      const r = listQuotes({ ...filters, limit: args.limit && args.limit > 0 ? args.limit : 20 });
      if (!r.success) {
        audit(ctx, "quote_search", "read", args, undefined, "auto", r.error);
        return `查询失败：${r.error}`;
      }
      // total=满足条件的真总数（评测发现只给截断行数会让模型反复重试凑数直至 max turns）
      const total = countQuotes(filters);
      const out = {
        total, count: r.data.length, quotes: r.data,
        // 收敛信号：数据已完整时显式声明，防模型按航线/船司逐扇出重复查询（评测 rate-table 实锤 11 连击）
        ...(total > 0 && r.data.length >= total ? { complete: true, notice: "命中数据已全部返回，无需再调用本工具，直接作答" } : {}),
        // 空结果显式引导：直接如实回答，不要换参数重试
        ...(total === 0 ? { empty: true, notice: "镜像库中没有满足条件的报价。请直接如实告知用户「镜像库暂无该航线报价」，不要重复调用本工具。" } : {}),
        // 「数条数/比价」类问题模型容易反复重查（rate-count 实测 6 连击撞 max turns）：
        // 直接把结论算好给它复述，比让它自己数数组长度可靠
        ...(total > 0 ? {
          say: `共 ${total} 条` + (args.lane || args.pod || args.carrier || args.container
            ? `（当前筛选条件下的命中数）` : `（镜像库全量）`)
            + `，其中返回明细 ${r.data.length} 条${r.data.length ? `，最低 ${r.data[0]!.oceanUsd ?? "-"} USD` : ""}`,
        } : {}),
        // 有命中 → 「把价格变成动作」的提示卡（点一下续问，产物留在对话里）
        ...(total > 0 ? {
          actions: [
            promptAction("按这批价写一封报价信", "根据刚才查到的运价，选最便宜的那条给客户写一封报价信，注明有效期和「以船司实时报价为准」的提醒"),
            navAction("在运价库筛选", "#/rates"),
          ],
        } : {}),
      };
      audit(ctx, "quote_search", "read", args, out, "auto");
      return JSON.stringify(out);
    },
  });

  const inboxSearch = tool({
    name: "inbox_search",
    description: "检索本地收件箱邮件（发件人/主题/正文摘要关键词，可按系统分类与未读过滤），返回 发件人/主题/分类/时间/id 列表。用户问「今天有什么新邮件/询盘/退信」「谁给我发过…」时使用本工具；要总结某封邮件先用本工具拿 id。",
    parameters: inboxSearchSchema,
    execute: async (args) => {
      const note = gate(ctx, "inbox_search");
      if (note) return note;
      const INBOX_CLASSES = ["inquiry", "reply", "bounce", "auto_reply", "normal"];
      const q0 = (args.query ?? "").trim();
      const cls = (args.classification ?? "").trim().toLowerCase();
      const conds = [];
      if (q0) {
        const q = `%${q0}%`;
        conds.push(or(like(inboxMessages.fromEmail, q), like(inboxMessages.subject, q), like(inboxMessages.bodyPreview, q)));
      }
      if (INBOX_CLASSES.includes(cls)) conds.push(eq(inboxMessages.classification, cls));
      if (args.unreadOnly) conds.push(eq(inboxMessages.isRead, 0));
      const rows = getDb().select({
        id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
        subject: inboxMessages.subject, classification: inboxMessages.classification,
        isRead: inboxMessages.isRead, receivedAt: inboxMessages.receivedAt,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(inboxMessages.receivedAt))
        .limit(Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50))
        .all();
      const raw = rows.map(r => ({ ...r, from: r.fromName || r.fromEmail, matchedContactId: r.matchedContactId ?? undefined }));
      audit(ctx, "inbox_search", "read", args, raw, "auto");
      // 收敛信号：空结果如实回答；结果少于 limit 说明已全量返回
      if (raw.length === 0) {
        return JSON.stringify({ messages: [], notice: "收件箱中没有匹配的邮件。请直接如实告知用户，不要重复调用本工具。" });
      }
      const defaultLimit = Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50);
      // P1-1：真实客户来信（询盘/回复）但库中无此联系人 → 附「创建联系人」写入动作
      const actions: AnyAction[] = [];
      for (const m of raw) {
        if (m.matchedContactId || !["inquiry", "reply"].includes(String(m.classification))) continue;
        const cands = getDb().select({ id: contacts.id }).from(contacts).where(eq(contacts.email, m.fromEmail)).all();
        if (cands.length > 0) continue;
        const label = `把 ${m.from} 加为客户`;
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "inbox_search",
          label,
          confirm: `为发件人 ${m.fromEmail} 创建联系人${m.fromName ? `（${m.fromName}）` : ""}`,
          detail: "只建联系人档案，不发任何邮件",
          diff: [
            { field: "email", label: "邮箱", from: "—（库中无此联系人）", to: m.fromEmail },
            { field: "name", label: "姓名", from: "—", to: m.fromName || "（取邮箱前缀）" },
            { field: "status", label: "状态", from: "—", to: "已触达（刚来信）" },
          ],
          target: { label: "查看联系人", href: `#/customers?view=table&add=1&email=${encodeURIComponent(m.fromEmail)}` },
          run: async () => {
            const nameGuess = m.fromName?.trim() || m.fromEmail.split("@")[0]!;
            const [first, ...rest] = nameGuess.split(/\s+/);
            const u = await upsertContact({
              email: m.fromEmail,
              firstName: first ?? nameGuess,
              lastName: rest.join(" ") || null,
              status: "reached",
            });
            return u.success ? okResult(`已创建联系人 ${u.data.email} #${u.data.id}`) : failResult(u.error);
          },
        }));
        break;   // 一张卡最多给一个创建动作，避免按钮噪音
      }
      return JSON.stringify({
        total: raw.length,
        ...(raw.length < defaultLimit ? { complete: true, notice: "以上即全部匹配邮件，直接作答即可" } : {}),
        messages: raw,
        ...(actions.length ? { actions } : {}),
      });
    },
  });

  const emailSummarize = tool({
    name: "email_summarize",
    description: "总结一封收件箱邮件并给出下一步跟进建议（输入是一封邮件；绝对不要拿它做客户档案查询或整库统计）。（内部调用 LLM 生成 一句话总结 + nextStep）。先 inbox_search 拿到邮件 id 再调用本工具。",
    parameters: emailSummarizeSchema,
    execute: async (args) => {
      const note = gate(ctx, "email_summarize");
      if (note) return note;
      const row = getDb().select({
        id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
        subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
        classification: inboxMessages.classification, isRead: inboxMessages.isRead,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
      if (!row) {
        audit(ctx, "email_summarize", "read", args, undefined, "auto", `邮件 #${args.messageId} 不存在`);
        return `失败：邮件 #${args.messageId} 不存在，请先用 inbox_search 查询`;
      }
      // 正文：全文本（懒加载含 IMAP 拉取）→ 去标签压成纯文本，避免 HTML 噪声进模型
      const bodyR = await getBody(args.messageId);
      const text = (bodyR.success ? bodyR.data : (row.bodyPreview || ""))
        .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);
      const contact = row.matchedContactId
        ? getDb().select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, companyId: contacts.companyId })
            .from(contacts).where(eq(contacts.id, row.matchedContactId)).get()
        : undefined;
      const r = await summarizeEmail({
        fromName: row.fromName, fromEmail: row.fromEmail, subject: row.subject,
        bodyPreview: text || (row.bodyPreview ?? ""),
        matchedContactName: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : null,
        matchedCompany: contact?.companyId
          ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? null)
          : null,
      });
      if (!r.success) {
        audit(ctx, "email_summarize", "read", args, undefined, "auto", r.error);
        return `总结失败：${r.error}`;
      }
      const summary = {
        id: row.id, from: row.fromName || row.fromEmail, subject: row.subject ?? "",
        summary: r.data.summary, nextStep: r.data.nextStep,
      };
      audit(ctx, "email_summarize", "read", args, summary, "auto");

      // P1-2/P1-3：按邮件类型给「顺手办掉」的写动作（点击才执行，落动作卡审计）
      const actions: AnyAction[] = [];
      const cls = String(row.classification ?? "");
      if (row.matchedContactId) {
        if (cls === "inquiry" || cls === "reply") {
          actions.push(registerAction({
            conversationId: ctx.conversationId, toolName: "email_summarize",
            label: "记一条跟进",
            confirm: `给联系人 #${row.matchedContactId} 记跟进：「${r.data.summary.slice(0, 40)}…」`,
            detail: "写入该联系人的跟进历史；只记事，不改阶段",
            diff: [
              { field: "note", label: "跟进内容", from: "—", to: `收到${cls === "inquiry" ? "询盘" : "回复"}：${r.data.summary.slice(0, 50)}` },
              { field: "direction", label: "方向", from: "—", to: "客户来件" },
            ],
            run: async () => {
              getDb().insert(interactions).values({
                contactId: row.matchedContactId!, type: "note", direction: "inbound",
                channel: "email", bodyPreview: `收到${cls === "inquiry" ? "询盘" : "回复"}：${r.data.summary}`,
              }).run();
              saveDatabase();
              return okResult(`已给联系人 #${row.matchedContactId} 记一条「收到${cls === "inquiry" ? "询盘" : "回复"}」的跟进`);
            },
          }));
        }
        if (cls === "bounce") {
          actions.push(registerAction({
            conversationId: ctx.conversationId, toolName: "email_summarize",
            label: "标记已流失",
            confirm: `把联系人 #${row.matchedContactId} 标记为「已流失」（邮箱退信）`,
            detail: "改的是 CRM 阶段；后续仍可手动改回",
            diff: [
              { field: "stage", label: "阶段", from: "当前阶段", to: "已流失 (lost)" },
              { field: "reason", label: "原因", from: "—", to: "邮箱退信" },
            ],
            run: async () => {
              const r2 = await setStage(row.matchedContactId!, "lost");
              return r2.success ? okResult(`已把联系人 #${row.matchedContactId} 标记为已流失`) : failResult(r2.error);
            },
          }));
        }
        if (cls === "inquiry" || cls === "reply") {
          actions.push(registerAction({
            conversationId: ctx.conversationId, toolName: "email_summarize",
            label: "标记已读",
            confirm: `把这封邮件（#${row.id}）标为已读`,
            diff: [{ field: "isRead", label: "状态", from: "未读", to: "已读" }],
            run: async () => {
              const r2 = markRead(row.id);
              return r2.success ? okResult("已标记已读") : failResult(r2.error);
            },
          }));
        }
      }
      return JSON.stringify({ ...summary, ...(actions.length ? { actions } : {}) });
    },
  });

  const companyBackcheck = tool({
    name: "company_backcheck",
    description: "对一家公司做公开网络背调并生成结构化报告（外部公开资料；库里已有的客户事实一律用 search_contacts，不要用本工具去佐证库内数据）。（一句话总结/进口活跃度/主营品类/货代契合点/风险/评分/来源链接）。数据来自 Exa/Tavily 网络搜索，非本地库。用户问「XX公司什么背景/值得开发吗」时使用。",
    parameters: companyBackcheckSchema,
    execute: async (args) => {
      const note = gate(ctx, "company_backcheck");
      if (note) return note;
      const query = `${args.companyName}${args.country ? ` ${args.country}` : ""} importer products supplier`;
      const hits = await searchCompany(query);
      if (!hits.success || hits.data.length === 0) {
        const msg = hits.success
          ? "网络搜索未找到该公司资料，无法生成背调报告"
          : `搜索数据源不可用：${hits.error}（需在设置中配置 EXA_API_KEY 或 TAVILY_API_KEY）`;
        audit(ctx, "company_backcheck", "read", args, undefined, "auto", msg);
        return msg;
      }
      const r = await generateBackcheckReport(
        { companyName: args.companyName, country: args.country ?? undefined },
        hits.data,
      );
      if (!r.success) {
        audit(ctx, "company_backcheck", "read", args, undefined, "auto", r.error);
        return `背调生成失败：${r.error}`;
      }
      const report = r.data;
      const matched = findCompanyByName(args.companyName);
      const industryGuess = Array.isArray(report.categories) ? report.categories.slice(0, 3).join("、") : "";
      const backcheckJson = JSON.stringify(report);
      const actions: AnyAction[] = [];

      if (matched) {
        // 库里已有 → 提议把背调结论写回公司档案（点击才执行）
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "company_backcheck",
          label: "写入公司档案",
          confirm: `把这次背调结论写入「${matched.name}」的公司档案`,
          detail: "只更新背调结论与空缺字段，不动已有联系人",
          diff: [
            { field: "backcheck", label: "背调结论", from: matched.backcheckData ? "已有旧版（将被覆盖）" : "无", to: `${cell(report.summary)}（评分 ${cell(report.rating)}）` },
            { field: "industry", label: "主营品类", from: cell(matched.industry), to: matched.industry || industryGuess || "—" },
            { field: "country", label: "国家", from: cell(matched.country), to: cell(matched.country || args.country) },
          ],
          target: { label: "查看公司档案", href: `#/customers?view=company&sel=${matched.id}` },
          run: async () => {
            const u = await upsertCompany({
              id: matched.id, name: matched.name,
              industry: matched.industry || (industryGuess || null),
              country: matched.country || (args.country ?? null),
              backcheckData: backcheckJson,
            });
            return u.success ? okResult(`已更新公司档案 #${matched.id}（${matched.name}）`) : failResult(u.error);
          },
        }));
        actions.push(navAction("查看公司档案", `#/customers?view=company&sel=${matched.id}`));
      } else {
        // 库里没有 → 提议建档
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "company_backcheck",
          label: "加入客户库",
          confirm: `新建公司「${args.companyName}」并写入这份背调结论`,
          detail: "只建公司档案，不创建联系人",
          diff: [
            { field: "name", label: "公司名", from: "—（库内无此公司）", to: args.companyName },
            { field: "industry", label: "主营品类", from: "—", to: industryGuess || "—" },
            { field: "country", label: "国家", from: "—", to: cell(args.country) },
            { field: "backcheck", label: "背调结论", from: "—", to: `${cell(report.summary)}（评分 ${cell(report.rating)}）` },
          ],
          target: { label: "查看公司库", href: "#/customers?view=company" },
          run: async () => {
            const u = await upsertCompany({
              name: args.companyName.trim(),
              industry: industryGuess || null,
              country: args.country ?? null,
              backcheckData: backcheckJson,
            });
            return u.success ? okResult(`已加入客户库：${u.data.name} #${u.data.id}`) : failResult(u.error);
          },
        }));
      }

      const out = {
        ...report,
        companyInDb: matched ? { id: matched.id, name: matched.name } : null,
        actions,
      };
      audit(ctx, "company_backcheck", "read", args, out, "auto");
      return JSON.stringify(out);
    },
  });

  const generateDraft = tool({
    name: "generate_draft",
    description: "为指定公司/联系人生成一封开发信草稿（带 SUBJECT: 主题行 + 正文，支持 EN/ES/PT）。本工具只产出文本，不会发送；用户可通过结果卡上的按钮一键存素材库或入队。撰写前若已有背调结论，把要点放进 focus；已知收件人时带上 contactId 才能入队。",
    parameters: generateDraftSchema,
    execute: async (args) => {
      const note = gate(ctx, "generate_draft");
      if (note) return note;
      const r = await generateEmailDraft({
        language: (["EN", "ES", "PT"].includes((args.language ?? "EN").toUpperCase()) ? args.language!.toUpperCase() : "EN") as "EN" | "ES" | "PT",
        companyName: args.companyName,
        contactName: args.contactName,
        backcheck: args.focus ? ({ summary: args.focus } as BackcheckReport) : null,
      });
      if (!r.success) {
        audit(ctx, "generate_draft", "read", args, undefined, "auto", r.error);
        return `草稿生成失败：${r.error}`;
      }
      // 拆 SUBJECT 行 → 主题/正文（结果卡动作与入队都要用）
      const raw = r.data.trim();
      const m = /^SUBJECT:\s*(.+)\s*$/im.exec(raw);
      const subject = (m?.[1] ?? `Following up — ${args.companyName}`).trim().slice(0, 150);
      const body = (m ? raw.slice(m.index + m[0].length) : raw).replace(/^\s+/, "").trim();
      const lang = args.language ?? "EN";
      const tplName = `${args.companyName} · AI 开发信`.slice(0, 60);

      const actions: AnyAction[] = [
        registerAction({
          conversationId: ctx.conversationId, toolName: "generate_draft",
          label: "存入素材库",
          confirm: `把这封草稿存进素材库，以后在发送中心可直接复用`,
          detail: `名称「${tplName}」，语言 ${lang}`,
          diff: [
            { field: "name", label: "素材名", from: "—", to: tplName },
            { field: "subject", label: "主题", from: "—", to: subject },
            { field: "body", label: "正文", from: "—", to: `${body.slice(0, 60)}${body.length > 60 ? "…" : ""}` },
          ],
          target: { label: "查看素材库", href: "#/templates" },
          run: async () => {
            const t = await upsertTemplate({ name: tplName, language: lang, subject, body, category: "ai-draft" });
            return t.success ? okResult(`已存入素材库：${t.data.name}`) : failResult(t.error);
          },
        }),
      ];
      if (args.contactId) {
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "generate_draft",
          label: "入队发给这位联系人",
          confirm: `把这封信加入发送队列，收件人 #${args.contactId}`,
          detail: "入队 ≠ 发送：队列建好后不会自动开始，仍要你在「发送中心」点「开始」",
          diff: [
            { field: "subject", label: "主题", from: "—", to: subject },
            { field: "contact", label: "收件人", from: "—", to: `#${args.contactId} ${args.contactName || ""}`.trim() },
          ],
          target: { label: "去发送中心", href: "#/campaigns" },
          run: async () => {
            const s = await startDynamicSend([args.contactId!], subject, body, false);
            return s.success
              ? okResult(`已入队 ${s.data.queuedCount} 封（批次 ${s.data.batchId.slice(0, 8)}），等待你在发送中心点开始`)
              : failResult(s.error);
          },
        }));
      }
      // 不重复放 draft 全文：推送给前端的结果有 6000 字上限，长信会把 actions 挤出截断范围
      const out = { subject, body, language: lang, contactId: args.contactId ?? null, actions };
      audit(ctx, "generate_draft", "read", args, { subject, length: body.length, actions: actions.length }, "auto");
      return JSON.stringify(out);
    },
  });

  const queueStatus = tool({
    name: "queue_status",
    description: "查询发信引擎与队列实时状态：是否运行中/已暂停、总组数、已发组数、失败组数、待发的组数与收件人数。用户问「还有多少没发出去」「发送进度」「队列是不是卡住了」时使用。",
    parameters: z.object({}),
    execute: async () => {
      const note = gate(ctx, "queue_status");
      if (note) return note;
      const s = getSendStatus();
      const q = getQueueItems();
      const items = q.success ? q.data : [];
      const pending = items.filter(i => i.status === "pending");
      const out = {
        running: s.success ? s.data.isRunning : false,
        paused: s.success ? s.data.isPaused : false,
        totalGroups: s.success ? s.data.totalItems : 0,
        sentGroups: s.success ? s.data.sentCount : 0,
        failedGroups: s.success ? s.data.failedCount : 0,
        pendingGroups: pending.length,
        pendingRecipients: pending.reduce((n, i) => n + i.recipients.length, 0),
      };
      audit(ctx, "queue_status", "read", {}, out, "auto");
      return JSON.stringify(out);
    },
  });

  const remindersDue = tool({
    name: "reminders_due",
    description: "查询到期与已逾期的跟进提醒（CRM 今日待跟进清单）。只回答「今天/最近该跟进谁」这类清单问题；要看某个人具体资料请用 search_contacts。，返回联系人 id/姓名/公司/提醒时间/跟进备注。用户问「今天该跟进谁」「有哪些到期提醒」「哪些客户 overdue 了」时必须先调用本工具。",
    parameters: z.object({}),
    execute: async () => {
      const note = gate(ctx, "reminders_due");
      if (note) return note;
      const r = checkReminders();
      if (!r.success) {
        audit(ctx, "reminders_due", "read", {}, undefined, "auto", r.error);
        return `查询失败：${r.error}`;
      }
      const brief = (c: (typeof r.data.due)[number]) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email,
        company: c.companyName ?? "", reminderAt: c.reminderAt ?? "", note: c.followupNote ?? "",
      });
      const due = r.data.due.map(brief);
      const overdue = r.data.overdue.map(brief);
      const all = [...overdue, ...due];                       // 逾期优先
      const out = { dueCount: due.length, overdueCount: overdue.length, due, overdue };

      // P1-4：提醒清单 → 一键批量成信入队（每人生成一封、按各自语言，入队不发送）
      const actions: AnyAction[] = [];
      if (all.length > 0) {
        const targets = all.slice(0, 10);
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "reminders_due",
          label: `给这 ${targets.length} 位批量生成跟进信`,
          confirm: `为清单前 ${targets.length} 位联系人各生成一封跟进信并加入发送队列`,
          detail: "入队 ≠ 发送：全部生成后到「发送中心」核对批次，手动点开始才外发；每人一封、按各自语言",
          diff: [
            { field: "targets", label: "收件人", from: "—", to: targets.slice(0, 5).map(c => `#${c.id} ${c.name}`).join("、") + (targets.length > 5 ? ` 等 ${targets.length} 人` : "") },
            { field: "batch", label: "批次", from: "—", to: "生成后显示" },
          ],
          target: { label: "去发送中心", href: "#/campaigns" },
          run: async () => {
            const queued: string[] = [];
            const failed: string[] = [];
            for (const c of targets) {
              const contact = getDb().select({
                id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName,
                language: contacts.language, companyId: contacts.companyId, email: contacts.email,
              }).from(contacts).where(eq(contacts.id, c.id)).get();
              if (!contact) { failed.push(`#${c.id}（已不存在）`); continue; }
              const companyName = contact.companyId
                ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? "")
                : "";
              const lang = ["ES", "PT"].includes(String(contact.language ?? "").toUpperCase())
                ? (String(contact.language).toUpperCase() as "ES" | "PT") : "EN";
              const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email;
              const draft = await generateEmailDraft({
                language: lang, companyName: companyName || c.company || name, contactName: name,
                backcheck: c.note ? { summary: `此前跟进备注：${c.note}` } as BackcheckReport : null,
              });
              if (!draft.success) { failed.push(`${name}（${draft.error.slice(0, 30)}）`); continue; }
              const raw = draft.data.trim();
              const m = /^SUBJECT:\s*(.+)\s*$/im.exec(raw);
              const subject = (m?.[1] ?? `Following up — ${companyName || name}`).trim().slice(0, 150);
              const body = (m ? raw.slice(m.index + m[0].length) : raw).replace(/^\s+/, "").trim();
              const q = await startDynamicSend([contact.id], subject, body, false);
              if (q.success) queued.push(name); else failed.push(`${name}（${q.error.slice(0, 30)}）`);
            }
            return okResult(
              `批量成信完成：${queued.length} 封已入队${queued.length ? `（${queued.join("、")}）` : ""}`
              + (failed.length ? `；${failed.length} 位未成：${failed.join("、")}` : "")
              + "。队列未启动，请到「发送中心」核对内容后点开始。",
            );
          },
        }));
      }
      audit(ctx, "reminders_due", "read", {}, { ...out, actions: actions.length }, "auto");
      if (due.length === 0 && overdue.length === 0) {
        return JSON.stringify({ ...out, notice: "今天没有到期或逾期的提醒。请如实告知用户，不要重复调用本工具。" });
      }
      return JSON.stringify({ ...out, ...(actions.length ? { actions } : {}) });
    },
  });

  const accountsStatus = tool({
    name: "accounts_status",
    description: "查询发信/收信账号的配置与健康状态：总数、启用数、健康数（无熔断且无连续失败），以及每个异常账号的具体问题（停用/发信熔断/连续失败次数/最近收信错误）。用户问「几个账号能用」「账号有没有问题」「哪个账号挂了」时使用。",
    parameters: z.object({}),
    execute: async () => {
      const note = gate(ctx, "accounts_status");
      if (note) return note;
      const rows = getDb().select({
        id: emailAccounts.id, email: emailAccounts.email, isActive: emailAccounts.isActive,
        consecutiveFails: emailAccounts.consecutiveFails, circuitOpenAt: emailAccounts.circuitOpenAt,
        lastFetchError: emailAccounts.lastFetchError, fetchFailCount: emailAccounts.fetchFailCount,
      }).from(emailAccounts).all();
      const issues = rows.map(r => {
        const probs: string[] = [];
        if (r.isActive !== 1) probs.push("已停用");
        if (r.circuitOpenAt) probs.push("发信熔断中");
        if (r.consecutiveFails > 0) probs.push(`发信连续失败 ${r.consecutiveFails} 次`);
        if (r.fetchFailCount > 0) probs.push(`收信连续失败 ${r.fetchFailCount} 次${r.lastFetchError ? `：${r.lastFetchError}` : ""}`);
        else if (r.lastFetchError) probs.push(`最近收信异常：${r.lastFetchError}`);
        return probs.length ? { id: r.id, email: r.email, problems: probs.join("、") } : null;
      }).filter((x): x is { id: number; email: string; problems: string } => x !== null);
      const healthyCount = rows.filter(r =>
        r.isActive === 1 && !r.circuitOpenAt && r.consecutiveFails === 0 && r.fetchFailCount === 0).length;
      // P1-7：有异常 → 直接给「去修」入口（跳设置页账号区）与复测动作
      const actions: AnyAction[] = [];
      if (issues.length > 0) {
        actions.push(navAction("去设置页修账号", "#/settings"));
      }
      const out = { total: rows.length, enabled: rows.filter(r => r.isActive === 1).length, healthy: healthyCount, issues, ...(actions.length ? { actions } : {}) };
      audit(ctx, "accounts_status", "read", {}, out, "auto");
      return JSON.stringify(out);
    },
  });

  const sendQueueAdd = tool({
    name: "send_queue_add",
    description: "把一封邮件加入发送队列。触发时机：用户明确说「把/给 X 发一封邮件」「发给 X」「发报价给 X」时，必须先 search_contacts 拿到 contactId，再调用本工具入队 —— 系统随后会弹人工确认框，那一步就是征求同意，因此不要只在正文里问「要不要发」而不调用本工具。本工具只入队不发送：队列建好后处于未启动状态，用户仍需在「发送中心」点「开始」才真正外发。主题与正文可含 {{company}}/{{firstName}}/{{lastName}} 变量。",
    parameters: sendQueueAddSchema,
    needsApproval: true,
    execute: async (args) => {
      const gateNote = gate(ctx, "send_queue_add");
      if (gateNote) return gateNote;
      const dup = lookupIdempotent(ctx, "send_queue_add", args);
      if (dup) return dup;
      const r = await startDynamicSend(args.contactIds, args.subject, args.body, false);
      if (!r.success) {
        audit(ctx, "send_queue_add", "write", args, undefined, "approved", r.error);
        forget(ctx, "send_queue_add", args);
        return `入队失败：${r.error}`;
      }
      audit(ctx, "send_queue_add", "write", args, r.data, "approved");
      const okMsg = `已加入发送队列：${r.data.queuedCount} 封（批次 ${r.data.batchId.slice(0, 8)}，${r.data.dropped} 组因限额被丢弃）。队列已建立但尚未启动，请提示用户到「发送中心」确认后手动点开始发送。`;
      rememberResult(ctx, "send_queue_add", args, okMsg);
      return okMsg;
    },
  });

  const updatePlan = tool({
    name: "update_plan",
    description: "更新界面上展示的任务清单卡，让用户看到多步任务进行到了哪一步。"
      + "只在任务确实需要 3 步以上时调用（例如「把这几家都背调一遍，各自写一封开发信」「今天该跟进谁，逐个记一条跟进」）："
      + "开工前先给一份全 pending 的清单；此后每做完一步再调用一次，把全部步骤重发一遍（已完成的标 done、正在做的标 doing），"
      + "不要只发增量。单步问答、简单查询一律不要调用本工具。本工具只更新界面清单，不读写任何业务数据。",
    parameters: updatePlanSchema,
    execute: async (args) => {
      const gateNote = gate(ctx, "update_plan");
      if (gateNote) return gateNote;
      const items = normalizePlan(args.items);
      audit(ctx, "update_plan", "read", args, { steps: items.length }, "auto");
      return JSON.stringify(items.length
        ? { ok: true, notice: "清单已更新并展示给用户。直接继续执行下一步，不要在正文里复述这份清单。" }
        : { ok: false, notice: "清单为空（items 里每条都要有 text）。界面无变化；如非多步任务请直接作答，不要重复调用本工具。" });
    },
  });

  return [
    searchContacts, recordFollowup, quoteSearch, inboxSearch, emailSummarize,
    companyBackcheck, generateDraft, queueStatus, remindersDue, accountsStatus, sendQueueAdd,
    updatePlan,
  ];
}
