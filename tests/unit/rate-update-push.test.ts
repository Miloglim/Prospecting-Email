import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { rateQuotes } from "../../src/main/db/schema/rates";
import { contacts } from "../../src/main/db/schema/contacts";
import { inboxMessages } from "../../src/main/db/schema/inbox";

// ═══════════════════════════════════════════════════════════════════
// 定向运价更新推送（规范 docs/rate-update-push-spec.md）方案层端到端。
// 每条都对着 2026-09-08 用户实测会话里翻过的车：找不到客户（范围分不清看板/联系人库）、
// 没登记偏好就一整批推不出去、来信里的整句被当目的港建假组并挤掉名额、
// 航线级价当本港价发出去、模型凭印象编船期/附加费细节，
// 以及 startQueue 会清空既有待发队列这件事必须先让人知道。
// ═══════════════════════════════════════════════════════════════════

process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";

const TMP = path.join(os.tmpdir(), "prospector-rate-update-test");
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

// 发送引擎打桩：只关心「组装了哪几个人、有没有以 autoStart=false 入队」，真发信归 send.service 自己的测试
const buildCalls: Array<{ ids: number[]; subject: string; body: string }> = [];
const startCalls: Array<{ count: number; autoStart: boolean; tplNames: string[] }> = [];
const queueState = { pendingGroups: 0, running: false };

vi.mock("../../src/main/services/send.service", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    buildDynamicQueue: (contactIds: number[], subject: string, body: string) => {
      buildCalls.push({ ids: contactIds, subject, body });
      return {
        success: true,
        data: contactIds.map(cid => ({
          id: `it-${cid}`, companyName: `CO${cid}`, companyId: cid,
          recipients: [{ contactId: cid, email: `${cid}@x.com`, name: `C${cid}` }],
          accountId: 1, subject, tplBody: body, contactVars: {}, status: "pending" as const,
        })),
      };
    },
    startQueue: async (items: Array<{ tplName?: string }>, autoStart = true) => {
      startCalls.push({ count: items.length, autoStart, tplNames: items.map(i => i.tplName ?? "") });
      return { success: true, data: { batchId: "batch-1", queued: items.length, queuedCount: items.length, dropped: 0 } };
    },
    getQueueItems: () => ({
      success: true,
      data: Array.from({ length: queueState.pendingGroups }, (_, i) => ({ id: `q${i}`, status: "pending" as const })),
    }),
    getSendStatus: () => ({ success: true, data: { isRunning: queueState.running } }),
  };
});

