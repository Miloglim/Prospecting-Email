import * as crypto from "crypto";
const nanoid = () => crypto.randomUUID().slice(0, 12);
import { getDb } from "../db";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { inboxMessages } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { eq, sql as dsql, desc, inArray } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";
import { sendQueue } from "../db/schema/send-queue";
import { EVENTS } from "../events";
import { loadConfig, DEFAULT_SCHEDULE } from "../config";
import { writeBodyForLastInsert } from "./inbox.service";
import { assembleEmail, type Lang, type ClientType, type Stage } from "./sentence-library";


// ── 类型 ──

export interface SendItem {
  id: string; companyName: string; companyId: number;
  recipients: Array<{ contactId: number; email: string; name: string }>;
  accountId: number;
  subject: string;   // 渲染后的主题（小，提前渲染）
  tplBody: string;   // 正文模板快照（含变量/随机词，发送时组装）
  contactVars: TemplateVars;  // 首联系人渲染变量
  tplName?: string;  // 该组采用的模板名（卡片展示；句库/即时/动态为来源标签）
  country?: string;  // 公司国家（卡片标签；company.country 优先，回落首联系人 country）
  language?: string; // 语言（卡片标签；取首联系人 language，与开发信语言一致）
  status: "pending" | "sending" | "sent" | "failed";
  error?: string; sentAt?: string;
  seq?: number;  // 原始队列顺序（跨账号排序用）
  cc?: string;   // 抄送地址，逗号分隔。收件人仍走 BCC 互不可见，抄送方在 CC 里对客户可见
}

export interface SendTemplate {
  name?: string;  // 模板名（卡片展示用；即时撰写等场景可传来源标签）
  subject: string;  // 含 {{firstName}} {{company}} 变量
  body: string;
  category?: string; // 受众：direct / peer / general
  stage?: string;    // 阶段：initial / followup1 / followup2 / closing / reactivate
  language?: string; // EN / ES / PT
}

export interface TimeBucket {
  key: string; label: string; description: string;
  contacts: { id: number }[]; count: number;
}

export interface SendStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: SendItem | null; delaySeconds: number;
  /** 本次等待的结束时刻（ISO）。delaySeconds 是固定总时长，前端离开页面后本地倒计时会丢，
   *  必须用绝对时间戳才能算出真实剩余；无等待时为 null。 */
  delayUntil: string | null;
  accountStats: Array<{
    accountId: number; email: string; sent: number; failed: number; total: number;
    remaining?: { hourly: number; daily: number };
    isCircuitOpen: boolean;
  }>;
}

const BUCKET_DEFS = [
  { key: "never", label: "从未发送", desc: "新联系人，无发送记录" },
  { key: "reached", label: "已触达", desc: "已发送，等待回复" },
  { key: "replied", label: "已回复", desc: "对方已回复，可跟进" },
  { key: "autoreply", label: "自动回复", desc: "收到 OOO，暂缓发送" },
  { key: "bounced", label: "退信", desc: "邮箱无效或退回" },
] as const;

// ── 引擎状态 ──

let state: SendStatus = {
  batchId: null, totalItems: 0, sentCount: 0, failedCount: 0,
  isPaused: false, isRunning: false, currentItem: null, delaySeconds: 0, delayUntil: null, accountStats: [],
};

// ── 全局发信限额（持久化到 config，24h 计时不可丢失）──

function getQuota() {
  const cfg = loadConfig();
  return cfg.sendQuota || { dailyLimit: 0, firstSendAt: null, sentToday: 0 };
}

function saveQuota(q: { dailyLimit: number; firstSendAt: string | null; sentToday: number }) {
  const cfg = loadConfig();
  saveConfigFn({ ...cfg, sendQuota: q });
}

/** 保存 config 的函数引用（由 transport 注入，避免循环依赖） */
import type { RuntimeConfig } from "../config";
let saveConfigFn: (c: RuntimeConfig) => void = () => {};
export function setSaveConfigFn(fn: (c: RuntimeConfig) => void) { saveConfigFn = fn; }
export function getQuotaStatus(): ReturnType<typeof checkQuota> { return checkQuota(); }

/** 检查全局日限额，24h 自动重置 */
function checkQuota(): { ok: boolean; remaining: number; reason?: string } {
  const quota = getQuota();
  if (quota.dailyLimit <= 0) return { ok: true, remaining: -1 }; // 0=不限

  const now = new Date();
  // 首次发送 → 开始计时
  if (!quota.firstSendAt) return { ok: true, remaining: quota.dailyLimit };

  const first = new Date(quota.firstSendAt);
  const elapsed = now.getTime() - first.getTime();
  const H24 = 24 * 3600 * 1000;

  // 超过24h → 重置
  if (elapsed >= H24) {
    const next = { dailyLimit: quota.dailyLimit, firstSendAt: null, sentToday: 0 };
    saveQuota(next);
    return { ok: true, remaining: quota.dailyLimit };
  }

  const remaining = quota.dailyLimit - quota.sentToday;
  if (remaining <= 0) {
    const resetAt = new Date(first.getTime() + H24);
    return { ok: false, remaining: 0, reason: `已达今日限额，${resetAt.toLocaleTimeString("zh-CN")} 重置` };
  }
  return { ok: true, remaining };
}

/** 记录发送（持久化）。按封数（收件人数）计，不是按组 — 一组 BCC 最多 20 封，按组计限额会超发 20 倍 */
function recordQuotaSend(count: number): void {
  const quota = getQuota();
  if (quota.dailyLimit <= 0) return;
  const now = new Date().toISOString();
  const next = {
    dailyLimit: quota.dailyLimit,
    firstSendAt: quota.firstSendAt || now,
    sentToday: (quota.sentToday || 0) + Math.max(1, count),
  };
  saveQuota(next);
}

let pushFn: ((c: string, d: unknown) => void) | null = null;
export function setPushFn(fn: (c: string, d: unknown) => void) { pushFn = fn; }
function push(c: string, d: unknown) { try { pushFn?.(c, d); } catch { /* */ } }

let sendBccFn: ((item: SendItem & { body: string }) => Promise<Result<{ messageId: string | null }>>) | null = null;
export function setSendBccFn(fn: (item: SendItem & { body: string }) => Promise<Result<{ messageId: string | null }>>) { sendBccFn = fn; }

// ── 可中断延迟 ──

let delayTimer: ReturnType<typeof setTimeout> | null = null;
let delayResolve: ((ok: boolean) => void) | null = null;
let delayStarted = 0;
let delayRemaining = 0;

