// ── Agent Harness 工具层 ──────────────────────────────────────────
// 每个工具 = @openai/agents tool() + 注册表元数据（副作用分级/预算）。
// execute 内强制：预算守卫 → 执行 → 审计落库。
// 审批不在这里各写一份：write 类工具的 needsApproval 统一由 buildHarnessTools 返回处
// 按注册表派生（见本文件末尾闸门），execute 只在人工批准后才可能运行。
import * as crypto from "crypto";
import { z } from "zod";
import { eq, like, or, and, desc, ne, sql, count, inArray } from "drizzle-orm";
import { tool } from "@openai/agents";
import { getDb, getRawDb, saveDatabase } from "../../db";
import { loadConfig, saveConfig } from "../../config";
import { readActiveEndpoint, endpointFamily } from "../endpoint.service";
import { queryStandard, standardToMarkdown, resolveQueryPod, podRawExpansion } from "../rates-standard";
import { contacts } from "../../db/schema/contacts";
import { companies } from "../../db/schema/companies";
import { interactions } from "../../db/schema/interactions";
import { inboxMessages } from "../../db/schema/inbox";
import { emailAccounts } from "../../db/schema/accounts";
import { agentToolCalls } from "../../db/schema/agent";
import { Log } from "../../logger";
import { okResult, failResult, type Result } from "../../errors";
import { checkBudget, requiresApprovalOf, ToolBudgetError } from "./policy";
import { getBody, markRead } from "../inbox.service";
import { checkReminders, setStage } from "../crm.service";
import { getSendStatus, getQueueItems, startDynamicSend } from "../send.service";
import { summarizeEmail, generateBackcheckReport, generateEmailDraft, searchCompany, type BackcheckReport } from "../ai.service";
import { upsertCompany } from "../company.service";
import { upsertContact, importContacts, deleteContactsBatch } from "../contact.service";
import { upsertTemplate } from "../template.service";
import { registerAction, type ActionCard } from "./actions";
import { lookupIdempotent, rememberResult, forget } from "./idempotency";
import { lookupCache, rememberCache, invalidateCache, countHit, countMiss } from "./tool-cache";
import { readIdentity } from "./identity";
import { parseDraft, parseTsv } from "./parser";
import { extractFact, rememberToolFact } from "./memory";
import { listQuotes, countQuotes, normalizeContainer, quoteOptions, probeBoardCached, remoteBase } from "../rate-sync.service";
import { writeArtifact, toCsv, type ArtifactFormat } from "../artifact.service";
import { runResearchScene, CRED_LABEL } from "../research.service";
import { startTask, normalizeBatchItems, normalizeBatchKind, normalizeMessageIds } from "../bg-task.service";
import { reportGap as reportGapRow } from "../gap.service";

/** 同一工具连续失败达此数 → 本回合暂停该工具（Q5 熔断：不让模型换参数死磕） */
export const MAX_CONSECUTIVE_FAILURES = 2;

