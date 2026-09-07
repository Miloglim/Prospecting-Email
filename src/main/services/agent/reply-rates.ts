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
  const r = listQuotes(filters);
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
