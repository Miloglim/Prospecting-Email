import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, saveDatabase } from "../db";
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
