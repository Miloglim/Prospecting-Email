// ── 通用联网调研底座 ──────────────────────────────────────────────
// 把「多源检索 → 页面核实 → 交叉核对分级 → 固定结构成稿」这套方法论写进代码，
// 不交给模型串：实测弱模型自己串多步调研时只走第一步、撞预算中断、还会凭记忆补数字。
// 场景（scene）只是这条管线上的一组参数，航线运价/船期是第一个场景；以后加
// 「港口拥堵」「新航线公告」「政策」这类调研，只加一个 SceneDef，不改管线。
//
// 方法论里的硬规则逐条落成代码，不靠提示词自觉：
//  1) 每条数据必须带来源链接 + 发布/更新日期，缺一项就在可信度上降级；
//  2) 搜索摘要只是线索 —— 没抓到页面正文的数字不得进结论，只进「需注意」清单；
//  3) 结论里的每个数字都要能回溯到被抓到的证据，回溯不过的整条剔除（不许用模型自身知识补写）；
//  4) 抓取失败不硬抓：同一 URL 只试一次，失败即计入覆盖缺口；
//  5) 不同口径（柜型、是否含附加费）不得直接比大小 —— 口径单独成列，不合并。
import { netFetch } from "../net-proxy";
import { searchWeb, chatJson, hasSearchSource, type SearchHit } from "./ai.service";
import { writeArtifact, type ArtifactMeta } from "./artifact.service";
import { okResult, failResult, type Result } from "../errors";

// ── 场景定义 ──────────────────────────────────────────────────────

export interface LaneInput {
  pol: string;              // 起运港（原样，用户怎么写就怎么传）
  pod: string;              // 目的港
  scope?: "rates" | "schedules" | "both";
  container?: string;       // 20GP / 40GP / 40HQ，留空 = 不限
  weeks?: number;           // 「近期」窗口，默认 4 周
}

export interface ResolvedPorts { polCn: string; polEn: string; podCn: string; podEn: string }

export interface Evidence {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  text?: string;            // 抓到的正文 = 已核实
  fetched: boolean;
  fetchError?: string;
  publishedRaw?: string;    // 页面里识别到的日期原文
  publishedAt?: string;     // 能解析出来时的 ISO
  tier: number;             // 来源优先级 1..5（越小越权威）
  amounts: number[];        // 证据里出现的运费金额（规范化后）
}

export type Credibility = "verified" | "single-source" | "stale" | "unverified";

export const CRED_LABEL: Record<Credibility, string> = {
  verified: "已核实", "single-source": "孤证", stale: "可能过期", unverified: "未核实",
};

export interface RateRow {
  source: string; value: string; scope: string; published: string;
  credibility: Credibility; url: string;
}
export interface ScheduleRow {
  source: string; info: string; published: string; credibility: Credibility; url: string;
}
export interface Conclusion { text: string; refs: number[] }

export interface ResearchOutput {
  route: string;
  window: string;
  conclusions: Conclusion[];
  dropped: string[];        // 因数字无法回溯被剔除的结论原文（进「需注意」）
  rates: RateRow[];
  schedules: ScheduleRow[];
  gaps: string[];
  report: string;
  evidenceCount: { hits: number; fetched: number };
}

// ── 纯函数（可单测）───────────────────────────────────────────────

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return String(url || "").toLowerCase(); }
}

/** 来源优先级（方法论第 5 节，按域名归类）：1 船司官方 2 聚合平台 3 指数机构 4 行业媒体 5 其它（营销页/博客） */
const TIER1 = ["maersk.com", "msc.com", "cma-cgm.com", "coscocesl.com", "one-line.com", "hmm21.com", "evergreen-line.com", "yangming.com", "zim.com", "hapag-lloyd.com", "sm-line.com", "wanhai.com", "sitc.com"];
const TIER2 = ["cogoport.com", "searates.com", "freightos.com", "xeneta.com", "vectonbinding", "container-news.com", "jctrans.com", "sino-shipping.com", "by56.com"];
const TIER3 = ["en.sse.net.cn", "sse.net.cn", "drewry.co.uk", "freightos.com/ebao", "ccindex", "scfi"];
const TIER4 = ["container-magagement.com", "container-management.com", "datamar.com", "theloadstar.co.uk", "theloadstar.com", "lloydslist.com", "journalofcommerce", "americanshipper"];

