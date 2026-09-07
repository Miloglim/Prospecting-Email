import { and, eq, like, gte, isNull, or, desc, sql, type Column } from "drizzle-orm";
import { Log } from "../logger";
import { getDb, saveDatabase } from "../db";
import { rateQuotes, spaceQuotes, type InsertRateQuoteRow, type InsertSpaceQuoteRow } from "../db/schema/rates";
import { okResult, failResult, type Result } from "../errors";
import { netFetch } from "../net-proxy";

// ── 运价 / 舱位同步服务 ──────────────────────────────────────────
// 链路：公司电脑台账（board_server，局域网 HTTP）→
//       本服务分页拉取 + 归一化 → 两张只读镜像：rate_quotes（运价）+ space_records（舱位）。
// 程序只读镜像，不回写。服务地址为程序内置参数（RATES_REMOTE_URL 可覆盖，无 UI 配置），
// 连接不上时给出简单提示；镜像保留上次同步成功的数据，失败不删旧。
// 规范：docs/rates-remote-source-spec.md（同步）+ docs/rates-query-fallback-spec.md（查询三段式）

/** 远程运价库地址（内置默认 = 公司电脑 board_server；RATES_REMOTE_URL 环境变量可覆盖） */
const REMOTE_BASE = (process.env.RATES_REMOTE_URL || "").trim() || "https://l5ruag9m.qwenwork.host";
/** 台账工作台跳转与报价截图 URL 都用它：界面层经 IPC/镜像字段取值，不再各自硬编码 IP */
export function remoteBase(): string { return REMOTE_BASE; }
/**
 * board_server 局域网可达性探测：GET 根路径，3 秒内有任何 HTTP 响应即视为通
 * （服务在跑就行，状态码不挑）；连不上/超时返回 false。
 * 用裸 fetch 不走 netFetch 代理——局域网 IP 经代理必然到不了。
 */
export async function probeBoard(): Promise<boolean> {
  try {
    await fetch(`${REMOTE_BASE}/`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch { return false; }
}

/** 探测结果缓存 30 秒：一次查价链路里可能连用好几次，别每次都得等满 3 秒超时 */
let probeCache: { at: number; ok: boolean } | null = null;
export async function probeBoardCached(): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.at < 30_000) return probeCache.ok;
  const ok = await probeBoard();
  probeCache = { at: Date.now(), ok };
  return ok;
}

/**
 * 目的港尾巴上可能粘连台账网页里的小字航线标签（"ISTANBUL 伊斯坦布尔(土耳其) 地东"）。
 * 受控词表只收区域/航线简称；另一个判据是"尾段与该行 route 值相同"（最常见形态）。
 * 护栏：只剥最后一个空白分隔、长度 ≤6 且不含括号的尾段 —— 正常形态
 * "BALBOA, PA 巴尔博亚(巴拿马)" 的中文译名(国家)带括号，绝不会被切碎。
 * 剥下来的标签在该行 lane 为空时回填 lane（航线信息回到它该在的列）。
 */
const LANE_TAGS = [
  "地东", "地西", "欧地", "欧西", "地中海", "黑海", "波海", "波罗的海", "红海", "波斯湾", "阿拉伯海",
  "南亚", "东南亚", "西非", "东非", "北非", "北欧", "大洋洲",
  "加勒比", "墨西哥", "南美东", "南美西", "中美洲", "美东", "美西",
];
export function stripLaneTag(podRaw: string, lane: string | null): { podRaw: string; lane: string | null } {
  const s = podRaw.trim();
  const i = s.lastIndexOf(" ");
  if (i <= 0) return { podRaw: s, lane };
  const head = s.slice(0, i).trim();
  const tail = s.slice(i + 1).trim();
  if (!head || !tail || tail.length > 6 || /[()（）\[\]]/.test(tail)) return { podRaw: s, lane };
  if (!LANE_TAGS.includes(tail) && tail !== lane?.trim()) return { podRaw: s, lane };
  return { podRaw: head, lane: lane?.trim() || tail };
}
/** 自动同步间隔（分钟），RATES_REMOTE_MINUTES 可覆盖，最小 1 */
const AUTO_MINUTES = Math.max(1, Number(process.env.RATES_REMOTE_MINUTES || 240) || 240);   // 默认 4 小时
const PAGE_SIZE = 500;
const ROW_CAP = 20_000;

