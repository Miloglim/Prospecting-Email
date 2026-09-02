import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// import_contacts 端到端离线单测：用用户那条 Gianiree Reyes 真实走一遍
// 内存 SQLite + 真 contact.service 导入器（tsv），验证：
//   · 归一化（全名拆 first/last、邮箱小写、公司自动建并关联、阶段缺省、备注进 extra）
//   · 写库成功；再次导入 → 按邮箱去重、不覆盖、不产生重复行
//   · 无效邮箱被剔除、不写
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({ Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock("../../src/main/services/ai.service", () => ({
  summarizeEmail: vi.fn(async () => ({ success: true, data: { summary: "s", nextStep: "n" } })),
  generateBackcheckReport: vi.fn(), generateEmailDraft: vi.fn(), searchCompany: vi.fn(),
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
CREATE TABLE agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL, tool_name text NOT NULL,
  side_effect text NOT NULL, args_json text, result_json text, approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
function newSandbox(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  h.db = drizzle(raw, { schema });
}

type ToolLike = { invoke: (rc: unknown, input: string, details?: unknown) => Promise<string> };
const call = (t: ToolLike, args: unknown) => t.invoke({}, JSON.stringify(args));

const { buildHarnessTools, buildImportTsv } = await import("../../src/main/services/agent/tools");
const ctx = { conversationId: "imp-conv", counts: new Map<string, number>(), failures: new Map<string, number>() } as never;
let toolByName: Record<string, ToolLike> = {};

const GIANIRE = {
  name: "Gianiree Reyes", email: "Operaciones.Peru@gmail.com", company: "Acecargo Worldwide",
  country: "Peru", stage: "cold", note: "由 Johana 推荐",
};

describe("import_contacts 端到端", () => {
  beforeAll(async () => {
    SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    newSandbox();
    (ctx as { counts: Map<string, number> }).counts.clear();
    (ctx as { failures: Map<string, number> }).failures.clear();
    const all = buildHarnessTools(ctx) as unknown as ToolLike[];
    toolByName = Object.fromEntries(all.map(t => [(t as { name?: string }).name ?? "", t]));
  });

  const contacts = () => h.db.select().from(schema.contacts).all();
  const companies = () => h.db.select().from(schema.companies).all();

  it("导入 Gianiree：写 1 条、拆名、建并关联公司、备注进 extra", async () => {
    const msg = await call(toolByName["import_contacts"]!, { contacts: [GIANIRE] });
    expect(msg).toContain("新增 1");
    const rows = contacts();
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c.firstName).toBe("Gianiree");
    expect(c.lastName).toBe("Reyes");
    expect(c.email).toBe("operaciones.peru@gmail.com");        // 小写归一
    expect(c.country).toBe("Peru");
    expect(c.stage).toBe("cold");
    const comp = companies().find(x => x.id === c.companyId);
    expect(comp?.name).toBe("Acecargo Worldwide");              // 公司自动创建并关联
    expect(JSON.parse(String(c.extra)).note).toBe("由 Johana 推荐");
  });

  it("重复导入同一邮箱：跳过、不覆盖、不产生第二条", async () => {
    await call(toolByName["import_contacts"]!, { contacts: [GIANIRE] });
    (ctx as { counts: Map<string, number> }).counts.clear();      // 模拟新一轮（一轮一次是设计）
    const again = await call(toolByName["import_contacts"]!, { contacts: [{ ...GIANIRE, note: "改了也没用" }] });
    expect(again).toContain("跳过 1");
    const rows = contacts();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.extra)).note).toBe("由 Johana 推荐"); // 未被覆盖
  });

  it("无效邮箱被剔除不写；批内重复邮箱只留一条", async () => {
    const out = JSON.parse(JSON.stringify(buildImportTsv([
      { name: "Gianiree Reyes", email: "Operaciones.Peru@gmail.com", company: "Acecargo Worldwide" },
      { name: "Dup", email: "operaciones.peru@gmail.com" },        // 批内重复（大小写归一后）
      { name: "坏邮箱", email: "not-an-email" },                    // 无效
      { name: "缺邮箱", email: "" },                                // 无效
    ])));
    expect(out.count).toBe(1);                                     // 只剩 1 行有效且唯一
    expect(out.invalid).toHaveLength(2);
  });
});
