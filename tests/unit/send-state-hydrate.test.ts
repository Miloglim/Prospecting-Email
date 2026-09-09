import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// 发送状态重启水合（2026-09-08「退出后发送状态缓存掉了，又要重新入队」回归）：
//   · 队列项有 getQueueItems 的 DB 兜底，但 进度/批次号/已发/失败 是纯内存 ——
//     重启后不水合，头部就显示 0/0、无批次号，用户只能重新入队；
//     而重新入队会整表清掉旧批次，数据才真的没了。
//   · 每个用例 resetModules + 动态 import，模拟一次干净重启。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz, raw: null as unknown as SqlJsDatabase, cfg: null as Record<string, unknown> };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => ({
    prepare: (_sql: string) => ({ all: () => [], get: () => null }),
    transaction: (fn: () => void) => () => fn(),
  }),
}));
vi.mock("../../src/main/config", () => ({
  DEFAULT_SCHEDULE: { timeWindowEnabled: true, startHour: 9, endHour: 8, groupSize: 20, groupDelayMinSeconds: 0, groupDelayMaxSeconds: 0 },
  loadConfig: () => h.cfg,
  saveConfig: () => {},
  APP_ROOT: "/tmp/sandbox",
  DB_PATH: "/tmp/sandbox/db",
  getResourcesRoot: () => "/tmp/sandbox/assets",
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/services/inbox.service", () => ({
  writeBodyForLastInsert: async () => {},
}));

const DDL = `
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
CREATE TABLE send_queue (
  id text PRIMARY KEY NOT NULL, batch_id text NOT NULL,
  company_name text, company_id integer, recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  status text DEFAULT 'pending' NOT NULL, error text, sent_at text,
  tpl_name text, country text, language text, cc text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type SendService = typeof import("../../src/main/services/send.service");
let S: SendService;

/** 模拟一次干净重启：全新内存库 + 全新 send.service 模块实例（模块级 state/stateHydrated 归零） */
async function restartWith(rows: Array<{ id: string; status: string; batchId?: string }>): Promise<void> {
  const raw = new SQLLIB.Database();
  raw.run(DDL);
  h.raw = raw;
  h.db = drizzle(raw, { schema });
  h.cfg = {
    fromName: "Sandbox", schedule: { timeWindowEnabled: true, startHour: 9, endHour: 8, groupSize: 20, groupDelayMinSeconds: 0, groupDelayMaxSeconds: 0 },
    test: { email: "self@test.local", company: "Test Co", enabled: true, dryRun: false },
    crm: { followupDays: {}, todoAdvanceDays: 2, autoArchiveDays: 30 },
    sendQuota: { dailyLimit: 0, firstSendAt: null, sentToday: 0 },
  };
  const db = h.db;
  for (const r of rows) {
    db.insert(schema.sendQueue).values({
      id: r.id, batchId: r.batchId ?? "batch-ab12cd34",
      recipients: JSON.stringify([{ contactId: 1, email: "a@b.c", name: "A" }]),
      accountId: 1, status: r.status, createdAt: new Date().toISOString(),
    }).run();
  }
  vi.resetModules();
  S = await import("../../src/main/services/send.service");
}

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

describe("发送状态重启水合", () => {
  beforeEach(() => { /* restartWith 在各用例内显式调用，意图更清楚 */ });

  it("中断批次：重启后首个状态查询即水合 进度/批次号，队列项走 DB 兜底（321 组待发场景）", async () => {
    await restartWith([
      { id: "g1", status: "sent" }, { id: "g2", status: "sent" },
      { id: "g3", status: "failed" },
      { id: "g4", status: "pending" }, { id: "g5", status: "pending" }, { id: "g6", status: "pending" },
      { id: "g7", status: "sending" },   // 退出时正在发 → 重启必须修正为 pending
    ]);

    const st = S.getSendStatus();
    expect(st.success).toBe(true);
    expect(st.data!.batchId).toBe("batch-ab12cd34");
    expect(st.data!.totalItems).toBe(7);
    expect(st.data!.sentCount).toBe(2);
    expect(st.data!.failedCount).toBe(1);
    expect(st.data!.isRunning).toBe(false);

    const q = S.getQueueItems();
    expect(q.success).toBe(true);
    expect(q.data!.length).toBe(7);
    // sending → pending 修正生效（含 DB 落库），前端 canResume 据此亮出「开始发送」
    expect(q.data!.filter(i => i.status === "pending").length).toBe(4);
    expect(q.data!.find(i => i.id === "g7")!.status).toBe("pending");
  });

  it("空表（无批次）：保持默认 0/0、无批次号，不误报", async () => {
    await restartWith([]);
    const st = S.getSendStatus();
    expect(st.data!.batchId).toBeNull();
    expect(st.data!.totalItems).toBe(0);
    expect(S.getQueueItems().data).toEqual([]);
  });

  it("水合只跑一次：水合后库里再进数据，状态不被回写覆盖（活批次的进度归引擎管）", async () => {
    await restartWith([{ id: "g1", status: "sent" }, { id: "g2", status: "pending" }]);
    const first = S.getSendStatus();
    expect(first.data!.totalItems).toBe(2);

    // 水合后新插入 3 行（模拟批次进行中 DB 变化），状态不得被水合回滚
    h.db.insert(schema.sendQueue).values([
      { id: "g3", batchId: "batch-ab12cd34", recipients: "[]", accountId: 1, status: "pending", createdAt: new Date().toISOString() },
      { id: "g4", batchId: "batch-ab12cd34", recipients: "[]", accountId: 1, status: "pending", createdAt: new Date().toISOString() },
      { id: "g5", batchId: "batch-ab12cd34", recipients: "[]", accountId: 1, status: "sent", createdAt: new Date().toISOString() },
    ]).run();

    const second = S.getSendStatus();
    expect(second.data!.totalItems).toBe(2);   // 仍是水合时的口径
    expect(second.data!.sentCount).toBe(1);
  });
});
