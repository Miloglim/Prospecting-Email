import { beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════════
// 新对话「行动建议」流（docs/suggestion-feed-spec.md）：
//  纯函数层——三桶候选 / 选取约束 / 轮换 / 问候语 / diff 计算；
//  SQL 集成层——未回询盘口径、退信窗口、往来匹配、dismiss 记忆（sql.js 沙箱）。
//  crm/send/rate-sync 全 mock（feed 只该依赖自己的 SQL），LLM 批生成已退役不再测。
// ═══════════════════════════════════════════════════════════════════

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suggest-feed-"));

// APP_ROOT 之外还要 DB_PATH：suggestion.service 现在复用 inbox.service 的 internalDomains()
// （客户回复一键行动要排除我方内部域名的互转），后者经 config 取库路径
vi.mock("../../src/main/config", () => ({ APP_ROOT: TMP, DB_PATH: path.join(TMP, "prospector.db") }));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => null,
}));

// crm/send/rate-sync：feed 的外部依赖全部可控注入
const mocks = vi.hoisted(() => ({
  reminders: { value: null as null | { due: unknown[]; overdue: unknown[] } },
  send: { value: null as null | { failed: number; pendingGroups: number; pendingRecipients: number; paused: boolean } },
  diff: { value: null as unknown },
}));
vi.mock("../../src/main/services/crm.service", () => ({
  checkReminders: () => (mocks.reminders.value
    ? { success: true, data: mocks.reminders.value }
    : { success: false, error: "off" }),
}));
vi.mock("../../src/main/services/send.service", () => ({
  getSendStatus: () => (mocks.send.value
    ? { success: true, data: { isRunning: false, isPaused: mocks.send.value!.paused, failedCount: mocks.send.value!.failed } }
    : { success: false, error: "off" }),
  getQueueItems: () => (mocks.send.value
    ? {
        success: true,
        data: Array.from({ length: mocks.send.value!.pendingGroups }, (_, i) => ({
          id: `g${i}`, status: "pending", recipients: [{ email: `r${i}@x.com` }],
        })),
      }
    : { success: false, error: "off" }),
}));
// rate-sync 只 mock 取数口（ratesDiff），computeRatesDiff/parseFlexDate 用真实现
vi.mock("../../src/main/services/rate-sync.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/services/rate-sync.service")>();
  return { ...actual, ratesDiff: () => mocks.diff.value };
});

const {
  collectCandidates, selectItems, buildGreeting, buildFeed, podToken, ctxContactId,
  feed, dismiss, beijingDay,
} = await import("../../src/main/services/suggestion.service");
type FeedInputs = import("../../src/main/services/suggestion.service").FeedInputs;
type Candidate = import("../../src/main/services/suggestion.service").Candidate;
const { computeRatesDiff, parseFlexDate } = await import("../../src/main/services/rate-sync.service");

// ── 纯函数层夹具 ──────────────────────────────────────────

const NOW = Date.parse("2026-09-07T04:00:00Z");   // 北京时间中午 12 点

const emptyInputs = (over: Partial<FeedInputs> = {}): FeedInputs => ({
  now: NOW,
  reminders: null,
  send: null,
  mail: { unread: 0, latest: null, unreplied: null, bounce3d: 0 },
  replyActions: [],
  diff: null,
  related: new Map(),
  dismissed: new Set(),
  ...over,
});

const reminder = (id: number, name: string, staleDays: number) => ({
  id, email: `${name}@x.com`, firstName: name, lastName: null, staleDays,
});

