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
import { inArray } from "drizzle-orm";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";
import { normalizeLang, buildDynamicQueue, startQueue, getQueueItems, getSendStatus, type SendItem, type EnqueueResult } from "./send.service";
import type { Lang } from "./sentence-library";
import { deriveCustomerPorts, normalizePodName, type CustomerPorts, type PortPref, type PortSource } from "./customer-ports";
import { lookupReplyRates, customerCleanQuotes, type ReplyRates } from "./agent/reply-rates";
import type { EmailInquiry } from "./agent/email-parse";
import { customerQuoteHtml, type CleanQuote } from "./rates-clean";
import { STAGES } from "./crm.service";
import { ratesDiff, parseFlexDate, type RatesDiff } from "./rate-sync.service";
import { podToken } from "./suggestion.service";

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
  customers: RateUpdateCustomer[];
  /** 清洗后的报价行（与界面表、邮件表同源） */
  quotes: CleanQuote[];
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
  /** no_port=推不出偏好港；no_live_rate=台账当期无有效价；over_cap=本轮组数上限没排上 */
  reason: "no_port" | "no_live_rate" | "over_cap";
  detail: string;
}

export interface RateUpdatePlan {
  id: string;
  createdAt: string;
  scope: { stages: string[]; includeReplied: boolean; port: string | null; days: number; quotesPerGroup: number };
  groups: RateUpdateGroup[];
  uncovered: UncoveredCustomer[];
  totals: { customers: number; covered: number; groups: number; quotes: number; truncated: number; uncoveredTotal: number };
}

export interface RateUpdateOpts {
  /** CRM 管线阶段收窄（reaching/quoting/trial/cooperating/other）；默认除 lost 全取 */
  stages?: string[];
  /** 指定客户（省略=跟进中的客户：status reached ∪ replied） */
  contactIds?: number[];
  /** 只看某个港（中英文/别名均可，内部归一后比对） */
  port?: string;
  /** 已回复客户是否一起推，默认真 */
  includeReplied?: boolean;
  /** 每组最多几条报价，默认 12（钳 1..30） */
  quotesPerGroup?: number;
  /** 最多分几组，默认 10 */
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
  /** {POD} 由组替换；一句说明为什么收到这封（偏好出处在人侧说明，信里只讲"贵司关注的港口"） */
  intro: (pod: string) => string;
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

/**
 * 一封运价更新邮件的正文（HTML）。签名不写在这里 —— sendBcc 会按发信账号的 signature 自动追加。
 * 导出供单测：表必须与 markdown 客户表同列、全表零中文、无价不出表。
 */
export function composeRateUpdateEmail(copy: Copy, pod: string, quoteTableHtml: string, drop: RateUpdateGroup["drop"]): string {
  const notes = copy.notes.map(n => `<li>${n}</li>`).join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222222">`
    + `<p>${copy.greeting},</p>`
    + `<p>${copy.intro(pod)}</p>`
    + (drop ? `<p>${copy.dropLine(pod, drop.pct, drop.oldUsd, drop.newUsd)}</p>` : "")
    + (quoteTableHtml ? `<p style="margin:12px 0 4px">${quoteTableHtml}</p>` : "")
    + `<ul style="margin:10px 0 10px 18px;padding:0">${notes}</ul>`
    + `<p>${copy.cta}</p>`
    + `<p>${copy.signoff},</p>`
    + `</div>`;
}

// ── 圈人（看板口径，与 crm.service.listPipeline 同源：status + tags 推阶段）──────

/** 阶段清单来自 crm.service（唯一事实源），本文件不再维护第二份 */
const ALL_STAGES: string[] = STAGES.map(s => s.key);

function stageOfTags(tagsRaw: string | null): string {
  let arr: unknown = [];
  try { arr = JSON.parse(tagsRaw || "[]"); } catch { arr = []; }
  const tags = Array.isArray(arr) ? arr.map(String) : [];
  return ALL_STAGES.find(k => tags.includes(k)) || "reaching";
}

interface ScopeRow {
  id: number; email: string; firstName: string | null; lastName: string | null;
  status: string | null; tags: string | null; language: string | null; companyId: number | null;
}

function scopeContacts(o: { includeReplied: boolean; stages: string[]; ids?: number[]; maxContacts: number }): ScopeRow[] {
  const statuses = o.includeReplied ? ["reached", "replied"] : ["reached"];
  const rows = getDb().select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    status: contacts.status, tags: contacts.tags, language: contacts.language, companyId: contacts.companyId,
  }).from(contacts).where(inArray(contacts.status, statuses)).all();
  const want = o.ids?.length ? new Set(o.ids) : null;
  return rows.filter(r => {
    if (want && !want.has(r.id)) return false;
    return o.stages.includes(stageOfTags(r.tags));
  }).slice(0, o.maxContacts);
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
 * 建方案（纯读，不写库）。分组键 = 目的港 + 语言，一位客户只进一组（分最高的那个港）。
 * 未覆盖的人一律列出来并给原因，不静默丢人（对齐「标注必须=实给」）。
 */
