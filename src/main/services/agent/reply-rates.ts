// ── 回信自查台账价（工作台无匹配价时的兜底）──────────────────────────
// 为什么：generate_draft 回信模式此前只从会话工作台取「本轮/本会话已经查过的价」，取不到就在
// 返回里叫模型「先 quote_search 再重新调本工具」。弱模型（实测 agnes-2.5-flash）经常不照做，
// 于是询价信的回信只能走「报价稍后补」话术。用户的口径是：解析询价邮件时「直接起草回复」
// 基本就等于「直接报价」——程序自己得先把价查出来。这里补这一刀：工具内部直接查台账，
// 一轮就出带真价的草稿。
// 抽取层不重写：来信要素用 email-parse.parseEmailInquiry 的结果（柜型/港/LOCODE 已归一）。
// 原则对齐运价线：抽不到目的港就不查（宁可不报价，不可报错价）。
// 规范：docs/agent-draft-reply-spec.md §询价信回信

import { listQuotes, countQuotes, normalizeContainer, type QuoteDto } from "../rate-sync.service";
import { resolveQueryPod, podRawExpansion } from "../rates-standard";
import type { EmailInquiry, RateRow, RatesPayload } from "./email-parse";

/**
 * 镜像里的 pol 是中文群名（宁波/天津/蛇口/华南基本港…），来信写的是 NINGBO/CNNBG。
 * 映射成「可接受的 pol 集合」而不是单值：华南基本港这类群名覆盖深圳/蛇口/盐田/南沙。
 * 对不上返回 null —— 起运港不做硬过滤（硬过滤会把群名行整批漏掉），只用于分区排序。
 */
const POL_SETS: Array<{ keys: string[]; accept: string[] }> = [
  { keys: ["NINGBO", "CNNBG", "宁波"], accept: ["宁波"] },
  { keys: ["SHANGHAI", "CNSHA", "上海"], accept: ["上海"] },
  { keys: ["QINGDAO", "CNTAO", "青岛"], accept: ["青岛"] },
  { keys: ["TIANJIN", "CNTXG", "TSN", "XINGANG", "天津", "新港"], accept: ["天津", "新港"] },
  { keys: ["XIAMEN", "CNXMN", "厦门"], accept: ["厦门"] },
  { keys: ["DALIAN", "CNDLC", "大连"], accept: ["大连"] },
  { keys: ["LIANYUNGANG", "CNLYG", "连云港"], accept: ["连云港"] },
  // 华南：盐田/蛇口/深圳/南沙 与群名「华南基本港」互相都算对得上
  { keys: ["SHEKOU", "CNSHK", "YANTIAN", "CNYTN", "SHENZHEN", "CNSZX", "NANSHA", "CNNSA", "蛇口", "盐田", "深圳", "南沙"],
    accept: ["蛇口", "盐田", "深圳", "南沙", "华南基本港", "华南"] },
  { keys: ["GUANGZHOU", "CNGZG", "广州"], accept: ["广州", "南沙", "华南基本港", "华南"] },
];

export function mirrorPolSet(inq: Pick<EmailInquiry, "pol" | "polCode">): string[] | null {
  const probe = [inq.polCode, inq.pol].filter(Boolean).join(" ").toUpperCase();
  if (!probe.trim()) return null;
  for (const s of POL_SETS) {
    if (s.keys.some(k => probe.includes(k.toUpperCase()))) return s.accept;
  }
  return null;
}

/** 回信用运价行：在 email-parse 的 RateRow 上补两列客户报价表要用的字段（目免/船期）。
 *  可选 = 向后兼容：会话工作台里早先存的 payload 没有这两项，缺了就按 "/" 占位。 */
export interface ReplyRateRow extends RateRow {
  ft?: string | null;
  etd?: string | null;
}

function toRateRow(q: QuoteDto): ReplyRateRow {
  return {
    carrier: q.carrier, container: q.container, pol: q.pol, pod: q.podRaw,
    price: q.oceanUsd, validFrom: q.validFrom, validTo: q.validTo, note: q.note,
    ft: q.freeDays, etd: q.etd,
  };
}

