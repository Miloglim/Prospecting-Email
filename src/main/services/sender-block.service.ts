import { getDb, saveDatabase } from "../db";
import { emailAccounts, sendBlockEvents } from "../db/schema";
import { eq, and, gt, desc } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";

/**
 * 发信受阻熔断（规范 docs/sender-block-circuit-spec.md）
 * ────────────────────────────────────────────────────
 * 治的实测问题：服务商把我们的内容/发信频率拦下（如阿里云 ESO_LOCAL_SPAM）时，SMTP 那一步是**成功**的，
 * 所以发送引擎的失败计数与熔断永远不沾（实测两账号 consecutive_fails=0、circuit_open_at=null，
 * 而 2026-08-06 与 2026-09-08 各有一批 8~12 封同族拦截通知）——程序继续按原节奏撞墙，拿域名信誉去赌。
 *
 * 本服务只接管「针对性拦截」这一类退信：反垃圾 / 限流 / 信誉黑名单。判据宁缺勿滥，
 * 不命中的退信一律照旧走收件人硬退信链路（用户明确要求：其他样式不用管）。
 */

// ── 判据：只认服务商明确说「我方内容或频率被拦」的文案与错误码 ──

export interface SenderBlockSignal { code: string; excerpt: string }

/** 判据族 → 特征串（小写比对）。命中任一即认定为发信受阻。
 *  只保留「反垃圾 / 限流」两类（用户明确要求）；信誉黑名单（Spamhaus/Barracuda/blacklist…）不在此列——
 *  那是发信域名的长期信誉问题、非本轮拦截，不该据此暂停整批。 */
const SENDER_BLOCK_PATTERNS: Array<{ code: string; marks: string[] }> = [
  // 阿里云邮件投递：本次实测样本（人读文案优先命中，摘录才有信息量；错误码兜底）
  { code: "ESO_LOCAL_SPAM", marks: ["系统反垃圾拦截", "建议调整邮件内容或发信频率", "eso_local_spam", "spamed by local spam engine"] },
  // 通用反垃圾/内容拦截
  { code: "spam_blocked", marks: ["blocked by spam", "spam content", "content rejected", "suspected spam", "junk mail filter", "反垃圾拦截"] },
  // 通用限流（发信频率）
  { code: "rate_limited", marks: ["rate limit", "ratelimit", "too many messages", "too frequent", "throttl", "发送频率过高", "发信频率过高", "超出发送频率"] },
];

/** 从退信原文（正文/预览均可）判断是否「发信受阻」。不命中返回 null —— 判不准一律按普通退信走。 */
export function detectSenderBlockSignal(text: string | null | undefined): SenderBlockSignal | null {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;
  for (const p of SENDER_BLOCK_PATTERNS) {
    const hit = p.marks.find(m => t.includes(m));
    if (hit) return { code: p.code, excerpt: excerptAround(t, hit) };
  }
  return null;
}

