import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { emailAccounts } from "./accounts";

export const inboxMessages = sqliteTable("inbox_messages", {
  id:                integer("id").primaryKey({ autoIncrement: true }),
  accountId:         integer("account_id").references(() => emailAccounts.id).notNull(),
  messageId:         text("message_id"),
  fromEmail:         text("from_email").notNull(),
  fromName:          text("from_name"),
  subject:           text("subject"),
  bodyPreview:       text("body_preview"),
  classification:    text("classification"),
  /** 意图（仅 replied/other 相关）：price_inquiry | schedule_request | cooperation | follow_up | other；null=未识别 */
  intent:            text("intent"),
  to:                text("to"),
  cc:                text("cc"),
  myRole:            text("my_role"),
  matchedContactId:  integer("matched_contact_id"),
  relatedContactIds: text("related_contact_ids"),
  isRead:            integer("is_read").notNull().default(0),
  receivedAt:        text("received_at").notNull(),
  createdAt:         text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type InboxMessageRow = typeof inboxMessages.$inferSelect;
export type InsertInboxMessageRow = typeof inboxMessages.$inferInsert;

/**
 * 退信 ↔ 被退联系人（多对多，规范：docs/bounce-multi-match-spec.md）。
 * 一封群发退信可通知多个失败收件人，inbox_messages.matched_contact_id 单列只装得下第一个（留作兼容旧读取），
 * 计数 / 一键删除 / 详情「被退联系人」栏全部以这张表为唯一数据源。
 */
export const inboxBounceMatches = sqliteTable("inbox_bounce_matches", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  messageId: integer("message_id").notNull(),
  contactId: integer("contact_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({ byMsgContact: uniqueIndex("inbox_bounce_matches_msg_contact").on(t.messageId, t.contactId) }));