describe("三桶候选生成", () => {
  it("跟进桶：逾期最久 → fu-stale（≥14 天转 urgent）；今天到期 → fu-due", () => {
    const inp = emptyInputs({
      reminders: { due: [reminder(2, "Ana", 0)], overdue: [reminder(1, "Juan", 20), reminder(3, "Bo", 5)] },
    });
    const c = collectCandidates(inp);
    const stale = c.find(x => x.key === "fu-stale-1")!;
    expect(stale.text).toBe("「Juan」沉默 20 天了，先处理他");
    expect(stale.tone).toBe("urgent");
    expect(stale.href).toBe("#/customers?view=table&detail=1");
    expect(c.find(x => x.key === "fu-due")!.text).toBe("今天有 1 位该跟进，帮我排个顺序");
  });

  it("发信桶：失败组压过待发组（failed 与 pending 不同时出）", () => {
    const both = collectCandidates(emptyInputs({ send: { failed: 2, pendingGroups: 5, pendingRecipients: 9, paused: false } }));
    expect(both.map(x => x.key)).toEqual(["fu-failed"]);
    expect(both[0]!.tone).toBe("urgent");
    const pend = collectCandidates(emptyInputs({ send: { failed: 0, pendingGroups: 5, pendingRecipients: 9, paused: true } }));
    expect(pend[0]!.key).toBe("fu-pending");
    expect(pend[0]!.text).toContain("队列暂停中");
  });

  it("邮件桶：未回询盘带新鲜度加分；未读只在最新一封 ≤2h 时出", () => {
    const fresh = collectCandidates(emptyInputs({
      mail: {
        unread: 3, bounce3d: 0,
        latest: { who: "Kat", subject: "YML FAK", receivedAt: new Date(NOW - 30 * 60_000).toISOString() },
        unreplied: { id: 77, from: "GCRA", subject: "Re: Logistics", receivedAt: new Date(NOW - 60 * 60_000).toISOString(), contactId: 5 },
      },
    }));
    const un = fresh.find(x => x.key === "mail-unreplied-77")!;
    expect(un.text).toBe("GCRA 的「Re: Logistics」还没回，起草回复");
    expect(un.score).toBe(38);            // 30 + 2h 内新鲜 8
    expect(un.contactId).toBe(5);
    expect(fresh.some(x => x.key === "mail-unread")).toBe(true);

    const old = collectCandidates(emptyInputs({
      mail: {
        unread: 3, bounce3d: 0,
        latest: { who: "Kat", subject: "旧邮件", receivedAt: new Date(NOW - 5 * 3600_000).toISOString() },
        unreplied: null,
      },
    }));
    expect(old.some(x => x.key === "mail-unread")).toBe(false);   // 5 小时前的「新到」不再当新闻
  });

  it("退信：近 3 天有退信 → urgent 候选", () => {
    const c = collectCandidates(emptyInputs({ mail: { unread: 0, latest: null, unreplied: null, bounce3d: 4 } }));
    const b = c.find(x => x.key === "mail-bounce")!;
    expect(b.text).toBe("近 3 天 4 封退信要处理");
    expect(b.tone).toBe("urgent");
  });

  it("资讯桶：降价文案带船司/柜型/新旧价；往来匹配命中就带客户名与跳转", () => {
    const inp = emptyInputs({
      diff: {
        syncedAt: new Date(NOW).toISOString(),
        addedPods: [], expiringSoon: [], spacesClosing: [],
        priceDrops: [{ podRaw: "SANTOS 桑托斯(巴西)", carrier: "MSC", container: "40HQ", oldUsd: 3200, newUsd: 2800 }],
      },
      related: new Map([["SANTOS", { id: 9, name: "Juan Garcia" }]]),
    });
    const c = collectCandidates(inp);
    const drop = c.find(x => x.key.startsWith("intel-drop"))!;
    expect(drop.text).toBe("SANTOS MSC 40HQ 降到 $2800（原 $3200），可以给 Juan Garcia 同步");
    expect(drop.href).toBe("#/customers?view=table&detail=9");
    expect(drop.score).toBe(35);          // 30 + 降幅 12.5% → round(5) = 5

    // 匹配不到客户 → 退化文案，不猜名字
    const bare = collectCandidates(emptyInputs({ diff: inp.diff }));
    expect(bare.find(x => x.key.startsWith("intel-drop"))!.text).toContain("可以同步给客户");
  });

  it("资讯桶：新增航线 / 即将过期 / 临近截关各出一条", () => {
    const c = collectCandidates(emptyInputs({
      diff: {
        syncedAt: new Date(NOW).toISOString(),
        priceDrops: [],
        addedPods: [{ podRaw: "KINGSTON 金斯敦(牙买加)", n: 3 }],
        expiringSoon: [{ podRaw: "VERACRUZ", n: 2, minDays: 4 }],
        spacesClosing: [{ podRaw: "SANTOS", vessel: "CMA CGM DIGNITY", etd: "9.8", boxQty: "2个40HQ", days: 1 }],
      },
    }));
    expect(c.find(x => x.key === "intel-added-KINGSTON 金斯敦(牙买加)")!.text).toBe("台账新上 KINGSTON 航线 3 条报价");
    expect(c.find(x => x.key === "intel-expiring-VERACRUZ")!.text).toBe("VERACRUZ 的 2 条报价 4 天后过期，要不要先锁价");
    const sp = c.find(x => x.key.startsWith("intel-space"))!;
    expect(sp.text).toContain("CMA CGM DIGNITY");
    expect(sp.text).toContain("还剩 2个40HQ");
  });
});

