import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { rateQuotes } from "../../src/main/db/schema/rates";

// ═══════════════════════════════════════════════════════════════════
// quote_search 三源归一（闭环规范 §5.1-A）：customerTable 必须与 total/quotes 同源。
// 钉住用户实测的自相矛盾：镜像 total:0 / quotes:[]，customerTable 却由标准化层
// 塞出了报价行（该层无有效期/柜型过滤）——「共 0 条却显示有价」，还会被当真价引用。
// ═══════════════════════════════════════════════════════════════════

// 探测真源可达性：指向必然拒绝的端口 → 秒失败
process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";

const TMP = path.join(os.tmpdir(), "prospector-quote-table-test");
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

// 标准化层打桩：行内容由用例控制（真实 queryStandard 依赖 data/rates-standard.json，不可确定）。
// resolveQueryPod/podRawExpansion 等其余导出保持原样（镜像查询路径要用）。
const stdRowsMock = vi.fn<(word: string) => unknown[]>(() => []);
vi.mock("../../src/main/services/rates-standard", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    queryStandard: (word: string, opts?: unknown) => stdRowsMock(word),
    standardToMarkdown: (rows: unknown[]) => `|STD|${(rows as unknown[]).length}|`,
  };
});

const { buildHarnessTools } = await import("../../src/main/services/agent/tools");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type ToolLike = { invoke: (rc: unknown, input: string, details?: unknown) => Promise<string> };
const call = (t: ToolLike, args: unknown): Promise<string> => t.invoke({}, JSON.stringify(args));

const ctx = { conversationId: "qtc-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
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
  h.db.insert(rateQuotes).values([
    { recordId: "r-santos", pol: "宁波", podRaw: "SANTOS", lane: "南美东",
      carrier: "MSC", container: "40HQ", oceanUsd: 3200, validTo: "2099-12-31", syncedAt: new Date().toISOString() },
  ] as never).run();
}

const run = async (args: unknown) => JSON.parse(await call(T("quote_search"), args)) as {
  total?: number; count?: number; customerTable?: string; standardCount?: number; notice?: string;
};

describe("quote_search 三源归一（customerTable 与 total/quotes 同源）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    ctx.counts.clear(); ctx.failures.clear();
    stdRowsMock.mockReset();
    toolByName = Object.fromEntries((buildHarnessTools(ctx) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
    T = (name) => toolByName[name]!;
  });

  it("镜像命中 + 参考层有行 → 客户表用标准化透视表，total>0，无降级提示", async () => {
    stdRowsMock.mockReturnValue([{ pod: "SANTOS", ports: ["SANTOS"] }]);
    const r = await run({ pod: "SANTOS" });
    expect(r.total).toBeGreaterThan(0);
    expect(r.customerTable).toBe("|STD|1|");
    expect(r.notice).not.toContain("标准化参考层另有");
  });

  it("镜像未命中 + 参考层有行 → customerTable 强制为空，降级为参考提示（不许冒充结果）", async () => {
    stdRowsMock.mockReturnValue([{ pod: "MANZANILLO", ports: ["MANZANILLO"] }, { pod: "MANZANILLO", ports: ["MANZANILLO"] }]);
    const r = await run({ pod: "MANZANILLO" });
    expect(r.total).toBe(0);
    expect(r.customerTable).toBe("");
    expect(r.standardCount).toBe(2);                       // 参考层数量如实透出，但不是结果
    expect(r.notice).toContain("标准化参考层另有 2 条");
    expect(r.notice).toContain("不作为报价依据");
  });

  it("镜像未命中 + 参考层也无 → 干净的 0，无 standardCount 无降级提示", async () => {
    stdRowsMock.mockReturnValue([]);
    const r = await run({ pod: "VALPARAISO" });
    expect(r.total).toBe(0);
    expect(r.customerTable).toBe("");
    expect(r.standardCount).toBeUndefined();
    expect(r.notice).not.toContain("标准化参考层另有");
  });
});