/** 同步失败提示（短句；排查细节只进日志） */
const REMOTE_DOWN_HINT = "网络连接失败";

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
 * 键名以实测为准（docs/运价接口字段对接说明.md，2026-09-06 从线上服务抓取核对）：
 * route→航线 lane、remark→备注、dead_freight→亏舱费、message_time→消息时间、
 * content_key→稳定记录键、freight_usd 为字符串（"6815.00"）、container_type 可为 null。
 * 柜型归一 / 有效期解析复用 normalizeContainer / parseValidity；
 * valid_from/valid_to 独立采信（缺一边才用本地解析补）。
 * 无目的港的行无业务意义，返回 null 跳过。
 */
export function mapRemoteRow(row: Record<string, unknown>, fallbackId: string): InsertRateQuoteRow | null {
  const pod = pick(row, ["pod_raw", "pod"]);
  if (!pod) return null;
  const containerRaw = pick(row, ["container_type", "container_raw", "container"]);
  const msgTime = pick(row, ["message_time", "msg_time"]);
  const vf = pick(row, ["valid_from"]);
  const vt = pick(row, ["valid_to"]);
  const parsed = parseValidity(pick(row, ["validity_raw"]), msgTime);
  const usdRaw = pick(row, ["freight_usd", "ocean_usd"]);
  const usd = usdRaw != null ? Number(usdRaw.replace(/[,\s]/g, "")) : NaN;
  // 目的港尾部粘连的航线小字（"… 地东"）剥掉，空 lane 用它回填
  const cleaned = stripLaneTag(pod, pick(row, ["route", "lane"]));
  return {
    recordId: pick(row, ["content_key", "record_id"]) || fallbackId,
    pol: pick(row, ["pol"]),
    podRaw: cleaned.podRaw,
    lane: cleaned.lane,
    carrier: pick(row, ["carrier"]),
    container: normalizeContainer(containerRaw),
    containerRaw,
    oceanUsd: Number.isFinite(usd) ? Math.round(usd) : null,
    validityRaw: pick(row, ["validity_raw"]),
    validFrom: vf ?? parsed.validFrom,
    validTo: vt ?? parsed.validTo,
    freeDays: pick(row, ["free_days"]),
    shortfallFee: pick(row, ["dead_freight", "shortfall_fee", "shortfall"]),
    note: pick(row, ["remark", "note"]),
    sourceGroup: pick(row, ["source_group"]),
    sender: pick(row, ["sender"]),
    msgTime,
    imageName: pick(row, ["image_url", "image_name"]),
    syncedAt: new Date().toISOString(),
  };
}

/**
 * 远程舱位行 → 归一化镜像行（/api/space，与运价同构但字段集不同：无海运费/有效期，
 * 多船名航次、截关、箱型箱量、舱位类型）。纯函数不触库，供单测。
 * 接口文档：docs/运价接口字段对接说明.md §3「/api/space 行」。
 * pod 在舱位表里可能为 null（群里常只报航线）；目的港同样剥尾部航线小字并回填空 lane；
 * price_usd 源端是文本（可能 "6815/7015" 这类双值），原样保留不强转成数字以免丢信息。
 */
