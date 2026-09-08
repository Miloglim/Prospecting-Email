import { getDb } from "../db";
import { inboxMessages, inboxBounceMatches, type InboxMessageRow, type InsertInboxMessageRow } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { crmStages, crmRelations } from "../db/schema/crm";
import { and, eq, inArray, or, desc, sql } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { EVENTS } from "../events";
import { saveDatabase, getRawDb } from "../db";
import { updateContactStatus, markAsBounced, deleteContactCascade, removeCompanyIfOrphan } from "./contact.service";
import * as path from "path";
import * as fs from "fs";
import { DB_PATH } from "../config";

// ── 已删除集持久化（防重取，参照旧 PE inbox-deleted.json）──

const DELETED_PATH = path.join(path.dirname(DB_PATH), "inbox-deleted.json");

// 内存缓存：isDeleted 在拉取循环里逐封调用，若每次读盘+JSON.parse 整个文件会卡（量一大几千次 IO）
let _deletedCache: Set<string> | null = null;

function _readDeleted(): Set<string> {
  if (_deletedCache) return _deletedCache;
  try {
    if (fs.existsSync(DELETED_PATH)) {
      _deletedCache = new Set(JSON.parse(fs.readFileSync(DELETED_PATH, "utf-8")));
    }
  } catch { /* 文件损坏 → 空集 */ }
  if (!_deletedCache) _deletedCache = new Set();
  return _deletedCache;
}

function _writeDeleted(set: Set<string>): void {
  _deletedCache = set;
  try {
    const dir = path.dirname(DELETED_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DELETED_PATH, JSON.stringify([...set].slice(-2000)));
  } catch { /* 静默 */ }
}

/** 检查指定 key 是否已被删除 */
export function isDeleted(key: string): boolean {
  return _readDeleted().has(key);
}

// ── 分类关键词（移植自旧 PE inbox-service.js）──

