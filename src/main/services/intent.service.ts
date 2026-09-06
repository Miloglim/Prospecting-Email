// ── 收信意图识别 + AI 兜底一级分类（规范 docs/inbox-intent-spec.md）────────
// 两级分类同一次 LLM 调用：一级（是否真人回复）只兜底规则的 other 桶；
// 二级（回复意图）只作用于 replied。AI 永远只兜底、永不覆盖规则高置信结论。
// 红线：bounce 永不进本流程；intent IS NULL 才落值（人工意志优先）；不自动回复。
import { and, eq, isNull, desc } from "drizzle-orm";
import { getDb, saveDatabase } from "../db";
import { inboxMessages } from "../db/schema/inbox";
import { Log } from "../logger";
import { chatJson } from "./ai.service";
import { classifyMessage } from "./inbox.service";

export type MailIntent = "price_inquiry" | "schedule_request" | "cooperation" | "follow_up" | "other";

/** UI 中文名（徽标/筛选用） */
export const INTENT_LABEL: Record<MailIntent, string> = {
  price_inquiry: "询价", schedule_request: "船期", cooperation: "合作", follow_up: "跟进", other: "其他",
};

/** 规则关键词：命中直接定档（零模型成本）；全落空返回 null 交给 LLM */
const INTENT_RULES: Array<[MailIntent, RegExp]> = [
  ["price_inquiry", /price|quot|rate|cost|pricing|freight|报价|价格|运价|费用|多少钱/i],
  ["schedule_request", /\beta\b|\betd\b|schedule|sailing|transit|lead\s?time|船期|舱位|开船|航程|直航/i],
  ["cooperation", /cooperat|partnership|agency|represent|agent|合作|代理|长期/i],
  ["follow_up", /thank|received|well received|confirm|跟进|收到|谢谢|好的/i],
];

/** 规则先行：命中返回意图；没把握返回 null（由调用方决定是否走 LLM） */
export function classifyIntentRules(subject: string | null, body: string | null): MailIntent | null {
  const s = String(subject || "");
  const b = String(body || "").slice(0, 1500);
  for (const [intent, re] of INTENT_RULES) {
    if (re.test(s) || re.test(b)) return intent;
  }
  return null;
}

const VALID: MailIntent[] = ["price_inquiry", "schedule_request", "cooperation", "follow_up", "other"];

/** 进行中的邮件 id 去重（同一封在一次收信批量里可能被多处触发） */
const inFlight = new Set<number>();

/**
 * 单封识别（幂等：intent 已有值直接跳过）。
 * replied → 规则 → LLM 意图兜底；other → 一次 LLM 同时问「是否真人回复 + 意图」，
 * 判为真人回复且分类仍是 other 时，走 classifyMessage 写 replied（联系人状态/往来记录同路径）。
 */
export async function resolveIntent(id: number): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const row = getDb().select({
      id: inboxMessages.id, classification: inboxMessages.classification,
      subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview, intent: inboxMessages.intent,
    }).from(inboxMessages).where(eq(inboxMessages.id, id)).get();
    if (!row || row.intent) return;
    const cls = row.classification || "other";
    if (!["replied", "other"].includes(cls)) return;
    // other 桶没有正文证据时宁可保持未识别（POP3 首插只有主题，防 LLM 瞎猜一级分类）
    if (cls === "other" && !(row.bodyPreview || "").trim()) return;

    const rulesHit = classifyIntentRules(row.subject, row.bodyPreview);
    if (cls === "replied" && rulesHit) { setIntent(id, rulesHit); return; }

    // LLM：replied 只问意图；other 同时问「是否真人回复」
    const r = await chatJson<{ reply?: boolean; intent?: string }>(
      "你是外贸/货代邮件分类器。判断这封邮件：(1) 是否真人写的业务回复（自动回复、订阅、通知、退信都算 false）；"
      + "(2) 业务意图分为：price_inquiry(询价/问价格)、schedule_request(问船期/舱位/航程)、cooperation(洽谈合作/代理)、"
      + "follow_up(日常跟进/确认/感谢)、other(其他)。只输出 JSON。",
      `主题：${row.subject ?? ""}\n正文：${(row.bodyPreview ?? "").slice(0, 800)}\n\n输出：{"reply":true,"intent":"price_inquiry"}`,
    );
    if (!r.success || !r.data) {
      Log.debug("intent.llm", `#${id} LLM 未返回，保持未识别`);
      return;
    }
    const intent = VALID.includes(r.data.intent as MailIntent) ? (r.data.intent as MailIntent) : "other";
    const isReply = r.data.reply === true;

    if (cls === "replied") { setIntent(id, intent); return; }

    // other 桶：AI 兜底一级分类——真人回复才升级（写路径与手动改分类一致），否则保持 other
    if (isReply) {
      if (rulesHit && intent === "other") { setIntent(id, rulesHit); }
      else setIntent(id, intent);
      const cur = getDb().select({ c: inboxMessages.classification }).from(inboxMessages).where(eq(inboxMessages.id, id)).get();
      if (cur?.c === "other") classifyMessage(id, "replied");
      Log.info("intent.fallback", `#${id} other→replied（AI 兜底），intent=${intent}`);
    } else {
      setIntent(id, "other");
    }
  } catch (err) {
    Log.warn("intent", `#${id} 识别失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    inFlight.delete(id);
  }
}

function setIntent(id: number, intent: MailIntent): void {
  getDb().update(inboxMessages).set({ intent }).where(and(eq(inboxMessages.id, id), isNull(inboxMessages.intent))).run();
  saveDatabase();
}

/** 收信入库后的异步触发入口（fire-and-forget，异常吞掉） */
export function queueIntent(id: number): void {
  void resolveIntent(id);
}

/** 存量重扫：「其他」桶里 intent 为空的邮件，单批上限 50，串行识别（手动触发，不静默跑） */
export async function rescanOther(limit = 50): Promise<{ scanned: number; promoted: number }> {
  const rows = getDb().select({ id: inboxMessages.id })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.classification, "other"), isNull(inboxMessages.intent)))
    .orderBy(desc(inboxMessages.receivedAt))
    .limit(Math.min(limit, 50))
    .all();
  let promoted = 0;
  for (const r of rows) {
    const before = getDb().select({ c: inboxMessages.classification }).from(inboxMessages).where(eq(inboxMessages.id, r.id)).get()?.c;
    await resolveIntent(r.id);
    const after = getDb().select({ c: inboxMessages.classification }).from(inboxMessages).where(eq(inboxMessages.id, r.id)).get()?.c;
    if (before === "other" && after === "replied") promoted++;
  }
  return { scanned: rows.length, promoted };
}

/** 存量重扫前的计数（按钮文案用） */
export function countUnscannedOther(): number {
  return getDb().select({ id: inboxMessages.id })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.classification, "other"), isNull(inboxMessages.intent)))
    .all().length;
}
