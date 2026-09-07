import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * 运价镜像表 — 公司电脑台账（board_server，局域网 HTTP）的本地归一化副本。
 * 同步方向单向：board_server /api/rates 分页拉取 → 归一化 → 本表全量刷新（只读镜像，不回写）；
 * 启动 5 秒后首拉 + 每 4 小时轮询。recordId 为源端主键（content_key），全量刷新按它去重。
 * pod_raw 入库时已剥掉台账网页粘连在目的港尾部的航线小字（如「… 地东」），航线信息归 lane。
 */
export const rateQuotes = sqliteTable("rate_quotes", {
  recordId:     text("record_id").primaryKey(),
  pol:          text("pol"),                    // 起运港（中文原文）
  podRaw:       text("pod_raw").notNull(),      // 目的港（可能是多港合并串，保留原文，匹配用 LIKE）
  lane:         text("lane"),                   // 航线：加勒比/南美东/墨西哥/南美西/中美洲/欧地…
  carrier:      text("carrier"),                // 船司：CMA/MSK/…
  container:    text("container"),              // 柜型（归一后：20GP/40GP/40HQ/NOR，组合价为 "40GP+40HQ"）
  containerRaw: text("container_raw"),          // 柜型（源端原文，便于回溯脏值映射）
  oceanUsd:     integer("ocean_usd"),           // 海运费 USD（源端为文本数字，解析失败为 null）
  validityRaw:  text("validity_raw"),           // 有效期船期原文（如 "9.1-9.7"）
  validFrom:    text("valid_from"),             // 解析产物 YYYY-MM-DD，解析失败 null
  validTo:      text("valid_to"),               // 解析产物 YYYY-MM-DD
  freeDays:     text("free_days"),              // 目免
  shortfallFee: text("shortfall_fee"),          // 亏舱费
  note:         text("note"),                   // 备注（附加费/航次等关键说明）
  sourceGroup:  text("source_group"),           // 来源群（溯源）
  sender:       text("sender"),                 // 发送人（溯源）
  msgTime:      text("msg_time"),               // 源消息时间（快照内时效基准）
  imageName:    text("image_name"),             // 运价表截图文件名（不存临时 URL）
  syncedAt:     text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type RateQuoteRow = typeof rateQuotes.$inferSelect;
export type InsertRateQuoteRow = typeof rateQuotes.$inferInsert;
