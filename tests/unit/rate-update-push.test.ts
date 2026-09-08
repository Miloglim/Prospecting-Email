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
// 定向运价更新推送（规范 docs/rate-update-push-spec.md）方案层端到端：
//   跟进看板客户 + 港口偏好（看板登记 ∪ 来信解析）→ 按「目的港 + 语言」分组
//   → 每组取台账当期真价 → 机械成文（全英文对外表）→ 入队只入队不发送。
// 钉的都是真出过事的地方：一个人收到两封、无价港拿别的港凑数、内部备注流进客户邮件、
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

// 发送引擎打桩：这里只关心「组装了哪几个人、有没有以 autoStart=false 入队」，真发信归 send.service 的测试
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
  buildRateUpdatePlan, planView, enqueueRateUpdatePlan, pendingPlanRateUpdate, clearPendingPlans,
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

  db.insert(rateQuotes).values([
    { recordId: "r-santos", pol: "宁波", podRaw: "SANTOS", lane: "南美东",
      carrier: "MSC", container: "40HQ", oceanUsd: 3200, validFrom: "2026-09-01", validTo: "2099-12-31",
      note: "含 EBS", sourceGroup: "宁波舱位滚动更新群", sender: "张三 13800000000", syncedAt: daysAgo(1) },
    { recordId: "r-cartagena", pol: "厦门", podRaw: "CARTAGENA", lane: "加勒比",
      carrier: "CMA", container: "20GP", oceanUsd: 1800, validFrom: "2026-09-01", validTo: "2099-12-31",
      note: "成本价 1500 可申请", sourceGroup: "内部群", sender: "李四", syncedAt: daysAgo(1) },
    // 只有过期行的港 → 必须判「当期无价」，不能拿它报价
    { recordId: "r-buena-old", pol: "宁波", podRaw: "BUENAVENTURA", lane: "南美西",
      carrier: "MSC", container: "40HQ", oceanUsd: 2000, validFrom: "2026-01-01", validTo: "2026-01-31",
      syncedAt: daysAgo(200) },
  ] as never).run();

  const ppl: Array<{ id: number; email: string; first: string; last: string; status: string; tags: string; extra: string; language?: string }> = [
    { id: 1, email: "juan@acme.com", first: "Juan", last: "G", status: "reached", tags: '["quoting"]', extra: "{}" },
    { id: 2, email: "ana@acme.es", first: "Ana", last: "R", status: "reached", tags: '["reaching"]', extra: "{}", language: "ES" },
    { id: 3, email: "pedro@acme.co", first: "Pedro", last: "M", status: "reached", tags: '["quoting"]', extra: "{}" },
    { id: 4, email: "liu@acme.cn", first: "Liu", last: "W", status: "reached", tags: '["reaching"]', extra: "{}" },
    { id: 5, email: "sato@acme.jp", first: "Sato", last: "K", status: "reached", tags: '["trial"]',
      extra: JSON.stringify({ preferredPorts: JSON.stringify([{ pol: "Ningbo", pod: "BUENAVENTURA" }]) }) },
    { id: 6, email: "bob@dead.com", first: "Bob", last: "B", status: "bounced", tags: '["reaching"]', extra: "{}" },
    { id: 7, email: "cleo@acme.us", first: "Cleo", last: "D", status: "replied", tags: '["cooperating"]', extra: "{}" },
  ];
  for (const p of ppl) {
    db.insert(contacts).values({
      id: p.id, email: p.email, firstName: p.first, lastName: p.last,
      status: p.status, tags: p.tags, extra: p.extra, language: p.language ?? null,
    } as never).run();
  }

  const mails: Array<{ id: number; contact: number; days: number; text: string }> = [
    { id: 11, contact: 1, days: 5, text: "Request ocean freight.\nPOD: Santos - BRSSZ\nContainer: 2 x 40HQ, ready in October." },
    { id: 12, contact: 2, days: 8, text: "POD: SANTOS (Brazil)\nPol: Ningbo, China\nContainer: 1 x 40HQ." },
    { id: 13, contact: 3, days: 3, text: "Destination: Cartagena, Colombia. Container: 3 x 20GP." },
    { id: 14, contact: 7, days: 12, text: "POD: Santos, Brazil\nQuote for 40HQ please." },
    // 同一人两个港：近期 Santos + 更早 Veracruz → 只能进一个组（一人一封）
    { id: 15, contact: 1, days: 60, text: "POD: Veracruz, Mexico. Container: 1 x 40HQ." },
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

const plan = () => {
  const r = buildRateUpdatePlan();
  if (!r.success) throw new Error(`方案没建成：${r.error}`);
  return r.data;
};
const groupOf = (pod: string, lang: string) => planView(plan()).groups.find(g => g.pod === pod && g.language === lang);

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  // 镜像 diff（降价原料）：SANTOS MSC 40HQ 3600 → 3200
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

describe("方案聚合：跟进看板客户 × 港口偏好 → 目的港分组", () => {
  it("来信里的港口把人带进对应组；已回复客户默认一起推；退信客户根本不进范围", () => {
    const p = plan();
    const view = planView(p);
    expect(groupOf("SANTOS", "EN")).toMatchObject({ customers: 2, quotes: 1, minUsd: 3200 });
    expect(groupOf("CARTAGENA", "EN")).toMatchObject({ customers: 1, minUsd: 1800 });
    expect(view.totals.customers).toBe(6);                       // 7 位客户去掉 1 位退信
    expect(view.uncovered.find(u => u.contactId === 4)?.reason).toBe("no_port");
    expect(view.uncovered.some(u => u.contactId === 6)).toBe(false);
  });

  it("同一客户两个港只进一组（分高的港赢），不会收到两封", () => {
    const view = planView(plan());
    expect(groupOf("SANTOS", "EN")?.customers).toBe(2);          // Juan + Cleo
    expect(view.groups.some(g => g.pod === "VERACRUZ")).toBe(false);
  });

  it("同港不同语言分两组；西语组正文是西语、全表零汉字、占位符留给发送时逐人渲染", () => {
    const p = plan();
    expect(groupOf("SANTOS", "ES")?.customers).toBe(1);
    const es = p.groups.find(g => g.key === "SANTOS|ES");
    expect(es?.bodyHtml).toContain("Estimado/a");
    expect(es?.subject).toContain("SANTOS");
    expect(es?.bodyHtml ?? "").not.toMatch(/[一-鿿]/);
    expect(es?.bodyHtml).toContain("{{firstName}}");
  });

  it("看板登记的人工偏好有出处；该港镜像里只有过期价 → 进未覆盖，绝不拿别的港凑数", () => {
    const view = planView(plan());
    const u = view.uncovered.find(x => x.contactId === 5);
    expect(u?.reason).toBe("no_live_rate");
    expect(u?.detail).toContain("BUENAVENTURA");
    expect(view.groups.some(g => g.pod === "BUENAVENTURA")).toBe(false);
    const sato = pendingPlanRateUpdate(view.planId)?.groups.find(g => g.customers.some(c => c.id === 5));
    expect(sato).toBeUndefined();                                 // 未覆盖 = 一封都不发
  });

  it("includeReplied=false 只推还没回的", () => {
    const r = buildRateUpdatePlan({ includeReplied: false });
    expect(r.success && planView(r.data).groups.find(g => g.key === "SANTOS|EN")?.customers).toBe(1);
  });

  it("port 参数只看一个港（英文与 LOCODE 都归一到镜像标准港名）", () => {
    // 中文译名（桑托斯）目前不在港口词表里，与 quote_search 同口径 —— 规范 §9 记为待办
    for (const word of ["santos", "BRSSZ"]) {
      const r = buildRateUpdatePlan({ port: word });
      expect(r.success).toBe(true);
      if (!r.success) continue;
      const view = planView(r.data);
      expect(view.groups.length).toBeGreaterThan(0);
      expect(view.groups.every(g => g.pod === "SANTOS")).toBe(true);
      expect(view.totals.covered).toBe(3);                      // Juan + Cleo（EN）、Ana（ES 单独一封西语信）
    }
  });

  it("降价标签只来自镜像 diff：命中才带，命不中不提降价", () => {
    const p = plan();
    const santos = p.groups.find(g => g.pod === "SANTOS" && g.language === "EN");
    expect(santos?.drop).toMatchObject({ oldUsd: 3600, newUsd: 3200, pct: 11 });
    expect(santos?.subject).toMatch(/^Price drop ·/);
    expect(santos?.bodyHtml).toContain("have come down about 11%");
    const c = p.groups.find(g => g.pod === "CARTAGENA");
    expect(c?.drop).toBeNull();
    expect(c?.subject).toMatch(/^Freight rates update/);
    expect(c?.bodyHtml ?? "").not.toContain("come down");
  });

  it("阶段收窄只推该列客户；已流失一律不参与", () => {
    const rq = buildRateUpdatePlan({ stages: ["quoting"] });
    expect(rq.success).toBe(true);
    if (!rq.success) return;
    const v1 = planView(rq.data);
    expect(v1.totals.customers).toBe(2);                          // quoting 列只有 Juan / Pedro
    expect(v1.groups.map(g => g.pod).sort()).toEqual(["CARTAGENA", "SANTOS"]);

    const rl = buildRateUpdatePlan({ stages: ["lost", "quoting"] });
    expect(rl.success).toBe(true);
    if (!rl.success) return;
    const v2 = planView(rl.data);
    expect(v2.totals.customers).toBe(2);                          // lost 被剔掉，结果同上
    expect(v2.uncovered.some(u => u.contactId === 4)).toBe(false); // Liu 属 reaching，压根不在范围内
  });
});

describe("邮件正文与对外表（与界面客户表同一出口）", () => {
  it("邮件表列 = 英文十一列；内部备注判丢、内部溯源列根本不出现", () => {
    const p = plan();
    const html = p.groups.find(g => g.pod === "CARTAGENA")?.bodyHtml ?? "";
    for (const col of ["CARRIER", "POL", "POD", "20GP", "40HQ/HC", "40NOR", "FT", "ETD", "VALIDITY", "TT", "REMARK"]) {
      expect(html).toContain(col);
    }
    expect(html).not.toMatch(/[一-鿿]/);                       // 「成本价 1500 可申请」是内部话术
    expect(html).not.toContain("内部群");
    expect(html).not.toContain("宁波舱位滚动更新群");
  });

  it("customerQuoteHtml 与 markdown 表同源同行数、REMARK 位为 /", () => {
    const rows = pivotQuotes([cleanQuoteRow({
      carrier: "MSC", pol: "宁波", podRaw: "SANTOS", lane: "南美东", container: "40HQ", containerRaw: null,
      oceanUsd: 3200, freeDays: "7", etd: "2026-09-15", validityRaw: "9.1-9.30",
      validFrom: "2026-09-01", validTo: "2099-12-31", note: "成本价 1500", sourceGroup: "群", sender: "张三",
      msgTime: null, syncedAt: null, status: null, messageText: null,
    })]);
    const html = customerQuoteHtml(rows, 12);
    const md = customerQuoteMarkdown(rows, 12);
    const mdRows = md.split("\n").filter(l => l.startsWith("|") && !l.startsWith("| CARRIER") && !l.startsWith("|---"));
    expect((html.match(/<tr>/g) ?? []).length).toBe(mdRows.length + 1);   // +1 = 表头行
    expect(mdRows[0]?.trim().endsWith("| / |")).toBe(true);               // 内部备注 → REMARK "/"
    expect(html).toContain("<table");
    expect(html).toContain("SANTOS");
  });

  it("正文固定三句注意事项 + 一句 CTA；签名不写进正文（发送时按账号追加）", () => {
    const p = plan();
    const html = p.groups.find(g => g.pod === "CARTAGENA")?.bodyHtml ?? "";
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
    expect(html).toContain("Best regards");
    expect(html).not.toMatch(/宁波|李四/);
  });
});

describe("agent 工具面（模型看到的契约）", () => {
  type ToolLike = { name?: string; invoke: (rc: unknown, input: string) => Promise<string> };
  const toolsFor = (ctx: unknown) =>
    Object.fromEntries(((buildHarnessTools(ctx) ?? []) as unknown as ToolLike[]).map(t => [t.name ?? "", t]));

  it("rate_update_plan 出方案：groups + planId + 下一步指令；enqueue 回执报数并指向发送中心", async () => {
    const ctx = { conversationId: "ru-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
    const T = toolsFor(ctx);
    const planOut = JSON.parse(await T["rate_update_plan"].invoke({}, "{}")) as {
      ok: boolean; planId?: string; groups?: unknown[]; totals?: Record<string, number>;
      notice?: string; nextStep?: string; queueOccupied?: number;
    };
    expect(planOut.ok).toBe(true);
    expect(planOut.planId).toBeTruthy();
    expect(planOut.groups?.length).toBe(3);
    expect(planOut.totals?.covered).toBe(4);
    expect(planOut.notice).toContain("不要再手抄");
    expect(planOut.notice).toContain("发送中心");
    expect(planOut.nextStep).toContain("rate_update_enqueue");
    expect(planOut.queueOccupied).toBe(0);

    const enq = JSON.parse(await T["rate_update_enqueue"].invoke({}, JSON.stringify({ planId: planOut.planId }))) as {
      ok: boolean; say?: string; notice?: string; actions?: Array<{ label: string; href?: string }>;
    };
    expect(enq.ok).toBe(true);
    expect(enq.say).toContain("3 组");
    expect(enq.say).toContain("4 封");
    expect((enq.actions ?? []).map(a => a.href)).toContain("#/queue");
    expect(enq.notice).toContain("不会自动发");
  });

  it("方案用过再调一次 → 工具层如实报过期，不静默重发", async () => {
    const ctx = { conversationId: "ru-conv2", counts: new Map<string, number>(), failures: new Map<string, number>() };
    const T = toolsFor(ctx);
    const planId = (JSON.parse(await T["rate_update_plan"].invoke({}, "{}")) as { planId: string }).planId;
    expect((JSON.parse(await T["rate_update_enqueue"].invoke({}, JSON.stringify({ planId }))) as { ok: boolean }).ok).toBe(true);
    ctx.counts.clear();   // 单轮预算 1 次；这里要测的是「方案一次性」，不是预算闸门
    const again = JSON.parse(await T["rate_update_enqueue"].invoke({}, JSON.stringify({ planId }))) as {
      ok: boolean; error?: { code?: string; message?: string };
    };
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("plan_expired");
    expect(again.error?.message).toContain("rate_update_plan");
  });
});

describe("入队：只入队不发送，且必须先解决队列占用", () => {
  it("方案入队走 buildDynamicQueue → startQueue(autoStart=false)，组标签带目的港；一人一组一封", async () => {
    const view = planView(plan());
    const r = await enqueueRateUpdatePlan(view.planId);
    expect(r.success).toBe(true);
    if (!r.success || r.data.occupied) return;
    expect(r.data.enqueue.groups).toBe(view.groups.length);
    expect(r.data.enqueue.queuedCount).toBe(view.totals.covered);
    expect(startCalls.length).toBe(1);
    expect(startCalls[0]?.autoStart).toBe(false);              // 红线：程序永不自动开始群发
    expect(startCalls[0]?.tplNames.every(n => n.startsWith("运价更新 · "))).toBe(true);
    expect(buildCalls.map(c => c.ids).flat().sort()).toEqual([1, 2, 3, 7]);
  });

  it("队列里还有未发送批次 → 默认拒绝（startQueue 会清空全表，不能静默覆盖）", async () => {
    queueState.pendingGroups = 3;
    const r = await enqueueRateUpdatePlan(planView(plan()).planId);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ occupied: true, pendingGroups: 3 });
    expect(startCalls.length).toBe(0);
  });

  it("引擎正在发送时绝对不让插队", async () => {
    queueState.running = true;
    const r = await enqueueRateUpdatePlan(planView(plan()).planId);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error).toContain("正在运行");
    expect(startCalls.length).toBe(0);
  });

  it("用户明确同意覆盖（overwrite=true）才入队；方案用过即作废，防同份重复入队", async () => {
    queueState.pendingGroups = 2;
    const planId = plan().id;
    const first = await enqueueRateUpdatePlan(planId, undefined, true);
    expect(first.success && !first.data.occupied).toBe(true);
    expect(startCalls.length).toBe(1);
    const second = await enqueueRateUpdatePlan(planId);
    expect(second.success).toBe(false);
    expect(second.success ? "" : second.error).toContain("过期");
  });

  it("groupKeys 只入队选中的组；不存在的组当面报错并列出可选值", async () => {
    const planId = plan().id;
    const one = await enqueueRateUpdatePlan(planId, ["CARTAGENA|EN"]);
    expect(one.success && !one.data.occupied).toBe(true);
    if (!one.success || one.data.occupied) return;
    expect(one.data.enqueue.groups).toBe(1);
    expect(one.data.enqueue.pods).toEqual(["CARTAGENA"]);
  });

  it("未知分组 → 报错并给出可选键；planId 不存在 → 叫重新生成", async () => {
    const p = plan();
    const bad = await enqueueRateUpdatePlan(p.id, ["NOSUCH|EN"]);
    expect(bad.success).toBe(false);
    expect(bad.success ? "" : bad.error).toContain("未知分组");
    expect(bad.success ? "" : bad.error).toContain("SANTOS|EN");
    const gone = await enqueueRateUpdatePlan("nope");
    expect(gone.success ? "" : gone.error).toContain("重新生成");
  });
});
