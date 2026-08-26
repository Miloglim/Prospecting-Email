import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sendQueue = sqliteTable("send_queue", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  companyName: text("company_name"),
  companyId: integer("company_id"),
  recipients: text("recipients").notNull(), // JSON array
  accountId: integer("account_id").notNull(),
  accountEmail: text("account_email"),
  subject: text("subject"),
  tplBody: text("tpl_body"),
  contactVars: text("contact_vars"), // JSON
  cc: text("cc"),                    // 抄送地址，逗号分隔（同事存档用；收件人仍走 BCC）
  status: text("status").default("pending").notNull(), // pending | sending | sent | failed
  error: text("error"),
  sentAt: text("sent_at"),
  createdAt: text("created_at").default("CURRENT_TIMESTAMP").notNull(),
});

export type SendQueueRow = typeof sendQueue.$inferSelect;
export type InsertSendQueueRow = typeof sendQueue.$inferInsert;
