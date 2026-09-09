import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════
// 发信任务（docs/smart-send-spec.md + 定时器式任务组营销）：
// 资格闸已解除（已触达/已回复照常入队，界面计数提示）、扫描入队、触点推进、
// 回复/退订/bounce 止损、OOO 顺延、
// 跨任务冷却、终态收尾、草稿生命周期、内容模式（fixed 快照）、
// 账号策略（fixed/rotate）、时段覆盖、单日上限、配额顺延。
// 队列入口经 setCampaignQueueFn 注入假件；send.service 打桩
// （变量渲染正确性归 send.service 自己的测试）。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

// 引擎状态桩：isRunning（扫描器引擎忙检查）与 quota（配额预算）按用例切换
const sendState = vi.hoisted(() => ({
  isRunning: false,
  quota: { ok: true, remaining: -1 as number },
}));

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
  getSendStatus: () => ({ success: true as const, data: { isRunning: sendState.isRunning } }),
  getQuotaStatus: () => sendState.quota,
  normalizeLang: (l: string | null | undefined) => {
    const u = (l ?? "EN").toUpperCase();
    return u === "ES" ? "ES" : u === "PT" ? "PT" : "EN";
  },
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
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE, provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer, imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text, circuit_reason text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE send_campaigns (
  id text PRIMARY KEY NOT NULL, name text NOT NULL, status text DEFAULT 'running' NOT NULL,
  auto_send integer DEFAULT 1 NOT NULL, target_filter_json text DEFAULT '{}' NOT NULL,
  touch_plan_json text NOT NULL,
  created_by text DEFAULT 'agent' NOT NULL, account_policy text DEFAULT 'rotate' NOT NULL,
  account_ids_json text, schedule_json text, send_mode text DEFAULT 'individual' NOT NULL,
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
    { id: 2, email: "b@x.com", firstName: "B", status: "replied", stage: "cold", language: "EN" }, // 已回复 → 照常入队
    { id: 3, email: "c@x.com", firstName: "C", status: "reached", stage: "cold", language: "EN" }, // 已触达 → 照常入队
    { id: 4, email: "d@x.com", firstName: "D", status: "", stage: "cold", language: "EN" },        // 合格（cap 用）
  ] as never).run();
  h.db.insert(schema.templates).values([
    { name: "F1 模板", language: "EN", subject: "Hi {{firstName}}", body: "followup one for {{company}}", stage: "followup1" },
    { name: "首信模板", language: "EN", subject: "Hello {{firstName}}", body: "first touch {{company}}", stage: "initial" },
  ]).run();
}

const campaign = await import("../../src/main/services/campaign.service");
type Enqueued = { items: Array<{ subject: string; tplBody: string }>; autoStart: boolean; accountIds?: number[] };
let enqueued: Enqueued[] = [];

/** 统一的队列假件：记录 items/autoStart/accountIds，全部成功 */
function injectQueue(): void {
  enqueued = [];
  sendState.isRunning = false;
  sendState.quota = { ok: true, remaining: -1 };
  campaign.setCampaignQueueFn(async (items, autoStart, opts) => {
    enqueued.push({ items: items as Enqueued["items"], autoStart, accountIds: opts?.accountIds });
    return { success: true, data: { batchId: "b1" } };
  });
}

/** 建一个 2 触点任务（首信 initial + 5 天后 followup1），返回 campaignId */
function seedCampaign(contactIds: number[], autoSend = true): string {
  const r = campaign.createCampaign({
    name: "测试任务", contactIds, autoSend,
    touches: [{ stage: "initial", delayDays: 0 }, { stage: "followup1", delayDays: 5 }],
  });
  if (!r.success) throw new Error(r.error);
  return r.data.id;
}

async function initSql(): Promise<void> {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
}