// ponytail: 关键词从旧 PE inbox-keywords.json 同步，覆盖 25+ 语言
const KEYWORDS = {
  auto_reply: [
    "automatic reply","auto-reply","auto reply","out of office","out of the office",
    "vacation","vacaciones","feriado","holiday notice","ooo -","[ooo]","ausente",
    "ausência","fuera de la oficina","fora do escritório","respuesta automática",
    "resposta automática","away from office","no estaré","estare ausente","estoy fuera",
    "licença maternidade","maternity leave","acceso limitado","automaattinen vastaus",
    "自動返信","자동 응답","부재중","автоответ","вне офиса","отпуск",
    "otomatik yanıt","ofis dışında","izinli","رد تلقائي","خارج المكتب","إجازة",
    "trả lời tự động","vắng mặt","nghỉ phép","ไม่อยู่ที่ทำงาน","ตอบกลับอัตโนมัติ",
    "स्वचालित उत्तर","कार्यालय से बाहर","balasan otomatis","di luar kantor",
    "abwesenheitsnotiz","abwesend","urlaub","réponse automatique",
    "automatische antwort","automatisch antwoord","risposta automatica",
    "assenza","fuori sede","en vacances","estou de férias","estaré de vuelta",
    "自动回复","休假",
  ],
  bounce_subject: [
    "undelivered","returned mail","delivery failure","mail delivery failed",
    "returned to sender","message could not be delivered","delivery status notification",
    "failure notice","mail system","address rejected","user unknown","mailbox full",
    "not found","does not exist","non remis","nicht zugestellt","no se pudo entregar",
    "退信","退回","退件","系统退信","投递失败","发送失败",
    "undeliverable","permanent failure","message undelivered",
    "warning: message","delayed delivery","delivery incomplete","rejected mail",
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
    "couldn't be delivered","couldn't deliver to","weren't found at",
    "unknown to address","the following recipients","action required",
    "recipients weren't found",
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
export type Classification = "replied" | "bounce" | "autoreply" | "other" | "sent";

/** 退信判定所需的「投递报告结构证据」：正文必须真长得像 NDR，避免误伤正常商务邮件 */
const NDR_MARKERS = [
  "reporting-mta", "final-recipient", "diagnostic-code", "original-recipient",
  "delivery to the following recipient", "failed to deliver", "delivery has failed",
  "以下收件人", "投递失败", "退信", "无法送达",
];
/** SMTP 协议码：`smtp; 550`、`status: 5.1.1`、`550 5.1.1` 这类明确形态 */
const SMTP_CODE_RE = /(smtp;\s*5\d{2}|status:\s*5\d{2}[\d.\-]*|\b5\d{2}\s+[2345]\.\d\.\d)/i;

/** 我方邮箱域名（同事/公司内部往来绝不判退信）。60 秒缓存，逐封分类不重复查库。 */
let _internalDomains: string[] | null = null;
let _internalAt = 0;
export function internalDomains(): string[] {
  if (_internalDomains && Date.now() - _internalAt < 60_000) return _internalDomains;
  _internalAt = Date.now();
  try {
    const rows = getDb().select({ email: emailAccounts.email }).from(emailAccounts).all();
    _internalDomains = [...new Set(rows
      .map(r => (r.email.split("@")[1] || "").trim().toLowerCase())
      .filter(d => d.includes(".")))];
  } catch { _internalDomains = []; }
  return _internalDomains;
}

export function classify(
  subject: string | null, from: string | null, bodyText: string | null,
  hasContactMatch = false, isCcOnly = false,
): Classification {
  const s = (subject || "").toLowerCase();
  const f = (from || "").toLowerCase();
  const b = (bodyText || "").toLowerCase().slice(0, 500);

  const domain = f.split("@")[1] || "";
  if (domain && internalDomains().includes(domain)) {
    // 我方域名来信（同事转发的报价、内部系统通知）：不判退信也不判自动回复
    if (KEYWORDS.reply_prefix.some(k => s.startsWith(k))) return "replied";
    return hasContactMatch ? "replied" : "other";
  }

  // 0. 自动回复优先（可能也带 Re:）
  if (KEYWORDS.auto_reply.some(k => s.includes(k) || b.includes(k))) return "autoreply";

  // 1. 退信检测——要硬证据。曾有 `/\b5\d{2}\b/` 这种裸数字规则：运价「545 / 580 /
  //    5 天免箱期」直接被判定退信，还据此建议用户「对方邮箱失效，改电话联系同事」。
  //    现在必须满足：主题命中退信短语 / 发件人是退信机器 / 有 SMTP 协议码 /
  //    （正文命中退信词 且 有 NDR 结构字段）。
  const strongSubject = KEYWORDS.bounce_subject.some(k => s.includes(k));
  const daemonSender = KEYWORDS.bounce_senders.some(k => f.includes(k));
  const protocolCode = SMTP_CODE_RE.test(b);
  const bodyWithStructure =
    (KEYWORDS.bounce_body.some(k => b.includes(k)) || KEYWORDS.bounce_left.some(k => b.includes(k)))
    && NDR_MARKERS.some(k => b.includes(k));
  if (strongSubject || daemonSender || protocolCode || bodyWithStructure) return "bounce";

  // 2. 仅被抄送 → 不算回复（不触发联系人状态「已回复」）
  if (isCcOnly) return "other";

  // 3. 回复
  if (KEYWORDS.reply_prefix.some(k => s.startsWith(k))) return "replied";
  if (KEYWORDS.inquiry.some(k => s.includes(k) || b.includes(k))) return "replied";

  // 4. 匹配到已知联系人 → 升级为 replied
  if (hasContactMatch) return "replied";

  return "other";
}

// ── 联系人匹配 ──

export function matchContact(email: string): ContactRow | null {
  const needle = (email || "").toLowerCase().trim();
  if (!needle) return null;
  const row = getDb().select().from(contacts)
    .where(sql`lower(${contacts.email}) = ${needle}`)
    .get();
  return row || null;
}

/** 匹配一组邮箱到联系人，返回逗号分隔的联系人 id（去重）。用于 to/cc 关联多个联系人。 */
export function matchContactIds(emails: string[]): string {
  const ids = new Set<number>();
  for (const e of emails) {
    const c = matchContact(e);
    if (c) ids.add(c.id);
  }
  return [...ids].join(",");
}

// 存量邮件即时回填已抽到 inbox-link.ts（contact.service 也要调，放这里会与
// inbox.service ↔ contact.service 现有依赖成环）。

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** 系统地址关键词 — 退信里必然出现但绝不是被退联系人 */
const SYS_ADDR_KEYWORDS = ["no-reply", "noreply", "mailer-daemon", "postmaster", "mailadmin", "mailsupport", "aliyun.com"];

/** 我方发信域名 — 退信正文里大量出现（原信头被引用），不排除会捞错 */
function myDomains(): string[] {
  return getDb().select({ email: emailAccounts.email }).from(emailAccounts).all()
    .map(a => (a.email || "").toLowerCase().split("@")[1] || "")
    .filter(Boolean);
}

/** 从退信原文提取**全部**「被退」联系人 id（去重、上限 50）。规范 docs/bounce-multi-match-spec.md §2。
 *  优先级链每层有任一命中即收：① DSN 标准头（RFC 3464——群发退信会列多个失败收件人，
 *  X-Failed-Recipients 可一行逗号多址或多行重复）→ ② 正文自然语言模式全收 → ③ 全文兜底。
 *  传完整 raw source 效果最好（DSN 段在里面）；只有 HTML 正文时自动降级走后两级。 */
export function extractBouncedContacts(text: string): number[] {
  const excl = [...SYS_ADDR_KEYWORDS, ...myDomains()];
  const seen = new Set<number>();
  const picked: number[] = [];
  const pick = (addr: string | undefined | null): void => {
    if (!addr || picked.length >= 50) return;
    const e = addr.toLowerCase().trim().replace(/[;,<>'")\]]/g, "");
    if (!e.includes("@") || excl.some(d => e.includes(d))) return;
    const c = matchContact(e);
    if (!c || seen.has(c.id)) return;
    seen.add(c.id);
    picked.push(c.id);
  };

  // ① DSN 标准头：整行捕获后按逗号/分号拆址（一行多址很常见）
  for (const m of text.matchAll(/(?:X-Failed-Recipients|Final-Recipient|Original-Recipient):\s*(?:rfc822;)?([^\r\n]+)/gi)) {
    for (const addr of (m[1] || "").split(/[,;]/)) pick(addr);
  }
  if (picked.length) return picked;

  // ② 正文模式 — 没有 DSN 段时，退信服务用自然语言写明被退地址。
  // 每条模式捕获「地址所在的一整段」再用邮箱正则展开（群发退信常把多个失败地址写在同一句里）
  const flat = text.replace(/\s+/g, " ");
  const pickSegment = (seg: string | undefined): void => {
    for (const em of (seg || "").match(EMAIL_RE) || []) pick(em);
  };
  for (const re of [
    /could not be delivered to\s+([^\r\n]{0,400})/gi,
    /following recipients?[^:]*:\s*([^\r\n]{0,400})/gi,
    /<(\S+@\S+)>[^<]{0,60}?(?:failed|rejected|bounced|undeliverable)/gi,
    /收(?:件|信)人?\s*(?:邮件)?地址[：:]\s*([^\r\n]{0,200})/g,
    /(?:无法(?:送达|投递)|退信|拒收)\s*[^\r\n]{0,60}?((?:[\w.+-]+@[\w.-]+\.\w+)(?:[，,、;；\s]+[\w.+-]+@[\w.-]+\.\w+)*)/g,
  ]) {
    for (const m of flat.matchAll(re)) pickSegment(m[1]);
  }
  if (picked.length) return picked;

  // ③ 兜底：全文扫邮箱，排除系统/我方域名后收所有能匹配到联系人的
  for (const em of text.match(EMAIL_RE) || []) pick(em);
  return picked;
}

/** 兼容旧单值语义：第一个被退人（写 inbox_messages.matched_contact_id 单列用） */
export function extractBouncedContact(text: string): number | null {
  return extractBouncedContacts(text)[0] ?? null;
}

/** ── 退信匹配写链（规范 §3）：一次调用干齐"这封退信 ↔ 这些被退人"的全部副作用 ──
 *  幂等写关联表 → 单列空则补第一个（兼容旧读取）→ 每个新加入者标记退信 + 补一条 bounced 事件。
 *  返回本次新增的联系人 id（旧链只处理一个人，全员在这一步一次覆盖）。不 saveDatabase，由调用方统一落盘。 */
export function recordBounceMatches(msgId: number, cids: number[]): number[] {
  const uniq = [...new Set(cids)].filter(x => Number.isInteger(x) && x > 0);
  if (!uniq.length) return [];
  const db = getDb();
  const msg = db.select().from(inboxMessages).where(eq(inboxMessages.id, msgId)).get();
  if (!msg) return [];
  const already = new Set(db.select({ contactId: inboxBounceMatches.contactId }).from(inboxBounceMatches)
    .where(eq(inboxBounceMatches.messageId, msgId)).all().map(r => r.contactId));
  const fresh = uniq.filter(cid => !already.has(cid));
  for (const cid of fresh) db.insert(inboxBounceMatches).values({ messageId: msgId, contactId: cid }).run();
  if (msg.matchedContactId == null) {
    db.update(inboxMessages).set({ matchedContactId: uniq[0] }).where(eq(inboxMessages.id, msgId)).run();
  }
  for (const cid of fresh) {
    markAsBounced(cid);
    db.insert(interactions).values({
      contactId: cid, type: "bounced", direction: "inbound",
      subject: msg.subject, bodyPreview: (msg.bodyPreview || "").slice(0, 500),
      messageId: msg.messageId, accountId: msg.accountId, createdAt: msg.receivedAt,
    }).run();
  }
  return fresh;
}

// ── 抓取器状态 ──

const SEEN_UIDS = new Set<string>();
let fetchInterval: ReturnType<typeof setInterval> | null = null;

/** IMAP fetch 函数，由 transport 层注入 */
let imapFetchFn: ((accountId: number) => Promise<Result<InboxMessageRow[]>>) | null = null;
export function setImapFetchFn(fn: (accountId: number) => Promise<Result<InboxMessageRow[]>>) {
  imapFetchFn = fn;
}

// 正文懒加载：按 messageId 单封拉取（由 transport 注入，避免 service 依赖 imapflow）
let imapFetchBodyFn: ((accountId: number, messageId: string, classification?: string | null) => Promise<Result<string>>) | null = null;
export function setImapFetchBodyFn(fn: (accountId: number, messageId: string, classification?: string | null) => Promise<Result<string>>) {
  imapFetchBodyFn = fn;
}

/** 推送事件的回调 */
let pushFn: ((channel: string, data: unknown) => void) | null = null;
export function setInboxPushFn(fn: (channel: string, data: unknown) => void) {
  pushFn = fn;
}

// ── 抓取 ──

export async function fetchInbox(accountId?: number, excludeIds?: number[]): Promise<Result<InboxMessageRow[]>> {
  Log.debug("inbox.fetch", `accountId=${accountId}`);

  if (!imapFetchFn) {
    return failResult("IMAP 抓取函数未配置");
  }

  // 默认抓取所有活跃账号（excludeIds = 本轮失败退避中的账号，见 startAutoFetch）
  let accounts = accountId
    ? getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).all()
    : getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  if (!accountId && excludeIds?.length) accounts = accounts.filter(a => !excludeIds.includes(a.id));
  if (!accounts.length) return okResult([]);

  const allNew: InboxMessageRow[] = [];

  // ponytail: 并行抓取所有账号；单账号异常也收敛为失败结果（保证健康度能对上账号）
  const results = await Promise.allSettled(
    accounts.map(async acc => {
      try {
        return { account: acc, result: await imapFetchFn!(acc.id) };
      } catch (err: unknown) {
        return { account: acc, result: failResult(err instanceof Error ? err.message : String(err)) };
      }
    })
  );

  // 收信健康度：逐账号落库（fetch_fail_count / last_fetch_error），本轮结束统一推送
  const health: Array<{ accountId: number; email: string; ok: boolean; error?: string }> = [];
  const now = new Date().toISOString();
  const db = getDb();

  for (const r of results) {
    if (r.status === "rejected") { Log.warn("inbox.fetch", "账号抓取异常"); continue; }
    const { account, result } = r.value;
    if (!result.success) {
      db.update(emailAccounts)
        .set({ fetchFailCount: sql`${emailAccounts.fetchFailCount} + 1`, lastFetchError: (result.error || "抓取失败").slice(0, 300), lastFetchAt: now })
        .where(eq(emailAccounts.id, account.id)).run();
      health.push({ accountId: account.id, email: account.email, ok: false, error: result.error });
      Log.warn("inbox.fetch", `账号 ${account.email} 抓取失败: ${result.error}`);
      continue;
    }
    db.update(emailAccounts)
      .set({ fetchFailCount: 0, lastFetchError: null, lastFetchAt: now })
      .where(eq(emailAccounts.id, account.id)).run();
    health.push({ accountId: account.id, email: account.email, ok: true });

    // 去重 UID
    const newItems = result.data.filter(m => !SEEN_UIDS.has(m.messageId || ""));
    for (const item of newItems) {
      if (item.messageId) SEEN_UIDS.add(item.messageId);
    }
    allNew.push(...newItems);

    if (newItems.length > 0) {
      Log.info("inbox.fetch", `${account.email}: ${newItems.length} 封新邮件`);
      for (const m of newItems) {
        if (m.classification === "bounce" || m.classification === "replied" || m.classification === "autoreply") {
          const cid = m.matchedContactId ?? (matchContact(m.fromEmail)?.id || null);
          if (cid) {
            const typeMap: Record<string, string> = { bounce: "bounced", replied: "replied", autoreply: "autoreply" };
            getDb().insert(interactions).values({
              contactId: cid,
              type: typeMap[m.classification] || m.classification,
              direction: "inbound",
              subject: m.subject,
              bodyPreview: m.bodyPreview,
              messageId: m.messageId,
              accountId: m.accountId,
              createdAt: m.receivedAt,
              }).run();
              // 更新联系人状态
              if (m.classification === "bounce") markAsBounced(cid);
              else updateContactStatus(cid, m.classification);
              // 发信任务止损联动（docs/smart-send-spec.md §3.3）：回复/退订/bounce 止损，OOO 顺延。
              // 惰性 import 防循环依赖；失败绝不影响收信主流程。
              try {
                const kind = m.classification === "bounce" ? "bounce"
                  : m.classification === "autoreply" ? "autoreply" : "replied";
                void import("./campaign.service").then(cm => cm.onContactSignal(cid, kind));
              } catch { /* 止损联动失败不影响收信 */ }
            }
          }
        }
      saveDatabase();
    }
  }

  // 收信健康度落库并推送（前端设置页状态列 / 账号列表据此点亮异常）
  if (health.length > 0) {
    saveDatabase();
    try { pushFn?.(EVENTS.INBOX_HEALTH, health); } catch { /* 静默 */ }
  }

  // 推送新邮件通知（含详细分类数目）
  if (allNew.length > 0 && pushFn) {
    try {
      const byClass: Record<string, number> = {};
      for (const m of allNew) {
        const c = m.classification || "other";
        byClass[c] = (byClass[c] || 0) + 1;
      }
      pushFn("inbox:newMail", { count: allNew.length, byClass });
    } catch { /* 静默 */ }
  }

  // 每次抓取后自动清理超限旧邮件
  if (allNew.length > 0) {
    try { cleanupInbox(); } catch { /* */ }
  }

  return okResult(allNew);
}

// ── 清理超上限旧邮件（先备份再删除）──
const CLEANUP_LIMITS: Record<string, number> = {
  replied: 2000, autoreply: 2000, bounce: 1000, other: 500,
}; // sent 完全解除限制：真实发信量远大于 500，不再清理/截断

const ARCHIVE_PATH = path.join(path.dirname(DB_PATH), "inbox-archive.jsonl");

export function cleanupInbox(): void {
  const db = getDb();
  let archiveLines: string[] = [];

  // 退信去重：同 subject+发件人+时间 的重复退信只保留最小 id（退信服务批量发的重复退信）
  try {
    const deleted = getRawDb().prepare(`
      DELETE FROM inbox_messages
      WHERE classification = 'bounce'
        AND id NOT IN (
          SELECT MIN(id) FROM inbox_messages
          WHERE classification = 'bounce'
          GROUP BY subject, from_email, received_at
        )
    `).run().changes;
    if (deleted > 0) {
      Log.info("inbox.cleanup", `退信去重删除 ${deleted} 封`);
      saveDatabase();
    }
  } catch (e) { Log.warn("inbox.cleanup", `退信去重失败: ${(e as Error).message}`); }

  // messageId 去重：相同 messageId 多行只保留最小 id（detectSent 并发导致的重复）
  try {
    const deleted2 = getRawDb().prepare(`
      DELETE FROM inbox_messages
      WHERE message_id IS NOT NULL AND message_id != ''
        AND id NOT IN (
          SELECT MIN(id) FROM inbox_messages
          WHERE message_id IS NOT NULL AND message_id != ''
          GROUP BY message_id
        )
    `).run().changes;
    if (deleted2 > 0) {
      Log.info("inbox.cleanup", `messageId 去重删除 ${deleted2} 封`);
      saveDatabase();
    }
  } catch (e) { Log.warn("inbox.cleanup", `messageId 去重失败: ${(e as Error).message}`); }

  for (const [cls, limit] of Object.entries(CLEANUP_LIMITS)) {
    const rows = db.select({
      id: inboxMessages.id, fromEmail: inboxMessages.fromEmail,
      fromName: inboxMessages.fromName, subject: inboxMessages.subject,
      bodyPreview: inboxMessages.bodyPreview, classification: inboxMessages.classification,
      matchedContactId: inboxMessages.matchedContactId, receivedAt: inboxMessages.receivedAt,
      accountId: inboxMessages.accountId,
    })
      .from(inboxMessages)
      .where(eq(inboxMessages.classification, cls))
      .orderBy(desc(inboxMessages.receivedAt))
      .all();
    if (rows.length <= limit) continue;
    const toDelete = rows.slice(limit);

    // 备份：写入 JSON Lines 格式
    for (const r of toDelete) {
      archiveLines.push(JSON.stringify({
        fromEmail: r.fromEmail, fromName: r.fromName,
        subject: r.subject, body: r.bodyPreview,
        classification: r.classification,
        receivedAt: r.receivedAt, accountId: r.accountId,
        archivedAt: new Date().toISOString(),
      }));
    }

    for (const r of toDelete) db.delete(inboxMessages).where(eq(inboxMessages.id, r.id)).run();
    Log.info("inbox.cleanup", `${cls}: 备份+删除 ${toDelete.length} 封，保留 ${limit}`);
  }

  // 追加写入备份文件（每行一条 JSON）
  if (archiveLines.length > 0) {
    try {
      const dir = path.dirname(ARCHIVE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(ARCHIVE_PATH, archiveLines.join("\n") + "\n");
      Log.info("inbox.archive", `已备份 ${archiveLines.length} 封邮件 → ${ARCHIVE_PATH}`);
    } catch (err) {
      Log.error("inbox.archive", "备份写入失败", err instanceof Error ? err.stack : undefined);
    }
  }
  if (archiveLines.length > 0) saveDatabase();
}

// ── 列表 ──

export function listInbox(): Result<InboxMessageRow[]> {
  const db = getDb();
  // 按分类分别限定数量，合并返回
  const all: InboxMessageRow[] = [];
  for (const [cls, limit] of Object.entries(CLEANUP_LIMITS)) {
    const rows = db.select().from(inboxMessages)
      .where(eq(inboxMessages.classification, cls))
      .orderBy(desc(inboxMessages.receivedAt))
      .limit(limit)
      .all();
    all.push(...rows);
  }
  // sent 完全解除限制：全量返回，不截断
  const sentRows = db.select().from(inboxMessages)
    .where(eq(inboxMessages.classification, "sent"))
    .orderBy(desc(inboxMessages.receivedAt))
    .all();
  all.push(...sentRows);
  // 按时间统一排序
  all.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());

  // ponytail: 批量查关联数据（发件账号 + 联系人状态），避免前端 N 次请求
  const accountIds = [...new Set(all.map(r => r.accountId).filter(Boolean))];
  const contactIds = [...new Set(all.map(r => r.matchedContactId).filter(Boolean))];
  const accountMap = new Map<number, string>();
  const contactMap = new Map<number, { status: string; tags: string }>();
  for (const aid of accountIds) {
    const a = db.select({ email: emailAccounts.email }).from(emailAccounts).where(eq(emailAccounts.id, aid)).get();
    if (a) accountMap.set(aid, a.email);
  }
  for (const cid of contactIds) {
    if (cid == null) continue;
    const c = db.select({ status: contacts.status, tags: contacts.tags })
      .from(contacts).where(eq(contacts.id, cid)).get();
    if (c) contactMap.set(cid, { status: c.status || "", tags: c.tags || "[]" });
  }

  // 扩展返回字段（前端不需要改接口定义，通过 unknown→any 带过去）
  const enriched = all.map(r => ({
    ...r,
    _accountEmail: accountMap.get(r.accountId) || null,
    _contactStatus: contactMap.get(r.matchedContactId ?? 0)?.status || null,
    _contactTags: contactMap.get(r.matchedContactId ?? 0)?.tags || null,
  }));
  return okResult(enriched as unknown as InboxMessageRow[]);
}

// ── 正文落盘（正文不进库，独立文件存储，参照 Foxmail 索引/正文分离）──

const BODY_DIR = path.join(path.dirname(DB_PATH), "bodies");

function bodyFilePath(id: number): string {
  return path.join(BODY_DIR, `${id}.html`);
}

/** 正文写入磁盘文件（异步，避免阻塞主进程） */
export async function writeBodyFile(id: number, html: string): Promise<void> {
  if (!html) return;
  if (!fs.existsSync(BODY_DIR)) fs.mkdirSync(BODY_DIR, { recursive: true });
  await fs.promises.writeFile(bodyFilePath(id), html, "utf-8");
}

/**
 * 只读本地落盘正文（同步、纯 fs、绝不触发 IMAP）：给上下文注入这类「毫秒级、拿不到就算了」
 * 的场景用。返回 null = 正文没落盘（此时只有 bodyPreview，注入方必须如实标注为预览）。
 */
export function readLocalBodyHtml(id: number): string | null {
  try {
    const file = bodyFilePath(id);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  } catch { return null; }
}

/** insert 后立即调用：把正文写入刚插入的邮件（用 last_insert_rowid 拿自增 id） */
export async function writeBodyForLastInsert(html: string): Promise<void> {
  if (!html) return;
  const row = getRawDb().prepare("SELECT last_insert_rowid() AS id").get() as { id: number } | undefined;
  const id = row?.id;
  if (typeof id === "number" && id > 0) await writeBodyFile(id, html);
}

// ── 获取邮件正文 ──

/** 从正文捞联系人回填（点开正文时顺手做，幂等）。
 *  退信：以关联表为准——没关联过则全量补一次（关联+标记+事件一步齐）；
 *  普通邮件：保持旧机会式匹配（正文里第一个在库联系人 → 单列），不建关联不标记。
 *  不补的话：右侧详情靠前端扫正文能显示「已匹配」，左侧列表读的却是 DB 字段 → 标签永远不亮。 */
function backfillMatchFromBody(id: number, current: number | null, classification: string | null, text: string): void {
  let touched = false;
  if (classification === "bounce") {
    const linked = getDb().select({ id: inboxBounceMatches.id }).from(inboxBounceMatches)
      .where(eq(inboxBounceMatches.messageId, id)).limit(1).get();
    if (!linked) touched = recordBounceMatches(id, extractBouncedContacts(text)).length > 0;
  } else if (current == null) {
    const cid = extractBouncedContact(text);
    if (cid != null) {
      getDb().update(inboxMessages).set({ matchedContactId: cid }).where(eq(inboxMessages.id, id)).run();
      touched = true;
    }
  }
  if (!touched) return;
  saveDatabase();
  // 推空计数事件：前端监听里 count=0 不弹提示，只刷新列表 → 左侧标签立即亮
  try { pushFn?.("inbox:newMail", { count: 0 }); } catch { /* 推送失败不影响正文返回 */ }
}

/** 邮件 HTML → 可读纯文本：剔 style/script/head 与 data:URI 内嵌图片，块级标签转换行，去标签+解码常见实体，压缩空白 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/"data:[^"]*"/g, '""')
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6]|table|blockquote|pre)(\s[^>]*)?\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function getBody(id: number): Promise<Result<string>> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const row = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  if (!row) return failResult("邮件不存在");
  // ① 正文已在磁盘文件 → 直接读（毫秒级，持久，重启后依然秒开）
  const file = bodyFilePath(id);
  if (fs.existsSync(file)) {
    try {
      const html = await fs.promises.readFile(file, "utf-8");
      backfillMatchFromBody(row.id, row.matchedContactId, row.classification, html);
      return okResult(html);
    }
    catch (err) { Log.error("inbox.body", `正文文件读取失败 id=${id}`, err instanceof Error ? err.stack : undefined); }
  }
  // ② 懒加载：IMAP 拉单封（fetchBody 内部会落盘文件）
  if (row.messageId && imapFetchBodyFn) {
    const r = await imapFetchBodyFn(row.accountId, row.messageId, row.classification);
    if (r.success && r.data) return okResult(r.data);
  }
  return okResult(row.bodyPreview || "");
}

/** 预加载最近 N 封无正文文件的邮件（限速 ~50ms/封，参考 Foxmail 读条后秒开体验） */
export async function prefetchRecentBodies(limit = 20): Promise<void> {
  if (!imapFetchBodyFn) return;
  const rows = getDb().select({ id: inboxMessages.id, accountId: inboxMessages.accountId, messageId: inboxMessages.messageId, classification: inboxMessages.classification })
    .from(inboxMessages)
    .where(sql`${inboxMessages.messageId} IS NOT NULL`)
    .orderBy(desc(inboxMessages.receivedAt))
    .limit(limit)
    .all();
  let loaded = 0;
  for (const r of rows) {
    if (!r.messageId) continue;
    if (fs.existsSync(bodyFilePath(r.id))) continue; // 已落盘 → 跳过（幂等）
    try {
      await imapFetchBodyFn(r.accountId, r.messageId, r.classification);
      loaded++;
      await new Promise(res => setTimeout(res, 50)); // 限速，避免瞬间打爆 IMAP
    } catch { /* 单封失败跳过 */ }
  }
  if (loaded > 0) Log.info("inbox.prefetch", `预加载 ${loaded}/${rows.length} 封正文`);
}

/** 退信原文到手后的落地处理：提取被退联系人 → 回填 matchedContactId → 正文落盘 → 标记联系人退信。
 *  抓取阶段拿到 raw source 时调用（DSN 段只在原文里，mailparser 会把它归到 attachments）。
 *  返回 true 表示本次新匹配到了联系人。 */
export async function applyBounceSource(
  messageId: string, accountId: number, rawSource: string, html: string, bodyText: string,
): Promise<boolean> {
  const row = getDb().select({ id: inboxMessages.id, matchedContactId: inboxMessages.matchedContactId })
    .from(inboxMessages)
    .where(sql`${inboxMessages.messageId} = ${messageId} AND ${inboxMessages.accountId} = ${accountId}`)
    .get();
  if (!row) return false;

  if (html) {
    try { await writeBodyFile(row.id, html); }
    catch (err) { Log.error("inbox.bounce", `正文落盘失败 id=${row.id}`, err instanceof Error ? err.stack : undefined); }
  }

  getDb().update(inboxMessages).set({ bodyPreview: bodyText.slice(0, 500) })
    .where(eq(inboxMessages.id, row.id)).run();

  // 全员被退一次收齐（群发退信可通知多个失败收件人）——
  // 关联表 + 标记退信 + bounced 事件的下游链都在 recordBounceMatches 里
  const fresh = recordBounceMatches(row.id, extractBouncedContacts(rawSource));
  saveDatabase();
  return fresh.length > 0;
}

/** 补匹配退信联系人（幂等）。
 *  退信 from 是 mailer-daemon，抓取阶段必然匹配不到；被退的真实收件人只在正文里。
 *  口径 = 关联表还没有记录的退信（存量单列值已由迁移种子进表，不会重复处理）。
 *  ponytail: 只扫本地已落盘的正文文件，零网络。缺正文的邮件等 prefetch/点开后落盘，下次拉取再补。 */
export async function backfillBounceMatches(): Promise<number> {
  const rows = getDb().select({ id: inboxMessages.id }).from(inboxMessages)
    .where(sql`${inboxMessages.classification} = 'bounce'
      AND ${inboxMessages.id} NOT IN (SELECT ${inboxBounceMatches.messageId} FROM ${inboxBounceMatches})`)
    .all();

  let filled = 0;
  for (const r of rows) {
    const file = bodyFilePath(r.id);
    if (!fs.existsSync(file)) continue;
    try {
      const fresh = recordBounceMatches(r.id, extractBouncedContacts(await fs.promises.readFile(file, "utf-8")));
      if (fresh.length) filled++;
    } catch (err) {
      Log.error("inbox.backfill", `正文读取失败 id=${r.id}`, err instanceof Error ? err.stack : undefined);
    }
  }
  if (filled > 0) {
    saveDatabase();
    Log.info("inbox.backfill", `退信补匹配 ${filled}/${rows.length} 封`);
  }
  return filled;
}

/** 一次性迁移：存量 raw_source 正文导出到文件 + 删除列（幂等，启动时调用） */
export async function migrateBodiesOut(): Promise<void> {
  const raw = getRawDb();
  const cols = (raw.prepare("PRAGMA table_info(inbox_messages)").all() as Array<{ name: string }>).map(r => r.name);
  if (!cols.includes("raw_source")) return; // 已迁移过
  const rows = raw.prepare("SELECT id, raw_source FROM inbox_messages WHERE raw_source IS NOT NULL AND raw_source != ''").all() as
    Array<{ id: number; raw_source: string | null }>;
  let n = 0;
  for (const r of rows) {
    const id = Number(r.id);
    const html = String(r.raw_source || "");
    if (!id || !html) continue;
    try { await writeBodyFile(id, html); n++; }
    catch (err) { Log.error("inbox.migrate", `正文导出失败 id=${id}`, err instanceof Error ? err.stack : undefined); }
  }
  raw.exec("ALTER TABLE inbox_messages DROP COLUMN raw_source;");
  saveDatabase();
  Log.info("inbox.migrate", `正文出库 ${n} 封 → ${BODY_DIR}，库已瘦身`);
}

// ── 手动更新邮件分类 ──

export function classifyMessage(id: number, classification: string): Result<void> {
  Log.debug("inbox.classify", `id=${id} type=${classification}`);

  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const valid = ["replied", "bounce", "autoreply", "other", "sent"];
  if (!valid.includes(classification)) return failResult(`无效分类: ${classification}`);

  const existing = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  if (!existing) return failResult("邮件不存在");

  getDb().update(inboxMessages).set({ classification })
    .where(eq(inboxMessages.id, id)).run();

  // 回写联系人状态；手动标退信同时进关联表（与一键删除同源）
  if (existing.matchedContactId) {
    if (classification === "bounce") recordBounceMatches(id, [existing.matchedContactId]);
    else if (classification === "autoreply") updateContactStatus(existing.matchedContactId, "autoreply");
  }
  saveDatabase();

  return okResult(undefined);
}

// ── 标记已回复（外部客户端发送后记录）──

export function markReplied(id: number): Result<void> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const existing = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  if (!existing) return failResult("邮件不存在");

  getDb().update(inboxMessages).set({ classification: "replied" })
    .where(eq(inboxMessages.id, id)).run();

  if (existing.matchedContactId) {
    getDb().insert(interactions).values({
      contactId: existing.matchedContactId,
      type: "sent",
      direction: "outbound",
      subject: `Re: ${existing.subject || ""}`,
      bodyPreview: `已通过外部客户端回复: ${existing.fromEmail}`,
      messageId: existing.messageId,
      accountId: existing.accountId,
    }).run();
    updateContactStatus(existing.matchedContactId, "replied");
  }
  saveDatabase();
  return okResult(undefined);
}

// ── 标记已读 / 删除 ──

/** 程序内标读待回写服务器 \Seen 的队列：键 accountId|messageId（IMAP 抓取轮开始时统一回写，
 *  否则未读校准会按服务器视角把程序内的已读改回未读——已读"复活"的根因） */
const pendingSeen = new Map<string, { accountId: number; messageId: string }>();

export function takePendingSeen(accountId: number): Array<{ messageId: string }> {
  const out: Array<{ messageId: string }> = [];
  for (const [k, v] of pendingSeen) {
    if (v.accountId === accountId) { out.push({ messageId: v.messageId }); pendingSeen.delete(k); }
  }
  return out;
}

export function markRead(id: number): Result<void> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const row = getDb().select({ accountId: inboxMessages.accountId, messageId: inboxMessages.messageId })
    .from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  getDb().update(inboxMessages).set({ isRead: 1 })
    .where(eq(inboxMessages.id, id)).run();
  if (row?.accountId && row.messageId) {
    pendingSeen.set(`${row.accountId}|${row.messageId}`, { accountId: row.accountId, messageId: row.messageId });
  }
  saveDatabase();
  return okResult(undefined);
}

export function deleteMessage(id: number): Result<void> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const existing = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  if (!existing) return failResult("邮件不存在");
  // 记录已删除 key（accountId|uid）防止重取
  const key = `${existing.accountId}|${existing.messageId}`;
  const deleted = _readDeleted();
  deleted.add(key);
  _writeDeleted(deleted);
  getDb().delete(inboxMessages).where(eq(inboxMessages.id, id)).run();
  saveDatabase();
  return okResult(undefined);
}