export interface ReplyRates extends RatesPayload {
  /** 起运港对齐上了（至少一条命中来信起运港的镜像群名）；false = 报价须逐条写明起运港 */
  polAligned: boolean;
}

/** 目的港查询词：来信那一段往往是脏的（"Santos - BRSSZ"、"桑托斯 (BRSSZ, 圣保罗州)"），
 *  整串进 LIKE 必然零命中。先剥 LOCODE 与分隔符取港名主体，再走港口归一（别名→标准港名）。 */
export function podQueryWord(inq: Pick<EmailInquiry, "pod" | "podCode">): string | null {
  const raw = (inq.pod || "").trim();
  const code = (inq.podCode || "").trim().toUpperCase();
  if (!raw && !code) return null;
  const debracket = raw.replace(/[（(][^）)]*[）)]/g, " ");          // 去括号补充（州名/国名）
  const parts = debracket.split(/[-–—/,，;；|]/).map(s => s.trim())
    .filter(s => s && !/^[A-Z]{5}$/.test(s.toUpperCase()));          // 剔 LOCODE 段
  const name = (parts.join(" ") || debracket).trim();
  const word = (name || code).toUpperCase();
  if (!word) return null;
  return resolveQueryPod(word) || word;                              // 别名/LOCODE → 镜像标准港名
}

/**
 * 台账自查：复用 quote_search 同一套出口（港口归一 + podRaw 航线级展开 + 只取当期有效），
 * 不另写一套匹配逻辑。排序 = 起运港对得上的优先，其次价低在前。
 * 抽不到目的港 → 返回 null（不查、不猜）。
 */
export function lookupReplyRates(inq: EmailInquiry, limit = 12): ReplyRates | null {
  const pod = podQueryWord(inq);
  if (!pod) return null;
  const container = normalizeContainer(inq.container) ?? undefined;
  // 不用 terms（跨字段 AND 语义）：脏词一旦进 AND 就把整批结果掐死；pod + podRaw 展开已够
  const filters = { pod, podExtra: podRawExpansion(pod), container, includeExpired: false, limit };
  // 附带查询不得打挂起草：老库缺表/列变更等异常一律按「没查到价」处理（回信仍可成稿，只是不报价）
  let r: ReturnType<typeof listQuotes>;
  try { r = listQuotes(filters); } catch { return null; }
  if (!r.success) return null;
  const accept = mirrorPolSet(inq);
  const rank = (q: QuoteDto) => (accept && q.pol && accept.some(a => q.pol!.includes(a)) ? 0 : 1);
  const rows = [...r.data].sort((a, b) =>
    rank(a) - rank(b) || (a.oceanUsd ?? Number.MAX_SAFE_INTEGER) - (b.oceanUsd ?? Number.MAX_SAFE_INTEGER));
  return {
    pod,
    lane: rows[0]?.lane ?? null,
    container: container ?? null,
    total: countQuotes(filters),
    rows: rows.map(toRateRow),
    polAligned: !!accept && rows.some(q => rank(q) === 0),
  };
}

// ── 客户报价表（英文十一列，列与占位锁死）────────────────────────────
// 规范 docs/rates-query-spec.md §4 + docs/agent-draft-reply-spec.md §客户报价表接缝：
// CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK；POL、POD 唯一且全大写，
// 缺项一律 "/"，TT 恒 "/"（台账没有航程数据，不猜），内部溯源（来源群/发送人/入库时间）不进客户表。

/** 船司 → 国际标准缩写。台账里多是群内简称，长名/别名统一收敛；认不出就原样大写，
 *  「未注明/未知/N/A/-」不是船司名 → "/"（客户表里不留假名）。 */
