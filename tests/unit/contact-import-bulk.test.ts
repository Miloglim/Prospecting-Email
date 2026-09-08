import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// 批量导入管线回归（2026-09-08「一次导 1500+ 联系人后整程序冻死」）：
//   · 520 行跨过 500 分块边界 → 验证分块取回 id 后回填不丢人
//   · 同名公司只建一次（Map 命中复用）
//   · 收件箱回填语义与单联系人版逐字一致：只认领未认领邮件、
//     事件/退信匹配防重、不抢已属于别人的邮件
//   · linkInboxForContacts 幂等：重复调用不产生重复事件
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz, raw: null as unknown as SqlJsDatabase };

function rawShim(raw: SqlJsDatabase) {
  return {
    prepare(sql: string) {
      const all = (...params: unknown[]) => {
        const st = raw.prepare(sql);
        if (params.length) st.bind(params as never);
        const out: unknown[] = [];
        while (st.step()) out.push(st.getAsObject());
        st.free();
        return out;
      };
      return { all, get: (...params: unknown[]) => (all(...params)[0] ?? null) };
    },
    // sql.js 内存库无并发，测试里事务退化为直跑（语义防重靠断言保证）。
    // better-sqlite3 的 transaction(fn) 返回包装函数，shim 保持同形。
    transaction: (fn: () => void) => () => fn(),
  };
}

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => rawShim(h.raw),
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const DDL = `
CREATE TABLE companies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL, domain text, industry text,
  country text, size text, backcheck_data text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE, company_id integer,
  first_name text, last_name text, title text, phone text, linkedin text, country text,
  client_type text, language text, stage text DEFAULT 'cold', status text DEFAULT '', tags text,
  extra text DEFAULT '{}', assignee text DEFAULT '', source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE interactions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, contact_id integer NOT NULL, type text NOT NULL,
  direction text NOT NULL, channel text DEFAULT 'email' NOT NULL, subject text, body_preview text,
  message_id text, account_id integer, metadata text, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, account_id integer NOT NULL, message_id text,
  from_email text NOT NULL, from_name text, subject text, body_preview text, classification text,
  intent text, "to" text, cc text, my_role text, matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL, received_at text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE inbox_bounce_matches (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, message_id integer NOT NULL, contact_id integer NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, UNIQUE(message_id, contact_id));
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
const N = 520;   // > 500 分块边界

function buildCsv(): string {
  const lines = ["Email,Company,Name,Stage"];
  for (let i = 0; i < N; i++) lines.push(`bulk${i}@co${i % 20}.test,Company ${i % 20},User ${i},冷开发`);
  lines.push("bulkdup@old.test,Old Co,Dup,冷开发");   // 已在库 → skipped
  lines.push(",Ghost Co,Ghost,冷开发");                 // 空邮箱 → skipped
  return lines.join("\n");
}

function newSandbox(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  h.raw = raw;
  h.db = drizzle(raw, { schema });
  const db = h.db;
  db.insert(schema.contacts).values([
    { email: "bulkdup@old.test", firstName: "Dup", stage: "cold" },
  ]).run();
  // 存量邮件：m1/m2 待认领；m3 与导入无关；m4 已属于别人(999)不得抢；m5 属于第 2 块的联系人
  db.insert(schema.inboxMessages).values([
    { accountId: 1, messageId: "m1", fromEmail: "bulk1@co1.test", classification: "replied", receivedAt: new Date().toISOString() },
    { accountId: 1, messageId: "m2", fromEmail: "bulk2@co2.test", classification: "bounce", receivedAt: new Date().toISOString() },
    { accountId: 1, messageId: "m3", fromEmail: "stranger@x.test", classification: "replied", receivedAt: new Date().toISOString() },
    { accountId: 1, messageId: "m4", fromEmail: "bulk3@co3.test", classification: "replied", matchedContactId: 999, receivedAt: new Date().toISOString() },
    { accountId: 1, messageId: "m5", fromEmail: `bulk${N - 5}@co15.test`, classification: "autoreply", receivedAt: new Date().toISOString() },
  ]).run();
}

const mapping = { Email: "email", Company: "companyName", Name: "firstName", Stage: "stage" };

const allRows = (table: string) => rawShim(h.raw).prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
const qOne = (sql: string, ...params: unknown[]) => rawShim(h.raw).prepare(sql).get(...params) as Record<string, unknown> | null;

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

describe("批量导入：单事务 + 公司去重 + 分块取 id（1500+ 冻死回归）", () => {
  let importContacts: typeof import("../../src/main/services/contact.service").importContacts;
  beforeAll(async () => {
    ({ importContacts } = await import("../../src/main/services/contact.service"));
  });
  beforeEach(newSandbox);

  it("520 行全量入库、跳过重复与空邮箱、同名公司只建一次", async () => {
    const r = await importContacts({ mode: "execute", type: "csv", data: buildCsv(), mapping });
    expect(r.success).toBe(true);
    expect((r as { data: { imported: number; skipped: number } }).data).toEqual({ imported: N, skipped: 2 });

    const contacts = allRows("contacts");
    expect(contacts.length).toBe(N + 1);   // 520 新 + 1 旧

    const companies = allRows("companies").filter(c => String(c.name).startsWith("Company"));
    expect(companies.length).toBe(20);     // 520 行只建了 20 家公司，同名全复用
    const byName = new Map(companies.map(c => [String(c.name), Number(c.id)]));
    const bulk = contacts.filter(c => /^bulk\d+@co\d+\.test$/.test(String(c.email)));
    expect(bulk.length).toBe(N);
    for (const c of bulk) {
      const idx = Number(String(c.email).match(/bulk\d+@co(\d+)\.test/)![1]);
      expect(c.company_id).toBe(byName.get(`Company ${idx}`));
      expect(c.stage).toBe("cold");        // 「冷开发」翻译到位
      expect(c.first_name).toMatch(/^User \d+$/);
    }
  });

  it("收件箱批量回填：认领正确的邮件、不抢别人的、跨 500 分块不丢人、补事件与退信匹配", async () => {
    await importContacts({ mode: "execute", type: "csv", data: buildCsv(), mapping });

    const idOf = (email: string) => Number(qOne("SELECT id FROM contacts WHERE email = ?", email)!.id);
    const msgs = allRows("inbox_messages");
    const byMid = new Map(msgs.map(m => [String(m.message_id), m]));

    expect(byMid.get("m1")!.matched_contact_id).toBe(idOf("bulk1@co1.test"));          // replied 认领
    expect(byMid.get("m2")!.matched_contact_id).toBe(idOf("bulk2@co2.test"));          // bounce 认领
    expect(byMid.get("m5")!.matched_contact_id).toBe(idOf(`bulk${N - 5}@co15.test`));  // 第 2 块的联系人照样回填
    expect(byMid.get("m3")!.matched_contact_id).toBeNull();                            // 无关邮件不动
    expect(byMid.get("m4")!.matched_contact_id).toBe(999);                             // 已属于别人，不抢

    const events = allRows("interactions");
    expect(events.filter(e => e.type === "replied").length).toBe(1);
    expect(events.filter(e => e.type === "bounced").length).toBe(1);
    expect(events.filter(e => e.type === "autoreply").length).toBe(1);

    const bounces = allRows("inbox_bounce_matches");
    expect(bounces.length).toBe(1);
    expect(Number(bounces[0]!.contact_id)).toBe(idOf("bulk2@co2.test"));
  });

  it("linkInboxForContacts 幂等：重复回填不产生重复事件/退信匹配", async () => {
    await importContacts({ mode: "execute", type: "csv", data: buildCsv(), mapping });
    const { linkInboxForContacts } = await import("../../src/main/services/inbox-link");

    const entries = (allRows("contacts") as Array<{ id: number; email: string }>)
      .filter(c => c.email.startsWith("bulk"))
      .map(c => ({ contactId: c.id, email: c.email }));
    const claimedAgain = linkInboxForContacts(entries);
    expect(claimedAgain).toBe(0);   // 已认领的不重复认领
    expect(allRows("interactions").length).toBe(3);
    expect(allRows("inbox_bounce_matches").length).toBe(1);
  });

  it("重复执行同一份导入：全跳过、库不膨胀", async () => {
    const data = buildCsv();
    await importContacts({ mode: "execute", type: "csv", data, mapping });
    const r2 = await importContacts({ mode: "execute", type: "csv", data, mapping });
    expect((r2 as { data: { imported: number } }).data.imported).toBe(0);
    expect(allRows("contacts").length).toBe(N + 1);
    expect(allRows("companies").filter(c => String(c.name).startsWith("Company")).length).toBe(20);
  });
});