export function mapRemoteSpace(row: Record<string, unknown>, fallbackId: string): InsertSpaceQuoteRow | null {
  const carrier = pick(row, ["carrier"]);
  const rawPod = pick(row, ["pod_raw", "pod"]);
  const lane0 = pick(row, ["route", "lane"]);
  const cleaned = rawPod ? stripLaneTag(rawPod, lane0) : { podRaw: null, lane: lane0 ?? null };
  const containerRaw = pick(row, ["container_type", "box_desc", "container_raw"]);
  return {
    recordId: pick(row, ["content_key", "record_id"]) || fallbackId,
    pol: pick(row, ["pol"]),
    podRaw: cleaned.podRaw,
    lane: cleaned.lane,
    carrier,
    container: normalizeContainer(containerRaw),
    containerRaw,
    boxQty: pick(row, ["box_qty"]),
    spaceType: pick(row, ["space_type", "stype"]),
    vessel: pick(row, ["vessel_voyage", "vessel"]),
    etd: pick(row, ["etd"]),
    cutoffRaw: pick(row, ["cutoff_raw", "cutoff"]),
    priceUsd: pick(row, ["price_usd", "price"]),
    note: pick(row, ["remark", "note"]),
    sourceGroup: pick(row, ["source_group"]),
    sender: pick(row, ["sender"]),
    msgTime: pick(row, ["message_time", "msg_time"]),
    imageName: pick(row, ["image_url", "image_name"]),
    status: pick(row, ["status"]),
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

/** 分页拉一页（外层结构 {ok,total,rows}）；网络/响应异常返回 null 由调用方兜 */
async function pullPage(base: string, path: string, query: string, offset: number):
  Promise<{ rows: Record<string, unknown>[]; total: number } | null> {
  try {
    const res = await netFetch(`${base}${path}?${query}&limit=${PAGE_SIZE}&offset=${offset}`,
      { headers: { Accept: "application/json" } });
    if (!res.ok) { lastError = `${path} 返回 HTTP ${res.status}（${base}）`; return null; }
    const json = await res.json() as { ok?: boolean; total?: number; rows?: Record<string, unknown>[] };
    if (json.ok === false) { lastError = `${path} 响应 ok=false（${base}）`; return null; }
    const list = Array.isArray(json.rows) ? json.rows : [];
    return { rows: list, total: Number.isFinite(Number(json.total)) ? Number(json.total) : offset + list.length };
  } catch (err) {
    lastError = `${REMOTE_DOWN_HINT}（${err instanceof Error ? err.message.slice(0, 80) : "网络不可达"}）`;
    return null;
  }
}

/**
 * 从台账全量刷新一张镜像表：分页拉 → 归一化 → 删旧插新（拉取中途失败则一行都不写，保留旧数据）。
 * @param statusQuery 服务端状态过滤（运价「当前生效」/舱位「当前有效」，两表字面量不同）；
 *                    传 null 则不带该参数，取回后在本地剔掉「已被覆盖」
 */
async function pullTable<T>(
  base: string, path: string, statusQuery: string | null, map: (row: Record<string, unknown>, id: string) => T | null,
): Promise<{ rows: T[]; unreachable: boolean }> {
  const out: T[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total && offset < ROW_CAP) {
    const page = await pullPage(base, path, statusQuery ? `status=${statusQuery}` : "", offset);
    if (!page) return { rows: out, unreachable: true };
    for (let i = 0; i < page.rows.length; i++) {
      const raw = page.rows[i]!;
      if (!statusQuery && String(raw.status ?? "") === "已被覆盖") continue;   // 被覆盖的历史不进镜像
      const m = map(raw, `${path.replace(/\W/g, "")}-${offset + i}`);
      if (m) out.push(m);
    }
    if (page.rows.length === 0) break;
    total = page.total;
    offset += page.rows.length;
  }
  return { rows: out, unreachable: false };
}

/**
 * 刷新本地镜像：运价（/api/rates）+ 舱位（/api/space），同批全量、各自独立成败。
 * 运价拉不到 = 整体失败（保留旧镜像，界面给友好提示）；
 * 舱位拉不到只记日志并保留旧舱位镜像——舱位是附带信息，不该拖垮运价刷新。
 */
export async function sync(): Promise<Result<{ imported: number }>> {
  if (syncing) return failResult("上一次同步仍在进行中，请稍候");
  syncing = true;
  try {
    const base = REMOTE_BASE.replace(/\/$/, "");
    const cur = encodeURIComponent("当前生效");
    const rates = await pullTable(base, "/api/rates", cur, mapRemoteRow);
    if (rates.unreachable) {
      Log.warn("rates.sync", lastError ?? "远程库不可达");
      return failResult(lastError && !lastError.startsWith(REMOTE_DOWN_HINT)
        ? "运价服务响应异常，请联系数据管理员检查服务。" : REMOTE_DOWN_HINT);
    }
    if (!rates.rows.length) {
      lastError = "远程库没有有效运价行";
      return failResult("运价库暂无有效数据（远程行目的港全为空或接口结构不符）。");
    }
    const db = getDb();
    db.delete(rateQuotes).run();
    for (let i = 0; i < rates.rows.length; i += 100) {
      db.insert(rateQuotes).values(rates.rows.slice(i, i + 100)).run();
    }

    // 舱位：状态字面量与运价不同，服务端不认这个值时退回不带 status 再拉一次（本地剔已被覆盖）
    const spaceCur = encodeURIComponent("当前有效");
    let spaces = await pullTable(base, "/api/space", spaceCur, mapRemoteSpace);
    if (spaces.unreachable || !spaces.rows.length) {
      const retry = await pullTable(base, "/api/space", null, mapRemoteSpace);
      if (!retry.unreachable && retry.rows.length) spaces = retry;
    }
    let spaceImported = 0;
    if (spaces.rows.length) {
      db.delete(spaceQuotes).run();
      for (let i = 0; i < spaces.rows.length; i += 100) {
        db.insert(spaceQuotes).values(spaces.rows.slice(i, i + 100)).run();
      }
      spaceImported = spaces.rows.length;
    } else if (!spaces.unreachable) {
      Log.debug("rates.sync", "舱位镜像拉到 0 行，保留旧数据");
    } else {
      Log.debug("rates.sync", `舱位拉取失败，保留旧舱位镜像：${lastError ?? ""}`);
    }

    saveDatabase();
    lastSync = { at: new Date().toISOString(), imported: rates.rows.length, source: base };
    lastError = null;
    Log.info("rates.sync", `镜像刷新：运价 ${rates.rows.length} 条、舱位 ${spaceImported} 条（远程 ${base}）`);
    return okResult({ imported: rates.rows.length });
  } finally {
    syncing = false;
  }
}

/** 自动同步：启动后 5 秒拉一次，之后按 AUTO_MINUTES 轮询；失败只记日志不打扰用户 */
export function startAutoSync(): void {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    void sync().then(r => {
      if (!r.success) Log.debug("rates.auto", `自动同步失败：${r.error}`);
    });
  }, AUTO_MINUTES * 60_000);
  setTimeout(() => {
    void sync().then(r => {
      if (!r.success) Log.debug("rates.auto", `启动同步失败：${r.error}`);
    });
  }, 5_000);
}

