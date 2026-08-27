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
  tplName: text("tpl_name"),         // 该组采用的模板名（卡片展示；句库/即时/动态为来源标签）
  country: text("country"),           // 公司国家（卡片标签；公司缺失时回落首联系人）
  language: text("language"),         // 语言（卡片标签；取首联系人，与开发信语言一致）
  cc: text("cc"),                    // 抄送地址，逗号分隔（同事存档用；收件人仍走 BCC）
  status: text("status").default("pending").notNull(), // pending | sending | sent | failed
  error: text("error"),
  sentAt: text("sent_at"),
  createdAt: text("created_at").default("CURRENT_TIMESTAMP").notNull(),
});

export type SendQueueRow = typeof sendQueue.$inferSelect;
export type InsertSendQueueRow = typeof sendQueue.$inferInsert;
