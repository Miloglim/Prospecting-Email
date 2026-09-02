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

/** Agent 工具调用留痕（harness 审计层）：每次工具执行落一行，含副作用分级与审批结论 */
export const agentToolCalls = sqliteTable("agent_tool_calls", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull(),
  toolName:       text("tool_name").notNull(),
  sideEffect:     text("side_effect").notNull(),  // read | write
  argsJson:       text("args_json"),
  resultJson:     text("result_json"),
  approval:       text("approval").notNull(),     // auto | approved | rejected
  error:          text("error"),
  createdAt:      text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type AgentToolCallRow = typeof agentToolCalls.$inferSelect;
/** 能力缺口台账（开发期需求探针）：agent 碰到工具清单外的诉求时登记；同义 wanted 合并累加 hits，按被抱怨次数定优先级 */
export const agentGaps = sqliteTable("agent_gaps", {
  id:         integer("id").primaryKey({ autoIncrement: true }),
  wanted:     text("wanted").notNull(),        // 想做什么做不到
  scene:      text("scene"),                   // 当时在办的事
  workaround: text("workaround"),              // 模型给的绕行办法
  hits:       integer("hits").notNull().default(1),
  createdAt:  text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type AgentGapRow = typeof agentGaps.$inferSelect;

export type InsertAgentToolCallRow = typeof agentToolCalls.$inferInsert;
