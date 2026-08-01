import { getDb } from "../db";
import { inboxMessages, type InboxMessageRow, type InsertInboxMessageRow } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { interactions } from "../db/schema/interactions";
import { eq, desc } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

// ── 分类关键词（移植自旧 PE inbox-service.js）──

const KEYWORDS = {
  auto_reply: [
    "automatic reply","auto-reply","auto reply","out of office","out of the office",
    "vacation","vacaciones","feriado","holiday notice","ooo -","[ooo]","ausente",
    "ausência","fuera de la oficina","fora do escritório","respuesta automática",
    "resposta automática","away from office","no estaré","estare ausente","estoy fuera",
    "自動返信","자동 응답","부재중","balasan otomatis","abwesend","urlaub",
    "en vacances","assenza","fuori sede","自动回复","休假",
  ],
  bounce_subject: [
    "undelivered","returned mail","delivery failure","mail delivery failed",
    "returned to sender","message could not be delivered","delivery status notification",
    "failure notice","mail system","address rejected","user unknown","mailbox full",
    "not found","does not exist","undeliverable","permanent failure","退信","退回","退件",
    "系统退信","投递失败","发送失败",
  ],
  bounce_senders: [
    "mailer-daemon","postmaster","mail delivery subsystem","mailadmin@","mailer@",
  ],
  bounce_body: [
    "address rejected","user unknown","mailbox not found","no such user",
    "invalid recipient","mailbox unavailable","does not like recipient",
    "not accepting mail","unrouteable address","recipient rejected","status: 5",
    "over quota","mailbox exceeded","message blocked","smtp error",
    "delivery failed permanently","unable to deliver","recipient unknown",
  ],
  bounce_left: [
    "no longer","has left","left the company","no longer with",
    "is no longer at","no longer works","不再该公司","已离职","no longer employed",
  ],
  reply_prefix: ["re:","resp:","rv:","ref:","回复:","答复:","转发:","fw:","fwd:"],
  inquiry: [
    "solicitud","consulta","cotización","cotizacion","información","info.",
    "request for quote","rfq","presupuesto","orçamento","budget request",
    "shipping quote","freight quote","logistics inquiry","cargo quote","transport quote",
  ],
} as const;

// ── 分类方法 ──

export type { InboxMessageRow } from "../db/schema/inbox";
export type Classification = "replied" | "bounce" | "autoreply" | "other";

export function classify(subject: string | null, from: string | null, bodyPreview: string | null): Classification {
  const s = (subject || "").toLowerCase();
  const f = (from || "").toLowerCase();
  const b = (bodyPreview || "").toLowerCase().slice(0, 500);

  // 0. 自动回复优先（可能也带 Re:）
  if (KEYWORDS.auto_reply.some(k => s.includes(k) || b.includes(k))) return "autoreply";

  // 1. 退信检测
  if (KEYWORDS.bounce_subject.some(k => s.includes(k))) return "bounce";
  if (KEYWORDS.bounce_senders.some(k => f.includes(k))) return "bounce";
  if (/\b5\d{2}\b/.test(b)) return "bounce";
  if (KEYWORDS.bounce_body.some(k => b.includes(k))) return "bounce";
  if (KEYWORDS.bounce_left.some(k => b.includes(k))) return "bounce";

  // 2. 回复
  if (KEYWORDS.reply_prefix.some(k => s.startsWith(k))) return "replied";
  if (KEYWORDS.inquiry.some(k => s.includes(k) || b.includes(k))) return "replied";

  return "other";
}

// ── 联系人匹配 ──

export function matchContact(email: string): ContactRow | null {
  const row = getDb().select().from(contacts)
    .where(eq(contacts.email, email.toLowerCase().trim()))
    .get();
  return row || null;
}

// ── 抓取器状态 ──

const SEEN_UIDS = new Set<string>();
let fetchInterval: ReturnType<typeof setInterval> | null = null;

/** IMAP fetch 函数，由 transport 层注入 */
let imapFetchFn: ((accountId: number) => Promise<Result<InboxMessageRow[]>>) | null = null;
export function setImapFetchFn(fn: (accountId: number) => Promise<Result<InboxMessageRow[]>>) {
  imapFetchFn = fn;
}