export function sourceTier(url: string): number {
  const d = domainOf(url);
  const has = (list: string[]) => list.some(k => d.includes(k));
  if (has(TIER1)) return 1;
  if (has(TIER3)) return 3;          // 指数机构域名也在聚合平台里，先判更特殊的
  if (has(TIER2)) return 2;
  if (has(TIER4)) return 4;
  return 5;
}

/** 页面/摘要里的发布日期：JSON-LD、"Updated: ..."、"2026年8月30日"、"30 Aug 2026"、"2026-08-30" */
const DATE_RES: RegExp[] = [
  /"datePublished"\s*:\s*"?(\d{4}-\d{2}-\d{2})/i,
  /(?:updated|published|发布日期|更新时间)\D{0,4}(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)/i,
  /(\d{4}-\d{2}-\d{2})/,
  /(\d{4}年\d{1,2}月(?:\d{1,2}日)?)/,
  /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/i,
  /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i,
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function extractPublished(text: string): { raw?: string; iso?: string } {
  const s = String(text || "");
  for (const re of DATE_RES) {
    const m = s.match(re);
    if (!m?.[1]) continue;
    const raw = m[1].trim();
    return { raw, iso: toIso(raw) };
  }
  return {};
}

function toIso(raw: string): string | undefined {
  // 年/月/日与斜杠全部换成连字符（不是只换第一处）：中文写法归一后是 "2026-8-28"，
  // 这种单位数月 Date.parse 直接返回 NaN，所以纯日期一律零补齐后原样返回，不进解析。
  const norm = raw.trim().replace(/年/g, "-").replace(/月/g, "-").replace(/日/g, "").replace(/\//g, "-");
  const ymd = norm.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]!.padStart(2, "0")}-${ymd[3]!.padStart(2, "0")}`;
  const t = Date.parse(norm);
  if (!Number.isNaN(t)) {
    // 取本地历法日：Date.parse 对 "30 Aug 2026" 按本地零点解析，
    // 用 toISOString 会在 +8 时区倒退一天，页面写的日期就错了
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // Date.parse 不认的英文月名两种语序：30 Aug 2026 / Aug 30, 2026
  const m = norm.match(/(\d{1,2})?\s*([a-z]{3})[a-z]*\.?,?\s*(\d{1,2})?,?\s*(\d{4})/i);
  if (m) {
    const mi = MONTHS.findIndex(x => m[2]!.toLowerCase().startsWith(x));
    const day = Number(m[1] || m[3] || 1);
    if (mi >= 0) {
      const d = new Date(Date.UTC(Number(m[4]), mi, day));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

export function ageDaysOf(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((now - t) / 86_400_000);
}

/**
 * 运费金额抽取：只认「像运价」的数 —— $3,200 / 3200 USD / 运价 3200 / 裸四位数。
 * 排除年份（1900-2100）与柜型（20GP/40HQ 里的 20/40），否则 2026 会被当成运价。
 * 只收美元口径：人民币金额（元）不参与，混进同一列会造成口径错误。
 */
export function extractAmounts(text: string): number[] {
  const s = String(text || "")
    .replace(/\b\d{2}\s?(?:gp|hq|hc|ot|fr|rh)\b/gi, " ")      // 柜型
    .replace(/[\d,]{3,}\s*(?:元|人民币|rmb|cny)/gi, " ")       // 人民币金额：整段抹掉，避免混进美元列
    .replace(/\b\d{4}[-/]\d{1,2}([-/]\d{1,2})?\b/g, " ");     // 日期
  const out = new Set<number>();
  const push = (n: number) => {
    if (Number.isFinite(n) && n >= 100 && n <= 30_000 && !(n >= 1900 && n <= 2100)) out.add(Math.round(n));
  };
  const RES = [
    /(?:usd|\$)\s?([\d,]{3,7})/gi,
    /([\d,]{3,7})\s?(?:usd|\$|\/\s?per\b|\/柜)/gi,
    /(?:运价|费率|海运费|freight|rate|ocean)[:：\s]*([\d,]{3,7})/gi,
  ];
  for (const re of RES) {
    for (const m of s.matchAll(re)) push(Number(String(m[1] ?? "").replace(/,/g, "")));
  }
  // 中文页面常不带币种直接写「桑托斯 3200」，四位数是运价最常见量级（1xxx 也要：20GP 常在 1500–1900）
  for (const m of s.matchAll(/\b([1-9]\d{3})\b/g)) push(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/** 可信度分级（代码判定，不让模型自封「已核实」） */
export function gradeEvidence(ev: Evidence, freshnessDays: number): Credibility {
  const age = ageDaysOf(ev.publishedAt);
  if (!ev.fetched) return "unverified";                    // 只有摘要 = 线索，不算数
  if (age === undefined) return "stale";                   // 抓到了但认不出日期 → 可能过期
  if (age > freshnessDays) return "stale";
  if (ev.tier <= 2) return "verified";                    // 一手权威来源
  return "single-source";
}

/** 交叉核对：同一金额出现在 ≥2 个不同域名下 → 孤证升为已核实 */
export function crossCheck(rows: Array<{ credibility: Credibility; url: string; amounts: number[] }>): void {
  const byAmount = new Map<number, Set<string>>();
  for (const r of rows) {
    if (r.credibility === "unverified") continue;
    for (const a of r.amounts) {
      if (!byAmount.has(a)) byAmount.set(a, new Set());
      byAmount.get(a)!.add(domainOf(r.url));
    }
  }
  for (const r of rows) {
    const agree = r.amounts.some(a => (byAmount.get(a)?.size ?? 0) >= 2);
    if (agree && r.credibility === "single-source") r.credibility = "verified";
  }
}

/** 结论里的数字能不能回溯到引用的证据；返回回溯不过的数字（有则整条剔除） */
export function unverifiableNumbers(text: string, evidenceTexts: string[]): string[] {
  const pool = new Set<number>();
  for (const t of evidenceTexts) for (const n of t.matchAll(/\d[\d,.]*/g)) {
    const v = Number(n[0].replace(/,/g, ""));
    if (Number.isFinite(v)) { pool.add(Math.round(v)); pool.add(v); }
  }
  const bad: string[] = [];
  for (const m of String(text || "").matchAll(/\d[\d,]*/g)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    // 100 以下（柜数、天数、百分比）与 1900-2100（年份）不作为运价核
    if (v < 100 || (v >= 1900 && v <= 2100)) continue;
    if (!pool.has(Math.round(v))) bad.push(m[0]);
  }
  return bad;
}

/** 检索词模板（方法论 Step 1）：中英文并行，替换成明确日期区间 */
export function laneQueries(p: ResolvedPorts, opts: { container?: string; weeks: number; today: Date }): string[] {
  const d = opts.today;
  const monthEn = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const y = d.getFullYear();
  const c = opts.container ? ` ${opts.container}` : "";
  const set: string[] = [];
  set.push(`${p.polCn}到${p.podCn} 海运费 运价${c} ${y}`);
  set.push(`${p.polEn} to ${p.podEn} freight rate ${monthEn} container`);
  set.push(`${p.polEn} ${p.podEn} spot rate index ${y}`);
  set.push(`${p.polCn}到${p.podCn} 船期 直航 ${y}年${d.getMonth() + 1}月 开船`);
  set.push(`${p.polEn} to ${p.podEn} sailing schedule ${monthEn} transit time`);
  set.push(`new service ${p.podEn} ${y} carrier weekly`);
  return set;
}

/** 成稿（方法论 Step 4 的固定五段结构 + 结尾时效提醒） */
export function composeReport(o: {
  route: string; window: string; container?: string; scope: string;
  conclusions: Conclusion[]; rates: RateRow[]; schedules: ScheduleRow[];
  gaps: string[]; dropped: string[]; mirror: string | null; at: Date;
}): string {
  const L: string[] = [];
  L.push(`# 航线市场调研：${o.route}`);
  L.push("");
  L.push(`- 调研范围：${o.scope}　|　柜型：${o.container || "不限"}　|　时间窗：${o.window}`);
  L.push(`- 生成时间：${bj(o.at)}　|　方法：多源检索 → 页面核实 → 交叉核对分级（未抓到的页面一律标「未核实」）`);
  L.push("");
  L.push("## 1. 关键结论");
  L.push("");
  if (!o.conclusions.length) L.push("- 本轮没有可通过核实的结论（见第 4 节缺口清单）——不编数字。");
  o.conclusions.forEach((c, i) => {
    L.push(`${i + 1}. ${c.text}${c.refs.length ? ` （来源 ${c.refs.join("、")}）` : ""}`);
  });
  L.push("");
  L.push("## 2. 运价来源明细");
  L.push("");
  L.push("| 来源 | 数据 | 口径 | 发布/更新 | 可信度 | 链接 |");
  L.push("|---|---|---|---|---|---|");
  if (!o.rates.length) L.push("| — | 本轮未取得可核实的运价 | — | — | 未核实 | — |");
  for (const r of o.rates) {
    L.push(`| ${esc(r.source)} | ${esc(r.value)} | ${esc(r.scope)} | ${esc(r.published)} | ${CRED_LABEL[r.credibility]} | ${r.url} |`);
  }
  L.push("");
  L.push("## 3. 船期来源明细");
  L.push("");
  L.push("| 来源 | 船期信息 | 发布/更新 | 可信度 | 链接 |");
  L.push("|---|---|---|---|---|");
  if (!o.schedules.length) L.push("| — | 本轮未取得船期信息 | — | 未核实 | — |");
  for (const s of o.schedules) L.push(`| ${esc(s.source)} | ${esc(s.info)} | ${esc(s.published)} | ${CRED_LABEL[s.credibility]} | ${s.url} |`);
  L.push("");
  L.push("## 4. 无法核实 / 需注意");
  L.push("");
  const notes = [...o.gaps, ...o.dropped.map(t => `结论因数字无法回溯到来源被剔除：${t}`)];
  if (!notes.length) L.push("- 无");
  for (const g of notes) L.push(`- ${g}`);
  L.push("");
  L.push("## 5. 建议下一步");
  L.push("");
  if (o.mirror) L.push(`- **对照本地运价镜像**：${o.mirror}`);
  L.push("- 即期运价以天计变化，本报告的数字只在标注日期内有效；对外报价请以船司实时运价为准。");
  L.push("- 不同口径（柜型、是否含附加费/DDP）不要直接比大小。");
  L.push("");
  return L.join("\n");
}

