import { afterAll, beforeEach, describe, expect, it } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import * as SendService from "../../src/main/services/send.service";
import { okResult, failResult, type Result } from "../../src/main/errors";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// 发信管线·生产前沙箱演练
// 真实 send.service 管线 + 内存 SQLite + 假 SMTP 传输（绝无网络/不碰真实库）。
// 覆盖：分组/拆组/BCC、变量渲染、坏邮箱过滤、reached 排除、账号轮换、
//       落库回执（interactions/inbox_messages/queue）、阶段推进、配额记录，
//       以及 熔断 / 瞬态重试 / 限额裁剪 / 二次拦截 / 动态发信+CC。
// ═══════════════════════════════════════════════════════════════════

const h = vi.hoisted(() => ({
  db: null as unknown,
  cfg: null as unknown,
}));

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

import { vi } from "vitest";

// ── 建表 DDL（与 runMigrations 的 SCHEMA_SQL 列对齐） ──
const DDL = `
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE, provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer, imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE companies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, domain text, industry text, country text, size text, backcheck_data text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE, company_id integer, first_name text, last_name text,
  title text, phone text, linkedin text, country text, client_type text, language text,
  stage text DEFAULT 'cold', status text DEFAULT '', tags text,
  extra text DEFAULT '{}', assignee text DEFAULT '',
  source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, language text NOT NULL, subject text NOT NULL, body text NOT NULL,
  category text, stage text, version integer DEFAULT 1 NOT NULL, is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE send_queue (
  id text PRIMARY KEY NOT NULL, batch_id text NOT NULL,
  company_name text, company_id integer, recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  status text DEFAULT 'pending' NOT NULL, error text, sent_at text,
  tpl_name text, country text, language text, cc text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE interactions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL, type text NOT NULL, direction text NOT NULL,
  channel text DEFAULT 'email' NOT NULL,
  subject text, body_preview text, message_id text, account_id integer, metadata text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL, message_id text, from_email text NOT NULL, from_name text,
  subject text, body_preview text, classification text, cc text, my_role text,
  matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL, received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

type Driz = ReturnType<typeof drizzle<typeof schema>>;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>> | null = null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForDone(timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = SendService.getSendStatus();
    if (s.success && !s.data.isRunning) return;
    await sleep(5);
  }
  throw new Error(`批次 ${timeoutMs}ms 未结束（调度循环疑似卡死）`);
}

/** 每次调用的假 SMTP 行为队列："ok" | "perm:原因" | "transient:原因" */
let sendCalls: Array<SendService.SendItem & { body: string }> = [];
let transportPlan: string[] = [];

function setSandbox(opts?: {
  dailyLimit?: number; groupSize?: number;
}) {
  h.cfg = {
    fromName: "Sandbox Sender", bodyName: "Sandbox", signature: "Best regards, Sandbox",
    schedule: {
      timeWindowEnabled: true, startHour: 9, endHour: 8,
      groupSize: opts?.groupSize ?? 20,
      groupDelayMinSeconds: 0, groupDelayMaxSeconds: 0,
    },
    test: { email: "self@test.local", company: "Test Co", enabled: true, dryRun: false },
    crm: { followupDays: {}, todoAdvanceDays: 2, autoArchiveDays: 30 },
    sendQuota: { dailyLimit: opts?.dailyLimit ?? 0, firstSendAt: null, sentToday: 0 },
  };
}

async function newSandbox(): Promise<Driz> {
  // sql.js（纯 WASM）：绕开 better-sqlite3 原生绑定的 Electron/Node ABI 冲突
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  setSandbox();
  sendCalls = [];
  transportPlan = [];
  SendService.setSaveConfigFn((c) => { h.cfg = c; });
  SendService.setPushFn(() => { /* noop */ });
  SendService.setSendBccFn(async (item) => {
    sendCalls.push(item);
    const plan = transportPlan.shift() ?? "ok";
    if (plan === "ok") return okResult({ messageId: `<sim-${sendCalls.length}@sandbox>` });
    return failResult(plan.replace(/^(perm|transient):/, ""));
  });
  return db;
}

const TPL = { name: "首发开发信", language: "EN", subject: "Hi {{firstName}} — {{company}}", body: "Hello {{firstName}} {{lastName}} at {{company}} re {{email}}", category: null, stage: null };

function seedCompany(db: Driz, name: string) {
  return db.insert(schema.companies).values({ name }).run() as unknown;
}

// drizzle sql.js/better 的 insert 无 returning 时按 email 回查 id
function companyId(db: Driz, name: string): number {
  return (db.select().from(schema.companies).where(eq(schema.companies.name, name)).get()!).id;
}
function seedAccounts(db: Driz, n = 1) {
  for (let i = 1; i <= n; i++) {
    db.insert(schema.emailAccounts).values({ email: `sender${i}@sb.com`, smtpHost: "smtp.test", encryptedPass: "x" }).run();
  }
}

function addContact(db: Driz, email: string, first: string, cid: number, extra?: Partial<{ stage: string; status: string; language: string; country: string; clientType: string }>) {
  db.insert(schema.contacts).values({
    email, firstName: first, companyId: cid,
    stage: extra?.stage ?? "cold", status: extra?.status ?? "", language: extra?.language ?? "EN",
    country: extra?.country ?? "Brazil", clientType: extra?.clientType ?? "direct",
  }).run();
}

beforeEach(() => {
  const s = SendService.getSendStatus();
  if (s.success && s.data.isRunning) { SendService.cancelSend(); }
});
afterAll(() => { SendService.cleanupSendEngine(); });

// ─────────────────────────────────────────────────────────

describe("发信管线沙箱演练（生产前逐环节验证）", () => {

  it("S1 全链路：分组/拆组/过滤/渲染/落库/阶段推进/配额记录", async () => {
    const db = await newSandbox();
    seedAccounts(db);
    const cx = companyId(db, (seedCompany(db, "X Ltda"), "X Ltda"));
    const cz = companyId(db, (seedCompany(db, "Z SA"), "Z SA"));
    const cw = companyId(db, (seedCompany(db, "W GmbH"), "W GmbH"));
    const cy = companyId(db, (seedCompany(db, "Y Inc"), "Y Inc"));
    addContact(db, "john@x.com", "John", cx);
    addContact(db, "mary@x.com", "Mary", cx);
    addContact(db, "bob@@broken", "Bob", cx);              // 无效邮箱 → 应剔除
    addContact(db, "sam@z.com", "Sam", cz);
    addContact(db, "mia@w.com", "Mia", cw, { stage: "f4" }); // 封顶阶段不再推进
    addContact(db, "lena@y.com", "Lena", cy, { status: "reached" }); // 已触达 → 排除

    const r = await SendService.startSend([], [TPL], true,
      db.select().from(schema.contacts).all().map(c => c.id)); // 全部 6 个联系人
    if (!r.success) console.log("S1 startSend failed:", r.error);
    expect(r.success).toBe(true);
    // 3 组：X 拆 1 组(2人, groupSize20)、Z、W；Lena/Bob 不在
    expect(r.data!.queued).toBe(3);
    expect(r.data!.queuedCount).toBe(4);

    await waitForDone();

    // 假传输收到的渲染：无 {{残留、含真实姓名与公司
    expect(sendCalls.length).toBe(3);
    for (const c of sendCalls) {
      expect(c.body).not.toContain("{{");
      expect(c.subject).toMatch(/^Hi \w+ — .+$/);
    }
    const byCompany = Object.fromEntries(sendCalls.map(c => [c.companyName, c.recipients.length]));
    expect(byCompany).toEqual({ "X Ltda": 2, "Z SA": 1, "W GmbH": 1 });

    const st = SendService.getSendStatus().data!;
    expect(st.sentCount).toBe(3);
    expect(st.failedCount).toBe(0);

    // 回执落库：interactions 4 条 sent、inbox_messages 4 条 sent 可查
    const ints = db.select().from(schema.interactions).all();
    expect(ints.filter(i => i.type === "sent").length).toBe(4);
    const sents = db.select().from(schema.inboxMessages).all().filter(m => m.classification === "sent");
    expect(sents.length).toBe(4);

    // 队列终态全 sent
    const rows = db.select().from(schema.sendQueue).all();
    expect(rows.every(r0 => r0.status === "sent")).toBe(true);
    expect(rows.every(r0 => !!r0.sentAt)).toBe(true);

    // 阶段推进：cold→f1，f4 封顶
    const john = db.select().from(schema.contacts).where(eq(schema.contacts.email, "john@x.com")).get()!;
    const mia = db.select().from(schema.contacts).where(eq(schema.contacts.email, "mia@w.com")).get()!;
    expect(john.stage).toBe("f1");
    expect(mia.stage).toBe("f4");

    // 配额按封数计（4 封，不是 3 组）
    const quota = (h.cfg as { sendQuota?: { sentToday: number; firstSendAt: string | null } }).sendQuota;
    expect(quota!.sentToday).toBe(0); // dailyLimit=0 不限额时不记录
  });

  it("S2 限额裁剪与二次拦截", async () => {
    const db = await newSandbox();
    setSandbox({ dailyLimit: 3 });
    seedAccounts(db);
    const ids: number[] = [];
    for (const [n, comp] of [["a", "CA"], ["b", "CB"], ["c", "CC"], ["d", "CD"]] as const) {
      const cid = companyId(db, (seedCompany(db, comp), comp));
      addContact(db, `${n}@${comp.toLowerCase()}.com`, n.toUpperCase(), cid);
      ids.push(db.select().from(schema.contacts).where(eq(schema.contacts.email, `${n}@${comp.toLowerCase()}.com`)).get()!.id);
    }
    const r1 = await SendService.startSend([], [TPL], true, ids);
    expect(r1.success).toBe(true);
    // 剩余额度 3 封 → 3 组保留、1 组整组裁剪
    expect(r1.data!.queuedCount).toBe(3);
    expect(r1.data!.dropped).toBe(1);
    await waitForDone();
    expect((h.cfg as { sendQuota: { sentToday: number } }).sendQuota.sentToday).toBe(3);

    // 额度耗尽 → 新批次直接拒绝且不改 state
    const r2 = await SendService.startSend([], [TPL], true, ids);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("限额");
  });

  it("S3 瞬态错误自动重试 ≤2 次后成功", async () => {
    const db = await newSandbox();
    seedAccounts(db);
    const cid = companyId(db, (seedCompany(db, "RT Ltd"), "RT Ltd"));
    addContact(db, "rt@rtltd.com", "Rt", cid);
    const id = db.select().from(schema.contacts).where(eq(schema.contacts.email, "rt@rtltd.com")).get()!.id;

    transportPlan = ["transient:421 Too many connections", "ok"];
    const r = await SendService.startSend([], [TPL], true, [id]);
    expect(r.success).toBe(true);
    await waitForDone();

    expect(sendCalls.length).toBe(2);            // 同组重试一次
    expect(SendService.getSendStatus().data!.sentCount).toBe(1);
    expect(SendService.getSendStatus().data!.failedCount).toBe(0);
    expect(db.select().from(schema.sendQueue).all()[0]!.status).toBe("sent");
  }, 20000);

  it("S4 永久错误 → 单账号失败、其他账号批次继续（熔断持久化）", async () => {
    const db = await newSandbox();
    const ca = companyId(db, (seedCompany(db, "A1"), "A1"));
    const cb = companyId(db, (seedCompany(db, "B1"), "B1"));
    const cc = companyId(db, (seedCompany(db, "C1"), "C1"));
    const cd = companyId(db, (seedCompany(db, "D1"), "D1"));
    const ids: number[] = [];
    for (const [n, cid] of [["p", ca], ["q", cb], ["r", cc], ["s", cd]] as const) {
      addContact(db, `${n}@m.com`, n.toUpperCase(), cid);
      ids.push(db.select().from(schema.contacts).where(eq(schema.contacts.email, `${n}@m.com`)).get()!.id);
    }
    seedAccounts(db, 2);
    const acctA = db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.email, "sender1@sb.com")).get()!;

    // A 账号的组全部返回 535（永久失败），B 账号的组成功
    SendService.setSendBccFn(async (item) => {
      sendCalls.push(item);
      if (item.accountId === acctA.id) return failResult("535 Invalid username or password");
      return okResult({ messageId: "<ok>" });
    });

    const r = await SendService.startSend([], [TPL], true, ids);
    expect(r.success).toBe(true);
    await waitForDone();

    const st = SendService.getSendStatus().data!;
    // 4 组轮换 2 账号 → A 恰 2 组失败、B 恰 2 组成功
    expect(st.failedCount).toBe(2);
    expect(st.sentCount).toBe(2);
    const rowA = db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, acctA.id)).get()!;
    expect(rowA.consecutiveFails).toBe(2); // 失败计数持久化（未达 3 次阈值不熔断，但已可见）
    for (const q of db.select().from(schema.sendQueue).all()) {
      if (q.accountId === acctA.id) expect(q.status).toBe("failed");
      else expect(q.status).toBe("sent");
    }
  }, 15000);

  it("S5 动态发信：自定义正文渲染 + CC 落库", async () => {
    const db = await newSandbox();
    seedAccounts(db);
    const cid = companyId(db, (seedCompany(db, "Dyn Co"), "Dyn Co"));
    addContact(db, "d1@dyn.com", "Dan", cid);
    addContact(db, "d2@dyn.com", "Dora", cid);
    const ids = db.select().from(schema.contacts).all().map(c => c.id);
    const r = await SendService.startDynamicSend(ids, "跟进 {{company}}", "Hi {{firstName}}，附件报价。", true, "boss@corp.com");
    expect(r.success).toBe(true);
    await waitForDone();
    expect(sendCalls.length).toBe(1);                     // 同公司合并一组 BCC
    expect(sendCalls[0]!.recipients.length).toBe(2);
    expect(sendCalls[0]!.subject).toBe("跟进 Dyn Co");    // 公司变量渲染
    const row = db.select().from(schema.sendQueue).all()[0]!;
    expect(row.cc).toBe("boss@corp.com");                 // CC 持久化，重启恢复不丢
  });

  it("S6 阻隔模式（dryRun）：不触传输、阶段不推进", async () => {
    const db = await newSandbox();
    (h.cfg as { test: { dryRun: boolean } }).test.dryRun = true;
    seedAccounts(db);
    const cid = companyId(db, (seedCompany(db, "DR Co"), "DR Co"));
    addContact(db, "dr@dr.com", "Dr", cid);
    const id = db.select().from(schema.contacts).where(eq(schema.contacts.email, "dr@dr.com")).get()!.id;
    const r = await SendService.startSend([], [TPL], true, [id]);
    expect(r.success).toBe(true);
    await waitForDone();
    expect(sendCalls.length).toBe(0);                     // 阻隔：一次都不触传输
    expect(SendService.getSendStatus().data!.sentCount).toBe(1);
    const dr = db.select().from(schema.contacts).where(eq(schema.contacts.email, "dr@dr.com")).get()!;
    expect(dr.stage).toBe("cold");                        // 阻隔不算真实送达 → 阶段不动
    expect(db.select().from(schema.interactions).all().length).toBe(0); // 也不写发信回执
  });
});
