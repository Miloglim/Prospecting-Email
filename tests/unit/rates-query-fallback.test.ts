import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { rateQuotes } from "../../src/main/db/schema/rates";

// ═══════════════════════════════════════════════════════════════════
// 运价查询三段式（规范 docs/rates-query-fallback-spec.md）
// 钉住用户实测翻车的那句回答：问「地东的价格」被答成「镜像库暂无该航线报价」。
// L1 机械层跨字段并集、L2 空结果回候选让模型换词重试、L3 两轮不过才定论。
// ═══════════════════════════════════════════════════════════════════

// 探测真源可达性用得到：指向必然拒绝的端口 → 秒失败，测试不等 3 秒超时
process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";

const TMP = path.join(os.tmpdir(), "prospector-rates-query-test");
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

const { stripLaneTag, mapRemoteRow, listQuotes, countQuotes, quoteOptions } =
  await import("../../src/main/services/rate-sync.service");
const { buildHarnessTools } = await import("../../src/main/services/agent/tools");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type ToolLike = { invoke: (rc: unknown, input: string, details?: unknown) => Promise<string> };
const call = (t: ToolLike, args: unknown): Promise<string> => t.invoke({}, JSON.stringify(args));

const ctx = { conversationId: "rates-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
let T: (name: string) => ToolLike = () => { throw new Error("未初始化"); };

function freshDb() {
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
  // 剥尾缀之后该有的样子：航线在 lane，目的港干干净净
  h.db.insert(rateQuotes).values([
    { recordId: "r-ist-1", pol: "宁波", podRaw: "ISTANBUL 伊斯坦布尔(土耳其)", lane: "地东",
      carrier: "CMA", container: "40HQ", oceanUsd: 1800, validTo: "2099-12-31", syncedAt: new Date().toISOString() },
    { recordId: "r-ist-2", pol: "上海", podRaw: "ISTANBUL 伊斯坦布尔(土耳其)", lane: "地东",
      carrier: "MSC", container: "40GP", oceanUsd: 1650, validTo: "2099-12-31", syncedAt: new Date().toISOString() },
    { recordId: "r-santos", pol: "宁波", podRaw: "SANTOS", lane: "南美东",
      carrier: "MSC", container: "40HQ", oceanUsd: 3200, validTo: "2099-12-31", syncedAt: new Date().toISOString() },
  ] as never).run();
  const all = buildHarnessTools(ctx as never) as unknown as ToolLike[];
  const byName = Object.fromEntries(all.map(t => [t.name ?? "", t]));
  T = (name: string) => byName[name]!;
}

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});
beforeEach(() => { ctx.counts.clear(); ctx.failures.clear(); freshDb(); });

describe("L1 机械层：跨字段并集 + 目的港尾缀剥离", () => {
  it("尾段是航线标签 → 剥掉并回填空 lane", () => {
    expect(stripLaneTag("ISTANBUL 伊斯坦布尔(土耳其) 地东", null))
      .toEqual({ podRaw: "ISTANBUL 伊斯坦布尔(土耳其)", lane: "地东" });
    expect(stripLaneTag("COLON 科隆 加勒比", "加勒比"))          // 尾段与该行 lane 同值
      .toEqual({ podRaw: "COLON 科隆", lane: "加勒比" });
  });

  it("正常形态不剥：带括号的中文译名(国家)、单段港名、非标签尾词", () => {
    expect(stripLaneTag("BALBOA, PA 巴尔博亚(巴拿马)", "加勒比").podRaw).toBe("BALBOA, PA 巴尔博亚(巴拿马)");
    expect(stripLaneTag("MANZANILLO", "墨西哥").podRaw).toBe("MANZANILLO");
    expect(stripLaneTag("PANAMA (MANZANILLO PA/BALBOA)", "加勒比").podRaw).toBe("PANAMA (MANZANILLO PA/BALBOA)");
    expect(stripLaneTag("ISTANBUL 伊斯坦布尔(土耳其) 报价", null).podRaw).toBe("ISTANBUL 伊斯坦布尔(土耳其) 报价");
  });

  it("入库路径也走同一剥离（远程行 lane 为空时由尾缀回填）", () => {
    const row = mapRemoteRow({
      content_key: "k1", pod_raw: "ISTANBUL 伊斯坦布尔(土耳其) 地东", route: "",
      carrier: "CMA", container_type: "40HQ", freight_usd: "1800.00",
    }, "k1")!;
    expect(row.podRaw).toBe("ISTANBUL 伊斯坦布尔(土耳其)");
    expect(row.lane).toBe("地东");
  });

  it("用户只说「地东」：机械层跨字段命中，不必猜它是航线还是港口", () => {
    for (const f of [{ terms: ["地东"] }, { terms: ["地东", "伊斯坦布尔"] }, { pod: "伊斯坦布尔" }] as never[]) {
      const r = listQuotes({ ...f, limit: 20 });
      expect(r.success, JSON.stringify(f)).toBe(true);
      expect((r as { data: unknown[] }).data.length, JSON.stringify(f)).toBe(2);
      expect(countQuotes(f as never), JSON.stringify(f)).toBe(2);
    }
    // 尾缀清洗后 pod 只打目的港列：航线词走 terms，不再靠 pod 兜（防回到"猜字段"老路）
    expect(countQuotes({ pod: "地东" } as never)).toBe(0);
  });
});

