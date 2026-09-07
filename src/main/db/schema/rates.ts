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

/**
 * 舱位镜像表 — 同一台账的 space 表（`/api/space`）本地副本，与运价同批全量刷新。
 * 舱位是群内动态（现舱/加班船/约舱/售罄/舱位紧张/截关截单/撤载改期/箱子动态），
 * 按消息时间看时效，不设 valid_from/to；pod 允许为空（群里常只报航线不报港）。
 * status 字面量与运价表不同：本表是「当前有效 / 已被覆盖」，运价表是「当前生效 / 已被覆盖」。
 */
export const spaceQuotes = sqliteTable("space_records", {
  recordId:     text("record_id").primaryKey(),
  pol:          text("pol"),
  podRaw:       text("pod_raw"),                // 目的港原文（可空；已剥尾部航线小字）
  lane:         text("lane"),                   // 航线
  carrier:      text("carrier"),
  container:    text("container"),              // 柜型（归一后）
  containerRaw: text("container_raw"),          // 箱型箱量描述原文（如 "2个40HQ"）
  boxQty:       text("box_qty"),
  spaceType:    text("space_type"),             // 现舱/加班船/约舱/售罄/舱位紧张/截关截单/撤载改期/箱子动态
  vessel:       text("vessel"),                 // 船名航次
  etd:          text("etd"),
  cutoffRaw:    text("cutoff_raw"),             // 截关原文
  priceUsd:     text("price_usd"),              // 源端就是文本（可能 "6815/7015"），原样保留不强转
  note:         text("note"),
  sourceGroup:  text("source_group"),
  sender:       text("sender"),
  msgTime:      text("msg_time"),               // 时效基准（格式不统一，只做倒序与展示）
  imageName:    text("image_name"),
  status:       text("status"),
  syncedAt:     text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type SpaceQuoteRow = typeof spaceQuotes.$inferSelect;
export type InsertSpaceQuoteRow = typeof spaceQuotes.$inferInsert;
