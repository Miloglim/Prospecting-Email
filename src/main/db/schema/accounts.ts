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
  isActive:          integer("is_active").notNull().default(1),
  createdAt:         text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
export type InsertEmailAccountRow = typeof emailAccounts.$inferInsert;