describe("选取约束", () => {
  const many = (): Candidate[] => [
    { bucket: "mail", key: "m1", text: "邮件一", tone: "mail", score: 40, prefix: "管邮件" },
    { bucket: "mail", key: "m2", text: "邮件二", tone: "mail", score: 39, prefix: "管邮件" },
    { bucket: "mail", key: "m3", text: "邮件三", tone: "mail", score: 38, prefix: "管邮件" },
    { bucket: "followup", key: "f1", text: "跟新一", tone: "urgent", score: 37, prefix: "跟进客户" },
    { bucket: "intel", key: "i1", text: "资讯一", tone: "intel", score: 36, prefix: "查运价" },
    { bucket: "intel", key: "i2", text: "资讯二", tone: "intel", score: 35, prefix: "查运价" },
  ];

  it("最多 4 条、同桶最多 2 条（第 3 封邮件让位给跟进/资讯）", () => {
    const picked = selectItems(many(), emptyInputs());
    expect(picked.map(p => p.key)).toEqual(["m1", "m2", "f1", "i1"]);
  });

  it("dismissed 当天不再出；池子被 dismiss 空了 → 预备库补齐 3 条静态介绍", () => {
    const inp = emptyInputs({ dismissed: new Set(["m1", "m2"]) });
    expect(selectItems(many(), inp).map(p => p.key)).toEqual(["m3", "f1", "i1", "i2"]);
    const all = emptyInputs({ dismissed: new Set(many().map(c => c.key)) });
    const padded = selectItems(many(), all);
    expect(padded).toHaveLength(3);
    expect(padded.every(p => p.bucket === "static")).toBe(true);
  });

  it("兜底预备库：真实候选不足 3 条时补齐到 3，真实条目排在前面", () => {
    const two: Candidate[] = [
      { bucket: "mail", key: "m1", text: "邮件一", tone: "mail", score: 40, prefix: "管邮件" },
      { bucket: "followup", key: "f1", text: "跟新一", tone: "urgent", score: 37, prefix: "跟进客户" },
    ];
    const out = selectItems(two, emptyInputs());
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).map(p => p.key)).toEqual(["m1", "f1"]);
    expect(out[2]!.bucket).toBe("static");
    expect(out[2]!.prompt).toContain("检索目标：");   // 预备库条目也带方法论前缀
  });

  it("ctx 锚点命中 → 该联系人的候选置顶（+50）", () => {
    const inp = emptyInputs({ ctxContactId: 5 });
    const cands: Candidate[] = [
      { bucket: "mail", key: "m1", text: "别人的邮件", tone: "mail", score: 40, prefix: "管邮件" },
      { bucket: "mail", key: "m2", text: "锚点客户的邮件", tone: "mail", score: 10, prefix: "管邮件", contactId: 5 },
    ];
    expect(selectItems(cands, inp)[0]!.key).toBe("m2");
  });

  it("换一批：rotate 取下一组；池子轮空停在上一批再由预备库补齐", () => {
    const first = selectItems(many(), emptyInputs(), 0);
    const second = selectItems(many(), emptyInputs(), 1);
    expect(first.map(p => p.key)).toEqual(["m1", "m2", "f1", "i1"]);
    expect(second.slice(0, 2).map(p => p.key)).toEqual(["m3", "i2"]);   // 真实候选只剩 2 条
    expect(second).toHaveLength(3);                                     // 第 3 条来自预备库
    expect(second[2]!.bucket).toBe("static");
    const third = selectItems(many(), emptyInputs(), 2);
    expect(third.slice(0, 2).map(p => p.key)).toEqual(["m3", "i2"]);   // 轮空 → 停在上一批
  });

  it("chip 的 prompt = 方法论前缀 + 检索目标（点击即发送的载荷）", () => {
    const picked = selectItems(many(), emptyInputs());
    expect(picked[0]!.prompt).toContain("检索目标：邮件一");
    expect(picked[0]!.prompt.startsWith("检索本地收件箱")).toBe(true);   // 管邮件前缀
  });
});

