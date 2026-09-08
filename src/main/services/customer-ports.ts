// ── 客户港口偏好聚合（读时派生，不落库）──────────────────────────────
// 规范 docs/rate-update-push-spec.md §2。为什么读时算而不建表：
//   偏好有两个出处——看板「偏好设置」里人工录的 contacts.extra.preferredPorts，和客户来信正文里的
//   起运/目的港。后者随每封新邮件变化，落库就要维护回填与失效；读时派生则「历史邮件即刻生效」，
//   与 crm.service 的 timeline 同一套做法（读时合并，不养第二份事实）。
// 原则：抽不到港就不记（宁缺毋滥，绝不拿别的港凑）；每个偏好带出处与最后时间，界面与 agent 都说得出依据。
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { inboxMessages } from "../db/schema/inbox";
import { ne, and, or, inArray, gte, desc, isNull, isNotNull, sql as dsql } from "drizzle-orm";
import { readLocalBodyHtml, htmlToText } from "./inbox.service";
import { parseEmailInquiry } from "./agent/email-parse";
import { podQueryWord } from "./agent/reply-rates";
import { listQuotes, normalizeContainer } from "./rate-sync.service";
import { resolveQueryPod } from "./rates-standard";

export type PortSource = "manual" | "inbound";

export interface PortPref {
  /** 标准英文港名（podQueryWord → resolveQueryPod 归一；归一不了取大写原文） */
  pod: string;
  /** 该港常用的起运港（人工录的优先，其次最近一封信里的 POL）；定价时用于对齐，不做硬过滤 */
  pol: string | null;
  /** 该港来信里出现过的柜型（多数优先；识别不了为 null，不猜） */
  container: string | null;
  score: number;
  sources: PortSource[];
  /** 最近一次见到该港的时间（纯 manual 时为 null） */
  lastSeenAt: string | null;
  /** 来信命中次数（界面标依据：「3 封来信提到」） */
  hits: number;
}

export interface CustomerPorts {
  contactId: number;
  email: string;
  name: string;
  companyName: string | null;
  language: string | null;
  country: string | null;
  /** 分数高→低，最多 MAX_PREFS 个；空数组 = 推不出任何港（方案层进 uncovered） */
  prefs: PortPref[];
}

export interface DeriveOpts {
  /** 来信回溯天数，默认 90 */
  days?: number;
  /** 每位客户最多解析几封来信，默认 5 */
  maxEmailsPerContact?: number;
  /** 单次最多处理多少客户，默认 300 */
  maxContacts?: number;
  /** 全文读盘总量闸门（防大客户量把主进程卡死），默认 2000 封 */
  maxBodyReads?: number;
  now?: Date;
}

const DEFAULTS: Required<Omit<DeriveOpts, "now">> = {
  days: 90, maxEmailsPerContact: 5, maxContacts: 300, maxBodyReads: 2000,
};

/** 最多记几个港（再多也没人会给客户发八张价表） */
export const MAX_PREFS = 6;

/** 人工偏好一条值多少分、来信一封值多少分、近 30 天再加多少。
 *  manual=4 高于一封近期来信（2+1）：用户自己在看板登记过的偏好，打平时必须压过从信里猜的。 */
const SCORE_MANUAL = 4;
const SCORE_INBOUND = 2;
const SCORE_RECENT_BONUS = 1;
const RECENT_DAYS = 30;

/**
 * extra.preferredPorts 双形态解析（历史包袱，必须都认）：看板写入时做的是 `JSON.stringify(arr)`，
 * 所以库里它是**一个 JSON 字符串**；导入/AI 写档案也可能直接塞数组。两种都要能读，脏数据不能炸方案。
 */
export function parsePreferredPorts(raw: unknown): Array<{ pol: string; pod: string }> {
  let v: unknown = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try { v = JSON.parse(s); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out: Array<{ pol: string; pod: string }> = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const pol = String(o.pol ?? "").trim();
    const pod = String(o.pod ?? "").trim();
    if (!pod) continue;          // 没目的港的条目没有意义（抽不到港就不记）
    out.push({ pol, pod });
  }
  return out;
}

