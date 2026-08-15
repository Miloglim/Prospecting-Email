import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
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
  matchedContactId:  integer("matched_contact_id"),
  isRead:            integer("is_read").notNull().default(0),
  receivedAt:        text("received_at").notNull(),
  createdAt:         text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type InboxMessageRow = typeof inboxMessages.$inferSelect;
export type InsertInboxMessageRow = typeof inboxMessages.$inferInsert;
