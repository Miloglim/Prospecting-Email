import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// search_contacts 结构化筛选（冷开发按前置条件精确圈人，治"给了条件还全量扫"）。
// 筛选走统一 CTE 选择器（getRawDb），这里给 sql.js 套一个 better-sqlite3 风格的
// prepare().all(...params) shim，让 CTE 真跑起来。
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
vi.mock("../../src/main/services/ai.service", () => ({
  summarizeEmail: vi.fn(), generateEmailDraft: vi.fn(), generateEmailReply: vi.fn(),
  generateBackcheckReport: vi.fn(), searchCompany: vi.fn(),
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
CREATE TABLE agent_conversations (
  id text PRIMARY KEY NOT NULL, title text DEFAULT '新对话' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL,
  role text NOT NULL, content text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL, tool_name text NOT NULL,
  side_effect text NOT NULL, args_json text, result_json text, approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_working_memory (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL,
  kind text NOT NULL, ref_id text NOT NULL, tool_name text NOT NULL,
  context_line text NOT NULL, payload_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");   // interactions 用 SQL 格式
const isoTs = (d: Date) => d.toISOString();                                  // inbox 用 ISO 格式

function newSandbox(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  h.raw = raw;
  h.db = drizzle(raw, { schema });
  const db = h.db;
  db.insert(schema.companies).values([
    { name: "Brazil Furniture", industry: "家具制造", country: "Brazil" },   // id 1
    { name: "Mexico Textiles", industry: "纺织", country: "Mexico" },        // id 2
  ]).run();
  db.insert(schema.contacts).values([
    { email: "ana@brazilfurn.com", firstName: "Ana", companyId: 1, country: "Brazil", stage: "cold", phone: "55" },   // 1 巴西冷客户 有电话
    { email: "bruno@brazilfurn.com", firstName: "Bruno", companyId: 1, country: "Brazil", stage: "f1" },              // 2 巴西 f1
    { email: "carlos@textiles.mx", firstName: "Carlos", companyId: 2, country: "Mexico", stage: "cold" },            // 3 墨西哥冷
    { email: "dead@no.email", firstName: "Placeholder", companyId: 1, country: "Brazil", stage: "cold" },            // 4 占位邮箱
  ]).run();
  // 沉默数据：#1 最近互动 60 天前（SQL 格式）；#2 5 天前（ISO 格式，走 inbox）；#3/#4 从未
  db.insert(schema.interactions).values([
    { contactId: 1, type: "note", direction: "out", createdAt: sqlTs(daysAgo(60)) },
  ]).run();
  db.insert(schema.inboxMessages).values([
    { accountId: 1, fromEmail: "bruno@brazilfurn.com", matchedContactId: 2, receivedAt: isoTs(daysAgo(5)), classification: "reply" },
  ]).run();
}

type ToolLike = { invoke: (rc: unknown, input: string) => Promise<string> };
const call = (t: ToolLike, args: unknown): Promise<string> => t.invoke({}, JSON.stringify(args));
const { buildHarnessTools } = await import("../../src/main/services/agent/tools");
const ctx = { conversationId: "cf-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
let T: Record<string, ToolLike> = {};

const run = async (args: unknown) => JSON.parse(await call(T["search_contacts"]!, args)) as {
  ok?: boolean; results?: Array<{ id: number; name: string; country: string | null; stage: string | null; email: string }>;
  total?: number; filtersApplied?: string[]; error?: { code: string; message: string };
};

describe("search_contacts 结构化筛选", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    newSandbox();
    ctx.counts.clear(); ctx.failures.clear();
    T = Object.fromEntries((buildHarnessTools(ctx) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
  });

  it("country 筛选：只回巴西的", async () => {
    const r = await run({ country: "Brazil" });
    expect(r.total).toBe(3);   // ana/bruno/dead（占位也是巴西，未加 validEmail）
    expect(r.results!.every(c => c.country === "Brazil")).toBe(true);
    expect(r.filtersApplied).toContain("国家~Brazil");
  });

  it("country + stage 组合：巴西冷客户", async () => {
    const r = await run({ country: "Brazil", stage: "cold" });
    expect(r.results!.map(c => c.id).sort()).toEqual([1, 4]);
    expect(r.filtersApplied).toEqual(expect.arrayContaining(["国家~Brazil", "阶段=cold"]));
  });

  it("stage 认中文别名 冷开发=cold", async () => {
    const r = await run({ stage: "冷开发" });
    expect(r.results!.every(c => c.stage === "cold")).toBe(true);
    expect(r.total).toBe(3);
  });

  it("stage 非法值 → bad_filter 当面纠错，不静默降级", async () => {
    const r = await run({ stage: "VIP" });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("bad_filter");
    expect(r.error!.message).toContain("cold / f1");
  });

  it("industry 筛选：按公司行业", async () => {
    const r = await run({ industry: "家具" });
    expect(r.results!.every(c => c.country === "Brazil")).toBe(true);   // 家具制造=巴西那家
    expect(r.total).toBe(3);
  });

  it("validEmail：排除 @no.email 占位", async () => {
    const r = await run({ country: "Brazil", validEmail: true });
    expect(r.results!.map(c => c.id).sort()).toEqual([1, 2]);   // dead@no.email 被排除
    expect(r.results!.some(c => c.email.includes("no.email"))).toBe(false);
  });

  it("silenceDays：混合格式(ISO/SQL)归一到日期粒度比较", async () => {
    const r = await run({ silenceDays: 30 });
    const ids = r.results!.map(c => c.id).sort();
    expect(ids).toEqual([1, 3, 4]);   // #1(60天前) #3#4(从未) 入选；#2(5天前) 排除
  });

  it("纯筛选无关键词也能查（query 可选）；total 反映筛选后真命中", async () => {
    const r = await run({ stage: "f1" });
    expect(r.total).toBe(1);
    expect(r.results![0]!.name).toBe("Bruno");
  });

  it("无任何条件 → no_criteria，拒绝全库扫", async () => {
    const r = await run({});
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("no_criteria");
  });

  it("关键词路径不受影响（向后兼容）", async () => {
    const r = await run({ query: "Ana" });
    expect(r.total).toBe(1);
    expect(r.results![0]!.name).toBe("Ana");
  });
});

describe("search_contacts 国家别名与发送状态（2026-09-08 数据归一后的两个活 bug 回归）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    newSandbox();
    ctx.counts.clear(); ctx.failures.clear();
    T = Object.fromEntries((buildHarnessTools(ctx) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
  });

  it("country 中文「巴西」命中英文写法 Brazil（归一后 country 全为英文，中文 LIKE 曾返回 0 条）", async () => {
    const r = await run({ country: "巴西" });
    expect(r.total).toBe(3);
    expect(r.results!.every(c => c.country === "Brazil")).toBe(true);
    expect(r.filtersApplied).toContain("国家~巴西");
  });

  it("country 中文别名可与 stage 组合：「巴西」的冷客户", async () => {
    const r = await run({ country: "巴西", stage: "cold" });
    expect(r.results!.map(c => c.id).sort()).toEqual([1, 4]);
  });

  it("country 对照表外的词原样 LIKE，不猜别名", async () => {
    const r = await run({ country: "危地马拉" });
    expect(r.total).toBe(0);
  });

  it("status:reached 只回已触达（「status 等于已触达」从此有了直接表达）", async () => {
    h.raw.run("UPDATE contacts SET status='reached' WHERE id=1");
    h.raw.run("UPDATE contacts SET status='replied' WHERE id=2");
    const r = await run({ status: "reached" });
    expect(r.results!.map(c => c.id)).toEqual([1]);
    expect(r.filtersApplied).toContain("状态=已触达");
  });

  it("status 认中文别名：已回复", async () => {
    h.raw.run("UPDATE contacts SET status='replied' WHERE id=2");
    const r = await run({ status: "已回复" });
    expect(r.results!.map(c => c.id)).toEqual([2]);
  });

  it("status:none 哨兵筛空状态（未触达 = 空串或 NULL）", async () => {
    h.raw.run("UPDATE contacts SET status='replied' WHERE id=2");
    const r = await run({ status: "未触达" });
    expect(r.results!.map(c => c.id).sort()).toEqual([1, 3, 4]);
  });

  it("status 非法值 → bad_filter 当面纠错", async () => {
    const r = await run({ status: "active" });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("bad_filter");
    expect(r.error!.message).toContain("reached");
  });

  it("country + status 组合：巴西的已触达客户", async () => {
    h.raw.run("UPDATE contacts SET status='reached' WHERE id=1");
    h.raw.run("UPDATE contacts SET status='reached' WHERE id=3");   // 墨西哥的已触达，不该入选
    const r = await run({ country: "巴西", status: "已触达" });
    expect(r.results!.map(c => c.id)).toEqual([1]);
  });
});
