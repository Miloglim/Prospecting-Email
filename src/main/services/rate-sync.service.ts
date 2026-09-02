import * as fs from "fs";
import * as path from "path";
import { and, eq, like, gte, isNull, or, sql } from "drizzle-orm";
import { APP_ROOT } from "../config";
import { Log } from "../logger";
import { getDb, saveDatabase } from "../db";
import { rateQuotes, type InsertRateQuoteRow } from "../db/schema/rates";
import { okResult, failResult, type Result } from "../errors";

// ── 运价同步服务 ──────────────────────────────────────────────────
// 链路：钉钉 AI 表格《海运运价智能台账》 →（千问办公定时任务 dws 全量拉取）→
//       data/rates-snapshot.json（dws record query 原样输出） → 本服务解析归一化 →
//       rate_quotes 镜像表（全量刷新）。程序只读镜像，不回写表格。

const SNAPSHOT_PATH = (process.env.RATES_SNAPSHOT_PATH || "").trim()
  || path.join(APP_ROOT, "data", "rates-snapshot.json");

/** 源表字段 ID → 语义（源自 dws field get 实测，改表结构时需同步更新） */
const F = {
  pol: "rj3c4Dc",          // 起运港
  pod: "M6UMJ2Y",          // 目的港
  lane: "xAfTdzf",         // 航线
  carrier: "Gc7HG8P",      // 船司
  container: "4Ye7pSe",    // 柜型
  oceanUsd: "RDG9zEx",     // 海运费USD
  validity: "32NW82C",     // 有效期船期
  freeDays: "kBm7poh",     // 目免
  shortfall: "QZeL9Dr",    // 亏舱费
  note: "uFJRuSd",         // 备注
  sourceGroup: "I0vGzUV",  // 来源群
  sender: "1NU3Dkx",       // 发送人
  msgTime: "HbQfZtf",      // 消息时间
  image: "F5UZCQj",        // 运价图片（附件，仅取文件名）
} as const;

interface DwsRecord { recordId?: string; cells?: Record<string, unknown> }

/** dws 单元格的三种形态：字符串 / {name, id}选项对象 / 附件数组 → 统一取文本 */
function cellText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const first = v[0] as { filename?: string } | undefined;
    return first?.filename ?? null;
  }
  if (typeof v === "object") {
    const o = v as { name?: string };
    return o.name ?? null;
  }
  return String(v);
}