// ── 导入联系人的归一化（纯函数，可单测）──────────────────────────
export interface ImportContactInput {
  name?: string | null; email: string; company?: string | null; country?: string | null;
  title?: string | null; phone?: string | null; stage?: string | null; note?: string | null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const impClean = (s?: string | null): string => (s ?? "").replace(/[\t\r\n]+/g, " ").trim();
/** 与 importContacts 的字段键对齐（firstName/lastName/companyName/extraNote 都是它的既有列） */
export const IMPORT_HEADER = ["firstName", "lastName", "email", "companyName", "country", "title", "phone", "stage", "extraNote"] as const;

/** 把归一化后的联系人数组拼成 importer 吃的 TSV：校验邮箱、批内按邮箱去重、全名拆 first/last、阶段缺省 cold。 */
export function buildImportTsv(contacts: ImportContactInput[]): { tsv: string; invalid: string[]; count: number } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  const rows: string[][] = [];
  for (const c of contacts) {
    const email = (c.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { invalid.push(impClean(c.name) || email || "(空)"); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    const full = impClean(c.name);
    const sp = full.indexOf(" ");
    const first = sp < 0 ? full : full.slice(0, sp);
    const last = sp < 0 ? "" : full.slice(sp + 1);
    rows.push([first, last, email, impClean(c.company), impClean(c.country), impClean(c.title), impClean(c.phone), impClean(c.stage) || "cold", impClean(c.note)]);
  }
  const tsv = [IMPORT_HEADER.join("\t"), ...rows.map(r => r.join("\t"))].join("\n");
  return { tsv, invalid, count: rows.length };
}

/**
 * SDK 层失败识别：参数校验类错误（InvalidToolInputError 等）发生在 execute 之前，
 * 走不到我们的 audit，于是熔断计数原本对这类失败完全失明——实测 flash 把 contactId
 * 发成 "1" 后原样重试 5 次撞满 max turns 就是这么漏过去的。这里按输出文本补记。
 * 注意：只管 SDK 文本错误；我们自己工具的业务失败走统一包络 ok:false（见 isEnvelopeFailure），
 * 两者分工，熔断才不会双重计数。
 */
export function isToolRuntimeError(out: string): boolean {
  return /An error occurred while running the tool|InvalidToolInputError|tool (?:call )?error|执行失败/i.test(out);
}

/**
 * 结构化失败判定：统一包络 ok:false（execute 之内的业务失败）。
 * gate 的流控返回（budget_exhausted/tool_suspended）不带 ok 字段，不算失败。
 */
export function isEnvelopeFailure(out: string): boolean {
  try {
    const o = JSON.parse(out) as { ok?: unknown };
    return !!o && typeof o === "object" && o.ok === false;
  } catch { return false; }
}

/** 成功包络：业务字段原样平铺，只加 ok:true（不破坏模型已认识的字段名） */
const okOut = (data: Record<string, unknown>): string => JSON.stringify({ ok: true, ...data });
/** 失败包络：code 供程序判断，message 是给模型看的人话（决定改参重试还是换路子） */
const failOut = (code: string, message: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ok: false, error: { code, message }, ...extra });

/** 按工具输出记一次成/败（成功清零，失败累加，达阈值后 gate() 会让该工具本回合静默） */
export function noteToolOutcome(ctx: ToolCtx, toolName: string | undefined, output: string): void {
  if (!toolName) return;
  const fails = ctx.failures ?? (ctx.failures = new Map());
  if (isToolRuntimeError(output)) fails.set(toolName, (fails.get(toolName) ?? 0) + 1);
  else fails.set(toolName, 0);
}

/** 回合内可用性门闸：先熔断后预算；返回 null 表示放行 */
function gate(ctx: ToolCtx, toolName: string): string | null {
  if ((ctx.failures?.get(toolName) ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    // 走失败包络：熔断态自持（模型再调仍计失败），失败卡也能如实显示
    return failOut("tool_suspended",
      `该工具本轮已连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，不再可用——这是程序内部机制，对用户只字不提「次数/上限/不可用/工具」这类词。`,
      { notice: "请基于本回合已取到的数据直接给结论；没办成的部分用一句自然的话说明卡在哪（如「暂时没查到有效信息」）并给替代路径（换个说法、稍后再试，或交后台任务）。"
        + "不要重复调用本工具，也不要把没取到的内容编出来。" });
  }
  return budgetNote(ctx.counts, toolName);
}

/** 读工具统一入口：先查缓存（命中不占配额、不写审计），未过闸再返回暂停/预算提示 */
function cachedRead(ctx: ToolCtx, toolName: string, args: unknown): string | null {
  const hit = lookupCache(ctx, toolName, args);
  if (hit !== null) { countHit(); return hit; }      // 命中：同一次查询的重复问法，不吃预算
  const note = gate(ctx, toolName);
  if (note) return note;
  countMiss();
  return null;
}

/** 读工具收尾：落审计 + 写缓存 */
function finishRead(ctx: ToolCtx, toolName: string, args: unknown, result: string): string {
  rememberCache(ctx, toolName, args, result);
  return result;
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

/** ISO/UTC 存储 → 北京时间可读串：时间交给模型换算就会编（实测把 12:13 写成 09:24） */
export function beijingTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const d = new Date(t + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const 日 = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return (d.toISOString().slice(0, 10) === new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    ? "今天 " : 日 + " ") + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}

const cell = (v: unknown): string => (v == null || v === "" ? "—" : String(v));

/**
 * 航线串拆成起运港/目的港：模型常整串传「上海到桑托斯」「Ningbo → Santos」，
 * 让它自己拆不稳（实测会把「桑托斯」拆成「托斯」）。拆不出来就交回调用方去问用户。
 */
export function splitRoute(route: string | null | undefined): { pol: string; pod: string } {
  const s = String(route || "").trim();
  if (!s) return { pol: "", pod: "" };
  const parts = s
    .split(/\s*(?:到|至|去|→|->|=>|\|{1,2}|[;,]|\/|[-—]\s?to\s?|\s+to\s+)\s*/i)
    .map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { pol: parts[0]!.slice(0, 40), pod: parts[1]!.slice(0, 40) };
  return { pol: "", pod: "" };
}

/** 与本地运价镜像对照（只报库里真有的：条数、USD 区间、最晚有效期；没有就 null，不编造） */
export function mirrorCompareForPod(podEn: string, podCn: string): string | null {
  for (const term of [podEn, podCn]) {
    const t = String(term || "").trim();
    if (!t) continue;
    const rows = listQuotes({ terms: [t], limit: 30 });
    if (!rows.success || !rows.data.length) continue;
    const prices = rows.data.map(q => q.oceanUsd).filter((n): n is number => typeof n === "number" && n > 0).sort((a, b) => a - b);
    const total = countQuotes({ terms: [t] });
    const latest = rows.data.map(q => q.validTo || "").sort().pop();
    return `镜像库「${t}」有 ${total} 条参考价`
      + (prices.length ? `，区间 ${prices[0]}–${prices[prices.length - 1]} USD` : "")
      + (latest ? `，最晚有效期 ${latest}` : "")
      + "；公开来源报价与它的差距要逐条对照口径判断，不要直接比大小";
  }
  return null;
}

export interface ResolvedContact { id: number; name: string; email: string; company: string | null }

/** 按 id / 邮箱 / 姓名 / 公司名在库里确定性定位联系人（最多回 10 条） */
function resolveContacts(q: string): ResolvedContact[] {
  const tokens = (q || "").split(/\s+/).filter(Boolean).slice(0, 4);
  if (!tokens.length) return [];
  const rows = getDb().select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    companyName: companies.name,
  }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(and(...tokens.map(tok => {
      const p = `%${tok}%`;
      return or(like(contacts.email, p), like(contacts.firstName, p), like(contacts.lastName, p), like(companies.name, p));
    }))).limit(10).all();
  return rows.map(r => ({
    id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
    email: r.email, company: r.companyName ?? null,
  }));
}

/**
 * 目标解析：contactId 优先，其次 contact（邮箱/姓名/公司名任一）。
 * 弱模型（实测 agnes-2.5-flash）串「先 search_contacts 再写」两步经常只走第一步，
 * 所以写工具自己定位人 —— 一步办成；检索在代码里做，不靠模型记忆。
 */
function pickTarget(
  args: { contactId?: number | null; contact?: string | null },
): { ok: true; person: ResolvedContact } | { ok: false; why: "ambiguous" | "notfound"; candidates: ResolvedContact[] } {
  if (args.contactId) {
    const one = getDb().select({
      id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
      companyName: companies.name,
    }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
      .where(eq(contacts.id, args.contactId)).get();
    if (one) {
      return { ok: true, person: {
        id: one.id, name: [one.firstName, one.lastName].filter(Boolean).join(" ") || one.email,
        email: one.email, company: one.companyName ?? null,
      } };
    }
  }
  const found = resolveContacts(args.contact || "");
  if (found.length === 1) return { ok: true, person: found[0]! };
  return { ok: false, why: found.length > 1 ? "ambiguous" : "notfound", candidates: found };
}

const candidatesText = (list: ResolvedContact[]) => list.slice(0, 5)
  .map(c => '#' + c.id + ' ' + c.name + (c.company ? '（' + c.company + '）' : '') + ' ' + c.email).join('；');

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

/** 预算超限时不 throw（模型会把 tool error 当“接口故障”继续绕），改为明确引导语令其基于已有数据作答。
 *  走失败包络（ok:false）：harness 的失败计数才能看见它——模型若无视引导继续调，
 *  连续 2 次后熔断接手（此前流控返回被当成功清零计数，重试风暴 10 连击就是这么漏的）。 */
function budgetNote(counts: Map<string, number>, toolName: string): string | null {
  try { checkBudget(counts, toolName); return null; }
  catch (e) {
    if (e instanceof ToolBudgetError) {
      return failOut("budget_exhausted",
        "本工具的回合内配额已用满——这是程序内部机制，对用户只字不提「次数/上限/限制」这类词。",
        { notice: "请立即交付已有结果：把已经取到的数据完整列给用户；还有没取到的部分，用一句自然的话说清楚（如「其余的下一条接着查」），不要说「请你自己打开客户端查看」，也不要编造。" });
    }
    throw e;
  }
}

export type { ToolCtx } from "./types";
import type { ToolCtx } from "./types";

/**
 * 宽松取值：模型常把 id 发成字符串（实测 flash 发 "1"）、把布尔发成 "false"、
 * 把 id 数组发成 "1,2"。zod 在这些情况下会抛 InvalidToolInputError —— 它发生在
 * execute 之前，我们的预算与熔断计数都看不见，模型只会原样重试到撞满 max turns。
 * 所以这里一律归一，归一不了就当没填，绝不让它炸。
 */
const toInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined;
};
const toBool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  return undefined;
};
const toIds = (v: unknown): number[] => {
  const raw = Array.isArray(v) ? v
    : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  return [...new Set(raw.map(toInt).filter((n): n is number => n !== undefined))].slice(0, 50);
};
/** 可选字符串：空串/全空格/null 一律归一为「未填」，不留给下游判 */
const optStr = (max: number) => z.preprocess(
  (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.string().max(max).nullable().optional(),
);

// 注意：可选字段必须 .nullable().optional() 成对出现 —— SDK 转 JSON Schema 时
// 只认这一种「可选」表达（少了 nullable 就整工具转换失败，实测踩过两次）。
const optInt = () => z.preprocess((v: unknown) => toInt(v) ?? undefined, z.number().int().nullable().optional());
const optBool = () => z.preprocess((v: unknown) => toBool(v) ?? undefined, z.boolean().nullable().optional());

// ── Schema 设计原则（live 评测两轮实锤）─────────────────────────
// ① 能用「钳制/归一」解决的，绝不用 .max()/.enum() 硬拒：zod 校验失败发生在 execute 之前，
//    预算守卫拦不住，模型会当成接口故障反复重试直到 max turns。
// ② 可选字段一律 .nullable().optional()：SDK 转 JSON Schema 要求可选字段以 nullable 表达
//    （否则报 "uses .optional() without .nullable()"）；而 DeepSeek 等模型确实会把没用上的
//    字段回传 null —— 声明可空后 null 能过校验，下游用 ?? / ?. / 真值判断天然按「未填」处理。
export const searchContactsSchema = z.object({
  query: z.string().min(1).max(80).describe("姓名/邮箱/公司名关键词；要查全库就传一个宽泛的词（如公司域名的常见片段）或 a"),
  limit: optInt().describe("返回条数上限，默认 10（发成字符串也行）"),
  sortBy: optStr(12).describe("传 'stale' = 按最近跟进时间升序（沉默最久的排前面，适合「沉默最久的是谁」类问题）"),
  hasPhone: optBool().describe("传 true = 只返回有电话号码的联系人（适合「有电话的客户」「要打电话的名单」类问题）"),
});

export const recordFollowupSchema = z.object({
  contactId: optInt().describe("联系人 id（可选；有 id 就不必填 contact）"),
  contact: optStr(80).describe("联系人定位串：邮箱、姓名或公司名任一（如 juan@acme.com 或 Juan Garcia）。本工具会自己在库里定位，不需要先调 search_contacts"),
  note: z.string().min(1).max(500).describe("跟进记录内容"),
});

// ── update_plan：界面任务清单（元工具，不读写任何业务数据）─────────────
export type PlanState = "pending" | "doing" | "done";
export interface PlanItem { /** 步骤稳定标识（文本哈希）：全量重发时渲染端据此识别同一步 */ id: string; text: string; state: PlanState }

const PLAN_DONE_RE = /^(done|completed|complete|finished|ok|已?完成|做完|已完成|已做)$/i;
const PLAN_DOING_RE = /^(doing|in[_\s-]?progress|running|active|wip|current|进行中|正在做|在做|当前)$/i;

/** 步骤 id：文本归一后的短哈希（同一步骤每次全量重发 id 不变） */
function planStepId(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
}

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
    return { id: planStepId(text), text, state };
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

// ── P2：产物导出 & 后台批量任务（元能力，均只读/只写产物目录）──────
export const exportArtifactSchema = z.object({
  // 参数只剩三个扁平字符串字段：弱模型手拼嵌套 JSON 数组极易写坏参数 JSON
  // （Invalid JSON input 发生在 SDK 内部，schema 宽松化与熔断都救不了，arch-export live 实锤），
  // 所以 csv 一律在 content 里写多行 TSV 文本，解析交给 parser.parseTsv。
  title: z.preprocess(
    (v: unknown) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : String(v)),
    z.string().max(60).nullable().optional(),
  ).describe("文件名（不带扩展名，如「未读邮件总结」）"),
  format: z.string().nullable().optional().describe("md 或 csv；其它写法按 md 处理"),
  content: z.string().nullable().optional()
    .describe("文件内容。md：Markdown 正文。csv：多行 TSV 文本——首行表头，每行一条记录，字段间用制表符分隔"),
});

const batchCompanySchema = z.object({
  name: z.string().describe("公司名（英文优先）"),
  country: z.string().nullable().optional().describe("国家/地区，帮助收敛搜索"),
});
export const startBatchTaskSchema = z.object({
  kind: z.string().nullable().optional().describe("backcheck=批量背调 / draft=批量开发信草稿 / email_summary=批量邮件总结；写「开发信」「写信」算 draft，写「总结邮件/邮件总结」算 email_summary"),
  companies: z.array(batchCompanySchema).nullable().optional().describe("backcheck/draft 用：要处理的公司列表，最多 10 家"),
  messageIds: z.array(z.number().int().positive()).nullable().optional().describe("email_summary 用：要总结的邮件 id 列表（来自 inbox_search），最多 60 封"),
});

export const importContactsSchema = z.object({
  contacts: z.array(z.object({
    name: z.string().nullable().optional().describe("姓名（整串即可，工具自动拆名/姓）"),
    email: z.string().describe("邮箱，必填——去重与写入的唯一键，缺了这条会被判无效"),
    company: z.string().nullable().optional().describe("公司名"),
    country: z.string().nullable().optional().describe("国家/地区"),
    title: z.string().nullable().optional().describe("职位"),
    phone: z.string().nullable().optional().describe("电话"),
    stage: z.string().nullable().optional().describe("阶段 cold/f1-f4，留空按 cold"),
    note: z.string().nullable().optional().describe("备注"),
  })).min(1).describe("要导入的联系人：把用户粘贴的任意内容（表格/名单/邮件签名等）整理成这个数组即可，不要反问用户要 CSV 还是 JSON"),
});

export const quoteSearchSchema = z.object({
  q: optStr(60).describe("用户说的那个词原样传（航线名、区域简称、中英文港名都行，如「地东」「伊斯坦布尔」「SANTOS」）——"
    + "工具会同时比对航线/目的港/起运港，不需要你先判断它属于哪个字段"),
  lane: optStr(20).describe("航线（库里真实存在的航线名，如 加勒比/南美东/地东），不传则全航线"),
  carrier: optStr(10).describe("船司三字码，如 CMA/MSK/MSC；不看船司就省略或传空"),
  pod: optStr(60).describe("目的港关键词（中英文均可，模糊匹配）；不限则省略或传空"),
  container: optStr(10).describe("柜型，如 20GP/40GP/40HQ/NOR（写 40HC 也会自动归一）；不限则省略或传空"),
  includeExpired: optBool().describe("是否包含已过有效期记录，默认 false"),
  limit: optInt().describe("返回条数，默认 20，按价格升序"),
});

export const inboxSearchSchema = z.object({
  query: optStr(120).describe("关键词，匹配发件人邮箱/主题/正文摘要；不传则返回最近邮件"),
  classification: z.string().max(20).nullable().optional()
    .describe("按系统分类过滤：inquiry=询盘 reply=回复 bounce=退信 auto_reply=自动回复；其他值视为不过滤"),
  intentFilter: optStr(20).describe("按意图过滤（可单用）：price_inquiry=询价 schedule_request=船期 cooperation=合作 follow_up=跟进；「有哪些询价」类问题优先用它"),
  unreadOnly: optBool().describe("只看未读，默认 false"),
  limit: optInt().describe("返回条数，默认 10，按时间倒序"),
});

export const emailSummarizeSchema = z.object({
  messageId: optInt().describe("邮件 id（单封时用；来自 inbox_search 返回）"),
  // 兜底字段：弱模型常自己发明 messageIds 想一次总结多封。本工具不做批量（一封封循环会撞
  // 本轮调用上限，且没有进度条），识别到这个意图时直接把请求转交给后台任务。
  // 上限与 toIds 的截断一致：卡在 max 上会让参数解析先炸掉（发生在预算计数之前，模型只会重试到 max turns）。
  messageIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).max(50).nullable().optional())
    .describe("不要传：本工具一次只总结一封。多封邮件一律用 start_batch_task(kind=\"email_summary\", messageIds=[…])"),
});

export const marketResearchSchema = z.object({
  route: optStr(80).describe("整串航线，如「上海到桑托斯」「Ningbo → Santos」（工具内部会拆成起运/目的港）"),
  pol: optStr(40).describe("起运港（与 route 二选一；中文名/英文/UNLOCODE 都行）"),
  pod: optStr(40).describe("目的港（与 route 二选一）"),
  scope: optStr(12).describe("rates=只看运价 / schedules=只看船期 / both=两者（默认 both）"),
  container: optStr(8).describe("柜型 20GP / 40GP / 40HQ，留空为不限"),
  weeks: optInt().describe("时间窗「近期」按最近 N 周，默认 4，上限 12"),
});

export const companyBackcheckSchema = z.object({
  companyName: z.string().min(2).max(80).describe("公司名（英文优先，可用行业常见拼写）"),
  country: optStr(40).describe("国家/地区，帮助收敛搜索"),
});

export const generateDraftSchema = z.object({
  companyName: optStr(80).describe("目标公司名（给了 contact 时可省略，工具会用库里档案补全）"),
  contactName: optStr(60).describe("收件人姓名（给了 contact 时可省略）"),
  language: z.string().max(8).nullable().optional().describe("输出语言：EN 英语 / ES 西语 / PT 葡语；其他值按 EN 处理"),
  focus: optStr(300).describe("内容侧重提示，如主推航线、客户痛点"),
  contactId: optInt().describe("收件联系人 id（可选）"),
  contact: optStr(80).describe("收件人的邮箱/姓名/公司名任一；给了它本工具会自己定位人并补全姓名与公司，无需先调 search_contacts"),
});

export const sendQueueAddSchema = z.object({
  contactIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).max(50))
    .describe("收件联系人 id 列表；也接受字符串数组或 \"1,2\" 形式。只有一个收件人时可改用 contact"),
  contact: optStr(80).describe("单个收件人的邮箱/姓名/公司名（本工具会自己定位人，无需先调 search_contacts）"),
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
  // 记忆写入：成功才抽一行事实给下一轮引用（失败与拒绝不值得记）
  if (!error) {
    const fact = extractFact(toolName, result);
    if (fact) rememberToolFact(ctx.conversationId, toolName, fact);
  }
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

