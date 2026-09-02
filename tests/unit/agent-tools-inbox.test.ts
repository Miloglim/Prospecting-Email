import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// 第一刀新工具离线单测：inbox_search / email_summarize
// 直接构造 harness 工具并调 execute，验证：过滤条件、id 引用校验、
// 正文去 HTML、匹配联系人/公司回填。email_summarize 内部会调 LLM，
// 这里 mock ai.service 的 summarizeEmail 返回固定结构。
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
// LLM 总结 mock：不依赖外部端点
vi.mock("../../src/main/services/ai.service", () => ({
  summarizeEmail: vi.fn(async () => ({ success: true, data: { summary: "客户要 2x40HQ 报价", nextStep: "今日回复报价" } })),
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
CREATE TABLE rate_quotes (
  record_id text PRIMARY KEY NOT NULL, pol text, pod_raw text NOT NULL, lane text, carrier text,
  container text, container_raw text, ocean_usd integer, validity_raw text, valid_from text, valid_to text,
  free_days text, shortfall_fee text, note text, source_group text, sender text, msg_time text,
  image_name text, synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE,
  provider text DEFAULT 'smtp' NOT NULL, smtp_host text, smtp_port integer,
  imap_host text, imap_port integer, encrypted_pass text NOT NULL,
  display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL, circuit_open_at text, circuit_reset_after text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

function newSandbox(): Driz {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  db.insert(schema.companies).values([{ name: "ACME Corp" }]).run();
  const acme = db.select().from(schema.companies).where(eq(schema.companies.name, "ACME Corp")).get()!.id;
  db.insert(schema.contacts).values([
    { email: "juan@acme.com", firstName: "Juan", lastName: "Garcia", companyId: acme, country: "Mexico" },
  ]).run();
  // 到期提醒种子（reminders_due）：Juan 3 小时后到期
  db.update(schema.contacts)
    .set({ extra: JSON.stringify({ crmReminder: { nextFollowupAt: new Date(Date.now() + 3 * 3600_000).toISOString(), note: "已发报价待回复" } }) })
    .where(eq(schema.contacts.email, "juan@acme.com")).run();
  // 账号健康种子（accounts_status）：1 正常 + 1 熔断 + 1 停用
  db.insert(schema.emailAccounts).values([
    { email: "ok@x.com", encryptedPass: "x" },
    { email: "broken@x.com", encryptedPass: "x", consecutiveFails: 3, circuitOpenAt: new Date().toISOString() },
    { email: "off@x.com", encryptedPass: "x", isActive: 0 },
  ]).run();
  db.insert(schema.inboxMessages).values([
    { accountId: 1, fromEmail: "juan@acme.com", fromName: "Juan Garcia",
      subject: "Quote request 40HQ", bodyPreview: "<div>Hello, <b>need rate</b> to Veracruz</div><style>body{color:red}</style>",
      classification: "inquiry", matchedContactId: 1, isRead: 0, receivedAt: "2026-09-01T10:00:00Z" },
    { accountId: 1, fromEmail: "noreply@x.com", subject: "Out of office",
      bodyPreview: "away", classification: "auto_reply", isRead: 1, receivedAt: "2026-08-30T10:00:00Z" },
  ]).run();
  // 运价种子：40HQ ×4 + 20GP ×1，全部在有效期（柜型归一测试用）
  const today = new Date();
  const plus = (d: number) => { const x = new Date(today); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
  db.insert(schema.rateQuotes).values([
    { recordId: "u1", podRaw: "SANTOS", lane: "南美东", carrier: "MSC", container: "40HQ", oceanUsd: 3200, validFrom: plus(-1), validTo: plus(10) },
    { recordId: "u2", podRaw: "SANTOS", lane: "南美东", carrier: "CMA", container: "40HQ", oceanUsd: 3450, validFrom: plus(-1), validTo: plus(10) },
    { recordId: "u3", podRaw: "KINGSTON", lane: "加勒比", carrier: "CMA", container: "40HQ", oceanUsd: 2800, validFrom: plus(-1), validTo: plus(10) },
    { recordId: "u4", podRaw: "VERACRUZ", lane: "加勒比", carrier: "MSC", container: "40HQ", oceanUsd: 3100, validFrom: plus(-1), validTo: plus(10) },
    { recordId: "u5", podRaw: "MANZANILLO", lane: "墨西哥", carrier: "HMM", container: "20GP", oceanUsd: 1900, validFrom: plus(-1), validTo: plus(10) },
  ]).run();
  return db;
}

type ToolLike = { invoke: (rc: unknown, input: string, details?: unknown) => Promise<string> };
/** SDK tool() 返回 FunctionTool：invoke(runContext, JSON 字符串参数) */
const call = (t: ToolLike, args: unknown): Promise<string> => t.invoke({}, JSON.stringify(args));

// 被测链路（mock 之后动态 import）
const { buildHarnessTools } = await import("../../src/main/services/agent/tools");
const { summarizeEmail } = await import("../../src/main/services/ai.service");

const ctx = { conversationId: "test-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
/** 按工具名取（注册顺序会变，按名索引更稳） */
let toolByName: Record<string, ToolLike> = {};
const T = (name: string): ToolLike => toolByName[name]!;

describe("agent 工具层（读工具集 + 收敛信号）", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    newSandbox();
    ctx.counts.clear();
    ctx.failures.clear();
    const all = buildHarnessTools(ctx) as unknown as ToolLike[];
    toolByName = Object.fromEntries(all.map(t => [t.name ?? "", t]));
  });

  it("inbox_search：无条件返回全部（新→旧）+ complete 收敛信号", async () => {
    const out = JSON.parse(await call(T("inbox_search"), {})) as {
      total: number; complete?: boolean; messages: Array<{ fromEmail: string; subject: string }>;
    };
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.fromEmail).toBe("juan@acme.com");   // 最新在前
    expect(out.complete).toBe(true);   // 2 条 < 默认 limit → 已全量返回
  });

  it("inbox_search：关键词 + 未读 + 分类过滤 + 空结果收敛信号", async () => {
    const out = JSON.parse(await call(T("inbox_search"), { query: "40HQ", unreadOnly: true })) as { messages: Array<{ id: number }> };
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.id).toBe(1);
    const bounce = JSON.parse(await call(T("inbox_search"), { classification: "auto_reply" })) as { messages: Array<{ id: number }> };
    expect(bounce.messages.map(r => r.id)).toEqual([2]);
    const empty = JSON.parse(await call(T("inbox_search"), { query: "不存在的关键词xyz" })) as { messages: unknown[]; notice?: string };
    expect(empty.messages).toHaveLength(0);
    expect(empty.notice).toContain("不要重复调用");
  });

  it("quote_search：脏柜型归一（40HC → 40HQ）", async () => {
    // 种子库中 40HQ 共 4 条（r1/r2/r3/r4），40HC 应被 normalizeContainer 归一后命中同一批
    const out = JSON.parse(await call(T("quote_search"), { container: "40HC" })) as { total: number };
    expect(out.total).toBe(4);
  });

  it("显式 null 的可选参数等同省略（DeepSeek 会把没用上的字段填 null）", async () => {
    const withNulls = JSON.parse(await call(T("quote_search"), {
      lane: null, carrier: null, pod: null, container: null, includeExpired: null, limit: null,
    })) as { total: number; quotes: unknown[] };
    expect(withNulls.total).toBe(5);              // 不加条件 = 全量命中
    expect(withNulls.quotes.length).toBeGreaterThan(0);

    const inboxNulls = JSON.parse(await call(T("inbox_search"), {
      query: null, classification: null, unreadOnly: null, limit: null,
    })) as { messages: unknown[] };
    expect(inboxNulls.messages).toHaveLength(2);
  });

  it("空字符串的可选筛选＝不过滤（模型用空串表达留省，不能被当成非法参数）", async () => {
    const out = JSON.parse(await call(T("quote_search"), {
      lane: "", carrier: "", pod: "", container: "", limit: 0,
    })) as { total: number; quotes: unknown[] };
    expect(out.total).toBe(5);
    const inbox = JSON.parse(await call(T("inbox_search"), {
      query: "   ", classification: "随便写的值", limit: 0,
    })) as { total: number };
    expect(inbox.total).toBeGreaterThanOrEqual(2);   // 非法分类被忽略，既不报错也不查空
  });

  it("quote_search：口语航线名（加勒比线）命中受控枚举「加勒比」", async () => {
    const out = JSON.parse(await call(T("quote_search"), { lane: "加勒比线" })) as { total: number };
    expect(out.total).toBe(2);
  });

  it("search_contacts：全名两词按词切分匹配 + 唯一命中给「写开发信」动作", async () => {
    const out = JSON.parse(await call(T("search_contacts"), { query: "Juan Garcia" })) as {
      results: Array<{ name: string }>;
      actions?: Array<{ kind: string; label: string; text?: string }>;
    };
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.name).toBe("Juan Garcia");
    // 动作是 prompt 类（点一下即续问），且把 contactId 带进问题，草稿结果卡才有入队按钮
    expect(out.actions?.[0]?.kind).toBe("prompt");
    expect(out.actions?.[0]?.text).toContain("联系人 #1");
  });

  it("email_summarize：id 不存在时给引导语而非崩溃", async () => {
    const out = await call(T("email_summarize"), { messageId: 999 });
    expect(out).toContain("不存在");
    expect(out).toContain("inbox_search");
  });

  it("email_summarize：正文去 HTML + 联系人/公司回填 + 审计留痕", async () => {
    const out = JSON.parse(await call(T("email_summarize"), { messageId: 1 })) as {
      from: string; summary: string; nextStep: string;
    };
    expect(out.from).toBe("Juan Garcia");
    expect(out.summary).toBe("客户要 2x40HQ 报价");
    expect(out.nextStep).toBe("今日回复报价");
    // 传给 LLM 的正文应已去掉 HTML 标签与 style 块
    const mocked = summarizeEmail as unknown as { mock: { calls: Array<Array<{ bodyPreview: string }>> } };
    const passed = mocked.mock.calls.at(-1)![0]!;
    expect(passed.bodyPreview).toContain("need rate");
    expect(passed.bodyPreview).not.toContain("<div>");
    expect(passed.bodyPreview).not.toContain("style");
    // 关联联系人/公司被解析进 prompt
    expect(passed.matchedContactName).toBe("Juan Garcia");
    expect(passed.matchedCompany).toBe("ACME Corp");
    // 审计落库
    const audits = h.db.select().from(schema.agentToolCalls).all();
    expect(audits.some(a => a.toolName === "email_summarize" && a.approval === "auto")).toBe(true);
  });

  it("预算守卫：超过 budgetPerTurn 后返回 budget_exhausted 引导语", async () => {
    await call(T("inbox_search"), {});
    await call(T("inbox_search"), {});
    await call(T("inbox_search"), {});
    const out = await call(T("inbox_search"), {});
    expect(out).toContain("budget_exhausted");
  });

  it("reminders_due：到期/逾期分桶 + 跟进备注回填", async () => {
    const out = JSON.parse(await call(T("reminders_due"), {})) as {
      dueCount: number; overdueCount: number;
      due: Array<{ name: string; company: string; note: string }>;
    };
    expect(out.dueCount).toBe(1);
    expect(out.due[0]!.name).toBe("Juan Garcia");
    expect(out.due[0]!.company).toBe("ACME Corp");
  });

  it("accounts_status：健康数与逐账号问题清单", async () => {
    const out = JSON.parse(await call(T("accounts_status"), {})) as {
      total: number; enabled: number; healthy: number;
      issues: Array<{ email: string; problems: string }>;
    };
    expect(out.total).toBe(3);
    expect(out.enabled).toBe(2);
    expect(out.healthy).toBe(1);
    expect(out.issues.find(i => i.email === "broken@x.com")!.problems).toContain("发信熔断中");
    expect(out.issues.find(i => i.email === "off@x.com")!.problems).toBe("已停用");
  });

it("熔断：同一工具连续失败 2 次后本回合暂停，并给收敛指令", async () => {
    const first = await call(T("email_summarize"), { messageId: 999 });
    const second = await call(T("email_summarize"), { messageId: 998 });
    expect(first).toContain("不存在");
    expect(second).toContain("不存在");
    const third = await call(T("email_summarize"), { messageId: 997 });
    expect(third).toContain("tool_suspended");
    expect(third).toContain("不要再调用本工具");
  });

  it("熔断计数看「连续」：中间成功一次就清零", async () => {
    await call(T("email_summarize"), { messageId: 999 });           // 失败 1
    const ok = await call(T("email_summarize"), { messageId: 1 });   // 成功 → 计数清零
    expect(ok).toContain("summary");
    const again = await call(T("email_summarize"), { messageId: 998 }); // 又失败，但只算第 1 次
    expect(again).toContain("不存在");
    expect(again).not.toContain("tool_suspended");
  });

  it("熔断不吞预算：暂停期间不再计数", async () => {
    const suspended = await call(T("email_summarize"), { messageId: 999 });
    await call(T("email_summarize"), { messageId: 998 });
    await call(T("email_summarize"), { messageId: 997 });       // 已熔断，直接给暂停语
    expect(suspended).not.toContain("tool_suspended");
    expect(ctx.counts.get("email_summarize")).toBeLessThanOrEqual(2);
  });

  it("写操作幂等：相同内容 5 分钟内重复提交只落一条", async () => {
    const args = { contactId: 1, note: "已发送报价，等待回复" };
    const first = await call(T("record_followup"), args);
    const second = await call(T("record_followup"), args);
    expect(first).toContain("记录跟进");
    expect(second).toContain("幂等");
    const rows = h.db.select().from(schema.interactions).all();
    expect(rows).toHaveLength(1);
  });

  it("写操作幂等按内容区分：改了备注就该再落一条", async () => {
    await call(T("record_followup"), { contactId: 1, note: "第一次联系" });
    const second = await call(T("record_followup"), { contactId: 1, note: "第二次联系" });
    expect(second).toContain("记录跟进");
    expect(second).not.toContain("幂等");
  });

  it("一步到位：只给邮箱也能记跟进（弱模型不必先 search_contacts）", async () => {
    const out = await call(T("record_followup"), { contact: "juan@acme.com", note: "已电话确认船期" });
    expect(out).toContain("Juan Garcia");
    expect(out).toContain("#1");
    expect(h.db.select().from(schema.interactions).all()).toHaveLength(1);
  });

  it("多位命中时不猜：回候选清单，且一条都不写库", async () => {
    h.db.insert(schema.contacts).values([
      { email: "wang2@x.com", firstName: "Wang", lastName: "Second", country: "China" },
      { email: "wang3@x.com", firstName: "Wang", lastName: "Third", country: "China" },
    ]).run();
    const out = await call(T("record_followup"), { contact: "Wang", note: "x" });
    expect(out).toContain("匹配到多位");
    expect(out).toContain("Wang Second");
    expect(out).toContain("Wang Third");
    expect(h.db.select().from(schema.interactions).all()).toHaveLength(0);   // 有歧义时绝不落库
  });

  it("queue_status：空闲时返回零值结构（不抛错）", async () => {
    const out = JSON.parse(await call(T("queue_status"), {})) as {
      running: boolean; paused: boolean; totalGroups: number; pendingGroups: number; pendingRecipients: number;
    };
    expect(out.running).toBe(false);
    expect(out.totalGroups).toBe(0);
    expect(out.pendingGroups).toBe(0);
    expect(out.pendingRecipients).toBe(0);
  });
});
