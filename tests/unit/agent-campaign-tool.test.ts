import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { sendCampaigns } from "../../src/main/db/schema/send-campaign";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// campaign_create AI 工具入参对齐（定时器式任务组营销）：
// 钉住 schema→service 的三段透传——
// ① touches[].mode（system/userTpl/fixed+内容快照）；
// ② schedule（发送时段 + 单日放行上限）；
// ③ 确认卡先出预览（内容来源/时段/上限进 diff），用户点确认才建档。
// 队列入口未注入 → run() 里的 scanDueCampaigns 空转，只验落库形态。
// ═══════════════════════════════════════════════════════════════════

const TMP = path.join(os.tmpdir(), "prospector-campaign-tool-test");
// 不做运价远程探测：指向必然拒绝的端口 → 秒失败（防止意外等待网络超时）
process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";
type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/config", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, APP_ROOT: TMP, DB_PATH: path.join(TMP, "prospector.db") };
});

const { buildHarnessTools } = await import("../../src/main/services/agent/tools");
const { executeAction } = await import("../../src/main/services/agent/actions");
const campaign = await import("../../src/main/services/campaign.service");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type ToolLike = { invoke: (rc: unknown, input: string, details?: unknown) => Promise<string> };
const call = (t: ToolLike, args: unknown): Promise<string> => t.invoke({}, JSON.stringify(args));

