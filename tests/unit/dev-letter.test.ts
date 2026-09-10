import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { contacts } from "../../src/main/db/schema/contacts";
import { emailAccounts } from "../../src/main/db/schema/accounts";

// ═══════════════════════════════════════════════════════════════════
// 首页「自动开发信」推荐群组（docs/home-cards-spec.md §2）：
// 确定性规则、无模型参与——从未触达 + 邮箱有效 → 每公司 1 位 → 齐全度排序 → 限额内截断。
// 红线：只产生"推荐 + 名单"，绝不入队、绝不发送。
// ═══════════════════════════════════════════════════════════════════

const TMP = path.join(os.tmpdir(), "prospector-dev-letter-test");
type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
const quotaState = { dailyLimit: 0, sentToday: 0 };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/config", () => ({
  loadConfig: () => ({ sendQuota: { dailyLimit: quotaState.dailyLimit, sentToday: quotaState.sentToday } }),
}));

const { recommendDevLetterGroup } = await import("../../src/main/services/dev-letter.service");

let raw: SqlJsDatabase;

function freshDb(): void {
  raw = new SQLLIB.Database();
  raw.exec(`
    CREATE TABLE contacts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE, company_id integer,
      first_name text, last_name text, title text, phone text, linkedin text, country text,
      client_type text, language text,
      stage text DEFAULT 'cold', status text DEFAULT '', tags text, extra text DEFAULT '{}',
      assignee text DEFAULT '', source text DEFAULT 'manual', source_detail text,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
    CREATE TABLE companies (
      id integer PRIMARY KEY NOT NULL, name text NOT NULL, short_name text, industry text, website text,
      country text, note text, created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE email_accounts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE,
      provider text NOT NULL DEFAULT 'smtp', smtp_host text, smtp_port integer,
      imap_host text, imap_port integer, encrypted_pass text NOT NULL DEFAULT '',
      display_name text, signature text, consecutive_fails integer DEFAULT 0 NOT NULL,
      circuit_open_at text, circuit_reset_after text, circuit_reason text, last_fetch_error text, last_fetch_at text,
      fetch_fail_count integer DEFAULT 0 NOT NULL, is_active integer DEFAULT 1 NOT NULL,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
    /* 推荐口径要看"有没有真发出去过"（规范 §2）：sent 交互 + 未完结任务归属 */
    CREATE TABLE interactions (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, contact_id integer, company_id integer,
      type text NOT NULL, direction text, channel text, subject text, body_preview text,
      account_id integer, created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE send_campaigns (
      id text PRIMARY KEY NOT NULL, name text NOT NULL, status text DEFAULT 'running' NOT NULL,
      auto_send integer DEFAULT 1 NOT NULL, target_filter_json text DEFAULT '{}' NOT NULL,
      touch_plan_json text NOT NULL, created_by text DEFAULT 'agent' NOT NULL,
      account_policy text DEFAULT 'rotate' NOT NULL, account_ids_json text, schedule_json text,
      send_mode text DEFAULT 'individual' NOT NULL,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
    CREATE TABLE send_campaign_targets (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, campaign_id text NOT NULL, contact_id integer NOT NULL,
      status text DEFAULT 'pending' NOT NULL, round integer DEFAULT 0 NOT NULL, next_touch_at text,
      last_sent_at text, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
  `);
  const db = drizzle(raw, { schema });
  h.db = db;
  db.insert(emailAccounts).values([
    { id: 1, email: "a@x.com", encryptedPass: "x", isActive: 1 },
    { id: 2, email: "b@x.com", encryptedPass: "x", isActive: 1 },
  ] as never).run();
}

/** 给联系人挂一条"真发出去过"的交互（推荐口径 §2：有 sent 交互就不再是冷客户） */
function markSent(contactId: number): void {
  raw.exec(`INSERT INTO interactions (contact_id, type, direction, channel) VALUES (${contactId}, 'sent', 'outbound', 'email')`);
}

/** 建一个任务并把联系人挂进去（campaignStatus 决定这批人算不算"已在未完结任务里"） */
function addCampaign(campaignId: string, campaignStatus: string, contactIds: number[], targetStatus = "pending"): void {
  raw.exec(`INSERT INTO send_campaigns (id, name, status, touch_plan_json)
            VALUES ('${campaignId}', '任务-${campaignId}', '${campaignStatus}', '[]')`);
  for (const cid of contactIds) {
    raw.exec(`INSERT INTO send_campaign_targets (campaign_id, contact_id, status)
              VALUES ('${campaignId}', ${cid}, '${targetStatus}')`);
  }
}

