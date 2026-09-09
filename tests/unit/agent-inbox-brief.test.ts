import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { inboxMessages } from "../../src/main/db/schema/inbox";
import { beijingDay } from "../../src/main/services/suggestion.service";

// ═══════════════════════════════════════════════════════════════════
// 2026-09-09 会话导出（「今天的邮件有询盘吗」）暴露的三处修：
//   ① inbox_search 此前没有时间参数 → 模型拉一页自己按时间戳筛，第一轮把询盘答成「没有」；
//   ② 我方发出副本（classification=sent）默认混在结果里 → 8 封"今天来信"里 6 封是自己发的；
//   ③ 概览数字/待回复清单只有首页卡片能用，agent 拿不到 → 新增 mail_brief 工具。
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({ getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null }));
vi.mock("../../src/main/logger", () => ({ Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));

const { buildHarnessTools } = await import("../../src/main/services/agent/tools");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type ToolLike = { name?: string; invoke: (rc: unknown, input: string) => Promise<string> };
const call = async (t: ToolLike, args: unknown) => JSON.parse(await t.invoke({}, JSON.stringify(args))) as Record<string, never>;

let T: Record<string, ToolLike> = {};

function seed(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  try { raw.run(`ALTER TABLE inbox_messages ADD COLUMN intent text;`); } catch { /* 已存在 */ }
  const db = drizzle(raw, { schema });
  h.db = db;
  const start = Date.parse(`${beijingDay()}T00:00:00Z`) - 8 * 3600_000;
  const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
  let id = 500;
  const add = (m: { from: string; fromName?: string; subject?: string; at: string; cls: string; intent?: string; read?: number; to?: string }) => {
    db.insert(inboxMessages).values({
      id: ++id, accountId: 1, fromEmail: m.from, fromName: m.fromName ?? null, subject: m.subject ?? null,
      classification: m.cls, intent: m.intent ?? null, receivedAt: m.at, isRead: m.read ?? 0, to: m.to ?? null,
    } as never).run();
  };
  // 今天：2 封我方发出 + 2 封客户询价 + 1 封自动回复
  add({ from: "me@x.com", subject: "开发信 1", at: iso(1000), cls: "sent", read: 1 });
  add({ from: "me@x.com", subject: "开发信 2", at: iso(2000), cls: "sent", read: 1 });
  add({ from: "buyer@acme.com", fromName: "Buyer", subject: "QUOTE-1308 Santos", at: iso(3000), cls: "replied", intent: "price_inquiry" });
  add({ from: "quote@acme.com", fromName: "Quotation", subject: "RFQ FCL", at: iso(4000), cls: "other", intent: "price_inquiry" });
  add({ from: "ooo@acme.com", fromName: "OOO", at: iso(5000), cls: "autoreply" });
  // 昨天：一封更早的询价（时间过滤要把它排除掉）
  add({ from: "old@acme.com", fromName: "Old", subject: "昨天的询盘", at: new Date(start - 3600_000).toISOString(), cls: "replied", intent: "price_inquiry" });
}

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});
beforeEach(() => {
  seed();
  const ctx = { conversationId: "ib-conv", counts: new Map<string, number>(), failures: new Map<string, number>(), userText: "今天的邮件有询盘吗" };
  T = Object.fromEntries(((buildHarnessTools(ctx) ?? []) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));
});

describe("inbox_search：时间范围与「默认只看进来的信」", () => {
  it("不传 since 也默认排除我方发出副本（问询盘不再被 sent 挤掉）", async () => {
    const r = await call(T["inbox_search"], { limit: 50 });
    const list = (r.messages ?? []) as Array<{ classification: string }>;
    expect(list.length).toBe(4);                      // 2 封 sent 被排除，含昨天那封
    expect(list.some(m => m.classification === "sent")).toBe(false);
  });

  it("since=今天 按北京时间算日界，昨天的询盘不混进来", async () => {
    const r = await call(T["inbox_search"], { since: "今天", limit: 50 });
    expect((r.messages ?? []) as unknown[]).toHaveLength(3);
    expect(r["时间窗口"]).toBeTruthy();
    const old = ((r.messages ?? []) as Array<{ subject: string | null }>).some(m => (m.subject ?? "").includes("昨天"));
    expect(old).toBe(false);
  });

  it("includeSent=true 才把我方发出副本带回来（用户问「我发出去的」时用）", async () => {
    const r = await call(T["inbox_search"], { includeSent: true, limit: 50 });
    expect((r.messages ?? []) as unknown[]).toHaveLength(6);
  });

  it("since 看不懂当面纠错，不静默降级成全量查", async () => {
    const r = await call(T["inbox_search"], { since: "前个礼拜" });
    expect(r.ok).toBe(false);
    expect((r.error as { code: string }).code).toBe("bad_filter");
  });
});

describe("mail_brief：概览数字与待回复清单交给 agent", () => {
  it("一次给全今天的数（未读/回复/询价）与等你回复清单", async () => {
    const r = await call(T["mail_brief"], {});
    expect(r.ok).toBe(true);
    expect(r.inbound).toBe(3);
    expect(r.byClass).toMatchObject({ replied: 1, autoreply: 1, other: 1 });
    expect(r.priceInquiry).toBe(2);
    expect(r.sentToday).toBe(2);
    expect((r.awaiting as unknown[]).length).toBe(1);              // old@acme 是昨天的，不进今日待回
    expect(r.summary).toContain("3 封");
    expect((r.notice as string)).toContain("服务端按北京时间算好");
    expect((r.nextStep as string)).toContain("起草回复");
  });

  it("工具已在注册表登记（审批闸门与工具集合一致性锁的前提）", () => {
    expect(T["mail_brief"]).toBeTruthy();
  });
});