describe("createCampaign（资格闸已解除：已回复/已触达照常入队）", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

  it("已回复/已触达照常入队；只剔除不在库的联系人", () => {
    const r = campaign.createCampaign({
      name: "t", contactIds: [1, 2, 3, 999], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ eligible: 3, excluded: 1 });   // 999 不在库；2/3 号照常入队
    const targets = h.db!.select().from(schema.sendCampaignTargets).all();
    expect(targets.map(t => t.contactId)).toEqual([1, 2, 3]);
  });

  it("previewCampaign：reachedReplied 计数供确认卡括号提示", () => {
    const pv = campaign.previewCampaign([1, 2, 3, 999]);
    expect(pv.success).toBe(true);
    expect(pv.data).toMatchObject({ total: 4, eligible: 3, excluded: 1, reachedReplied: 2 });
  });

  it("名单全不在库 → 拒建并说明，不落任何行", () => {
    const r = campaign.createCampaign({
      name: "t", contactIds: [998, 999], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(r.success).toBe(false);
    expect(h.db!.select().from(schema.sendCampaigns).all()).toHaveLength(0);
  });
});

describe("scanDueCampaigns（到期触点 → 入队）", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

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

  it("资格闸已解除：目标联系人已变 replied → 照常入队（止损只认 onContactSignal 显式信号）", async () => {
    const cid = seedCampaign([1], true);
    h.db!.update(schema.contacts).set({ status: "replied" }).where(eq(schema.contacts.id, 1)).run();
    await campaign.scanDueCampaigns();
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("queued");
    expect(enqueued).toHaveLength(1);
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

  it("引擎忙（isRunning）→ 本轮整体跳过，触点原样不动", async () => {
    const cid = seedCampaign([1], true);
    sendState.isRunning = true;
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(0);
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("pending");                          // 不顺延：引擎空了下轮自然接上
    expect(t.nextTouchAt).not.toBeNull();
  });
});

describe("定时器语义：时段覆盖 / 单日上限 / 配额预算", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

  it("任务级时段覆盖：当前小时在窗外 → 本轮不喂料，触点原样等下个周期", async () => {
    const now = new Date().getHours();
    const start = (now + 1) % 24;               // [now+1, now+2) 的窗口永远不含 now
    const end = (now + 2) % 24;
    const cid = campaign.createCampaign({
      name: "时窗外", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
      schedule: { windowStartHour: start, windowEndHour: end },
    }).data!.id;
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(0);
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("pending");
    expect(t.nextTouchAt).not.toBeNull();       // 没被顺延，等窗口开了下轮直接发
  });

  it("单日放行上限：cap=1 → 本轮只放 1 组，其余顺延次日", async () => {
    const cid = campaign.createCampaign({
      name: "cap", contactIds: [1, 4], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
      schedule: { dailyGroupCap: 1 },
    }).data!.id;
    await campaign.scanDueCampaigns();
    const totalItems = enqueued.reduce((n, e) => n + e.items.length, 0);
    expect(totalItems).toBe(1);                                  // 只放行 1 组
    const ts = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).all();
    const queued = ts.filter(t => t.status === "queued");
    const deferred = ts.filter(t => t.status === "pending");
    expect(queued).toHaveLength(1);
    expect(deferred).toHaveLength(1);                            // 没放行的顺延了
    expect(new Date(deferred[0]!.nextTouchAt!).getTime()).toBeGreaterThan(new Date(daysAheadIso(0.5)).getTime());
  });

  it("今日配额耗尽 → autoSend 任务触点顺延次日；autoSend=false 的不受配额闸", async () => {
    sendState.quota = { ok: false, remaining: 0, reason: "已达今日限额" };
    const cidA = seedCampaign([1], true);                        // autoSend=1 → 被配额挡住
    const cidB = campaign.createCampaign({
      name: "手动批", contactIds: [4], autoSend: false,
      touches: [{ stage: "initial", delayDays: 0 }],
    }).data!.id;
    await campaign.scanDueCampaigns();
    expect(enqueued.reduce((n, e) => n + e.items.length, 0)).toBe(1);   // 只有手动批入队
    const tA = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cidA)).get()!;
    expect(tA.status).toBe("pending");
    expect(new Date(tA.nextTouchAt!).getTime()).toBeGreaterThan(new Date(daysAheadIso(0.5)).getTime());
    const tB = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cidB)).get()!;
    expect(tB.status).toBe("queued");
  });
});

