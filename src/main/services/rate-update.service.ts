// ── 定向运价更新推送（跟进看板客户 × 港口偏好 → 分组方案 → 入队）────────────
// 规范：docs/rate-update-push-spec.md
// 职责边界：本文件只做「聚合 → 选价 → 成文 → 入队」这一段。
//   · 港口偏好来自 customer-ports（读时派生，本文件不写库）；
//   · 价格一律走 reply-rates.lookupReplyRates + customerCleanQuotes（与回信报价同一出口，不另写匹配）；
//   · 入队一律走 buildDynamicQueue → startQueue(autoStart=false)：账号轮换/公司交错/时窗/日配额全部继承，
//     红线「AI 永不触发群发开始」在这里的物理体现就是 autoStart 恒为 false。
// 文案是常量：正文价格与表格全部机械拼装，模型不参与生成（预览所见=发出所得）。
import crypto from "crypto";
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { inArray, sql as dsql } from "drizzle-orm";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { normalizeLang, buildDynamicQueue, startQueue, getQueueItems, getSendStatus, type SendItem, type EnqueueResult } from "./send.service";
import type { Lang } from "./sentence-library";
import { deriveCustomerPorts, normalizePodName, plausiblePortToken, type CustomerPorts, type PortPref, type PortSource } from "./customer-ports";
import { lookupReplyRates, customerCleanQuotes, type ReplyRates } from "./agent/reply-rates";
import type { EmailInquiry } from "./agent/email-parse";
import { customerQuoteHtml, customerQuoteRows, cleanPod, type CleanQuote } from "./rates-clean";
import { listQuotes } from "./rate-sync.service";
import { STAGES } from "./crm.service";
import { ratesDiff, parseFlexDate, type RatesDiff } from "./rate-sync.service";
import { podToken } from "./suggestion.service";
// 国家别名表已下沉 country-alias.ts（本文件内部仍用；对外经下方 `export ... from` 原样转出口）
import { COUNTRY_ALIAS, countryMatchWords } from "./country-alias";

// ── 类型 ──────────────────────────────────────────────────────

export interface RateUpdateCustomer {
  id: number; name: string; email: string; company: string | null;
  /** 该客户为什么进这一组：manual=看板录过偏好，inbound=来信里解析到 */
  sources: PortSource[];
  /** 依据说明（界面/回执上说得出口） */
  evidence: string;
}

export interface RateUpdateGroup {
  /** `${pod}|${language}` —— 选组用的稳定标识 */
  key: string;
  pod: string;
  lane: string | null;
  language: Lang;
  /** 这一组凭什么成立：pref=来信/登记偏好；port=用户点名这个港；country=按国家映射到的兜底港 */
  basis: "pref" | "port" | "country";
  /** 展示名（主题与界面用）：单港时是港名，按国家兜底时带方向说明 */
  label: string;
  /** 命中的是航线级/区域基本港价（pod_raw 是「南美东」这类航线名）——必须如实标注，不许当本港专属价 */
  laneLevel: boolean;
  customers: RateUpdateCustomer[];
  /** 清洗后的报价行（与界面表、邮件表同源） */
  quotes: CleanQuote[];
  /** 可引用的真实行文本（与对外表同一批单元格）：模型只许引用这里的字符串，堵凭印象编细节 */
  facts: string[];
  minUsd: number | null;
  /** 组内最早到期日（催单口径；无日期为 null） */
  earliestValidTo: string | null;
  carriers: string[];
  /** 降价标签：只来自镜像 diff，匹配不上就 null（绝不为了话术编降价） */
  drop: { oldUsd: number; newUsd: number; pct: number } | null;
  subject: string;
  bodyHtml: string;
}

export interface UncoveredCustomer {
  contactId: number; name: string;
  /** no_port=推不出偏好港（也没能从国家映射到当期有价的港）；no_live_rate=台账当期无有效价；over_cap=本轮组数上限没排上 */
  reason: "no_port" | "no_live_rate" | "over_cap";
  detail: string;
}

export interface RateUpdatePlan {
  id: string;
  createdAt: string;
  scope: {
    /** board=跟进看板（已触达 ∪ 已回复）；contacts=联系人库全量（含冷客户） */
    scope: "board" | "contacts";
    stages: string[]; country: string | null; includeReplied: boolean;
    port: string | null; days: number; quotesPerGroup: number;
  };
  groups: RateUpdateGroup[];
  uncovered: UncoveredCustomer[];
  totals: { customers: number; covered: number; groups: number; quotes: number; truncated: number; uncoveredTotal: number };
  /** 圈到 0 人时的如实说明（这不是权限问题，也不许被说成权限问题）与建议换的范围 */
  emptyReason: string | null;
  suggestScope: "board" | "contacts" | null;
}