export interface QuoteFilters { lane?: string; carrier?: string; pol?: string; pod?: string; container?: string; includeExpired?: boolean; limit?: number; /** podRaw 展开集（航线名/区域码），查具体港时 OR 进过滤 */ podExtra?: string[]; /** 跨字段并集词：每个词同时比对 lane/pod_raw/pol，词之间 AND（规范 rates-query-fallback-spec §1） */ terms?: string[] }

export interface QuoteDto {
  podRaw: string; lane: string | null; carrier: string | null; container: string | null;
  oceanUsd: number | null; validFrom: string | null; validTo: string | null;
  pol: string | null; note: string | null; sourceGroup: string | null; msgTime: string | null;
  // 详情抽屉用（追加在尾部：agent 数据表格卡取前 7 键自动生成列，保持列序不变）
  validityRaw: string | null; freeDays: string | null; shortfallFee: string | null; sender: string | null;
  /** 报价截图的 board_server 绝对 URL（无图为 null；接口未动，只拼现成的 /images/ 静态服务） */
  imageUrl: string | null;
}

/** 条件查价（供 UI 与 agent 工具 quote_search 复用） */
function quoteConds(f: QuoteFilters) {
  const conds = [];
  // 航线模糊匹配：库里是「加勒比/南美东…」受控枚举，like 兼容「加勒比线」这类口语后缀
  if (f.lane) conds.push(like(rateQuotes.lane, `%${f.lane}%`));
  if (f.carrier) conds.push(like(rateQuotes.carrier, `%${f.carrier}%`));   // 模糊 + ASCII 大小写不敏感（zim→ZIM）
  // 起运港模糊匹配（界面筛选与列序对齐：船司→起运港→目的港→柜型）
  if (f.pol) conds.push(like(rateQuotes.pol, `%${f.pol}%`));
  if (f.pod) {
    // 港口归一展开：pod=SANTOS 也要命中 podRaw=「南美东」/区域码 的航线级行
    const podConds = [like(rateQuotes.podRaw, `%${f.pod}%`)];
    for (const extra of f.podExtra ?? []) podConds.push(eq(rateQuotes.podRaw, extra));
    conds.push(or(...podConds));
  }
  if (f.container) conds.push(or(eq(rateQuotes.container, f.container), like(rateQuotes.container, `%${f.container}%`)));
  // 跨字段并集：一个词到底是航线名还是港口名，机械层不猜（模型也不该猜）
  for (const t of f.terms ?? []) {
    const w = t.trim();
    if (!w) continue;
    conds.push(or(like(rateQuotes.lane, `%${w}%`), like(rateQuotes.podRaw, `%${w}%`), like(rateQuotes.pol, `%${w}%`)));
  }
  if (!f.includeExpired) {
    conds.push(or(gte(rateQuotes.validTo, todayBeijing()), isNull(rateQuotes.validTo)));
  }
  return conds;
}