function addContact(p: {
  id: number; email: string; name?: string; status?: string; companyId?: number | null;
  language?: string | null; country?: string | null; title?: string | null; createdAt?: string;
  stage?: string; clientType?: string | null;
}): void {
  const [first = null, last = null] = (p.name ?? "").split(" ");
  h.db.insert(contacts).values({
    id: p.id, email: p.email, firstName: first, lastName: last,
    status: p.status ?? "", companyId: p.companyId ?? null,
    language: p.language ?? null, country: p.country ?? null, title: p.title ?? null,
    stage: p.stage ?? "cold", clientType: p.clientType ?? null,
    createdAt: p.createdAt ?? new Date().toISOString(),
  } as never).run();
}

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});

beforeEach(() => {
  freshDb();
  quotaState.dailyLimit = 0;
  quotaState.sentToday = 0;
});

describe("推荐群组：确定性规则（从未触达 → 每公司 1 位 → 齐全度排序 → 限额截断）", () => {
  it("只收从未触达的冷客户；已回复/退信/自动回复/已触达都不进", () => {
    addContact({ id: 1, email: "a@acme.com", name: "A One", status: "" });
    addContact({ id: 2, email: "b@acme.com", name: "B Two", status: "reached" });
    addContact({ id: 3, email: "c@acme.com", name: "C Three", status: "replied" });
    addContact({ id: 4, email: "d@acme.com", name: "D Four", status: "bounced" });
    addContact({ id: 5, email: "e@acme.com", name: "E Five", status: "autoreply" });
    const r = recommendDevLetterGroup();
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.contacts.map(c => c.id)).toEqual([1]);
    expect(r.data.totalCandidates).toBe(1);
  });

  it("占位/无效邮箱剔除，不占名额", () => {
    addContact({ id: 1, email: "real@acme.com", name: "Real" });
    addContact({ id: 2, email: "xxx@no.email", name: "Placeholder" });   // 项目约定的占位邮箱写法
    addContact({ id: 3, email: "broken-at-acme", name: "Broken" });       // 缺 @ 与域名
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.map(c => c.id)).toEqual([1]);
  });

  it("每公司只取 1 位，资料齐全的优先；无公司按邮箱域分组", () => {
    // 同公司 acme：#2 资料全（语言+国家+职位），#1 只有邮箱 → 取 #2
    addContact({ id: 1, email: "a@acme.com", name: "A", companyId: 11, createdAt: "2026-01-01T00:00:00Z" });
    addContact({ id: 2, email: "b@acme.com", name: "B", companyId: 11, language: "EN", country: "Brazil", title: "Buyer" });
    // 无公司按邮箱域分组：同域 = 同一主体，只取 1 位（资料齐全的 Y 优先）
    addContact({ id: 3, email: "x@gateway.io", name: "X", companyId: null, createdAt: "2026-02-01T00:00:00Z" });
    addContact({ id: 4, email: "y@gateway.io", name: "Y", companyId: null, language: "EN", createdAt: "2026-01-01T00:00:00Z" });
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.map(c => c.id)).toEqual([2, 4]);
    expect(r.success && r.data.companyCount).toBe(2);
  });

  it("限额截断：日限 100 已发 95 → 只推 5 位；未设限额按 50 封顶", () => {
    for (let i = 1; i <= 10; i++) addContact({ id: i, email: `c${i}@c${i}.com`, name: `C${i}` });
    quotaState.dailyLimit = 100;
    quotaState.sentToday = 95;
    const r1 = recommendDevLetterGroup();
    expect(r1.success && r1.data.groupSize).toBe(5);
    expect(r1.success && r1.data.quota.remaining).toBe(5);
    quotaState.dailyLimit = 0;
    quotaState.sentToday = 0;
    const r2 = recommendDevLetterGroup();
    expect(r2.success && r2.data.groupSize).toBe(10);      // 候选只有 10 位，50 的封顶没顶到
  });

  it("推荐理由与语言分布可解释；零候选时给可执行的原因", () => {
    addContact({ id: 1, email: "a@acme.com", name: "A", language: "EN" });
    addContact({ id: 2, email: "b@acme.com", name: "B", language: "ES" });
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.reasons.length).toBeGreaterThanOrEqual(3);
    expect(r.success && r.data.languages.some(l => l.lang === "EN" && l.n === 1)).toBe(true);
    expect(r.success && r.data.contacts.every(c => c.name && c.email)).toBe(true);

    freshDb();                                                  // 清库再验零候选分支
    const empty = recommendDevLetterGroup();
    expect(empty.success && empty.data.contacts.length).toBe(0);
    expect(empty.success ? empty.data.reasons[0] : "").toContain("从未触达");
  });
});

