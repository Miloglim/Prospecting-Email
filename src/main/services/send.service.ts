import * as crypto from "crypto";
const nanoid = () => crypto.randomUUID().slice(0, 12);
import { getDb } from "../db";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { inboxMessages } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { eq, sql as dsql, desc, inArray, and, isNotNull } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase, getRawDb } from "../db";
import { sendQueue } from "../db/schema/send-queue";
// 选人器「已在任务」灰显用（getPickerStats）：只引 schema，不引 campaign.service（它反向依赖本文件）
import { sendCampaigns, sendCampaignTargets } from "../db/schema/send-campaign";
import { EVENTS } from "../events";
import { nudge as nudgeSuggestions } from "./suggestion-bus";
import { isCircuitOpen, CIRCUIT_TTL_MS } from "./sender-block.service";
import { loadConfig, DEFAULT_SCHEDULE } from "../config";
import { writeBodyForLastInsert } from "./inbox.service";
import { assembleEmail, type Lang, type ClientType, type Stage } from "./sentence-library";


// ── 类型 ──

export interface SendItem {
  id: string; companyName: string; companyId: number;
  campaignId?: string;    // 归属开发任务（队列运行情况挂在任务卡片背后；旧模式入队不带）
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
  sendMode?: "individual" | "bcc";  // individual=单独一封（收件人走 To，像人工手发）；缺省 bcc（互不可见）
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
  /** 等待原因：group=组间暂停（正常倒计时）；window=未到发送时段（前端应显示"未到发送时段"而非倒计时） */
  delayReason: "group" | "window" | null;
  /** 暂停原因：user=用户手动暂停；sender_block=服务商反垃圾/限流拦截退信触发（队列页据此出横幅而非"等待恢复"） */
  pausedReason?: "user" | "sender_block" | null;
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
  isPaused: false, isRunning: false, currentItem: null, delaySeconds: 0, delayUntil: null, delayReason: null,
  pausedReason: null, accountStats: [],
};

/** 可参与发信的账号：启用 + 熔断不在生效期（24h 自动过期）。
 *  旧口径只看 is_active=1 —— 熔断过的账号下一批照样被排进轮换，等于白熔断（规范 §5）。 */
function selectableAccounts(): Array<{ id: number; email: string }> {
  const rows = getDb().select({
    id: emailAccounts.id, email: emailAccounts.email,
    circuitOpenAt: emailAccounts.circuitOpenAt, circuitResetAfter: emailAccounts.circuitResetAfter,
  }).from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  return rows.filter(r => !isCircuitOpen(r));
}

/** 启用账号总数（用来区分「没配账号」与「账号全在熔断中」两种失败） */
function activeAccountCount(): number {
  return getDb().select({ id: emailAccounts.id }).from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all().length;
}

/** 熔断态变化对外播报（账号卡/队列页据此刷新；sender-block 服务触发时借用） */
export function pushCircuitChanged(payload: Record<string, unknown>): void {
  push(EVENTS.CIRCUIT_CHANGED, payload);
}

// ── 重启水合 ──

let stateHydrated = false;

/** 重启后从 send_queue 水合批次状态（一次性）。
 *  队列项本身有 getQueueItems 的 DB 兜底，但 进度/批次号/已发/失败 是纯内存 ——
 *  不水合的话重启后头部显示 0/0、无批次号，用户看到的就是「发送状态缓存掉了」，
 *  只能重新入队；而重新入队会整表清掉旧批次，数据才真的没了。 */
