import { and, eq, like, gte, isNull, or, sql } from "drizzle-orm";
import { Log } from "../logger";
import { getDb, saveDatabase } from "../db";
import { rateQuotes, type InsertRateQuoteRow } from "../db/schema/rates";
import { okResult, failResult, type Result } from "../errors";
import { netFetch } from "../net-proxy";

// ── 运价同步服务 ──────────────────────────────────────────────────
// 链路（v5.0.3 起）：钉钉台账（公司电脑心跳入库）→ board_server 局域网 HTTP →
//       本服务分页拉取 + 归一化 → rate_quotes 镜像表（全量刷新）。
// 程序只读镜像，不回写。服务地址为程序内置参数（RATES_REMOTE_URL 可覆盖，无 UI 配置），
// 连接不上时给出简单提示；镜像保留上次同步成功的数据，失败不删旧。
// 规范：docs/rates-remote-source-spec.md

/** 远程运价库地址（内置默认 = 公司电脑 board_server；RATES_REMOTE_URL 环境变量可覆盖） */
const REMOTE_BASE = (process.env.RATES_REMOTE_URL || "").trim() || "http://192.168.189.229:8788";
/** 自动同步间隔（分钟），RATES_REMOTE_MINUTES 可覆盖，最小 1 */
const AUTO_MINUTES = Math.max(1, Number(process.env.RATES_REMOTE_MINUTES || 10) || 10);
const PAGE_SIZE = 500;
const ROW_CAP = 20_000;

/** 友好提示：镜像拉取失败时给用户的一句话（细节进日志） */
const REMOTE_DOWN_HINT = "运价库连接失败：请确认公司电脑已开机、运价服务已启动，且本机与公司电脑在同一局域网。";

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

/** 远程行 → 文本（数字/字符串都收；空串归 null） */
function rText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
/** 别名容错：远程行字段名按序取第一个非空值 */
function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rText(row[k]);
    if (v != null) return v;
  }
  return null;
}

/**
 * 远程行 → 归一化镜像行（纯函数，不触库，供单测）。
 * 字段别名容错（board_server 侧命名与本地 schema 不完全一致）：
 * container_type|container_raw|container → containerRaw，freight_usd|ocean_usd → oceanUsd，pod_raw|pod → podRaw。
 * 柜型归一 / 有效期解析复用 normalizeContainer / parseValidity；远程已给 valid_from/valid_to 则直采。
 * 无目的港的行无业务意义，返回 null 跳过。
 */
export function mapRemoteRow(row: Record<string, unknown>, fallbackId: string): InsertRateQuoteRow | null {
  const pod = pick(row, ["pod_raw", "pod"]);
  if (!pod) return null;
  const containerRaw = pick(row, ["container_type", "container_raw", "container"]);
  const msgTime = pick(row, ["msg_time"]);
  const vf = pick(row, ["valid_from"]);
  const vt = pick(row, ["valid_to"]);
  const parsed = vf && vt ? { validFrom: vf, validTo: vt } : parseValidity(pick(row, ["validity_raw"]), msgTime);
  const usdRaw = pick(row, ["freight_usd", "ocean_usd"]);
  const usd = usdRaw != null ? Number(usdRaw.replace(/[,\s]/g, "")) : NaN;
  return {
    recordId: pick(row, ["record_id"]) || fallbackId,
    pol: pick(row, ["pol"]),
    podRaw: pod,
    lane: pick(row, ["lane"]),
    carrier: pick(row, ["carrier"]),
    container: normalizeContainer(containerRaw),
    containerRaw,
    oceanUsd: Number.isFinite(usd) ? Math.round(usd) : null,
    validityRaw: pick(row, ["validity_raw"]),
    validFrom: parsed.validFrom,
    validTo: parsed.validTo,
    freeDays: pick(row, ["free_days"]),
    shortfallFee: pick(row, ["shortfall_fee", "shortfall"]),
    note: pick(row, ["note"]),
    sourceGroup: pick(row, ["source_group"]),
    sender: pick(row, ["sender"]),
    msgTime,
    imageName: pick(row, ["image_name"]),
    syncedAt: new Date().toISOString(),
  };
}