function sleep(ms: number): Promise<boolean> {
  return new Promise(resolve => {
    delayRemaining = ms; delayStarted = Date.now();
    delayResolve = resolve;
    delayTimer = setTimeout(() => { delayResolve = null; delayTimer = null; delayRemaining = 0; resolve(true); }, ms);
  });
}

export function pauseDelay() {
  if (!delayTimer) return;
  clearTimeout(delayTimer); delayTimer = null;
  delayRemaining -= (Date.now() - delayStarted);
  if (delayRemaining < 0) delayRemaining = 0;
}

export function resumeDelay() {
  if (!delayResolve || delayRemaining <= 0) return;
  delayStarted = Date.now();
  delayTimer = setTimeout(() => { const r = delayResolve; delayResolve = null; delayTimer = null; delayRemaining = 0; r?.(true); }, delayRemaining);
}

// ── 时间桶计算 ──

export function getTimeBuckets(): Result<TimeBucket[]> {
  const db = getDb();
  const allContacts = db.select().from(contacts).all();

  // 有发送记录的人（判断"从未发送"用）
  const sentSet = new Set(
    db.select({ contactId: interactions.contactId })
      .from(interactions).where(eq(interactions.type, "sent"))
      .groupBy(interactions.contactId).all()
      .map(r => r.contactId)
  );

  const buckets = new Map<string, ContactRow[]>();
  BUCKET_DEFS.forEach(b => buckets.set(b.key, []));

  for (const c of allContacts) {
    const st = c.status || "";
    if (st === "bounced") { buckets.get("bounced")!.push(c); continue; }
    if (st === "autoreply") { buckets.get("autoreply")!.push(c); continue; }
    if (st === "replied") { buckets.get("replied")!.push(c); continue; }
    if (st === "reached") { buckets.get("reached")!.push(c); continue; }
    // 无 status → 从未发送
    if (!sentSet.has(c.id)) { buckets.get("never")!.push(c); continue; }
    // 其他情况（极少）→ 兜底到已触达
    buckets.get("reached")!.push(c);
  }

  return okResult(BUCKET_DEFS.map(b => ({
    key: b.key, label: b.label, description: b.desc,
    contacts: (buckets.get(b.key) || []).map(c => ({ id: c.id })), count: (buckets.get(b.key) || []).length,
  })));
}

// ── 阶段桶（按 contacts.stage 分组）──

const STAGE_BUCKET_DEFS = [
  // label 与 renderer 的 STAGE_META 保持一致（Cold/F1…），解释放 desc
  { key: "cold", label: "Cold", desc: "从未发送过邮件" },
  { key: "f1", label: "F1", desc: "已发第1封开发信" },
  { key: "f2", label: "F2", desc: "已发第2封跟进" },
  { key: "f3", label: "F3", desc: "已发第3封跟进" },
  { key: "f4", label: "F4", desc: "已发4封及以上" },
];

export function getStageBuckets(): Result<TimeBucket[]> {
  const db = getDb();
  const allContacts = db.select().from(contacts).all();
  const buckets = new Map<string, ContactRow[]>();
  STAGE_BUCKET_DEFS.forEach(b => buckets.set(b.key, []));

  for (const c of allContacts) {
    if (c.status === "reached") continue; // 已触达不进发送阶段桶
    const stage = c.stage || "cold";
    if (buckets.has(stage)) buckets.get(stage)!.push(c);
    else buckets.get("cold")!.push(c);
  }

  return okResult(STAGE_BUCKET_DEFS.map(b => ({
    key: b.key, label: b.label, description: b.desc,
    contacts: (buckets.get(b.key) || []).map(c => ({ id: c.id })), count: (buckets.get(b.key) || []).length,
  })));
}

// ── 最后发送时间桶 ──

const SEND_TIME_BUCKET_DEFS = [
  { key: "today", label: "今天", desc: "过去24小时内发送" },
  { key: "1day", label: "1天", desc: "1天前发送" },
  { key: "2days", label: "2天", desc: "2天前发送" },
  { key: "3-5days", label: "3-5天", desc: "3-5天前发送" },
  { key: "6-10days", label: "6-10天", desc: "6-10天前发送" },
  { key: "older", label: "更早", desc: "超过10天前发送" },
];

export function getSendTimeBuckets(): Result<TimeBucket[]> {
  const db = getDb();
  const allContacts = db.select().from(contacts).all();
  const now = Date.now();

  // 查每个联系人的最后一次发送时间
  const lastSent = new Map<number, number>();
  const sentRows = db.select({
    contactId: interactions.contactId,
    createdAt: interactions.createdAt,
  }).from(interactions)
    .where(eq(interactions.type, "sent"))
    .orderBy(desc(interactions.createdAt))
    .all();
  for (const r of sentRows) {
    if (!lastSent.has(r.contactId)) {
      lastSent.set(r.contactId, new Date(r.createdAt).getTime());
    }
  }

  const buckets = new Map<string, ContactRow[]>();
  SEND_TIME_BUCKET_DEFS.forEach(b => buckets.set(b.key, []));

  for (const c of allContacts) {
    if (c.status === "reached") continue; // 已触达不进最后发送时间桶
    const ts = lastSent.get(c.id);
    if (!ts) continue; // 无发送记录 → 不显示（按客户状态的已触达已覆盖）
    const days = (now - ts) / 86400000;
    if (days < 1) buckets.get("today")!.push(c);
    else if (days < 2) buckets.get("1day")!.push(c);
    else if (days < 3) buckets.get("2days")!.push(c);
    else if (days <= 5) buckets.get("3-5days")!.push(c);
    else if (days <= 10) buckets.get("6-10days")!.push(c);
    else buckets.get("older")!.push(c);
  }

  return okResult(SEND_TIME_BUCKET_DEFS.map(b => ({
    key: b.key, label: b.label, description: b.desc,
    contacts: (buckets.get(b.key) || []).map(c => ({ id: c.id })), count: (buckets.get(b.key) || []).length,
  })));
}

// ── 模板渲染（沿用旧 PE: {{firstName}} {{company}}，兼容 {{ contact.firstName }}）──

interface TemplateVars {
  firstName?: string | null;
  lastName?: string | null;
  company?: string;
  email: string;
  title?: string | null;
  phone?: string | null;
}

