import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, getRawDb, saveDatabase } from "../db";
import { inboxMessages, inboxBounceMatches } from "../db/schema/inbox";
import { interactions } from "../db/schema/interactions";
import { Log } from "../logger";

/**
 * 新建/改邮箱后立即回填「存量邮件 ↔ 该联系人」的关联。
 * 治的实测问题：先收到询价信、后把发件人加进联系人库，客户详情的邮件往来与跟进记录
 * 要等重启才出来——matched_contact_id 只在邮件到达那一刻写，原先补 link 的唯一地方
 * 是启动迁移 v4.1（db/index.ts）。本函数＝那段迁移的即时版，口径逐字一致：
 *   · 只认领 matched_contact_id 为空的行（绝不抢别人已关联的）；
 *   · replied/bounce/autoreply 行补跟进事件（同 message 已有同型事件则跳过）；
 *   · 退信行补 inbox_bounce_matches（防重）。
 * 幂等可反复调；返回本次新认领的邮件数（0 = 没有要补的）。
 * 单独成模块是因为 contact.service 要调它，而 inbox.service 已依赖 contact.service，
 * 放回去就成环。
 */
export function linkInboxForContact(contactId: number, email: string): number {
  const needle = (email || "").toLowerCase().trim();
  if (!Number.isInteger(contactId) || contactId <= 0 || !needle) return 0;
  try {
    const db = getDb();
    // 先数后改：.changes 在 sql.js 驱动下不可靠（生产 better-sqlite3 才有），
    // 且拿到目标 id 列表后，认领与事件补齐都按同一批走，语义更精确
    const targets = db.select({ id: inboxMessages.id }).from(inboxMessages)
      .where(and(isNull(inboxMessages.matchedContactId), sql`lower(${inboxMessages.fromEmail}) = ${needle}`))
      .all();
    if (!targets.length) return 0;
    db.update(inboxMessages).set({ matchedContactId: contactId })
      .where(inArray(inboxMessages.id, targets.map(t => t.id))).run();
    const linked = targets.length;
    const fresh = db.select({
      id: inboxMessages.id, classification: inboxMessages.classification, subject: inboxMessages.subject,
      bodyPreview: inboxMessages.bodyPreview, messageId: inboxMessages.messageId,
      accountId: inboxMessages.accountId, receivedAt: inboxMessages.receivedAt,
    }).from(inboxMessages).where(and(
      eq(inboxMessages.matchedContactId, contactId),
      inArray(inboxMessages.classification, ["bounce", "replied", "autoreply"]),
      sql`NOT EXISTS (SELECT 1 FROM interactions it WHERE it.contact_id = ${inboxMessages.matchedContactId} AND it.message_id IS ${inboxMessages.messageId} AND it.type IN ('bounced','replied','autoreply'))`,
    )).all();
    const typeMap: Record<string, "bounced" | "replied" | "autoreply"> =
      { bounce: "bounced", replied: "replied", autoreply: "autoreply" };
    for (const m of fresh) {
      const type = typeMap[m.classification || ""];
      if (!type) continue;
      db.insert(interactions).values({
        contactId, type, direction: "inbound", channel: "email",
        subject: m.subject, bodyPreview: m.bodyPreview, messageId: m.messageId,
        accountId: m.accountId, createdAt: m.receivedAt,
      }).run();
    }
    const bounceIds = fresh.filter(m => m.classification === "bounce").map(m => m.id);
    if (bounceIds.length) {
      const already = new Set(db.select({ messageId: inboxBounceMatches.messageId }).from(inboxBounceMatches)
        .where(eq(inboxBounceMatches.contactId, contactId)).all().map(r => r.messageId));
      for (const mid of bounceIds) if (!already.has(mid)) {
        db.insert(inboxBounceMatches).values({ messageId: mid, contactId }).run();
      }
    }
    saveDatabase();
    Log.debug("inbox.link", `联系人 #${contactId} 即时回填：新认领邮件 ${linked} 封、补跟进事件 ${fresh.length} 条`);
    return linked;
  } catch (err) {
    Log.warn("inbox.link", `存量邮件关联回填失败 contact=${contactId}：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** 批量版回填 —— 语义与 linkInboxForContact 逐字一致（只认领未认领、事件/退信匹配防重），
 *  专供批量导入用：单联系人版每个邮箱都要全表扫一遍收件箱，1500+ 导入 = 1500 次全表扫描
 *  同步阻塞主进程（导入后整程序冻死的根因）。这里一次扫描认领全部，单事务单 checkpoint。 */
export function linkInboxForContacts(entries: Array<{ contactId: number; email: string }>): number {
  const valid = entries.filter(e => Number.isInteger(e.contactId) && e.contactId > 0 && (e.email || "").trim());
  if (!valid.length) return 0;
  const emailToId = new Map<string, number>();
  for (const e of valid) emailToId.set(e.email.toLowerCase().trim(), e.contactId);

  try {
    const db = getDb();
    let claimed = 0;
    let events = 0;

    getRawDb().transaction(() => {
      // ① 一次扫描认领：所有待回填邮箱的未认领邮件（部分索引 idx_inbox_unmatched_from 直接命中）
      const needles = [...emailToId.keys()];
      const targets = db.select({ id: inboxMessages.id, fromEmail: inboxMessages.fromEmail }).from(inboxMessages)
        .where(and(isNull(inboxMessages.matchedContactId), inArray(sql`lower(${inboxMessages.fromEmail})`, needles)))
        .all();
      if (!targets.length) return;

      const byId = new Map<number, number>();   // messageId → contactId
      for (const t of targets) {
        const cid = emailToId.get((t.fromEmail || "").toLowerCase().trim());
        if (cid) byId.set(t.id, cid);
      }
      for (const [cid, ids] of groupIds(byId)) {
        db.update(inboxMessages).set({ matchedContactId: cid })
          .where(inArray(inboxMessages.id, ids)).run();
        claimed += ids.length;
      }
      if (!claimed) return;

      // ② 补跟进事件：与单联系人版同一条 NOT EXISTS 防重口径，一次性查回所有新认领的 replied/bounce/autoreply
      const contactIds = [...new Set(byId.values())];
      const fresh = db.select({
        id: inboxMessages.id, contactId: inboxMessages.matchedContactId,
        classification: inboxMessages.classification, subject: inboxMessages.subject,
        bodyPreview: inboxMessages.bodyPreview, messageId: inboxMessages.messageId,
        accountId: inboxMessages.accountId, receivedAt: inboxMessages.receivedAt,
      }).from(inboxMessages).where(and(
        inArray(inboxMessages.matchedContactId, contactIds),
        inArray(inboxMessages.classification, ["bounce", "replied", "autoreply"]),
        sql`NOT EXISTS (SELECT 1 FROM interactions it WHERE it.contact_id = ${inboxMessages.matchedContactId} AND it.message_id IS ${inboxMessages.messageId} AND it.type IN ('bounced','replied','autoreply'))`,
      )).all();
      for (const m of fresh) {
        const type = ({ bounce: "bounced", replied: "replied", autoreply: "autoreply" } as Record<string, "bounced" | "replied" | "autoreply">)[m.classification || ""];
        if (!type || !m.contactId) continue;
        db.insert(interactions).values({
          contactId: m.contactId, type, direction: "inbound", channel: "email",
          subject: m.subject, bodyPreview: m.bodyPreview, messageId: m.messageId,
          accountId: m.accountId, createdAt: m.receivedAt,
        }).run();
        events++;
      }

      // ③ 退信匹配防重：与单联系人版同口径 —— inbox_bounce_matches.message_id 是 inbox_messages 的数字主键
      const bounceRows = fresh.filter(m => m.classification === "bounce" && m.contactId);
      if (bounceRows.length) {
        const existing = new Map<number, Set<number>>();
        for (const r of db.select({ contactId: inboxBounceMatches.contactId, messageId: inboxBounceMatches.messageId })
          .from(inboxBounceMatches).where(inArray(inboxBounceMatches.contactId, contactIds)).all()) {
          const s = existing.get(r.contactId) ?? new Set<number>();
          s.add(r.messageId);
          existing.set(r.contactId, s);
        }
        for (const m of bounceRows) {
          const have = existing.get(m.contactId!) ?? new Set<number>();
          if (have.has(m.id)) continue;
          db.insert(inboxBounceMatches).values({ messageId: m.id, contactId: m.contactId! }).run();
          have.add(m.id);
          existing.set(m.contactId!, have);
        }
      }
    })();

    if (claimed > 0) saveDatabase();
    Log.debug("inbox.link", `批量回填 ${valid.length} 位联系人：新认领邮件 ${claimed} 封、补跟进事件 ${events} 条`);
    return claimed;
  } catch (err) {
    Log.warn("inbox.link", `批量存量邮件关联回填失败（${valid.length} 位）：${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

function groupIds(byId: Map<number, number>): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  for (const [mid, cid] of byId) {
    const arr = grouped.get(cid) ?? [];
    arr.push(mid);
    grouped.set(cid, arr);
  }
  return grouped;
}