describe("内容模式与账号策略（向导入参对齐）", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

  it("fixed=创建时内容快照：入队收到的就是快照原文", async () => {
    campaign.createCampaign({
      name: "固定内容", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", content: { subject: "固定主题 {{firstName}}", body: "固定正文" } }],
    });
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.items[0]!.subject).toBe("固定主题 {{firstName}}");   // 变量渲染归 buildDynamicQueue
    expect(enqueued[0]!.items[0]!.tplBody).toBe("固定正文");
  });

  it("fixed 模式缺内容 → 拒建（normalizeTouches 校验）", () => {
    const r = campaign.createCampaign({
      name: "缺内容", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", content: { subject: "", body: "x" } }],
    });
    expect(r.success).toBe(false);
  });

  it("system 模式 → 直接句库组装（不查用户模板）", async () => {
    campaign.createCampaign({
      name: "句库", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0, mode: "system" }],
    });
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(1);            // 句库兜底永远有内容
    expect(enqueued[0]!.items[0]!.subject.length).toBeGreaterThan(0);
  });

  it("账号策略 fixed：只把健康的指定账号传给队列", async () => {
    h.db!.insert(schema.emailAccounts).values([
      { id: 1, email: "ok@x.com", encryptedPass: "x", isActive: 1 },
      { id: 2, email: "off@x.com", encryptedPass: "x", isActive: 0 },                                        // 停用
      { id: 3, email: "circuit@x.com", encryptedPass: "x", isActive: 1, circuitOpenAt: new Date().toISOString() },  // 熔断中
    ] as never).run();
    campaign.createCampaign({
      name: "指定账号", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
      accountPolicy: { mode: "fixed", accountIds: [1, 2, 3] },
    });
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.accountIds).toEqual([1]);                        // 只剩健康账号 1
  });

  it("指定账号全部熔断/停用 → 整批顺延 1 天，不静默换号", async () => {
    h.db!.insert(schema.emailAccounts).values([
      { id: 1, email: "off@x.com", encryptedPass: "x", isActive: 0 },
    ] as never).run();
    const cid = campaign.createCampaign({
      name: "全熔断", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
      accountPolicy: { mode: "fixed", accountIds: [1] },
    }).data!.id;
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(0);
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("pending");
    expect(new Date(t.nextTouchAt!).getTime()).toBeGreaterThan(new Date(daysAheadIso(0.5)).getTime());
  });

  it("fixed 账号列表里有不存在的账号 → 拒建", () => {
    h.db!.insert(schema.emailAccounts).values([{ id: 1, email: "ok@x.com", encryptedPass: "x" }] as never).run();
    const r = campaign.createCampaign({
      name: "坏账号", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
      accountPolicy: { mode: "fixed", accountIds: [1, 99] },
    });
    expect(r.success).toBe(false);
  });
});

describe("草稿生命周期（draft / updateCampaignDraft）", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

  it("startNow=false → 草稿：nextTouchAt=null 不计时，扫描不喂料", async () => {
    const r = campaign.createCampaign({
      name: "草稿", contactIds: [1], autoSend: true, startNow: false,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(r.success).toBe(true);
    const c = h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, r.data!.id)).get()!;
    expect(c.status).toBe("draft");
    expect(c.createdBy).toBe("agent");                       // 缺省 agent（旧调用兼容）
    const t = h.db!.select().from(schema.sendCampaignTargets).all();
    expect(t).toHaveLength(1);
    expect(t[0]!.nextTouchAt).toBeNull();
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(0);                         // 草稿不在扫描范围（campaigns.status != running）
  });

  it("启动：draft → running 后 pending 触点从现在计时，下轮扫描入队", async () => {
    const cid = campaign.createCampaign({
      name: "草稿", contactIds: [1], autoSend: true, startNow: false,
      touches: [{ stage: "initial", delayDays: 0 }],
    }).data!.id;
    campaign.setCampaignStatus(cid, "running");
    await campaign.scanDueCampaigns();
    expect(enqueued).toHaveLength(1);
    const t = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).get()!;
    expect(t.status).toBe("queued");
  });

  it("updateCampaignDraft：名单与计划全量替换；createdBy=ui 落库", () => {
    const cid = campaign.createCampaign({
      name: "草稿", contactIds: [1], autoSend: true, startNow: false,
      touches: [{ stage: "initial", delayDays: 0 }],
    }).data!.id;
    const r = campaign.updateCampaignDraft(cid, {
      name: "改过的草稿", contactIds: [4], autoSend: false, createdBy: "ui",
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", content: { subject: "s", body: "b" } }],
      accountPolicy: { mode: "fixed", accountIds: [] },
    });
    expect(r.success).toBe(false);                           // 空账号列表 → 拒
    const r2 = campaign.updateCampaignDraft(cid, {
      name: "改过的草稿", contactIds: [4], autoSend: false, createdBy: "ui",
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", content: { subject: "s", body: "b" } }],
    });
    expect(r2.success).toBe(true);
    const ts = h.db!.select().from(schema.sendCampaignTargets).where(eq(schema.sendCampaignTargets.campaignId, cid)).all();
    expect(ts.map(t => t.contactId)).toEqual([4]);            // 全量替换：1 → 4
    const c = h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, cid)).get()!;
    expect(c.name).toBe("改过的草稿");
    expect(c.autoSend).toBe(0);
    expect(JSON.parse(c.touchPlanJson)[0].content).toEqual({ subject: "s", body: "b" });
  });

  it("非 draft 状态拒改（只有草稿可以编辑）", () => {
    const cid = seedCampaign([1], true);                      // running
    const r = campaign.updateCampaignDraft(cid, {
      name: "x", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(r.success).toBe(false);
  });
});

