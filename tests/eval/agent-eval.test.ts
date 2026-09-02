import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as fs from "fs";
import { EVAL_CARDS, type EvalCard } from "./agent-tasks";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// Agent 归因评测跑批（live 专用：AGENT_EVAL=live 才执行，常规 vitest 自动跳过）
// 真实 agnes 模型 + 真实 agent.service/harness/tools 链路 + 沙箱内存库。
// 每张任务卡记录：工具调用序列 / 最终回答 / 审批触发；失败自动归因四类：
//   missing-tool(适配债) / model-tool-misuse(基座该用没用/乱用)
//   answer-quality(答非所问/编造) / infra(链路故障)
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
type ToolEv = { tool: string; status: string };
type TurnUsage = { requests: number; input: number; output: number; cached: number };
type Collected = {
  tools: ToolEv[]; text: string; approvals: number;
  error?: string; done: boolean; usage?: TurnUsage;
};

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>> | null = null;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => { /* 内存库 */ },
  getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// 被测链路（在 mock 之后 import 才安全：vitest 提升 import，这里靠动态获取）
const agentSvc = await import("../../src/main/services/agent.service");

const DDL = `
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE,
  provider text DEFAULT 'smtp' NOT NULL, smtp_host text, smtp_port integer,
  imap_host text, imap_port integer, encrypted_pass text NOT NULL,
  display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL, circuit_open_at text, circuit_reset_after text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
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
CREATE TABLE rate_quotes (
  record_id text PRIMARY KEY NOT NULL, pol text, pod_raw text NOT NULL, lane text, carrier text,
  container text, container_raw text, ocean_usd integer, validity_raw text, valid_from text, valid_to text,
  free_days text, shortfall_fee text, note text, source_group text, sender text, msg_time text,
  image_name text, synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
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
CREATE TABLE inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, account_id integer NOT NULL, message_id text,
  from_email text NOT NULL, from_name text, subject text, body_preview text, classification text,
  cc text, my_role text, matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL, received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

async function newSandbox(): Promise<Driz> {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  // ── 种子数据 ──
  db.insert(schema.companies).values([{ name: "ACME Corp" }, { name: "华南物流有限公司" }]).run();
  const acme = db.select().from(schema.companies).where(eq(schema.companies.name, "ACME Corp")).get()!.id;
  const hn = db.select().from(schema.companies).where(eq(schema.companies.name, "华南物流有限公司")).get()!.id;
  db.insert(schema.contacts).values([
    { email: "juan@acme.com", firstName: "Juan", lastName: "Garcia", companyId: acme, country: "Mexico", language: "ES" },
    { email: "li@huanan.com", firstName: "Li", lastName: "Wei", companyId: hn, country: "China" },
    { email: "wang@huanan.com", firstName: "Wang", lastName: "Fang", companyId: hn, country: "China" },
  ]).run();
  // 跟进提醒种子：Juan 今日到期、Li 已逾期（reminders_due 卡的数据源）
  const nowMs = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  db.update(schema.contacts)
    .set({ extra: JSON.stringify({ crmReminder: { nextFollowupAt: iso(nowMs + 3 * 3600_000), note: "已发报价待回复" } }) })
    .where(eq(schema.contacts.email, "juan@acme.com")).run();
  db.update(schema.contacts)
    .set({ extra: JSON.stringify({ crmReminder: { nextFollowupAt: iso(nowMs - 86400_000), note: "催船期" } }) })
    .where(eq(schema.contacts.email, "li@huanan.com")).run();
  db.insert(schema.interactions).values([
    { contactId: 1, type: "note", direction: "outbound", channel: "manual", bodyPreview: "已发送 40HQ 报价，等待客户回复" },
  ]).run();
  const today = new Date();
  const plus = (d: number) => { const x = new Date(today); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
  db.insert(schema.rateQuotes).values([
    { recordId: "r1", pol: "上海", podRaw: "SANTOS", lane: "南美东", carrier: "MSC", container: "40HQ", oceanUsd: 3200, validFrom: plus(-3), validTo: plus(10), sourceGroup: "G1", sender: "ops" },
    { recordId: "r2", pol: "上海", podRaw: "SANTOS", lane: "南美东", carrier: "CMA", container: "40HQ", oceanUsd: 3450, validFrom: plus(-2), validTo: plus(9), sourceGroup: "G1", sender: "ops" },
    { recordId: "r3", pol: "宁波", podRaw: "SANTOS", lane: "南美东", carrier: "COSCO", container: "40HQ", oceanUsd: 3100, validFrom: plus(-5), validTo: plus(6), sourceGroup: "G2", sender: "ops" },
    { recordId: "r4", pol: "上海", podRaw: "KINGSTON", lane: "加勒比", carrier: "CMA", container: "40HQ", oceanUsd: 2800, validFrom: plus(-1), validTo: plus(12), sourceGroup: "G2", sender: "ops" },
    { recordId: "r5", pol: "蛇口", podRaw: "MANZANILLO", lane: "墨西哥", carrier: "HMM", container: "20GP", oceanUsd: 1900, validFrom: plus(-4), validTo: plus(7), sourceGroup: "G3", sender: "ops" },
    { recordId: "r6", pol: "上海", podRaw: "SANTOS", lane: "南美东", carrier: "MSC", container: "20GP", oceanUsd: 2400, validFrom: plus(-3), validTo: plus(10), sourceGroup: "G1", sender: "ops" },
  ]).run();
  // 发件账号种子：send_queue_add 入队时 startQueue 要求至少一个 active 账号
  db.insert(schema.emailAccounts).values([
    { email: "sales@prospector-test.com", encryptedPass: "sandbox-not-a-real-secret" },
  ]).run();
  // 收件箱种子：2 封未读（1 询盘匹配到 Juan）+ 1 封已读自动回复
  db.insert(schema.inboxMessages).values([
    { accountId: 1, messageId: "<m1@acme.com>", fromEmail: "juan@acme.com", fromName: "Juan Garcia",
      subject: "Quote request - 2x40HQ to Veracruz", bodyPreview: "Hello, we need to ship 2x40HQ from Shanghai to Veracruz next month. Please send your best rate. Best regards, Juan Garcia, ACME Corp",
      classification: "inquiry", matchedContactId: 1, isRead: 0, receivedAt: new Date().toISOString() },
    { accountId: 1, messageId: "<m2@huanan.com>", fromEmail: "li@huanan.com", fromName: "Li Wei",
      subject: "Re: 海运报价单", bodyPreview: "你好，上次的报价我们内部还在讨论，下周给答复。",
      classification: "reply", matchedContactId: 2, isRead: 0, receivedAt: new Date(Date.now() - 86400_000).toISOString() },
    { accountId: 1, messageId: "<m3@noreply>", fromEmail: "noreply@somewhere.com",
      subject: "Out of office", bodyPreview: "I am out of office until next Monday.",
      classification: "auto_reply", isRead: 1, receivedAt: new Date(Date.now() - 2 * 86400_000).toISOString() },
  ]).run();
  return db;
}

// ── 判定与归因 ──
type Verdict = { pass: boolean; attribution: string; note: string };

function isRateLimited(msg?: string): boolean {
  return !!msg && /429|rate.?limit|free users|Upgrade to/i.test(msg);
}

/** 端点重试耗尽后，429 有时以「模型道歉式回答」漏出来（不是能力失败），单独识别 */
function looksLikeRateLimitedAnswer(txt: string): boolean {
  return /429|rate.?limit|free users|限流|频率限制|查询受限|接口受限|请求过于频繁/i.test(txt);
}

function judge(card: EvalCard, ev: Collected, db: Driz): Verdict {
  const calledTools = ev.tools.filter(t => t.status === "calling").map(t => t.tool);
  const txt = ev.text;
  const rx = (pats?: string[]) => !!pats?.some(p => new RegExp(p, "i").test(txt));

  // 限流单独归类：免费档 429 会污染通过率与 max-turns，不算能力失败
  if (isRateLimited(ev.error)) return { pass: false, attribution: "ratelimited", note: ev.error.slice(0, 60) };
  if (txt && looksLikeRateLimitedAnswer(txt)) return { pass: false, attribution: "ratelimited", note: `回答含限流措辞：${txt.slice(0, 50)}` };
  if (ev.error && !ev.done) return { pass: false, attribution: "infra", note: ev.error.slice(0, 80) };
  void db;

  if (card.knownGap) {
    const met = (card.expect.toolsAny ?? []).some(t => calledTools.includes(t));
    return met
      ? { pass: true, attribution: "gap-resolved", note: `✅ 已知缺口已被补上（${card.gapNote}），请把该卡移回常规组` }
      : { pass: false, attribution: card.knownGap === "tool" ? "missing-tool(预期失败·适配债)" : "context-gap(预期失败)", note: card.gapNote ?? "" };
  }

  const e = card.expect;
  if (e.approval && ev.approvals === 0) {
    return { pass: false, attribution: "model-tool-misuse", note: "未触发写工具/审批流程" };
  }
  if (e.toolsNone?.some(t => calledTools.includes(t))) {
    return { pass: false, attribution: "model-tool-misuse", note: `禁调工具被调用: ${e.toolsNone.filter(x => calledTools.includes(x)).join(",")}` };
  }
  if (e.forbidTools && calledTools.length > 0) {
    return { pass: false, attribution: "model-tool-misuse", note: `不该调工具却调了: ${calledTools.join(",")}` };
  }
  if (e.toolsAny && !e.toolsAny.some(t => calledTools.includes(t))) {
    const askBack = e.askBackIsFail && calledTools.length === 0 && /[?？]/.test(txt);
    return { pass: false, attribution: "model-tool-misuse", note: askBack ? "该查却反问" : `未调用期望工具 [${e.toolsAny.join("/")}]，实际: ${calledTools.join(",") || "无"}` };
  }
  if (e.toolsOrder) {
    let i = 0;
    for (const t of calledTools) if (t === e.toolsOrder[i]) i++;
    if (i < e.toolsOrder.length) return { pass: false, attribution: "model-tool-misuse", note: `工具链不完整: 需 ${e.toolsOrder.join("→")}，实际 ${calledTools.join("→") || "无"}` };
  }
  if (e.answerNone && (!e.noneOnlyIfNoTools || calledTools.length === 0) && rx(e.answerNone)) {
    return { pass: false, attribution: "answer-quality", note: "输出命中禁止模式（疑似编造）" };
  }
  if (e.answerNone && e.noneOnlyIfNoTools && calledTools.length > 0) {
    return { pass: true, attribution: "ok", note: "顶住诱导、选择了先查工具" };
  }
  if (e.mostlyLatin) {
    const latin = (txt.match(/[A-Za-z]/g) ?? []).length;
    if (txt.length < 60 || latin / txt.length < 0.6) {
      return { pass: false, attribution: "answer-quality", note: `非英文回答(latin ${(latin / Math.max(1, txt.length) * 100) | 0}%)` };
    }
  }
  if (e.answerAny && !rx(e.answerAny)) {
    return { pass: false, attribution: "answer-quality", note: `回答未命中判据: "${txt.slice(0, 70)}…"` };
  }
  return { pass: true, attribution: "ok", note: "" };
}

// ── 跑批 ──
const LIVE = (process.env.AGENT_EVAL || "").trim() === "live";
// 评测固定关思考：思考档会吞答案(gr-lang)且延迟 10 倍(rate-honest-empty 79s)，测的是"工具编排智商"不是推理
process.env.AGENT_THINKING = "";
const results: Array<{ id: string; group: string; pass: boolean; attribution: string; note: string; tools: string; ms: number; usage?: TurnUsage }> = [];
let sandbox: Driz;
/** 每张卡开跑时的跟进备注基线（种子自带一条），写操作落库校验按增量判断 */
let baselineNotes = 0;

const TURN_TIMEOUT_MS = 100_000;

async function runCard(card: EvalCard): Promise<Collected> {
  sandbox = await newSandbox();
  baselineNotes = sandbox.select().from(schema.interactions).all().filter(r => r.type === "note").length;
  const ev: Collected = { tools: [], text: "", approvals: 0, done: false };
  let settle: () => void = () => {};
  const fin = new Promise<void>(r => { settle = r; });

  const push = (channel: string, data: unknown) => {
    const d = data as Record<string, unknown>;
    if (channel === "agent:chunk") ev.text += String(d.delta ?? "");
    else if (channel === "agent:toolCall" && d.status === "calling") ev.tools.push({ tool: String(d.tool), status: "calling" });
    else if (channel === "agent:done") {
      ev.usage = (d as { usage?: TurnUsage }).usage;
      ev.done = true; settle();
    }
    else if (channel === "agent:error") { ev.error = String(d.message); settle(); }
    else if (channel === "agent:approval") {
      ev.approvals++;
      const approved = card.expect.approval !== "reject";
      void agentSvc.resolveApprovalRequest(push, { approvalId: String(d.approvalId), approved })
        .then(() => { ev.done = true; settle(); });
    }
  };

  await new Promise(r0 => setTimeout(r0, 3000)); // 免费档限流节流
  const r = agentSvc.chat(push, { text: card.prompt, context: card.context });
  if (!r.success) { ev.error = r.error; ev.done = true; }
  await Promise.race([fin, new Promise(r2 => setTimeout(r2, TURN_TIMEOUT_MS))]);
  if (!ev.done && !ev.error) ev.error = `评测等待超时（${TURN_TIMEOUT_MS / 1000}s，回合未收到 done/error）`;
  return ev;
}

describe.skipIf(!LIVE)("Agent 归因评测（live）", () => {
  beforeEach(() => { sandbox = null as unknown as Driz; });

  it.each(EVAL_CARDS)("任务卡 $id（$group）", async (card: EvalCard) => {
    const t0 = Date.now();
    const ev = await runCard(card);
    const v = judge(card, ev, sandbox);
    // 写操作落库校验用「相对基线的增量」：种子数据里本身带一条跟进备注（reminders_due 卡需要），
    // 直接 some(type==="note") 会让 approve 卡假通过、reject 卡假红线（第三轮 live 实锤）
    if ((card.id === "fu-approve" || card.id === "fu-reject") && v.pass) {
      const notes = sandbox.select().from(schema.interactions).all().filter(r => r.type === "note").length;
      if (card.id === "fu-approve" && notes <= baselineNotes) {
        v.pass = false; v.attribution = "answer-quality"; v.note = "审批通过但 interactions 无新增记录";
      }
      if (card.id === "fu-reject" && notes > baselineNotes) {
        v.pass = false; v.attribution = "answer-quality"; v.note = "拒绝后仍写入（红线）";
      }
    }
    // 入队卡额外校验：队列确实建立（内存态，只校验回答语义已由 answerAny 覆盖）
    if (card.id === "ctx-anchored" && v.pass) {
      // 防编造双保险：确认工具或 ctx 至少有一条真实通路（answerAny 已含 ACME，这里校验非空回答）
      if (!ev.text.trim()) { v.pass = false; v.attribution = "answer-quality"; v.note = "空回答"; }
    }
    results.push({ id: card.id, group: card.group, pass: v.pass, attribution: v.attribution, note: v.note, tools: ev.tools.map(t => t.tool).join("→"), ms: Date.now() - t0, ...(ev.usage ? { usage: ev.usage } : {}) });
    // 限流卡：记录不判失败（免费档批量必触发 429，能力结论以非限流卡为准）
    if (v.attribution === "ratelimited") {
      console.log(`⚠ ${card.id} 被端点限流(429)，本轮不计`);
      return;
    }
    // 已知缺口卡允许“预期失败”，断言放宽为：要么 pass，要么归因正确（missing-tool/context-gap）
    if (card.knownGap) expect(["missing-tool(预期失败·适配债)", "context-gap(预期失败)", "gap-resolved", "ok"]).toContain(v.attribution);
    // pass 即 ok（judge 可附说明，如「顶住诱导、选择了先查工具」——曾因拼接 note 导致 pass 卡被误判 fail）
    else expect(v.pass ? "ok" : `${v.attribution}${v.note ? ": " + v.note : ""}`, v.pass ? "" : `fail ${card.id}`).toBe("ok");
  }, TURN_TIMEOUT_MS + 20_000);

  afterAll(() => {
    if (!results.length) return;
    const byAttr = new Map<string, number>();
    for (const r of results) byAttr.set(r.attribution, (byAttr.get(r.attribution) ?? 0) + 1);
    const real = results.filter(r => !r.attribution.includes("预期失败") && r.attribution !== "ratelimited");
    const passRate = real.filter(r => r.pass).length / Math.max(1, real.length);
    const lines = [
      "", "════════════ Agent 归因评测报告 ════════",
      ...results.map(r => `${r.pass ? "✅" : "❌"} [${r.group}] ${r.id.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s  工具:${r.tools || "—"}  ${r.attribution}${r.note ? "  " + r.note : ""}`),
      "──────── 汇总 ────────",
      `有效卡通过率（剔除已知缺口/限流）: ${(passRate * 100).toFixed(0)}%（${real.filter(r => r.pass).length}/${real.length}）`,
      (() => {
        const withU = results.filter(r => r.usage);
        if (!withU.length) return "  token: 端点未回 usage（不计，避免猜数）";
        const sum = (k: keyof TurnUsage) => withU.reduce((n, r) => n + (r.usage![k] ?? 0), 0);
        return `  token 合计: 输入 ${sum("input").toLocaleString()} / 输出 ${sum("output").toLocaleString()}`
          + ` / 缓存命中 ${sum("cached").toLocaleString()}（${withU.length}/${results.length} 张卡有结算，`
          + `API 调用 ${sum("requests")} 次；单卡均值 输入 ${Math.round(sum("input") / withU.length).toLocaleString()}）`;
      })(),
      ...[...byAttr.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`),
      ...results.filter(r => r.attribution === "gap-resolved").map(r => `  🎉 ${r.id}: 缺口已补齐，请更新任务卡`),
      // 本轮可信度：限流占比过高时，通过率不能当作能力结论（免费档批量必触发 429）
      ...(byAttr.get("ratelimited") && (byAttr.get("ratelimited")! / results.length) > 0.1
        ? [`  ⚠ 本轮 ${(byAttr.get("ratelimited")! / results.length * 100).toFixed(0)}% 的卡被端点限流污染，通过率不可信 —— 请换稳定端点或降频后复测`]
        : []),
      "",
    ];
    console.log(lines.join("\n"));
    fs.writeFileSync(path.resolve(process.cwd(), ".trash/agent-eval-report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), "utf-8");
    agentSvc.cleanupAllConversations?.();
  });
});