/** 推送事件的回调 */
let pushFn: ((channel: string, data: unknown) => void) | null = null;
export function setInboxPushFn(fn: (channel: string, data: unknown) => void) {
  pushFn = fn;
}

// ── 抓取 ──

export async function fetchInbox(accountId?: number): Promise<Result<InboxMessageRow[]>> {
  Log.debug("inbox.fetch", `accountId=${accountId}`);

  if (!imapFetchFn) {
    return failResult("IMAP 抓取函数未配置");
  }

  // 默认抓取所有活跃账号
  const accounts = accountId
    ? getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).all()
    : getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();

  const allNew: InboxMessageRow[] = [];

  for (const account of accounts) {
    try {
      const result = await imapFetchFn(account.id);
      if (!result.success) {
        Log.warn("inbox.fetch", `账号 ${account.email} 抓取失败: ${result.error}`);
        continue;
      }

      // 去重 UID
      const newItems = result.data.filter(m => !SEEN_UIDS.has(m.messageId || ""));
      for (const item of newItems) {
        if (item.messageId) SEEN_UIDS.add(item.messageId);
      }
      allNew.push(...newItems);

      if (newItems.length > 0) {
        Log.info("inbox.fetch", `${account.email}: ${newItems.length} 封新邮件`);
        // 记录互动（退信、回复）
        for (const m of newItems) {
          if (m.classification === "bounce" || m.classification === "replied") {
            const c = matchContact(m.fromEmail);
            if (c) {
              getDb().insert(interactions).values({
                contactId: c.id,
                type: m.classification === "bounce" ? "bounced" : "replied",
                direction: "inbound",
                subject: m.subject,
                bodyPreview: m.bodyPreview,
                messageId: m.messageId,
                accountId: m.accountId,
                createdAt: m.receivedAt,
              }).run();
              // 更新联系人状态
              const { updateContactStatus, markAsBounced } = require("./contact.service");
              if (m.classification === "bounce") markAsBounced(c.id);
              else updateContactStatus(c.id, "replied");
            }
          }
        }
        saveDatabase();
      }
    } catch (err: unknown) {
      Log.error("inbox.fetch", `${account.email} 异常`,
        err instanceof Error ? err.stack : String(err));
    }
  }

  // 推送新邮件通知
  if (allNew.length > 0 && pushFn) {
    try { pushFn("inbox:newMail", { count: allNew.length }); } catch { /* 静默 */ }
  }

  return okResult(allNew);
}

// ── 列表 ──

export function listInbox(): Result<InboxMessageRow[]> {
  const rows = getDb().select().from(inboxMessages)
    .orderBy(desc(inboxMessages.receivedAt))
    .limit(200)
    .all();
  return okResult(rows);
}

// ── 手动更新邮件分类 ──

export function classifyMessage(id: number, classification: string): Result<void> {
  Log.debug("inbox.classify", `id=${id} type=${classification}`);

  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const valid = ["replied", "bounce", "autoreply", "other"];
  if (!valid.includes(classification)) return failResult(`无效分类: ${classification}`);

  const existing = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  if (!existing) return failResult("邮件不存在");

  getDb().update(inboxMessages).set({
    classification,
    // 退信 → 同时标记关联联系人
    ...(classification === "bounce" && existing.matchedContactId
      ? { matchedContactId: existing.matchedContactId }
      : {}),
  }).where(eq(inboxMessages.id, id)).run();
  saveDatabase();

  // 退信 → 同步更新联系人状态为 bounced
  if (classification === "bounce" && existing.matchedContactId) {
    try {
      const { markAsBounced } = require("./contact.service");
      markAsBounced(existing.matchedContactId);
    } catch { /* */ }
  }

  return okResult(undefined);
}

// ── 自动抓取 ──

export function startAutoFetch(intervalMs = 5 * 60 * 1000) {
  if (fetchInterval) clearInterval(fetchInterval);
  Log.info("inbox.auto", `每 ${intervalMs / 1000}s 自动抓取`);
  fetchInterval = setInterval(() => {
    fetchInbox().catch(err => {
      Log.error("inbox.auto", "自动抓取失败", err instanceof Error ? err.stack : undefined);
    });
  }, intervalMs);
}

export function stopAutoFetch() {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
}
