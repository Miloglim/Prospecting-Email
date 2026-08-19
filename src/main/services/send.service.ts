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
  status: "pending" | "sending" | "sent" | "failed";
  error?: string; sentAt?: string;
}

export interface SendTemplate {
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
  isPaused: false, isRunning: false, currentItem: null, delaySeconds: 0, accountStats: [],
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

/** 记录发送（持久化） */
function recordQuotaSend(): void {
  const quota = getQuota();
  if (quota.dailyLimit <= 0) return;
  const now = new Date().toISOString();
  const next = {
    dailyLimit: quota.dailyLimit,
    firstSendAt: quota.firstSendAt || now,
    sentToday: (quota.sentToday || 0) + 1,
  };
  saveQuota(next);
}

let pushFn: ((c: string, d: unknown) => void) | null = null;
export function setPushFn(fn: (c: string, d: unknown) => void) { pushFn = fn; }
function push(c: string, d: unknown) { try { pushFn?.(c, d); } catch { /* */ } }

let sendBccFn: ((item: SendItem & { body: string }) => Promise<Result<void>>) | null = null;
export function setSendBccFn(fn: (item: SendItem & { body: string }) => Promise<Result<void>>) { sendBccFn = fn; }

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
  { key: "cold", label: "新线索", desc: "从未发送过邮件" },
  { key: "f1", label: "第1轮", desc: "已发第1封开发信" },
  { key: "f2", label: "第2轮", desc: "已发第2封跟进" },
  { key: "f3", label: "第3轮", desc: "已发第3封跟进" },
  { key: "f4", label: "第4轮+", desc: "已发4封及以上" },
];

