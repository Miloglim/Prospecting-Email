import { describe, it, expect, vi, beforeAll } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import { eq } from "drizzle-orm";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import * as SB from "../../src/main/services/sender-block.service";

// ═══════════════════════════════════════════════════════════════
// 发信受阻熔断（规范 docs/sender-block-circuit-spec.md）
// 实测缺陷：阿里云 ESO_LOCAL_SPAM 这类通知是 SMTP 成功后异步发来的，
// 发送引擎的失败计数永远不沾 → 30 分钟内 8 封拦截、程序一次都没停。
// 本文件钉死 §9 的五个判定点。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
const sendSpy = { pauseSend: vi.fn(), markAccountCircuitOpen: vi.fn(), pushCircuitChanged: vi.fn() };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => ({ prepare: () => ({ all: () => [], get: () => null }), transaction: (fn: () => void) => () => fn() }),
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
// 触发时惰性 import 的引擎侧动作：这里换成探针，直接断言「暂停整批 + 标红 + 播报」都发生了
vi.mock("../../src/main/services/send.service", () => ({
  pauseSend: (r: string) => sendSpy.pauseSend(r),
  markAccountCircuitOpen: (id: number) => sendSpy.markAccountCircuitOpen(id),
  pushCircuitChanged: (p: unknown) => sendSpy.pushCircuitChanged(p),
}));