describe("问候语与工具函数", () => {
  it("只报有值的项；全空说干净；时段按北京时间", () => {
    const full = buildGreeting(emptyInputs({
      reminders: { due: [], overdue: [reminder(1, "a", 3), reminder(2, "b", 9)] },
      mail: { unread: 5, latest: null, unreplied: null, bounce3d: 0 },
      diff: { syncedAt: new Date(NOW - 3600_000).toISOString(), addedPods: [], priceDrops: [], expiringSoon: [], spacesClosing: [] },
    }));
    expect(full).toBe("中午好。今天2 位客户逾期没跟进、5 封未读、运价镜像刚更新。");
    expect(buildGreeting(emptyInputs())).toContain("今天收件箱很干净");
    // 北京 20 点（UTC 12 点）→ 晚上好
    expect(buildGreeting(emptyInputs({ now: Date.parse("2026-09-07T12:00:00Z") }))).toMatch(/^晚上好/);
  });

  it("podToken 取英文主段；纯中文返回 null（不猜）", () => {
    expect(podToken("SANTOS 桑托斯(巴西)")).toBe("SANTOS");
    expect(podToken("BALBOA, PA 巴尔博亚(巴拿马)")).toBe("BALBOA");
    expect(podToken("桑托斯")).toBeNull();
  });

  it("ctxContactId 只认 contact:N 锚点", () => {
    expect(ctxContactId("contact:12")).toBe(12);
    expect(ctxContactId("company:3")).toBeUndefined();
    expect(ctxContactId(undefined)).toBeUndefined();
  });
});

describe("镜像 diff（可同步资讯的原料）", () => {
  const rate = (podRaw: string, carrier: string, container: string, oceanUsd: number | null, validTo: string | null) =>
    ({ podRaw, carrier, container, oceanUsd, validTo });
  const now = new Date("2026-09-07T04:00:00Z");

  it("parseFlexDate：9.21 / ISO / 垃圾值", () => {
    expect(parseFlexDate("9.21", now)).toBe("2026-09-21");
    expect(parseFlexDate("2026-10-01", now)).toBe("2026-10-01");
    expect(parseFlexDate("待定", now)).toBeNull();
    expect(parseFlexDate(null, now)).toBeNull();
  });

  it("降价按 pod+船司+柜型 元组对比（record_id 变了也认得出），元组取最低价", () => {
    const d = computeRatesDiff(
      [rate("SANTOS", "MSC", "40HQ", 3200, null), rate("SANTOS", "MSC", "40HQ", 3000, null)],
      [rate("SANTOS", "MSC", "40HQ", 2800, null)],
      [], now,
    );
    expect(d.priceDrops).toEqual([{ podRaw: "SANTOS", carrier: "MSC", container: "40HQ", oldUsd: 3000, newUsd: 2800 }]);
  });

  it("涨价与持平不进 diff；新目的港进 addedPods", () => {
    const d = computeRatesDiff(
      [rate("SANTOS", "MSC", "40HQ", 2800, null)],
      [rate("SANTOS", "MSC", "40HQ", 3000, null), rate("KINGSTON", "CMA", "20GP", 1900, null)],
      [], now,
    );
    expect(d.priceDrops).toHaveLength(0);
    expect(d.addedPods).toEqual([{ podRaw: "KINGSTON", n: 1 }]);
  });

  it("即将过期只收 7 天内且未过期的；临截关只收 3 天内、解析不出的跳过", () => {
    const d = computeRatesDiff([], [
      rate("VERACRUZ", "MSC", "40HQ", 3100, "2026-09-11"),   // 4 天后 → 收
      rate("SANTOS", "MSC", "40HQ", 3200, "2026-09-30"),     // 23 天后 → 不收
      rate("MANZANILLO", "HMM", "20GP", 1900, "2026-09-01"), // 已过期 → 不收
    ], [
      { podRaw: "SANTOS", vessel: "V1", etd: "9.8", cutoffRaw: null, boxQty: "2个40HQ" },   // 1 天 → 收
      { podRaw: "SANTOS", vessel: "V2", etd: "待定", cutoffRaw: null, boxQty: null },        // 解析不出 → 跳过
    ], now);
    expect(d.expiringSoon).toEqual([{ podRaw: "VERACRUZ", n: 1, minDays: 4 }]);
    expect(d.spacesClosing).toHaveLength(1);
    expect(d.spacesClosing[0]!.vessel).toBe("V1");
  });
});

// ── SQL 集成层（sql.js 沙箱：未回询盘口径 / 往来匹配 / dismiss 记忆）──