/** 「被退联系人」唯一数据源（规范 §4）：关联表 ∪ 旧单列，只认现存联系人。
 *  INNER 语义（id 必须在 contacts 里）天然把「挂到已消失旧 ID」挡在计数外。
 *  按钮计数、确认弹窗、一键删除三处共用这一个口径 —— 所见 = 所删。 */
function bounceMatchedContactIds(): number[] {
  return getDb().select({ id: contacts.id }).from(contacts)
    .where(sql`${contacts.id} IN (
      SELECT m.contact_id FROM inbox_bounce_matches m
        JOIN inbox_messages i ON i.id = m.message_id AND i.classification = 'bounce'
      UNION
      SELECT i2.matched_contact_id FROM inbox_messages i2
        WHERE i2.classification = 'bounce' AND i2.matched_contact_id IS NOT NULL
    )`).all().map(r => r.id);
}

/** 按钮/确认弹窗现拉：全库同源计数 + 邮箱预览（前 20），弹窗说的就是会删的 */
export function bounceMatchStats(): Result<{ count: number; emails: string[] }> {
  const ids = bounceMatchedContactIds();
  const emails = ids.length
    ? getDb().select({ email: contacts.email }).from(contacts).where(inArray(contacts.id, ids)).all().map(r => r.email)
    : [];
  return okResult({ count: ids.length, emails: emails.slice(0, 20) });
}

