import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * 发信任务（Campaign）：一次批准、按计划自动跟进的完整生命周期。
 * 引擎不动（send.service 原样复用），本表只是队列的"策源"与"账本"。
 * 规范：docs/smart-send-spec.md
 */
export const sendCampaigns = sqliteTable("send_campaigns", {
  id:             text("id").primaryKey(),                     // nanoid
  name:           text("name").notNull(),                      // 「巴西冷客户·4 触点」
  status:         text("status").notNull().default("running"), // draft|running|paused|done|stopped
  /** 计划内 touch 自动开始发送；0=每轮入队待发送中心手动开始 */
  autoSend:       integer("auto_send").notNull().default(1),
  /** 创建时的筛选条件快照（回显/审计：这个任务当初圈的是谁） */
  targetFilterJson: text("target_filter_json").notNull().default("{}"),
  /** 触点计划 [{round, stage:"initial|followup1|…", templateId?:number, mode?:"fixed|userTpl|system", content?, delayDays}] */
  touchPlanJson:  text("touch_plan_json").notNull(),
  /** 创建入口：ui=发送中心向导 / agent=AI 对话编排（默认，旧数据兼容） */
  createdBy:      text("created_by").notNull().default("agent"),
  /** 发信账号策略：rotate=健康账号智能轮换（默认） / fixed=仅用指定账号 */
  accountPolicy:  text("account_policy").notNull().default("rotate"),
  /** accountPolicy=fixed 时的账号 id 列表（JSON 数组） */
  accountIdsJson: text("account_ids_json"),
  /** 任务级调度覆盖（JSON：windowStartHour/windowEndHour/dailyGroupCap）；空=继承全局 */
  scheduleJson:   text("schedule_json"),
  /** 发送方式：individual=每个联系人单独一封（收件人走 To，像人工手发，默认）/ bcc=同公司合并一封（BCC 互不可见） */
  sendMode:       text("send_mode").notNull().default("individual"),
  createdAt:      text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:      text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type SendCampaignRow = typeof sendCampaigns.$inferSelect;

/**
 * 任务名单（创建时定格，所见即所发；事后新入库的人不自动混入）。
 * status: pending(待发) | queued(已入队未发) | sent(计划走完) | replied | bounced
 *       | unsubscribed | skipped(止损/资格不符跳过)
 */
export const sendCampaignTargets = sqliteTable("send_campaign_targets", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  campaignId:  text("campaign_id").notNull(),
  contactId:   integer("contact_id").notNull(),
  status:      text("status").notNull().default("pending"),
  round:       integer("round").notNull().default(0),   // 已完成的触点轮次
  nextTouchAt: text("next_touch_at"),                   // 下一触点到期时间（ISO）；空=无待发
  lastSentAt:  text("last_sent_at"),
  updatedAt:   text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  convIdx: index("idx_sct_campaign_status").on(t.campaignId, t.status),
  dueIdx: index("idx_sct_status_next").on(t.status, t.nextTouchAt),
  uniq: index("idx_sct_campaign_contact").on(t.campaignId, t.contactId),
}));

export type SendCampaignTargetRow = typeof sendCampaignTargets.$inferSelect;
