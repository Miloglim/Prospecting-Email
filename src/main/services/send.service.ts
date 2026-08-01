import * as crypto from "crypto";
const nanoid = () => crypto.randomUUID().slice(0, 12);
import { getDb } from "../db";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { emailAccounts } from "../db/schema/accounts";
import { eq, sql as dsql } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";
import { EVENTS } from "../events";
import { loadConfig, DEFAULT_SCHEDULE } from "../config";

// ── 类型 ──

export interface SendItem {
  id: string; companyName: string; companyId: number;
  recipients: Array<{ contactId: number; email: string; name: string }>;
  accountId: number;
  subject: string;   // 渲染后的主题
  body: string;      // 渲染后的正文
  status: "pending" | "sending" | "sent" | "failed";
  error?: string; sentAt?: string;
}

export interface SendTemplate {
  subject: string;  // 含 {{firstName}} {{company}} 变量
  body: string;
}

export interface TimeBucket {
  key: string; label: string; description: string;
  contacts: ContactRow[]; count: number;
}

export interface SendStatus {
  batchId: string | null; totalItems: number; sentCount: number; failedCount: number;
  isPaused: boolean; isRunning: boolean;
  currentItem: SendItem | null; delaySeconds: number;
  accountStats: Array<{
    accountId: number; email: string; sent: number; failed: number; isCircuitOpen: boolean;
  }>;
}

const BUCKET_DEFS = [
  { key: "never", label: "从未发送", desc: "新联系人，第一次接触" },
  { key: "1-3", label: "1-3 天", desc: "最近刚发过，等回复" },
  { key: "4-7", label: "4-7 天", desc: "适合第一次跟进" },
  { key: "8-11", label: "7-11 天", desc: "适合第二次跟进" },
  { key: "over11", label: "11 天以上", desc: "冷掉了，重新激活" },
  { key: "autoreply", label: "自动回复", desc: "收到 OOO，等段时间再发" },
  { key: "active", label: "跟进中", desc: "CRM 管线里活跃客户" },
] as const;

// ── 引擎状态 ──

let state: SendStatus = {
  batchId: null, totalItems: 0, sentCount: 0, failedCount: 0,
  isPaused: false, isRunning: false, currentItem: null, delaySeconds: 0, accountStats: [],
};

let pushFn: ((c: string, d: unknown) => void) | null = null;
export function setPushFn(fn: (c: string, d: unknown) => void) { pushFn = fn; }
function push(c: string, d: unknown) { try { pushFn?.(c, d); } catch { /* */ } }

let sendBccFn: ((item: SendItem) => Promise<Result<void>>) | null = null;
export function setSendBccFn(fn: (item: SendItem) => Promise<Result<void>>) { sendBccFn = fn; }

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

  const sentRows = db.select({
    contactId: interactions.contactId,
    maxDate: dsql<string>`MAX(${interactions.createdAt})`,
  }).from(interactions)
    .where(eq(interactions.type, "sent"))
    .groupBy(interactions.contactId).all();

  const lastSentMap = new Map<number, string>();
  for (const r of sentRows) lastSentMap.set(r.contactId, r.maxDate);

  const autoRows = db.select({ contactId: interactions.contactId })
    .from(interactions).where(eq(interactions.type, "autoreply"))
    .groupBy(interactions.contactId).all();
  const autoSet = new Set(autoRows.map(r => r.contactId));

  const now = Date.now();
  const DAY = 86400000;
  const buckets = new Map<string, ContactRow[]>();
  BUCKET_DEFS.forEach(b => buckets.set(b.key, []));

  for (const c of allContacts) {
    if (autoSet.has(c.id)) { buckets.get("autoreply")!.push(c); continue; }

    const lastSent = lastSentMap.get(c.id);
    if (!lastSent) { buckets.get("never")!.push(c); continue; }

    const days = Math.floor((now - new Date(lastSent).getTime()) / DAY);
    if (days <= 3) buckets.get("1-3")!.push(c);
    else if (days <= 7) buckets.get("4-7")!.push(c);
    else if (days <= 11) buckets.get("8-11")!.push(c);
    else buckets.get("over11")!.push(c);
  }

  return okResult(BUCKET_DEFS.map(b => ({
    key: b.key, label: b.label, description: b.desc,
    contacts: buckets.get(b.key) || [], count: (buckets.get(b.key) || []).length,
  })));
}

// ── 模板渲染（沿用旧 PE: {{firstName}} {{company}}，兼容 {{ contact.firstName }}）──