// ── 规范 §2：发过信 / 已在任务里的人不再推荐（用户报的"重复建同一批人"根因）────
describe("推荐口径：真·从未触达 + 不撞未完结任务", () => {
  it("有 sent 交互的人不再进池（status 仍是空也照样剔掉——旧口径就在这里漏人）", () => {
    addContact({ id: 1, email: "a@acme.com", name: "A" });
    addContact({ id: 2, email: "b@acme.com", name: "B" });
    markSent(2);
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.map(c => c.id)).toEqual([1]);
    expect(r.success && r.data.totalCandidates).toBe(1);
  });

  it("stage 已推进（正在跟进）的人不当冷客户推荐", () => {
    addContact({ id: 1, email: "a@acme.com", name: "A", stage: "f1" });
    addContact({ id: 2, email: "b@acme.com", name: "B", stage: "cold" });
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.map(c => c.id)).toEqual([2]);
  });

  it("挂在未完结任务里的人被排除并如实报数；done 任务里的人照常可再开发", () => {
    addContact({ id: 1, email: "a@a1.com", name: "A" });
    addContact({ id: 2, email: "b@a2.com", name: "B" });
    addContact({ id: 3, email: "c@a3.com", name: "C" });
    addCampaign("run1", "running", [1]);
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.map(c => c.id)).toEqual([2, 3]);
    expect(r.success && r.data.excludedInCampaign).toBe(1);
    expect(r.success && r.data.reasons.some(x => x.includes("已在进行中的任务"))).toBe(true);

    addCampaign("done1", "done", [2]);                          // 完结任务不挡下一轮开发
    const r2 = recommendDevLetterGroup();
    expect(r2.success && r2.data.contacts.map(c => c.id)).toEqual([2, 3]);
    expect(r2.success && r2.data.excludedInCampaign).toBe(1);
  });

  it("任务里触点已是终态（sent/replied）的人不占「已在任务」名额", () => {
    addContact({ id: 1, email: "a@a1.com", name: "A" });
    addContact({ id: 2, email: "b@a2.com", name: "B" });
    addCampaign("run1", "running", [1], "sent");
    addCampaign("run2", "paused", [2], "replied");
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.map(c => c.id)).toEqual([1, 2]);
    expect(r.success && r.data.excludedInCampaign).toBe(0);
  });

  it("库里没冷客户时，零候选理由会指路到未完结任务的人数", () => {
    addContact({ id: 1, email: "a@acme.com", name: "A" });
    addCampaign("run1", "running", [1]);
    const r = recommendDevLetterGroup();
    expect(r.success && r.data.contacts.length).toBe(0);
    expect(r.success && r.data.reasons[0]).toContain("另有 1 位正在未完结的任务里");
  });
});

// ── 规范 §4：用户要求只作确定性收窄（模型翻条件，选人规则不变）──────────────
describe("用户要求的确定性收窄 criteria", () => {
  beforeEach(() => {
    addContact({ id: 1, email: "a@br.com", name: "A", companyId: 11, country: "Brazil", language: "EN", clientType: "direct" });
    addContact({ id: 2, email: "b@br.com", name: "B", companyId: 12, country: "巴西", language: "PT" });
    addContact({ id: 3, email: "c@mx.com", name: "C", companyId: 13, country: "Mexico", language: "ES", clientType: "agent" });
  });

  it("国家走中英别名双向匹配：说「巴西」同时命中库里写 Brazil 与写 巴西 的", () => {
    const r = recommendDevLetterGroup(undefined, new Date(), { country: "巴西", parsedBy: "keyword" });
    expect(r.success && r.data.contacts.map(c => c.id).sort()).toEqual([1, 2]);
    expect(r.success && r.data.applied.parsedBy).toBe("keyword");
    expect(r.success && r.data.reasons[0]).toContain("巴西");
  });

  it("语言与客户类型精确收窄；解析来源如实带回", () => {
    const byLang = recommendDevLetterGroup(undefined, new Date(), { language: "ES", parsedBy: "model" });
    expect(byLang.success && byLang.data.contacts.map(c => c.id)).toEqual([3]);
    const byType = recommendDevLetterGroup(undefined, new Date(), { clientType: "direct", parsedBy: "keyword" });
    expect(byType.success && byType.data.contacts.map(c => c.id)).toEqual([1]);
  });

  it("点名的数量优先于日限额与 50 封顶", () => {
    quotaState.dailyLimit = 100; quotaState.sentToday = 0;
    const r = recommendDevLetterGroup(undefined, new Date(), { limit: 2, parsedBy: "model" });
    expect(r.success && r.data.groupSize).toBe(2);
    expect(r.success && r.data.reasons[0]).toContain("前 2 位");
  });

  it("「按这个要求没人」与「库里没冷客户」两种空集必须分开说", () => {
    const none = recommendDevLetterGroup(undefined, new Date(), { country: "智利", parsedBy: "keyword" });
    expect(none.success && none.data.contacts.length).toBe(0);
    expect(none.success && none.data.totalCandidates).toBe(3);        // 池子有人，只是不合这个条件
    expect(none.success && none.data.reasons[0]).toContain("没筛到人");

    freshDb();
    const empty = recommendDevLetterGroup(undefined, new Date(), { country: "智利" });
    expect(empty.success && empty.data.reasons[0]).toContain("从未触达");   // 库里本来就没冷客户
  });
});