export interface RateUpdateOpts {
  /** 圈人范围：board=跟进看板（默认）；contacts=联系人库全量（用户说「所有 XX 客户」「冷客户也发」时用） */
  scope?: "board" | "contacts";
  /** 按国家/地区收窄（中英文都认，如 巴西/Brazil）；无港口偏好的客户会按该国航线映射到兜底港 */
  country?: string;
  /** CRM 管线阶段收窄（reaching/quoting/trial/cooperating/other）；默认除 lost 全取。scope=contacts 时忽略 */
  stages?: string[];
  /** 直接按联系人状态圈人（用户说「status=已触达的那批」时用）：reached/replied/''/bounced/autoreply */
  statuses?: string[];
  /** 指定客户（省略=按 scope/country/stages 圈定） */
  contactIds?: number[];
  /** 只看某个港（中英文/别名均可，内部归一后比对） */
  port?: string;
  /** 已回复客户是否一起推，默认真 */
  includeReplied?: boolean;
  /** 每组最多几条报价，默认 12（钳 1..30） */
  quotesPerGroup?: number;
  /** 最多分几组，默认 24 */
  maxGroups?: number;
  /** 来信回溯天数，默认 90 */
  days?: number;
  /** 最多圈多少客户，默认 300 */
  maxContacts?: number;
  now?: Date;
}

export interface RateUpdateEnqueueResult extends EnqueueResult {
  groups: number;
  pods: string[];
}

/** 入队结果二选一：队列被占（既有待发批次会被 startQueue 全表清空）时必须先让人决定 */
export type RateUpdateEnqueue =
  | { occupied: true; pendingGroups: number }
  | { occupied: false; enqueue: RateUpdateEnqueueResult };

// ── 文案常量（EN/ES/PT；价格与表格由数据拼装，不经模型）──────────────

interface Copy {
  subjectDrop: string;
  subject: string;
  greeting: string;
  /** {POD} 由组展示名替换：单港=「SANTOS」，按国家兜底=「Brazil (SANTOS)」 */
  intro: (label: string) => string;
  /** 航线级/区域基本港价必须如实说明（不能让客户以为是本港专属价） */
  laneNote: (lane: string, pod: string) => string;
  /** 这封为什么寄给他：按国家当期报价方向 */
  countryNote: (country: string) => string;
  dropLine: (pod: string, pct: number, from: number, to: number) => string;
  notes: string[];
  cta: string;
  signoff: string;
}

const COPY: Record<Lang, Copy> = {
  EN: {
    subjectDrop: "Price drop · {POD} freight rates",
    subject: "Freight rates update · {POD}",
    greeting: "Dear {{firstName}}",
    intro: (pod) => `Here is our current ocean freight list for <b>${pod}</b>, updated from our live rate sheet.`,
    laneNote: (lane, pod) => `Please note: rates on this lane are quoted for the <b>${lane}</b> service and apply to ${pod} as a basic port; exact terms depend on the selected terminal.`,
    countryNote: (country) => `As you have cargo moving in the ${country} direction, we are sharing the rates we can currently work with.`,
    dropLine: (pod, pct, from, to) => `Rates to ${pod} have come down about ${pct}% (from USD ${from.toLocaleString("en-US")} to USD ${to.toLocaleString("en-US")}).`,
    notes: [
      "Ocean freight only; local charges and surcharges are quoted on request.",
      "Rates are reference prices and subject to carrier confirmation at booking.",
      "Please reply with container type and ready date so we can hold the space for you.",
    ],
    cta: "If you have cargo moving to this port, reply with the details and we will confirm the best available service.",
    signoff: "Best regards",
  },
  ES: {
    subjectDrop: "Baja de flete · {POD}",
    subject: "Actualización de fletes · {POD}",
    greeting: "Estimado/a {{firstName}}",
    intro: (pod) => `Le compartimos nuestra lista vigente de fletes marítimos para <b>${pod}</b>, actualizada de nuestra tabla de tarifas.`,
    laneNote: (lane, pod) => `Nota: las tarifas de esta línea corresponden al servicio <b>${lane}</b> y aplican a ${pod} como puerto base; las condiciones exactas dependen de la terminal seleccionada.`,
    countryNote: (country) => `Como tienen carga con destino a ${country}, compartimos las tarifas actualmente operativas.`,
    dropLine: (pod, pct, from, to) => `Los fletes hacia ${pod} han bajado cerca de ${pct}% (de USD ${from.toLocaleString("en-US")} a USD ${to.toLocaleString("en-US")}).`,
    notes: [
      "Solo flete marítimo; cargos locales y sobretasas se cotizan a solicitud.",
      "Los precios son de referencia y están sujetos a confirmación de la naviera al reservar.",
      "Por favor indique tipo de contenedor y fecha de la carga para reservar espacio.",
    ],
    cta: "Si tiene carga con destino a este puerto, responda con los detalles y confirmaremos el mejor servicio disponible.",
    signoff: "Saludos cordiales",
  },
  PT: {
    subjectDrop: "Queda de frete · {POD}",
    subject: "Atualização de fretes · {POD}",
    greeting: "Prezado(a) {{firstName}}",
    intro: (pod) => `Segue nossa tabela atual de fretes marítimos para <b>${pod}</b>, atualizada conforme nossa planilha de tarifas.`,
    laneNote: (lane, pod) => `Observação: as tarifas desta linha referem-se ao serviço <b>${lane}</b> e se aplicam a ${pod} como porto base; as condições exatas dependem do terminal escolhido.`,
    countryNote: (country) => `Como vocês têm carga com destino a ${country}, enviamos as tarifas atualmente disponíveis.`,
    dropLine: (pod, pct, from, to) => `Os fretes para ${pod} caíram cerca de ${pct}% (de USD ${from.toLocaleString("en-US")} para USD ${to.toLocaleString("en-US")}).`,
    notes: [
      "Apenas frete marítimo; taxas locais e adicionais cotados sob solicitação.",
      "Os preços são de referência e sujeitos à confirmação da armadora no momento da reserva.",
      "Informe o tipo de contêiner e a data da carga para reservarmos espaço.",
    ],
    cta: "Se você tem carga com destino a este porto, responda com os detalhes e confirmaremos o melhor serviço disponível.",
    signoff: "Atenciosamente",
  },
};