/**
 * 镜像库存概览（实时现算，不养第二份词表）：查价空结果时回给模型当候选，
 * 让"语义理解"这一步有真实可依的东西。规范 rates-query-fallback-spec §3。
 */
export function quoteOptions(limit = 20): {
  lanes: { v: string; c: number }[]; pods: { v: string; c: number }[]; rows: number; latestSyncAt: string | null;
} {
  const db = getDb();
  const group = (col: Column, label: string) => db.select({
    v: sql<string>`coalesce(nullif(trim(${col}), ''), ${label})`, c: sql<number>`count(*)`,
  }).from(rateQuotes).groupBy(sql`1`).orderBy(sql`count(*) desc`).limit(limit).all();
  return {
    lanes: group(rateQuotes.lane, "（未标注航线）"),
    pods: group(rateQuotes.podRaw, "（未标注目的港）"),
    rows: db.select({ n: sql<number>`count(*)` }).from(rateQuotes).get()?.n ?? 0,
    latestSyncAt: db.select({ t: sql<string>`max(${rateQuotes.syncedAt})` }).from(rateQuotes).get()?.t ?? null,
  };
}

export function listQuotes(f: QuoteFilters): Result<QuoteDto[]> {
  const conds = quoteConds(f);
  const rows = getDb().select({
    podRaw: rateQuotes.podRaw, lane: rateQuotes.lane, carrier: rateQuotes.carrier,
    container: rateQuotes.container, oceanUsd: rateQuotes.oceanUsd,
    validFrom: rateQuotes.validFrom, validTo: rateQuotes.validTo,
    pol: rateQuotes.pol, note: rateQuotes.note, sourceGroup: rateQuotes.sourceGroup, msgTime: rateQuotes.msgTime,
    // 尾键：详情抽屉字段（agent 表格卡只认前 7 键，加列不改展示序）
    validityRaw: rateQuotes.validityRaw, freeDays: rateQuotes.freeDays,
    shortfallFee: rateQuotes.shortfallFee, sender: rateQuotes.sender, imageName: rateQuotes.imageName,
  }).from(rateQuotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(rateQuotes.oceanUsd)
    .limit(Math.min(f.limit ?? 20, 5000))
    .all();
  // 截图走 board_server 现成的 /images/ 静态服务（只取 basename 防穿越），拼成绝对 URL 给界面
  const base = REMOTE_BASE.replace(/\/$/, "");
  return okResult(rows.map(({ imageName, ...rest }) => ({
    ...rest,
    imageUrl: imageName ? `${base}/images/${encodeURIComponent(imageName)}` : null,
  })));
}

/** 满足条件的总条数（评测 rate-count 发现的缺陷：工具只返回截断后的行数，
 *  模型查"总共多少条"会拿不到真值而反复重试直至 max turns） */
export function countQuotes(f: QuoteFilters): number {
  const conds = quoteConds(f);
  const row = getDb().select({ n: sql<number>`count(*)` }).from(rateQuotes)
    .where(conds.length ? and(...conds) : undefined).get();
  return Number(row?.n ?? 0);
}

export interface SpaceFilters { terms?: string[]; pod?: string; lane?: string; carrier?: string; pol?: string; container?: string; /** 只看最近 N 天的群内动态（默认 21 天），舱位是时效信息 */ days?: number; limit?: number }

export interface SpaceDto {
  podRaw: string | null; lane: string | null; carrier: string | null; pol: string | null;
  container: string | null; boxQty: string | null; spaceType: string | null;
  vessel: string | null; etd: string | null; cutoffRaw: string | null; priceUsd: string | null;
  note: string | null; sender: string | null; sourceGroup: string | null; msgTime: string | null;
  imageUrl: string | null;
}

/**
 * 查运价时附带的「相关舱位」：用户查的那个词同时比对航线/目的港/起运港/柜型/船名，
 * 只取最近 days 天（舱位是群内动态，旧一条会误导），按消息时间倒序。
 * msg_time 格式不统一（"2026-09-03" 或 "2026-09-06 17:59"），但都以 YYYY-MM-DD 开头，字典序可比。
 */
export function listSpaces(f: SpaceFilters): Result<SpaceDto[]> {
  const conds = [];
  const words = [...(f.terms ?? []), f.pod ?? "", f.lane ?? ""];
  for (const t of words) {
    const w = (t ?? "").trim();
    if (!w) continue;
    // 一个词可能是航线名、港名、船司的船名——舱位表里哪一列命中都算相关
    conds.push(or(
      like(spaceQuotes.lane, `%${w}%`), like(spaceQuotes.podRaw, `%${w}%`),
      like(spaceQuotes.pol, `%${w}%`), like(spaceQuotes.container, `%${w}%`),
      like(spaceQuotes.vessel, `%${w}%`),
    ));
  }
  if (f.carrier) conds.push(like(spaceQuotes.carrier, `%${f.carrier}%`));
  if (f.container) conds.push(or(eq(spaceQuotes.container, f.container), like(spaceQuotes.container, `%${f.container}%`)));
  if (f.pol) conds.push(like(spaceQuotes.pol, `%${f.pol}%`));
  // 舱位是群内动态：只取最近 days 天（没时间戳的按"时效不可判"丢掉，免得把旧舱位说成现舱）
  const days = Math.max(1, f.days ?? 21);
  const from = new Date(Date.now() + 8 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10);
  conds.push(gte(spaceQuotes.msgTime, from));
  const rows = getDb().select({
    podRaw: spaceQuotes.podRaw, lane: spaceQuotes.lane, carrier: spaceQuotes.carrier, pol: spaceQuotes.pol,
    container: spaceQuotes.container, boxQty: spaceQuotes.boxQty, spaceType: spaceQuotes.spaceType,
    vessel: spaceQuotes.vessel, etd: spaceQuotes.etd, cutoffRaw: spaceQuotes.cutoffRaw,
    priceUsd: spaceQuotes.priceUsd, note: spaceQuotes.note, sender: spaceQuotes.sender,
    sourceGroup: spaceQuotes.sourceGroup, msgTime: spaceQuotes.msgTime, imageName: spaceQuotes.imageName,
  }).from(spaceQuotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(spaceQuotes.msgTime))
    .limit(Math.min(f.limit ?? 8, 30))
    .all();
  const base = REMOTE_BASE.replace(/\/$/, "");
  return okResult(rows.map(({ imageName, ...rest }) => ({
    ...rest,
    imageUrl: imageName ? `${base}/images/${encodeURIComponent(imageName)}` : null,
  })));
}

export function status(): Result<{
  total: number; active: number; spaceTotal: number; lastSyncAt: string | null; lastImported: number | null;
  remoteHost: string; lastError: string | null;
}> {
  const rows = getDb().select({ validTo: rateQuotes.validTo }).from(rateQuotes).all();
  const today = todayBeijing();
  let host = REMOTE_BASE;
  try { host = new URL(REMOTE_BASE).host; } catch { /* 保底原样 */ }
  return okResult({
    total: rows.length,
    active: rows.filter(r => !r.validTo || r.validTo >= today).length,
    spaceTotal: getDb().select({ n: sql<number>`count(*)` }).from(spaceQuotes).get()?.n ?? 0,
    lastSyncAt: lastSync?.at ?? null,
    lastImported: lastSync?.imported ?? null,
    remoteHost: host,
    lastError,
  });
}