describe("L2/L3：查不到 ≠ 没有", () => {
  it("镜像概览实时取自库（不养第二份词表）", () => {
    const o = quoteOptions();
    expect(o.rows).toBe(3);
    expect(o.lanes.map(l => `${l.v}:${l.c}`)).toEqual(["地东:2", "南美东:1"]);
    expect(o.latestSyncAt).toBeTruthy();
  });

  it("第一轮没命中 → 回候选航线/目的港 + 指令换词重试一次", async () => {
    const out = JSON.parse(await call(T("quote_search"), { q: "波德港不存在XYZ" })) as {
      empty?: boolean; candidates?: { lanes: { v: string; c: number }[]; pods: { v: string; c: number }[] };
      notice: string; mirror?: { rows: number; reachable: boolean };
    };
    expect(out.empty).toBe(true);
    expect(out.candidates?.lanes.map(l => l.v)).toContain("地东");
    expect(out.candidates?.pods.map(p => p.v)).toContain("ISTANBUL 伊斯坦布尔(土耳其)");
    expect(out.notice).toContain("再查一次");
    expect(out.notice).not.toContain("暂无");
    // 空结果不许进读缓存：同一参数第二次调用要真跑，才走得到定论口径
    const again = JSON.parse(await call(T("quote_search"), { q: "波德港不存在XYZ" })) as { notice: string };
    expect(again.notice).not.toBe(out.notice);
  });

  it("第二轮仍没命中 → 按镜像事实定论（台账连不上就说「没跟上真源」，两条出口都在）", async () => {
    await call(T("quote_search"), { q: "波德港不存在XYZ" });
    const out = JSON.parse(await call(T("quote_search"), { q: "波德港不存在XYZ" })) as {
      notice: string; mirror: { rows: number; reachable: boolean; remoteHost: string };
      actions?: Array<{ kind: string; label: string }>;
    };
    expect(out.mirror.reachable).toBe(false);            // 测试环境里真源必然连不上
    expect(out.mirror.rows).toBe(3);
    expect(out.notice).toContain("两轮都没命中");
    expect(out.notice).toContain("镜像没跟上");
    expect(out.notice).toContain("不要说成");
    expect(out.actions?.map(a => a.label)).toEqual(["去运价页同步镜像", "联网查市场行情"]);
  });

  it("命中时口径不变：给出条数与固定格式指令", async () => {
    const out = JSON.parse(await call(T("quote_search"), { q: "地东" })) as {
      total: number; empty?: boolean; candidates?: unknown; notice: string;
    };
    expect(out.total).toBe(2);
    expect(out.empty).toBeUndefined();
    expect(out.candidates).toBeUndefined();
    expect(out.notice).toContain("以船司实时报价为准");
  });
});