const CARRIER_STD: Record<string, string> = {
  "CMA CGM": "CMA", "CMACGM": "CMA", "达飞": "CMA",
  "MAERSK": "MSK", "MSK": "MSK", "马士基": "MSK",
  "EVERGREEN": "EMC", "长荣": "EMC", "EMC": "EMC",
  "HAPAG-LLOYD": "HPL", "赫伯罗特": "HPL",
  "YANG MING": "YML", "阳明": "YML",
  "WAN HAI": "WHL", "万海": "WHL",
  "OCEAN NETWORK EXPRESS": "ONE", "ZIM": "ZIM", "HMM": "HMM", "MSC": "MSC",
  "COSCO": "COSCO", "中远": "COSCO", "OOCL": "OOCL", "PIL": "PIL", "太平": "PIL",
  "TS LINES": "TSL", "德翔": "TSL", "SM LINE": "SKSM", "IRISL": "IRISL", "TURKON": "TURKON",
  "SEABOARD": "SBS", "KINGSTON": "KSC", "GFS": "GFS", "SITC": "SITC", "CNC": "CNC",
  "NYK": "NYK", "MOL": "MOL", "K LINE": "KLN", "HPL": "HPL",
};
const CARRIER_BLANK = ["未注明", "未知", "N/A", "NA", "-", "—", ""];

export function stdCarrier(raw: string | null | undefined): string {
  const s = (raw || "").trim();
  if (!s || CARRIER_BLANK.includes(s.toUpperCase())) return "/";
  const up = s.toUpperCase();
  return CARRIER_STD[up] ?? CARRIER_STD[s] ?? up.replace(/\s+/g, " ");
}