// ── 控制面：配置快照与受控补丁（docs/agent-control-plane-spec.md）────────
// 密钥/端点密钥/检索源令牌永不进快照（红线）。
export function programConfigSnapshot() {
  const c = loadConfig();
  const ep = readActiveEndpoint();
  // 账号查询容错：无库环境（单测）返回空表，不阻塞快照其余部分
  let accounts: Array<{ email: string; displayName: string | null; isActive: number | null; lastFetchError: string | null }> = [];
  try {
    accounts = getDb().select({
      email: emailAccounts.email, displayName: emailAccounts.displayName,
      isActive: emailAccounts.isActive, lastFetchError: emailAccounts.lastFetchError,
    }).from(emailAccounts).all();
  } catch { /* DB 未初始化 */ }
  return {
    schedule: {
      timeWindowEnabled: c.schedule.timeWindowEnabled,
      startHour: c.schedule.startHour, endHour: c.schedule.endHour,
      groupSize: c.schedule.groupSize,
      groupDelayMinSeconds: c.schedule.groupDelayMinSeconds,
      groupDelayMaxSeconds: c.schedule.groupDelayMaxSeconds,
    },
    sendQuota: c.sendQuota ?? null,
    testMode: { enabled: c.test.enabled, dryRun: c.test.dryRun },
    identity: { ...readIdentity() },   // 仅 fromName 可配；公司身份恒定
    crm: { ...c.crm },
    accounts: accounts.map(a => ({
      email: a.email, displayName: a.displayName || null,
      isActive: !!a.isActive, lastFetchError: a.lastFetchError || null,
    })),
    endpoint: { model: ep.model || null, baseUrl: ep.baseUrl || null, family: endpointFamily(ep.baseUrl) },
  };
}

function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "是", "开", "on"].includes(s)) return true;
  if (["false", "0", "no", "否", "关", "off"].includes(s)) return false;
  throw new Error(`不是布尔值：${v}`);
}
function intIn(min: number, max: number) {
  return (v: string): number => {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`需 ${min}-${max} 的整数，收到 ${v}`);
    return n;
  };
}
function strMax(max: number) {
  return (v: string): string => {
    const s = v.trim();
    if (s.length > max) throw new Error(`超过 ${max} 字`);
    return s;
  };
}

/** 域 → 字段白名单与校验器；不在表里的键一律拒绝（防弱模型瞎传） */
const CONFIG_PATCHERS: Record<string, Record<string, (v: string) => number | boolean | string>> = {
  schedule: {
    timeWindowEnabled: parseBool, startHour: intIn(0, 23), endHour: intIn(0, 23),
    groupSize: intIn(1, 500), groupDelayMinSeconds: intIn(0, 86_400), groupDelayMaxSeconds: intIn(0, 86_400),
  },
  quota: { dailyLimit: intIn(1, 100_000) },
  test: { enabled: parseBool, dryRun: parseBool, email: strMax(80), company: strMax(80) },
  crm: {
    "followupDays.reaching": intIn(1, 365), "followupDays.quoting": intIn(1, 365),
    "followupDays.trial": intIn(1, 365), "followupDays.cooperating": intIn(1, 365),
    "followupDays.lost": intIn(1, 365), "followupDays.other": intIn(1, 365),
    todoAdvanceDays: intIn(0, 60), autoArchiveDays: intIn(0, 365),
  },
  // 注意：config.json 里的 identity{company/title/business/persona} 是历史死字段，
  // readIdentity() 只认 fromName（公司身份写死在 identity.ts）——白名单只开 fromName。
  identity: { fromName: strMax(40) },
};

/**
 * 应用配置补丁。kvs = 多行 "key=value"（弱模型友好，不传嵌套 JSON）。
 * 返回 before/after 差异供确认卡与回答展示；任一行非法 → 整批拒绝（不半改）。
 */
export function applyConfigPatch(domain: string, kvs: string):
  Result<{ changed: Array<{ field: string; from: unknown; to: unknown }> }> {
  const patchers = CONFIG_PATCHERS[domain];
  if (!patchers) {
    return failResult(`不支持的配置域「${domain}」，可用：${Object.keys(CONFIG_PATCHERS).join("/")}`);
  }
  const c = loadConfig();
  const target: Record<string, unknown> =
    domain === "schedule" ? { ...c.schedule } :
    domain === "quota" ? { ...(c.sendQuota ?? { dailyLimit: 1500, firstSendAt: null, sentToday: 0 }) } :
    domain === "test" ? { ...c.test } :
    domain === "crm" ? { ...c.crm, followupDays: { ...c.crm.followupDays } } :
    { fromName: c.fromName };
  const changed: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const line of kvs.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) return failResult(`行格式应为 key=value：${t}`);
    const key = t.slice(0, eq).trim();
    const raw = t.slice(eq + 1).trim();
    const p = patchers[key];
    if (!p) return failResult(`「${domain}」没有字段 ${key}，可用：${Object.keys(patchers).join("/")}`);
    let val: unknown;
    try { val = p(raw); } catch (e) { return failResult(e instanceof Error ? e.message : String(e)); }
    const from = key.includes(".")
      ? (target[key.split(".")[0]!] as Record<string, unknown>)[key.split(".")[1]!]
      : target[key];
    if (from === val) continue;
    if (key.includes(".")) {
      const [a, b] = key.split(".");
      (target[a!] as Record<string, unknown>)[b!] = val;
    } else target[key] = val;
    changed.push({ field: key, from, to: val });
  }
  if (!changed.length) return failResult("没有需要修改的字段（值与当前一致或 kvs 为空）");
  // 落盘
  if (domain === "schedule") c.schedule = target as unknown as typeof c.schedule;
  else if (domain === "quota") c.sendQuota = target as unknown as typeof c.sendQuota;
  else if (domain === "test") c.test = target as unknown as typeof c.test;
  else if (domain === "crm") c.crm = target as unknown as typeof c.crm;
  else c.fromName = String(target.fromName ?? c.fromName);
  saveConfig(c);
  return okResult({ changed });
}

/** 联系人 tags JSON → 字符串数组（容错） */
const tagsArr = (s: string | null | undefined): string[] => {
  try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; }
  catch { return []; }
};