function renderTemplate(template: string, contact: ContactRow): string {
  let out = template || "";
  const vars: Record<string, string> = {
    firstName: contact.firstName || "",
    lastName: contact.lastName || "",
    company: "", // 由调用方填充
    email: contact.email,
  };

  for (const [key, val] of Object.entries(vars)) {
    // 旧 PE 格式 {{firstName}}
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi"), val);
    // 兼容格式 {{ contact.firstName }}
    out = out.replace(new RegExp(`\\{\\{\\s*contact\\.${key}\\s*\\}\\}`, "gi"), val);
  }

  // 清理未替换的变量
  out = out.replace(/\{\{\s*[a-zA-Z_.]+\s*\}\}/g, "");
  return out;
}

// ── 构建队列（按公司合并 BCC + 渲染模板）──

function buildQueue(bucketKeys: string[], template?: SendTemplate): Result<SendItem[]> {
  const buckets = getTimeBuckets();
  if (!buckets.success) return failResult(buckets.error);

  const selected = new Map<number, ContactRow>();
  for (const b of buckets.data) {
    if (bucketKeys.includes(b.key)) for (const c of b.contacts) selected.set(c.id, c);
  }

  if (selected.size === 0) return failResult("没有选中的联系人");

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

  const items: SendItem[] = [];
  for (const [, group] of companyGroups) {
    const first = group[0]!;
    const companyName = first.companyId ? (companyMap.get(first.companyId) || "") : "";

    // 用组内第一个联系人渲染模板（BCC 组共享一封，取第一人为准）
    const subj = template ? renderTemplate(template.subject, { ...first }) : "Regarding our logistics partnership";
    const body = template ? renderTemplate(template.body, { ...first }) : "Hello, I hope this email finds you well.\n\nBest regards";

    items.push({
      id: nanoid(), companyName: companyName || `#${first.companyId || "N/A"}`,
      companyId: first.companyId || 0,
      recipients: group.map(c => ({ contactId: c.id, email: c.email, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email })),
      subject: subj, body,
      accountId: 0, status: "pending",
    });
  }
  return okResult(items);
}

// ── 多账号并行发送 ──

let queues: Map<number, SendItem[]> = new Map();
let abortFlags: Map<number, boolean> = new Map();

export async function startSend(bucketKeys: string[], template?: SendTemplate): Promise<Result<string>> {
  Log.debug("send.start", `buckets=${bucketKeys.join(",")}`);

  if (state.isRunning) return failResult("已有发送任务运行中");

  const qr = buildQueue(bucketKeys, template);
  if (!qr.success) return failResult(qr.error);

  const items = qr.data;
  if (items.length === 0) return failResult("没有待发送项");

  const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
  if (accounts.length === 0) return failResult("没有可用的发件账号");

  const batchId = nanoid();
  queues = new Map();
  abortFlags = new Map();

  for (let i = 0; i < items.length; i++) {
    const aid = accounts[i % accounts.length]!.id;
    if (!queues.has(aid)) queues.set(aid, []);
    queues.get(aid)!.push({ ...items[i]!, accountId: aid });
  }

  state = {
    batchId, totalItems: items.length, sentCount: 0, failedCount: 0,
    isPaused: false, isRunning: true, currentItem: null, delaySeconds: 0,
    accountStats: accounts.map(a => ({ accountId: a.id, email: a.email, sent: 0, failed: 0, isCircuitOpen: false })),
  };

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
      const r = await sendBccFn(item);
      if (r.success) {
        item.status = "sent"; state.sentCount++; fails = 0;
        const now = new Date().toISOString();
        for (const rc of item.recipients) {
          try {
            getDb().insert(interactions).values({ contactId: rc.contactId, type: "sent", direction: "outbound", channel: "email", accountId, createdAt: now }).run();
            const { updateContactStatus } = require("./contact.service");
            updateContactStatus(rc.contactId, "reached");
          } catch (err) {
            Log.error("send.record", rc.email, err instanceof Error ? err.stack : undefined);
          }
        }
        saveDatabase();
        const s = state.accountStats.find(x => x.accountId === accountId);
        if (s) s.sent++;
      } else {
        item.status = "failed"; item.error = r.error; state.failedCount++; fails++;
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
      state.delaySeconds = Math.floor(ms / 1000);
      push(EVENTS.SEND_PROGRESS, state);
      await sleep(ms);
      state.delaySeconds = 0;
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
/** 预览模板渲染效果（用第一个联系人） */
export function previewTemplate(template: SendTemplate): Result<{ subject: string; body: string }> {
  const first = getDb().select().from(contacts).limit(1).get();
  if (!first) return failResult("没有联系人可预览");
  return okResult({
    subject: renderTemplate(template.subject, first),
    body: renderTemplate(template.body, first),
  });
}

export function getSendStatus(): Result<SendStatus> { return okResult({ ...state }); }
export function cleanupSendEngine() {
  state.isRunning = false; abortFlags.forEach((_, k) => abortFlags.set(k, true));
  if (delayTimer) clearTimeout(delayTimer); Log.info("send.cleanup", "引擎已清理");
}