const esc = (s: string) => String(s ?? "").replace(/\|/g, "／").replace(/\n/g, " ").slice(0, 160);

function bj(at: Date): string {
  const d = new Date(at.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}（北京）`;
}

// ── IO 环节 ───────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const PAGE_CHARS = 3000;
const FETCH_MAX = 5;          // 一轮最多抓 5 页：再多就是自找超时
const FETCH_TIMEOUT = 12_000;

function stripHtml(html: string): string {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, PAGE_CHARS);
}

/** 抓一页正文；失败即返回错误（同一 URL 不重试，降级为线索） */
export async function fetchPage(url: string): Promise<Result<string>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await netFetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" } });
    if (!res.ok) return failResult(`HTTP ${res.status}`);
    const html = await res.text();
    const text = stripHtml(html);
    if (text.length < 80) return failResult("页面正文过短（可能是动态渲染或反爬）");
    return okResult(text);
  } catch (err) {
    return failResult(err instanceof Error ? err.message.slice(0, 80) : "抓取失败");
  } finally { clearTimeout(timer); }
}

/** 端口名规范化（中英文/UNLOCODE 之间互相补齐）；端点没配或失败时退回原样切分 */
async function resolvePorts(pol: string, pod: string): Promise<ResolvedPorts> {
  const fb = (): ResolvedPorts => ({ polCn: pol, polEn: pol, podCn: pod, podEn: pod });
  const r = await chatJson<Partial<ResolvedPorts>>(
    "你是货代行业港口知识助手。把用户给的港口名补成中英两种写法，只输出 JSON，不要解释。不知道英文写法就把英文字段填成给定原名。",
    `起运港：${pol}\n目的港：${pod}\n\n输出：{"polCn":"","polEn":"","podCn":"","podEn":""}`,
  );
  if (!r.success || !r.data?.polEn || !r.data?.podEn) return fb();
  const d = r.data;
  return {
    polCn: (d.polCn || pol).slice(0, 40), polEn: (d.polEn || pol).slice(0, 40),
    podCn: (d.podCn || pod).slice(0, 40), podEn: (d.podEn || pod).slice(0, 40),
  };
}

/** 从正文里摘一条最像「运价」的句子（含金额的那一行），作为表格里的「数据」列 */
function rateSentence(text: string): { value: string; scope: string } {
  const lines = String(text || "").split(/\n|[。；;]/).map(s => s.trim()).filter(Boolean);
  const hit = lines.find(l => /usd|\$|运价|费率|海运费|freight|rate/i.test(l) && /\d{3,}/.test(l)) || lines[0] || "";
  const amounts = extractAmounts(hit);
  const cont = hit.match(/\b(20GP|40GP|40HQ|40HC|40OT)\b/i)?.[1];
  const ddp = /ddp/i.test(hit) ? "含 DDP" : /all-?in/i.test(hit) ? "全包价" : "口径未注明";
  return {
    value: amounts.length ? `${amounts.slice(0, 3).join(" / ")} USD` : hit.slice(0, 60),
    scope: [cont ? cont.toUpperCase() : "柜型未注明", ddp].join("，"),
  };
}

function scheduleSentence(text: string): string {
  const lines = String(text || "").split(/\n|[。；;]/).map(s => s.trim()).filter(Boolean);
  const hit = lines.find(l => /transit|days|ETD|ETA|sail|week|航次|船期|直航|中转|天/i.test(l)) || lines[0] || "";
  return hit.slice(0, 80);
}

/**
 * 跑一个调研场景（目前只有 ocean-lane）。
 * 不做的事：不写业务库、不发送任何东西、不改运价镜像 —— 产出只是报告文件 + 结构化摘要。
 */
export async function runResearchScene(
  input: LaneInput,
  deps: { mirrorCompare?: (podEn: string, podCn: string) => string | null } = {},
): Promise<Result<{ out: ResearchOutput; artifact: ArtifactMeta }>> {
  const pol = String(input.pol || "").trim();
  const pod = String(input.pod || "").trim();
  if (!pol || !pod) return failResult("缺少起运港或目的港：这两项必须由用户提供，其余可用默认值");
  // 前置检查：没配检索源就立刻指路，别先花一次 LLM 调用、再把 6 条查询全发出去空跑
  if (!hasSearchSource()) {
    return failResult("未配置联网检索源：请到「设置 → 模型与端点 → 搜索源」填入 Exa 或 Tavily 任一密钥后重试（本能力只读公开网页，不发送任何邮件）");
  }
  const scope: NonNullable<LaneInput["scope"]> = input.scope ?? "both";
  const weeks = Math.min(Math.max(input.weeks && input.weeks > 0 ? input.weeks : 4, 1), 12);
  const freshnessDays = weeks * 7;
  const today = new Date();

  const ports = await resolvePorts(pol, pod);
  const queries = laneQueries(ports, { container: input.container, weeks, today });
  const wantRates = scope !== "schedules";
  const wantSched = scope !== "rates";
  const queriesUsed = queries.filter(q => (wantRates && /freight|rate|海运费|运价|spot/.test(q)) || (wantSched && /schedule|船期|service|sailing|transit/.test(q)));

  // Step 1 多源检索：并行发查询，摘要只是线索
  const searched = await Promise.all(queriesUsed.map(q => searchWeb(q, { numResults: 6, textChars: 1200 })));
  const usable = searched.flatMap(s => (s.success && s.data.length ? [s.data] : []));
  if (!usable.length) {
    const failed = searched.find(s => !s.success);
    const why = failed && !failed.success ? failed.error : "搜索源无结果";
    return failResult(`联网调研失败：${why}（检查「设置 → 搜索源」里 Exa / Tavily 的密钥是否已配置）`);
  }
  const seen = new Set<string>();
  const evs: Evidence[] = [];
  for (const hits of usable) {
    for (const h of hits) {
      const key = domainOf(h.url) + "|" + String(h.title || "").toLowerCase().slice(0, 40);
      if (!h.url || seen.has(key)) continue;
      seen.add(key);
      evs.push({
        url: h.url, domain: domainOf(h.url), title: h.title || domainOf(h.url),
        snippet: String(h.snippet || "").slice(0, 1200), fetched: false,
        tier: sourceTier(h.url), amounts: [],
      });
    }
  }
  // 权威来源优先抓取，其余留作线索
  const pick = [...evs].sort((a, b) => a.tier - b.tier).slice(0, FETCH_MAX);
  await Promise.all(pick.map(async ev => {
    const r = await fetchPage(ev.url);
    if (r.success) {
      ev.fetched = true; ev.text = r.data;
      const pub = extractPublished(r.data.slice(0, 1200) + "\n" + ev.snippet);
      ev.publishedRaw = pub.raw; ev.publishedAt = pub.iso;
      ev.amounts = extractAmounts(r.data);
    } else ev.fetchError = r.error;
  }));
  for (const ev of evs) if (!ev.fetched) {
    const pub = extractPublished(ev.snippet);
    ev.publishedRaw = pub.raw; ev.publishedAt = pub.iso;
  }

  // Step 3 交叉核对与分级
  const rows: Array<RateRow & { credibility: Credibility; amounts: number[]; url: string; ev: Evidence }> = evs.map(ev => {
    const cred = gradeEvidence(ev, freshnessDays);
    const { value, scope: sc } = ev.fetched ? rateSentence(ev.text || "") : rateSentence(ev.snippet);
    return {
      source: `${ev.title}（${ev.domain}，优先级 ${ev.tier}）`, value, scope: sc,
      published: ev.publishedRaw || "未标注", credibility: cred, url: ev.url,
      amounts: ev.fetched ? ev.amounts : extractAmounts(ev.snippet), ev,
    };
  });
  crossCheck(rows);
  const verified = rows.filter(r => r.credibility !== "unverified");
  const unverified = rows.filter(r => r.credibility === "unverified");

  const schedules: ScheduleRow[] = wantSched
    ? verified.slice(0, 6).map(r => ({
      source: r.source, info: r.ev.fetched ? scheduleSentence(r.ev.text || "") : scheduleSentence(r.ev.snippet),
      published: r.published, credibility: r.credibility, url: r.url,
    }))
    : [];

  // Step 2/4 成稿：结论交给模型归纳，但数字必须能回溯，回溯不过的整条剔除
  const evidenceBlock = verified.map((r, i) =>
    `[${i + 1}] ${r.source}\n日期：${r.published}\n正文摘录：${(r.ev.text || r.ev.snippet).slice(0, 900)}`).join("\n\n");
  const judged = await chatJson<{ conclusions?: Array<{ text?: string; refs?: number[] }> }>(
    "你是货代市场分析师。只依据给定资料归纳结论，禁止使用资料外的知识或数字；每条结论必须注明引用的资料编号。只输出 JSON。",
    `航线：${ports.polCn}/${ports.polEn} → ${ports.podCn}/${ports.podEn}　柜型：${input.container || "不限"}　时间窗：近 ${weeks} 周\n\n资料：\n${evidenceBlock || "（无可核实资料）"}\n\n输出：{"conclusions":[{"text":"一句话结论","refs":[1,2]}]}`,
  );
  const conclusions: Conclusion[] = [];
  const dropped: string[] = [];
  for (const c of judged.success ? judged.data.conclusions ?? [] : []) {
    const text = String(c?.text || "").trim().slice(0, 200);
    if (!text) continue;
    const refs = (Array.isArray(c?.refs) ? (c.refs as unknown[]) : []).map(v => Number(v)).filter(n => Number.isInteger(n) && n >= 1 && n <= verified.length);
    if (!refs.length) { dropped.push(text + "（未标注来源）"); continue; }
    const texts = refs.map(n => (verified[n - 1]!.ev.text || verified[n - 1]!.ev.snippet));
    const bad = unverifiableNumbers(text, texts);
    if (bad.length) { dropped.push(`${text}（数字 ${bad.join("、")} 在引用资料里找不到）`); continue; }
    conclusions.push({ text, refs });
  }

  const gaps = [
    ...unverified.slice(0, 6).map(r => `未核实（只拿到搜索摘要，页面没抓到）：${r.source} — ${r.value}`),
    ...evs.filter(e => e.fetchError).slice(0, 4).map(e => `抓取失败：${e.domain} — ${e.fetchError}（船司班期页普遍反爬，已降级为线索）`),
    ...(verified.length ? [] : ["本轮没有任何一条资料通过页面核实，不给数字结论"]),
    `权威指数覆盖情况未确认时（SCFI/CCFI/Drewry/FBX 是否含该航线），本报告不代其发声`,
  ];

  const route = `${ports.polEn} → ${ports.podEn}`;
  const window = `近 ${weeks} 周`;
  const mirror = deps.mirrorCompare ? deps.mirrorCompare(ports.podEn, ports.podCn) : null;
  const report = composeReport({
    route, window, container: input.container, scope: scope === "both" ? "运价 + 船期" : scope === "rates" ? "运价" : "船期",
    conclusions: conclusions.slice(0, 5), rates: verified.slice(0, 10), schedules, gaps, dropped, mirror, at: today,
  });
  const w = writeArtifact(`航线调研 ${route}`, "md", report);
  if (!w.success) return failResult(w.error);

  return okResult({
    out: {
      route, window,
      conclusions: conclusions.slice(0, 5), dropped,
      rates: verified.slice(0, 10), schedules, gaps, report,
      evidenceCount: { hits: evs.length, fetched: pick.filter(e => e.fetched).length },
    },
    artifact: w.data,
  });
}
