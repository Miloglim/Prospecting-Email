import { beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import * as SendService from "../../src/main/services/send.service";

// ═══════════════════════════════════════════════════════════════════
// 选人页轻量统计（getPickerStats）：两条聚合 SQL 替代旧的
// getTimeBuckets / getSendTimeBuckets 全表 JS 分桶。
// 性能优化的红线是语义不能漂 —— 这里同一份种子数据双跑新旧实现，
// 断言 never 集合与「最近发送档位」映射与旧桶完全等价。
// ═══════════════════════════════════════════════════════════════════

const h = vi.hoisted(() => ({ db: null as unknown, cfg: null as unknown }));

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => { /* 内存库无需落盘 */ },
  getRawDb: () => null,
}));

vi.mock("../../src/main/config", async (orig) => {
  const actual = await orig<typeof import("../../src/main/config")>();
  return {
    DEFAULT_SCHEDULE: actual.DEFAULT_SCHEDULE,
    loadConfig: () => h.cfg,
    saveConfig: (c: unknown) => { h.cfg = c; },
    APP_ROOT: "/tmp/sandbox",
    DB_PATH: "/tmp/sandbox/db",
    getResourcesRoot: () => "/tmp/sandbox/assets",
  };
});

vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock("../../src/main/services/inbox.service", () => ({
  writeBodyForLastInsert: async () => { /* 沙箱不落 .eml */ },
}));

let raw: SqlJsDatabase;
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

beforeEach(async () => {
  const SQL = await initSqlJs();
  raw = new SQL.Database();
  raw.exec(BASE_SCHEMA_SQL);
  h.db = drizzle(raw, { schema });

  // 种子（id 按插入顺序 1..6）：
  // 1 空状态、无任何交互          → never
  // 2 NULL 状态、只有 note 交互   → never（NOT EXISTS 只看 type='sent'）
  // 3 空状态、0.5 天前 sent       → lastSent「今天」
  // 4 reached、2 天前 sent        → 两边都排除（旧实现 continue reached）
  // 5 bounced、3 天前 sent        → lastSent「3-5天」（旧实现只排除 reached）
  // 6 replied、15 天前 sent       → lastSent「更早」
  const contactsSeed: Array<[string, string | null]> = [
    ["a@x.com", ""],
    ["b@x.com", null],
    ["c@x.com", ""],
    ["d@x.com", "reached"],
    ["e@x.com", "bounced"],
    ["f@x.com", "replied"],
  ];
  for (const [email, status] of contactsSeed) {
    raw.run("INSERT INTO contacts (email, status) VALUES (?, ?)", [email, status]);
  }
  const interactionsSeed: Array<[number, string, number]> = [
    [2, "note", 1], [3, "sent", 0.5], [4, "sent", 2], [5, "sent", 3], [6, "sent", 15],
  ];
  for (const [contactId, type, daysAgo] of interactionsSeed) {
    raw.run(
      "INSERT INTO interactions (contact_id, type, direction, created_at) VALUES (?, ?, 'outbound', ?)",
      [contactId, type, iso(daysAgo)],
    );
  }
});

describe("getPickerStats 与旧桶实现语义等价", () => {
  it("never 集合 = 旧 getTimeBuckets 的 never 桶", () => {
    const stats = SendService.getPickerStats();
    expect(stats.success).toBe(true);
    const s = stats.data!;

    const legacyNever = SendService.getTimeBuckets().data!.find(b => b.key === "never")!;
    expect(new Set(s.neverIds)).toEqual(new Set(legacyNever.contacts.map(c => c.id)));
    expect([...s.neverIds].sort()).toEqual([1, 2]);
  });

  it("最近发送档位集合 = 旧 getSendTimeBuckets 展开后的 id 集（排除 reached）", () => {
    const stats = SendService.getPickerStats();
    const s = stats.data!;

    const legacyIds = SendService.getSendTimeBuckets().data!
      .flatMap(b => b.contacts.map(c => c.id));
    expect(new Set(s.lastSent.map(e => e.id))).toEqual(new Set(legacyIds));

    const m = new Map(s.lastSent.map(e => [e.id, e.label] as const));
    expect(m.get(3)).toBe("今天");
    expect(m.get(5)).toBe("3-5天");
    expect(m.get(6)).toBe("更早");
    expect(m.has(4)).toBe(false);
  });
});

// ── 规范 §3：选人器「已在任务」灰显的数据口径 ──────────────────────────────
describe("getPickerStats().inCampaign", () => {
  const putCampaign = (id: string, status: string) => raw.run(
    "INSERT INTO send_campaigns (id, name, status, touch_plan_json) VALUES (?, ?, ?, '[]')",
    [id, `任务-${id}`, status],
  );
  const putTarget = (campaignId: string, contactId: number, status: string) => raw.run(
    "INSERT INTO send_campaign_targets (campaign_id, contact_id, status) VALUES (?, ?, ?)",
    [campaignId, contactId, status],
  );

  it("未完结任务的待发/已入队触点算「已在任务」；done 任务与终态触点都不算", () => {
    putCampaign("run1", "running"); putTarget("run1", 1, "pending");
    putCampaign("draft1", "draft"); putTarget("draft1", 2, "queued");
    putCampaign("done1", "done");   putTarget("done1", 3, "pending");     // 完结任务不挡再开发
    putCampaign("run2", "running"); putTarget("run2", 4, "sent");         // 触点已终态
    const s = SendService.getPickerStats().data!;
    expect(s.inCampaign.map(e => e.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(s.inCampaign.find(e => e.id === 1)?.campaignName).toBe("任务-run1");
  });

  it("同一人挂在两个未完结任务里只回一条（取先查到的那个任务名）", () => {
    putCampaign("a1", "running"); putTarget("a1", 5, "pending");
    putCampaign("a2", "paused");  putTarget("a2", 5, "pending");
    const s = SendService.getPickerStats().data!;
    expect(s.inCampaign.filter(e => e.id === 5)).toHaveLength(1);
  });
});