function renderTemplate(template: string, contact: TemplateVars): string {
  let out = template || "";
  const vars: Record<string, string> = {
    firstName: contact.firstName || "",
    lastName: contact.lastName || "",
    company: contact.company || "",
    email: contact.email,
    title: contact.title || "",
    phone: contact.phone || "",
  };

  for (const [key, val] of Object.entries(vars)) {
    // 函数替换：值里含 $& $' 等 replace 特殊序列时不能被解释（公司名/签名里的价格会被弄脏）
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi"), () => val);
    out = out.replace(new RegExp(`\\{\\{\\s*contact\\.${key}\\s*\\}\\}`, "gi"), () => val);
  }

  // 随机词/短语：{optionA|optionB|optionC} → 每次渲染随机选一个
  out = out.replace(/\{([^{}|]+\|[^{}]+)\}/g, (_match, choices: string) => {
    const opts = choices.split("|");
    return opts[Math.floor(Math.random() * opts.length)]!;
  });

  // 清理未替换的变量
  out = out.replace(/\{\{\s*[a-zA-Z_.]+\s*\}\}/g, "");
  return out;
}

export { renderTemplate };
export type { TemplateVars };

// ── 联系人 stage → 模板 stage 映射 ──
const STAGE_MAP: Record<string, string> = {
  cold: "initial", f1: "followup1", f2: "followup2", f3: "closing", f4: "reactivate",
};

// 已触达的人不能进开发信发送桶（跟进走客户跟进界面，避免给已触达客户发开发信）
const EXCLUDED_STATUSES = ["reached"];

/** 入队前过滤无效邮箱联系人：一个坏地址会让整组 BCC 被 SMTP 整批拒收（凑 3 组就熔断）。
 *  返回过滤后的联系人 + 剔除数（调用方记日志）。 */
function filterValidEmails(rows: ContactRow[]): { kept: ContactRow[]; removed: number } {
  const kept = rows.filter(c => isValidEmail(c.email || ""));
  return { kept, removed: rows.length - kept.length };
}

// ── 联系人 clientType → 模板 category 映射 ──
function mapClientType(ct: string): string {
  const v = (ct || "").toLowerCase();
  if (v === "direct") return "direct";
  if (v === "agent" || v === "peer") return "peer";
  return "general";
}

