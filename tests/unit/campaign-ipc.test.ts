import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { sendCampaigns, sendCampaignTargets } from "../../src/main/db/schema/send-campaign";
import { IPC } from "../../src/main/contract";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// 向导 → IPC → service 端到端（钉死用户实测的「按钮点不动」疑点）：
// 直接 mock electron 的 ipcMain.handle 捕获 handler，用 CampaignWizard
// buildTouches 的真实 payload 形状调用——通道注册、参数解包、service
// 调用、返回形态一条链全验。按钮无反馈的根因（submit 吞异常）在
// renderer 层，这里是证明「接口逻辑本身是对上的」。
// 链路语义：「添加任务」= startNow:false 草稿；卡片「启动」= control resume。
// ═══════════════════════════════════════════════════════════════════

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { handlers.set(ch, fn); } },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("nodemailer", () => ({ createTransport: vi.fn(() => ({ sendMail: vi.fn() })) }));
vi.mock("../../src/main/services/account.service", () => ({ getDecryptedPassword: async () => "x" }));
vi.mock("../../src/main/services/inline-images", () => ({ embedInlineImages: async (h: unknown) => h }));
vi.mock("../../src/main/net-proxy", () => ({ netFetch: async () => null }));
vi.mock("../../src/main/services/send.service", () => {
  const ok = (data: unknown = null) => ({ success: true, data });
  return {
    buildDynamicQueue: vi.fn(async () => ok([])),
    getSendStatus: vi.fn(() => ok({ isRunning: false, isPaused: false, sentCount: 0, failedCount: 0, totalItems: 0 })),
    getQuotaStatus: vi.fn(() => ok({})),
    normalizeLang: (l: string) => l,
    setSendBccFn: vi.fn(), setPushFn: vi.fn(), setSaveConfigFn: vi.fn(),
    startSend: vi.fn(async () => ok({})), pauseSend: vi.fn(() => ok({})),
    resumeSend: vi.fn(() => ok({})), cancelSend: vi.fn(() => ok({})),
    getQueueItems: vi.fn(() => ok([])), resumeQueue: vi.fn(async () => ok({ batchId: "b" })),
    getTimeBuckets: vi.fn(() => ok([])), getStageBuckets: vi.fn(() => ok([])),
    getSendTimeBuckets: vi.fn(() => ok([])), getPickerStats: vi.fn(() => ok({})),
    previewSentence: vi.fn(() => ok({})), buildQueue: vi.fn(async () => ok({})),
    buildAdaptiveQueue: vi.fn(async () => ok({})), previewTemplate: vi.fn(() => ok({})),
    isValidEmail: (s: string) => /.+@.+\..+/.test(s),
    startDynamicSend: vi.fn(async () => ok({})),
  };
});

const TMP = path.join(os.tmpdir(), "prospector-campaign-ipc-test");
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
  return { ...actual, APP_ROOT: TMP, DB_PATH: path.join(TMP, "prospector.db"), loadConfig: () => ({}), saveConfig: () => ({}) };
});

const { registerSendIPC } = await import("../../src/main/transport/send.ipc");

type Res<T> = { success: boolean; error?: string; data?: T };
const invoke = <T>(ch: string, ...args: unknown[]): Res<T> => {
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`handler 未注册: ${ch}`);
  return fn(undefined, ...args) as Res<T>;
};

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
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

/** 与 CampaignWizard.buildTouches 输出完全同形（含空 schedule / rotate 账号策略） */
const wizardPayload = {
  name: "巴西冷客户·系统句库",
  contactIds: [1, 2],
  touches: [
    { stage: "initial", delayDays: 0, mode: "system" },
    { stage: "followup1", delayDays: 5, mode: "system" },
  ],
  autoSend: true,
  accountPolicy: { mode: "rotate" },
  schedule: {},
};

