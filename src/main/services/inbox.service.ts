import { getDb } from "../db";
import { inboxMessages, type InboxMessageRow, type InsertInboxMessageRow } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { interactions } from "../db/schema/interactions";
import { eq, desc, sql } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase, getSqlJsDb } from "../db";
import { updateContactStatus, markAsBounced, deleteContactCascade } from "./contact.service";
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

export function classify(
  subject: string | null, from: string | null, bodyText: string | null,
  hasContactMatch = false, isCcOnly = false,
): Classification {
  const s = (subject || "").toLowerCase();
  const f = (from || "").toLowerCase();
  const b = (bodyText || "").toLowerCase().slice(0, 500);

  // 0. 自动回复优先（可能也带 Re:）
  if (KEYWORDS.auto_reply.some(k => s.includes(k) || b.includes(k))) return "autoreply";

  // 1. 退信检测
  if (KEYWORDS.bounce_subject.some(k => s.includes(k))) return "bounce";
  if (KEYWORDS.bounce_senders.some(k => f.includes(k))) return "bounce";
  if (/\b5\d{2}\b/.test(b)) return "bounce";
  if (KEYWORDS.bounce_body.some(k => b.includes(k))) return "bounce";
  if (KEYWORDS.bounce_left.some(k => b.includes(k))) return "bounce";

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

  // ponytail: 并行抓取所有账号
  const results = await Promise.allSettled(
    accounts.map(acc => imapFetchFn!(acc.id).then(
      r => ({ account: acc, result: r }),
    ))
  );

  for (const r of results) {
    if (r.status === "rejected") { Log.warn("inbox.fetch", "账号抓取异常"); continue; }
    const { account, result } = r.value;
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
            }
          }
        }
      saveDatabase();
    }
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
    getSqlJsDb().run(`
      DELETE FROM inbox_messages
      WHERE classification = 'bounce'
        AND id NOT IN (
          SELECT MIN(id) FROM inbox_messages
          WHERE classification = 'bounce'
          GROUP BY subject, from_email, received_at
        )
    `);
    const deleted = getSqlJsDb().getRowsModified();
    if (deleted > 0) {
      Log.info("inbox.cleanup", `退信去重删除 ${deleted} 封`);
      saveDatabase();
    }
  } catch (e) { Log.warn("inbox.cleanup", `退信去重失败: ${(e as Error).message}`); }

  // messageId 去重：相同 messageId 多行只保留最小 id（detectSent 并发导致的重复）
  try {
    getSqlJsDb().run(`
      DELETE FROM inbox_messages
      WHERE message_id IS NOT NULL AND message_id != ''
        AND id NOT IN (
          SELECT MIN(id) FROM inbox_messages
          WHERE message_id IS NOT NULL AND message_id != ''
          GROUP BY message_id
        )
    `);
    const deleted2 = getSqlJsDb().getRowsModified();
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

/** insert 后立即调用：把正文写入刚插入的邮件（用 last_insert_rowid 拿自增 id） */
export async function writeBodyForLastInsert(html: string): Promise<void> {
  if (!html) return;
  const res = getSqlJsDb().exec("SELECT last_insert_rowid() as id");
  const id = res[0]?.values?.[0]?.[0];
  if (typeof id === "number" && id > 0) await writeBodyFile(id, html);
}

// ── 获取邮件正文 ──

export async function getBody(id: number): Promise<Result<string>> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const row = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, id)).get();
  if (!row) return failResult("邮件不存在");
  // ① 正文已在磁盘文件 → 直接读（毫秒级，持久，重启后依然秒开）
  const file = bodyFilePath(id);
  if (fs.existsSync(file)) {
    try { return okResult(await fs.promises.readFile(file, "utf-8")); }
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

/** 一次性迁移：存量 raw_source 正文导出到文件 + 删除列（幂等，启动时调用） */
export async function migrateBodiesOut(): Promise<void> {
  const js = getSqlJsDb();
  const cols = (js.exec("PRAGMA table_info(inbox_messages)")[0]?.values || []).map(r => String(r[1]));
  if (!cols.includes("raw_source")) return; // 已迁移过
  const rows = js.exec("SELECT id, raw_source FROM inbox_messages WHERE raw_source IS NOT NULL AND raw_source != ''")[0]?.values || [];
  let n = 0;
  for (const r of rows) {
    const id = Number(r[0]);
    const html = String(r[1] || "");
    if (!id || !html) continue;
    try { await writeBodyFile(id, html); n++; }
    catch (err) { Log.error("inbox.migrate", `正文导出失败 id=${id}`, err instanceof Error ? err.stack : undefined); }
  }
  js.run("ALTER TABLE inbox_messages DROP COLUMN raw_source;");
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

  getDb().update(inboxMessages).set({
    classification,
    // 退信 → 同时标记关联联系人
    ...(classification === "bounce" && existing.matchedContactId
      ? { matchedContactId: existing.matchedContactId }
      : {}),
  }).where(eq(inboxMessages.id, id)).run();
  saveDatabase();

  // 回写联系人状态
  if (existing.matchedContactId) {
    if (classification === "bounce") markAsBounced(existing.matchedContactId);
    else if (classification === "autoreply") updateContactStatus(existing.matchedContactId, "autoreply");
  }

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

export function markRead(id: number): Result<void> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  getDb().update(inboxMessages).set({ isRead: 1 })
    .where(eq(inboxMessages.id, id)).run();
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

/** 一键删除所有退信匹配的联系人（不删邮件） */
export function deleteAllBounce(): Result<number> {
  // 查所有退信邮件匹配到的联系人（去重）
  const bounceMsgs = getDb().select({ matchedContactId: inboxMessages.matchedContactId })
    .from(inboxMessages)
    .where(eq(inboxMessages.classification, "bounce"))
    .all();
  const contactIds = [...new Set(
    bounceMsgs.map(m => m.matchedContactId).filter((x): x is number => x != null),
  )];
  // 级联删除这些联系人（收件箱邮件保留，仅解除关联）
  for (const cid of contactIds) deleteContactCascade(cid);
  saveDatabase();
  Log.info("inbox.deleteBounce", `已删除 ${contactIds.length} 个退信匹配的联系人`);
  return okResult(contactIds.length);
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