/** 柜型归一化：脏值映射到标准码；组合价（斜杠分隔多种柜型）拼为 "A+B" */
export function normalizeContainer(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/['’\s]/g, "");
  if (s === "NOR" || s === "40NOR" || s === "45GPHC") return "NOR";
  if (s.includes("/")) {
    // 组合柜型：逐段归一后去重排序；全段无法识别则落入下方单值分支兜底
    const parts = s.split("/").map(p => normalizeContainer(p)).filter((x): x is string => !!x);
    const uniq = [...new Set(parts)];
    if (uniq.length > 0) return uniq.sort().join("+");
  }
  if (s.startsWith("20")) return "20GP";
  if (s.startsWith("40HQ") || s.startsWith("40HC")) return "40HQ";
  if (s.startsWith("40GP")) return "40GP";
  if (s.startsWith("45")) return "45HQ";
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 有效期解析："9.1-9.7" / "9月1日-9月7日" / "9.15-9.21" → {validFrom, validTo}
 * 年份取消息时间年份；结束月 < 起始月视为跨年。解析失败返回 null 对。
 */
export function parseValidity(raw: string | null, msgTime: string | null): { validFrom: string | null; validTo: string | null } {
  if (!raw) return { validFrom: null, validTo: null };
  const m = raw.match(/(\d{1,2})[.月](\d{1,2})日?\s*[-~—至到]+\s*(\d{1,2})[.月](\d{1,2})日?/);
  if (!m) return { validFrom: null, validTo: null };
  const year0 = (msgTime || "").slice(0, 4);
  const baseYear = /^\d{4}$/.test(year0) ? Number(year0) : new Date().getFullYear();
  const [, sm, sd, em, ed] = m as unknown as (string | undefined)[];
  const sMonth = Number(sm), sDay = Number(sd), eMonth = Number(em), eDay = Number(ed);
  if ([sMonth, eMonth].some(n => n < 1 || n > 12) || [sDay, eDay].some(n => n < 1 || n > 31)) {
    return { validFrom: null, validTo: null };
  }
  const from = `${baseYear}-${pad(sMonth)}-${pad(sDay)}`;
  const toYear = eMonth < sMonth ? baseYear + 1 : baseYear;
  const to = `${toYear}-${pad(eMonth)}-${pad(eDay)}`;
  return { validFrom: from, validTo: to };
}

/** 快照 JSON → 归一化行数组（纯函数，不触库，供单测） */
export function parseSnapshot(json: unknown): InsertRateQuoteRow[] {
  const root = (json ?? {}) as { data?: { records?: DwsRecord[] }; records?: DwsRecord[] };
  const records = root.data?.records ?? root.records ?? [];
  const out: InsertRateQuoteRow[] = [];
  records.forEach((r, i) => {
    const cells = r.cells;
    const pod = cellText(cells?.[F.pod]);
    if (!pod) return; // 无目的港的行无业务意义
    const containerRaw = cellText(cells?.[F.container]);
    const msgTime = cellText(cells?.[F.msgTime]);
    const { validFrom, validTo } = parseValidity(cellText(cells?.[F.validity]), msgTime);
    const usdRaw = cellText(cells?.[F.oceanUsd]);
    const usd = usdRaw != null ? Number(usdRaw.replace(/[,\s]/g, "")) : NaN;
    out.push({
      recordId: r.recordId || `local-${i}`,
      pol: cellText(cells?.[F.pol]),
      podRaw: pod,
      lane: cellText(cells?.[F.lane]),
      carrier: cellText(cells?.[F.carrier]),
      container: normalizeContainer(containerRaw),
      containerRaw,
      oceanUsd: Number.isFinite(usd) ? Math.round(usd) : null,
      validityRaw: cellText(cells?.[F.validity]),
      validFrom, validTo,
      freeDays: cellText(cells?.[F.freeDays]),
      shortfallFee: cellText(cells?.[F.shortfall]),
      note: cellText(cells?.[F.note]),
      sourceGroup: cellText(cells?.[F.sourceGroup]),
      sender: cellText(cells?.[F.sender]),
      msgTime,
      imageName: cellText(cells?.[F.image]),
      syncedAt: new Date().toISOString(),
    });
  });
  return out;
}

let lastSync: { at: string; imported: number; source: string } | null = null;

/** 北京时间今日 YYYY-MM-DD（valid_to 为日期文本，字典序比较即可判过期） */
function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 从快照文件全量刷新本地镜像 */
export function sync(): Result<{ imported: number; exportedAt?: string }> {
  Log.debug("rates.sync", SNAPSHOT_PATH);
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return failResult(`快照文件不存在：${SNAPSHOT_PATH}（请先由同步任务导出，或配置 RATES_SNAPSHOT_PATH）`);
  }
  let rows: InsertRateQuoteRow[];
  let exportedAt: string | undefined;
  try {
    const json = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf-8")) as { exportedAt?: string };
    exportedAt = json.exportedAt;
    rows = parseSnapshot(json);
  } catch (err) {
    Log.error("rates.sync", "快照解析失败", err instanceof Error ? err.stack : String(err));
    return failResult("快照文件解析失败，请检查格式");
  }
  if (rows.length === 0) return failResult("快照中无有效运价行（目的港全部为空？）");

  const db = getDb();
  db.delete(rateQuotes).run();
  // 分块插入，避免单条语句变量数过多
  for (let i = 0; i < rows.length; i += 100) {
    db.insert(rateQuotes).values(rows.slice(i, i + 100)).run();
  }
  saveDatabase();
  lastSync = { at: new Date().toISOString(), imported: rows.length, source: SNAPSHOT_PATH };
  Log.info("rates.sync", `镜像刷新 ${rows.length} 条（exportedAt=${exportedAt ?? "n/a"}）`);
  return okResult({ imported: rows.length, exportedAt });
}

export interface QuoteFilters { lane?: string; carrier?: string; pod?: string; container?: string; includeExpired?: boolean; limit?: number }

export interface QuoteDto {
  podRaw: string; lane: string | null; carrier: string | null; container: string | null;
  oceanUsd: number | null; validFrom: string | null; validTo: string | null;
  pol: string | null; note: string | null; sourceGroup: string | null; msgTime: string | null;
}

/** 条件查价（供 UI 与 agent 工具 quote_search 复用） */
function quoteConds(f: QuoteFilters) {
  const conds = [];
  // 航线模糊匹配：库里是「加勒比/南美东…」受控枚举，like 兼容「加勒比线」这类口语后缀
  if (f.lane) conds.push(like(rateQuotes.lane, `%${f.lane}%`));
  if (f.carrier) conds.push(eq(rateQuotes.carrier, f.carrier.toUpperCase()));
  if (f.pod) conds.push(like(rateQuotes.podRaw, `%${f.pod}%`));
  if (f.container) conds.push(or(eq(rateQuotes.container, f.container), like(rateQuotes.container, `%${f.container}%`)));
  if (!f.includeExpired) {
    conds.push(or(gte(rateQuotes.validTo, todayBeijing()), isNull(rateQuotes.validTo)));
  }
  return conds;
}

export function listQuotes(f: QuoteFilters): Result<QuoteDto[]> {
  const conds = quoteConds(f);
  const rows = getDb().select({
    podRaw: rateQuotes.podRaw, lane: rateQuotes.lane, carrier: rateQuotes.carrier,
    container: rateQuotes.container, oceanUsd: rateQuotes.oceanUsd,
    validFrom: rateQuotes.validFrom, validTo: rateQuotes.validTo,
    pol: rateQuotes.pol, note: rateQuotes.note, sourceGroup: rateQuotes.sourceGroup, msgTime: rateQuotes.msgTime,
  }).from(rateQuotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(rateQuotes.oceanUsd)
    .limit(Math.min(f.limit ?? 20, 5000))
    .all();
  return okResult(rows);
}

/** 满足条件的总条数（评测 rate-count 发现的缺陷：工具只返回截断后的行数，
 *  模型查"总共多少条"会拿不到真值而反复重试直至 max turns） */
export function countQuotes(f: QuoteFilters): number {
  const conds = quoteConds(f);
  const row = getDb().select({ n: sql<number>`count(*)` }).from(rateQuotes)
    .where(conds.length ? and(...conds) : undefined).get();
  return Number(row?.n ?? 0);
}

export function status(): Result<{
  total: number; active: number; lastSyncAt: string | null; lastImported: number | null;
  snapshotExists: boolean; snapshotMtime: string | null;
}> {
  const rows = getDb().select({ validTo: rateQuotes.validTo }).from(rateQuotes).all();
  const today = todayBeijing();
  let snapMtime: string | null = null;
  try { snapMtime = fs.statSync(SNAPSHOT_PATH).mtime.toISOString(); } catch { /* 无快照 */ }
  return okResult({
    total: rows.length,
    active: rows.filter(r => !r.validTo || r.validTo >= today).length,
    lastSyncAt: lastSync?.at ?? null,
    lastImported: lastSync?.imported ?? null,
    snapshotExists: snapMtime != null,
    snapshotMtime: snapMtime,
  });
}
