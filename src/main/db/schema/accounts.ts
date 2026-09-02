import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const emailAccounts = sqliteTable("email_accounts", {
  id:                integer("id").primaryKey({ autoIncrement: true }),
  email:             text("email").notNull().unique(),
  provider:          text("provider").notNull().default("smtp"),
  smtpHost:          text("smtp_host"),
  smtpPort:          integer("smtp_port"),
  imapHost:          text("imap_host"),
  imapPort:          integer("imap_port"),
  encryptedPass:     text("encrypted_pass").notNull(),
  displayName:       text("display_name"),
  signature:         text("signature"),
  consecutiveFails:  integer("consecutive_fails").notNull().default(0),
  circuitOpenAt:     text("circuit_open_at"),
  circuitResetAfter: text("circuit_reset_after"),
  /** 收信健康度（与发信熔断分开计数）：最近一次抓取失败原因 / 尝试时间 / 连续失败次数 */
  lastFetchError:    text("last_fetch_error"),
  lastFetchAt:       text("last_fetch_at"),
  fetchFailCount:    integer("fetch_fail_count").notNull().default(0),
  isActive:          integer("is_active").notNull().default(1),
  createdAt:         text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
export type InsertEmailAccountRow = typeof emailAccounts.$inferInsert;
