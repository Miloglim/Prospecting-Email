import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════
// 发信任务 Phase A（docs/smart-send-spec.md）：资格硬闸、扫描入队、
// 触点推进、回复/退订/bounce 止损、OOO 顺延、跨任务冷却、终态收尾。
// 队列入口经 setCampaignQueueFn 注入假件；buildDynamicQueue 打桩
// （变量渲染正确性归 send.service 自己的测试）。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/services/send.service", () => ({
  buildDynamicQueue: vi.fn((contactIds: number[], subject: string, body: string) => ({
    success: true as const,
    data: contactIds.map(cid => ({
      id: `it-${cid}`, companyName: "ACME", companyId: 1,
      recipients: [{ contactId: cid, email: `${cid}@x.com`, name: `C${cid}` }],
      accountId: 1, subject, tplBody: body, contactVars: {}, status: "pending" as const,
    })),
  })),
}));

const DDL = `
CREATE TABLE contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE, company_id integer,
  first_name text, last_name text, title text, phone text, linkedin text, country text,
  client_type text, language text,
  stage text DEFAULT 'cold', status text DEFAULT '', tags text, extra text DEFAULT '{}',
  assignee text DEFAULT '', source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL, language text NOT NULL,
  subject text NOT NULL, body text NOT NULL, category text, stage text,
  version integer DEFAULT 1 NOT NULL, is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE send_campaigns (
  id text PRIMARY KEY NOT NULL, name text NOT NULL, status text DEFAULT 'running' NOT NULL,
  auto_send integer DEFAULT 1 NOT NULL, target_filter_json text DEFAULT '{}' NOT NULL,
  touch_plan_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE send_campaign_targets (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, campaign_id text NOT NULL, contact_id integer NOT NULL,
  status text DEFAULT 'pending' NOT NULL, round integer DEFAULT 0 NOT NULL, next_touch_at text,
  last_sent_at text, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAheadIso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function freshDb(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(DDL);
  h.db = drizzle(raw, { schema });
  h.db.insert(schema.contacts).values([
    { id: 1, email: "a@x.com", firstName: "A", status: "", stage: "cold", language: "EN" },        // 合格
    { id: 2, email: "b@x.com", firstName: "B", status: "replied", stage: "cold", language: "EN" }, // 已回复 → 闸
    { id: 3, email: "c@x.com", firstName: "C", status: "reached", stage: "cold", language: "EN" }, // 已触达 → 闸
  ] as never).run();
  h.db.insert(schema.templates).values([
    { name: "F1 模板", language: "EN", subject: "Hi {{firstName}}", body: "followup one for {{company}}", stage: "followup1" },
    { name: "首信模板", language: "EN", subject: "Hello {{firstName}}", body: "first touch {{company}}", stage: "initial" },
  ]).run();
}

const campaign = await import("../../src/main/services/campaign.service");
type Enqueued = { items: unknown[]; autoStart: boolean };
let enqueued: Enqueued[] = [];

/** 建一个 2 触点任务（首信 initial + 5 天后 followup1），返回 campaignId */
function seedCampaign(contactIds: number[], autoSend = true): string {
  const r = campaign.createCampaign({
    name: "测试任务", contactIds, autoSend,
    touches: [{ stage: "initial", delayDays: 0 }, { stage: "followup1", delayDays: 5 }],
  });
  if (!r.success) throw new Error(r.error);
  return r.data.id;
}

describe("createCampaign（资格硬闸：已回复/已触达不入队）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    enqueued = [];
    campaign.setCampaignQueueFn(async (items, autoStart) => { enqueued.push({ items, autoStart }); return { success: true, data: { batchId: "b1" } }; });
  });

  it("已回复/已触达被排除且如实计数；只有合格者进名单", () => {
    const r = campaign.createCampaign({
      name: "t", contactIds: [1, 2, 3, 999], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ eligible: 1, excluded: 3 });   // 2 号闸 + 3 号闸 + 999 不在库
    const targets = h.db!.select().from(schema.sendCampaignTargets).all();
    expect(targets.map(t => t.contactId)).toEqual([1]);
  });

  it("全部不合格 → 拒建并说明，不落任何行", () => {
    const r = campaign.createCampaign({
      name: "t", contactIds: [2, 3], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(r.success).toBe(false);
    expect(h.db!.select().from(schema.sendCampaigns).all()).toHaveLength(0);
  });
});

describe("scanDueCampaigns（到期触点 → 入队，引擎侧硬闸）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    enqueued = [];
    campaign.setCampaignQueueFn(async (items, autoStart) => { enqueued.push({ items, autoStart }); return { success: true, data: { batchId: "b1" } }; });
  });

  it("到期 pending → 组队入队并标 queued；autoSend 透传", async () => {
    const cid = seedCampaign([1], true);
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.autoStart).toBe(true);
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("queued");
  });

  it("autoSend=false 透传（入队待人点开始）", async () => {
    seedCampaign([1], false);
    await campaign.scanDueCampaigns();
    expect(enqueued[0]!.autoStart).toBe(false);
  });

  it("无启用模板 → 程序预设句库兜底组装，触点照常入队", async () => {
    const cid = seedCampaign([1], true);
    h.db!.delete(schema.templates).run();          // 素材库空：initial/followup1 都没有用户模板
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(1);              // assembleEmail 句库兜底，不再因缺模板顺延
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("queued");
  });

  it("引擎硬闸：目标联系人已变 replied → 标 skipped，绝不入队", async () => {
    const cid = seedCampaign([1], true);
    h.db!.update(schema.contacts).set({ status: "replied" }).where(eq(schema.contacts.id, 1)).run();
    await campaign.scanDueCampaigns();
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("skipped");
    expect(enqueued).toHaveLength(0);
  });

  it("跨任务冷却：联系人已有 queued 触点 → 本轮跳过顺延，不重复入队", async () => {
    seedCampaign([1], true);                                   // 任务 A
    const cidB = seedCampaign([1], true);                      // 任务 B 同一人
    await campaign.scanDueCampaigns();                         // A、B 同轮扫描：A 先入队，B 撞冷却
    const tB = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cidB)).get()!;
    expect(tB.status).toBe("pending");                          // 顺延未入队
    expect(new Date(tB.nextTouchAt!).getTime()).toBeGreaterThan(new Date(daysAheadIso(0.5)).getTime()); // 推到了明天之后
    const totalItems = enqueued.reduce((n, e) => n + e.items.length, 0);
    expect(totalItems).toBe(1);                                 // 同一人只入队一次
  });
});

describe("推进与止损（onCampaignSendSent / onContactSignal）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    enqueued = [];
    campaign.setCampaignQueueFn(async (items, autoStart) => { enqueued.push({ items, autoStart }); return { success: true, data: { batchId: "b1" } }; });
  });

  it("真实发出 → round 推进、nextTouchAt=+5d；计划走完 → sent 且任务 done", async () => {
    const cid = seedCampaign([1], true);
    await campaign.scanDueCampaigns();                          // 首信入队
    campaign.onCampaignSendSent(1);                             // 首信发出
    let t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.round).toBe(1);
    expect(t.status).toBe("pending");
    expect(new Date(t.nextTouchAt!).getTime()).toBeGreaterThan(new Date(daysAheadIso(4.9)).getTime());  // +5d
    // 5 天后到期 → 二触入队 → 发出 → 计划走完
    h.db!.update(schema.sendCampaignTargets).set({ nextTouchAt: daysAgoIso(0) }).where(eq(schema.sendCampaignTargets.id, t.id)).run();
    await campaign.scanDueCampaigns();
    campaign.onCampaignSendSent(1);
    t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.id, t.id)).get()!;
    expect(t.status).toBe("sent");
    const c = h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, cid)).get()!;
    expect(c.status).toBe("done");
  });

  it("回复止损：pending/queued 全部 replied 且清 nextTouchAt", async () => {
    const cid = seedCampaign([1], true);
    await campaign.scanDueCampaigns();                          // 首信 queued
    campaign.onContactSignal(1, "replied");
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("replied");
    expect(t.nextTouchAt).toBeNull();
  });

  it("OOO 自动回复：不止损，待发触点顺延 3 天", async () => {
    const cid = seedCampaign([1], true);
    campaign.onContactSignal(1, "autoreply");                   // 尚未入队，pending
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("pending");
    expect(new Date(t.nextTouchAt!).getTime()).toBeGreaterThan(new Date(daysAheadIso(2.9)).getTime());
  });

  it("bounce 止损", async () => {
    const cid = seedCampaign([1], true);
    campaign.onContactSignal(1, "bounce");
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("bounced");
    expect(t.nextTouchAt).toBeNull();
  });

  it("stop 终止：全部待发清空 skipped", async () => {
    const cid = seedCampaign([1], true);
    campaign.setCampaignStatus(cid, "stopped");
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("skipped");
    expect(t.nextTouchAt).toBeNull();
    const c = h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, cid)).get()!;
    expect(c.status).toBe("stopped");
  });
});