function hydrateStateFromDb(): void {
  if (stateHydrated || state.isRunning) return;
  stateHydrated = true;
  try {
    const rows = getDb().select({ status: sendQueue.status, batchId: sendQueue.batchId })
      .from(sendQueue).orderBy(dsql`${sendQueue.createdAt} ASC`).all();
    if (!rows.length) return;
    let sent = 0, failed = 0;
    for (const r of rows) {
      if (r.status === "sent") sent++;
      else if (r.status === "failed") failed++;
    }
    const last = rows[rows.length - 1]!;
    state = { ...state, batchId: last.batchId, totalItems: rows.length, sentCount: sent, failedCount: failed };
    Log.info("send.hydrate", `重启水合批次 ${last.batchId.slice(0, 8)}：${sent} 已发 / ${failed} 失败 / ${rows.length - sent - failed} 待发`);
  } catch (err) {
    Log.warn("send.hydrate", `批次状态水合失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

// ── 批次运行中标志（持久化到 config）──
// 批次真实启动时写入、结束/取消时清除；退出/崩溃后残留 → 下次启动 autoResumeInterruptedBatch
// 自动续跑。没有这个标志，重启后引擎不知道批次在跑，用户得回队列页手动点「开始发送」。

function saveRunningBatch(batchId: string | null): void {
  try {
    const cfg = loadConfig();
    saveConfigFn({ ...cfg, runningBatch: batchId ? { batchId, startedAt: new Date().toISOString() } : null });
  } catch { /* 标志写失败退化为现状：重启后队列页手动开始 */ }
}

/** 启动自动续跑：上次退出/崩溃时批次在跑（config.runningBatch 残留且队列还有 pending 行）→
 *  从 DB 恢复续发，语义与队列页手动「开始发送」完全一致（配额守卫/时段等待都在链路里）。
 *  在 registerAllIPC 之后调用（saveConfigFn 已注入）。 */
export function autoResumeInterruptedBatch(): void {
  const flag = loadConfig().runningBatch;
  if (!flag?.batchId) return;
  saveRunningBatch(null); // 无论续跑成败先清标志，不残留（resumeQueue 真启动会重新写入）
  const r = resumeQueue();
  if (r.success) Log.info("send.autoResume", `检测到中断批次，已自动续跑: ${r.data.queued} 组待发`);
  else Log.warn("send.autoResume", `中断批次未自动续跑（${r.error}），可在发送队列手动开始`);
}

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
// 发送进度同时喂建议流热更新（debounce 在总线里，逐收件人推送不会导致逐次重算）
function push(c: string, d: unknown) { try { pushFn?.(c, d); } catch { /* */ } if (c === EVENTS.SEND_PROGRESS) nudgeSuggestions(); }

let sendBccFn: ((item: SendItem & { body: string }) => Promise<Result<{ messageId: string | null }>>) | null = null;
export function setSendBccFn(fn: (item: SendItem & { body: string }) => Promise<Result<{ messageId: string | null }>>) { sendBccFn = fn; }

// ── 可中断延迟 ──

let delayTimer: ReturnType<typeof setTimeout> | null = null;
let delayResolve: ((ok: boolean) => void) | null = null;
let delayStarted = 0;
let delayRemaining = 0;

/** SMTP 错误分类（P1-2）：瞬态错误可安全重试，其余按永久失败处理。
 *  瞬态 = 网络栈错误码（超时/连接重置/DNS 抖动）或服务端临时拒绝（421/450/451/452、灰名单、过载）。 */
export function classifySmtpError(msg: string): "transient" | "permanent" {
  const s = (msg || "").toLowerCase();
  if (/(etimedout|econnreset|econnrefused|eai_again|esocket|epipe|ehostunreach|enetunreach)/.test(s)) return "transient";
  if (/(temporar|try again|too many|busy|overload|greylist|graylist|unavailable|421|450|451|452)/.test(s)) return "transient";
  return "permanent";
}

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

// ── 选人页轻量统计 ──
// 旧实现在 getTimeBuckets/getSendTimeBuckets 里全表读 contacts 再 JS 分桶，
// 而选人页实际只消费两个小结果：never 集合 + contactId→最近发送档位。
// 这里下推为两条聚合 SQL（8634 行库从 ~100ms 全表扫描降到 ~1ms 索引查询），
// 语义与两个桶函数严格对齐：never = 无 status 且无 sent 交互；
// 最近发送档排除 status='reached'（与 getSendTimeBuckets 的 continue 一致）。

export interface PickerStats {
  /** 从未发送的联系人 id（对齐 getTimeBuckets 的 never 桶） */
  neverIds: number[];
  /** 有发送记录且未触达的联系人：id → 最近发送档位标签（对齐 getSendTimeBuckets） */
  lastSent: Array<{ id: number; label: string }>;
  /** 已归属未完结任务（draft/running/paused 且触点 pending/queued）的联系人：选人器据此灰显「已在任务」 */
  inCampaign: Array<{ id: number; campaignName: string }>;
}

function lastSentBucketLabel(lastAt: string): string {
  const days = (Date.now() - new Date(lastAt).getTime()) / 86_400_000;
  if (days < 1) return "今天";
  if (days < 2) return "1天";
  if (days < 3) return "2天";
  if (days <= 5) return "3-5天";
  if (days <= 10) return "6-10天";
  return "更早";
}

export function getPickerStats(): Result<PickerStats> {
  const db = getDb();
  const neverRows = db.select({ id: contacts.id }).from(contacts)
    .where(dsql`(contacts.status IS NULL OR contacts.status = '') AND NOT EXISTS (
      SELECT 1 FROM interactions i WHERE i.contact_id = contacts.id AND i.type = 'sent'
    )`)
    .all();
  const lastRows = db.select({
    id: interactions.contactId,
    lastAt: dsql<string>`MAX(${interactions.createdAt})`,
  }).from(interactions)
    .innerJoin(contacts, dsql`contacts.id = interactions.contact_id`)
    .where(dsql`${interactions.type} = 'sent' AND (contacts.status IS NULL OR contacts.status != 'reached')`)
    .groupBy(interactions.contactId)
    .all();
  // 已在未完结任务里的人（规范 §3）：done/stopped 任务不算——那批人可以再开发；同一人只记一个任务名
  const campaignRows = db.select({
    id: sendCampaignTargets.contactId,
    name: sendCampaigns.name,
  }).from(sendCampaignTargets)
    .innerJoin(sendCampaigns, dsql`${sendCampaigns.id} = ${sendCampaignTargets.campaignId}`)
    .where(dsql`${sendCampaignTargets.status} IN ('pending','queued')
      AND ${sendCampaigns.status} IN ('draft','running','paused')`)
    .all();
  const inCampaignMap = new Map<number, string>();
  for (const r of campaignRows) if (!inCampaignMap.has(r.id)) inCampaignMap.set(r.id, r.name);
  return okResult({
    neverIds: neverRows.map(r => r.id),
    lastSent: lastRows.map(r => ({ id: r.id, label: lastSentBucketLabel(r.lastAt) })),
    inCampaign: [...inCampaignMap].map(([id, campaignName]) => ({ id, campaignName })),
  });
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

// ── 联系人亲和发信账号（不换人发，用户拍板 v6.0）──
// 智能轮换建立在「对应联系人的历史发信账号」之上：谁发过的客户还由谁发；
// 只有从未发过的新联系人才进轮换池。已触达/已回复客户可入队（界面只做计数提示）。

/** 联系人 → 历史发信账号（interactions 里最近一封 type='sent' 的 account_id）。
 *  一条 GROUP BY 聚合拿全：SQLite 的 MAX() 裸列语义保证 account_id 取自 MAX(created_at) 所在行。 */
export function lastSentAccountMap(contactIds: number[]): Map<number, number> {
  const ids = [...new Set((contactIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const m = new Map<number, number>();
  if (!ids.length) return m;
  try {
    const rows = getDb().select({
      contactId: interactions.contactId,
      accountId: interactions.accountId,
      lastAt: dsql<string | null>`MAX(${interactions.createdAt})`,
    }).from(interactions)
      .where(and(
        eq(interactions.type, "sent"),
        isNotNull(interactions.accountId),
        inArray(interactions.contactId, ids),
      ))
      .groupBy(interactions.contactId)
      .all();
    for (const r of rows) if (r.accountId != null) m.set(r.contactId, r.accountId);
  } catch (err) {
    Log.warn("send.affinity", `历史发信账号查询失败（按无历史处理）: ${err instanceof Error ? err.message : String(err)}`);
  }
  return m;
}

/** 启用但熔断中的账号 id 集合：亲和账号落在这里 = 临时不可用（24h 自动过期），缓发而非换人。 */
function circuitAccountIds(): Set<number> {
  const rows = getDb().select({
    id: emailAccounts.id,
    circuitOpenAt: emailAccounts.circuitOpenAt,
    circuitResetAfter: emailAccounts.circuitResetAfter,
  }).from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  return new Set(rows.filter(r => isCircuitOpen(r)).map(r => r.id));
}

/** 亲和判定（纯函数，可单测）：组内收件人同享唯一历史账号时保持该账号（不换人发）。
 *  - 历史账号在可选池 → 用它；
 *  - 历史账号启用但熔断中（且未限定账号池）→ 整组缓发（deferred，绝不静默换号）；
 *  - 历史账号已停用/不在任务限定的账号池 → 视为无历史，交由调用方轮换；
 *  - 收件人历史账号不一致或都无历史 → 轮换（BCC 一组只能一个发件人，混历史不硬凑）。 */
export function pickAffinityAccount(
  recipients: Array<{ contactId: number }>,
  affinity: Map<number, number>,
  activeIds: Set<number>,
  circuitIds: Set<number>,
  fixedPool: boolean,
): { accountId?: number; deferred: boolean } {
  const accs = new Set<number>();
  for (const r of recipients) {
    const a = affinity.get(r.contactId);
    if (a != null) accs.add(a);
  }
  if (accs.size !== 1) return { deferred: false };
  const a = [...accs][0]!;
  if (activeIds.has(a)) return { accountId: a, deferred: false };
  if (!fixedPool && circuitIds.has(a)) return { deferred: true };
  return { deferred: false };
}

/** 按亲和账号把同公司联系人分桶（构建 BCC 组前的切分）：历史账号不同的客户不能塞进同一组——
 *  一组 BCC 只有一个发件人，不换人发的唯一保证就是组内历史账号一致；无历史归 0 号桶（轮换）。 */
export function partitionByAffinity<T extends { id: number }>(sorted: T[], affinity: Map<number, number>): Array<{ affinity: number; rows: T[] }> {
  const buckets = new Map<number, T[]>();
  for (const c of sorted) {
    const a = affinity.get(c.id) ?? 0;
    if (!buckets.has(a)) buckets.set(a, []);
    buckets.get(a)!.push(c);
  }
  return [...buckets.entries()].map(([affinity, rows]) => ({ affinity, rows }));
}

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

  // 用 id 一次查完整联系人（供模板渲染）。已触达/已回复照常入队（界面计数提示，不在此拦截）
  const selectedRows = getDb().select().from(contacts).where(inArray(contacts.id, [...selectedIds])).all();
  const affinity = lastSentAccountMap([...selectedIds]);
  const { kept: validRows, removed: badEmails } = filterValidEmails(selectedRows);
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

  // 预分配账号（供预览展示）：亲和组=历史发信账号（须在可用池内），新客户组=轮换；
  // 正式发送时 startQueue 同一套判据复核（熔断亲和组届时缓发）
  const activeIds = selectableAccounts().map(a => a.id);
  const activeSet = new Set(activeIds);

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

    // 亲和分桶（不换人发）：历史账号不同的联系人各自成组；同一亲和桶内再按 groupSize 拆组
    for (const bucket of partitionByAffinity(sorted, affinity)) {
      const first = bucket.rows[0]!;
      const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";
      const t = pickTemplate(userTpls, first);
      const contactVars: TemplateVars = {
        firstName: first.firstName, lastName: first.lastName,
        company: companyName, email: first.email,
        title: first.title, phone: first.phone,
      };
      const subj = renderTemplate(t.subject, contactVars);

      // 同亲和桶超 groupSize 拆多组（BCC 每组上限 N 人）
      for (let s = 0; s < bucket.rows.length; s += groupSize) {
        const chunk = bucket.rows.slice(s, s + groupSize);
        const aid = bucket.affinity > 0 && activeSet.has(bucket.affinity)
          ? bucket.affinity
          : (activeIds.length > 0 ? rotateAccountId(items.length, activeIds) : 0); // 新客户逐组轮换；亲和账号不可用同走轮换（startQueue 复核）

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
  }
  return okResult(items);
}

/** 联系人语言 → 邮件语言（只认 EN/ES/PT，其余一律 EN）。导出给运价更新等需要按语言分组的链路复用。 */
export function normalizeLang(l: string | null | undefined): Lang {
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

  // 已触达/已回复照常入队（资格闸已解除，界面只做计数提示）
  const selectedRows = getDb().select().from(contacts).where(inArray(contacts.id, [...selectedIds])).all();
  const affinity = lastSentAccountMap([...selectedIds]);
  const { kept: validRows, removed: badEmails } = filterValidEmails(selectedRows);
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

  const activeIds = selectableAccounts().map(a => a.id);
  const activeSet = new Set(activeIds);
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

    // 亲和分桶（不换人发）：历史账号不同的联系人各自成组，桶内按语言/类型/阶段组装
    for (const bucket of partitionByAffinity(sorted, affinity)) {
      const first = bucket.rows[0]!;
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

      for (let s = 0; s < bucket.rows.length; s += groupSize) {
        const chunk = bucket.rows.slice(s, s + groupSize);
        items.push({
          id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
          companyId: first.companyId || 0,
          recipients: chunk.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
          subject: assembled.subject, tplBody: assembled.body,
          contactVars: { firstName: first.firstName, lastName: first.lastName, company: companyName, email: first.email, title: first.title, phone: first.phone },
          tplName: `预设句库·${l}·${ct}`,
          country: companyCountryMap.get(first.companyId || 0) || first.country || undefined,
          language: l,
          accountId: bucket.affinity > 0 && activeSet.has(bucket.affinity)
            ? bucket.affinity
            : (activeIds.length > 0 ? rotateAccountId(items.length, activeIds) : 0),
          status: "pending",
        });
      }
    }
  }
  return okResult(items);
}

// ── 多账号并行发送 ──

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

/** 新客户账号轮换：第 i 组取 accountIds[i % n] — 只作用于「无历史发信账号」的新联系人组，
 *  历史客户走亲和（pickAffinityAccount），不换人发。纯函数，可单测。 */
export function rotateAccountId(index: number, accountIds: number[]): number {
  return accountIds[((index % accountIds.length) + accountIds.length) % accountIds.length]!;
}

/** 按公司交错打乱队列（保持账号轮换不变的前提下避免同公司连发）：
 *  将组按 companyId 分桶，每轮从「非上一家公司」中选**剩余组数最多**的一家出一组
 *  （平局随机打破）—— 贪心最大剩余优先可证明：只要某公司组数 ≤ 其余公司总和+1，
 *  同公司两组必不相邻；超过时连发不可避免（数学下界），但间隔仍被最大化摊开。
 *  随机性体现在平局打破与各组入桶顺序，原队列的公司排序被打散。纯函数，可单测。 */
export function interleaveCompanies<T extends { companyId: number }>(items: T[]): T[] {
  if (items.length <= 2) return [...items];
  const buckets = new Map<number, T[]>();
  for (const it of items) {
    const k = it.companyId || 0;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(it);
  }
  const out: T[] = [];
  let lastKey: number | null = null;
  while (out.length < items.length) {
    // 候选 = 还有剩余且非上一家的公司；全空（只剩上一家）才允许连发
    let cands = [...buckets.entries()].filter(([k, v]) => v.length > 0 && k !== lastKey);
    if (cands.length === 0) cands = [...buckets.entries()].filter(([, v]) => v.length > 0);
    if (cands.length === 0) break;
    // 剩余最多者优先；平局随机
    const maxN = Math.max(...cands.map(([, v]) => v.length));
    const top = cands.filter(([, v]) => v.length === maxN);
    const pick = top[Math.floor(Math.random() * top.length)]!;
    out.push(pick[1].pop()!);
    lastKey = pick[0];
  }
  return out;
}

/** 发送阶段推进：真实发送成功后 cold→f1→f2→f3→f4（f4 封顶不再进）。
 *  空值/未知值视为 cold，推进到 f1。纯函数，可单测。 */
export function nextStage(stage: string | null | undefined): string {
  const ORDER = ["cold", "f1", "f2", "f3", "f4"];
  const i = ORDER.indexOf((stage || "cold").toLowerCase());
  const cur = i < 0 ? 0 : i; // 未知值视为 cold
  return ORDER[Math.min(cur + 1, ORDER.length - 1)]!;
}

let queues: Map<number, SendItem[]> = new Map();
let abortFlag = false; // 串行模型：单一批次中断标志（旧 per-account abortFlags map 已废弃）

/** 公共发送入口：配额守卫 → 账号分配 → 限额裁剪 → 持久化 → 启动发送循环。
 *  autoStart=false 时只入队落库、不发一封（对齐旧 PE 两步式：加入队列 → 队列页手动开始）。
 *  opts.accountIds：限定轮换池只在这批账号内（发信任务的「指定账号」策略）——只缩小，不越过熔断闸。
 *  账号分配（不换人发，用户拍板 v6.0）：历史发信账号可用的组沿用原账号；熔断中的组缓发
 *  （不入本批、deferredContactIds 回传调用方顺延）；只有无历史的新组才进轮换池。
 *  返回 { batchId, queued(组), queuedCount(封), dropped(组), deferredContactIds(缓发联系人) }。 */
export async function startQueue(items: SendItem[], autoStart = true, opts?: { accountIds?: number[] }): Promise<Result<{ batchId: string; queued: number; queuedCount: number; dropped: number; deferredContactIds: number[] }>> {
  if (state.isRunning) return failResult("已有发送任务运行中");
  if (items.length === 0) return failResult("没有待发送项");

  const accounts = opts?.accountIds?.length
    ? selectableAccounts().filter(a => opts.accountIds!.includes(a.id))
    : selectableAccounts();
  if (accounts.length === 0) {
    if (opts?.accountIds?.length) return failResult("任务指定的发信账号当前都不可用（未启用或熔断中）——暂停任务或到设置页处理账号");
    return failResult(activeAccountCount() > 0
      ? "所有启用账号都在发信熔断中（服务商反垃圾/限流拦截或连续失败）——到设置页账号卡点「解除熔断」，或等 24 小时自动过期"
      : "没有可用的发件账号");
  }

  // ① 配额守卫放最前 — 失败时什么都不动（后置会把 state 污染成永远 isRunning 的幽灵批次）
  const qCheck = checkQuota();
  if (!qCheck.ok) return failResult(qCheck.reason || "已达全局发信限额");

  const batchId = nanoid();

  // ② 亲和分配（不换人发）：历史账号熔断中的组缓发——不入本批、不占配额，
  //    deferredContactIds 回传（任务扫描器据此顺延次日）。指定账号池（fixed 策略）内不缓发：
  //    池外亲和账号视同无历史，交由轮换。
  const affinity = lastSentAccountMap(items.flatMap(it => it.recipients.map(r => r.contactId)));
  const activeIds = new Set(accounts.map(a => a.id));
  const circuitIds = circuitAccountIds();
  const fixedPool = (opts?.accountIds?.length ?? 0) > 0;
  const deferredContactIds = new Set<number>();
  const runItems: SendItem[] = [];
  for (const it of items) {
    const p = pickAffinityAccount(it.recipients, affinity, activeIds, circuitIds, fixedPool);
    if (p.deferred) {
      for (const r of it.recipients) deferredContactIds.add(r.contactId);
      continue;
    }
    // 亲和组沿用历史账号；非亲和组清零 → 交错后按新顺序轮换（丢弃预分配，保相邻新组不同号）
    runItems.push(p.accountId ? { ...it, accountId: p.accountId } : { ...it, accountId: 0 });
  }
  if (deferredContactIds.size > 0) {
    Log.info("send.affinity", `亲和缓发: ${deferredContactIds.size} 位联系人的历史发信账号熔断中，本批不入队（不换人发）`);
  }
  if (runItems.length === 0) {
    return okResult({ batchId, queued: 0, queuedCount: 0, dropped: 0, deferredContactIds: [...deferredContactIds] });
  }

  // ③ 公司交错 + 新组轮换：交错只管发送顺序（同公司相邻组被拉开）；
  //    亲和组已带历史账号（同上判据），无历史的新组按序轮换 — 相邻新组不同号不变量保持。
  queues = new Map();
  abortFlag = false;
  saveRunningBatch(null);   // 清旧批次标志（autoStart=true 时下面重新写入）；两步式入队不写标志 → 重启不会误自动启动
  const rotIds = [...activeIds];
  const shuffled = interleaveCompanies(runItems);
  const ordered: Array<SendItem & { seq: number }> = [];
  let rot = 0;
  for (const it of shuffled) {
    const aid = it.accountId > 0
      ? it.accountId
      : (rotIds.length > 0 ? rotateAccountId(rot++, rotIds) : 0); // 新客户逐组轮换（亲和组已被上方沿用）
    ordered.push({ ...it, accountId: aid, seq: ordered.length });
  }
  const rotLoad = new Map<number, number>();
  for (const it of ordered) rotLoad.set(it.accountId, (rotLoad.get(it.accountId) ?? 0) + 1);
  Log.info("send.alloc", `亲和优先+新组轮换: ${rotIds.length} 账号 → ` + [...rotLoad.entries()].map(([id, n]) => `#${id}:${n}组`).join(" ") + (deferredContactIds.size ? `，缓发 ${deferredContactIds.size} 人` : ""));

  // ④ 限额裁剪（按封数，整组保留）— 在写 state 之前，totalItems 才与实际发送数一致，进度条才能到 100%
  const { kept, keptCount, dropped } = trimByBudget(ordered, qCheck.remaining);
  if (dropped > 0) Log.warn("send.quota", `限额裁剪: ${items.length} 组/${items.reduce((s, it) => s + it.recipients.length, 0)} 封 → ${kept.length} 组/${keptCount} 封`);
  for (const it of kept) {
    if (!queues.has(it.accountId)) queues.set(it.accountId, []);
    queues.get(it.accountId)!.push(it);
  }

  // ⑤ 写 state — 基于裁剪后的数据
  stateHydrated = true;   // 新批次接管状态后，重启水合不得再回头覆盖
  state = {
    batchId, totalItems: kept.length, sentCount: 0, failedCount: 0,
    isPaused: false, isRunning: autoStart, currentItem: null, delaySeconds: 0, delayUntil: null, delayReason: null,
    pausedReason: null,
    accountStats: accounts.map(a => {
      const total = queues.get(a.id)?.length || 0;
      return { accountId: a.id, email: a.email, sent: 0, failed: 0, total, isCircuitOpen: false };
    }),
  };

  try {
    const now = new Date().toISOString();
    const rows: any[] = [];
    for (const [aid, q] of queues) {
      const acctEmail = accounts.find(a => a.id === aid)?.email || "";
      for (const item of q) {
        rows.push({
          id: item.id, batchId, campaignId: item.campaignId ?? null,
          companyName: item.companyName, companyId: item.companyId,
          recipients: JSON.stringify(item.recipients),
          accountId: aid, accountEmail: acctEmail,
          subject: item.subject, tplBody: item.tplBody, contactVars: JSON.stringify(item.contactVars),
          tplName: item.tplName || null,
          country: item.country || null, language: item.language || null,
          cc: item.cc || null,
          sendMode: item.sendMode || "bcc",
          status: "pending", createdAt: now,
        });
      }
    }
    // 清旧队 + 写新队同生共死：不包事务时若插入中途失败，旧批次已被 DELETE、新批次残缺，
    // 重启后既回不来也续不上（「队列丢失」的放大器）
    getRawDb().transaction(() => {
      getDb().delete(sendQueue).run();
      for (let i = 0; i < rows.length; i += 200) {
        getDb().insert(sendQueue).values(rows.slice(i, i + 200)).run();
      }
    })();
    saveDatabase();
  } catch (err) {
    Log.warn("send.queuePersist", `写入发送队列表失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!autoStart) {
    Log.info("send.enqueue", `批次 ${batchId}: ${kept.length} 组已入队，等待用户在队列页手动开始`);
    return okResult({ batchId, queued: kept.length, queuedCount: keptCount, dropped, deferredContactIds: [...deferredContactIds] });
  }

  Log.info("send.start", `批次 ${batchId}: ${kept.length} 组, ${accounts.length} 账号（全局串行）`);
  saveRunningBatch(batchId);   // 运行中标志落盘：退出/崩溃后启动可自动续跑
  void runBatchLoop();
  return okResult({ batchId, queued: kept.length, queuedCount: keptCount, dropped, deferredContactIds: [...deferredContactIds] });
}

/** 入队结果：batchId + 入队规模 + 配额裁剪掉的组数（前端据此提示） */
export interface EnqueueResult {
  batchId: string;
  queued: number;      // 实际入队组数
  queuedCount: number; // 实际入队封数（收件人数）
  dropped: number;     // 因限额被整组丢弃的组数
  deferredContactIds: number[]; // 亲和缓发（历史发信账号熔断中，本批未入队）的联系人
}

export async function startSend(bucketKeys: string[], templates?: SendTemplate[], autoStart = true, contactIds?: number[]): Promise<Result<EnqueueResult>> {
  Log.debug("send.start", `buckets=${bucketKeys.join(",")} templates=${templates?.length || 0} autoStart=${autoStart} directIds=${contactIds?.length || 0}`);
  const qr = templates && templates.length > 0 ? buildQueue(bucketKeys, templates, contactIds) : buildAdaptiveQueue(bucketKeys, contactIds);
  if (!qr.success) return failResult(qr.error);
  return startQueue(qr.data, autoStart);
}

/** 动态更新：按选中的客户跟进联系人 + 手动内容组装队列。
 *  sendMode="individual"（v6.1 用户拍板）：每个联系人单独一封，收件人走 To —— 像人工手发；
 *  缺省 bcc：同公司亲和桶合并一封，收件人走 BCC 互不可见。 */
export function buildDynamicQueue(contactIds: number[], subject: string, body: string, cc?: string, sendMode?: "individual" | "bcc"): Result<SendItem[]> {
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

  const affinity = lastSentAccountMap(validRows.map(c => c.id));
  const activeSet = new Set(selectableAccounts().map(a => a.id));
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

    // 单发模式（v6.1）：每个联系人单独一封，各自渲染变量；账号亲和复核在 startQueue 同一套判据
    if (sendMode === "individual") {
      for (const c of sorted) {
        const companyName = c.companyId ? (companyMap.get(c.companyId) || "") : "";
        const vars: TemplateVars = {
          firstName: c.firstName, lastName: c.lastName, company: companyName,
          email: c.email, title: c.title, phone: c.phone,
        };
        items.push({
          id: nanoid(), companyName: companyName || `#${c.companyId || "N/A"}`,
          companyId: c.companyId || 0,
          recipients: [{ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email }],
          subject: renderTemplate(subject, vars), tplBody: body,
          contactVars: vars, tplName: "动态更新",
          country: companyCountryMap.get(c.companyId || 0) || c.country || undefined,
          language: c.language || undefined,
          accountId: affinity.get(c.id) ?? 0, status: "pending", // 0 = 无亲和/不可用，startQueue 复核（熔断缓发）
          ...(cc ? { cc } : {}), sendMode: "individual",
        });
      }
      continue;
    }

    // 亲和分桶（不换人发）：历史账号不同的联系人各自成组，BCC 组内历史账号必须一致；
    // 桶账号不可用（停用/熔断）时不硬标 — startQueue 同套判据复核（熔断的组会被缓发）
    for (const bucket of partitionByAffinity(sorted, affinity)) {
      const first = bucket.rows[0]!;
      const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";
      // 动态发信 subject 也要按联系人变量渲染（模板模式在 buildQueue 已渲染；
      // 此处曾漏渲染 → 生产会把「跟进 {{company}}」原样发出去，沙箱演练 S5 捕获）
      const dynVars: TemplateVars = {
        firstName: first.firstName, lastName: first.lastName, company: companyName,
        email: first.email, title: first.title, phone: first.phone,
      };
      const subj = renderTemplate(subject, dynVars);
      // 桶内历史账号一致（partitionByAffinity 保证）；账号不可用（停用/熔断）时置 0，
      // startQueue 同套判据复核 — 熔断亲和组会被缓发，停用组进新客轮换
      const aid = bucket.affinity > 0 && activeSet.has(bucket.affinity) ? bucket.affinity : 0;

      for (let s = 0; s < bucket.rows.length; s += groupSize) {
        const chunk = bucket.rows.slice(s, s + groupSize);
        items.push({
          id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
          companyId: first.companyId || 0,
          recipients: chunk.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
          subject: subj, tplBody: body,
          contactVars: dynVars,
          tplName: "动态更新",
          country: companyCountryMap.get(first.companyId || 0) || first.country || undefined,
          language: first.language || undefined,
          accountId: aid, status: "pending", // 0 = 无亲和，startQueue 会进新客轮换池
          ...(cc ? { cc } : {}),
        });
      }
    }
  }
  return okResult(items);
}