describe("推进与止损（onCampaignSendSent / onContactSignal）", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

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

describe("再启动新周期（restartCampaign + 完结清空固定内容）", () => {
  beforeAll(async () => { await initSql(); });
  beforeEach(() => { freshDb(); injectQueue(); });

  it("完结任务再启动：sent/replied/skipped 重置待发，退信保持终态不重置", () => {
    const cid = seedCampaign([1, 2, 3, 4], true);
    h.db!.update(schema.sendCampaignTargets).set({ status: "sent" }).where(eq(schema.sendCampaignTargets.contactId, 1)).run();
    h.db!.update(schema.sendCampaignTargets).set({ status: "replied" }).where(eq(schema.sendCampaignTargets.contactId, 2)).run();
    h.db!.update(schema.sendCampaignTargets).set({ status: "skipped" }).where(eq(schema.sendCampaignTargets.contactId, 3)).run();
    h.db!.update(schema.sendCampaignTargets).set({ status: "bounced" }).where(eq(schema.sendCampaignTargets.contactId, 4)).run();
    h.db!.update(schema.sendCampaigns).set({ status: "done" }).where(eq(schema.sendCampaigns.id, cid)).run();

    const r = campaign.restartCampaign(cid);
    expect(r.success).toBe(true);
    expect(r.data.reset).toBe(3);                                   // sent/replied/skipped；bounced 不动
    const ts = h.db!.select().from(schema.sendCampaignTargets).all();
    const by = Object.fromEntries(ts.map(t => [t.contactId, t.status]));
    expect(by).toEqual({ 1: "pending", 2: "pending", 3: "pending", 4: "bounced" });
    const t1 = ts.find(t => t.contactId === 1)!;
    expect(t1.round).toBe(0);
    expect(new Date(t1.nextTouchAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1000);  // 立即到期
    const c = h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, cid)).get()!;
    expect(c.status).toBe("running");
  });

  it("非 done 状态拒绝再启动", () => {
    const cid = seedCampaign([1], true);                            // running
    const r = campaign.restartCampaign(cid);
    expect(r.success).toBe(false);
  });

  it("完结时清空固定内容快照 → 再启动拒绝并转回草稿（防旧内容重发）", async () => {
    const cid = campaign.createCampaign({
      name: "t", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", content: { subject: "老主题", body: "老正文" } }],
    }).data!.id;
    await campaign.scanDueCampaigns();
    campaign.onCampaignSendSent(1);                                 // 单触点走完 → sent + done + 快照清空

    const c = h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, cid)).get()!;
    expect(c.status).toBe("done");
    expect(JSON.parse(c.touchPlanJson)[0].content).toBeUndefined(); // 固定内容已清空

    const r = campaign.restartCampaign(cid);
    expect(r.success).toBe(false);
    expect(r.error).toContain("固定内容");
    expect(h.db!.select().from(schema.sendCampaigns).where(eq(schema.sendCampaigns.id, cid)).get()!.status).toBe("draft");
  });
});