/** 镜像 pol 是中文群名 → 客户表要英文大写港名。认不出的一律 "/"，不音译不猜。 */
const POL_EN: Record<string, string> = {
  宁波: "NINGBO", 上海: "SHANGHAI", 青岛: "QINGDAO", 天津: "TIANJIN", 新港: "TIANJIN XINGANG",
  厦门: "XIAMEN", 大连: "DALIAN", 连云港: "LIANYUNGANG", 深圳: "SHENZHEN", 蛇口: "SHEKOU",
  盐田: "YANTIAN", 南沙: "NANSHA", 广州: "GUANGZHOU", 福州: "FUZHOU", 汕头: "SHANTOU",
  中山: "ZHONGSHAN", 珠海: "ZHUHAI", 华南基本港: "CHINA BASE PORTS", 华东基本港: "CHINA EAST BASE PORTS",
  华北基本港: "CHINA NORTH BASE PORTS", 基本港: "CHINA BASE PORTS",
};
export function stdPol(raw: string | null | undefined, inq?: Pick<EmailInquiry, "pol" | "polCode">): string {
  const s = (raw || "").trim();
  if (!s) return "/";
  // 该行起运港与来信要求的起运港对得上 → 用来信的英文写法（客户看的就是自己问的那个港）
  const accept = inq ? mirrorPolSet(inq) : null;
  if (accept?.some(a => s.includes(a)) && inq?.polCode) return inq.polCode.toUpperCase();
  return POL_EN[s] ?? (/^[A-Za-z0-9 ,'-]+$/.test(s) ? s.toUpperCase() : "/");
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-08" → {d:8,m:9}；"9.8"/"9/8" 也认（中文写法月在前）。认不出返回 null（不猜） */
function dayOf(raw: string | null | undefined): { d: number; m: number } | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return { d: Number(iso[3]), m: Number(iso[2]) };
  const md = /(?:^|[^\d.])(\d{1,2})\s*[./]\s*(\d{1,2})(?!\d)/.exec(s);
  if (md) {
    const a = Number(md[1]); const b = Number(md[2]);
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return { d: b, m: a };
  }
  return null;
}
/** 有效期：同月 "8-14 Sep"，跨月 "28 Aug-3 Sep"，只有一端就给单个日期，都没有 "/" */
export function fmtValidityEn(from: string | null | undefined, to: string | null | undefined): string {
  const a = dayOf(from); const b = dayOf(to);
  if (!a && !b) return "/";
  if (a && b) {
    if (a.m === b.m) return `${a.d}-${b.d} ${MON[a.m - 1]}`;
    return `${a.d} ${MON[a.m - 1]}-${b.d} ${MON[b.m - 1]}`;
  }
  const x = (a ?? b)!;
  return `${x.d} ${MON[x.m - 1]}`;
}
/** 船期：单日 "12 Sep"；认不出 "/"（源端常是「EVER FIT 027W，9.6晚开」这类自由文本，不猜） */
export function fmtEtdEn(raw: string | null | undefined): string {
  const d = dayOf(raw);
  return d ? `${d.d} ${MON[d.m - 1]}` : "/";
}
/** 目免：台账是「21天」「21 combined」这类文本，只取天数，取不到 "/" */
export function fmtFtEn(raw: string | null | undefined): string {
  const s = (raw || "").trim();
  if (!s) return "/";
  const m = /(\d{1,3})/.exec(s);
  return m ? m[1]! : "/";
}

const CONTAINER_COL: Array<{ key: "p20" | "p40" | "pNor"; test: (c: string | null) => boolean }> = [
  { key: "p20", test: c => /^20/.test(c ?? "") },
  { key: "p40", test: c => /^40(HQ|HC|GP)?$/.test((c ?? "").toUpperCase()) || /^40\s*'?\s*(HQ|HC)$/.test(c ?? "") },
  { key: "pNor", test: c => /NOR/i.test(c ?? "") },
];

/** 备注：只留客户看得懂的（附加费/免费期/直转航），内部溯源与联系方式剔掉；空 → "/" */
function remarkFor(raw: string | null | undefined): string {
  const s = (raw || "").trim();
  if (!s) return "/";
  const cleaned = s
    .replace(/1[3-9]\d{9}/g, "")                      // 手机号
    .replace(/\d{2,3}-?\d{7,8}/g, "")                  // 座机
    .replace(/\s{2,}/g, " ")
    .trim();
  return (cleaned || "/").slice(0, 60);
}

/**
 * 客户报价表：按（船司 + 起运港）透视成一行三柜型价，POD 用查询归一后的标准港名
 * （航线级行也展开到该港，多港粘连一律只留目标港）。行序沿用 lookupReplyRates 的排序
 * （起运港对齐的在前、其次价升序）。
 */
export function customerQuoteTable(rows: ReplyRateRow[] | RateRow[], pod: string | null, inq?: EmailInquiry, max = 20): string {
  if (!rows.length) return "";
  const podCell = (pod || "").trim().toUpperCase() || "/";
  const groups = new Map<string, { carrier: string; pol: string; p20: number | null; p40: number | null; pNor: number | null; ft: string; etd: string; from: string | null; to: string | null; note: string }>();
  for (const r of rows) {
    const carrier = stdCarrier(r.carrier);
    const pol = stdPol(r.pol, inq);
    const key = `${carrier}|${pol}`;
    let g = groups.get(key);
    if (!g) {
      g = { carrier, pol, p20: null, p40: null, pNor: null, ft: "/", etd: "/", from: null, to: null, note: "/" };
      groups.set(key, g);
    }
    const col = CONTAINER_COL.find(c => c.test(r.container));
    const price = typeof r.price === "number" ? r.price : null;
    if (col && price != null && g[col.key] == null) g[col.key] = price;
    const ft = fmtFtEn((r as ReplyRateRow).ft);
    if (ft !== "/" && g.ft === "/") g.ft = ft;
    const etd = fmtEtdEn((r as ReplyRateRow).etd);
    if (etd !== "/" && g.etd === "/") g.etd = etd;
    if (!g.from && r.validFrom) g.from = r.validFrom;
    if (!g.to && r.validTo) g.to = r.validTo;
    if (g.note === "/") {
      const rm = remarkFor(r.note);
      if (rm !== "/") g.note = rm;
    }
  }
  const usd = (n: number | null) => (n != null ? String(n) : "/");
  const head = [
    "| CARRIER | POL | POD | 20GP | 40HQ/HC | 40NOR | FT | ETD | VALIDITY | TT | REMARK |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const body = [...groups.values()].slice(0, max).map(g =>
    `| ${g.carrier} | ${g.pol} | ${podCell} | ${usd(g.p20)} | ${usd(g.p40)} | ${usd(g.pNor)} `
    + `| ${g.ft} | ${g.etd} | ${fmtValidityEn(g.from, g.to)} | / | ${g.note} |`);
  return [...head, ...body].join("\n");
}