export async function startDynamicSend(contactIds: number[], subject: string, body: string, autoStart = true, cc?: string, sendMode?: "individual" | "bcc"): Promise<Result<EnqueueResult>> {
  const qr = buildDynamicQueue(contactIds, subject, body, cc, sendMode);
  if (!qr.success) return failResult(qr.error);
  return startQueue(qr.data, autoStart);
}

// 检查时间窗口（跟操作系统时区：2026-09-06 用户拍板，不再固定北京时间）
function inWindow(sched: typeof DEFAULT_SCHEDULE): boolean {
  if (!sched.timeWindowEnabled) return true;
  const h = new Date().getHours(); // 本机时区小时
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
  const sendAttempts = new Map<string, number>(); // P1-2: 每组瞬态重试次数（组 id → 已重试数）

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
      state.delayReason = "window"; // 前端据此显示"未到发送时段"而非 60 秒倒计时
      push(EVENTS.SEND_PROGRESS, state);
      await sleep(waitMs);
      if (loopGen !== myGen) return; // 已被新批次接管
      if (!state.isRunning) break;
      state.delaySeconds = 0;
      state.delayUntil = null;
      state.delayReason = null;
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
        // P1-2: 成功即清零持久化熔断计数。sender_block 熔断不由 SMTP 成功解（只有一键解除/24h 过期），
        // 连原因与过期时刻一起清的是 smtp_fail 那条账
        try {
          const cur = getDb().select({ circuitReason: emailAccounts.circuitReason })
            .from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
          getDb().update(emailAccounts)
            .set({
              consecutiveFails: 0,
              ...(cur?.circuitReason === "sender_block"
                ? {} : { circuitOpenAt: null, circuitResetAfter: null, circuitReason: null }),
            })
            .where(eq(emailAccounts.id, accountId)).run();
        } catch { /* */ }
        recordQuotaSend(item.recipients.length);
        let stageAdvanced = 0; // 本组阶段推进人数（日志可观测）
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
            // v4.4: 发送阶段推进 — SMTP 确认成功后才推进（cold→f1→…→f4 封顶），失败/阻隔不动 stage
            try {
              const cRow = getDb().select({ stage: contacts.stage }).from(contacts).where(eq(contacts.id, rc.contactId)).get();
              if (cRow) {
                const ns = nextStage(cRow.stage);
                if (ns !== (cRow.stage || "cold")) {
                  getDb().update(contacts).set({ stage: ns, updatedAt: now }).where(eq(contacts.id, rc.contactId)).run();
                  stageAdvanced++;
                }
              }
            } catch { /* 推进失败不影响发送记录 */ }
            // 智能发信任务推进（docs/smart-send-spec.md §3.1）：真实发出 → 任务触点记一轮、排下一轮。
            // 惰性 import 防循环依赖（campaign.service 引本服务的 buildDynamicQueue/类型）。
            try { void import("./campaign.service").then(cm => cm.onCampaignSendSent(rc.contactId)); } catch { /* 任务推进失败不影响发送记录 */ }
            // v4.0: 发信不再自动标已触达 — reached 只能用户手动设置/改标签触发
          } catch (err) {
            Log.error("send.record", rc.email, err instanceof Error ? err.stack : undefined);
          }
        }
        // P0-2: 每组即时落盘 —— 30s 窗口内崩溃会重发已触达客户，74ms/组的写盘成本可接受
        saveDatabase();
        if (stageAdvanced > 0) Log.info("send.stage", `${item.companyName}: ${stageAdvanced}/${item.recipients.length} 人阶段已推进`);
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.sent++;
      } else {
        // P1-2: 瞬态错误有界重试（≤2 次，间隔 5s）——重试期间不计熔断、不落 failed
        const attempt = (sendAttempts.get(item.id) ?? 0) + 1;
        sendAttempts.set(item.id, attempt);
        if (classifySmtpError(r.error || "") === "transient" && attempt <= 2) {
          Log.warn("send.retry", `${item.companyName}: 瞬态错误，第 ${attempt}/2 次重试（${(r.error || "").slice(0, 120)}）`);
          state.currentItem = null;
          state.delaySeconds = 5;
          state.delayUntil = new Date(Date.now() + 5000).toISOString();
          state.delayReason = "group";
          push(EVENTS.SEND_PROGRESS, state);
          const ok = await sleep(5000);
          if (loopGen !== myGen) return; // 已被新批次接管
          state.delaySeconds = 0; state.delayUntil = null; state.delayReason = null;
          if (!ok) break;
          i--; // 同组重试
          continue;
        }
        item.status = "failed"; item.error = r.error; state.failedCount++;
        try { getDb().update(sendQueue).set({ status: "failed", error: r.error }).where(eq(sendQueue.id, item.id)).run(); } catch { /* */ }
        // 智能发信任务失败回退（docs/smart-send-spec.md §3.2）：重试耗尽的目标回 pending 明天再试，不无声丢触点
        try { for (const rc of item.recipients) void import("./campaign.service").then(cm => cm.onCampaignSendFailed(rc.contactId)); } catch { /* */ }
        saveDatabase(); // P0-2: 失败态同样即时落盘，崩溃恢复不会重发已判定失败的组
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.failed++;
        const n = (failsByAccount.get(accountId) ?? 0) + 1;
        failsByAccount.set(accountId, n);
        // P1-2: 熔断计数持久化（重启后熔断状态可见）。
        // 单次 SMTP 失败不许顺手清掉 sender_block 熔断——那是服务商拦截驱动的另一条账，
        // 只有「一键解除」或 24h 过期能解（规范 §4/§6）。
        try {
          const cur = getDb().select({ circuitReason: emailAccounts.circuitReason })
            .from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
          const opened = new Date();
          const patch = n >= 3
            ? {
              consecutiveFails: n, circuitOpenAt: opened.toISOString(),
              circuitResetAfter: new Date(opened.getTime() + CIRCUIT_TTL_MS).toISOString(), circuitReason: "smtp_fail",
            }
            : { consecutiveFails: n, ...(cur?.circuitReason === "sender_block" ? {} : { circuitOpenAt: null, circuitResetAfter: null, circuitReason: null }) };
          getDb().update(emailAccounts).set(patch).where(eq(emailAccounts.id, accountId)).run();
        } catch { /* 统计失败不影响发送 */ }
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
      state.delayReason = "group";
      push(EVENTS.SEND_PROGRESS, state);
      const ok = await sleep(ms);
      if (loopGen !== myGen) return; // 已被新批次接管：delayUntil 归新循环，别去清它
      state.delaySeconds = 0;
      state.delayUntil = null;
      state.delayReason = null;
      if (!ok) break;
    }
  }

  if (loopGen !== myGen) return; // 已被新批次接管，本轮收尾作废
  const allDone = plan.every(x => x.status !== "pending");
  if (allDone) {
    state.isRunning = false;
    saveRunningBatch(null);   // 批次跑完：清运行中标志，重启不再触发自动续跑
    Log.info("send.done", `${state.sentCount}/${state.totalItems}`);
    push(EVENTS.SEND_PROGRESS, state);
  }
  } catch (err: unknown) {
    // 兜底：循环意外抛错若不管，会让 isRunning 永远卡 true、批次静默死亡（表现为"倒计时结束后不再发送"）
    Log.error("send.loop", err instanceof Error ? (err.stack || err.message) : String(err));
    if (loopGen === myGen) {
      state.isRunning = false; state.isPaused = false;
      state.currentItem = null; state.delaySeconds = 0; state.delayUntil = null; state.delayReason = null;
      push(EVENTS.SEND_PROGRESS, state);
    }
  }
}

