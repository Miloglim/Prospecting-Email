import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Agent 会话（一个对话线程）。TEXT 主键用 crypto.randomUUID，与 IPC/前端 conversationId 对齐 */
export const agentConversations = sqliteTable("agent_conversations", {
  id:        text("id").primaryKey(),
  title:     text("title").notNull().default("新对话"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Agent 消息（仅存 user/assistant 正文；system 提示词不落库，运行时拼接） */
export const agentMessages = sqliteTable("agent_messages", {
  id:              integer("id").primaryKey({ autoIncrement: true }),
  conversationId:  text("conversation_id").notNull().references(() => agentConversations.id),
  role:            text("role").notNull(),   // user | assistant
  content:         text("content").notNull(),
  createdAt:       text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type AgentConversationRow = typeof agentConversations.$inferSelect;
export type AgentMessageRow = typeof agentMessages.$inferSelect;