const DDL = `
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
  intent text, "to" text, cc text, my_role text, matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL, received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

function newSandbox(): Driz {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  db.insert(schema.contacts).values([
    { email: "juan@acme.com", firstName: "Juan", lastName: "Garcia" },
  ]).run();
  return db;
}

beforeEach(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  newSandbox();
  mocks.reminders.value = null;
  mocks.send.value = null;
  mocks.diff.value = null;
  // dismiss 记忆按天落盘：每个用例清掉临时文件，互不污染
  try { fs.rmSync(path.join(TMP, "data", "suggestion-dismissed.json"), { force: true }); } catch { /* */ }
});

describe("feed 集成（真 SQL 口径）", () => {
  const insertMail = (over: Partial<typeof schema.inboxMessages.$inferInsert> = {}) => {
    h.db.insert(schema.inboxMessages).values({
      accountId: 1, fromEmail: "gcra@x.com", fromName: "GCRA Fortune Freight",
      subject: "Re: Logistics Solution", classification: "replied",
      matchedContactId: 1, isRead: 1, receivedAt: "2026-09-07T02:00:00Z",
      ...over,
    }).run();
  };

  it("未回询盘：客户来信后没有我方 outbound → 出候选；补了 outbound 就消失", () => {
    insertMail();
    let f = feed();
    expect(f.items.some(i => i.key === "mail-unreplied-1")).toBe(true);
    expect(f.items.find(i => i.key === "mail-unreplied-1")!.text)
      .toBe("GCRA Fortune Freight 的「Re: Logistics Solution」还没回，起草回复");

    // 我方随后发出邮件（interactions type=sent，UTC 格式 created_at）→ 不再算未回
    h.db.insert(schema.interactions).values({
      contactId: 1, type: "sent", direction: "outbound", channel: "email",
      createdAt: "2026-09-07 03:00:00",
    }).run();
    f = feed();
    expect(f.items.some(i => i.key === "mail-unreplied-1")).toBe(false);
  });

  it("退信窗口：3 天内的 bounce 计数进候选，更早的不算", () => {
    insertMail({ id: 10, classification: "bounce", fromEmail: "mailer@x.com", matchedContactId: null, receivedAt: new Date(Date.now() - 86400_000).toISOString() });
    insertMail({ id: 11, classification: "bounce", fromEmail: "mailer@x.com", matchedContactId: null, receivedAt: new Date(Date.now() - 10 * 86400_000).toISOString() });
    const f = feed();
    const b = f.items.find(i => i.key === "mail-bounce");
    expect(b?.text).toBe("近 3 天 1 封退信要处理");
  });

  it("往来匹配：30 天内主题提到该港的联系人 → 降价 chip 带客户名与跳转", () => {
    mocks.diff.value = {
      syncedAt: new Date().toISOString(),
      addedPods: [], expiringSoon: [], spacesClosing: [],
      priceDrops: [{ podRaw: "SANTOS 桑托斯(巴西)", carrier: "MSC", container: "40HQ", oldUsd: 3200, newUsd: 2800 }],
    };
    h.db.insert(schema.interactions).values({
      contactId: 1, type: "note", direction: "internal", channel: "manual",
      subject: "RFQ SANTOS 40HQ", createdAt: new Date(Date.now() - 5 * 86400_000).toISOString().replace("T", " ").slice(0, 19),
    }).run();
    const f = feed();
    const drop = f.items.find(i => i.key.startsWith("intel-drop"))!;
    expect(drop.text).toContain("可以给 Juan Garcia 同步");
    expect(drop.href).toBe("#/customers?view=table&detail=1");
  });

  it("dismiss：点过的 chip 当天不再出，隔天自动失效", () => {
    insertMail();
    dismiss("mail-unreplied-1");
    expect(feed().items.some(i => i.key === "mail-unreplied-1")).toBe(false);
    // 落盘文件带当天日期（北京时间日切）
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, "data", "suggestion-dismissed.json"), "utf-8")) as { day: string; keys: string[] };
    expect(raw.day).toBe(beijingDay());
    expect(raw.keys).toContain("mail-unreplied-1");
  });

  it("全空库：静态能力介绍兜底 + 干净问候（新装机器不空屏）", () => {
    const f = feed();
    expect(f.greeting).toContain("很干净");
    expect(f.items.length).toBeGreaterThan(0);
    expect(f.items.every(i => i.bucket === "static")).toBe(true);
  });

  it("buildFeed 纯函数总装 = 问候 + 选取（供推送路径复用）", () => {
    const f = buildFeed(emptyInputs({
      reminders: { due: [], overdue: [reminder(1, "Juan", 9)] },
      mail: { unread: 0, latest: null, unreplied: null, bounce3d: 0 },
    }));
    expect(f.greeting).toContain("1 位客户逾期没跟进");
    expect(f.items[0]!.key).toBe("fu-stale-1");
  });
});
