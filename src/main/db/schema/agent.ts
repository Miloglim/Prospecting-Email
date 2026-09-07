import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Agent 会话（一个对话线程）。TEXT 主键用 crypto.randomUUID，与 IPC/前端 conversationId 对齐 */
export const agentConversations = sqliteTable("agent_conversations", {
  id:        text("id").primaryKey(),
  title:     text("title").notNull().default("新对话"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  /** 归档时间（null=未归档）：侧栏删除=移入归档；彻底删除只在设置页归档区 */
  archivedAt: text("archived_at"),
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

/** Agent 会话内的「工具事实」记忆：每次工具调用成功后抽一行（共 N 条 / 已导出 X / 已入队 Y…）。
 *  加载历史时注入最近若干条 —— 上一轮查过的数据下一轮不必重查（工具结果从不进消息历史）。 */
export const agentFacts = sqliteTable("agent_facts", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull(),
  toolName:       text("tool_name").notNull(),
  fact:           text("fact").notNull(),
  createdAt:      text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type AgentFactRow = typeof agentFacts.$inferSelect;

/**
 * 会话工作台（closed-loop working memory）：数据型工具把「决策相关的结构化结果」落这里，
 * 跨轮不丢、跨工具可程序化直取。取代 agent_facts 的瘦一行事实（见 docs/agent-closed-loop-spec.md）。
 *  · contextLine：回放进模型上下文的紧凑要点（1-3 行，含单位/口径），封顶 ~400 字；
 *  · payloadJson：供工具直取的完整结构化数据（JSON），封顶 ~8KB，超限按字段优先级裁剪（保条数）；
 *  · (conversationId, kind, refId) 为逻辑去重键：重读同一封邮件/同条件重查 = upsert 刷新而非堆叠。
 */
export const agentWorkingMemory = sqliteTable("agent_working_memory", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull(),
  kind:           text("kind").notNull(),      // email | rates | contacts | inbox | backcheck | draft
  refId:          text("ref_id").notNull(),    // 去重键：email=messageId，rates/contacts=查询指纹
  toolName:       text("tool_name").notNull(),
  contextLine:    text("context_line").notNull(),
  payloadJson:    text("payload_json").notNull(),
  createdAt:      text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:      text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type AgentWorkingMemoryRow = typeof agentWorkingMemory.$inferSelect;

/**
 * 首页「AI 建议行动」的每日批次（每天一批，读的时候按当天数据填槽）。
 * template 存的是带 {slot} 占位的模板而不是成品句子 —— 数字与人名每次显示时现填，
 * 昨天的「9 封未读」今天不会还挂在卡上；填不上的槽（值为 0/空）那条建议直接跳过。
 */
export const agentSuggestions = sqliteTable("agent_suggestions", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  day:       text("day").notNull(),          // 归属日（北京时间 YYYY-MM-DD）
  groupName: text("group_name").notNull(),  // 六个分区标题之一
  template:  text("template").notNull(),    // 带 {slot} 占位的建议文本
  source:    text("source").notNull(),      // ai（模型生成）| rule（本地兜底）
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type AgentSuggestionRow = typeof agentSuggestions.$inferSelect;

export type InsertAgentToolCallRow = typeof agentToolCalls.$inferInsert;
