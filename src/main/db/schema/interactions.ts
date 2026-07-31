import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts";
import { emailAccounts } from "./accounts";

export const interactions = sqliteTable("interactions", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  contactId:   integer("contact_id").references(() => contacts.id).notNull(),
  type:        text("type").notNull(),
  direction:   text("direction").notNull(),
  channel:     text("channel").notNull().default("email"),
  subject:     text("subject"),
  bodyPreview: text("body_preview"),
  messageId:   text("message_id"),
  accountId:   integer("account_id").references(() => emailAccounts.id),
  metadata:    text("metadata"),
  createdAt:   text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type InteractionRow = typeof interactions.$inferSelect;
export type InsertInteractionRow = typeof interactions.$inferInsert;