/** 组内语言的文案（Lang 已由 normalizeLang 收敛，理论上不会落到 EN 之外） */
function copyOf(lang: Lang): Copy { return COPY[lang] ?? COPY.EN; }

const fill = (tpl: string, pod: string): string => tpl.replace(/\{POD\}/g, pod);

/** composeRateUpdateEmail 的额外语境：单港 or 国家方向、是否航线级价 */
export interface EmailContext {
  label: string;
  pod: string;
  lane?: string | null;
  laneLevel?: boolean;
  /** 按国家兜底时给的方向名（英文进信，中文国家名不进客户邮件） */
  countryEn?: string | null;
}

/**
 * 一封运价更新邮件的正文（HTML）。签名不写在这里 —— sendBcc 会按发信账号的 signature 自动追加。
 * 导出供单测：表必须与 markdown 客户表同列、全表零中文、无价不出表。
 * 航线级（区域基本港）价必须标注；但航线名是中文（「南美东」），绝不能进客户邮件 ——
 * 所以中文航线名只进界面/工具，信里用不含中文的说法表达同一件事。
 */
export function composeRateUpdateEmail(copy: Copy, ctx: EmailContext, quoteTableHtml: string, drop: RateUpdateGroup["drop"]): string {
  const notes = copy.notes.map(n => `<li>${n}</li>`).join("");
  const laneLine = ctx.laneLevel
    ? (ctx.lane && !/[\u4e00-\u9fa5]/.test(ctx.lane)
      ? `<p>${copy.laneNote(ctx.lane, ctx.pod)}</p>`
      : `<p>${copy.laneNote("the service shown below", ctx.pod)}</p>`)
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222222">`
    + `<p>${copy.greeting},</p>`
    + `<p>${copy.intro(ctx.label)}</p>`
    + (ctx.countryEn ? `<p>${copy.countryNote(ctx.countryEn)}</p>` : "")
    + (drop ? `<p>${copy.dropLine(ctx.pod, drop.pct, drop.oldUsd, drop.newUsd)}</p>` : "")
    + laneLine
    + (quoteTableHtml ? `<p style="margin:12px 0 4px">${quoteTableHtml}</p>` : "")
    + `<ul style="margin:10px 0 10px 18px;padding:0">${notes}</ul>`
    + `<p>${copy.cta}</p>`
    + `<p>${copy.signoff},</p>`
    + `</div>`;
}

// ── 圈人（看板口径，与 crm.service.listPipeline 同源：status + tags 推阶段）──────

/** 阶段清单字面量兜底：绝不因为跨模块初始化顺序拿不到 STAGES 就把所有客户筛空（实测踩过） */
export const FALLBACK_STAGE_KEYS = ["reaching", "quoting", "trial", "cooperating", "lost", "other"];

/** 运行时取阶段清单（不用模块顶层派生常量——打包/热重载下跨模块初值可能还没就绪） */
export function stageKeys(source: ReadonlyArray<{ key: string }> = STAGES): string[] {
  let keys: string[] = [];
  try { keys = (source ?? []).map(s => s?.key).filter((k): k is string => typeof k === "string" && k.length > 0); } catch { keys = []; }
  return keys.length ? keys : FALLBACK_STAGE_KEYS;
}