export function buildRateUpdatePlan(opts: RateUpdateOpts = {}): Result<RateUpdatePlan> {
  const o = {
    includeReplied: opts.includeReplied ?? true,
    stages: opts.stages?.length ? opts.stages.filter(s => ALL_STAGES.includes(s) && s !== "lost") : ALL_STAGES.filter(s => s !== "lost"),
    quotesPerGroup: clampInt(opts.quotesPerGroup, 1, MAX_QUOTES_PER_GROUP, 12),
    maxGroups: clampInt(opts.maxGroups, 1, 40, 10),
    days: clampInt(opts.days, 7, 365, 90),
    maxContacts: clampInt(opts.maxContacts, 1, 1000, 300),
  };
  if (o.stages.length === 0) return failResult("筛选阶段后没有可用阶段（已流失客户不参与运价更新推送）");
  const now = opts.now ?? new Date();
  const portFilter = opts.port?.trim() ? normalizePodName({ pod: opts.port, podCode: null }) : null;

  const rows = scopeContacts({
    includeReplied: o.includeReplied, stages: o.stages, ids: opts.contactIds, maxContacts: o.maxContacts,
  });
  if (!rows.length) return failResult("跟进看板里没有符合条件的客户（范围：已触达" + (o.includeReplied ? "/已回复" : "") + "）");
  const names = companyNameMap();
  const derived = deriveCustomerPorts(rows.map(r => r.id), { days: o.days, maxContacts: o.maxContacts, now });
  const portsById = new Map<number, CustomerPorts>(derived.map(d => [d.contactId, d]));

  // ① 一人一港：分最高的那个偏好（指定港时优先取该港）
  type Bucket = { pod: string; language: Lang; prefs: Map<number, PortPref>; customers: RateUpdateCustomer[]; containers: Map<string, number> };
  const buckets = new Map<string, Bucket>();
  const uncovered: UncoveredCustomer[] = [];
  for (const r of rows) {
    const cp = portsById.get(r.id);
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email;
    const pref = pickPref(cp?.prefs ?? [], portFilter);
    if (!pref) {
      uncovered.push({
        contactId: r.id, name, reason: "no_port",
        detail: portFilter
          ? `关注的港里没有 ${portFilter}`
          : cp
            ? "近 " + o.days + " 天来信未提到目的港，偏好设置里也没有登记"
            : "无港口偏好",
      });
      continue;
    }
    const language = normalizeLang(r.language);
    const key = `${pref.pod}|${language}`;
    let b = buckets.get(key);
    if (!b) { b = { pod: pref.pod, language, prefs: new Map(), customers: [], containers: new Map() }; buckets.set(key, b); }
    b.customers.push({
      id: r.id, name, email: r.email, company: r.companyId ? (names.get(r.companyId) ?? null) : null,
      sources: [...pref.sources], evidence: evidenceOf(pref),
    });
    b.prefs.set(r.id, pref);
    if (pref.container) b.containers.set(pref.container, (b.containers.get(pref.container) ?? 0) + 1);
  }

  // ② 组排序（人多优先）→ 取前 maxGroups 组；被截掉的组的人进 uncovered（不静默丢）
  const sorted = [...buckets.values()].sort((a, b) => b.customers.length - a.customers.length || a.pod.localeCompare(b.pod));
  const taken = sorted.slice(0, o.maxGroups);
  let truncated = 0;
  for (const dropped of sorted.slice(o.maxGroups)) {
    truncated += dropped.customers.length;
    for (const c of dropped.customers) {
      uncovered.push({ contactId: c.id, name: c.name, reason: "over_cap", detail: `未纳入本轮（组数上限 ${o.maxGroups}，${dropped.pod} 组靠后）` });
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
    const limited = dtos.slice(0, o.quotesPerGroup);
    const quotes = customerCleanQuotes(limited, b.pod);
    if (!quotes.length) {
      for (const c of b.customers) {
        uncovered.push({ contactId: c.id, name: c.name, reason: "no_live_rate", detail: `镜像里 ${b.pod} 报价行清洗后为空` });
      }
      continue;
    }
    const copy = copyOf(b.language);
    const minUsd = minUsdOf(quotes);
    const drop = dropFor(diff, b.pod);
    const subject = fill(drop ? copy.subjectDrop : copy.subject, b.pod);
    const groupsRow: RateUpdateGroup = {
      key: `${b.pod}|${b.language}`,
      pod: b.pod,
      lane: quotes.find(q => q.lane)?.lane ?? null,
      language: b.language,
      customers: b.customers,
      quotes,
      minUsd,
      earliestValidTo: earliestValidToOf(quotes),
      carriers: [...new Set(quotes.map(q => q.carrier).filter(Boolean))].slice(0, 8),
      drop,
      subject,
      bodyHtml: composeRateUpdateEmail(copy, b.pod, customerQuoteHtml(quotes, o.quotesPerGroup), drop),
    };
    groups.push(groupsRow);
  }

  const covered = groups.reduce((s, g) => s + g.customers.length, 0);
  const plan: RateUpdatePlan = {
    id: newId(),
    createdAt: now.toISOString(),
    scope: {
      stages: o.stages, includeReplied: o.includeReplied,
      port: portFilter ?? (opts.port?.trim() || null),
      days: o.days, quotesPerGroup: o.quotesPerGroup,
    },
    groups,
    uncovered,
    totals: {
      customers: rows.length, covered, groups: groups.length,
      quotes: groups.reduce((s, g) => s + g.quotes.length, 0),
      truncated, uncoveredTotal: uncovered.length,
    },
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
    for (const it of qr.data) items.push({ ...it, tplName: `运价更新 · ${g.pod}` });
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
      pods: [...new Set(selected.map(g => g.pod))],
    },
  });
}

/** 方案 → 界面/agent 共用投影（组表行 + 未覆盖 + 计数；正文只在预览时单独取，避免整包过大） */
export function planView(plan: RateUpdatePlan): Record<string, unknown> {
  return {
    planId: plan.id,
    scope: plan.scope,
    totals: plan.totals,
    groups: plan.groups.map(g => ({
      pod: g.pod, lane: g.lane, language: g.language,
      customers: g.customers.length,
      quotes: g.quotes.length,
      minUsd: g.minUsd,
      validTo: g.earliestValidTo,
      carriers: g.carriers.join("/"),
      dropPct: g.drop?.pct ?? null,
      subject: g.subject,
      // 入队用的分组键（技术字段，排最后：界面表格卡只取前 7 列，不让它占位）
      key: g.key,
    })),
    uncovered: plan.uncovered.slice(0, 30),
  };
}