let lastSync: { at: string; imported: number; source: string } | null = null;
let lastError: string | null = null;
let syncing = false;
let autoTimer: ReturnType<typeof setInterval> | null = null;

/** 北京时间今日 YYYY-MM-DD（valid_to 为日期文本，字典序比较即可判过期） */
function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 从远程运价库全量刷新本地镜像（分页拉全量 → 归一化 → 删旧插新）。
 * 拉取失败不动本地镜像（保留上次成功数据），返回带友好提示的失败。
 */
export async function sync(): Promise<Result<{ imported: number }>> {
  if (syncing) return failResult("上一次同步仍在进行中，请稍候");
  syncing = true;
  try {
    const base = REMOTE_BASE.replace(/\/$/, "");
    const rows: InsertRateQuoteRow[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total && offset < ROW_CAP) {
      let res: Response;
      try {
        res = await netFetch(`${base}/api/rates?limit=${PAGE_SIZE}&offset=${offset}`, { headers: { Accept: "application/json" } });
      } catch (err) {
        const d = err instanceof Error ? err.message.slice(0, 80) : "网络不可达";
        lastError = `${REMOTE_DOWN_HINT}（${d}）`;
        Log.warn("rates.sync", `远程库不可达：${d}`);
        return failResult(REMOTE_DOWN_HINT);
      }
      if (!res.ok) {
        lastError = `运价服务返回 HTTP ${res.status}（${base}）`;
        Log.warn("rates.sync", lastError);
        return failResult(`运价服务响应异常（HTTP ${res.status}），请联系数据管理员检查服务。`);
      }
      let json: { ok?: boolean; total?: number; rows?: Record<string, unknown>[] };
      try { json = await res.json() as typeof json; }
      catch { lastError = "运价服务返回格式异常"; return failResult("运价服务返回格式异常，请联系数据管理员。"); }
      const list = Array.isArray(json.rows) ? json.rows : [];
      total = Number.isFinite(Number(json.total)) ? Number(json.total) : offset + list.length;
      for (let i = 0; i < list.length; i++) {
        const m = mapRemoteRow(list[i]!, `remote-${offset + i}`);
        if (m) rows.push(m);
      }
      if (list.length === 0) break;
      offset += list.length;
    }
    if (!rows.length) {
      lastError = "远程库没有有效运价行";
      return failResult("运价库暂无有效数据（远程行目的港全为空或接口结构不符）。");
    }
    const db = getDb();
    db.delete(rateQuotes).run();
    for (let i = 0; i < rows.length; i += 100) {
      db.insert(rateQuotes).values(rows.slice(i, i + 100)).run();
    }
    saveDatabase();
    lastSync = { at: new Date().toISOString(), imported: rows.length, source: base };
    lastError = null;
    Log.info("rates.sync", `镜像刷新 ${rows.length} 条（远程 ${base}）`);
    return okResult({ imported: rows.length });
  } finally {
    syncing = false;
  }
}

/** 自动同步：启动后 5 秒拉一次，之后按 AUTO_MINUTES 轮询；失败只记日志不打扰用户 */
export function startAutoSync(): void {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    void sync().then(r => {
      if (!r.success) Log.debug("rates.auto", `自动同步未成功：${r.error}`);
    });
  }, AUTO_MINUTES * 60_000);
  setTimeout(() => {
    void sync().then(r => {
      if (!r.success) Log.debug("rates.auto", `启动同步未成功：${r.error}`);
    });
  }, 5_000);
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
  remoteHost: string; lastError: string | null;
}> {
  const rows = getDb().select({ validTo: rateQuotes.validTo }).from(rateQuotes).all();
  const today = todayBeijing();
  let host = REMOTE_BASE;
  try { host = new URL(REMOTE_BASE).host; } catch { /* 保底原样 */ }
  return okResult({
    total: rows.length,
    active: rows.filter(r => !r.validTo || r.validTo >= today).length,
    lastSyncAt: lastSync?.at ?? null,
    lastImported: lastSync?.imported ?? null,
    remoteHost: host,
    lastError,
  });
}