/** 暂停发送。reason=user（默认，用户手动点暂停）| sender_block（服务商拦截退信触发，队列页据此出横幅）。 */
export function pauseSend(reason: "user" | "sender_block" = "user"): Result<void> {
  state.isPaused = true;
  state.pausedReason = reason;
  pauseDelay();
  if (reason === "sender_block") push(EVENTS.SEND_PROGRESS, state);
  return okResult(undefined);
}
export function resumeSend(): Result<void> { state.isPaused = false; state.pausedReason = null; resumeDelay(); return okResult(undefined); }

/** 账号熔断态在批次内的真实上报（sender_block 触发时把该账号的卡标红，不让它继续显示"绿着"） */
export function markAccountCircuitOpen(accountId: number): void {
  const s = state.accountStats.find(x => x.accountId === accountId);
  if (s) s.isCircuitOpen = true;
  push(EVENTS.SEND_PROGRESS, state);
}

/** 取消当前批次：中断串行调度循环，队列丢弃（已发送的仍保留 interactions 记录） */
export function cancelSend(): Result<void> {
  if (!state.isRunning) return okResult(undefined);
  state.isRunning = false;
  state.pausedReason = null;
  abortFlag = true;
  saveRunningBatch(null);   // 用户主动取消：清运行中标志，重启不得自动续跑被取消的批次
  if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
  if (delayResolve) { const r = delayResolve; delayResolve = null; delayRemaining = 0; r(false); }
  Log.info("send.cancel", `批次 ${state.batchId || "?"} 已取消`);
  push(EVENTS.SEND_PROGRESS, state);
  return okResult(undefined);
}
/** 预览模板渲染效果（用第一个联系人；签名随账号，预览不含） */
export function previewTemplate(template: SendTemplate): Result<{ subject: string; body: string }> {
  const first = getDb().select().from(contacts).limit(1).get();
  if (!first) return failResult("没有联系人可预览");
  return okResult({
    subject: renderTemplate(template.subject, first),
    body: renderTemplate(template.body, first),
  });
}