export function getStageBuckets(): Result<TimeBucket[]> {
  const db = getDb();
  const allContacts = db.select().from(contacts).all();
  const buckets = new Map<string, ContactRow[]>();
  STAGE_BUCKET_DEFS.forEach(b => buckets.set(b.key, []));

  for (const c of allContacts) {
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
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi"), val);
    out = out.replace(new RegExp(`\\{\\{\\s*contact\\.${key}\\s*\\}\\}`, "gi"), val);
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

// ── 联系人 stage → 模板 stage 映射 ──
const STAGE_MAP: Record<string, string> = {
  cold: "initial", f1: "followup1", f2: "followup2", f3: "closing", f4: "reactivate",
};

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

export function buildQueue(bucketKeys: string[], templates?: SendTemplate[]): Result<SendItem[]> {
  // 三个维度（状态/阶段/发送时间）收集选中联系人 id —— 桶查询只返回 id，避免传输完整联系人
  const selectedIds = new Set<number>();
  for (const br of [getTimeBuckets(), getStageBuckets(), getSendTimeBuckets()]) {
    if (!br.success) continue;
    for (const b of br.data) {
      if (bucketKeys.includes(b.key)) for (const c of b.contacts) selectedIds.add(c.id);
    }
  }
  if (selectedIds.size === 0) return failResult("没有选中的联系人");

  // 用 id 一次查完整联系人（供模板渲染）
  const selected = new Map<number, ContactRow>();
  const selectedRows = getDb().select().from(contacts).where(inArray(contacts.id, [...selectedIds])).all();
  for (const c of selectedRows) selected.set(c.id, c);

  const companyGroups = new Map<string, ContactRow[]>();
  for (const c of selected.values()) {
    const k = `c_${c.companyId || 0}`;
    if (!companyGroups.has(k)) companyGroups.set(k, []);
    companyGroups.get(k)!.push(c);
  }

  // 查公司名（用于 {{company}} 变量）
  const companyMap = new Map<number, string>();
  if (selected.size > 0) {
    const companyRows = getDb().select().from(companies).all();
    for (const comp of companyRows) companyMap.set(comp.id, comp.name);
  }

  const userTpls = (templates?.filter(t => t?.subject && t?.body) || []);
  if (userTpls.length === 0) return failResult("请先选择至少一个邮件模板");

  // 预分配账号（供预览展示），正式发送时 startSend 会重新精确分配
  const activeAccounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  const activeIds = new Set(activeAccounts.map(a => a.id));

  // 批量查上次发送账号（一次查询 + 内存去重，避免 N 次查询卡顿）
  const lastAccountMap = new Map<number, number>();
  const cidSet = new Set([...companyGroups.values()].flat().map(c => c.id));
  const sentRows = getDb().select({ contactId: interactions.contactId, accountId: interactions.accountId })
    .from(interactions).where(eq(interactions.type, "sent"))
    .orderBy(desc(interactions.createdAt)).all();
  for (const r of sentRows) {
    if (r.contactId == null || r.accountId == null) continue;
    if (cidSet.has(r.contactId) && !lastAccountMap.has(r.contactId) && activeIds.has(r.accountId)) {
      lastAccountMap.set(r.contactId, r.accountId);
    }
  }

  const items: SendItem[] = [];
  let roundRobinIdx = 0;
  for (const [, group] of companyGroups) {
    const first = group[0]!;
    const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";
    const t = pickTemplate(userTpls, first);
    const contactVars: TemplateVars = {
      firstName: first.firstName, lastName: first.lastName,
      company: companyName, email: first.email,
      title: first.title, phone: first.phone,
    };
    const subj = renderTemplate(t.subject, contactVars);

    const preferredAid = lastAccountMap.get(first.id);
    const aid = preferredAid || activeAccounts[roundRobinIdx % activeAccounts.length]?.id || 0;
    if (!preferredAid) roundRobinIdx++;

    items.push({
      id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
      companyId: first.companyId || 0,
      recipients: group.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
      subject: subj, tplBody: t.body, contactVars,
      accountId: aid, status: "pending",
    });
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
  const r = assembleEmail({
    lang: normalizeLang(lang),
    clientType: mapClientType(clientType) as ClientType,
    stage: s,
    includeCompany: true,
  });
  r.body = r.body.replace(/\{\{\s*company\s*\}\}/gi, "your company");
  return okResult(r);
}

/** 自适应模式：无模板时用组件句库组装（按公司 BCC 分组，每组随机组装） */
export function buildAdaptiveQueue(bucketKeys: string[]): Result<SendItem[]> {
  const selectedIds = new Set<number>();
  for (const br of [getTimeBuckets(), getStageBuckets(), getSendTimeBuckets()]) {
    if (!br.success) continue;
    for (const b of br.data) {
      if (bucketKeys.includes(b.key)) for (const c of b.contacts) selectedIds.add(c.id);
    }
  }
  if (selectedIds.size === 0) return failResult("没有选中的联系人");

  const selected = new Map<number, ContactRow>();
  const selectedRows = getDb().select().from(contacts).where(inArray(contacts.id, [...selectedIds])).all();
  for (const c of selectedRows) selected.set(c.id, c);

  const companyGroups = new Map<string, ContactRow[]>();
  for (const c of selected.values()) {
    const k = `c_${c.companyId || 0}`;
    if (!companyGroups.has(k)) companyGroups.set(k, []);
    companyGroups.get(k)!.push(c);
  }

  const companyMap = new Map<number, string>();
  for (const comp of getDb().select().from(companies).all()) companyMap.set(comp.id, comp.name);

  const items: SendItem[] = [];
  for (const [, group] of companyGroups) {
    const first = group[0]!;
    const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";
    const assembled = assembleEmail({
      lang: normalizeLang(first.language),
      clientType: mapClientType(first.clientType || "") as ClientType,
      stage: (STAGE_MAP[first.stage || ""] || "initial") as Stage,
      includeCompany: !!companyName,
    });
    items.push({
      id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
      companyId: first.companyId || 0,
      recipients: group.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
      subject: assembled.subject, tplBody: assembled.body,
      contactVars: { firstName: first.firstName, lastName: first.lastName, company: companyName, email: first.email, title: first.title, phone: first.phone },
      accountId: 0, status: "pending",
    });
  }
  return okResult(items);
}

// ── 多账号并行发送 ──

let queues: Map<number, SendItem[]> = new Map();
let abortFlags: Map<number, boolean> = new Map();

export async function startSend(bucketKeys: string[], templates?: SendTemplate[]): Promise<Result<string>> {
  Log.debug("send.start", `buckets=${bucketKeys.join(",")} templates=${templates?.length || 0}`);

  if (state.isRunning) return failResult("已有发送任务运行中");

  // 自适应模式：无模板时用句库自动组装
  const qr = templates && templates.length > 0
    ? buildQueue(bucketKeys, templates)
    : buildAdaptiveQueue(bucketKeys);
  if (!qr.success) return failResult(qr.error);

  const items = qr.data;
  if (items.length === 0) return failResult("没有待发送项");

  const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  if (accounts.length === 0) return failResult("没有可用的发件账号");

  const batchId = nanoid();
  queues = new Map();
  abortFlags = new Map();

  // 账号分配：优先复用上次发送使用的账号（联系人亲和）
  const activeIds = new Set(accounts.map(a => a.id));
  const lastAccountMap = new Map<number, number>(); // contactId → accountId
  const allContactIds = items.flatMap(it => it.recipients.map(r => r.contactId));
  if (allContactIds.length > 0) {
    // 批量查每个联系人的最后一次发送账号（一次查询 + 内存去重）
    const cidSet = new Set(allContactIds);
    const sentRows = getDb().select({ contactId: interactions.contactId, accountId: interactions.accountId })
      .from(interactions).where(eq(interactions.type, "sent"))
      .orderBy(desc(interactions.createdAt)).all();
    for (const r of sentRows) {
      if (r.contactId == null || r.accountId == null) continue;
      if (cidSet.has(r.contactId) && !lastAccountMap.has(r.contactId) && activeIds.has(r.accountId)) {
        lastAccountMap.set(r.contactId, r.accountId);
      }
    }
  }

  let roundRobinIdx = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // 取组内第一个联系人的上次账号
    const firstCid = item.recipients[0]?.contactId;
    const preferredAid = firstCid ? lastAccountMap.get(firstCid) : undefined;
    const aid = preferredAid || accounts[roundRobinIdx % accounts.length]!.id;
    if (!preferredAid) roundRobinIdx++;
    if (!queues.has(aid)) queues.set(aid, []);
    queues.get(aid)!.push({ ...item, accountId: aid });
  }

  state = {
    batchId, totalItems: items.length, sentCount: 0, failedCount: 0,
    isPaused: false, isRunning: true, currentItem: null, delaySeconds: 0,
    accountStats: accounts.map(a => {
      const total = queues.get(a.id)?.length || 0;
      return { accountId: a.id, email: a.email, sent: 0, failed: 0, total, isCircuitOpen: false };
    }),
  };

  // 全局限额裁剪：队列不超过剩余额度
  const qCheck = checkQuota();
  if (!qCheck.ok) return failResult(qCheck.reason || "已达全局发信限额");
  let quotaRemaining = qCheck.remaining;
  if (quotaRemaining > 0) {
    const totalNeeded = [...queues.values()].reduce((s, q) => s + q.length, 0);
    if (totalNeeded > quotaRemaining) {
      // 从各账号队列尾部截断，保留前 quotaRemaining 组
      let keep = quotaRemaining;
      const newQueues = new Map<number, SendItem[]>();
      for (const [aid, q] of queues) {
        const sliced = q.slice(0, Math.min(q.length, keep));
        if (sliced.length > 0) newQueues.set(aid, sliced);
        keep -= sliced.length;
        if (keep <= 0) break;
      }
      queues = newQueues;
      Log.warn("send.quota", `限额裁剪: ${totalNeeded} → ${quotaRemaining} 组`);
    }
  }

  // 持久化：清除旧批次，分批批量写入（避免逐条 insert 卡顿）
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
          status: "pending", createdAt: now,
        });
      }
    }
    // 每批 200 行，避免单条 SQL 过长
    for (let i = 0; i < rows.length; i += 200) {
      getDb().insert(sendQueue).values(rows.slice(i, i + 200)).run();
    }
    saveDatabase();
  } catch (err) {
    Log.warn("send.queuePersist", `写入发送队列表失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  Log.info("send.start", `批次 ${batchId}: ${items.length} 组, ${accounts.length} 账号`);

  for (const a of accounts) { abortFlags.set(a.id, false); runAccountLoop(a.id); }

  return okResult(batchId);
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

async function runAccountLoop(accountId: number) {
  const q = queues.get(accountId) || [];
  let fails = 0;
  const sched = loadConfig().schedule || DEFAULT_SCHEDULE;

  for (let i = 0; i < q.length; i++) {
    while (state.isPaused && state.isRunning) await sleep(1000);
    if (!state.isRunning || abortFlags.get(accountId)) break;

    // 时间窗口检查 — 窗口外等待，模拟人工只在工作时间发信
    if (!inWindow(sched)) {
      const waitMs = 60 * 1000; // 每分钟检查一次
      state.delaySeconds = Math.floor(waitMs / 1000);
      push(EVENTS.SEND_PROGRESS, state);
      await sleep(waitMs);
      if (!state.isRunning) break;
      state.delaySeconds = 0;
      i--; // 不消耗队列项，继续等
      continue;
    }

    const item = q[i]!;
    state.currentItem = { ...item, status: "sending" };
    push(EVENTS.SEND_PROGRESS, state);

    if (sendBccFn) {
      // 发送前按模板现场组装正文（随机词每组重新随机）
      const body = renderTemplate(item.tplBody, item.contactVars);
      const sendItem = { ...item, body };
      const r = await sendBccFn(sendItem);
      if (r.success) {
        item.status = "sent"; item.sentAt = new Date().toISOString(); state.sentCount++; fails = 0;
        recordQuotaSend();
        try { getDb().update(sendQueue).set({ status: "sent", sentAt: item.sentAt }).where(eq(sendQueue.id, item.id)).run(); } catch { /* */ }
        const now = new Date().toISOString();
        for (const rc of item.recipients) {
          try {
            getDb().insert(interactions).values({ contactId: rc.contactId, type: "sent", direction: "outbound", channel: "email", subject: item.subject, bodyPreview: body.slice(0, 200), accountId, createdAt: now }).run();
            // 收件箱「已发送」:SMTP 发信不进 IMAP Sent 文件夹,直接落 inbox_messages 让前端可见并关联联系人
            getDb().insert(inboxMessages).values({
              accountId, messageId: null,
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
        saveDatabase();
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.sent++;
      } else {
        item.status = "failed"; item.error = r.error; state.failedCount++; fails++;
        try { getDb().update(sendQueue).set({ status: "failed", error: r.error }).where(eq(sendQueue.id, item.id)).run(); } catch { /* */ }
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.failed++;
        if (fails >= 3) { const s = state.accountStats.find(x => x.accountId === accountId); if (s) s.isCircuitOpen = true; Log.warn("send.circuit", `账号 ${accountId} 熔断`); break; }
      }
    } else {
      item.status = "failed"; item.error = "发送器未配置";
    }

    state.currentItem = null;
    push(EVENTS.SEND_PROGRESS, state);

    if (i < q.length - 1 && state.isRunning && !state.isPaused) {
      // 公司组之间：15-20 分钟随机间隔（模拟人工一批批处理）
      let ms: number;
      if (item.recipients.length <= 1) {
        // 单联系人公司：短间隔 5-10 秒
        ms = randBetween(sched.singleRecipDelayMinSeconds, sched.singleRecipDelayMaxSeconds);
      } else {
        // 多联系人公司（BCC 组）：15-20 分钟
        ms = randBetween(sched.companyDelayMinMinutes * 60, sched.companyDelayMaxMinutes * 60);
      }
      // 批间暂停：每 batchSize 组额外休息，模拟人工处理完一批后停下喘口气
      if ((i + 1) % sched.batchSize === 0) {
        ms += randBetween(sched.batchPauseMinSeconds, sched.batchPauseMaxSeconds) * 1000;
      }
      state.delaySeconds = Math.floor(ms / 1000);
      push(EVENTS.SEND_PROGRESS, state);
      const ok = await sleep(ms);
      state.delaySeconds = 0;
      if (!ok) break;
    }
  }

  const allDone = Array.from(queues.values()).flat().every(x => x.status !== "pending");
  if (allDone) {
    state.isRunning = false;
    Log.info("send.done", `${state.sentCount}/${state.totalItems}`);
    push(EVENTS.SEND_PROGRESS, state);
  }
}

export function pauseSend(): Result<void> { state.isPaused = true; pauseDelay(); return okResult(undefined); }
export function resumeSend(): Result<void> { state.isPaused = false; resumeDelay(); return okResult(undefined); }

/** 取消当前批次：终止所有账号循环，队列丢弃（已发送的仍保留 interactions 记录） */
export function cancelSend(): Result<void> {
  if (!state.isRunning) return okResult(undefined);
  state.isRunning = false;
  abortFlags.forEach((_, k) => abortFlags.set(k, true));
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
      status: r.status === "sending" ? "pending" : (r.status as SendItem["status"]),
      error: r.error || undefined, sentAt: r.sentAt || undefined,
    }));
    return okResult(items);
  } catch (err) {
    Log.warn("send.getQueue", `从 DB 读取队列失败: ${err instanceof Error ? err.message : String(err)}`);
    return okResult([]);
  }
}

/** 恢复中断的批次 — 从 DB 加载 pending 项，重建内存队列 */
export function resumeQueue(): Result<string> {
  if (state.isRunning) return failResult("已有发送任务运行中");

  try {
    const rows = getDb().select().from(sendQueue)
      .where(eq(sendQueue.status, "pending"))
      .orderBy(dsql`${sendQueue.createdAt} ASC`)
      .all();

    if (rows.length === 0) return failResult("没有待恢复的发送项");

    const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
    if (accounts.length === 0) return failResult("没有可用的发件账号");

    const batchId = rows[0]!.batchId || nanoid();
    queues = new Map();
    abortFlags = new Map();

    for (const r of rows) {
      const recipients = (() => { try { return JSON.parse(r.recipients); } catch { return []; } })();
      const contactVars = (() => { try { return JSON.parse(r.contactVars || "{}"); } catch { return {}; } })();
      const item: SendItem = {
        id: r.id, companyName: r.companyName || "", companyId: r.companyId || 0,
        recipients, accountId: r.accountId,
        subject: r.subject || "", tplBody: r.tplBody || "", contactVars,
        status: "pending",
        error: r.error || undefined, sentAt: r.sentAt || undefined,
      };
      if (!queues.has(r.accountId)) queues.set(r.accountId, []);
      queues.get(r.accountId)!.push(item);
    }

    const totalItems = rows.length;
    // Derive sent/failed counts from DB
    const sentCount = getDb().select().from(sendQueue).where(eq(sendQueue.status, "sent")).all().length;
    const failedCount = getDb().select().from(sendQueue).where(eq(sendQueue.status, "failed")).all().length;

    state = {
      batchId, totalItems: totalItems + sentCount + failedCount,
      sentCount, failedCount,
      isPaused: false, isRunning: true, currentItem: null, delaySeconds: 0,
      accountStats: accounts.map(a => {
        const total = queues.get(a.id)?.length || 0;
        return { accountId: a.id, email: a.email, sent: 0, failed: 0, total, isCircuitOpen: false };
      }),
    };

    Log.info("send.resume", `恢复批次 ${batchId}: ${rows.length} 待发送, ${sentCount} 已完成`);
    for (const a of accounts) { abortFlags.set(a.id, false); runAccountLoop(a.id); }
    return okResult(batchId);
  } catch (err) {
    Log.error("send.resumeQueue", err instanceof Error ? err.message : String(err));
    return failResult("恢复队列失败: " + (err instanceof Error ? err.message : String(err)));
  }
}

export function cleanupSendEngine() {
  state.isRunning = false; abortFlags.forEach((_, k) => abortFlags.set(k, true));
  if (delayTimer) clearTimeout(delayTimer); Log.info("send.cleanup", "引擎已清理");
}
