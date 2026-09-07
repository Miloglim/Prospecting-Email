import { describe, it, expect, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// 会话工作台（working-memory.ts）：结构化结果的 upsert 去重、回放封顶与顺序、
// 程序化直取、payload 裁剪合法性、查询指纹稳定性。沙箱内存库，机制验证要确定性。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => { /* 内存库 */ },
  getRawDb: () => null,
}));

const wm = await import("../../src/main/services/agent/working-memory");

const DDL = `
CREATE TABLE agent_working_memory (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  kind text NOT NULL, ref_id text NOT NULL, tool_name text NOT NULL,
  context_line text NOT NULL, payload_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>> | null = null;
async function newSandbox(): Promise<Driz> {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  return db;
}

describe("rememberWork / getWork（写入与程序化直取）", () => {
  it("写入后可按 kind+refId 直取完整 payload", async () => {
    await newSandbox();
    wm.rememberWork("c1", {
      kind: "rates", refId: "ningbo-santos-40hq", toolName: "quote_search",
      contextLine: "运价 宁波→桑托斯 40HQ：16 条，最低 CMA 天津 $8,000",
      payload: { rows: [{ carrier: "CMA", price: 8000, pod: "SANTOS" }], cheapest: 8000 },
    });
    const got = wm.getWork("c1", "rates", "ningbo-santos-40hq") as { cheapest: number };
    expect(got.cheapest).toBe(8000);
  });

  it("同 (conv,kind,refId) 再写 = upsert 刷新，不堆叠", async () => {
    await newSandbox();
    const base = { kind: "email" as const, refId: "16703", toolName: "email_read_full" };
    wm.rememberWork("c1", { ...base, contextLine: "旧要点", payload: { v: 1 } });
    wm.rememberWork("c1", { ...base, contextLine: "新要点", payload: { v: 2 } });
    const list = wm.listWork("c1", "email");
    expect(list).toHaveLength(1);
    expect((wm.getWork("c1", "email", "16703") as { v: number }).v).toBe(2);
  });

  it("getWork 无 refId → 取该 kind 最近一条；无数据 → null", async () => {
    await newSandbox();
    expect(wm.getWork("cX", "rates")).toBeNull();
    wm.rememberWork("c1", { kind: "rates", refId: "a", toolName: "quote_search", contextLine: "A", payload: { tag: "a" } });
    wm.rememberWork("c1", { kind: "rates", refId: "b", toolName: "quote_search", contextLine: "B", payload: { tag: "b" } });
    expect((wm.getWork("c1", "rates") as { tag: string }).tag).toBe("b");   // 最近写的
  });

  it("空 contextLine 或空 refId 不入库（防脏项）", async () => {
    await newSandbox();
    wm.rememberWork("c1", { kind: "email", refId: "", toolName: "t", contextLine: "有要点", payload: {} });
    wm.rememberWork("c1", { kind: "email", refId: "x", toolName: "t", contextLine: "  ", payload: {} });
    expect(wm.listWork("c1", "email")).toHaveLength(0);
  });
});

describe("recallWorkBlock（回放注入）", () => {
  it("无数据不出声（短对话零噪音）", async () => {
    await newSandbox();
    expect(wm.recallWorkBlock("cEmpty")).toEqual([]);
  });

  it("有数据 → 注入块含工作台抬头与要点，按时间正序", async () => {
    await newSandbox();
    wm.rememberWork("c1", { kind: "email", refId: "1", toolName: "email_read_full", contextLine: "邮件#1 柜型 1×40'HC", payload: {} });
    wm.rememberWork("c1", { kind: "rates", refId: "2", toolName: "quote_search", contextLine: "运价 宁波→桑托斯 16 条", payload: {} });
    const block = wm.recallWorkBlock("c1");
    expect(block).toHaveLength(1);
    expect(block[0]!.role).toBe("user");
    expect(block[0]!.content).toContain("本会话工作台");
    expect(block[0]!.content).toContain("不要编造");
    // 正序：先写的邮件在前
    expect(block[0]!.content.indexOf("邮件#1")).toBeLessThan(block[0]!.content.indexOf("运价"));
  });

  it("条数封顶 12（表里再多也不撑爆上下文）", async () => {
    await newSandbox();
    for (let i = 0; i < 20; i++) {
      wm.rememberWork("c1", { kind: "contacts", refId: `r${i}`, toolName: "search_contacts", contextLine: `要点${i}`, payload: {} });
    }
    const block = wm.recallWorkBlock("c1")[0]!.content;
    expect((block.match(/· /g) ?? []).length).toBe(12);
    // 收的是最近的（要点19 在，要点0 被丢尾）
    expect(block).toContain("要点19");
    expect(block).not.toContain("要点0\n");
  });

  it("总量封顶：超长要点丢尾，注入块不无限膨胀", async () => {
    await newSandbox();
    for (let i = 0; i < 12; i++) {
      wm.rememberWork("c1", { kind: "rates", refId: `q${i}`, toolName: "quote_search", contextLine: `运价${i}：` + "长".repeat(380), payload: {} });
    }
    const block = wm.recallWorkBlock("c1")[0]!.content;
    // 每条 ~386 字，1800 上限只容得下约 4 条，远少于 12
    expect((block.match(/· /g) ?? []).length).toBeLessThan(6);
    expect((block.match(/· /g) ?? []).length).toBeGreaterThan(0);
  });
});

describe("fitPayload（裁剪始终产出合法 JSON）", () => {
  it("超大数组 → 输出 ≤ 上限、可 JSON.parse、且优先保条数", () => {
    const big = { rows: Array.from({ length: 400 }, (_, i) => ({ carrier: `C${i}`, note: "描述".repeat(120), price: i })), total: 400 };
    const s = wm.fitPayload(big);
    expect(s.length).toBeLessThanOrEqual(8192);
    const parsed = JSON.parse(s) as { rows?: unknown[] };
    expect(Array.isArray(parsed.rows)).toBe(true);   // 数组字段仍在（没被整体截成半截 JSON）
    expect((parsed.rows as unknown[]).length).toBeGreaterThan(0);
  });

  it("小 payload 原样通过", () => {
    const s = wm.fitPayload({ a: 1, b: "x" });
    expect(JSON.parse(s)).toEqual({ a: 1, b: "x" });
  });
});

describe("fingerprint（查询指纹稳定）", () => {
  it("同参不同键顺序 → 同指纹；大小写/空格归一", () => {
    expect(wm.fingerprint({ pod: "SANTOS", lane: "南美东" })).toBe(wm.fingerprint({ lane: "南美东", pod: "santos " }));
  });
  it("不同参 → 不同指纹", () => {
    expect(wm.fingerprint({ pod: "SANTOS" })).not.toBe(wm.fingerprint({ pod: "MANZANILLO" }));
  });
});
