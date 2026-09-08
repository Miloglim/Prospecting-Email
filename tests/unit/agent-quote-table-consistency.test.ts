import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { rateQuotes } from "../../src/main/db/schema/rates";

// ═══════════════════════════════════════════════════════════════════
// quote_search 三源归一（闭环规范 §5.1-A）：两张表都必须与 total/quotes 同源。
// 钉住用户实测的自相矛盾：镜像 total:0 / quotes:[]，表却由标准化层塞出了报价行
// （该层无有效期/柜型过滤）——「共 0 条却显示有价」，还会被当真价引用。
// 两表分离（用户定案）：userTable=中文带来源给用户；customerTable=唯一出口英文十一列，
// 内部备注判丢、绝不混中文。
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

// 标准化参考层已退役（规范 docs/rates-answer-chain-spec.md §5-4）：两张表现在只有一个来源——
// 镜像行经 rates-clean 清洗透视。这里不再打桩 rates-standard，只锁结果。

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
    // 港级行：pod_raw 就是具体港
    { recordId: "r-santos", pol: "宁波", podRaw: "SANTOS", lane: "南美东",
      carrier: "MSC", container: "40HQ", oceanUsd: 3200, validFrom: "2026-09-01", validTo: "2099-12-31",
      note: "含 EBS", sourceGroup: "宁波舱位滚动更新群", sender: "张三 13800000000", syncedAt: new Date().toISOString() },
    // 航线级行：pod_raw 是航线名，只有 L2（航线展开）才捞得到
    { recordId: "r-caribbean", pol: "厦门", podRaw: "加勒比", lane: "加勒比",
      carrier: "HMM", container: "40HQ", oceanUsd: 2500, validTo: "2099-12-31",
      syncedAt: new Date().toISOString() },
  ] as never).run();
}

const run = async (args: unknown) => JSON.parse(await call(T("quote_search"), args)) as {
  total?: number; count?: number; userTable?: string; customerTable?: string;
  standardCount?: number; notice?: string; actions?: Array<{ label: string }>;
};

describe("quote_search 两表同源与两段查询（规范 rates-answer-chain-spec §2/§3）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    freshDb();
    ctx.counts.clear(); ctx.failures.clear();
    toolByName = Object.fromEntries((buildHarnessTools(ctx) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
    T = (name) => toolByName[name]!;
  });

  it("L1 精准港命中 → userTable 是 12 列中文工作表（出处三列必备），未同意不出客户表", async () => {
    const r = await run({ pod: "SANTOS" });
    expect(r.total).toBeGreaterThan(0);
    expect((r.userTable ?? "").split("\n")[0]).toBe(
      "| 船司 | 起运港 | 目的港 | 20GP | 40HQ/HC | 40NOR | 目免 | 有效期 | 备注 | 来源 | 发送人 | 入库时间 |");
    expect(r.userTable).toContain("MSC");
    expect(r.userTable).toContain("宁波舱位滚动更新群");   // 来源（信息出处，用户点名要的三列之一）
    expect(r.userTable).toMatch(/\d{1,2} Sep/);            // 有效期格式化后仍在（1 Sep – 31 Dec）
    expect(r.customerTable).toBe("");                     // 没同意做成客户报价表 → 不生成
    expect((r.actions ?? []).map(a => a.label)).toContain("做成客户报价表");
    expect(r.standardCount).toBeUndefined();              // 参考层已退役
    expect(r.notice).not.toContain("标准化参考层");
  });

  it("国别/区域词 q=巴西 → regionLanes 扩展命中纯英文港行（SANTOS 不含「巴西」字样也不漏）", async () => {
    const r = await run({ q: "巴西" });
    expect(r.total).toBeGreaterThan(0);
    expect((r.quotes ?? []).some(q => q.podRaw === "SANTOS")).toBe(true);
  });

  it("pod=巴西 同样走区域扩展（不因 pod 字面收窄漏掉 SANTOS）", async () => {
    const r = await run({ pod: "巴西" });
    expect(r.total).toBeGreaterThan(0);
    expect((r.quotes ?? []).some(q => q.podRaw === "SANTOS")).toBe(true);
  });

  it("forCustomer=true（用户点头）→ 英文十一列对外表，且一个汉字都不许有", async () => {
    const r = await run({ pod: "SANTOS", forCustomer: true });
    expect((r.customerTable ?? "").split("\n")[0]).toBe(
      "| CARRIER | POL | POD | 20GP | 40HQ/HC | 40NOR | FT | ETD | VALIDITY | TT | REMARK |");
    expect(r.customerTable).toContain("MSC");
    expect(r.customerTable).toContain("SANTOS");
    expect(r.customerTable).not.toMatch(/[一-鿿]/);
    expect((r.actions ?? []).map(a => a.label)).not.toContain("做成客户报价表");   // 已经出过了
  });

  it("L1 没有该具体港的价 → L2 按航线展开命中，并明确标注是航线级报价", async () => {
    const r = await run({ pod: "VERACRUZ" });        // 港级行里没有 VERACRUZ
    expect(r.total).toBeGreaterThan(0);              // 靠航线级（加勒比）捞回来
    expect(r.notice).toContain("航线级");
    expect(r.userTable).toContain("加勒比");         // 工作表保留原样，让操作者看出是航线级
  });

  it("航线级命中做对外表时 POD 展开成查询目标港（客户表里不能出现中文航线名）", async () => {
    const r = await run({ pod: "VERACRUZ", forCustomer: true });
    expect(r.customerTable).toContain("VERACRUZ");
    expect(r.customerTable).not.toMatch(/[一-鿿]/);
  });

  it("两段都查不到 → 两张表强制为空（治「共 0 条却显示有价」），走定论口径", async () => {
    const r = await run({ pod: "NOSUCHPORTXYZ" });
    expect(r.total).toBe(0);
    expect(r.userTable).toBe("");
    expect(r.customerTable).toBe("");
    expect(r.standardCount).toBeUndefined();
    expect(r.notice).not.toContain("标准化参考层");
    expect(r.notice).toMatch(/查不到|没有/);
  });
});