export function getSendStatus(): Result<SendStatus> { hydrateStateFromDb(); return okResult({ ...state }); }

/** 返回所有队列项（展示用精简投影），内存优先 → DB 兜底（重启后恢复）。
 *  刻意剔除 tplBody/contactVars：正文模板每组数 KB，队列页不显示它 ——
 *  123 组全量每 3s 走一遍 IPC 会让队列页进卡、滚动掉帧（发送用的正文引擎内部自持，不走这里）。 */
export function getQueueItems(): Result<Array<Omit<SendItem, "tplBody" | "contactVars"> & { accountEmail?: string }>> {
  // 内存优先
  let items: Array<Omit<SendItem, "tplBody" | "contactVars"> & { accountEmail?: string }> = [];
  const accounts = getDb().select().from(emailAccounts).all();
  const emailMap = new Map(accounts.map(a => [a.id, a.email]));
  for (const [aid, q] of queues) {
    for (const item of q) {
      items.push({
        id: item.id, companyName: item.companyName, companyId: item.companyId,
        recipients: item.recipients, accountId: item.accountId,
        subject: item.subject, tplName: item.tplName,
        country: item.country, language: item.language,
        status: item.status, error: item.error, sentAt: item.sentAt,
        seq: item.seq, cc: item.cc, sendMode: item.sendMode,
        accountEmail: emailMap.get(aid) || `#${aid}`,
      });
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
      tplName: r.tplName || undefined,
      country: r.country || undefined, language: r.language || undefined,
      status: r.status === "sending" ? "pending" : (r.status as SendItem["status"]),
      error: r.error || undefined, sentAt: r.sentAt || undefined,
      cc: r.cc || undefined,
      sendMode: (r.sendMode as "individual" | "bcc") || "bcc",
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

    const accounts = selectableAccounts();
    if (accounts.length === 0) return failResult(activeAccountCount() > 0
      ? "所有启用账号都在发信熔断中（服务商反垃圾/限流拦截或连续失败）——到设置页账号卡点「解除熔断」，或等 24 小时自动过期"
      : "没有可用的发件账号");

    // 配额守卫 — 与 startQueue 同一条门（否则中断批次次日恢复会直接突破当日限额）
    const qCheck = checkQuota();
    if (!qCheck.ok) return failResult(qCheck.reason || "已达全局发信限额");

    const batchId = rows[0]!.batchId || nanoid();

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
        sendMode: (r.sendMode as "individual" | "bcc") || "bcc",  // 同上：单发/合并语义随行恢复，不能丢
      });
    }

    // 排序重建（不换人发）：落库行已带入队时定下的账号 — 账号仍在可用池的组原样恢复
    // （亲和关系随行保留）；账号熔断中的组跳过本轮回（保持 pending，解除后可再恢复）；
    // 只有账号已停用/删除的组才改派轮换池。公司交错仍管发送顺序（防"账号1连发完→账号2"）。
    const shuffled = interleaveCompanies(items);
    const rotIds = accounts.map(a => a.id);
    const poolIds = new Set(rotIds);
    const fusedIds = circuitAccountIds();
    const rebuilt: Array<SendItem & { seq: number }> = [];
    let rot = 0;
    let fusedSkipped = 0;
    for (const it of shuffled) {
      if (poolIds.has(it.accountId)) { rebuilt.push({ ...it, seq: rebuilt.length }); continue; }
      if (fusedIds.has(it.accountId)) { fusedSkipped++; continue; } // 不换人发：熔断组挂起待下轮
      rebuilt.push({ ...it, accountId: rotIds.length > 0 ? rotateAccountId(rot++, rotIds) : it.accountId, seq: rebuilt.length });
    }
    if (fusedSkipped > 0) Log.info("send.affinity", `恢复批次: ${fusedSkipped} 组的历史发信账号熔断中，本轮挂起（不换人发）`);
    if (rebuilt.length === 0) {
      return failResult("待恢复的组都在熔断账号上（不换人发，不改派）——到设置页解除熔断后再恢复");
    }

    // 限额裁剪（按封数，整组保留，createdAt 顺序）
    const { kept, keptCount, dropped } = trimByBudget(rebuilt, qCheck.remaining);
    if (dropped > 0) {
      Log.warn("send.quota", `恢复批次裁剪: ${rebuilt.length} 组 → ${kept.length} 组`);
      const keptIds = new Set(kept.map(k => k.id));
      for (const it of rebuilt) {
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

    stateHydrated = true;   // 恢复的批次接管状态后，重启水合不得再回头覆盖
    state = {
      batchId, totalItems: totalItems + sentCount + failedCount,
      sentCount, failedCount,
      isPaused: false, isRunning: true, currentItem: null, delaySeconds: 0, delayUntil: null, delayReason: null,
      pausedReason: null,
      accountStats: accounts.map(a => {
        const total = queues.get(a.id)?.length || 0;
        return { accountId: a.id, email: a.email, sent: 0, failed: 0, total, isCircuitOpen: false };
      }),
    };

    Log.info("send.resume", `恢复批次 ${batchId}: ${kept.length} 待发送, ${sentCount} 已完成`);
    saveRunningBatch(batchId);   // 恢复续跑同样视为"运行中"：再次退出/崩溃后仍可自动续跑
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