// ── 模板匹配：类型 → 阶段 → 通用 → 随机 ──
function pickTemplate(tpls: SendTemplate[], contact: ContactRow): SendTemplate {
  if (tpls.length === 1) return tpls[0]!;

  // 给每个模板打分：category 匹配 +2，stage 匹配 +1
  const targetCat = mapClientType(contact.clientType || "");
  const targetStage = STAGE_MAP[contact.stage || ""] || "initial";

  const scored = tpls.map(t => {
    let score = 0;
    const tCat = (t.category || "").toLowerCase();
    const tStage = (t.stage || "").toLowerCase();

    if (tCat === targetCat) score += 2;
    else if (tCat === "general" || !t.category) score += 0; // 兜底

    if (tStage === targetStage) score += 1;

    return { t, score };
  });

  // 取最高分
  scored.sort((a, b) => b.score - a.score);
  const bestScore = scored[0]!.score;
  const candidates = scored.filter(s => s.score === bestScore).map(s => s.t);

  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

// ── 构建队列（按公司合并 BCC + 渲染模板，每组随机选模板）──

/** 解析本次发信的联系人 id 集合：contactIds 直选优先（新选人表格路径），否则按分桶 key 展开（兼容旧路径） */
function resolveSelectedIds(bucketKeys: string[], contactIds?: number[]): Set<number> {
  if (contactIds && contactIds.length > 0) return new Set(contactIds);
  const ids = new Set<number>();
  for (const br of [getTimeBuckets(), getStageBuckets(), getSendTimeBuckets()]) {
    if (!br.success) continue;
    for (const b of br.data) {
      if (bucketKeys.includes(b.key)) for (const c of b.contacts) ids.add(c.id);
    }
  }
  return ids;
}

export function buildQueue(bucketKeys: string[], templates?: SendTemplate[], contactIds?: number[]): Result<SendItem[]> {
  // 三个维度（状态/阶段/发送时间）收集选中联系人 id —— 桶查询只返回 id，避免传输完整联系人；contactIds 直选时跳过桶展开
  const selectedIds = resolveSelectedIds(bucketKeys, contactIds);
  if (selectedIds.size === 0) return failResult("没有选中的联系人");

  // 用 id 一次查完整联系人（供模板渲染）
  const selected = new Map<number, ContactRow>();
  const selectedRows = getDb().select().from(contacts).where(inArray(contacts.id, [...selectedIds])).all();
  for (const c of selectedRows) {
    if (EXCLUDED_STATUSES.includes(c.status || "")) continue; // 已触达不进开发信
    selected.set(c.id, c);
  }
  const { kept: validRows, removed: badEmails } = filterValidEmails([...selected.values()]);
  if (badEmails > 0) Log.warn("send.filter", `buildQueue 剔除 ${badEmails} 个无效邮箱联系人`);
  const valid = new Map(validRows.map(c => [c.id, c]));

  const companyGroups = new Map<string, ContactRow[]>();
  for (const c of valid.values()) {
    const k = `c_${c.companyId || 0}`;
    if (!companyGroups.has(k)) companyGroups.set(k, []);
    companyGroups.get(k)!.push(c);
  }

  // 查公司名（用于 {{company}} 变量）+ 公司国家（卡片标签）
  const companyMap = new Map<number, string>();
  const companyCountryMap = new Map<number, string>();
  if (valid.size > 0) {
    const companyRows = getDb().select().from(companies).all();
    for (const comp of companyRows) {
      companyMap.set(comp.id, comp.name);
      if (comp.country) companyCountryMap.set(comp.id, comp.country);
    }
  }

  const userTpls = (templates?.filter(t => t?.subject && t?.body) || []);
  if (userTpls.length === 0) return failResult("请先选择至少一个邮件模板");

  // 预分配账号（供预览展示，与正式发送同一套轮换规则）；正式发送时 startQueue 会重新精确分配
  const activeAccounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  const activeIds = activeAccounts.map(a => a.id);

  const groupSize = Math.max(1, loadConfig().schedule?.groupSize || 20);
  const items: SendItem[] = [];

  // 公司按人数降序（多的先发）、同人数按公司名 A-Z；公司内联系人按姓名 A-Z
  const sortedCompanies = [...companyGroups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    const nameA = companyMap.get(a[1][0]?.companyId || 0) || "";
    const nameB = companyMap.get(b[1][0]?.companyId || 0) || "";
    return nameA.localeCompare(nameB);
  });

  for (const [, group] of sortedCompanies) {
    const sorted = [...group].sort((a, b) => {
      const nameA = [a.firstName, a.lastName].filter(Boolean).join(" ").toLowerCase();
      const nameB = [b.firstName, b.lastName].filter(Boolean).join(" ").toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const first = sorted[0]!;
    const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";
    const t = pickTemplate(userTpls, first);
    const contactVars: TemplateVars = {
      firstName: first.firstName, lastName: first.lastName,
      company: companyName, email: first.email,
      title: first.title, phone: first.phone,
    };
    const subj = renderTemplate(t.subject, contactVars);

    // 同公司超 groupSize 拆多组（BCC 每组上限 N 人）
    for (let s = 0; s < sorted.length; s += groupSize) {
      const chunk = sorted.slice(s, s + groupSize);
      const aid = activeIds.length > 0 ? rotateAccountId(items.length, activeIds) : 0; // 逐组轮换，预览=真实分配

      items.push({
        id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
        companyId: first.companyId || 0,
        recipients: chunk.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
        subject: subj, tplBody: t.body, contactVars, tplName: t.name,
        country: companyCountryMap.get(first.companyId || 0) || first.country || undefined,
        language: first.language || undefined,
        accountId: aid, status: "pending",
      });
    }
  }
  return okResult(items);
}

function normalizeLang(l: string | null | undefined): Lang {
  const v = (l || "EN").toUpperCase();
  return v === "ES" || v === "PT" ? v : "EN";
}

const VALID_STAGES: Stage[] = ["initial", "followup1", "followup2", "closing", "reactivate"];

/** 句库预览：按语言/客户类型/阶段组装一封（{{company}} 用占位词替换展示） */
export function previewSentence(lang: string, clientType: string, stage: string): Result<{ subject: string; body: string }> {
  const s: Stage = (VALID_STAGES as string[]).includes(stage) ? (stage as Stage) : "initial";
  const l = normalizeLang(lang);
  const ct = mapClientType(clientType) as ClientType;
  const r = assembleEmail({
    lang: l,
    clientType: ct,
    stage: s,
    includeCompany: true,
    subjectOverride: loadConfig().sentenceSubjects?.[`${ct}.${l}`] || undefined,
  });
  r.body = r.body.replace(/\{\{\s*company\s*\}\}/gi, "your company");
  return okResult(r);
}

/** 自适应模式：无模板时用组件句库组装（按公司 BCC 分组，每组随机组装） */
export function buildAdaptiveQueue(bucketKeys: string[], contactIds?: number[]): Result<SendItem[]> {
  const selectedIds = resolveSelectedIds(bucketKeys, contactIds);
  if (selectedIds.size === 0) return failResult("没有选中的联系人");

  const selected = new Map<number, ContactRow>();
  const selectedRows = getDb().select().from(contacts).where(inArray(contacts.id, [...selectedIds])).all();
  for (const c of selectedRows) {
    if (EXCLUDED_STATUSES.includes(c.status || "")) continue; // 已触达不进开发信
    selected.set(c.id, c);
  }
  const { kept: validRows, removed: badEmails } = filterValidEmails([...selected.values()]);
  if (badEmails > 0) Log.warn("send.filter", `buildAdaptiveQueue 剔除 ${badEmails} 个无效邮箱联系人`);

  const companyGroups = new Map<string, ContactRow[]>();
  for (const c of validRows) {
    const k = `c_${c.companyId || 0}`;
    if (!companyGroups.has(k)) companyGroups.set(k, []);
    companyGroups.get(k)!.push(c);
  }

  const companyMap = new Map<number, string>();
  const companyCountryMap = new Map<number, string>();
  for (const comp of getDb().select().from(companies).all()) {
    companyMap.set(comp.id, comp.name);
    if (comp.country) companyCountryMap.set(comp.id, comp.country);
  }

  const activeIds = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all().map(a => a.id);
  const groupSize = Math.max(1, loadConfig().schedule?.groupSize || 20);
  const items: SendItem[] = [];

  // 公司按人数降序、同人数按公司名 A-Z；公司内联系人按姓名 A-Z
  const sortedCompanies = [...companyGroups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    const nameA = companyMap.get(a[1][0]?.companyId || 0) || "";
    const nameB = companyMap.get(b[1][0]?.companyId || 0) || "";
    return nameA.localeCompare(nameB);
  });

  for (const [, group] of sortedCompanies) {
    const sorted = [...group].sort((a, b) => {
      const nameA = [a.firstName, a.lastName].filter(Boolean).join(" ").toLowerCase();
      const nameB = [b.firstName, b.lastName].filter(Boolean).join(" ").toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const first = sorted[0]!;
    const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";
    const l = normalizeLang(first.language);
    const ct = mapClientType(first.clientType || "") as ClientType;
    const assembled = assembleEmail({
      lang: l,
      clientType: ct,
      stage: (STAGE_MAP[first.stage || ""] || "initial") as Stage,
      includeCompany: !!companyName,
      subjectOverride: loadConfig().sentenceSubjects?.[`${ct}.${l}`] || undefined,
    });

    for (let s = 0; s < sorted.length; s += groupSize) {
      const chunk = sorted.slice(s, s + groupSize);
      items.push({
        id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
        companyId: first.companyId || 0,
        recipients: chunk.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
        subject: assembled.subject, tplBody: assembled.body,
        contactVars: { firstName: first.firstName, lastName: first.lastName, company: companyName, email: first.email, title: first.title, phone: first.phone },
        tplName: `预设句库·${l}·${ct}`,
        country: companyCountryMap.get(first.companyId || 0) || first.country || undefined,
        language: l,
        accountId: activeIds.length > 0 ? rotateAccountId(items.length, activeIds) : 0, status: "pending",
      });
    }
  }
  return okResult(items);
}

// ── 多账号并行发送 ──

/** 为一组邮件挑发信账号：亲和账号（该客户上次用的）未超载就用它，超了改投当前最闲的。
 *  纯函数，无副作用 —— 防的是"历史集中在某账号的联系人把整批压给它 → 连续猛发被限流"。 */
export function pickAccountId(preferredAid: number | undefined, load: Map<number, number>, cap: number): number {
  if (preferredAid != null && (load.get(preferredAid) ?? 0) < cap) return preferredAid;
  return [...load.entries()].reduce((min, e) => (e[1] < min[1] ? e : min))[0]!;
}

/** 按剩余额度（封=收件人数）裁剪队列：整组保留或整组丢弃，不拆 BCC 组。
 *  budget=-1 表示不限。返回保留的组、保留的收件人数、丢弃组数。纯函数，可单测。 */
export function trimByBudget<T extends { recipients: Array<{ email: string }> }>(
  items: T[],
  budget: number,
): { kept: T[]; keptCount: number; dropped: number } {
  if (budget < 0) return { kept: items, keptCount: items.reduce((s, it) => s + it.recipients.length, 0), dropped: 0 };
  const kept: T[] = [];
  let used = 0;
  for (const it of items) {
    const n = it.recipients.length;
    if (used + n > budget) break; // 按顺序整组保留；超预算的组（含后续）整组丢弃
    kept.push(it);
    used += n;
  }
  return { kept, keptCount: used, dropped: items.length - kept.length };
}

/** 收件人邮箱格式校验（与 send.ipc CC 校验同一条规则）：一个坏地址会让整组被 SMTP 拒收 */
export function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** 账号轮换：第 i 组取 accountIds[i % n] — 串行调度按 seq 逐组发，相邻两组必落到不同账号
 *  （≥2 账号时），替代旧"联系人亲和"：亲和会让历史客户永远固定在同一账号发信。
 *  纯函数，可单测。 */
export function rotateAccountId(index: number, accountIds: number[]): number {
  return accountIds[((index % accountIds.length) + accountIds.length) % accountIds.length]!;
}

let queues: Map<number, SendItem[]> = new Map();
let abortFlag = false; // 串行模型：单一批次中断标志（旧 per-account abortFlags map 已废弃）

/** 公共发送入口：配额守卫 → 账号分配 → 限额裁剪 → 持久化 → 启动发送循环。
 *  autoStart=false 时只入队落库、不发一封（对齐旧 PE 两步式：加入队列 → 队列页手动开始）。
 *  返回 { batchId, queued(组), queuedCount(封), dropped(组) } — 前端据此提示裁剪。 */
async function startQueue(items: SendItem[], autoStart = true): Promise<Result<{ batchId: string; queued: number; queuedCount: number; dropped: number }>> {
  if (state.isRunning) return failResult("已有发送任务运行中");
  if (items.length === 0) return failResult("没有待发送项");

  const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  if (accounts.length === 0) return failResult("没有可用的发件账号");

  // ① 配额守卫放最前 — 失败时什么都不动（后置会把 state 污染成永远 isRunning 的幽灵批次）
  const qCheck = checkQuota();
  if (!qCheck.ok) return failResult(qCheck.reason || "已达全局发信限额");

  const batchId = nanoid();

  // ② 账号轮换：第 i 组 → 第 i%N 个活跃账号。串行调度按 seq 逐组发，相邻两组必是不同账号，
  // 整批负载也天然均匀。旧"联系人亲和"（历史谁发就一直谁发）已按用户要求废弃。
  queues = new Map();
  abortFlag = false;
  const activeIds = accounts.map(a => a.id);
  const ordered: Array<SendItem & { seq: number }> = [];
  for (let i = 0; i < items.length; i++) {
    ordered.push({ ...items[i]!, accountId: rotateAccountId(i, activeIds), seq: i });
  }
  const rotLoad = new Map<number, number>();
  for (const it of ordered) rotLoad.set(it.accountId, (rotLoad.get(it.accountId) ?? 0) + 1);
  Log.info("send.alloc", `轮换: ${activeIds.length} 账号 → ` + [...rotLoad.entries()].map(([id, n]) => `#${id}:${n}组`).join(" "));

  // ③ 限额裁剪（按封数，整组保留）— 在写 state 之前，totalItems 才与实际发送数一致，进度条才能到 100%
  const { kept, keptCount, dropped } = trimByBudget(ordered, qCheck.remaining);
  if (dropped > 0) Log.warn("send.quota", `限额裁剪: ${items.length} 组/${items.reduce((s, it) => s + it.recipients.length, 0)} 封 → ${kept.length} 组/${keptCount} 封`);
  for (const it of kept) {
    if (!queues.has(it.accountId)) queues.set(it.accountId, []);
    queues.get(it.accountId)!.push(it);
  }

  // ④ 写 state — 基于裁剪后的数据
  state = {
    batchId, totalItems: kept.length, sentCount: 0, failedCount: 0,
    isPaused: false, isRunning: autoStart, currentItem: null, delaySeconds: 0, delayUntil: null,
    accountStats: accounts.map(a => {
      const total = queues.get(a.id)?.length || 0;
      return { accountId: a.id, email: a.email, sent: 0, failed: 0, total, isCircuitOpen: false };
    }),
  };

  try {
    getDb().delete(sendQueue).run();
    const now = new Date().toISOString();
    const rows: any[] = [];
    for (const [aid, q] of queues) {
      const acctEmail = accounts.find(a => a.id === aid)?.email || "";
      for (const item of q) {
        rows.push({
          id: item.id, batchId, companyName: item.companyName, companyId: item.companyId,
          recipients: JSON.stringify(item.recipients),
          accountId: aid, accountEmail: acctEmail,
          subject: item.subject, tplBody: item.tplBody, contactVars: JSON.stringify(item.contactVars),
          tplName: item.tplName || null,
          country: item.country || null, language: item.language || null,
          cc: item.cc || null,
          status: "pending", createdAt: now,
        });
      }
    }
    for (let i = 0; i < rows.length; i += 200) {
      getDb().insert(sendQueue).values(rows.slice(i, i + 200)).run();
    }
    saveDatabase();
  } catch (err) {
    Log.warn("send.queuePersist", `写入发送队列表失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!autoStart) {
    Log.info("send.enqueue", `批次 ${batchId}: ${kept.length} 组已入队，等待用户在队列页手动开始`);
    return okResult({ batchId, queued: kept.length, queuedCount: keptCount, dropped });
  }

  Log.info("send.start", `批次 ${batchId}: ${kept.length} 组, ${accounts.length} 账号（全局串行）`);
  void runBatchLoop();
  return okResult({ batchId, queued: kept.length, queuedCount: keptCount, dropped });
}

/** 入队结果：batchId + 入队规模 + 配额裁剪掉的组数（前端据此提示） */
export interface EnqueueResult {
  batchId: string;
  queued: number;      // 实际入队组数
  queuedCount: number; // 实际入队封数（收件人数）
  dropped: number;     // 因限额被整组丢弃的组数
}

export async function startSend(bucketKeys: string[], templates?: SendTemplate[], autoStart = true, contactIds?: number[]): Promise<Result<EnqueueResult>> {
  Log.debug("send.start", `buckets=${bucketKeys.join(",")} templates=${templates?.length || 0} autoStart=${autoStart} directIds=${contactIds?.length || 0}`);
  const qr = templates && templates.length > 0 ? buildQueue(bucketKeys, templates, contactIds) : buildAdaptiveQueue(bucketKeys, contactIds);
  if (!qr.success) return failResult(qr.error);
  return startQueue(qr.data, autoStart);
}

/** 动态更新：按选中的客户跟进联系人 + 手动内容组装队列 */
export function buildDynamicQueue(contactIds: number[], subject: string, body: string, cc?: string): Result<SendItem[]> {
  const rows = getDb().select().from(contacts).where(inArray(contacts.id, contactIds)).all();
  if (rows.length === 0) return failResult("没有选中的联系人");

  // 过滤无效邮箱（一个坏地址整组被拒收）
  const { kept: validRows, removed: badEmails } = filterValidEmails(rows);
  if (badEmails > 0) Log.warn("send.filter", `buildDynamicQueue 剔除 ${badEmails} 个无效邮箱联系人`);
  if (validRows.length === 0) return failResult("所选联系人均无有效邮箱");

  const companyGroups = new Map<string, ContactRow[]>();
  for (const c of validRows) {
    const k = `c_${c.companyId || 0}`;
    if (!companyGroups.has(k)) companyGroups.set(k, []);
    companyGroups.get(k)!.push(c);
  }

  const companyMap = new Map<number, string>();
  const companyCountryMap = new Map<number, string>();
  for (const comp of getDb().select().from(companies).all()) {
    companyMap.set(comp.id, comp.name);
    if (comp.country) companyCountryMap.set(comp.id, comp.country);
  }

  const activeIds = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all().map(a => a.id);
  const groupSize = Math.max(1, loadConfig().schedule?.groupSize || 20);
  const items: SendItem[] = [];

  const sortedCompanies = [...companyGroups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    const nameA = companyMap.get(a[1][0]?.companyId || 0) || "";
    const nameB = companyMap.get(b[1][0]?.companyId || 0) || "";
    return nameA.localeCompare(nameB);
  });

  for (const [, group] of sortedCompanies) {
    const sorted = [...group].sort((a, b) => {
      const nameA = [a.firstName, a.lastName].filter(Boolean).join(" ").toLowerCase();
      const nameB = [b.firstName, b.lastName].filter(Boolean).join(" ").toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const first = sorted[0]!;
    const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";

    for (let s = 0; s < sorted.length; s += groupSize) {
      const chunk = sorted.slice(s, s + groupSize);
      items.push({
        id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
        companyId: first.companyId || 0,
        recipients: chunk.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
        subject, tplBody: body,
        contactVars: { firstName: first.firstName, lastName: first.lastName, company: companyName, email: first.email, title: first.title, phone: first.phone },
        tplName: "动态更新",
        country: companyCountryMap.get(first.companyId || 0) || first.country || undefined,
        language: first.language || undefined,
        accountId: activeIds.length > 0 ? rotateAccountId(items.length, activeIds) : 0, status: "pending",
        ...(cc ? { cc } : {}),
      });
    }
  }
  return okResult(items);
}

export async function startDynamicSend(contactIds: number[], subject: string, body: string, autoStart = true, cc?: string): Promise<Result<EnqueueResult>> {
  const qr = buildDynamicQueue(contactIds, subject, body, cc);
  if (!qr.success) return failResult(qr.error);
  return startQueue(qr.data, autoStart);
}

// 检查时间窗口（北京时间）
function inWindow(sched: typeof DEFAULT_SCHEDULE): boolean {
  if (!sched.timeWindowEnabled) return true;
  const h = new Date(Date.now() + 8 * 3600000).getUTCHours(); // 北京时
  return sched.startHour < sched.endHour
    ? h >= sched.startHour && h < sched.endHour
    : h >= sched.startHour || h < sched.endHour;
}

function randBetween(min: number, max: number): number {
  if (max <= min) return min * 1000;
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

// ── 全局串行发送循环 ──
// 单调度器按 seq 顺序逐组发送：发 1 组 → 组间暂停 → 下一组。
// 旧实现是每账号一个并行循环：多账号同秒发首组（组间暂停只在各账号内部生效，同公司拆组被连发），
// 且 currentItem/delayUntil/sleep 定时器都是全局单值，被并行循环互相覆写 —— 倒计时乱跳、暂停只作用于最后一次 sleep。
// 串行模型下这些竞态天然消失，组间暂停恢复"任意相邻两组之间"的真实语义。
let loopGen = 0; // 循环代数：每次 runBatchLoop 占用新一代，旧循环在下一个 await 点感知后代别不符 → 静默退出（不碰 state）

async function runBatchLoop(): Promise<void> {
  const myGen = ++loopGen; // 覆盖「取消→立刻恢复」竞态：旧循环可能还在 SMTP 发送中/睡眠中，唤醒后让位
  try {
  const sched = loadConfig().schedule || DEFAULT_SCHEDULE;
  const plan = [...queues.values()].flat().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const acctEmails = new Map(getDb().select().from(emailAccounts).all().map(a => [a.id, a.email]));
  const failsByAccount = new Map<number, number>();

  /** 账号熔断：把该账号剩余 pending 组标 failed（其他账号继续发 — 串行模型无需中断整批） */
  const tripAccount = (aid: number, fromIdx: number) => {
    const s = state.accountStats.find(x => x.accountId === aid);
    if (s) s.isCircuitOpen = true;
    Log.warn("send.circuit", `账号 ${aid} 熔断`);
    for (let j = fromIdx; j < plan.length; j++) {
      const it = plan[j]!;
      if (it.accountId !== aid || it.status !== "pending") continue;
      it.status = "failed"; it.error = `账号 ${acctEmails.get(aid) || aid} 熔断，本组未发送`;
      state.failedCount++;
      if (s) s.failed++;
      try { getDb().update(sendQueue).set({ status: "failed", error: it.error }).where(eq(sendQueue.id, it.id)).run(); } catch { /* */ }
    }
    push(EVENTS.CIRCUIT_CHANGED, { accountId: aid, email: acctEmails.get(aid), batchId: state.batchId });
  };

  for (let i = 0; i < plan.length; i++) {
    while (state.isPaused && state.isRunning) await sleep(1000);
    if (loopGen !== myGen) return; // 已被新批次接管，静默让位
    if (!state.isRunning || abortFlag) break;

    const item = plan[i]!;
    if (item.status !== "pending") continue; // 已被熔断标记的组直接跳过
    const accountId = item.accountId;

    // 时间窗口检查 — 窗口外等待，模拟人工只在工作时间发信（测试模式跳过时段限制）
    if (!loadConfig().test.enabled && !inWindow(sched)) {
      const waitMs = 60 * 1000; // 每分钟检查一次
      state.delaySeconds = Math.floor(waitMs / 1000);
      state.delayUntil = new Date(Date.now() + waitMs).toISOString();
      push(EVENTS.SEND_PROGRESS, state);
      await sleep(waitMs);
      if (loopGen !== myGen) return; // 已被新批次接管
      if (!state.isRunning) break;
      state.delaySeconds = 0;
      state.delayUntil = null;
      i--; // 不消耗队列项，继续等
      continue;
    }

    state.currentItem = { ...item, status: "sending" };
    push(EVENTS.SEND_PROGRESS, state);

    if (loadConfig().test.dryRun) {
      // 发信阻隔：流程完整但不实际发送（测试模式）
      item.status = "sent"; item.sentAt = new Date().toISOString(); state.sentCount++; failsByAccount.set(accountId, 0);
      try { getDb().update(sendQueue).set({ status: "sent", sentAt: item.sentAt }).where(eq(sendQueue.id, item.id)).run(); } catch { /* */ }
      const s = state.accountStats.find(x => x.accountId === accountId);
      if (s) s.sent++;
      Log.info("send.dryRun", `${item.companyName}: 测试模式，跳过真实发送`);
    } else if (sendBccFn) {
      // 发送前按模板现场组装正文（随机词每组重新随机）
      const body = renderTemplate(item.tplBody, item.contactVars);
      const sendItem = { ...item, body };
      const r = await sendBccFn(sendItem);
      if (r.success) {
        const messageId = r.data?.messageId || null;
        item.status = "sent"; item.sentAt = new Date().toISOString(); state.sentCount++; failsByAccount.set(accountId, 0);
        recordQuotaSend(item.recipients.length);
        try { getDb().update(sendQueue).set({ status: "sent", sentAt: item.sentAt }).where(eq(sendQueue.id, item.id)).run(); } catch { /* */ }
        const now = new Date().toISOString();
        for (const rc of item.recipients) {
          try {
            getDb().insert(interactions).values({ contactId: rc.contactId, type: "sent", direction: "outbound", channel: "email", subject: item.subject, bodyPreview: body.slice(0, 200), accountId, createdAt: now }).run();
            // 收件箱「已发送」:SMTP 发信不进 IMAP Sent 文件夹,直接落 inbox_messages 让前端可见并关联联系人
            getDb().insert(inboxMessages).values({
              accountId, messageId,
              fromEmail: rc.email, fromName: rc.name,
              subject: item.subject, bodyPreview: body.slice(0, 500),
              classification: "sent", matchedContactId: rc.contactId,
              isRead: 1, receivedAt: now,
            }).run();
            await writeBodyForLastInsert(body); // 正文落盘文件
            // v4.0: 发信不再自动标已触达 — reached 只能用户手动设置/改标签触发
          } catch (err) {
            Log.error("send.record", rc.email, err instanceof Error ? err.stack : undefined);
          }
        }
        // 不每封写盘（64MB 库写盘 ~74ms，大量组会卡顿），依赖 main 进程 30s 自动保存
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.sent++;
      } else {
        item.status = "failed"; item.error = r.error; state.failedCount++;
        try { getDb().update(sendQueue).set({ status: "failed", error: r.error }).where(eq(sendQueue.id, item.id)).run(); } catch { /* */ }
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.failed++;
        const n = (failsByAccount.get(accountId) ?? 0) + 1;
        failsByAccount.set(accountId, n);
        if (n >= 3) tripAccount(accountId, i + 1); // 连续失败阈值：只摘除该账号剩余组，批次继续
      }
    } else {
      item.status = "failed"; item.error = "发送器未配置";
    }

    state.currentItem = null;
    push(EVENTS.SEND_PROGRESS, state);

    if (i < plan.length - 1 && state.isRunning && !state.isPaused) {
      // 组间暂停 — 全局生效于任意相邻两组之间
      const ms = randBetween(sched.groupDelayMinSeconds, sched.groupDelayMaxSeconds);
      state.delaySeconds = Math.floor(ms / 1000);
      state.delayUntil = new Date(Date.now() + ms).toISOString();
      push(EVENTS.SEND_PROGRESS, state);
      const ok = await sleep(ms);
      if (loopGen !== myGen) return; // 已被新批次接管：delayUntil 归新循环，别去清它
      state.delaySeconds = 0;
      state.delayUntil = null;
      if (!ok) break;
    }
  }

  if (loopGen !== myGen) return; // 已被新批次接管，本轮收尾作废
  const allDone = plan.every(x => x.status !== "pending");
  if (allDone) {
    state.isRunning = false;
    Log.info("send.done", `${state.sentCount}/${state.totalItems}`);
    push(EVENTS.SEND_PROGRESS, state);
  }
  } catch (err: unknown) {
    // 兜底：循环意外抛错若不管，会让 isRunning 永远卡 true、批次静默死亡（表现为"倒计时结束后不再发送"）
    Log.error("send.loop", err instanceof Error ? (err.stack || err.message) : String(err));
    if (loopGen === myGen) {
      state.isRunning = false; state.isPaused = false;
      state.currentItem = null; state.delaySeconds = 0; state.delayUntil = null;
      push(EVENTS.SEND_PROGRESS, state);
    }
  }
}

export function pauseSend(): Result<void> { state.isPaused = true; pauseDelay(); return okResult(undefined); }
export function resumeSend(): Result<void> { state.isPaused = false; resumeDelay(); return okResult(undefined); }

/** 取消当前批次：中断串行调度循环，队列丢弃（已发送的仍保留 interactions 记录） */
export function cancelSend(): Result<void> {
  if (!state.isRunning) return okResult(undefined);
  state.isRunning = false;
  abortFlag = true;
  if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
  if (delayResolve) { const r = delayResolve; delayResolve = null; delayRemaining = 0; r(false); }
  Log.info("send.cancel", `批次 ${state.batchId || "?"} 已取消`);
  push(EVENTS.SEND_PROGRESS, state);
  return okResult(undefined);
}
/** 预览模板渲染效果（用第一个联系人），附全局署名签名 */
export function previewTemplate(template: SendTemplate): Result<{ subject: string; body: string }> {
  const first = getDb().select().from(contacts).limit(1).get();
  if (!first) return failResult("没有联系人可预览");
  const signature = (loadConfig().signature || "").trim();
  const body = renderTemplate(template.body, first) + (signature ? `\n\n${signature}` : "");
  return okResult({
    subject: renderTemplate(template.subject, first),
    body,
  });
}

export function getSendStatus(): Result<SendStatus> { return okResult({ ...state }); }

/** 返回所有队列项，内存优先 → DB 兜底（重启后恢复） */
export function getQueueItems(): Result<Array<SendItem & { accountEmail?: string }>> {
  // 内存优先
  let items: Array<SendItem & { accountEmail?: string }> = [];
  const accounts = getDb().select().from(emailAccounts).all();
  const emailMap = new Map(accounts.map(a => [a.id, a.email]));
  for (const [aid, q] of queues) {
    for (const item of q) {
      items.push({ ...item, accountEmail: emailMap.get(aid) || `#${aid}` });
    }
  }
  // 按原始队列顺序排序（跨账号交错，与发送顺序一致）
  items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (items.length > 0) return okResult(items);

  // DB 兜底（重启后）
  try {
    const rows = getDb().select().from(sendQueue).orderBy(
      // ponytail: raw order by — created_at 字符串可排序
      dsql`${sendQueue.createdAt} ASC`
    ).all();
    // 修正：sending → pending（进程已死，不可能还在发送中）
    for (const r of rows) {
      if (r.status === "sending") {
        try { getDb().update(sendQueue).set({ status: "pending" }).where(eq(sendQueue.id, r.id)).run(); } catch { /* */ }
      }
    }
    items = rows.map(r => ({
      id: r.id, companyName: r.companyName || "", companyId: r.companyId || 0,
      recipients: (() => { try { return JSON.parse(r.recipients); } catch { return []; } })(),
      accountId: r.accountId, accountEmail: r.accountEmail || emailMap.get(r.accountId) || "",
      subject: r.subject || "",
      tplBody: r.tplBody || "",
      contactVars: (() => { try { return JSON.parse(r.contactVars || "{}"); } catch { return {}; } })(),
      tplName: r.tplName || undefined,
      country: r.country || undefined, language: r.language || undefined,
      status: r.status === "sending" ? "pending" : (r.status as SendItem["status"]),
      error: r.error || undefined, sentAt: r.sentAt || undefined,
      cc: r.cc || undefined,
    }));
    return okResult(items);
  } catch (err) {
    Log.warn("send.getQueue", `从 DB 读取队列失败: ${err instanceof Error ? err.message : String(err)}`);
    return okResult([]);
  }
}

/** 恢复中断的批次 — 从 DB 加载 pending 项，重建内存队列（与 startQueue 共享配额纪律） */
export function resumeQueue(): Result<{ batchId: string; queued: number; queuedCount: number; dropped: number }> {
  if (state.isRunning) return failResult("已有发送任务运行中");

  try {
    const rows = getDb().select().from(sendQueue)
      .where(eq(sendQueue.status, "pending"))
      .orderBy(dsql`${sendQueue.createdAt} ASC`)
      .all();

    if (rows.length === 0) return failResult("没有待恢复的发送项");

    const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
    if (accounts.length === 0) return failResult("没有可用的发件账号");

    // 配额守卫 — 与 startQueue 同一条门（否则中断批次次日恢复会直接突破当日限额）
    const qCheck = checkQuota();
    if (!qCheck.ok) return failResult(qCheck.reason || "已达全局发信限额");

    const batchId = rows[0]!.batchId || nanoid();
    const activeIds = new Set(accounts.map(a => a.id));

    const items: SendItem[] = [];
    for (const r of rows) {
      const recipients = (() => { try { return JSON.parse(r.recipients); } catch { return []; } })();
      const contactVars = (() => { try { return JSON.parse(r.contactVars || "{}"); } catch { return {}; } })();
      items.push({
        id: r.id, companyName: r.companyName || "", companyId: r.companyId || 0,
        recipients, accountId: r.accountId,
        subject: r.subject || "", tplBody: r.tplBody || "", contactVars,
        tplName: r.tplName || undefined,
        country: r.country || undefined, language: r.language || undefined,
        status: "pending",
        error: r.error || undefined, sentAt: r.sentAt || undefined,
        cc: r.cc || undefined,   // 恢复队列时必须带回，否则用户点「开始发送」抄送就没了
      });
    }

    // 停用账号的组重新分配到活跃账号 — 否则永远 pending，批次卡死（历史亲和已失效，均分给活着的账号）
    const load = new Map<number, number>(accounts.map(a => [a.id, 0]));
    const cap = Math.ceil(items.length / accounts.length);
    for (const it of items) {
      if (!activeIds.has(it.accountId)) {
        it.accountId = pickAccountId(undefined, load, cap);
      }
      load.set(it.accountId, (load.get(it.accountId) ?? 0) + 1);
    }

    // 限额裁剪（按封数，整组保留，createdAt 顺序）
    const { kept, keptCount, dropped } = trimByBudget(items, qCheck.remaining);
    if (dropped > 0) {
      Log.warn("send.quota", `恢复批次裁剪: ${items.length} 组 → ${kept.length} 组`);
      const keptIds = new Set(kept.map(k => k.id));
      for (const it of items) {
        if (!keptIds.has(it.id)) {
          it.status = "failed"; it.error = "已达今日限额，本组未恢复";
          try { getDb().update(sendQueue).set({ status: "failed", error: it.error }).where(eq(sendQueue.id, it.id)).run(); } catch { /* */ }
        }
      }
    }

    queues = new Map();
    abortFlag = false;
    for (const it of kept) {
      if (!queues.has(it.accountId)) queues.set(it.accountId, []);
      queues.get(it.accountId)!.push(it);
    }

    const totalItems = rows.length;
    // Derive sent/failed counts from DB
    const sentCount = getDb().select().from(sendQueue).where(eq(sendQueue.status, "sent")).all().length;
    const failedCount = getDb().select().from(sendQueue).where(eq(sendQueue.status, "failed")).all().length;

    state = {
      batchId, totalItems: totalItems + sentCount + failedCount,
      sentCount, failedCount,
      isPaused: false, isRunning: true, currentItem: null, delaySeconds: 0, delayUntil: null,
      accountStats: accounts.map(a => {
        const total = queues.get(a.id)?.length || 0;
        return { accountId: a.id, email: a.email, sent: 0, failed: 0, total, isCircuitOpen: false };
      }),
    };

    Log.info("send.resume", `恢复批次 ${batchId}: ${kept.length} 待发送, ${sentCount} 已完成`);
    void runBatchLoop();
    return okResult({ batchId, queued: kept.length, queuedCount: keptCount, dropped });
  } catch (err) {
    Log.error("send.resumeQueue", err instanceof Error ? err.message : String(err));
    return failResult("恢复队列失败: " + (err instanceof Error ? err.message : String(err)));
  }
}

export function cleanupSendEngine() {
  state.isRunning = false; abortFlag = true;
  if (delayTimer) clearTimeout(delayTimer); Log.info("send.cleanup", "引擎已清理");
}
