import { describe, it, expect, vi, beforeAll } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// 中断批次启动自动续跑（2026-09-08「退出后又要重新加入队列」回归）：
//   · 批次真实启动时写 config.runningBatch、结束/取消时清除；
//   · 退出/崩溃后标志残留 → 启动 autoResumeInterruptedBatch 自动续跑，
//     语义与队列页手动「开始发送」一致（配额守卫/时段等待都在链路里）；
//   · 两步式手动入队（autoStart=false）不写标志 → 重启不被误自动启动。
//   dryRun 配置下 runBatchLoop 首轮无 await，同步跑完 —— 断言确定性有保障。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz, cfg: null as Record<string, unknown> };

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
  id text PRIMARY KEY NOT NULL, batch_id text NOT NULL, campaign_id text,
  company_name text, company_id integer, recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  send_mode text DEFAULT 'bcc' NOT NULL,
  status text DEFAULT 'pending' NOT NULL, error text, sent_at text,
  tpl_name text, country text, language text, cc text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type SendService = typeof import("../../src/main/services/send.service");
let S: SendService;

/** 模拟一次干净重启：全新内存库 + 全新 send.service 模块实例 */
async function restartWith(opts: {
  rows: Array<{ id: string; status: string }>;
  runningBatch?: { batchId: string; startedAt: string } | null;
}): Promise<void> {
  const raw = new SQLLIB.Database();
  raw.run(DDL);
  h.db = drizzle(raw, { schema });
  h.cfg = {
    fromName: "Sandbox", schedule: { timeWindowEnabled: true, startHour: 9, endHour: 8, groupSize: 20, groupDelayMinSeconds: 0, groupDelayMaxSeconds: 0 },
    test: { email: "self@test.local", company: "Test Co", enabled: true, dryRun: true },
    crm: { followupDays: {}, todoAdvanceDays: 2, autoArchiveDays: 30 },
    sendQuota: { dailyLimit: 0, firstSendAt: null, sentToday: 0 },
    runningBatch: opts.runningBatch ?? null,
  };
  const db = h.db;
  db.insert(schema.emailAccounts).values({ email: "sender@test.local", encryptedPass: "x" } as never).run();
  for (const r of opts.rows) {
    db.insert(schema.sendQueue).values({
      id: r.id, batchId: "batch-ab12cd34",
      recipients: JSON.stringify([{ contactId: 1, email: "a@b.c", name: "A" }]),
      accountId: 1, status: r.status, createdAt: new Date().toISOString(),
    }).run();
  }
  vi.resetModules();
  S = await import("../../src/main/services/send.service");
  S.setSaveConfigFn(c => { h.cfg = c as Record<string, unknown>; }); // 与生产 registerSendIPC 同款注入
}

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

describe("中断批次启动自动续跑", () => {
  it("退出时批次在跑：启动后自动续跑（dryRun 发完、标志清掉、不再卡 running）", async () => {
    await restartWith({
      rows: [{ id: "g1", status: "sent" }, { id: "g2", status: "pending" }],
      runningBatch: { batchId: "batch-ab12cd34", startedAt: new Date().toISOString() },
    });
    S.autoResumeInterruptedBatch();

    const st = S.getSendStatus();
    expect(st.data!.batchId).toBe("batch-ab12cd34");
    // resumeQueue 先按 DB 派生 sentCount=1（g1），循环又把 g2 发出 → 最终 2/2
    expect(st.data!.totalItems).toBe(2);
    expect(st.data!.sentCount).toBe(2);
    expect(st.data!.isRunning).toBe(false);           // dryRun 同步跑完
    expect(h.cfg.runningBatch).toBeNull();            // 结束即清标志，重启不再触发
    const q = S.getQueueItems();
    expect(q.data!.find(i => i.id === "g2")!.status).toBe("sent"); // pending 行确实被续跑发出
  });

  it("两步式手动入队（无标志）：重启不误自动启动，pending 原样保留", async () => {
    await restartWith({ rows: [{ id: "g1", status: "pending" }], runningBatch: null });
    S.autoResumeInterruptedBatch();

    expect(S.getSendStatus().data!.isRunning).toBe(false);
    expect(h.cfg.runningBatch).toBeNull();
    expect(S.getQueueItems().data!.find(i => i.id === "g1")!.status).toBe("pending");
  });

  it("标志残留但队列无 pending 行（批次其实已完成）：不启动、标志清掉不残留", async () => {
    await restartWith({
      rows: [{ id: "g1", status: "sent" }],
      runningBatch: { batchId: "batch-ab12cd34", startedAt: new Date().toISOString() },
    });
    S.autoResumeInterruptedBatch();

    expect(S.getSendStatus().data!.isRunning).toBe(false);
    expect(h.cfg.runningBatch).toBeNull();
  });
});
