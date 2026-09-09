import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { inboxMessages } from "../../src/main/db/schema/inbox";
import { beijingDay } from "../../src/main/services/suggestion.service";

// ═══════════════════════════════════════════════════════════════════
// 首页卡片三「今日邮箱概览」（docs/home-cards-spec.md §5）：
// 北京时间自然日为界、未读真源=DB isRead、"待你回复"=今日客户回复且其后再无发往该邮箱的邮件。
// 纯读快照，不改任何状态。
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { todayMailBrief } = await import("../../src/main/services/mail-brief.service");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

/** 北京时间今日的起点（UTC 毫秒），与服务的日界算法同源 */
function beijingStartUtc(now = new Date()): number {
  return Date.parse(`${beijingDay(now.getTime())}T00:00:00Z`) - 8 * 3600_000;
}

function freshDb(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  try { raw.run(`ALTER TABLE inbox_messages ADD COLUMN intent text;`); } catch { /* 列已存在 */ }
  const db = drizzle(raw, { schema });
  h.db = db;
  let seq = 100;
  const add = (m: {
    from: string; fromName?: string; subject?: string; at: string;
    cls: string; intent?: string; read?: number; to?: string; cc?: string; contactId?: number;
  }) => {
    db.insert(inboxMessages).values({
      id: ++seq, accountId: 1, fromEmail: m.from, fromName: m.fromName ?? null, subject: m.subject ?? null,
      classification: m.cls, intent: m.intent ?? null, receivedAt: m.at, isRead: m.read ?? 0,
      to: m.to ?? null, cc: m.cc ?? null, matchedContactId: m.contactId ?? null,
    } as never).run();
  };
  return { db, add };
}

function seed(now = new Date()) {
  const start = beijingStartUtc(now);
  const { add } = freshDb();
  // 今日区间
  add({ from: "a@acme.com", fromName: "Ana", subject: "POD Santos 40HQ", at: new Date(start + 30_000).toISOString(), cls: "other", intent: "price_inquiry" });
  add({ from: "juan@acme.com", fromName: "Juan", subject: "RFQ", at: new Date(start + 3600_000).toISOString(), cls: "replied", contactId: 7 });
  add({ from: "late@acme.com", fromName: "Late", subject: "已回过", at: new Date(start + 7200_000).toISOString(), cls: "replied" });
  add({ from: "me@x.com", subject: "Re: 已回过", to: "late@acme.com, boss@x.com", at: new Date(start + 9000_000).toISOString(), cls: "sent", read: 1 });
  add({ from: "oOOO@auto.com", fromName: "Out of office", at: new Date(start + 4000_000).toISOString(), cls: "autoreply", read: 1 });
  add({ from: "mailer@mail.ru", subject: "bounce notice", at: new Date(start + 5000_000).toISOString(), cls: "bounce" });
  // 边界外：北京今日 00:00 前 1 分钟（= 昨日 23:59）
  add({ from: "yesterday@acme.com", subject: "昨天的", at: new Date(start - 60_000).toISOString(), cls: "other" });
  return { start, add };
}

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => require("path").resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});
beforeEach(() => { seed(); });

describe("今日邮箱概览", () => {
  it("以北京时间自然日为界，昨天的不计入", () => {
    const r = todayMailBrief();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.inbound).toBe(5);                                  // 不含昨天那封，也不含 sent
    expect(r.data.latest.some(m => m.fromEmail === "yesterday@acme.com")).toBe(false);
  });

  it("未读真源=DB isRead；分类与询价各算各的", () => {
    const r = todayMailBrief();
    if (!r.success) throw new Error("fail");
    expect(r.data.unread).toBe(4);                                   // autoreply 与 sent 副本已读
    expect(r.data.byClass).toEqual({ replied: 2, autoreply: 1, bounce: 1, other: 1 });
    expect(r.data.priceInquiry).toBe(1);
    expect(r.data.sentToday).toBe(1);
  });

  it("待你回复：今日客户回复里，之后再无发往该邮箱的才算；等得最久的排前", () => {
    const r = todayMailBrief();
    if (!r.success) throw new Error("fail");
    expect(r.data.awaiting.map(m => m.fromEmail)).toEqual(["juan@acme.com"]);   // late 之后有发出，已不算待回
    expect(r.data.awaiting[0]?.matchedContactId).toBe(7);
    expect(r.data.awaiting[0]?.waitedHours).toBeGreaterThan(0);
  });

  it("零邮件的早晨也给出可看的结论，不报错", () => {
    freshDb();
    const r = todayMailBrief();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.inbound).toBe(0);
    expect(r.data.summary).toContain("还没有新来信");
  });

  it("概览是只读快照：跑完不改任何行的 isRead", () => {
    const before = h.db.select({ id: inboxMessages.id, read: inboxMessages.isRead }).from(inboxMessages).all();
    todayMailBrief();
    const after = h.db.select({ id: inboxMessages.id, read: inboxMessages.isRead }).from(inboxMessages).all();
    expect(after).toEqual(before);
  });
});