/** 取命中词附近一句作为摘录（呈现与审计用，别把整封 HTML 塞进库） */
function excerptAround(lower: string, mark: string): string {
  const i = lower.indexOf(mark);
  if (i < 0) return mark;
  const start = Math.max(0, lower.lastIndexOf("\n", i) + 1);
  let end = lower.indexOf("\n", i);
  if (end < 0) end = Math.min(lower.length, i + 180);
  return lower.slice(start, end).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ── 熔断态（沿用既有 circuit_open_at / circuit_reset_after 两列，24h 自然过期）──

export const CIRCUIT_TTL_MS = 24 * 60 * 60 * 1000;

/** 熔断是否仍在生效期：开启时刻 +（circuit_reset_after 或 24h 兜底）> now。 */
export function isCircuitOpen(
  row: { circuitOpenAt: string | null; circuitResetAfter: string | null } | undefined | null,
  now = Date.now(),
): boolean {
  if (!row?.circuitOpenAt) return false;
  const opened = Date.parse(row.circuitOpenAt);
  if (!Number.isFinite(opened)) return false;
  const until = row.circuitResetAfter ? Date.parse(row.circuitResetAfter) : opened + CIRCUIT_TTL_MS;
  if (!Number.isFinite(until)) return false;
  return now < until;
}

// ── 记录与触发 ──

/** 滚动窗口：命中即算（≥1 封）——一封明确的反垃圾/限流拦截通知就说明服务商已在拦本轮，立即熔断 + 暂停整批。
 *  窗口只用于计数呈现（windowCount），不再作触发门槛；计数口径仍是「命中判据的退信」，普通退信不进这张表、永不触发。 */
export const BLOCK_WINDOW_MS = 30 * 60 * 1000;
export const BLOCK_TRIP_COUNT = 1;

export interface SenderBlockInput {
  accountId: number;
  /** 幂等键：IMAP message_id，缺省回退 inbox 行 id */
  messageId: string | null;
  /** 通知时间（窗口按它算；缺省取现在） */
  occurredAt?: string | null;
  signal: SenderBlockSignal;
}

export interface SenderBlockOutcome {
  counted: boolean;       // 本次是否新记了一条（false = 重复通知已记过）
  windowCount: number;     // 滚动 30 分钟内的累计封数
  tripped: boolean;        // 本次是否触发熔断
  alreadyOpen: boolean;    // 账号此前已在熔断中
  email: string;
}

/**
 * 记一封发信受阻通知。触发条件满足时：置该账号熔断 → 暂停整个批次（不取消、不丢队列）
 * → 推 events 让界面呈现。联系人状态由调用方（收信链路）负责跳过，本服务不碰 crm。
 */
export function recordSenderBlock(input: SenderBlockInput): SenderBlockOutcome {
  const db = getDb();
  const now = new Date();
  const key = (input.messageId || "").trim() || `msg:${input.accountId}:${input.occurredAt || now.toISOString()}`;
  const occurredIso = normalizeIso(input.occurredAt) || now.toISOString();
  const email = db.select({ email: emailAccounts.email }).from(emailAccounts)
    .where(eq(emailAccounts.id, input.accountId)).get()?.email || `#${input.accountId}`;

  let counted = false;
  try {
    const seen = db.select({ id: sendBlockEvents.id }).from(sendBlockEvents)
      .where(eq(sendBlockEvents.messageId, key)).get();
    if (!seen) {
      db.insert(sendBlockEvents).values({
        accountId: input.accountId, messageId: key, code: input.signal.code,
        excerpt: input.signal.excerpt, occurredAt: occurredIso, createdAt: now.toISOString(),
      }).run();
      saveDatabase();
      counted = true;
    }
  } catch (err) {
    // 老库缺表/唯一键竞争：不抛挂收信主流程，只是这条没记上
    Log.warn("senderBlock.record", `记事件失败（忽略）: ${err instanceof Error ? err.message : String(err)}`);
  }

  const windowCount = countRecentBlocks(input.accountId, now.getTime());
  const acct = db.select({
    circuitOpenAt: emailAccounts.circuitOpenAt,
    circuitResetAfter: emailAccounts.circuitResetAfter,
    circuitReason: emailAccounts.circuitReason,
  }).from(emailAccounts).where(eq(emailAccounts.id, input.accountId)).get();
  const alreadyOpen = isCircuitOpen(acct);

  const out: SenderBlockOutcome = { counted, windowCount, tripped: false, alreadyOpen, email };
  if (windowCount < BLOCK_TRIP_COUNT || alreadyOpen) {
    if (counted) {
      Log.warn("senderBlock", `${email}: 服务商拦截通知（${input.signal.code}），30 分钟内累计 ${windowCount} 封，未触发熔断阈值 ${BLOCK_TRIP_COUNT}`);
    }
    return out;
  }

  openSenderBlockCircuit(input.accountId, now);
  out.tripped = true;
  Log.warn("senderBlock.trip", `${email}: 30 分钟内 ${windowCount} 封反垃圾/限流拦截通知 → 账号熔断 + 暂停整批发信`);

  // 惰性 import 防环（send.service → inbox.service → 本模块）：熔断的那一下顺手把整批按暂停
  void import("./send.service").then(m => {
    m.pauseSend("sender_block");
    m.markAccountCircuitOpen(input.accountId);
    m.pushCircuitChanged({ accountId: input.accountId, email, reason: "sender_block", windowCount, code: input.signal.code });
  }).catch(() => { /* 暂停失败不影响熔断落库 */ });

  return out;
}

/** 置熔断：开启时刻 + 24h 自动过期 + 原因。连续失败计数一并清零（受阻与 SMTP 失败是两码事）。 */
export function openSenderBlockCircuit(accountId: number, now = new Date()): void {
  const iso = now.toISOString();
  getDb().update(emailAccounts)
    .set({ circuitOpenAt: iso, circuitResetAfter: new Date(now.getTime() + CIRCUIT_TTL_MS).toISOString(), circuitReason: "sender_block" })
    .where(eq(emailAccounts.id, accountId)).run();
  saveDatabase();
}

/** 一键解除熔断（设置页显式点击）：清熔断三列 + 连续失败计数。 */
export function resetSendCircuit(accountId: number): Result<void> {
  try {
    getDb().update(emailAccounts)
      .set({ circuitOpenAt: null, circuitResetAfter: null, circuitReason: null, consecutiveFails: 0 })
      .where(eq(emailAccounts.id, accountId)).run();
    saveDatabase();
    Log.info("senderBlock.reset", `账号 #${accountId} 熔断已人工解除`);
    return okResult(undefined);
  } catch (err) {
    return failResult(err instanceof Error ? err.message : "解除熔断失败");
  }
}

/** 滚动窗口内的拦截封数 */
export function countRecentBlocks(accountId: number, nowMs = Date.now()): number {
  try {
    const cutoff = new Date(nowMs - BLOCK_WINDOW_MS).toISOString();
    return getDb().select({ id: sendBlockEvents.id }).from(sendBlockEvents)
      .where(and(eq(sendBlockEvents.accountId, accountId), gt(sendBlockEvents.occurredAt, cutoff)))
      .all().length;
  } catch { return 0; }   // 老库缺表 → 视作无记录，不影响收信
}

function normalizeIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