const DDL = `
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE, provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer, imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text, circuit_reason text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE send_block_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL,
  message_id text NOT NULL UNIQUE,
  code text NOT NULL, excerpt text,
  occurred_at text NOT NULL, created_at text NOT NULL
);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type SB = typeof import("../../src/main/services/sender-block.service");
// 纯函数（判据/生效期）不碰 DB，静态实例即可；带库状态用例走 freshDb 重装模块
let S: SB = SB;

async function freshDb(): Promise<void> {
  const raw = new SQLLIB.Database();
  raw.run(DDL);
  h.db = drizzle(raw, { schema });
  h.db.insert(schema.emailAccounts).values({ id: 1, email: "zayne_jin@yqn.com", encryptedPass: "x" } as never).run();
  vi.resetModules();
  S = await import("../../src/main/services/sender-block.service");
  sendSpy.pauseSend.mockClear();
}

/** 用户实测那封原文（截样）—— 判据必须认它 */
const ALIYUN_SPAM_NOTICE = `很抱歉，你发送的邮件被本系统退回，相关信息如下：
收信地址 zambia@transitex.co.zm
退信原因 您发送的邮件被系统反垃圾拦截，此次邮件投递可能存在法律法规或系统规则无法允许的内容或者行为，建议调整邮件内容或发信频率后重新发送。
解决方案 请调整内容之后重新尝试发送
参考信息 ESO_LOCAL_SPAM: spamed by local spam engine`;

/** 普通硬退信（收件人邮箱不存在）：不属于本机制管的范围，必须判 null */
const HARD_BOUNCE_NOTICE = `Undeliverable: Logistics Solutions
Reporting-MTA: dns; mail.example.com
Final-Recipient: rfc822; gone@dead-domain.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 user unknown`;

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

describe("发信受阻判据（只认针对性拦截，其他退信照旧）", () => {
  it("阿里云反垃圾/限流通知命中，并带出判据码", () => {
    const hit = S.detectSenderBlockSignal(ALIYUN_SPAM_NOTICE);
    expect(hit?.code).toBe("ESO_LOCAL_SPAM");
    expect(hit?.excerpt).toContain("反垃圾");
  });

  it("收件人硬退信（5.1.1/user unknown）不命中——不许接管", () => {
    expect(S.detectSenderBlockSignal(HARD_BOUNCE_NOTICE)).toBeNull();
    expect(S.detectSenderBlockSignal("无法发送到 a@b.c\n系统应答:550 No such user")).toBeNull();
  });

  it("限流/黑名单族也认（rate limit / 发送频率过高 / blacklist）", () => {
    expect(S.detectSenderBlockSignal("Delivery rate limit exceeded, slow down")).not.toBeNull();
    expect(S.detectSenderBlockSignal("您的发送频率过高，请稍后再试")).not.toBeNull();
    expect(S.detectSenderBlockSignal("Recipient server blocked: your IP is on a blacklist")).not.toBeNull();
  });

  it("空文/纯 HTML 不误报", () => {
    expect(S.detectSenderBlockSignal(null)).toBeNull();
    expect(S.detectSenderBlockSignal("   ")).toBeNull();
    expect(S.detectSenderBlockSignal("<div>Logistics Solutions.</div>")).toBeNull();
  });
});

describe("熔断生效期与解除", () => {
  it("circuit_reset_after 之内算熔断，过期自动放行（不必等手动清）", () => {
    const now = Date.parse("2026-09-08T10:00:00.000Z");
    const open = { circuitOpenAt: "2026-09-08T09:00:00.000Z", circuitResetAfter: "2026-09-09T09:00:00.000Z" };
    expect(S.isCircuitOpen(open, now)).toBe(true);
    expect(S.isCircuitOpen({ ...open, circuitResetAfter: "2026-09-08T09:30:00.000Z" }, now)).toBe(false);
    expect(S.isCircuitOpen(null, now)).toBe(false);
  });
});

describe("滚动窗口触发", () => {
  it("30 分钟内第 3 封触发：熔断该账号 + 暂停整批 + 播报；第 4 封不重复触发", async () => {
    await freshDb();
    const base = Date.now();
    const at = (min: number) => new Date(base + min * 60_000).toISOString();

    const r1 = S.recordSenderBlock({ accountId: 1, messageId: "m1", occurredAt: at(0), signal: { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" } });
    const r2 = S.recordSenderBlock({ accountId: 1, messageId: "m2", occurredAt: at(3), signal: { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" } });
    expect([r1.tripped, r2.tripped]).toEqual([false, false]);
    expect(r1.windowCount).toBe(1);
    expect(S.isCircuitOpen(h.db.select({ circuitOpenAt: schema.emailAccounts.circuitOpenAt, circuitResetAfter: schema.emailAccounts.circuitResetAfter }).from(schema.emailAccounts).where(ONE).get())).toBe(false);

    const r3 = S.recordSenderBlock({ accountId: 1, messageId: "m3", occurredAt: at(6), signal: { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" } });
    expect(r3.tripped).toBe(true);
    expect(r3.windowCount).toBe(3);

    const acct = h.db.select().from(schema.emailAccounts).where(ONE).get()!;
    expect(acct.circuitReason).toBe("sender_block");
    expect(S.isCircuitOpen(acct)).toBe(true);
    // 24h 自动过期时刻已写死
    expect(Date.parse(acct.circuitResetAfter!) - Date.parse(acct.circuitOpenAt!)).toBe(S.CIRCUIT_TTL_MS);

    await vi.waitFor(() => expect(sendSpy.pauseSend).toHaveBeenCalledWith("sender_block"), { timeout: 2000 });
    expect(sendSpy.pauseSend).toHaveBeenCalledWith("sender_block");
    expect(sendSpy.markAccountCircuitOpen).toHaveBeenCalledWith(1);
    expect(sendSpy.pushCircuitChanged).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, reason: "sender_block", windowCount: 3 }));

    const r4 = S.recordSenderBlock({ accountId: 1, messageId: "m4", occurredAt: at(9), signal: { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" } });
    expect(r4.tripped).toBe(false);
    expect(r4.alreadyOpen).toBe(true);
  });

  it("同一封通知重复记录幂等（messageId 唯一键）", async () => {
    await freshDb();
    const sig = { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" };
    const a = S.recordSenderBlock({ accountId: 1, messageId: "same", occurredAt: new Date().toISOString(), signal: sig });
    const b = S.recordSenderBlock({ accountId: 1, messageId: "same", occurredAt: new Date().toISOString(), signal: sig });
    expect([a.counted, b.counted]).toEqual([true, false]);
    expect(b.windowCount).toBe(1);
  });

  it("窗口外的旧记录不计入（31 分钟前那封不算）", async () => {
    await freshDb();
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const now = new Date().toISOString();
    const sig = { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" };
    S.recordSenderBlock({ accountId: 1, messageId: "o1", occurredAt: old, signal: sig });
    const r = S.recordSenderBlock({ accountId: 1, messageId: "n1", occurredAt: now, signal: sig });
    expect(r.windowCount).toBe(1);
    expect(S.countRecentBlocks(1)).toBe(1);
  });

  it("一键解除：熔断三列与连续失败计数全部清干净", async () => {
    await freshDb();
    const sig = { code: "ESO_LOCAL_SPAM", excerpt: "反垃圾" };
    const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    for (const [mid, min] of [["m1", 0], ["m2", 1], ["m3", 2]] as const) {
      S.recordSenderBlock({ accountId: 1, messageId: mid, occurredAt: at(min), signal: sig });
    }
    expect(S.isCircuitOpen(h.db.select().from(schema.emailAccounts).where(ONE).get()!)).toBe(true);

    const r = S.resetSendCircuit(1);
    expect(r.success).toBe(true);
    const acct = h.db.select().from(schema.emailAccounts).where(ONE).get()!;
    expect(acct.circuitOpenAt).toBeNull();
    expect(acct.circuitResetAfter).toBeNull();
    expect(acct.circuitReason).toBeNull();
    expect(acct.consecutiveFails).toBe(0);
  });
});

const ONE = eq(schema.emailAccounts.id, 1);
