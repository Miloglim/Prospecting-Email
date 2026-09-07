import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as os from "os";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { rateQuotes } from "../../src/main/db/schema/rates";
import type { EmailInquiry } from "../../src/main/services/agent/email-parse";

// ═══════════════════════════════════════════════════════════════════
// 回信自查台账价（规范 docs/agent-draft-reply-spec.md §询价信回信）
// 钉住用户口径：解析询价邮件时「直接起草回复」= 直接报价 —— 程序自己得先把价查出来，
// 不能只叫模型「先 quote_search 再重调一次」（弱模型实测不照做，回信只剩"报价稍后补"）。
// 三件事：脏目的港段归一成查询词、起运港分区排序（不硬过滤）、过期与错柜型不许混进来。
// ═══════════════════════════════════════════════════════════════════

process.env.RATES_REMOTE_URL = "http://127.0.0.1:9/";

const TMP = path.join(os.tmpdir(), "prospector-reply-rates-test");
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

const { parseEmailInquiry } = await import("../../src/main/services/agent/email-parse");
const { lookupReplyRates, mirrorPolSet, podQueryWord } = await import("../../src/main/services/agent/reply-rates");

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
const day = (offset: number) =>
  new Date(Date.now() + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

function freshDb() {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.exec(BASE_SCHEMA_SQL);
  for (const s of [
    `ALTER TABLE inbox_messages ADD COLUMN intent text;`,
    `ALTER TABLE contacts ADD COLUMN language text;`,
  ]) { try { raw.run(s); } catch { /* 列已存在 */ } }
  h.db = drizzle(raw, { schema });
  h.db.insert(rateQuotes).values([
    // 当期有效 · 40HQ：三个不同起运港（宁波=来信起运港，天津/华南基本港=别的）
    { recordId: "q1", pol: "天津", podRaw: "SANTOS", lane: "南美东", carrier: "CMA", container: "40HQ", oceanUsd: 8000, validFrom: day(-1), validTo: day(5) },
    { recordId: "q2", pol: "宁波", podRaw: "Santos", lane: "南美东", carrier: "EMC", container: "40HQ", oceanUsd: 8800, validFrom: day(-1), validTo: day(5) },
    { recordId: "q3", pol: "华南基本港", podRaw: "Santos", lane: "南美东", carrier: "ONE", container: "40HQ", oceanUsd: 9000, validFrom: day(-1), validTo: day(5) },
    // 航线级行（podRaw 是航线名）：靠 podRaw 展开命中，不能被漏
    { recordId: "q4", pol: "青岛", podRaw: "南美东", lane: "南美东", carrier: "MSC", container: "40HQ", oceanUsd: 8500, validFrom: day(-1), validTo: day(5) },
    // 柜型不同（40NOR）：来信要 40HQ，这条不许混进报价
    { recordId: "q5", pol: "蛇口", podRaw: "Santos", lane: "南美东", carrier: "MSK", container: "40NOR", oceanUsd: 7810, validFrom: day(-1), validTo: day(5) },
    // 已过期：再便宜也不许报
    { recordId: "q6", pol: "盐田", podRaw: "Santos", lane: "南美东", carrier: "ZIM", container: "40HQ", oceanUsd: 7000, validFrom: day(-10), validTo: day(-3) },
  ]).run();
  return h.db;
}

const inq = (o: Partial<EmailInquiry>): EmailInquiry => ({
  container: null, containerRaw: null, pol: null, polCode: null, pod: null, podCode: null,
  incoterm: null, cargo: null, cargoValueUsd: null, quoteRef: null, volumeCbm: null, weightKg: null, ...o,
});

// 真实来信（Three Logistics QUOTE-1297-0926，htmlToText 之后的形态：标签独行、值在下一行）
const REAL_BODY = [
  "Three Logistics", "Technology that moves your cargo", "Date", "4 de setembro de 2026",
  "International Quotation Request - FCL", "Quotation No.:", "QUOTE-1297-0926", "Dear Partner,",
  "Please provide your quotation for the shipment with the following details:",
  "Incoterm", "FOB", "Port of Loading", "Porto de Ningbo - CNNBG (Ningbo)",
  "Port of Discharge", "Santos - BRSSZ (Santos, SP)", "Commodity / HS Code", "F.A.K. / NON IMO / Stackable",
  "Volume", "1 x 40' HC", "Remarks", "PLEASE ADVISE:", "Freight Rate / Validity",
].join("\n\n");

describe("回信自查台账价", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => { freshDb(); });

  it("真实询价信：标签独行也能抽出双港 + LOCODE + 柜型 + 询价号", () => {
    const p = parseEmailInquiry(REAL_BODY);
    expect(p.polCode).toBe("CNNBG");
    expect(p.podCode).toBe("BRSSZ");
    expect(p.pod).toContain("Santos");
    expect(p.container).toBe("40HQ");          // "1 x 40' HC" → HC 归一到 HQ
    expect(p.quoteRef).toBe("QUOTE-1297-0926");
    expect(p.incoterm).toBe("FOB");
  });

  it("LOCODE 只认国家码开头的真代码：Porto/CHINA/ITALY 这类五字母词不许冒充", () => {
    expect(parseEmailInquiry("Port of Loading: Porto de Ningbo - CNNBG (Ningbo)").polCode).toBe("CNNBG");
    expect(parseEmailInquiry("POL: Shanghai, CHINA").polCode).toBeNull();
    expect(parseEmailInquiry("POL: Genoa - ITGOA (Italy)").polCode).toBe("ITGOA");
    expect(parseEmailInquiry("Destination: Santos - BRSSZ (Santos, SP)").podCode).toBe("BRSSZ");
  });

  it("脏目的港段归一成查询词：\"Santos - BRSSZ\" → SANTOS；只有 LOCODE 也认", () => {
    expect(podQueryWord(inq({ pod: "Santos - BRSSZ", podCode: "BRSSZ" }))).toBe("SANTOS");
    expect(podQueryWord(inq({ pod: "", podCode: "BRSSZ" }))).toBe("SANTOS");
    expect(podQueryWord(inq({ pod: "Santos (Santos, SP)" }))).toBe("SANTOS");
    expect(podQueryWord(inq({}))).toBeNull();
  });

  it("起运港映射成集合：CNNBG→宁波；深圳系→含华南基本港；未知港→null（不硬过滤）", () => {
    expect(mirrorPolSet(inq({ pol: "Porto de Ningbo", polCode: "CNNBG" }))).toEqual(["宁波"]);
    const sz = mirrorPolSet(inq({ pol: "Shenzhen", polCode: "CNSZX" }));
    expect(sz).toContain("华南基本港");
    expect(mirrorPolSet(inq({ pol: "Mombasa", polCode: "KEMBA" }))).toBeNull();
    expect(mirrorPolSet(inq({}))).toBeNull();
  });

  it("来信起运港对得上：对齐的行排最前（哪怕更贵），过期与错柜型不许进来", () => {
    const r = lookupReplyRates(inq({ pod: "Santos - BRSSZ", podCode: "BRSSZ", pol: "Porto de Ningbo", polCode: "CNNBG", container: "40HQ" }))!;
    expect(r.pod).toBe("SANTOS");
    expect(r.polAligned).toBe(true);
    expect(r.rows[0]!.carrier).toBe("EMC");          // 宁波 8800 排在天津 8000 前面
    expect(r.rows[0]!.pol).toBe("宁波");
    expect(r.rows.map(x => x.carrier)).not.toContain("MSK");   // 40NOR 柜型不符
    expect(r.rows.map(x => x.carrier)).not.toContain("ZIM");   // 已过期
    expect(r.rows.map(x => x.carrier)).toContain("MSC");       // 航线级行靠 podRaw 展开命中
    expect(r.rows.every(x => x.price != null && x.price >= 8000)).toBe(true);
  });

  it("起运港对不上：仍给全量当期价（按价升序），但 polAligned=false 让回信逐条写明起运港", () => {
    const r = lookupReplyRates(inq({ pod: "Santos", podCode: "BRSSZ", pol: "Mombasa", polCode: "KEMBA", container: "40HQ" }))!;
    expect(r.polAligned).toBe(false);
    expect(r.rows[0]!.carrier).toBe("CMA");          // 最便宜的先给
    expect(r.rows[0]!.price).toBe(8000);
    expect(r.rows.length).toBeGreaterThanOrEqual(4);
  });

  it("抽不到目的港就不查（宁可不报价，不可报错价）", () => {
    expect(lookupReplyRates(inq({ pol: "Ningbo", polCode: "CNNBG", container: "40HQ" }))).toBeNull();
  });
});
