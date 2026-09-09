import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * 发信受阻事件（规范 docs/sender-block-circuit-spec.md §3）：
 * 服务商把我们的内容/发信频率拦下（反垃圾/限流/信誉黑名单）所产生的通知，记在**发信账号**头上，
 * 不记成收件人退信。message_id 唯一 = 幂等键（同一封通知被点开多次也只记一次）。
 */
export const sendBlockEvents = sqliteTable("send_block_events", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  accountId:  integer("account_id").notNull(),
  messageId:  text("message_id").notNull().unique(), // IMAP message_id（无则回退 inbox 行 id 字符串）
  code:       text("code").notNull(),               // 命中的判据族（ESO_LOCAL_SPAM / rate_limit / …）
  excerpt:    text("excerpt"),                      // 退信原因原文摘录（呈现与审计用）
  occurredAt: text("occurred_at").notNull(),        // 通知时间（滚动窗口按它算）
  createdAt:  text("created_at").notNull(),
});

export type SendBlockEventRow = typeof sendBlockEvents.$inferSelect;
export type InsertSendBlockEventRow = typeof sendBlockEvents.$inferInsert;
