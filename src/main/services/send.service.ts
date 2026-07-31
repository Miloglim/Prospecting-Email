import { nanoid } from "nanoid";
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { interactions, type InsertInteractionRow } from "../db/schema/interactions";
import { emailAccounts } from "../db/schema/accounts";
import { eq, like } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";
import { EVENTS } from "../events";

// ── 类型定义 ──

export interface QueueItem {
  id: string;
  contactEmail: string;
  contactId: number;
  contactName: string;
  subject: string;
  body: string;
  accountId: number;
  status: "pending" | "sending" | "sent" | "failed";
  error?: string;
  sentAt?: string;
}

export interface SendConfig {
  stageFilter?: string[];
  accountId?: number;
  search?: string;
}

export interface SendStatus {
  queueLength: number;
  sentCount: number;
  failedCount: number;
  isPaused: boolean;
  isRunning: boolean;
  consecutiveFails: number;
  cooldownSeconds: number;
}

// ── 引擎状态 ──

let state: SendStatus = {
  queueLength: 0, sentCount: 0, failedCount: 0,
  isPaused: false, isRunning: false,
  consecutiveFails: 0, cooldownSeconds: 0,
};

let queue: QueueItem[] = [];
let currentBatchId: string | null = null;
let tickTimeout: ReturnType<typeof setTimeout> | null = null;
let cooldownTimeout: ReturnType<typeof setTimeout> | null = null;

/** 推送事件的回调，由 transport 层注入（ponytail: service 不直接 import BrowserWindow） */
let pushFn: ((channel: string, data: unknown) => void) | null = null;
export function setPushFn(fn: (channel: string, data: unknown) => void) {
  pushFn = fn;
}
function push(channel: string, data: unknown) {
  try { pushFn?.(channel, data); } catch { /* 静默降级 */ }
}

/** SMTP 发送函数，由 transport 层注入 */
let sendMailFn: ((item: QueueItem) => Promise<Result<void>>) | null = null;
export function setSendMailFn(fn: (item: QueueItem) => Promise<Result<void>>) {
  sendMailFn = fn;
}

// ── 队列操作 ──

export async function startSend(config: SendConfig): Promise<Result<string>> {
  Log.debug("send.start", JSON.stringify(config));

  if (state.isRunning) {
    return failResult("已有发送任务运行中");
  }

  // 查联系人
  let query = getDb().select().from(contacts);
  if (config.stageFilter && config.stageFilter.length > 0) {
    // 按 CRM 阶段筛选 — 需要 JOIN crm_stages
    // ponytail: 简单实现，先查全部再内存过滤
  }
  if (config.search) {
    query = query.where(
      like(contacts.email, `%${config.search}%`)
    ) as typeof query;
  }
  const allContacts = query.all();

  // 查账号
  const accounts = config.accountId
    ? getDb().select().from(emailAccounts).where(eq(emailAccounts.id, config.accountId)).all()
    : getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();

  if (accounts.length === 0) {
    return failResult("没有可用的发件账号");
  }

  // 构建队列
  const batchId = nanoid(12);
  queue = [];

  for (let i = 0; i < allContacts.length; i++) {
    const c = allContacts[i]!;
    const account = accounts[i % accounts.length]!;
    // ponytail: 简单轮询分配账号

    queue.push({
      id: nanoid(),
      contactEmail: c.email,
      contactId: c.id,
      contactName: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email,
      subject: "",  // 由调用方先渲染再传入，或在此处渲染
      body: "",
      accountId: account.id,
      status: "pending",
    });
  }

  // 重置状态
  state = {
    queueLength: queue.length,
    sentCount: 0,
    failedCount: 0,
    isPaused: false,
    isRunning: true,
    consecutiveFails: 0,
    cooldownSeconds: 0,
  };
  currentBatchId = batchId;

  Log.info("send.start", `批次 ${batchId}: ${queue.length} 封待发送`);

  // 启动发送循环
  tick();

  return okResult(batchId);
}

export function pauseSend(): Result<void> {
  Log.debug("send.pause", "");
  state.isPaused = true;
  return okResult(undefined);
}

export function resumeSend(): Result<void> {
  Log.debug("send.resume", "");
  state.isPaused = false;
  tick();
  return okResult(undefined);
}

export function getSendStatus(): Result<SendStatus> {
  return okResult({ ...state, queueLength: queue.filter(q => q.status === "pending").length });
}

// ── 发送循环 ──

async function tick() {
  if (!state.isRunning || state.isPaused) return;

  const pending = queue.find(q => q.status === "pending");
  if (!pending) {
    // 队列发完
    state.isRunning = false;
    Log.info("send.done", `批次 ${currentBatchId}: 完成 ${state.sentCount}/${state.sentCount + state.failedCount}`);
    push(EVENTS.SEND_PROGRESS, state);
    return;
  }

  if (!sendMailFn) {
    Log.error("send.tick", "sendMailFn 未注入");
    pending.status = "failed";
    pending.error = "发送函数未配置";
    state.failedCount++;
    state.isRunning = false;
    return;
  }

  pending.status = "sending";
  push(EVENTS.SEND_PROGRESS, { ...state, currentItem: pending });

  const result = await sendMailFn(pending);

  if (result.success) {
    pending.status = "sent";
    pending.sentAt = new Date().toISOString();
    state.sentCount++;
    state.consecutiveFails = 0;

    // 记录互动
    try {
      getDb().insert(interactions).values({
        contactId: pending.contactId,
        type: "sent",
        direction: "outbound",
        channel: "email",
        subject: pending.subject,
        accountId: pending.accountId,
        createdAt: pending.sentAt,
      }).run();
      saveDatabase();
    } catch (err: unknown) {
      Log.error("send.tick", "记录互动失败", err instanceof Error ? err.stack : undefined);
    }
  } else {
    pending.status = "failed";
    pending.error = result.error;
    state.failedCount++;
    state.consecutiveFails++;

    // 熔断检查
    if (state.consecutiveFails >= 3) {
      enterCooldown();
      return;
    }
  }

  // 间隔
  const delayMs = 30_000; // 30 秒默认，后续从 config 读取
  tickTimeout = setTimeout(tick, delayMs);
}

// ── 熔断器 ──

function enterCooldown() {
  const exp = Math.min(state.consecutiveFails - 2, 5); // 1→4→8→16→32
  state.cooldownSeconds = Math.min(Math.pow(2, exp) * 60, 1800);
  state.isPaused = true;

  Log.warn("send.circuit", `熔断触发: 连续 ${state.consecutiveFails} 次失败，冷却 ${state.cooldownSeconds}s`);
  push(EVENTS.CIRCUIT_CHANGED, { consecutiveFails: state.consecutiveFails, cooldownSeconds: state.cooldownSeconds, isPaused: true });

  cooldownTimeout = setTimeout(() => {
    state.isPaused = false;
    state.consecutiveFails = 0;
    Log.info("send.circuit", "熔断恢复");
    push(EVENTS.CIRCUIT_CHANGED, { consecutiveFails: 0, cooldownSeconds: 0, isPaused: false });
    tick();
  }, state.cooldownSeconds * 1000);
}

/** 清理定时器（应用退出时调用） */
export function cleanupSendEngine() {
  if (tickTimeout) clearTimeout(tickTimeout);
  if (cooldownTimeout) clearTimeout(cooldownTimeout);
  state.isRunning = false;
  Log.info("send.cleanup", "引擎已清理");
}