describe("campaign IPC 端到端（向导 payload → transport → 落库）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
    registerSendIPC();
  });
  beforeEach(() => { freshDb(); });

  it("通道已注册：campaignCreate / campaignUpdateDraft / campaignControl / campaigns / campaignDelete 全在白名单", () => {
    for (const ch of [IPC.SEND.CAMPAIGN_CREATE, IPC.SEND.CAMPAIGN_UPDATE_DRAFT, IPC.SEND.CAMPAIGN_CONTROL,
      IPC.SEND.CAMPAIGNS, IPC.SEND.CAMPAIGN_DELETE]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });

  it("卡片「删除」(campaignDelete)：草稿经通道删净；空 id 走 Result 包络报错", () => {
    const created = invoke<{ id: string }>(IPC.SEND.CAMPAIGN_CREATE, { ...wizardPayload, startNow: false });
    const id = created.data!.id;
    expect(invoke(IPC.SEND.CAMPAIGN_DELETE, "").success).toBe(false);
    const r = invoke<{ deletedTargets: number }>(IPC.SEND.CAMPAIGN_DELETE, id);
    expect(r.success).toBe(true);
    expect(r.data!.deletedTargets).toBe(2);
    expect(h.db.select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get()).toBeUndefined();
    expect(h.db.select().from(sendCampaignTargets).all()).toHaveLength(0);
  });

  it("「添加任务」(startNow=false)：落库为草稿、触点不计时、已回复者照常入队", () => {
    const r = invoke<{ id: string; eligible: number; excluded: number }>(IPC.SEND.CAMPAIGN_CREATE, { ...wizardPayload, startNow: false });
    expect(r.success).toBe(true);
    expect(r.data!.eligible).toBe(2);   // #2 replied → 照常入队（资格闸已解除）
    expect(r.data!.excluded).toBe(0);
    const c = h.db.select().from(sendCampaigns).where(eq(sendCampaigns.id, r.data!.id)).get()!;
    expect(c.status).toBe("draft");
    const t = h.db.select().from(sendCampaignTargets).all();
    expect(t).toHaveLength(2);
    expect(t.every(x => x.nextTouchAt === null)).toBe(true);   // 草稿不排触点
  });

  it("任务列表 (campaigns)：必须走 Result 包络 {success,data}——裸数组会让前端判空、卡片全不见", () => {
    invoke(IPC.SEND.CAMPAIGN_CREATE, { ...wizardPayload, contactIds: [1], startNow: false });
    const r = invoke<Array<{ id: string; name: string; status: string; queuedGroups: number }>>(IPC.SEND.CAMPAIGNS);
    expect(r.success).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.name).toBe(wizardPayload.name);
    expect(r.data![0]!.status).toBe("draft");
    expect(r.data![0]!.queuedGroups).toBe(0);
  });

  it("卡片「启动」(control resume)：draft → running，pending 触点立即到期", () => {
    const created = invoke<{ id: string }>(IPC.SEND.CAMPAIGN_CREATE, { ...wizardPayload, contactIds: [1], startNow: false });
    const r = invoke<string>(IPC.SEND.CAMPAIGN_CONTROL, { campaignId: created.data!.id, action: "resume" });
    expect(r.success).toBe(true);
    const c = h.db.select().from(sendCampaigns).where(eq(sendCampaigns.id, created.data!.id)).get()!;
    expect(c.status).toBe("running");
    expect(h.db.select().from(sendCampaignTargets).all()[0]!.nextTouchAt).not.toBeNull();
  });

  it("编辑草稿 (campaignUpdateDraft)：campaignId 解包正确，名单全量替换", () => {
    const created = invoke<{ id: string }>(IPC.SEND.CAMPAIGN_CREATE, { ...wizardPayload, contactIds: [1], startNow: false });
    const id = created.data!.id;
    const r = invoke<{ eligible: number }>(IPC.SEND.CAMPAIGN_UPDATE_DRAFT, {
      campaignId: id,
      name: "改名了",
      contactIds: [1],
      touches: [{ stage: "initial", delayDays: 0, mode: "system" }],
      autoSend: false,
      accountPolicy: { mode: "rotate" },
      schedule: { dailyGroupCap: 30 },
      startNow: false,
    });
    expect(r.success).toBe(true);
    const c = h.db.select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get()!;
    expect(c.name).toBe("改名了");
    expect(c.scheduleJson).toContain("dailyGroupCap");
    expect(JSON.parse(c.touchPlanJson)).toHaveLength(1);
  });

  it("失败也走 Result 包络（不抛异常、renderer 能拿到 error 文案）", () => {
    const r = invoke(IPC.SEND.CAMPAIGN_CREATE, { ...wizardPayload, name: "   " });
    expect(r.success).toBe(false);
    expect(r.error).toContain("任务名必填");
  });
});