/** 某封退信的被退联系人（详情栏「被退联系人」段） */
export function bounceMatchesOf(inboxMessageId: number): Result<Array<{ id: number; email: string; companyName: string | null }>> {
  if (!Number.isInteger(inboxMessageId) || inboxMessageId <= 0) return failResult("无效的 ID");
  const rows = getDb().select({ id: contacts.id, email: contacts.email, companyName: companies.name })
    .from(inboxBounceMatches)
    .innerJoin(contacts, eq(contacts.id, inboxBounceMatches.contactId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(eq(inboxBounceMatches.messageId, inboxMessageId))
    .all();
  return okResult(rows);
}

/** 一键删除全部被退联系人：邮件保留仅解关联；不可逆 → 动手前先把整人档案追加归档，归档失败即拒绝删除。 */
export function deleteAllBounce(): Result<{ deleted: number; emails: string[]; archive: string | null }> {
  const ids = bounceMatchedContactIds();
  if (!ids.length) return okResult({ deleted: 0, emails: [], archive: null });
  const db = getDb();
  const people = db.select().from(contacts).where(inArray(contacts.id, ids)).all();
  const archivePath = path.join(path.dirname(DB_PATH), "bounce-delete-archive.jsonl");
  try {
    const now = new Date().toISOString();
    const lines = people.map(p => JSON.stringify({
      deletedAt: now,
      contact: p,
      interactions: db.select().from(interactions).where(eq(interactions.contactId, p.id)).all(),
      crmStages: db.select().from(crmStages).where(eq(crmStages.contactId, p.id)).all(),
      crmRelations: db.select().from(crmRelations).where(or(eq(crmRelations.contactIdA, p.id), eq(crmRelations.contactIdB, p.id))).all(),
      bounceMessageIds: db.select({ messageId: inboxBounceMatches.messageId }).from(inboxBounceMatches)
        .where(eq(inboxBounceMatches.contactId, p.id)).all().map(r => r.messageId),
    }));
    if (!fs.existsSync(path.dirname(archivePath))) fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.appendFileSync(archivePath, lines.join("\n") + "\n", "utf-8");
  } catch (err) {
    return failResult(`删除前归档写入失败，未删除任何人：${err instanceof Error ? err.message : String(err)}`);
  }
  for (const p of people) {
    deleteContactCascade(p.id);
    removeCompanyIfOrphan(p.companyId);   // 与单个删除同口径：名下没人的公司随手清，不留孤儿
  }
  saveDatabase();
  Log.info("inbox.deleteBounce", `已删除 ${people.length} 个被退联系人，归档：${archivePath}`);
  return okResult({ deleted: people.length, emails: people.map(p => p.email), archive: archivePath });
}

// ── 自动抓取 ──

export function startAutoFetch(intervalMs = 5 * 60 * 1000) {
  if (fetchInterval) clearInterval(fetchInterval);
  Log.info("inbox.auto", `每 ${intervalMs / 1000}s 自动抓取`);
  // P1-4: 轮询防重入 — 上一轮没跑完（如超大积压/慢连接）时跳过本轮，避免并发抓取同账号
  let autoRunning = false;
  // 失败退避：被限流的账号越撞限得越狠 —— 连败 ≥3 降频到每 4 轮、≥12 降频到每 12 轮；成功一轮自动恢复
  let autoTick = 0;
  fetchInterval = setInterval(() => {
    if (autoRunning) {
      Log.warn("inbox.auto", "上一轮抓取未结束，本轮跳过");
      return;
    }
    autoRunning = true;
    autoTick++;
    let exclude: number[] = [];
    try {
      exclude = getDb()
        .select({ id: emailAccounts.id, f: emailAccounts.fetchFailCount })
        .from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all()
        .filter(a => a.f >= 3 && autoTick % (a.f >= 12 ? 12 : 4) !== 0)
        .map(a => a.id);
      if (exclude.length) Log.info("inbox.auto", `失败退避：跳过 ${exclude.length} 个连败账号（本第 ${autoTick} 轮）`);
    } catch { /* 查不到就照常全量 */ }
    fetchInbox(undefined, exclude)
      .catch(err => {
        Log.error("inbox.auto", "自动抓取失败", err instanceof Error ? err.stack : undefined);
      })
      .finally(() => { autoRunning = false; });
  }, intervalMs);
}

export function stopAutoFetch() {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
}