const {
  buildRateUpdatePlan, planView, enqueueRateUpdatePlan, pendingPlanRateUpdate, clearPendingPlans, portForCountry,
} = await import("../../src/main/services/rate-update.service");
const { buildHarnessTools } = await import("../../src/main/services/agent/tools");
const { customerQuoteHtml, cleanQuoteRow, pivotQuotes, customerQuoteMarkdown } =
  await import("../../src/main/services/rates-clean");

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function freshDb(): void {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  for (const s of [
    `ALTER TABLE inbox_messages ADD COLUMN intent text;`,
    `ALTER TABLE contacts ADD COLUMN language text;`,
  ]) { try { raw.run(s); } catch { /* 列已存在 */ } }
  const db = drizzle(raw, { schema });
  h.db = db;

  const future = "2099-12-31";
  const past = "2026-01-31";
  db.insert(rateQuotes).values([
    // 本港级行（当期有效）
    { recordId: "r-santos", pol: "宁波", podRaw: "SANTOS", lane: "南美东",
      carrier: "MSC", container: "40HQ", oceanUsd: 3200, validFrom: "2026-09-01", validTo: future,
      note: "含 EBS", sourceGroup: "宁波舱位滚动更新群", sender: "张三 13800000000", syncedAt: daysAgo(1) },
    { recordId: "r-cartagena", pol: "厦门", podRaw: "CARTAGENA", lane: "加勒比",
      carrier: "CMA", container: "20GP", oceanUsd: 1800, validFrom: "2026-09-01", validTo: future,
      note: "成本价 1500 可申请", sourceGroup: "内部群", sender: "李四", syncedAt: daysAgo(1) },
    // 国家兜底用：pod_raw 带中文国名（真实台账写法「RIO DE JANEIRO 里约热内卢(巴西)」）
    { recordId: "r-rio", pol: "宁波", podRaw: "RIO DE JANEIRO 里约热内卢(巴西)", lane: "南美东",
      carrier: "EMC", container: "40HQ", oceanUsd: 3450, validFrom: "2026-09-01", validTo: future, syncedAt: daysAgo(1) },
    // 航线级行（区域基本港价）：VERACRUZ 只剩过期行，当期价只能来自这条航线级行 → 组必须被标成航线级
    { recordId: "r-mex-lane", pol: "厦门", podRaw: "墨西哥", lane: "墨西哥",
      carrier: "HMM", container: "40HQ", oceanUsd: 2600, validFrom: "2026-09-01", validTo: future, syncedAt: daysAgo(1) },
    { recordId: "r-veracruz-old", pol: "厦门", podRaw: "VERACRUZ", lane: "加勒比",
      carrier: "CMA", container: "20GP", oceanUsd: 1900, validFrom: "2026-01-01", validTo: past, syncedAt: daysAgo(200) },
    // 只有过期行的港 → 当期无价
    { recordId: "r-buena-old", pol: "宁波", podRaw: "BUENAVENTURA", lane: "南美西",
      carrier: "MSC", container: "40HQ", oceanUsd: 2000, validFrom: "2026-01-01", validTo: past, syncedAt: daysAgo(200) },
  ] as never).run();

  const ppl: Array<{ id: number; email: string; first: string; last: string; status: string; tags: string; extra: string; language?: string; country?: string }> = [
    { id: 1, email: "juan@acme.com", first: "Juan", last: "G", status: "reached", tags: '["quoting"]', extra: "{}" },
    { id: 2, email: "ana@acme.es", first: "Ana", last: "R", status: "reached", tags: '["reaching"]', extra: "{}", language: "ES" },
    { id: 3, email: "pedro@acme.co", first: "Pedro", last: "M", status: "reached", tags: '["quoting"]', extra: "{}" },
    { id: 4, email: "liu@acme.cn", first: "Liu", last: "W", status: "reached", tags: '["reaching"]', extra: "{}" },
    { id: 5, email: "sato@acme.jp", first: "Sato", last: "K", status: "reached", tags: '["trial"]',
      extra: JSON.stringify({ preferredPorts: JSON.stringify([{ pol: "Ningbo", pod: "BUENAVENTURA" }]) }) },
    { id: 6, email: "bob@dead.com", first: "Bob", last: "B", status: "bounced", tags: '["reaching"]', extra: "{}" },
    { id: 7, email: "cleo@acme.us", first: "Cleo", last: "D", status: "replied", tags: '["cooperating"]', extra: "{}" },
    { id: 8, email: "henry@acme.pa", first: "Henry", last: "P", status: "reached", tags: '["reaching"]', extra: "{}" },
    // 冷客户 + 有国家：只有 scope=contacts 才圈得到（用户口径「选出所有巴西客户」）
    { id: 9, email: "nina@acme.br", first: "Nina", last: "S", status: "", tags: "[]", extra: "{}", country: "巴西" },
  ];
  for (const p of ppl) {
    db.insert(contacts).values({
      id: p.id, email: p.email, firstName: p.first, lastName: p.last,
      status: p.status, tags: p.tags, extra: p.extra, language: p.language ?? null, country: p.country ?? null,
    } as never).run();
  }

  const mails: Array<{ id: number; contact: number; days: number; text: string }> = [
    { id: 11, contact: 1, days: 5, text: "Request ocean freight.\nPOD: Santos - BRSSZ\nContainer: 2 x 40HQ, ready in October." },
    { id: 12, contact: 2, days: 8, text: "POD: SANTOS (Brazil)\nPol: Ningbo, China\nContainer: 1 x 40HQ." },
    { id: 13, contact: 3, days: 3, text: "Destination: Cartagena, Colombia. Container: 3 x 20GP." },
    { id: 14, contact: 7, days: 12, text: "POD: Santos, Brazil\nQuote for 40HQ please." },
    { id: 15, contact: 1, days: 60, text: "POD: Manzanillo, Mexico. Container: 1 x 40HQ." },
    { id: 16, contact: 8, days: 6, text: "POD: Veracruz, Mexico\nContainer: 1 x 40HQ." },
    // 脏值夹具：这封信没有 POD 标签行，正文里那句「QUICK UPDATE ON SPACE AVAILABLE」曾被当成目的港建组
    { id: 17, contact: 4, days: 4, text: "QUICK UPDATE ON SPACE AVAILABLE.\nSantos 2 x 40HQ ready next week." },
  ];
  for (const m of mails) {
    db.insert(inboxMessages).values({
      id: m.id, accountId: 1, fromEmail: `c${m.contact}@x.com`, fromName: "C",
      subject: "RFQ", bodyPreview: m.text, classification: "other",
      receivedAt: daysAgo(m.days), matchedContactId: m.contact,
    } as never).run();
  }
}

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

