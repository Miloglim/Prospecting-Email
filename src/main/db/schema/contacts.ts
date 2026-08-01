import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// 沿用旧 PE 设计：contacts 表是核心数据源，CRM 阶段/状态/提醒/偏好都在此表
export const contacts = sqliteTable("contacts", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  email:        text("email").notNull().unique(),
  companyId:    integer("company_id"),
  firstName:    text("first_name"),
  lastName:     text("last_name"),
  title:        text("title"),
  phone:        text("phone"),
  linkedinUrl:  text("linkedin"),
  country:      text("country"),
  clientType:   text("client_type").default("unlabeled"),
  // 发送阶段（cold/f1/f2/f3/f4）
  stage:        text("stage").default("cold"),
  // 联系人状态（空 / reached / replied / bounced / autoreply）
  status:       text("status").default(""),
  // CRM 管线标签 — JSON 数组: ["reaching"] / ["quoting"] 等
  tags:         text("tags").default("[]"),
  // 扩展数据 — JSON: { crmReminder, crmPreferences, relations }
  extra:        text("extra").default("{}"),
  isBounced:    integer("is_bounced").default(0),
  bounceReason: text("bounce_reason"),
  lastSentAt:   text("last_sent_at"),
  lastSentAcct: text("last_sent_acct"),
  assignee:     text("assignee").default(""),
  followupNote: text("followup_note"),
  source:       text("source").default("manual"),
  sourceDetail: text("source_detail"),
  createdAt:    text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:    text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type ContactRow = typeof contacts.$inferSelect;
export type InsertContactRow = typeof contacts.$inferInsert;
