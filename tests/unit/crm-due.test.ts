import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// 「该跟进却没跟进」的唯一口径：显式提醒到期 + 沉默超期（>5 天没跟进）
// 回归背景：看板把超过 5 天没跟进的客户标红，而 reminders_due 只认显式提醒，
// 于是出现「看板明明有红、助手说没有到期」的自相矛盾。
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => null,
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
  cc text, my_role text, matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL, received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
const { checkReminders, listPipeline, SILENT_OVERDUE_DAYS } = await import("../../src/main/services/crm.service");

function newSandbox(): Driz {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  db.insert(schema.companies).values([{ name: "ACME Corp" }]).run();
  const acme = db.select().from(schema.companies).where(eq(schema.companies.name, "ACME Corp")).get()!.id;
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  db.insert(schema.contacts).values([
    // ① 无显式提醒，但 10 天没跟进 → 沉默超期（看板红）
    { email: "silent@acme.com", firstName: "Silent", lastName: "Hu", companyId: acme, status: "reached", tags: '["quoting"]', stage: "f2" },
    // ② 显式提醒设到昨天 → 提醒到期
    { email: "due@acme.com", firstName: "Due", lastName: "Date", companyId: acme, status: "reached", tags: '["reaching"]', stage: "f1",
      extra: JSON.stringify({ crmReminder: { nextFollowupAt: day(1) } }) },
    // ③ 显式提醒在 12 天后 → 不该出现在清单
    { email: "far@acme.com", firstName: "Far", lastName: "Away", companyId: acme, status: "reached", tags: '["reaching"]', stage: "f1",
      extra: JSON.stringify({ crmReminder: { nextFollowupAt: new Date(Date.now() + 12 * 86400000).toISOString() } }) },
    // ③b 没进 CRM 管线（status 非 reached）但设了过去的提醒 → 仍要在清单里
    { email: "offline@acme.com", firstName: "Off", lastName: "Line", companyId: acme, status: "", tags: '[]', stage: "cold",
      extra: JSON.stringify({ crmReminder: { nextFollowupAt: day(2) } }) },
    // ④ 今天刚跟进过 → 不该出现在清单
    { email: "fresh@acme.com", firstName: "Fresh", lastName: "Touch", companyId: acme, status: "reached", tags: '["reaching"]', stage: "f1" },
  ]).run();
  const id = (email: string) => db.select().from(schema.contacts).where(eq(schema.contacts.email, email)).get()!.id;
  db.insert(schema.interactions).values([
    { contactId: id("silent@acme.com"), type: "note", direction: "outbound", channel: "email", bodyPreview: "已发报价", createdAt: day(10) },
    { contactId: id("fresh@acme.com"), type: "note", direction: "outbound", channel: "email", bodyPreview: "刚通完电话", createdAt: day(0) },
  ]).run();
  return db;
}

describe("跟进到期判定（看板红点与 reminders_due 同一口径）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => { newSandbox(); });

  it("沉默超过 5 天的客户算逾期（此前只有显式提醒才算，导致看板红、助手说没到期）", () => {
    const r = checkReminders();
    expect(r.success).toBe(true);
    if (!r.success) return;
    const emails = r.data.overdue.map(c => c.email);
    expect(emails).toContain("silent@acme.com");
    expect(emails).toContain("due@acme.com");        // 显式提醒到期同样在列
    expect(emails).not.toContain("far@acme.com");
    expect(emails).not.toContain("fresh@acme.com");
  });

  it("管线数据带 staleDays/overdue，看板不必自己算天数", () => {
    const pipe = listPipeline();
    expect(pipe.success).toBe(true);
    if (!pipe.success) return;
    const flat = pipe.data.flatMap(s => s.contacts);
    const silent = flat.find(c => c.email === "silent@acme.com")!;
    const fresh = flat.find(c => c.email === "fresh@acme.com")!;
    expect(silent.staleDays).toBeGreaterThanOrEqual(SILENT_OVERDUE_DAYS);
    expect(silent.overdue).toBe(true);
    expect(fresh.overdue).toBe(false);
  });

  it("没进 CRM 管线的联系人只要设了提醒就不该被漏掉", () => {
    const r = checkReminders();
    if (!r.success) throw new Error("checkReminders 失败");
    expect(r.data.overdue.map(c => c.email)).toContain("offline@acme.com");
  });

  it("逾期按沉默时长从久到近排（「逾期最久的那位」有确定答案）", () => {
    const r = checkReminders();
    if (!r.success) throw new Error("checkReminders 失败");
    const stale = r.data.overdue.map(c => c.staleDays ?? -1);
    expect(stale).toEqual([...stale].sort((a, b) => b - a));
  });
});