/**
 * 来信里「标签: 值」的抓法会连整行尾巴一起吃进来：
 *   "Pod: SANTOS (Brazil), 1 x 20GP." / "POD: Santos - BRSSZ, ready cargo 2 x 40HQ"
 * 归一前先本地收紧到「港名那一段」：第一个逗号/分号之前 + 柜型/数量词之前。
 * 刻意不改 parseEmailInquiry —— 它是回信链路的共用解析，动它的影响面另案（规范 §9）。
 */
export function cleanPortSegment(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const head = s.split(/[,;，；]/)[0] ?? s;
  const cut = head.split(/\b\d+\s*[x×*]\s*|\b\d{2}\s*['’]?\s*(?:GP|HQ|HC|NOR|OT|RF)\b/i)[0] ?? head;
  return cut.trim() || null;
}

/**
 * 形态闸门（实锤教训）：来信「标签独行、值在下一行」的形态会把整句、邮件标题甚至签名当成目的港
 * ——「QUICK UPDATE ON SPACE AVAILABLE.」「UMESH SHARMA INTEX GROUP <SALES6@…>」都建过组，
 * 假港不仅污染名单，还会挤掉组数名额。不像港名的字符串一律不收（宁缺毋滥）。
 */
export function plausiblePortToken(word: string): boolean {
  const s = word.trim();
  if (s.length < 3 || s.length > 24) return false;
  if (!/^[A-Z0-9][A-Z0-9 .&'/-]*$/i.test(s)) return false;         // 邮箱/尖括号/冒号等一律拒
  if (/[<>@_;:|]/.test(s)) return false;
  if ((s.match(/[0-9]/g) ?? []).length > 2) return false;          // 真港名极少带三个以上数字
  if (s.split(/\s+/).length > 3) return false;                     // 超过三个词是句子不是港名
  return !/\b(UPDATE|QUOTE|SPACE|ALERT|NOTICE|GROUP|COMPANY|LTD|SRL|SALES|INFO|URGENT|RE)\b|CONGESTI|RETARDOS|PRESENTAN/i.test(s);
}

// 「这词是不是真港」查一次记住（键=大写原词）：每客户偏好只有几个词，缓存够撑一整天
const podKnownCache = new Map<string, string | null>();

/** 台账（含过期行——港的存在性与时效无关）里是否有该目的港 */
function mirrorHasPod(word: string): boolean {
  try {
    const r = listQuotes({ pod: word, includeExpired: true, limit: 1 });
    return !!(r.success && r.data.length);
  } catch { return false; }
}

/** 认证目的港：形态可信 + （词表归一后或原词）台账真有其港；认不出 null，绝不放行脏字符串 */
export function knownPod(word: string | null | undefined): string | null {
  const raw = (word ?? "").trim();
  if (!raw) return null;
  const key = raw.toUpperCase();
  if (podKnownCache.has(key)) return podKnownCache.get(key) ?? null;
  const tryOne = (w: string): string | null =>
    (plausiblePortToken(w) && mirrorHasPod(w)) ? w : null;
  const hit = tryOne(resolveQueryPod(key).trim().toUpperCase()) ?? tryOne(key);
  podKnownCache.set(key, hit);
  return hit;
}

/** 人工登记的港：只过形态闸门 + 词表归一，不查镜像（当期有没有价交给方案层判 no_live_rate） */
export function manualPodName(raw: string | null | undefined): string | null {
  const seg = cleanPortSegment(raw ?? null);
  if (!seg) return null;
  const up = seg.trim().toUpperCase();
  if (!plausiblePortToken(up)) return null;
  return resolveQueryPod(up).trim().toUpperCase() || null;
}

/** 港名归一（来信推断用）：脏段收紧 → 剥 LOCODE/括号 → knownPod 认证；认不出 null，不猜 */
export function normalizePodName(inq: { pod: string | null; podCode: string | null }): string | null {
  if (!inq.pod && !inq.podCode) return null;
  const probe = podQueryWord({ pod: cleanPortSegment(inq.pod), podCode: inq.podCode });
  const byLoCode = inq.podCode ? resolveQueryPod(inq.podCode.toUpperCase()) : null;
  return knownPod(probe) ?? knownPod(byLoCode);
}

/** 人工偏好 → PortPref（同港重复条目合并分数）；导出供单测与详情面板复用 */
export function prefsFromManual(list: Array<{ pol: string; pod: string }>): PortPref[] {
  const map = new Map<string, PortPref>();
  for (const p of list) {
    const pod = manualPodName(p.pod);
    if (!pod) continue;
    const cur = map.get(pod);
    if (cur) {
      cur.score += SCORE_MANUAL;
      if (p.pol && !cur.pol) cur.pol = p.pol;
      continue;
    }
    map.set(pod, {
      pod, pol: p.pol || null, container: null, score: SCORE_MANUAL,
      sources: ["manual"], lastSeenAt: null, hits: 0,
    });
  }
  return [...map.values()];
}

/** related_contact_ids 是 `,12,45,` 这类逗号串（与 crm.service 的 instr 口径同源） */
function parseRelatedIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw.split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
}

function parseExtra(raw: string | null | undefined): Record<string, unknown> {
  try {
    const o = JSON.parse(raw || "{}") as unknown;
    return o && typeof o === "object" ? o as Record<string, unknown> : {};
  } catch { return {}; }
}

type MailRow = {
  id: number; matchedContactId: number | null; relatedContactIds: string | null;
  receivedAt: string; subject: string | null; bodyPreview: string | null;
};

/**
 * 主入口：客户 → 港口偏好（manual ∪ inbound 来信解析）。
 * 本文件只管「这人关心哪些港」——查价、判有没有当期价是 rate-update 方案层的活。
 * @param contactIds 指定客户；省略 = 跟进中的客户（看板口径 reached ∪ replied）
 */
export function deriveCustomerPorts(contactIds?: number[], opts: DeriveOpts = {}): CustomerPorts[] {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - o.days * 86400_000).toISOString();
  const recentCutoff = new Date(now.getTime() - RECENT_DAYS * 86400_000).toISOString();
  const db = getDb();

  // ① 圈人
  const wantIds = contactIds?.length ? new Set(contactIds) : null;
  const companyCol = dsql<string | null>`(select name from companies where companies.id = ${contacts.companyId})`;
  const rows = (wantIds
    ? db.select({
      id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
      language: contacts.language, country: contacts.country, extra: contacts.extra, companyName: companyCol,
    }).from(contacts).where(inArray(contacts.id, [...wantIds]))
    : db.select({
      id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
      language: contacts.language, country: contacts.country, extra: contacts.extra, companyName: companyCol,
    }).from(contacts).where(inArray(contacts.status, ["reached", "replied"]))
  ).limit(o.maxContacts).all();
  if (!rows.length) return [];
  const idSet = new Set(rows.map(r => r.id));

  // ② 一次捞回窗口期内的来信（不按客户逐个查库）：主联系人命中 OR related 含该 id
  const idList = [...idSet];
  // 主联系人命中这批 id；带 related 的邮件整批捞回来由下面按 idSet 精判
  // （不给每个 id 拼一条 instr：客户数上千会撞 SQLite 的变量上限）
  const idMatch = or(inArray(inboxMessages.matchedContactId, idList), isNotNull(inboxMessages.relatedContactIds));
  const notSent = or(isNull(inboxMessages.classification), ne(inboxMessages.classification, "sent"));
  const mails = db.select({
    id: inboxMessages.id, matchedContactId: inboxMessages.matchedContactId,
    relatedContactIds: inboxMessages.relatedContactIds, receivedAt: inboxMessages.receivedAt,
    subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
  }).from(inboxMessages)
    .where(and(notSent, gte(inboxMessages.receivedAt, cutoff), idMatch))
    .orderBy(desc(inboxMessages.receivedAt))
    .limit(3000)
    .all() as MailRow[];

  // ③ 分桶到人（related 的每个 id 都算往来），每人最多 maxEmailsPerContact 封
  const byContact = new Map<number, MailRow[]>();
  for (const m of mails) {
    const targets = new Set<number>();
    if (m.matchedContactId && idSet.has(m.matchedContactId)) targets.add(m.matchedContactId);
    for (const rid of parseRelatedIds(m.relatedContactIds)) if (idSet.has(rid)) targets.add(rid);
    for (const cid of targets) {
      const arr = byContact.get(cid);
      if (arr) { if (arr.length < o.maxEmailsPerContact) arr.push(m); }
      else byContact.set(cid, [m]);
    }
  }

  // ④ 正文：本地全文优先（bodyPreview 只有 500 字，询价要素常在后面），读不到退预览；全文读盘有闸门
  let bodyReads = 0;
  const bodyCache = new Map<number, string>();   // 同一封挂多个联系人时只读一次
  const bodyOf = (m: MailRow): string => {
    const hit = bodyCache.get(m.id);
    if (hit !== undefined) return hit;
    let text = "";
    if (bodyReads < o.maxBodyReads) {
      bodyReads++;
      const full = readLocalBodyHtml(m.id);
      text = full ? htmlToText(full) : (m.bodyPreview ?? "");
    } else {
      text = m.bodyPreview ?? "";
    }
    bodyCache.set(m.id, text);
    return text;
  };

  const out: CustomerPorts[] = [];
  for (const r of rows) {
    const prefs = new Map<string, PortPref>();
    for (const p of prefsFromManual(parsePreferredPorts(parseExtra(r.extra).preferredPorts))) prefs.set(p.pod, p);
    // 每港柜型计数（出现次数多的优先；只出现过一次也认，定价时它只是软条件）
    const containers = new Map<string, Map<string, number>>();

    for (const m of byContact.get(r.id) ?? []) {
      const inq = parseEmailInquiry(bodyOf(m));
      const pod = normalizePodName({ pod: inq.pod, podCode: inq.podCode });
      if (!pod) continue;                     // 这封信没提到港 → 不记
      const gain = SCORE_INBOUND + (m.receivedAt >= recentCutoff ? SCORE_RECENT_BONUS : 0);
      const polRaw = cleanPortSegment(inq.pol) || inq.polCode || null;
      const cur = prefs.get(pod);
      if (cur) {
        cur.score += gain;
        cur.hits += 1;
        if (!cur.sources.includes("inbound")) cur.sources.push("inbound");
        if (!cur.lastSeenAt || cur.lastSeenAt < m.receivedAt) cur.lastSeenAt = m.receivedAt;
        if (polRaw && !cur.pol) cur.pol = polRaw;
      } else {
        prefs.set(pod, {
          pod, pol: polRaw, container: null, score: gain,
          sources: ["inbound"], lastSeenAt: m.receivedAt, hits: 1,
        });
      }
      const c = normalizeContainer(inq.container);
      if (c) {
        const per = containers.get(pod) ?? new Map<string, number>();
        per.set(c, (per.get(c) ?? 0) + 1);
        containers.set(pod, per);
      }
    }

    for (const [pod, per] of containers) {
      const p = prefs.get(pod);
      if (!p) continue;
      let best: { v: string; n: number } | null = null;
      for (const [v, n] of per) if (!best || n > best.n) best = { v, n };
      if (best) p.container = best.v;
    }

    const list = [...prefs.values()]
      .sort((a, b) => b.score - a.score || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))
      .slice(0, MAX_PREFS);
    out.push({
      contactId: r.id, email: r.email,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
      companyName: r.companyName ?? null,
      language: r.language ?? null, country: r.country ?? null,
      prefs: list,
    });
  }
  return out;
}

/** 单客户的来信推断偏好（详情面板「从近 N 天来信推断」只读展示用） */
export function derivedPortsFor(contactId: number, opts: DeriveOpts = {}): PortPref[] {
  return deriveCustomerPorts([contactId], opts)[0]?.prefs ?? [];
}