function parseTags(tagsRaw: string | null): string[] {
  try {
    const arr = JSON.parse(tagsRaw || "[]") as unknown;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}

export function stageOfTags(tagsRaw: string | null): string {
  const tags = parseTags(tagsRaw);
  return stageKeys().find(k => tags.includes(k)) || "reaching";
}

interface ScopeRow {
  id: number; email: string; firstName: string | null; lastName: string | null;
  status: string | null; tags: string | null; language: string | null; companyId: number | null;
  country: string | null;
}

/** 联系人库口径里的坏地址：占位/无效邮箱不发（一个坏地址会让整组 BCC 被拒） */
const PLACEHOLDER_EMAIL = /no\.email|noreply|no-reply|example\.com|test@|@test|null@/i;

function scopeContacts(o: {
  scope: "board" | "contacts"; includeReplied: boolean; stages: string[]; stagesExplicit?: boolean;
  statuses?: string[]; country?: string | null; ids?: number[]; maxContacts: number;
}): ScopeRow[] {
  const select = {
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    status: contacts.status, tags: contacts.tags, language: contacts.language, companyId: contacts.companyId,
    country: contacts.country,
  };
  const db = getDb();
  // 显式给了状态就照它来（用户会说「status=已触达的那批」），否则用范围默认口径
  const statuses = o.statuses?.length
    ? o.statuses
    : o.scope === "contacts" ? ["", "reached", "replied"] : (o.includeReplied ? ["reached", "replied"] : ["reached"]);
  const rows = db.select(select).from(contacts)
    .where(inArray(dsql`coalesce(${contacts.status}, '')`, statuses)).all();
  const want = o.ids?.length ? new Set(o.ids) : null;
  const countryProbe = o.country?.trim().toLowerCase() ?? "";
  const countryWords = countryProbe ? countryMatchWords(countryProbe) : [];
  return rows.filter(r => {
    if (want && !want.has(r.id)) return false;
    if (o.scope === "contacts" && PLACEHOLDER_EMAIL.test(r.email || "")) return false;
    // 看板口径：已流失一律不参与（直接看 tags，不依赖阶段清单）；用户点名阶段时才按清单比对
    if (o.scope === "board") {
      const tags = parseTags(r.tags);
      if (tags.includes("lost")) return false;
      if (o.stagesExplicit && !o.stages.some(s => tags.includes(s))) return false;
    }
    if (countryWords.length) {
      const hay = (r.country ?? "").trim().toLowerCase();
      if (!hay || !countryWords.some(w => hay.includes(w) || w.includes(hay))) return false;
    }
    return true;
  }).slice(0, o.maxContacts);
}

/** 国家中英别名与解析函数已下沉到 country-alias.ts（首页开发信的意图解析也要用）；
 *  这里原样转出口，老调用点（agent/tools.ts 等）继续从本模块引。 */
export { looksLikeCountry, countryMatchWords, matchCountryInText } from "./country-alias";

/**
 * 国家 → 当期有价的代表港（没有港口偏好的客户用它兜底，解决「没登记偏好就一个都推不了」的死路）。
 * 做法：国家关键词 LIKE 镜像 lane/pod_raw/pol → 命中的行用 cleanPod 抽英文港名（pod_raw 常写成
 * 「SANTOS 桑托斯(巴西)」）→ 过形态闸门（拒句子/邮件标题那类脏值）→ 条数多的优先、并列取价低的。
 * 一个都没命中就返回 null，由上层如实记 no_port —— 绝不编一个港口出来。
 */
export function portForCountry(country: string): { pod: string; lane: string | null; rows: number } | null {
  const words = countryMatchWords(country);
  const byPod = new Map<string, { n: number; min: number | null; lane: string | null }>();
  for (const w of words) {
    let r: ReturnType<typeof listQuotes>;
    try { r = listQuotes({ terms: [w], includeExpired: false, limit: 300 }); } catch { continue; }
    if (!r.success) continue;
    for (const q of r.data) {
      const pods = cleanPod(q.podRaw).pods;
      const pod = (pods[0] ?? "").trim().toUpperCase();
      if (!pod || !plausiblePortToken(pod)) continue;              // 航线名/脏值不当港用
      const cur = byPod.get(pod) ?? { n: 0, min: null, lane: q.lane ?? null };
      cur.n += 1;
      if (!cur.lane && q.lane) cur.lane = q.lane;
      const price = q.oceanUsd;
      if (typeof price === "number" && price > 0 && (cur.min === null || price < cur.min)) cur.min = price;
      byPod.set(pod, cur);
    }
    if (byPod.size) break;                                          // 中文词命中了就不必再试英文
  }
  let best: { pod: string; lane: string | null; rows: number } | null = null;
  let bestMin: number | null = null;
  for (const [pod, v] of byPod) {
    if (!best || v.n > best.rows || (v.n === best.rows && (v.min ?? Infinity) < (bestMin ?? Infinity))) {
      best = { pod, lane: v.lane, rows: v.n };
      bestMin = v.min;
    }
  }
  return best;
}

function companyNameMap(): Map<number, string> {
  const m = new Map<number, string>();
  try { for (const c of getDb().select({ id: companies.id, name: companies.name }).from(companies).all()) m.set(c.id, c.name); } catch { /* 公司表读不到就都不显示公司名 */ }
  return m;
}

// ── 定价：偏好 → 伪询价要素 → 台账自查 ─────────────────────────────

/** 港口偏好 → lookupReplyRates 吃的"询价要素"（复用回信查价那把刀，不另写匹配逻辑） */
function prefToInquiry(pref: PortPref, container?: string | null): EmailInquiry {
  return {
    container: pref.container ?? container ?? null, containerRaw: null,
    pol: pref.pol, polCode: null,
    pod: pref.pod, podCode: null,
    incoterm: null, cargo: null, cargoValueUsd: null, quoteRef: null, volumeCbm: null, weightKg: null,
  };
}

function dropFor(d: RatesDiff | null, pod: string): RateUpdateGroup["drop"] {
  if (!d) return null;
  let best: { oldUsd: number; newUsd: number; pct: number } | null = null;
  for (const row of d.priceDrops) {
    const token = podToken(row.podRaw);
    if (!token || token !== pod) continue;
    const pct = row.oldUsd > 0 ? Math.round(((row.oldUsd - row.newUsd) / row.oldUsd) * 100) : 0;
    if (!best || row.oldUsd - row.newUsd > best.oldUsd - best.newUsd) best = { oldUsd: row.oldUsd, newUsd: row.newUsd, pct };
  }
  return best;
}

function evidenceOf(pref: PortPref): string {
  const bits: string[] = [];
  if (pref.sources.includes("manual")) bits.push("看板登记的偏好");
  if (pref.sources.includes("inbound")) bits.push(`${pref.hits} 封来信提到`);
  if (pref.lastSeenAt) bits.push(`最近 ${pref.lastSeenAt.slice(0, 10)}`);
  return bits.join(" · ");
}

function minUsdOf(rows: CleanQuote[]): number | null {
  let best: number | null = null;
  for (const r of rows) {
    for (const v of [r.p20, r.p40, r.pNor]) {
      if (typeof v === "number" && v > 0 && (best === null || v < best)) best = v;
    }
  }
  return best;
}

function earliestValidToOf(rows: CleanQuote[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const d = parseFlexDate(r.validTo);
    if (!d) continue;
    if (!best || d < best) best = d;
  }
  return best;
}

// ── 方案 ─────────────────────────────────────────────────────

const clampInt = (v: number | undefined, lo: number, hi: number, dft: number): number => {
  const n = Math.trunc(Number(v ?? dft));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dft;
};

/** 与 send.service 同一套 id 生成（项目不依赖 nanoid 包） */
const newId = () => crypto.randomUUID().slice(0, 12);

/** 每港最多几个柜型档也钳在这里：30 条已经是客户表可读上限 */
export const MAX_QUOTES_PER_GROUP = 30;

/**
 * 建方案（纯读，不写库）。分组键 = 目的港 + 语言，一位客户只进一组。
 * 求港顺序：用户点名那个港 → 客户自己的港口偏好（分最高）→ 按所属国家映射到的当期代表港兜底；
 * 三条都落空才记 no_port —— 不再因为「没登记偏好」就一整批推不出去。
 * 未覆盖的人一律列出来并给原因，不静默丢人（对齐「标注必须=实给」）。
 */
export function buildRateUpdatePlan(opts: RateUpdateOpts = {}): Result<RateUpdatePlan> {
  const scopeMode: "board" | "contacts" = opts.scope === "contacts" ? "contacts" : "board";
  // 排除「已流失」不依赖任何清单（直接看 tags）；用户显式点名阶段时才按清单比对
  const explicitStages = (opts.stages ?? []).filter(s => stageKeys().includes(s) && s !== "lost");
  const o = {
    scope: scopeMode,
    country: opts.country?.trim() || null,
    includeReplied: opts.includeReplied ?? true,
    stages: explicitStages,
    stagesExplicit: !!opts.stages?.length && explicitStages.length > 0,
    /** 显式状态圈人（用户说「status=已触达」）；未给则按 scope 的默认口径 */
    statuses: opts.statuses?.length ? [...new Set(opts.statuses.map(s => s.trim()))] : undefined,
    quotesPerGroup: clampInt(opts.quotesPerGroup, 1, MAX_QUOTES_PER_GROUP, 12),
    maxGroups: clampInt(opts.maxGroups, 1, 40, 24),
    days: clampInt(opts.days, 7, 365, 90),
    maxContacts: clampInt(opts.maxContacts, 1, 1000, 300),
  };
  const now = opts.now ?? new Date();
  const portFilter = opts.port?.trim() ? normalizePodName({ pod: opts.port, podCode: null }) : null;
  if (opts.port?.trim() && !portFilter) return failResult(`「${opts.port.trim()}」在台账里不是可识别的目的港，先确认港名或按航线查`);

  const rows = scopeContacts({
    scope: o.scope, includeReplied: o.includeReplied, stages: o.stages, stagesExplicit: o.stagesExplicit,
    statuses: o.statuses,
    country: o.country, ids: opts.contactIds, maxContacts: o.maxContacts,
  });
  const scopeLabel = o.scope === "contacts"
    ? `联系人库${o.country ? `里的「${o.country}」客户` : ""}` : `跟进看板（已触达${o.includeReplied ? "/已回复" : ""}）${o.country ? `里的「${o.country}」客户` : ""}`;
  const emptyPlan = (reason: string, suggest: "board" | "contacts" | null): Result<RateUpdatePlan> => okResult({
    id: newId(), createdAt: now.toISOString(),
    scope: {
      scope: o.scope, stages: o.stages, includeReplied: o.includeReplied,
      country: o.country, port: portFilter ?? (opts.port?.trim() || null),
      days: o.days, quotesPerGroup: o.quotesPerGroup,
    },
    groups: [], uncovered: [],
    totals: { customers: 0, covered: 0, groups: 0, quotes: 0, truncated: 0, uncoveredTotal: 0 },
    emptyReason: reason, suggestScope: suggest,
  });
  // 圈到 0 人是数据事实，不是故障：如实带原因 + 建议换哪个范围，别让模型自己去猜（它猜就会编出「权限没开」这种话）
  if (!rows.length) {
    const suggest = o.scope === "board" ? "contacts" as const : null;
    return emptyPlan(
      o.country
        ? `${scopeLabel}一个也没有（${o.country}的客户目前都在联系人库里当冷客户，没进过跟进看板）`
        : `${scopeLabel}里没有符合条件的客户`,
      suggest,
    );
  }
  const names = companyNameMap();
  const derived = deriveCustomerPorts(rows.map(r => r.id), { days: o.days, maxContacts: o.maxContacts, now });
  const portsById = new Map<number, CustomerPorts>(derived.map(d => [d.contactId, d]));

  /** 同国只查一次代表港（巴西→当期报价最多的那个港），查不到如实 null */
  const countryPortCache = new Map<string, { pod: string; lane: string | null; rows: number } | null>();
  const countryPort = (country: string | null): { pod: string; lane: string | null; rows: number } | null => {
    const key = (country ?? "").trim().toLowerCase();
    if (!key) return null;
    if (countryPortCache.has(key)) return countryPortCache.get(key) ?? null;
    const hit = portForCountry(key);
    countryPortCache.set(key, hit);
    return hit;
  };
  const countryEnOf = (country: string | null): string | null => {
    const c = (country ?? "").trim();
    if (!c) return null;
    const en = /^[A-Za-z][A-Za-z .-]{1,23}$/.test(c) ? c : (COUNTRY_ALIAS[c]?.[0] ?? null);   // 中文名 → 英文别名；没有就不写这句
    return en ? en.replace(/^\p{L}/u, m => m.toUpperCase()) : null;
  };

  // ① 一人一组：点名港 → 自己的偏好 → 国家代表港兜底
  type Bucket = {
    pod: string; language: Lang; basis: "pref" | "port" | "country";
    countryEn: string | null; prefs: Map<number, PortPref>; customers: RateUpdateCustomer[]; containers: Map<string, number>;
  };
  const buckets = new Map<string, Bucket>();
  const uncovered: UncoveredCustomer[] = [];
  for (const r of rows) {
    const cp = portsById.get(r.id);
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email;
    let pref = pickPref(cp?.prefs ?? [], portFilter);
    let basis: Bucket["basis"] = portFilter ? "port" : "pref";
    let countryEn: string | null = null;
    if (!pref && !portFilter) {
      // 没有港口偏好 → 按他所在国家的当期代表港兜底（用户口径：「巴西客户就报巴西方向的运价」）
      const fallback = countryPort(r.country ?? o.country);
      if (fallback) {
        const synthetic: PortPref = {
          pod: fallback.pod, pol: null, container: cp?.prefs[0]?.container ?? null,
          score: 0, sources: [], lastSeenAt: null, hits: 0,
        };
        pref = synthetic;
        basis = "country";
        countryEn = countryEnOf(r.country ?? o.country);
      }
    }
    if (!pref) {
      uncovered.push({
        contactId: r.id, name, reason: "no_port",
        detail: portFilter
          ? `关注的港里没有 ${portFilter}`
          : (r.country ?? o.country)
            ? `${r.country ?? o.country}方向台账当前也没有可用报价，且 TA 没登记港口偏好`
            : cp
              ? "近 " + o.days + " 天来信未提到目的港，偏好设置里也没有登记"
              : "无港口偏好",
      });
      continue;
    }
    const language = normalizeLang(r.language);
    const key = `${pref.pod}|${language}`;
    let b = buckets.get(key);
    if (!b) {
      b = { pod: pref.pod, language, basis, countryEn, prefs: new Map(), customers: [], containers: new Map() };
      buckets.set(key, b);
    }
    const evidence = basis === "country"
      ? `${r.country ?? o.country ?? "所在国家"}方向当期报价最多的港（TA 未登记偏好）`
      : evidenceOf(pref);
    b.customers.push({
      id: r.id, name, email: r.email, company: r.companyId ? (names.get(r.companyId) ?? null) : null,
      sources: basis === "country" ? [] : [...pref.sources], evidence,
    });
    b.prefs.set(r.id, pref);
    if (pref.container) b.containers.set(pref.container, (b.containers.get(pref.container) ?? 0) + 1);
  }

  // ② 组排序（人多优先）→ 取前 maxGroups 组；被截掉的组的人进 uncovered（不静默丢）
  const sorted = [...buckets.values()].sort((a, b) => b.customers.length - a.customers.length || a.pod.localeCompare(b.pod));
  const taken = sorted.slice(0, o.maxGroups);
  const droppedBuckets = sorted.slice(o.maxGroups);
  let truncated = 0;
  for (const dropped of droppedBuckets) {
    truncated += dropped.customers.length;
    for (const c of dropped.customers) {
      uncovered.push({
        contactId: c.id, name: c.name, reason: "over_cap",
        detail: `本轮最多 ${o.maxGroups} 组，共 ${sorted.length} 组候选，${dropped.pod} 组人多靠后没排上`,
      });
    }
  }

  // ③ 选价 + 成文
  const diff = safeDiff();
  const groups: RateUpdateGroup[] = [];
  for (const b of taken) {
    const prefSample: PortPref = b.prefs.values().next().value ?? {
      pod: b.pod, pol: null, container: null, score: 0, sources: [], lastSeenAt: null, hits: 0,
    };
    const container = topOf(b.containers) ?? prefSample.container ?? null;
    let reply: ReplyRates | null = null;
    try { reply = lookupReplyRates(prefToInquiry(prefSample, container)); } catch { reply = null; }
    const dtos = reply?.dtos ?? [];
    if (!dtos.length) {
      // 台账当期无价 → 这组一个人都不发（宁缺毋滥，绝不拿别的港价凑）
      for (const c of b.customers) {
        uncovered.push({ contactId: c.id, name: c.name, reason: "no_live_rate", detail: `镜像里 ${b.pod} 当前无有效报价` });
      }
      continue;
    }
    // 分层：本港专属行在前、航线级行在后（各自保持价升序），与查价呈现同口径
    const ordered = [...dtos].sort((a, b) =>
      (/[\u4e00-\u9fa5]/.test(a.podRaw ?? "") ? 1 : 0) - (/[\u4e00-\u9fa5]/.test(b.podRaw ?? "") ? 1 : 0));
    const limited = ordered.slice(0, o.quotesPerGroup);
    const quotes = customerCleanQuotes(limited, b.pod);
    if (!quotes.length) {
      for (const c of b.customers) {
        uncovered.push({ contactId: c.id, name: c.name, reason: "no_live_rate", detail: `镜像里 ${b.pod} 报价行清洗后为空` });
      }
      continue;
    }
    // 航线级判定：台账原始 podRaw 是中文航线名（「南美东」）=区域基本港价，不是本港专属价 —— 必须如实标
    const laneLevel = limited.some(d => /[\u4e00-\u9fa5]/.test(d.podRaw ?? ""));
    const lane = quotes.find(q => q.lane)?.lane ?? null;
    const label = b.basis === "country" && b.countryEn ? `${b.pod} (${b.countryEn})` : b.pod;
    const copy = copyOf(b.language);
    const minUsd = minUsdOf(quotes);
    const drop = dropFor(diff, b.pod);
    const subject = fill(drop ? copy.subjectDrop : copy.subject, label);
    groups.push({
      key: `${b.pod}|${b.language}`,
      pod: b.pod, lane, language: b.language, basis: b.basis, label, laneLevel,
      customers: b.customers,
      quotes,
      facts: customerQuoteRows(quotes, o.quotesPerGroup).map(cells => cells.join(" | ")),
      minUsd,
      earliestValidTo: earliestValidToOf(quotes),
      carriers: [...new Set(quotes.map(q => q.carrier).filter(Boolean))].slice(0, 8),
      drop, subject,
      bodyHtml: composeRateUpdateEmail(copy, { label, pod: b.pod, lane, laneLevel, countryEn: b.countryEn },
        customerQuoteHtml(quotes, o.quotesPerGroup), drop),
    });
  }

  const covered = groups.reduce((s, g) => s + g.customers.length, 0);
  const plan: RateUpdatePlan = {
    id: newId(),
    createdAt: now.toISOString(),
    scope: {
      scope: o.scope, stages: o.stages, includeReplied: o.includeReplied,
      country: o.country, port: portFilter ?? (opts.port?.trim() || null),
      days: o.days, quotesPerGroup: o.quotesPerGroup,
    },
    groups,
    uncovered,
    totals: {
      customers: rows.length, covered, groups: groups.length,
      quotes: groups.reduce((s, g) => s + g.quotes.length, 0),
      truncated, uncoveredTotal: uncovered.length,
    },
    emptyReason: groups.length ? null : (o.country
      ? `圈到 ${rows.length} 位客户，但她们的偏好港与国家方向在台账当期都没有有效价` : "圈到客户了但没有任何港口当期有有效报价"),
    suggestScope: null,
  };
  rememberPlan(plan);
  Log.debug("rateUpdate.plan", `${plan.id}: ${rows.length} 人 → ${groups.length} 组/${covered} 人，未覆盖 ${uncovered.length}`);
  return okResult(plan);
}

function safeDiff(): RatesDiff | null {
  try { return ratesDiff(); } catch { return null; }
}

function topOf(counts: Map<string, number>): string | null {
  let best: { v: string; n: number } | null = null;
  for (const [v, n] of counts) if (!best || n > best.n) best = { v, n };
  return best?.v ?? null;
}

/** 选这个人的目标港：指定了港就用那个港（前提是他也真关心它），否则取分最高的 */
function pickPref(prefs: PortPref[], portFilter: string | null): PortPref | null {
  if (!prefs.length) return null;
  if (!portFilter) return prefs[0] ?? null;
  return prefs.find(p => p.pod === portFilter) ?? null;
}

// ── pending plan（预览即执行对象：入队只认这份，不让模型二次拼内容）──────

const PLAN_TTL_MS = 30 * 60_000;
const PLAN_MAX = 20;
const plans = new Map<string, { plan: RateUpdatePlan; at: number }>();

function rememberPlan(plan: RateUpdatePlan): void {
  const cutoff = Date.now() - PLAN_TTL_MS;
  for (const [id, v] of plans) if (v.at < cutoff) plans.delete(id);
  while (plans.size >= PLAN_MAX) {
    const oldest = plans.keys().next().value;
    if (oldest === undefined) break;
    plans.delete(oldest);
  }
  plans.set(plan.id, { plan, at: Date.now() });
}

export function pendingPlanRateUpdate(planId: string): RateUpdatePlan | null {
  const hit = plans.get(planId);
  if (!hit) return null;
  if (Date.now() - hit.at > PLAN_TTL_MS) { plans.delete(planId); return null; }
  return hit.plan;
}

/** 测试与调试用：清空 pending 方案 */
export function clearPendingPlans(): void { plans.clear(); }

/** 当前待发组数（既有批次）——startQueue 落库前会清空 send_queue 全表，覆盖前必须让人知道 */
export function pendingQueueGroups(): number {
  try {
    const st = getSendStatus();
    if (st.success && st.data.isRunning) return -1;               // -1 = 正在发送，绝对不让插队
    const q = getQueueItems();
    if (!q.success) return 0;
    return q.data.filter(i => i.status === "pending" || i.status === "sending").length;
  } catch { return 0; }
}

/**
 * 方案入队（唯一写出通道）：每组一份正文 → buildDynamicQueue → 合并 → startQueue(autoStart=false)。
 * autoStart 恒为 false 是红线：程序永不自动开始群发，发送必须人在发送中心点。
 */
export async function enqueueRateUpdatePlan(
  planId: string, groupKeys?: string[], overwrite = false,
): Promise<Result<RateUpdateEnqueue>> {
  const plan = pendingPlanRateUpdate(planId);
  if (!plan) return failResult("方案已过期或不存在，请重新生成方案（rate_update_plan）");
  const unknown = groupKeys?.filter(k => !plan.groups.some(g => g.key === k));
  if (unknown?.length) {
    return failResult(`未知分组：${unknown.join("、")}。可选：${plan.groups.map(g => g.key).join("、")}`);
  }
  const selected = groupKeys?.length
    ? plan.groups.filter(g => groupKeys.includes(g.key))
    : plan.groups;
  if (!selected.length) return failResult("没有选中任何分组");

  const occupied = pendingQueueGroups();
  if (occupied === -1) return failResult("有发送任务正在运行，等它跑完再入队（避免打断当前批次）");
  if (occupied > 0 && !overwrite) return okResult({ occupied: true, pendingGroups: occupied });

  const items: SendItem[] = [];
  for (const g of selected) {
    const qr = buildDynamicQueue(g.customers.map(c => c.id), g.subject, g.bodyHtml);
    if (!qr.success) {
      Log.warn("rateUpdate.build", `${g.key} 组装失败：${qr.error}`);
      continue;
    }
    for (const it of qr.data) items.push({ ...it, tplName: `运价更新 · ${g.label}` });
  }
  if (!items.length) return failResult("所选分组都没能组装成邮件（客户邮箱可能全部无效）");

  const q = await startQueue(items, false);
  if (!q.success) return failResult(`入队失败：${q.error}`);
  plans.delete(planId);        // 一次性：预览即执行对象，用过就作废，防止同份方案重复入队
  Log.info("rateUpdate.enqueue", `批次 ${q.data.batchId}：${selected.length} 组 / ${q.data.queuedCount} 封（${q.data.dropped} 组被限额裁剪）`);
  return okResult({
    occupied: false,
    enqueue: {
      ...q.data,
      groups: selected.length,
      pods: [...new Set(selected.map(g => g.label))],
    },
  });
}

/** 方案 → 界面/agent 共用投影（组表行 + 未覆盖 + 计数；正文只在预览时单独取，避免整包过大） */
export function planView(plan: RateUpdatePlan): Record<string, unknown> {
  return {
    planId: plan.id,
    scope: plan.scope,
    totals: plan.totals,
    emptyReason: plan.emptyReason,
    suggestScope: plan.suggestScope,
    groups: plan.groups.map(g => ({
      pod: g.pod, label: g.label, lane: g.lane, language: g.language,
      basis: g.basis, laneLevel: g.laneLevel,
      customers: g.customers.length,
      quotes: g.quotes.length,
      minUsd: g.minUsd,
      validTo: g.earliestValidTo,
      carriers: g.carriers.join("/"),
      dropPct: g.drop?.pct ?? null,
      subject: g.subject,
      /** 模型唯一可引用的真实行文本（前 6 行）：细节只能从这里抄，不许凭印象补 */
      facts: g.facts.slice(0, 6),
      // 入队用的分组键（技术字段，排最后：界面表格卡只取前 7 列，不让它占位）
      key: g.key,
    })),
    uncovered: plan.uncovered.slice(0, 30),
  };
}