export function buildHarnessTools(ctx: ToolCtx) {
  // 身份档案：一处读，供单封与批量两处成信时自落款（免得留 {{firstName}} 占位）
  const sender = readIdentity();
  const searchContacts = tool({
    name: "search_contacts",
    description: "在本地联系人库按姓名/邮箱/公司名关键词检索，返回结构化记录（含 id/姓名/邮箱/公司/国家/阶段）。涉及客户的事实性回答必须且只能基于本工具返回的数据。绝对不要用本工具查运价、邮件或公司公开背景（那是 quote_search / inbox_search / company_backcheck）。",
    parameters: searchContactsSchema,
    execute: async (args) => {
      const cached = cachedRead(ctx, "search_contacts", args);
      if (cached) return cached;
      // 按词切分匹配（live 评测实锤：模型常传全名 "Juan Garcia"，整串 LIKE 匹配不上单列 firstName/lastName → 误判查无此人）
      const perToken = args.query.split(/\s+/).filter(Boolean).slice(0, 4).map(tok => {
        const p = `%${tok}%`;
        return or(like(contacts.email, p), like(contacts.firstName, p), like(contacts.lastName, p), like(companies.name, p));
      });
      // hasPhone 过滤：只返回有电话号码的联系人
      if (args.hasPhone) {
        perToken.push(and(sql`${contacts.phone} IS NOT NULL`, sql`${contacts.phone} != ''`));
      }
      // A2：真总数（不带 total 时模型会拿"本批行数"当全库数，live 评测实锤过同类坑）
      const total = getDb()
        .select({ n: count() })
        .from(contacts)
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(and(...perToken))
        .all()[0]?.n ?? 0;
      const limit = Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50);
      // B：最近跟进时间（读时合并口径：interactions ∪ inbox 邮件取较新者，与 CRM 看板同源）
      const mergedLatest = (ids: number[]): Map<number, string> => {
        const m = new Map<number, string>();
        if (!ids.length) return m;
        const take = (cid: number | null, at: string | null) => {
          if (cid == null || !at) return;
          const cur = m.get(cid);
          if (!cur || at > cur) m.set(cid, at);
        };
        const chunk = 200;
        for (let i = 0; i < ids.length; i += chunk) {
          const part = ids.slice(i, i + chunk);
          const rows1 = getDb().select({ contactId: interactions.contactId, at: sql<string>`MAX(${interactions.createdAt})` })
            .from(interactions).where(inArray(interactions.contactId, part)).groupBy(interactions.contactId).all();
          for (const r of rows1) take(r.contactId, r.at);
          const rows2 = getDb().select({ cid: inboxMessages.matchedContactId, at: sql<string>`MAX(${inboxMessages.receivedAt})` })
            .from(inboxMessages).where(inArray(inboxMessages.matchedContactId, part)).groupBy(inboxMessages.matchedContactId).all();
          for (const r of rows2) take(r.cid, r.at);
        }
        return m;
      };
      type ContactHit = {
        id: number; name: string; email: string; company: string | null; country: string | null;
        stage: string | null; status: string | null; lastFollowupAt: string | null;
      };
      let out: ContactHit[];
      if (args.sortBy === "stale") {
        // 精确版沉默排序：一条 SQL 聚合完成（CTE 合并两表取最晚，未跟进者排最前）。
        // 探针实测全库 8714 行 16ms——JS 侧"先取 400 行再排"会漏掉 400 名开外的人，弃用。
        const conds: string[] = [];
        const params: string[] = [];
        for (const tok of args.query.split(/\s+/).filter(Boolean).slice(0, 4)) {
          const p = `%${tok}%`;
          conds.push("(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR cp.name LIKE ?)");
          params.push(p, p, p, p);
        }
        const staleRows = getRawDb().prepare(
          `WITH last_act AS (
             SELECT contact_id AS cid, MAX(created_at) AS at FROM interactions GROUP BY contact_id
             UNION ALL
             SELECT matched_contact_id, MAX(received_at) FROM inbox_messages WHERE matched_contact_id IS NOT NULL GROUP BY matched_contact_id
           ), merged AS (SELECT cid, MAX(at) AS last_at FROM last_act GROUP BY cid)
           SELECT c.id AS id, c.email AS email, c.first_name AS firstName, c.last_name AS lastName,
                  c.country AS country, c.stage AS stage, c.status AS status, cp.name AS companyName,
                  c.title AS title, c.tags AS tags, c.extra AS extra,
                  m.last_at AS lastFollowupAt
           FROM contacts c
           LEFT JOIN merged m ON m.cid = c.id
           LEFT JOIN companies cp ON cp.id = c.company_id
           ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
           ORDER BY (m.last_at IS NULL) DESC, m.last_at ASC
           LIMIT ?`,
        ).all(...params, limit) as Array<{
          id: number; email: string; firstName: string | null; lastName: string | null;
          country: string | null; stage: string | null; status: string | null;
          companyName: string | null; lastFollowupAt: string | null;
          title: string | null; tags: string | null; extra: string | null;
        }>;
        out = staleRows.map(r => ({
          id: r.id,
          name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
          email: r.email, company: r.companyName, country: r.country,
          stage: r.stage, status: r.status,
          title: r.title, tags: tagsArr(r.tags),
          preferences: (() => { try { const e = JSON.parse(r.extra || "{}"); return Array.isArray(e.preferences) ? e.preferences : []; } catch { return []; } })(),
          lastFollowupAt: r.lastFollowupAt ?? null,
        }));
      } else {
        const baseRows = getDb()
          .select({
            id: contacts.id, email: contacts.email,
            firstName: contacts.firstName, lastName: contacts.lastName,
            country: contacts.country, stage: contacts.stage, status: contacts.status,
            title: contacts.title, tags: contacts.tags, extra: contacts.extra,
            phone: contacts.phone,
            companyName: companies.name,
          })
          .from(contacts)
          .leftJoin(companies, eq(contacts.companyId, companies.id))
          .where(and(...perToken))
          .limit(limit)
          .all();
        const latest = mergedLatest(baseRows.map(r => r.id));
        out = baseRows.map(r => ({
          id: r.id,
          name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
          email: r.email, company: r.companyName, country: r.country,
          stage: r.stage, status: r.status,
          title: r.title, tags: tagsArr(r.tags),
          preferences: (() => { try { const e = JSON.parse(r.extra || "{}"); return Array.isArray(e.preferences) ? e.preferences : []; } catch { return []; } })(),
          lastFollowupAt: latest.get(r.id) ?? null,
        }));
      }
      audit(ctx, "search_contacts", "read", args, out, "auto");
      // 空结果给显式收敛信号：模型往往会换词重试直至 max turns（live 评测实锤）
      if (out.length === 0) {
        return okOut({ results: [], total: 0, notice: "库中没有匹配该关键词的联系人。请直接如实告知用户查无此人，不要用相同参数重复调用本工具。" });
      }
      const QUIET_NOTE = "本结果卡不会展示给用户（静默检索）：正文禁止复述联系人名单或按行描述，直接给结论；"
        + "只允许引用本批 results 里的人——此前对话或其他来源的联系人（姓名/公司/备注）一律不得混入本轮回答，results 里没有就明说未检索到。";
      const completeNote = total <= out.length
        ? { complete: true as const, notice: `命中数据已全部返回（共 ${total} 条），无需再调用本工具，直接作答。沉默天数请直接引用 lastFollowupAt 与正文计算结果，不要自己换算。${QUIET_NOTE}` }
        : { notice: `共命中 ${total} 条，本批返回前 ${out.length} 条（sortBy:'stale' 时为沉默最久的前若干名）。回答时必须说明「共 ${total} 条，展示前 ${out.length} 条」，不要把本批行数说成总数。${QUIET_NOTE}` };
      // 唯一命中 → 直接续问写开发信（带上 contactId，草稿结果卡才能长出「入队」按钮）
      if (out.length === 1 && total === 1) {
        const one = out[0]!;
        return okOut({
          results: out, total,
          actions: [promptAction(
            "给 TA 写一封开发信",
            `给联系人 #${one.id} ${one.name}（${one.company || "无公司名"}${one.country ? `，${one.country}` : ""}）写一封开发信，先想清楚切入点再动笔`,
          )],
        });
      }
      // P1-5：多命中 → 两种批量路径任选：整批各生成一封入队（写动作），或续问聚焦
      const batch = out.slice(0, 10);
      return okOut({
        results: out, total, ...completeNote,
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
                const draft = await generateEmailDraft({ language: lang, companyName: companyName || c.company || name, contactName: name, sender });
                if (!draft.success) { failed.push(name); continue; }
                const { subject, body } = parseDraft(draft.data, `Following up — ${companyName || name}`);
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
    execute: async (args) => {
      const gateNote = gate(ctx, "record_followup");
      if (gateNote) return gateNote;
      // 幂等：同一会话里相同内容 5 分钟内只落一次（模型重复提交/用户连点）
      const dup = lookupIdempotent(ctx, "record_followup", args);
      if (dup) return dup;
      // 定位人：id 或 邮箱/姓名/公司名任一（弱模型不必先调 search_contacts）
      const target = pickTarget(args);
      if (!target.ok) {
        const why = target.why === "ambiguous"
          ? `「${args.contact}」匹配到多位联系人，请用 contactId 指定其一：${candidatesText(target.candidates)}`
          : `库里找不到「${args.contact ?? `#${args.contactId}`}」，请先用 search_contacts 确认这人是否已建档`;
        audit(ctx, "record_followup", "write", args, undefined, "approved", "未定位到联系人");
        return failOut(target.why, why);
      }
      const pid = target.person.id;
      getDb().insert(interactions).values({
        contactId: pid, type: "note", direction: "outbound",
        channel: "manual", bodyPreview: args.note,
      }).run();
      saveDatabase();
      audit(ctx, "record_followup", "write", args, { ok: true }, "approved");
      invalidateCache("record_followup");
      const who = `${target.person.name}（#${pid}${target.person.company ? ` · ${target.person.company}` : ""}）`;
      const stageRow = getDb().select({ stage: contacts.stage }).from(contacts).where(eq(contacts.id, pid)).get();
      const nextStage = nextStageAfter(stageRow?.stage ?? null);
      const out = okOut({
        say: `已为 ${who} 记录跟进。`,
        notice: nextStage
          ? `提示用户：TA 当前阶段是「${stageRow?.stage ?? "冷开发"}」，要不要顺手推进到「${nextStage.label}」？（可在 CRM 看板里改，或让我用动作卡来做）`
          : "（该联系人已是终态阶段，无需推进）",
      });
      rememberResult(ctx, "record_followup", args, out);
      return out;
    },
  });

  const deleteContacts = tool({
    name: "delete_contacts",
    description: "删除联系人（可按邮箱后缀批量，如清理 no.email 占位地址）。破坏性操作：往来记录一并删除、"
      + "收件箱邮件保留但解除关联、无联系人的空壳公司自动清理，**删除不可恢复**。执行前必须弹出人工确认，"
      + "确认卡上会列命中名单样例；建议用户先在客户页导出备份。单次上限 500 人，超出拒绝并提示分批。"
      + "查命中多少但暂不删 → 用 search_contacts；本工具只在用户明确说「删除」时调用。",
    parameters: z.object({
      emailSuffix: optStr(60).describe("按邮箱后缀过滤（如 no.email）；与 query 二选一或并用"),
      query: optStr(80).nullable().describe("姓名/邮箱/公司名关键词（与 search_contacts 同词法）；只按后缀删时可传 null"),
    }),
    execute: async (args) => {
      const gateNote = gate(ctx, "delete_contacts");
      if (gateNote) return gateNote;
      const suffix = (args.emailSuffix ?? "").trim().replace(/^@/, "");
      const tokens = String(args.query ?? "").split(/\s+/).filter(Boolean).slice(0, 4);
      if (!suffix && !tokens.length) {
        return failOut("invalid_args", "至少要给 emailSuffix 或 query 之一的过滤条件，拒绝无条件全库删除。");
      }
      // 后缀条件是 AND（no.email）；query 的多词是 OR 组——语义：后缀命中且（含任一关键词）
      const suffixConds = suffix ? [like(contacts.email, `%${suffix}`)] : [];
      const tokenConds = tokens.flatMap(tok => [like(contacts.email, `%${tok}%`), like(contacts.firstName, `%${tok}%`), like(contacts.lastName, `%${tok}%`), like(companies.name, `%${tok}%`)]);
      const where = and(...suffixConds, ...(tokenConds.length ? [or(...tokenConds)] : []));
      const hits = getDb().select({
        id: contacts.id, email: contacts.email,
        firstName: contacts.firstName, lastName: contacts.lastName,
      }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(where).limit(501).all();
      const total = hits.length === 501 ? getDb().select({ n: count() }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id)).where(where).all()[0]!.n : hits.length;
      if (!hits.length) {
        audit(ctx, "delete_contacts", "write", args, { matched: 0 }, "approved");
        return okOut({ matched: 0, notice: "没有命中任何联系人，未执行删除。请如实告知用户（可能后缀拼写不同），不要重复调用。" });
      }
      if (total > 500) {
        audit(ctx, "delete_contacts", "write", args, { matched: total, refused: "over_limit" }, "approved");
        return failOut("over_limit", `命中 ${total} 人超过单次上限 500。请提示用户缩小条件（加关键词/分批）后重试，不要自己放宽条件。`);
      }
      // 执行删除（确认已由 SDK 中断流完成；此处 ids 是确认卡上那批的子集校验）
      const ids = hits.map(h => h.id);
      const r = deleteContactsBatch(ids);
      if (!r.success) {
        audit(ctx, "delete_contacts", "write", args, undefined, "approved", r.error);
        return failOut("delete_failed", `删除失败：${r.error}`);
      }
      invalidateCache("search_contacts");
      invalidateCache("reminders_due");
      const sample = hits.slice(0, 5).map(h => `#${h.id} ${[h.firstName, h.lastName].filter(Boolean).join(" ") || h.email}`).join("、");
      audit(ctx, "delete_contacts", "write", args, { deleted: r.data.deleted, companiesRemoved: r.data.companiesRemoved, sample }, "approved");
      return okOut({
        deleted: r.data.deleted, companiesRemoved: r.data.companiesRemoved, matched: total,
        say: `已删除 ${r.data.deleted} 个联系人${r.data.companiesRemoved ? `（含 ${r.data.companiesRemoved} 个空壳公司自动清理）` : ""}：${sample}${total > 5 ? ` 等 ${total} 人` : ""}。`,
        notice: "已删除不可恢复。若用户后续要找回，只能从备份导入。提醒用户相关往来记录已一并删除。",
      });
    },
  });

  const readProgramConfig = tool({
    name: "read_program_config",
    description: "读取程序当前运行配置：发信时段/组间暂停/每组人数、日限额、测试模式、身份档案、"
      + "CRM 跟进天数、发信账号清单、生效端点（不含任何密钥）。用户问「程序怎么配的/为什么这个点不发/"
      + "限额多少」时必须先调本工具，禁止凭印象回答。要改配置用 update_program_config。",
    parameters: z.object({}),
    execute: async () => {
      const gateNote = gate(ctx, "read_program_config");
      if (gateNote) return gateNote;
      const snap = programConfigSnapshot();
      audit(ctx, "read_program_config", "read", undefined, snap, "auto");
      return finishRead(ctx, "read_program_config", {}, okOut({
        config: snap,
        notice: "这是只读快照。用户要改配置时调用 update_program_config（会弹确认），不要自己承诺已改。",
      }));
    },
  });

  const updateProgramConfig = tool({
    name: "update_program_config",
    description: "修改程序配置（写操作，执行前一律弹人工确认）。"
      + 'domain 取 schedule/quota/test/crm/identity；kvs 为多行 key=value（如 "startHour=9\nendHour=18"）。'
      + "字段白名单：schedule=timeWindowEnabled/startHour/endHour/groupSize/groupDelayMinSeconds/groupDelayMaxSeconds；"
      + "quota=dailyLimit；test=enabled/dryRun/email/company；crm=followupDays.<阶段>/todoAdvanceDays/autoArchiveDays；"
      + "identity=fromName（公司身份恒定不可改）。"
      + "端点/密钥/检索源不在本工具射程——用户要改那些，引导去设置页。"
      + "先 read_program_config 拿现值，只传要改的键；确认被拒则如实告知未改。",
    parameters: z.object({
      domain: z.string().describe("配置域：schedule/quota/test/crm/identity"),
      kvs: z.string().describe("多行 key=value，只写要改的键"),
    }),
    execute: async (args) => {
      const gateNote = gate(ctx, "update_program_config");
      if (gateNote) return gateNote;
      const r = applyConfigPatch(String(args.domain ?? "").trim(), String(args.kvs ?? ""));
      if (!r.success) {
        audit(ctx, "update_program_config", "write", args, undefined, "approved", r.error);
        return failOut("invalid_patch", r.error);
      }
      audit(ctx, "update_program_config", "write", args, r.data, "approved");
      return okOut({
        changed: r.data.changed,
        say: `已修改 ${r.data.changed.length} 项配置：` +
          r.data.changed.map((xx: { field: string; from: unknown; to: unknown }) => `${xx.field} ${String(xx.from)} → ${String(xx.to)}`).join("；"),
        notice: "配置即时生效，无需重启。若用户问为什么，说明改的是哪个域。",
      });
    },
  });

  const updateContact = tool({
    name: "update_contact",
    description: "更新一位联系人的档案字段（写操作，需确认）。可改：title/phone/country/clientType"
      + "(agent|direct)/tags(逗号分隔)/preference(偏好备注，追加进 extra.preferences 数组)。"
      + "定位用 contactId 或 contact（邮箱/姓名/公司名）。不改 status/stage（状态由收信与 CRM 管）。"
      + "从邮件里读到的客户偏好（语种/航线/柜型习惯）应落到 preference，别只写跟进流水。",
    parameters: z.object({
      contactId: optInt().describe("联系人 id（有它就不必填 contact）"),
      contact: optStr(80).describe("邮箱/姓名/公司名任一"),
      title: optStr(60), phone: optStr(40), country: optStr(40),
      clientType: optStr(10).describe("agent 或 direct"),
      tags: optStr(120).describe("逗号分隔标签，如 reaching,重点"),
      preference: optStr(200).describe("偏好备注，追加写入 extra.preferences"),
    }),
    execute: async (args) => {
      const gateNote = gate(ctx, "update_contact");
      if (gateNote) return gateNote;
      const target = pickTarget(args);
      if (!target.ok) {
        const why = target.why === "ambiguous"
          ? `「${args.contact}」匹配到多位联系人，请用 contactId 指定：${candidatesText(target.candidates)}`
          : `库里找不到「${args.contact ?? `#${args.contactId}`}」`;
        audit(ctx, "update_contact", "write", args, undefined, "approved", why);
        return failOut(target.why, why);
      }
      const id = target.person.id;
      const row = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
      if (!row) return failOut("notfound", "联系人已不存在");
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const changed: string[] = [];
      if (args.title != null) { set.title = args.title; changed.push(`职位→${args.title}`); }
      if (args.phone != null) { set.phone = args.phone; changed.push(`电话→${args.phone}`); }
      if (args.country != null) { set.country = args.country; changed.push(`国家→${args.country}`); }
      if (args.clientType != null) {
        if (!["agent", "direct"].includes(args.clientType)) return failOut("invalid", "clientType 只能是 agent 或 direct");
        set.clientType = args.clientType; changed.push(`客户类型→${args.clientType}`);
      }
      if (args.tags != null) {
        const arr = args.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
        set.tags = JSON.stringify(arr); changed.push(`标签→${arr.join("/") || "清空"}`);
      }
      if (args.preference != null) {
        let extra: Record<string, unknown> = {};
        try { extra = JSON.parse(row.extra || "{}"); } catch { /* 坏 JSON 当空 */ }
        const prefs = Array.isArray(extra.preferences) ? extra.preferences as string[] : [];
        if (!prefs.includes(args.preference)) prefs.push(args.preference);
        extra.preferences = prefs.slice(-10);
        set.extra = JSON.stringify(extra); changed.push("偏好已追加");
      }
      if (!changed.length) return failOut("noop", "没有要改的字段");
      getDb().update(contacts).set(set).where(eq(contacts.id, id)).run();
      saveDatabase();
      invalidateCache("update_contact");
      audit(ctx, "update_contact", "write", args, { id, changed }, "approved");
      return okOut({ id, changed, say: `已更新联系人 #${id}：${changed.join("；")}` });
    },
  });

  const emailReadFull = tool({
    name: "email_read_full",
    description: "按 messageId 读取一封邮件的完整信息：全文正文（懒加载，含 IMAP 原文）、"
      + "发件人/收件人/抄送、时间、分类、意图、附件文件名。用户要「原文/全文/完整内容」时用；"
      + "只要摘要用 email_summarize。正文超长会截断并标注。",
    parameters: z.object({ messageId: z.number().int().describe("inbox_search 返回的 id") }),
    execute: async (args) => {
      const gateNote = gate(ctx, "email_read_full");
      if (gateNote) return gateNote;
      const row = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
      if (!row) return failOut("not_found", `邮件 #${args.messageId} 不存在，先 inbox_search 拿 id`);
      const bodyR = await getBody(args.messageId);
      const full = bodyR.success ? bodyR.data : (row.bodyPreview || "");
      const CAP = 12_000;
      audit(ctx, "email_read_full", "read", args, { id: row.id, len: full.length }, "auto");
      return finishRead(ctx, "email_read_full", args, okOut({
        id: row.id, from: row.fromEmail, fromName: row.fromName,
        to: row.to || null, cc: row.cc || null, subject: row.subject,
        receivedAt: row.receivedAt, classification: row.classification, intent: row.intent || null,
        body: full.slice(0, CAP),
        ...(full.length > CAP ? { notice: `正文共 ${full.length} 字，已截断到 ${CAP} 字；要存档用 export_artifact。` } : {}),
      }));
    },
  });

  const quoteSearch = tool({
    name: "quote_search",
    description: "查询本地海运运价镜像库（真源 = 局域网台账 board_server；启动 5 秒后与每 4 小时全量刷新镜像）。"
      + "绝对不要用它回答客户、联系人、邮件内容或公司背景问题（那是 search_contacts / inbox_search / company_backcheck 的事）。"
      + "用户给了一个词就原样传 q（不必判断它是航线名还是港口名，工具会跨字段比对）；所有参数均可省略，省略的条件视为不限。"
      + "没命中时按返回的 notice 指引走：第一轮先照 candidates 换词重试一次，两轮都没命中才按 notice 给的口径回答——"
      + "「本地镜像查不到」与「该航线没有报价」是两件事，不得混说，更不得编造价格。"
      + "返回 目的港/船司/柜型/USD价/有效期/备注 结构化列表，按价格升序。运价相关问题必须且只能基于本工具结果回答；结果为参考价，回答时须提醒以船司实时报价为准。",
    parameters: quoteSearchSchema,
    execute: async (args) => {
      const cached = cachedRead(ctx, "quote_search", args);
      if (cached) return cached;
      // 模型可传 null（字段已声明 nullable），统一在此收敛成 undefined，保证 QuoteFilters 契约干净
      const trimmed = (v: string | null | undefined): string | undefined => {
        const t = (v ?? "").trim();
        return t || undefined;                    // 空串与 null 都按「不过滤」处理
      };
      const podQ = trimmed(args.pod);
      const qQ = trimmed(args.q);
      // 口语后缀去掉（「加勒比线」「南美东航线」→ 加勒比 / 南美东）
      const laneQ = trimmed(args.lane)?.replace(/航线$/, "").replace(/线$/, "").trim() || undefined;
      // 港口归一：用户任意写法→标准港名；并把航线级/区域级 podRaw 展开进过滤
      // （查 SANTOS 时 podRaw=「南美东」「WCSA」的行也要命中，否则漏掉航线级报价）
      const canon = podQ ? resolveQueryPod(podQ) : undefined;
      // L1 机械层：每个词各自跨字段 OR（航线/目的港/起运港），词之间 AND。
      // 「地东」是航线还是港名不由机械层猜、也不由模型猜——猜错字段就是漏查（规范 rates-query-fallback-spec §1）
      const termWords = [...new Set([qQ, laneQ, podQ].filter((x): x is string => !!x)
        .flatMap(w => [w, resolveQueryPod(w)].map(t => t.trim()).filter(Boolean)))];
      const filters = {
        carrier: trimmed(args.carrier)?.toUpperCase(),
        pod: podQ,
        podExtra: canon ? podRawExpansion(canon) : undefined,
        terms: termWords.length ? termWords : undefined,
        // 脏柜型归一（40HC→40HQ 等），识别不了则原样大写透传
        container: normalizeContainer(trimmed(args.container) ?? null) ?? trimmed(args.container)?.toUpperCase() ?? undefined,
        includeExpired: args.includeExpired ?? undefined,
      };
      const r = listQuotes({ ...filters, limit: args.limit && args.limit > 0 ? args.limit : 20 });
      if (!r.success) {
        audit(ctx, "quote_search", "read", args, undefined, "auto", r.error);
        return failOut("query_failed", `查询失败：${r.error}`);
      }
      // total=满足条件的真总数（评测发现只给截断行数会让模型反复重试凑数直至 max turns）
      const total = countQuotes(filters);
      // 固定回答格式：结论与客户表格由工具预计算，模型只许复述——
      // 格式漂移（每次长得不一样）和双表格（正文重抄界面表格卡）都在这根治
      const fmtUsd = (n: number | null) => (n != null ? `$${n.toLocaleString("en-US")}` : "议价");
      // 客户表格优先用标准化层（data/rates-standard.json，柜型已透视成 20/40/NOR 三列、港口已归一）；
      // 无该文件时回退用镜像行拼表。两条路都是机械生成，模型只许原样贴。
      const stdWord = podQ || qQ || laneQ;
      const stdRows = stdWord ? queryStandard(stdWord, { carrier: filters.carrier }) : [];
      const customerTable = stdRows.length
        ? standardToMarkdown(stdRows)
        : (r.data.length
          ? [
            "| 船司 | 起运港 | 目的港 | 柜型 | 价格(USD) | 有效期 |",
            "|---|---|---|---|---|---|",
            ...r.data.slice(0, 15).map(q =>
              `| ${q.carrier ?? "—"} | ${q.pol ?? "—"} | ${q.podRaw} | ${q.container ?? "—"} | ${fmtUsd(q.oceanUsd)} | ${q.validFrom || q.validTo ? `${q.validFrom ?? "?"}~${q.validTo ?? "?"}` : "—"} |`),
          ].join("\n")
          : "");
      const cheapest = r.data[0] ?? null;
      const answer = cheapest
        ? `最低 ${fmtUsd(cheapest.oceanUsd)}（${cheapest.carrier ?? "—"} · ${cheapest.container ?? "综合"} · ${cheapest.pol ?? "—"}→${cheapest.podRaw}），共 ${total} 条当前有效报价。`
        : "";
      // 逐条件拼 notice：收敛信号 + 固定格式指令（弱模型对工具返回里的指令最服帖）
      const noticeLines: string[] = [];
      let candidates: { lanes: { v: string; c: number }[]; pods: { v: string; c: number }[] } | undefined;
      let mirror: { rows: number; latestSyncAt: string | null; remoteHost: string; reachable: boolean } | undefined;
      let concluded = false;                       // 是否已进入 L3 定论口径
      if (total === 0) {
        // 查不到 ≠ 没有：L2 把库存事实回给模型做语义重试，两轮不过才 L3 定论（规范 rates-query-fallback-spec §3/§4）
        const opts = quoteOptions();
        const attempt = ctx.counts?.get("quote_search") ?? 1;
        const words = termWords.map(w => w.toLowerCase());
        const hasSub = (s: string, w: string) => {
          for (let i = 0; i + 2 <= w.length; i++) if (s.includes(w.slice(i, i + 2))) return true;
          return false;
        };
        // 贴合度只机械排个序（谁和查询词有公共子串靠前）；语义等价关系交给人/模型判断，代码不养同义词表
        const score = (v: string) => {
          const s = v.toLowerCase();
          if (words.some(w => s.includes(w) || w.includes(s))) return 0;
          return words.some(w => hasSub(s, w)) ? 1 : 2;
        };
        const rank = <T extends { v: string; c: number }>(items: T[]): T[] =>
          [...items].sort((a, b) => score(a.v) - score(b.v) || b.c - a.c).slice(0, 12);
        candidates = { lanes: rank(opts.lanes), pods: rank(opts.pods) };
        const reachable = await probeBoardCached();
        let remoteHost = remoteBase();
        try { remoteHost = new URL(remoteBase()).host; } catch { /* 保底原样 */ }
        mirror = { rows: opts.rows, latestSyncAt: opts.latestSyncAt, remoteHost, reachable };
        const syncAt = opts.latestSyncAt ? beijingTime(opts.latestSyncAt) : "未知（本次运行还没同步过）";
        const stale = !opts.latestSyncAt || Date.now() - Date.parse(opts.latestSyncAt) > 24 * 3600_000;
        if (attempt <= 1) {
          noticeLines.push(
            "机械匹配第一轮没命中，这不是「库里没有」。candidates 是本地镜像里真实存在的航线与目的港（带条数，已按贴合度排序）："
            + "请判断用户说的词是否对应其中某一项（区域简称、中英文译名、同一航线的不同叫法都算）。"
            + "对得上就换成 candidates 里的原值再查一次（重试一次为限，别用同样的词重复调用）；对不上再等下一轮结论。",
          );
        } else {
          concluded = true;
          noticeLines.push(!reachable || stale
            ? `两轮都没命中。本地镜像共 ${opts.rows} 条、最近同步 ${syncAt}，局域网台账${reachable ? "可达" : "现在连不上"}`
              + "——很可能是镜像没跟上真源。请照实说「本地镜像里查不到这条」，不要说成「该航线没有报价」；"
              + "再给用户两条路：到「运价库」页点同步刷新镜像，或让你联网查当前市场行情。"
            : `两轮都没命中，且镜像刚同步过（${syncAt}）、台账可达——可以确定台账里没有这个航线/港口。`
              + "请如实告诉用户库里没有，并问一句要不要你联网查当前市场行情；用户明确同意前不要自行联网。");
        }
      } else {
        if (r.data.length < total) noticeLines.push(`共命中 ${total} 条，本批返回 ${r.data.length} 条，回答时必须注明。`);
        else noticeLines.push("命中数据已全部返回，无需再调用本工具，直接作答。");
        noticeLines.push(
          "回答格式（固定，勿自由发挥）：正文第一句原样采用 answer 字段（可微调语气，数字与船司不改）；明细表已由界面渲染成表格卡，正文禁止再手写表格或逐行复述报价——否则用户会看到两张表。",
          "用户要「面向客户的运价表/报价表」时：把 customerTable 的 Markdown 原样贴进正文，这就是交付物；用户没明说「导出文件」就不要调 export_artifact。"
            + (stdRows.length
              ? "customerTable 已是标准化透视表（列：船司/起运港/目的港/20GP/40HQ&HC/40NOR/Freetime/Transit/有效期/报价单链接），港口已归一（航线级报价已展开到具体港），直接贴不要改列；报价单链接指向船司报价截图，可提示用户点击查看。"
              : "customerTable 列固定：船司/起运港/目的港/柜型/价格/有效期，不带内部备注。"),
          "末尾固定提醒：镜像价为参考价，以船司实时报价为准。",
        );
      }
      const out = {
        total, count: r.data.length, quotes: r.data,
        answer, customerTable,
        ...(stdRows.length ? { standardCount: stdRows.length } : {}),
        notice: noticeLines.join("\n"),
        ...(candidates ? { candidates } : {}),
        ...(mirror ? { mirror } : {}),
        ...(total > 0 && r.data.length >= total ? { complete: true } : {}),
        ...(total === 0 ? { empty: true } : {}),
        ...(total > 0 ? {
          say: `共 ${total} 条` + (args.q || args.lane || args.pod || args.carrier || args.container
            ? `（当前筛选条件下的命中数）` : `（镜像库全量）`)
            + `，其中返回明细 ${r.data.length} 条${r.data.length ? `，最低 ${r.data[0]!.oceanUsd ?? "-"} USD` : ""}`,
        } : {}),
        ...(total > 0 ? {
          actions: [
            promptAction("按这批价写一封报价信", "根据刚才查到的运价，选最便宜的那条给客户写一封报价信，注明有效期和「以船司实时报价为准」的提醒"),
            navAction("在运价库筛选", "#/rates"),
          ],
        } : concluded ? {
          // 定论后的两条出口：刷新镜像（用户自己在运价页点，agent 不代点）/ 联网调研（点了才做）
          actions: [
            navAction("去运价页同步镜像", "#/rates"),
            promptAction("联网查市场行情",
              `本地镜像没查到「${termWords.join(" ") || "这个航线"}」的运价。请联网调研该航线当前的市场行情与船期，`
              + "回答时注明这是外部行情、不是公司台账报价。"),
          ],
        } : {}),
      };
      audit(ctx, "quote_search", "read", args, out, "auto");
      // 空结果不进读缓存：同词再查也要真跑一遍，才走得到 L2→L3 的分层结论
      const payload = okOut(out);
      return total === 0 ? payload : finishRead(ctx, "quote_search", args, payload);
    },
  });

  const marketResearch = tool({
    name: "market_research",
    description: "联网调研某航线的公开市场行情：多源检索 → 逐页核实 → 交叉核对分级 → 产出带来源链接与日期的报告（不自动落盘，用户点「保存调研报告」才写文件）。"
      + "用户问「某航线现在什么行情 / 外面报多少 / 最近有没有新船期 / 我们这个价在市场算什么水平」时用本工具；"
      + "查自己台账里的价用 quote_search。缺起运港或目的港时只追问这两项（其余可默认）。"
      + "一次调用就跑完整套流程，不要换措辞连续调用；查不到可核实来源时它会如实给缺口，绝不编数字。",
    parameters: marketResearchSchema,
    execute: async (args) => {
      const note = gate(ctx, "market_research");
      if (note) return note;
      const fromRoute = splitRoute(args.route);
      const pol = (args.pol || "").trim() || fromRoute.pol;
      const pod = (args.pod || "").trim() || fromRoute.pod;
      if (!pol || !pod) {
        // 方法论要求：只追问这两个港口，其余用默认值。这是待补信息、不是故障 → ok:true、不带 error、不喂熔断计数
        const need = {
          needPorts: true,
          notice: "调研一条航线只需要两个必填项：起运港与目的港。请用一句话问用户（如「从哪个港到哪个港？柜型要不要限定？」），"
            + "拿到后直接再调本工具；柜型与时间窗可以留空走默认。",
        };
        audit(ctx, "market_research", "read", args, need, "auto");
        return okOut(need);
      }
      const scopeRaw = String(args.scope || "").trim().toLowerCase();
      const scope = scopeRaw === "rates" || scopeRaw === "schedules" ? scopeRaw : "both";
      const r = await runResearchScene(
        { pol, pod, scope, container: (args.container || "").trim() || undefined, weeks: args.weeks ?? undefined },
        { mirrorCompare: mirrorCompareForPod },
      );
      if (!r.success) {
        audit(ctx, "market_research", "read", args, undefined, "auto", r.error);
        return failOut("research_failed", r.error, {
          notice: "请如实告诉用户这次没查到公开行情、以及要补哪一项，"
            + "禁止凭自己的知识给运价数字；用户台账里的价格可以用 quote_search 查。",
        });
      }
      const o = r.data.out;
      const rows = o.rates.map(x => ({
        source: x.source.slice(0, 40), value: x.value, scope: x.scope,
        published: x.published, credibility: CRED_LABEL[x.credibility], url: x.url,
      }));
      // 报告不自动落盘（调研一成功就写文件会在回合中段抢跑，用户没点头前一个字不落盘）：
      // 注册成写动作卡，正文照常给结论，想要文件点「保存调研报告」才写，执行走统一审计。
      const saveReport = registerAction({
        conversationId: ctx.conversationId, toolName: "market_research",
        label: "保存调研报告",
        confirm: "把这次调研存成报告文件？",
        detail: "含全部来源链接与日期，存到 outputs/agent 目录；不发邮件、不改任何数据",
        diff: [{ field: "report", label: "报告文件", from: "未保存", to: `航线调研 ${o.route}.md` }],
        run: async () => {
          const w = writeArtifact(`航线调研 ${o.route}`, "md", o.report);
          return w.success ? okResult(`报告已保存：${w.data.path}`) : failResult(w.error);
        },
      });
      const out = {
        route: o.route,
        window: o.window,
        checked: `${o.evidenceCount.fetched}/${o.evidenceCount.hits} 个来源通过页面核实`,
        say: rows.length
          ? `公开来源核实完成：${o.conclusions.length} 条结论、${rows.length} 条运价来源可引用`
          : "本轮没有通过核实的公开来源，因此不给运价数字（缺口见 gaps）",
        conclusions: o.conclusions.map(c => c.text),
        results: rows,
        gaps: o.gaps.slice(0, 5),
        dropped: o.dropped.slice(0, 5),
        actions: [saveReport],
        notice: "报告没有自动保存：结果卡下方有「保存调研报告」按钮，用户点击才会生成文件——正文不要声称文件已生成；"
          + "用户想要文件时，提示他点这个按钮即可。正文只讲结论加一句时效提醒（即期价以天计变化）；"
          + "明细表已由界面表格卡呈现，不要再自建汇总表，也不要补表里没有的数字、日期或来源。",
      };
      audit(ctx, "market_research", "read", args, out, "auto");
      return finishRead(ctx, "market_research", args, okOut(out));
    },
  });

  const inboxSearch = tool({
    name: "inbox_search",
    description: "检索本地收件箱邮件（发件人/主题/正文摘要关键词，可按系统分类与未读过滤），返回 发件人/主题/分类/时间/id 列表。用户问「今天有什么新邮件/询盘/退信」「谁给我发过…」时使用本工具；要总结某封邮件先用本工具拿 id。",
    parameters: inboxSearchSchema,
    execute: async (args) => {
      const cached = cachedRead(ctx, "inbox_search", args);
      if (cached) return cached;
      const INBOX_CLASSES = ["inquiry", "reply", "bounce", "auto_reply", "normal"];
      const q0 = (args.query ?? "").trim();
      const cls = (args.classification ?? "").trim().toLowerCase();
      const conds = [];
      if (q0) {
        const q = `%${q0}%`;
        conds.push(or(like(inboxMessages.fromEmail, q), like(inboxMessages.subject, q), like(inboxMessages.bodyPreview, q)));
      }
      if (INBOX_CLASSES.includes(cls)) conds.push(eq(inboxMessages.classification, cls));
      const intentF = (args.intentFilter ?? "").trim();
      if (intentF) conds.push(eq(inboxMessages.intent, intentF));
      // 「未读」指待我处理的来信：我方自己发出的副本（classification=sent）也是 is_read=0，
      // 不排除会把"我发出去的邮件"算成未读，计数与清单一起失真（用户实测抓到过）
      if (args.unreadOnly) conds.push(eq(inboxMessages.isRead, 0), ne(inboxMessages.classification, "sent"));
      const rows = getDb().select({
        id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
        subject: inboxMessages.subject, classification: inboxMessages.classification,
        intent: inboxMessages.intent,
        isRead: inboxMessages.isRead, receivedAt: inboxMessages.receivedAt,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(inboxMessages.receivedAt))
        .limit(Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50))
        .all();
      // 时间由服务端算成北京时间、条数由服务端算好：模型不换算时区、不自己数数
      // （此前它在汇总表里把 12:13 写成 09:24 这类编造时间，就是两头都让它自己算导致的）
      const raw = rows.map(r => ({
        ...r,
        from: r.fromName || r.fromEmail,
        matchedContactId: r.matchedContactId ?? undefined,
        收到时间: beijingTime(r.receivedAt),
      }));
      const matchedTotal = getDb().select({ n: sql<number>`count(*)` }).from(inboxMessages)
        .where(conds.length ? and(...conds) : undefined).get()?.n ?? raw.length;
      audit(ctx, "inbox_search", "read", args, raw, "auto");
      // 收敛信号：空结果如实回答；结果少于 limit 说明已全量返回
      // 空结果也要走 finishRead 落缓存：否则模型换个措辞重复问同一个查不到的条件，
      // 每次都真查并吃掉一次预算，很快撞满 budgetPerTurn 卡住（「中断反应」的成因之一）
      if (raw.length === 0) {
        return finishRead(ctx, "inbox_search", args,
          okOut({ total: 0, messages: [], notice: "收件箱中没有匹配的邮件。请直接如实告知用户，不要重复调用本工具。" }));
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
      return finishRead(ctx, "inbox_search", args, okOut({
        total: matchedTotal,
        returned: raw.length,
        // 让模型照抄结论，别自己数条数、别自己换算时间
        say: `共 ${matchedTotal} 封匹配，本条列出 ${raw.length} 封（时间为北京时间）`,
        ...(args.unreadOnly ? { unreadHint: "此处「未读」只算来信，已排除我方自己发出的邮件副本" } : {}),
        ...(raw.length < defaultLimit ? { complete: true, notice: "以上即全部匹配邮件，直接作答即可" } : {}),
        messages: raw,
        ...(actions.length ? { actions } : {}),
      }));
    },
  });

  const emailSummarize = tool({
    name: "email_summarize",
    description: "总结一封收件箱邮件并给出下一步跟进建议（输入是一封邮件；绝对不要拿它做客户档案查询或整库统计）。（内部调用 LLM 生成 一句话总结 + nextStep）。先 inbox_search 拿到邮件 id 再调用本工具。",
    parameters: emailSummarizeSchema,
    execute: async (args) => {
      const note = gate(ctx, "email_summarize");
      if (note) return note;
      const batchIds = Array.isArray(args.messageIds) ? args.messageIds : [];
      if (!args.messageId && batchIds.length) {
        // 模型自己发明了 messageIds：这是有效意图，不算失败（不喂熔断计数），直接把请求转交出去
        const redirect = {
          redirect: "start_batch_task",
          messageIds: batchIds,
          notice: "多封邮件的总结不在本工具做（一封封循环会撞本轮调用上限，也没有进度条）。"
            + "请立即调用 start_batch_task，kind=\"email_summary\"，messageIds 照抄上面这串——"
            + "不要再用 inbox_search 重新查一遍，也不要回答「请你自己打开客户端查看」。",
        };
        audit(ctx, "email_summarize", "read", args, redirect, "auto");
        return okOut(redirect);
      }
      if (!args.messageId) {
        audit(ctx, "email_summarize", "read", args, undefined, "auto", "缺少 messageId");
        return failOut("missing_message_id", "缺少参数 messageId。请先用 inbox_search 拿到邮件 id 再总结。");
      }
      const row = getDb().select({
        id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
        subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
        classification: inboxMessages.classification, intent: inboxMessages.intent,
        isRead: inboxMessages.isRead,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
      if (!row) {
        audit(ctx, "email_summarize", "read", args, undefined, "auto", `邮件 #${args.messageId} 不存在`);
        return failOut("not_found", `邮件 #${args.messageId} 不存在，请先用 inbox_search 查询`);
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
        return failOut("summarize_failed", `总结失败：${r.error}`);
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
      // 询价联动：识别为询价的邮件，提示先查台账价再起草（quote_search → 草稿引用台账价）
      const quoteHint = row.intent === "price_inquiry"
        ? { notice: "这是询价邮件：起草回复前先用 quote_search 查该航线的台账价，把参考价写进草稿（注明以船司实时报价为准）。" }
        : {};
      return okOut({ ...summary, ...quoteHint, ...(actions.length ? { actions } : {}) });
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
        return failOut(hits.success ? "no_hits" : "search_source_unavailable", msg);
      }
      const r = await generateBackcheckReport(
        { companyName: args.companyName, country: args.country ?? undefined },
        hits.data,
      );
      if (!r.success) {
        audit(ctx, "company_backcheck", "read", args, undefined, "auto", r.error);
        return failOut("generate_failed", `背调生成失败：${r.error}`);
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
      return okOut(out);
    },
  });

  const generateDraft = tool({
    name: "generate_draft",
    description: "生成一封开发信/跟进信/回信的草稿（带 SUBJECT: 主题行 + 正文，支持 EN/ES/PT）。"
      + "本工具只产出文本、不发送；用户可用结果卡按钮一键存素材库或入队。"
      + "写什么由你从对话与上下文里已有的材料决定：如果邮件正文已经在上下文里，就直接照着它写，"
      + "绝对不要为了『起草/回复邮件』先去调 company_backcheck 或其他检索工具（那是跑题）；"
      + "上下文中没有的关键数字（如成交价、柜型）用 {{占位}} 标出并在结尾一句话提示，不要连环追问。"
      + "边界：只用于给客户写开发信/跟进信/回信；寒暄、自我介绍、翻译、改写一段现成文字都不要调本工具。"
      + "已知收件人 contactId 时才带上它（结果卡才会出现「入队」按钮）。",
    parameters: generateDraftSchema,
    execute: async (args) => {
      const note = gate(ctx, "generate_draft");
      if (note) return note;
      // 收件人可由 contact/contactId 任一定位；定位到就用档案补全姓名与公司（少一步 = 弱模型少一次掉链子）
      const target = args.contactId || args.contact ? pickTarget(args) : null;
      const person = target && target.ok ? target.person : null;
      if (target && !target.ok) {
        audit(ctx, "generate_draft", "read", args, undefined, "auto", "未定位到收件人");
        return failOut(target.why, target.why === "ambiguous"
          ? `「${args.contact}」匹配到多位联系人，请改用 contactId 指定其一：${candidatesText(target.candidates)}`
          : `库里找不到「${args.contact}」；不知道对方是否建档时，先调 search_contacts，或直接给我公司名继续写`);
      }
      const companyName = args.companyName || person?.company || person?.name || "客户";
      const contactName = args.contactName || person?.name || companyName;
      const r = await generateEmailDraft({
        language: (["EN", "ES", "PT"].includes((args.language ?? "EN").toUpperCase()) ? args.language!.toUpperCase() : "EN") as "EN" | "ES" | "PT",
        companyName,
        contactName,
        backcheck: args.focus ? ({ summary: args.focus } as BackcheckReport) : null,
        sender,
      });
      if (!r.success) {
        audit(ctx, "generate_draft", "read", args, undefined, "auto", r.error);
        return failOut("generate_failed", `草稿生成失败：${r.error}`);
      }
      // 拆 SUBJECT 行 → 主题/正文（结果卡动作与入队都要用）
      const { subject, body } = parseDraft(r.data, `Following up — ${companyName}`);
      const lang = args.language ?? "EN";
      const tplName = `${companyName} · AI 开发信`.slice(0, 60);

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
      const draftContactId = person?.id ?? args.contactId;
      if (draftContactId) {
        actions.push(registerAction({
          conversationId: ctx.conversationId, toolName: "generate_draft",
          label: "入队发给这位联系人",
          confirm: `把这封信加入发送队列，收件人 ${person ? `${person.name}（` : ""}#${draftContactId}${person ? "）" : ""}`,
          detail: "入队 ≠ 发送：队列建好后不会自动开始，仍要你在「发送中心」点「开始」",
          diff: [
            { field: "subject", label: "主题", from: "—", to: subject },
            { field: "contact", label: "收件人", from: "—", to: `#${draftContactId} ${contactName}`.trim() },
          ],
          target: { label: "去发送中心", href: "#/campaigns" },
          run: async () => {
            const s = await startDynamicSend([draftContactId], subject, body, false);
            return s.success
              ? okResult(`已入队 ${s.data.queuedCount} 封（批次 ${s.data.batchId.slice(0, 8)}），等待你在发送中心点开始`)
              : failResult(s.error);
          },
        }));
      }
      // 正文只放一份（subject/body）：整条结果受推送上限约束，重复字段会挤掉 actions
      const out = { subject, body, language: lang, contactId: draftContactId ?? null, actions };
      audit(ctx, "generate_draft", "read", args, { subject, length: body.length, actions: actions.length }, "auto");
      return okOut(out);
    },
  });

  const queueStatus = tool({
    name: "queue_status",
    description: "查询发信引擎与队列实时状态：是否运行中/已暂停、总组数、已发组数、失败组数、待发的组数与收件人数。用户问「还有多少没发出去」「发送进度」「队列是不是卡住了」时使用。",
    parameters: z.object({}),
    execute: async () => {
      const cached = cachedRead(ctx, "queue_status", {});
      if (cached) return cached;
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
      return okOut(out);
    },
  });

  const remindersDue = tool({
    name: "reminders_due",
    description: "查询到期与已逾期的跟进提醒（CRM 今日待跟进清单）。只回答「今天/最近该跟进谁」这类清单问题；要看某个人具体资料请用 search_contacts。，返回联系人 id/姓名/公司/提醒时间/跟进备注。用户问「今天该跟进谁」「有哪些到期提醒」「哪些客户 overdue 了」时必须先调用本工具。",
    parameters: z.object({}),
    execute: async () => {
      const cached = cachedRead(ctx, "reminders_due", {});
      if (cached) return cached;
      const r = checkReminders();
      if (!r.success) {
        audit(ctx, "reminders_due", "read", {}, undefined, "auto", r.error);
        return failOut("query_failed", `查询失败：${r.error}`);
      }
      const brief = (c: (typeof r.data.due)[number]) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email,
        company: c.companyName ?? "", reminderAt: c.reminderAt ?? "", note: c.followupNote ?? "",
        // 逾期来源：显式提醒到期 or 沉默超期（无提醒但距最近跟进 >5 天 = 看板标红的同一批）
        reason: c.reminderAt ? "显式提醒到期" : `沉默 ${(c.staleDays ?? 0)} 天未跟进`,
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
              const { subject, body } = parseDraft(draft.data, `Following up — ${companyName || name}`);
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
        return okOut({ ...out, notice: "今天没有到期或逾期的提醒。请如实告知用户，不要重复调用本工具。" });
      }
      return okOut({ ...out, ...(actions.length ? { actions } : {}) });
    },
  });

  const accountsStatus = tool({
    name: "accounts_status",
    description: "查询发信/收信账号的配置与健康状态：总数、启用数、健康数（无熔断且无连续失败），以及每个异常账号的具体问题（停用/发信熔断/连续失败次数/最近收信错误）。用户问「几个账号能用」「账号有没有问题」「哪个账号挂了」时使用。",
    parameters: z.object({}),
    execute: async () => {
      const cached = cachedRead(ctx, "accounts_status", {});
      if (cached) return cached;
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
      return okOut(out);
    },
  });

  const sendQueueAdd = tool({
    name: "send_queue_add",
    description: "把一封邮件加入发送队列。触发时机：用户明确说「把/给 X 发一封邮件」「发给 X」「发报价给 X」时直接调用本工具入队（收件人可用 contactIds 或 contact=邮箱/姓名，本工具会自己在库里定位，不必先调 search_contacts）—— 系统随后会弹人工确认框，那一步就是征求同意，因此不要只在正文里问「要不要发」而不调用本工具。本工具只入队不发送：队列建好后处于未启动状态，用户仍需在「发送中心」点「开始」才真正外发。主题与正文可含 {{company}}/{{firstName}}/{{lastName}} 变量。",
    parameters: sendQueueAddSchema,
    execute: async (args) => {
      const gateNote = gate(ctx, "send_queue_add");
      if (gateNote) return gateNote;
      const dup = lookupIdempotent(ctx, "send_queue_add", args);
      if (dup) return dup;
      // 收件人：id 列表优先，否则用 contact 定位（少一步 = 弱模型少一次掉链子）
      let ids = args.contactIds ?? [];
      if (ids.length === 0 && args.contact) {
        const t = pickTarget({ contact: args.contact });
        if (!t.ok) {
          audit(ctx, "send_queue_add", "write", args, undefined, "approved", "未定位到收件人");
          return failOut(t.why, t.why === "ambiguous"
            ? `「${args.contact}」匹配到多位联系人，请用 contactIds 指定：${candidatesText(t.candidates)}`
            : `库里找不到「${args.contact}」，请先确认对方已建档`);
        }
        ids = [t.person.id];
      }
      if (ids.length === 0) {
        audit(ctx, "send_queue_add", "write", args, undefined, "approved", "缺少收件人");
        return failOut("missing_recipient", "缺少收件人。请给 contactIds（或单个 contact：邮箱/姓名）。");
      }
      const r = await startDynamicSend(ids, args.subject, args.body, false);
      if (!r.success) {
        audit(ctx, "send_queue_add", "write", args, undefined, "approved", r.error);
        forget(ctx, "send_queue_add", args);
        return failOut("enqueue_failed", `入队失败：${r.error}`);
      }
      audit(ctx, "send_queue_add", "write", args, r.data, "approved");
      invalidateCache("send_queue_add");
      const out = okOut({
        say: `已加入发送队列：${r.data.queuedCount} 封（批次 ${r.data.batchId.slice(0, 8)}，${r.data.dropped} 组因限额被丢弃）。`,
        notice: "队列已建立但尚未启动，请提示用户到「发送中心」确认后手动点开始发送。",
      });
      rememberResult(ctx, "send_queue_add", args, out);
      return out;
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

  const exportArtifact = tool({
    name: "export_artifact",
    description: "把整理好的内容导出成文件给用户带走（落盘到 outputs/agent，对话里出现文件卡，可「打开位置」「复制路径」）。"
      + "**仅当用户明确要求「导出/生成文件/存成文件」时才调用**——对话里能直接交付的内容（如贴在正文里的表格）一律不落盘；"
      + "不确定用户要不要文件时，先在对话里给出内容并问一句，不要直接生成。"
      + "确要导出时完整内容写进文件，不要在回答正文里再贴一遍全文。"
      + "md 格式用 content 传 Markdown 正文；csv 格式把表格写成 content 里的多行 TSV 文本"
      + "（首行表头，每行一条记录，字段间用制表符分隔）。参数只有这三个扁平字段，越简单越不容易写坏 JSON。本工具只写产物目录，不碰任何业务数据。",
    parameters: exportArtifactSchema,
    execute: async (args) => {
      const gateNote = gate(ctx, "export_artifact");
      if (gateNote) return gateNote;
      const dup = lookupIdempotent(ctx, "export_artifact", args);
      if (dup) return dup;
      const format: ArtifactFormat = /^csv$/i.test(String(args.format ?? "").trim()) ? "csv" : "md";
      const title = String(args.title ?? "").trim().slice(0, 40) || "导出内容";
      let content: string;
      if (format === "csv") {
        // csv 统一从 content 解析 TSV（rows 协议已废：嵌套数组 JSON 弱模型写坏率高）
        const rows = parseTsv(args.content ?? "")
          .slice(0, 500)
          .map(r => r.slice(0, 20).map(c => c.slice(0, 200)));
        if (!rows.length) {
          audit(ctx, "export_artifact", "read", args, undefined, "auto", "csv 缺少 content TSV");
          return failOut("missing_content",
            "导出 csv 需要 content：把表格写成多行 TSV 文本（首行表头，每行一条记录，字段间用制表符分隔）。请补齐后再调用本工具。");
        }
        content = toCsv(rows);
      } else {
        content = String(args.content ?? "").trim().slice(0, 64_000);
        if (!content) {
          audit(ctx, "export_artifact", "read", args, undefined, "auto", "content 为空");
          return failOut("missing_content", "导出 md 需要 content（Markdown 正文）。请补齐内容后再调用本工具。");
        }
      }
      const w = writeArtifact(title, format, content);
      if (!w.success) {
        audit(ctx, "export_artifact", "read", args, undefined, "auto", w.error);
        return failOut("write_failed", `导出失败：${w.error}`);
      }
      audit(ctx, "export_artifact", "read", args, w.data, "auto");
      const okMsg = okOut({ artifact: w.data, notice: "文件已生成，对话里已显示文件卡。正文给用户一句结论即可，禁止再贴全文。" });
      rememberResult(ctx, "export_artifact", args, okMsg);
      return okMsg;
    },
  });

  const importContactsTool = tool({
    name: "import_contacts",
    description: "把用户提供的客户信息批量导入本地联系人库。用户粘贴任意格式（名单/表格/邮件签名/一段话）时，先把每条整理成 contacts（姓名/邮箱/公司/国家/职位/电话/阶段/备注）再调用本工具；绝不要反问用户「用 CSV 还是 JSON」。"
      + "邮箱是去重与写入的键：无效邮箱跳过、库里已存在的邮箱不会被覆盖（只提示疑似已存在）。"
      + "写操作，执行前请用户确认；被拒绝则不写。完成后给一句结论并询问是否按公司/国家汇总、或挑几位进开发信。",
    parameters: importContactsSchema,
    execute: async (args) => {
      const gateNote = gate(ctx, "import_contacts");
      if (gateNote) return gateNote;
      const { tsv, invalid, count } = buildImportTsv(args.contacts);
      const total = args.contacts.length;
      if (count === 0) {
        audit(ctx, "import_contacts", "write", args, undefined, "approved", "无有效邮箱可导入");
        return failOut("no_valid_contacts",
          `没有可导入的联系人：${total} 条里 ${invalid.length} 条邮箱无效或缺失。每条必须有合法邮箱，请核对后重试。`);
      }
      const mapping = Object.fromEntries(IMPORT_HEADER.map((h) => [h, h]));
      const res = await importContacts({ mode: "execute", type: "tsv", data: tsv, mapping });
      if (!res.success) {
        audit(ctx, "import_contacts", "write", args, undefined, "approved", res.error);
        return failOut("import_failed", `导入失败：${res.error}`);
      }
      const { imported, skipped } = res.data;
      audit(ctx, "import_contacts", "write", args, { imported, skipped, invalid: invalid.length }, "approved");
      invalidateCache("search_contacts");
      saveDatabase();
      return okOut({
        say: `导入完成：新增 ${imported} 位，跳过 ${skipped} 位（邮箱已存在/为空），无效 ${invalid.length} 位`
          + (invalid.length ? `（如 ${invalid.slice(0, 3).join("、")}）` : "") + "。",
        notice: "要不要按公司/国家汇总一下，或挑几位直接进开发信？",
        imported, skipped, invalidCount: invalid.length,
      });
    },
  });

  const startBatchTask = tool({
    name: "start_batch_task",
    description: "把批量活起成后台任务（对话里出进度卡、逐项推进、可随时取消、不阻塞对话）。三种 kind：backcheck=批量背调（≥3 家）、draft=批量开发信草稿（≥3 家）、email_summary=批量邮件总结（≥3 封，传 messageIds）。"
      + "凡是要总结多封邮件，一律用本工具（传 messageIds，来自 inbox_search），绝不要用 email_summarize 一封封循环（那会撞每轮调用次数上限、只能做几封）。单封才用 email_summarize，单家才用 company_backcheck / generate_draft。"
      + "上限：公司 10 家、邮件 60 封；完成后自动生成文件产物。只搜索与生成文本，绝不发送任何邮件。",
    parameters: startBatchTaskSchema,
    execute: async (args) => {
      const gateNote = gate(ctx, "start_batch_task");
      if (gateNote) return gateNote;
      const kind = normalizeBatchKind(args.kind);
      if (kind === "email_summary") {
        const ids = normalizeMessageIds(args.messageIds);
        if (!ids.length) {
          audit(ctx, "start_batch_task", "read", args, undefined, "auto", "邮件 id 为空");
          return failOut("missing_message_ids", "email_summary 需要 messageIds（先用 inbox_search 拿到邮件 id）。请让用户补充或先检索。");
        }
        const r = startTask(ctx.push, { conversationId: ctx.conversationId, kind, messageIds: ids });
        if (!r.success) { audit(ctx, "start_batch_task", "read", args, undefined, "auto", r.error); return failOut("start_failed", `启动后台任务失败：${r.error}`); }
        audit(ctx, "start_batch_task", "read", args, r.data, "auto");
        return okOut({ task: r.data, notice: `后台任务已启动（总结 ${r.data.total} 封），进度卡已在对话中展示，完成后自动生成文件产物。告诉用户可随时看进度、继续问别的，不要重复调用本工具。` });
      }
      const companies = normalizeBatchItems(args.companies);
      if (!companies.length) {
        audit(ctx, "start_batch_task", "read", args, undefined, "auto", "公司列表为空");
        return failOut("missing_companies", "companies 至少要有一家有 name 的公司。请让用户补充，或改用对应的单公司工具。");
      }
      const r = startTask(ctx.push, { conversationId: ctx.conversationId, kind, companies });
      if (!r.success) {
        audit(ctx, "start_batch_task", "read", args, undefined, "auto", r.error);
        return failOut("start_failed", `启动后台任务失败：${r.error}`);
      }
      audit(ctx, "start_batch_task", "read", args, r.data, "auto");
      return okOut({ task: r.data, notice: "后台任务已启动，进度卡已在对话中展示。告诉用户随时能看进度、可以继续问别的。不要重复调用本工具。" });
    },
  });

  const reportGap = tool({
    name: "report_gap",
    description: "登记一条「客户端目前做不到」的能力缺口（开发期需求台账）。"
      + "触发时机：用户想要的操作在当前工具清单里不存在（例如把人推荐的新联系人加入联系人库、修改客户阶段等），" +
      "你必须先如实说明做不到并给出绕行办法，然后调用本工具记一笔：wanted=用户想做而做不了的事（一句话）、scene=当时在办的事、workaround=你给出的替代路径。"
      + "绕行办法只允许描述真实存在的功能（本程序的页面与工具）或「稍后人工处理」，严禁发明本产品没有的系统、页面或功能。"
      + "同一回合同类缺口只记一次；这只是台账读写，不执行任何业务操作。",
    parameters: z.object({
      wanted: z.string().describe("想做但做不到的事，一句话"),
      scene: z.string().nullable().optional().describe("当时在办的事（如「跟进 jberrocal 的自动回复」）"),
      workaround: z.string().nullable().optional().describe("你给用户的绕行办法"),
    }),
    execute: async (args) => {
      const gateNote = gate(ctx, "report_gap");
      if (gateNote) return gateNote;
      const r = reportGapRow(args);
      audit(ctx, "report_gap", "read", args, r.success ? r.data : undefined, "auto", r.success ? undefined : r.error);
      if (!r.success) return failOut("report_failed", `缺口登记失败：${r.error}`);
      return JSON.stringify({
        ok: true, gapId: r.data.gapId, hits: r.data.hits,
        notice: r.data.merged
          ? "该缺口此前已登记，本次计入抱怨次数。已足够，禁止再为同一缺口调用本工具。"
          : "缺口已登记进台账。如实把做不到和绕行办法讲给用户即可，禁止假装已完成。",
      });
    },
  });

  // ── 审批闸门（唯一收口）────────────────────────────────────────────
  // needsApproval 一律由注册表派生：登记为 sideEffect:"write" 就必须人工确认。
  // 各工具不再自己写一份——漏写不再是「静默执行」的成因（export_artifact 曾把注册表
  // 改成 write/需审批却没接 needsApproval，元数据与真实行为脱节、测试还全绿）。
  // 闸门只向上加严：只可能把 needsApproval 置 true，绝不把任何工具置成免审批。
  // 结构锁见 tests/unit/agent-approval-gate.test.ts。
  const tools = [
    searchContacts, recordFollowup, deleteContacts, readProgramConfig, updateProgramConfig,
    updateContact, emailReadFull, quoteSearch, marketResearch, inboxSearch, emailSummarize,
    companyBackcheck, generateDraft, queueStatus, remindersDue, accountsStatus, sendQueueAdd,
    updatePlan, exportArtifact, startBatchTask, importContactsTool, reportGap,
  ];
  for (const t of tools) {
    const name = (t as unknown as { name?: string }).name ?? "";
    if (requiresApprovalOf(name)) (t as unknown as { needsApproval?: unknown }).needsApproval = true;
  }
  return tools;
}