const plan = (opts = {}) => {
  const r = buildRateUpdatePlan(opts);
  if (!r.success) throw new Error(`方案没建成：${r.error}`);
  return r.data;
};
const view = (opts = {}) => planView(plan(opts)) as ReturnType<typeof planView>;
const groupOf = (v: ReturnType<typeof view>, pod: string, lang: string) =>
  v.groups.find(g => g.pod === pod && g.language === lang);

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "data", "rates-diff.json"), JSON.stringify({
    syncedAt: new Date().toISOString(),
    addedPods: [], expiringSoon: [], spacesClosing: [],
    priceDrops: [{ podRaw: "SANTOS", carrier: "MSC", container: "40HQ", oldUsd: 3600, newUsd: 3200 }],
  }), "utf-8");
});

beforeEach(() => {
  freshDb();
  buildCalls.length = 0;
  startCalls.length = 0;
  queueState.pendingGroups = 0;
  queueState.running = false;
  clearPendingPlans();
});

describe("范围两分：跟进看板 vs 联系人库（此前混为一谈导致「找不到客户」）", () => {
  it("默认只圈看板：已触达 ∪ 已回复；退信与冷客户都不进", () => {
    const v = view();
    expect(v.scope.scope).toBe("board");
    expect(v.totals.customers).toBe(7);                          // 9 位里剔掉 bounced 与冷客户 Nina
    expect(groupOf(v, "SANTOS", "EN")?.customers).toBe(2);       // Juan + Cleo（已回复一起推）
  });

  it("scope=contacts 才圈冷客户，并按所在国家的当期代表港兜底", () => {
    const v = view({ scope: "contacts" });
    expect(v.totals.customers).toBe(8);
    const rio = groupOf(v, "RIO DE JANEIRO", "EN");
    expect(rio).toMatchObject({ customers: 1, basis: "country", quotes: 1, minUsd: 3450 });
    expect(rio?.label).toBe("RIO DE JANEIRO (Brazil)");
    expect(rio?.subject).toContain("RIO DE JANEIRO (Brazil)");
  });

  it("country 收窄：说「巴西客户」就只圈巴西的，不用绕去 search_contacts", () => {
    const v = view({ scope: "contacts", country: "巴西" });
    expect(v.totals.customers).toBe(1);
    expect(v.groups.map(g => g.pod)).toEqual(["RIO DE JANEIRO"]);
    expect(v.groups[0]?.basis).toBe("country");
    const body = pendingPlanRateUpdate(v.planId)?.groups[0]?.bodyHtml ?? "";
    expect(body).toContain("Brazil");                            // 信里说明是所在方向的当期报价
    expect(body).not.toMatch(/[一-鿿]/);                          // 中文国名绝不进客户邮件
  });

  it("看板里没有该国客户 → 空方案带原因与建议范围（不再是失败，也不许被说成权限问题）", () => {
    const r = buildRateUpdatePlan({ country: "巴西" });         // Nina 是冷客户，不在看板
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.groups.length).toBe(0);
    expect(r.data.emptyReason).toContain("冷客户");
    expect(r.data.suggestScope).toBe("contacts");
  });

  it("statuses 显式圈状态：只要「已触达」就不含已回复的那位", () => {
    const v = view({ statuses: ["reached"] });
    expect(groupOf(v, "SANTOS", "EN")?.customers).toBe(1);       // 只剩 Juan（Cleo 是 replied）
  });

  it("stages 传歪了不整单失败：退回默认口径并如实记实际生效阶段", () => {
    const r = buildRateUpdatePlan({ stages: ['["reaching"', "quotin", "拼错的值"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.groups.length).toBeGreaterThan(0);
    expect(r.data.scope.stages).toEqual(["reaching", "quoting", "trial", "cooperating", "other"]);
  });
});

describe("参数误用的纠偏（模型会把国家名塞进 port）", () => {
  const call = async (args: unknown, conversationId = "ru-fix") => {
    const ctx = { conversationId, counts: new Map<string, number>(), failures: new Map<string, number>() };
    const T = Object.fromEntries(
      ((buildHarnessTools(ctx) ?? []) as unknown as Array<{ name?: string }>).map(t => [t.name ?? "", t]),
    ) as Record<string, { invoke: (r: unknown, i: string) => Promise<string> }>;
    return JSON.parse(await T["rate_update_plan"].invoke({}, JSON.stringify(args))) as Record<string, never>;
  };

  it("port=巴西 → 自动按国家处理并说明纠正了什么", async () => {
    const out = await call({ scope: "contacts", port: "巴西" }, "ru-fix-a") as {
      ok: boolean; corrected?: string; groups?: Array<{ pod: string; basis: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.corrected).toContain("按国家处理");
    expect(out.groups?.map(g => g.pod)).toEqual(["RIO DE JANEIRO"]);
    expect(out.groups?.[0]?.basis).toBe("country");
  });

  it("空方案回 empty:true + 建议范围动作，且 notice 禁提权限", async () => {
    const out = await call({ port: "巴西" }, "ru-fix-b") as {
      ok: boolean; empty?: boolean; emptyReason?: string; suggestScope?: string;
      notice?: string; actions?: Array<{ text?: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.empty).toBe(true);
    expect(out.suggestScope).toBe("contacts");
    expect(out.notice).toContain("权限");
    expect((out.actions ?? []).map(a => a.text ?? "").join(" ")).toContain('scope="contacts"');
  });
});

describe("港口偏好：脏值不成组，没偏好才走国家兜底", () => {
  it("来信里的整句/邮件标题不再被当成目的港（假港会挤掉真客户名额）", () => {
    const v = view();
    expect(v.groups.some(g => /QUICK|AVAILABLE|UPDATE/i.test(g.pod))).toBe(false);
    // Liu 的信没有 POD 标签行（散文式提港）→ 认不出港 → 如实 no_port
    expect(v.uncovered.find(u => u.contactId === 4)?.reason).toBe("no_port");
  });

  it("台账里真有的港才认；同一客户两个港只进一组", () => {
    const v = view();
    expect(groupOf(v, "SANTOS", "EN")?.customers).toBe(2);
    expect(v.groups.some(g => g.pod === "MANZANILLO")).toBe(false);   // 台账里没这个港的行 → 不建组
  });

  it("人工登记的港当期无有效价 → 进未覆盖，绝不拿别的港价凑", () => {
    const v = view();
    const sato = v.uncovered.find(x => x.contactId === 5);
    expect(sato?.reason).toBe("no_live_rate");
    expect(sato?.detail).toContain("BUENAVENTURA");
    expect(v.groups.some(g => g.pod === "BUENAVENTURA")).toBe(false);
  });

  it("同港不同语言分两组；西语组正文是西语、全表零汉字、占位符留给发送时逐人渲染", () => {
    const v = view();
    expect(groupOf(v, "SANTOS", "ES")?.customers).toBe(1);
    const es = pendingPlanRateUpdate(v.planId)?.groups.find(g => g.key === "SANTOS|ES");
    expect(es?.bodyHtml).toContain("Estimado/a");
    expect(es?.bodyHtml ?? "").not.toMatch(/[一-鿿]/);
    expect(es?.bodyHtml).toContain("{{firstName}}");
  });

  it("国家代表港：从当期有效行抽英文港名，认不出的国家返回 null", () => {
    expect(portForCountry("巴西")).toMatchObject({ pod: "RIO DE JANEIRO" });
    expect(portForCountry("不存在国")).toBeNull();
  });
});

describe("航线级（区域基本港）价必须如实标注", () => {
  it("VERACRUZ 当期只有航线级行 → 组标 laneLevel，正文写清是基本港适用价", () => {
    const v = view();
    expect(groupOf(v, "VERACRUZ", "EN")).toMatchObject({ laneLevel: true, quotes: 1, minUsd: 2600 });
    const p = pendingPlanRateUpdate(v.planId);
    const g = p?.groups.find(x => x.key === "VERACRUZ|EN");
    expect(g?.bodyHtml).toContain("basic port");
    expect(g?.bodyHtml ?? "").not.toMatch(/[一-鿿]/);              // 中文航线名「加勒比」不外流
    expect(groupOf(v, "SANTOS", "EN")?.laneLevel).toBe(false);     // 本港级行不打这个标注
    // 一人一组：Juan 同时提到 Santos 与 Veracruz，只能出现在一个组里
    const ids = (p?.groups ?? []).flatMap(x => x.customers.map(c => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("工具返回 laneLevelGroups 与 facts 白名单（禁编细节）", async () => {
    const ctx = { conversationId: "ru-lane", counts: new Map<string, number>(), failures: new Map<string, number>() };
    const T = Object.fromEntries(
      ((buildHarnessTools(ctx) ?? []) as unknown as Array<{ name?: string }>).map(t => [t.name ?? "", t]),
    ) as Record<string, { invoke: (r: unknown, i: string) => Promise<string> }>;
    const out = JSON.parse(await T["rate_update_plan"].invoke({}, "{}")) as {
      ok: boolean; laneLevelGroups?: string[]; notice?: string; groups?: Array<{ facts?: string[] }>;
    };
    expect(out.ok).toBe(true);
    expect(out.laneLevelGroups).toContain("VERACRUZ");
    expect(out.notice).toContain("航线级");
    expect(out.notice).toContain("facts");
    expect((out.groups?.[0]?.facts ?? []).length).toBeGreaterThan(0);
  });
});

describe("可引用事实与对外表（同批次清洗行）", () => {
  it("facts 与对外表同源；内部备注判丢、溯源列不出现", () => {
    const v = view();
    const santos = groupOf(v, "SANTOS", "EN");
    expect(santos?.facts.length).toBeGreaterThan(0);
    const raw = {
      carrier: "MSC", pol: "宁波", podRaw: "SANTOS", lane: "南美东", container: "40HQ", containerRaw: null,
      oceanUsd: 3200, freeDays: "7", etd: "2026-09-15", validityRaw: "9.1-9.30",
      validFrom: "2026-09-01", validTo: "2099-12-31", note: "成本价 1500", sourceGroup: "群", sender: "张三",
      msgTime: null, syncedAt: null, status: null, messageText: null,
    };
    const rows = pivotQuotes([cleanQuoteRow(raw)]);
    const html = customerQuoteHtml(rows, 12);
    const md = customerQuoteMarkdown(rows, 12);
    const mdRows = md.split("\n").filter(l => l.startsWith("|") && !l.startsWith("| CARRIER") && !l.startsWith("|---"));
    expect((html.match(/<tr>/g) ?? []).length).toBe(mdRows.length + 1);   // +1 = 表头行
    expect(mdRows[0]?.trim().endsWith("| / |")).toBe(true);               // 内部备注 → REMARK "/"
    const cartagena = pendingPlanRateUpdate(v.planId)?.groups.find(g => g.pod === "CARTAGENA");
    expect(cartagena?.bodyHtml).not.toContain("内部群");
    for (const col of ["CARRIER", "POL", "POD", "20GP", "40HQ/HC", "40NOR", "FT", "ETD", "VALIDITY", "TT", "REMARK"]) {
      expect(cartagena?.bodyHtml ?? "").toContain(col);
    }
    expect((cartagena?.bodyHtml.match(/<li>/g) ?? []).length).toBe(3);
    expect(cartagena?.bodyHtml).toContain("Best regards");
  });

  it("降价标签只来自镜像 diff：命中才带，命不中不提降价", () => {
    const p = plan();
    const s = p.groups.find(g => g.pod === "SANTOS" && g.language === "EN");
    expect(s?.drop).toMatchObject({ oldUsd: 3600, newUsd: 3200, pct: 11 });
    expect(s?.subject).toMatch(/^Price drop ·/);
    expect(s?.bodyHtml).toContain("have come down about 11%");
    const c = p.groups.find(g => g.pod === "CARTAGENA");
    expect(c?.drop).toBeNull();
    expect(c?.bodyHtml ?? "").not.toContain("come down");
  });

  it("未覆盖名单按原因如实给数，不静默丢人", () => {
    const v = view();
    expect(v.totals.uncoveredTotal).toBe(2);
    expect(v.uncovered.map(u => u.reason).sort()).toEqual(["no_live_rate", "no_port"]);
  });
});

describe("入队：只入队不发送，且必须先解决队列占用", () => {
  it("方案入队走 buildDynamicQueue → startQueue(autoStart=false)，组标签带展示名；一人一组一封", async () => {
    const v = view();
    const r = await enqueueRateUpdatePlan(v.planId);
    expect(r.success).toBe(true);
    if (!r.success || r.data.occupied) return;
    expect(r.data.enqueue.groups).toBe(v.groups.length);
    expect(r.data.enqueue.queuedCount).toBe(v.totals.covered);
    expect(startCalls.length).toBe(1);
    expect(startCalls[0]?.autoStart).toBe(false);                            // 红线：程序永不自动开始群发
    expect(startCalls[0]?.tplNames.every(n => n.startsWith("运价更新 · "))).toBe(true);
    expect(buildCalls.map(c => c.ids).flat().sort()).toEqual([1, 2, 3, 7, 8]);
  });

  it("队列里还有未发送批次 → 默认拒绝（startQueue 会清空全表，不能静默覆盖）", async () => {
    queueState.pendingGroups = 3;
    const r = await enqueueRateUpdatePlan(view().planId);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ occupied: true, pendingGroups: 3 });
    expect(startCalls.length).toBe(0);
  });

  it("引擎正在发送时绝对不让插队", async () => {
    queueState.running = true;
    const r = await enqueueRateUpdatePlan(view().planId);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("正在运行");
    expect(startCalls.length).toBe(0);
  });

  it("同意覆盖后才入队；方案用过即作废，防同份重复入队", async () => {
    queueState.pendingGroups = 2;
    const planId = plan().id;
    const first = await enqueueRateUpdatePlan(planId, undefined, true);
    expect(first.success && !first.data.occupied).toBe(true);
    expect(startCalls.length).toBe(1);
    const second = await enqueueRateUpdatePlan(planId);
    expect(second.success ? "" : second.error).toContain("过期");
  });

  it("groupKeys 只入队选中的组；未知组当面报错并列出可选键", async () => {
    const planId = plan().id;
    const one = await enqueueRateUpdatePlan(planId, ["CARTAGENA|EN"]);
    expect(one.success && !one.data.occupied).toBe(true);
    if (!one.success || one.data.occupied) return;
    expect(one.data.enqueue.groups).toBe(1);
    const bad = await enqueueRateUpdatePlan(plan().id, ["NOSUCH|EN"]);
    expect(bad.success ? "" : bad.error).toContain("未知分组");
    expect(bad.success ? "" : bad.error).toContain("SANTOS|EN");
  });
});