const ctx = { conversationId: "act-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
let toolByName: Record<string, ToolLike> = {};
let T: (name: string) => ToolLike = () => { throw new Error("未初始化"); };

function freshDb(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  for (const s of [
    `ALTER TABLE inbox_messages ADD COLUMN intent text;`,
    `ALTER TABLE contacts ADD COLUMN language text;`,
    `ALTER TABLE email_accounts ADD COLUMN last_fetch_error text;`,
    `ALTER TABLE email_accounts ADD COLUMN last_fetch_at text;`,
    `ALTER TABLE email_accounts ADD COLUMN fetch_fail_count integer DEFAULT 0 NOT NULL;`,
  ]) { try { raw.run(s); } catch { /* 列已存在 */ } }
  h.db = drizzle(raw, { schema });
  h.db.insert(schema.contacts).values([
    { id: 1, email: "a@x.com", firstName: "Ana", status: "", stage: "cold", language: "EN" },
    { id: 2, email: "b@x.com", firstName: "Bruno", status: "replied", stage: "cold", language: "EN" },
  ] as never).run();
}

interface ToolOut {
  ok?: boolean; error?: { code: string; message: string };
  eligible?: number; excluded?: number; planSummary?: string;
  actions?: Array<{ id: string; label: string; confirm: string; diff: Array<{ field: string; label: string; to: string }> }>;
}
const run = async (args: unknown): Promise<ToolOut> => JSON.parse(await call(T("campaign_create"), args));

describe("campaign_create 工具入参对齐（mode / schedule → service 透传）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    ctx.counts.clear(); ctx.failures.clear();
    toolByName = Object.fromEntries((buildHarnessTools(ctx) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
    T = (name) => toolByName[name]!;
  });

  it("system 模式 + 定时器（时段/单日上限）→ 确认卡 diff 列全，点确认后落库形态正确", async () => {
    const r = await run({
      name: "巴西冷客户·系统句库",
      contactIds: [1, 2],
      touches: [
        { stage: "initial", delayDays: 0, mode: "system" },
        { stage: "followup1", delayDays: 5, mode: "system" },
      ],
      autoSend: true,
      schedule: { windowStartHour: 9, windowEndHour: 18, dailyGroupCap: 50 },
    });
    expect(r.ok).toBe(true);
    expect(r.eligible).toBe(2);           // #2 已回复照常入队（资格闸已解除）
    expect(r.excluded).toBe(0);
    const card = r.actions![0]!;
    expect(card.confirm).toContain("其中 1 位已触达/已回复，将照常入队");   // rrNote 括号计数提示
    expect(card.confirm).toContain("系统句库");
    expect(card.confirm).toContain("9:00-18:00");
    expect(card.confirm).toContain("单日上限 50 组/天");
    const diff = Object.fromEntries(card.diff.map(d => [d.field, d.to]));
    expect(diff.content).toBe("系统句库");
    expect(diff.window).toBe("9:00-18:00");
    expect(diff.cap).toContain("50");

    const done = await executeAction(card.id);
    expect(done.success).toBe(true);
    const row = h.db.select().from(sendCampaigns).get()!;
    expect(row.name).toBe("巴西冷客户·系统句库");
    const plan = JSON.parse(row.touchPlanJson) as Array<{ stage: string; mode?: string }>;
    expect(plan.map(p => p.stage)).toEqual(["initial", "followup1"]);
    expect(plan.every(p => p.mode === "system")).toBe(true);
    const sched = JSON.parse(row.scheduleJson!) as { windowStartHour: number; windowEndHour: number; dailyGroupCap: number };
    expect(sched).toEqual({ windowStartHour: 9, windowEndHour: 18, dailyGroupCap: 50 });
  });

  it("fixed 模式：内容快照原样落 touch_plan；缺主题/正文在出卡前就拒（bad_touch）", async () => {
    const bad = await run({
      contactIds: [1],
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", subject: "", body: "hi" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("bad_touch");
    expect(bad.error?.message).toContain("主题或正文为空");
    expect(h.db.select().from(sendCampaigns).all()).toHaveLength(0);   // 没落库

    const r = await run({
      contactIds: [1],
      touches: [{ stage: "initial", delayDays: 0, mode: "fixed", subject: "Hi {{firstName}}", body: "hello" }],
    });
    expect(r.ok).toBe(true);
    const done = await executeAction(r.actions![0]!.id);
    expect(done.success).toBe(true);
    const plan = JSON.parse(h.db.select().from(sendCampaigns).get()!.touchPlanJson) as Array<{ mode?: string; content?: { subject: string; body: string } }>;
    expect(plan[0]!.mode).toBe("fixed");
    expect(plan[0]!.content).toEqual({ subject: "Hi {{firstName}}", body: "hello" });
  });

  it("不传 mode/schedule → 旧行为兼容：touch_plan 无 mode、schedule_json 为空", async () => {
    const r = await run({
      contactIds: [1],
      touches: [{ stage: "initial", delayDays: 0 }, { stage: "followup1", delayDays: 5 }],
    });
    expect(r.ok).toBe(true);
    const done = await executeAction(r.actions![0]!.id);
    expect(done.success).toBe(true);
    const row = h.db.select().from(sendCampaigns).get()!;
    const plan = JSON.parse(row.touchPlanJson) as Array<{ mode?: string }>;
    expect(plan.every(p => p.mode === undefined)).toBe(true);
    expect(row.scheduleJson).toBeNull();
  });

  it("schedule 只传一半时段（缺 windowEndHour）→ 不生效，不落库", async () => {
    const r = await run({
      contactIds: [1],
      touches: [{ stage: "initial", delayDays: 0 }],
      schedule: { windowStartHour: 9, dailyGroupCap: 0 },
    });
    expect(r.ok).toBe(true);
    const card = r.actions![0]!;
    expect(card.confirm).not.toContain(":00");
    expect(card.diff.find(d => d.field === "window")).toBeUndefined();
    const done = await executeAction(card.id);
    expect(done.success).toBe(true);
    expect(h.db.select().from(sendCampaigns).get()!.scheduleJson).toBeNull();
  });
});

describe("campaign_status 概览带出新建任务（对齐后的读路径）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    ctx.counts.clear(); ctx.failures.clear();
    toolByName = Object.fromEntries((buildHarnessTools(ctx) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
    T = (name) => toolByName[name]!;
  });

  it("AI 建的任务（agent 入口缺省）能被概览查到且状态口径不变", async () => {
    const r = await campaign.createCampaign({
      name: "工具链冒烟", contactIds: [1], autoSend: true,
      touches: [{ stage: "initial", delayDays: 0, mode: "system" }],
      schedule: { dailyGroupCap: 10 },
    });
    expect(r.success).toBe(true);
    const out = JSON.parse(await call(T("campaign_status"), {})) as {
      campaigns?: Array<{ id: string; name: string; status: string; total: number; pending: number; planRounds: number }>;
    };
    const c = out.campaigns?.find(x => x.id === r.data!.id);
    expect(c).toMatchObject({ name: "工具链冒烟", status: "running", total: 1, pending: 1, planRounds: 1 });
    // 草稿启动链路顺手冒烟：draft → resume 计时
    const d = await campaign.createCampaign({
      name: "草稿", contactIds: [1], autoSend: true, startNow: false,
      touches: [{ stage: "initial", delayDays: 0 }],
    });
    expect(d.success).toBe(true);
    const up = await campaign.setCampaignStatus(d.data!.id, "running");
    expect(up.success).toBe(true);
    const row = h.db.select().from(sendCampaigns).where(eq(sendCampaigns.id, d.data!.id)).get()!;
    expect(row.status).toBe("running");
  });
});
