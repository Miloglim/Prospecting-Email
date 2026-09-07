// ── 发信任务（Campaign）服务：计划批准后的自动跟进闭环 ────────────────
// 引擎不动：本服务只"往队列喂料 + 订阅发送结果回调"（docs/smart-send-spec.md）。
//  · 队列函数经 setCampaignQueueFn 注入（对齐 setSendBccFn/setImapFetchBodyFn 的解耦惯例，
//    也让单测沙箱不必拉起整个发送引擎）；
//  · send/inbox 侧的进度与止损钩子反向调本服务，用惰性 require 避免循环依赖；
//  · 资格硬闸（用户拍板 §0.5-2）：status 为 replied / reached 的联系人绝不入队，双重生效。
import * as crypto from "crypto";
import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { sendCampaigns, sendCampaignTargets, contacts, templates } from "../db/schema";
import { buildDynamicQueue, type SendItem } from "./send.service";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";

export interface CampaignTouch { stage: string; delayDays: number; templateId?: number }
export interface CreateCampaignInput {
  name: string;
  contactIds: number[];
  /** 触点计划按数组顺序执行：第 1 项=首信（立即），之后每项在上封发出 delayDays 天后发 */
  touches: CampaignTouch[];
  autoSend?: boolean;
  targetFilter?: Record<string, unknown>;
}

/** 资格硬闸：这些状态的联系人不能进分批队列（用户拍板：已回复/已触达由用户引导决策） */
const BLOCKED_STATUS = new Set(["replied", "reached"]);
const TERMINAL_TARGET = new Set(["sent", "replied", "bounced", "unsubscribed", "skipped"]);

type EnqueueFn = (items: SendItem[], autoStart: boolean) => Promise<Result<{ batchId: string }>>;
let enqueueFn: EnqueueFn | null = null;
/** 由发送 transport 注入真实队列入口（startQueue）；未注入时扫描器只记日志不动 */
export function setCampaignQueueFn(fn: EnqueueFn): void { enqueueFn = fn; }

const nowIso = () => new Date().toISOString();
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

// ── 创建（名单定格，所见即所发）──────────────────────────────────
/** 创建前预览：与 createCampaign 同一资格判据，供确认卡展示「命中/排除/样本名单」 */
export function previewCampaign(contactIds: number[]): Result<{
  total: number; eligible: number; excluded: number;
  sample: Array<{ id: number; name: string; email: string }>;
}> {
  const ids = [...new Set((contactIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return failResult("名单为空");
  const rows = getDb().select({
    id: contacts.id, status: contacts.status,
    firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
  }).from(contacts).where(inArray(contacts.id, ids)).all();
  const found = new Map(rows.map(r => [r.id, r]));
  const eligibleRows = ids.map(id => found.get(id)).filter((r): r is NonNullable<typeof r> =>
    !!r && !BLOCKED_STATUS.has(r.status ?? ""));
  return okResult({
    total: ids.length,
    eligible: eligibleRows.length,
    excluded: ids.length - eligibleRows.length,
    sample: eligibleRows.slice(0, 5).map(r => ({
      id: r.id,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
      email: r.email,
    })),
  });
}

export function createCampaign(input: CreateCampaignInput): Result<{ id: string; eligible: number; excluded: number }> {
  const name = input.name?.trim();
  if (!name) return failResult("任务名必填");
  const touches = (input.touches ?? []).filter(t => t && t.stage);
  if (!touches.length) return failResult("触点计划不能为空（至少一个 stage，如 initial）");
  const ids = [...new Set((input.contactIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return failResult("名单为空：先圈定收件人");

  // 资格硬闸（第一重）：已回复/已触达在建任务时就被排除，且如实报告排除数量
  const rows = getDb().select({ id: contacts.id, status: contacts.status })
    .from(contacts).where(inArray(contacts.id, ids)).all();
  const found = new Map(rows.map(r => [r.id, r.status ?? ""]));
  const eligible: number[] = [];
  let excluded = 0;
  for (const id of ids) {
    const st = found.get(id);
    if (st == null) { excluded++; continue; }            // 名单里有人已不在库
    if (BLOCKED_STATUS.has(st)) { excluded++; continue; }
    eligible.push(id);
  }
  if (!eligible.length) {
    return failResult(`名单里 ${excluded} 人全部不符合资格（已回复/已触达/已不在库），无可发对象——这些客户的后续由你在客户页引导。`);
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  getDb().insert(sendCampaigns).values({
    id, name,
    status: "running",
    autoSend: input.autoSend === false ? 0 : 1,
    targetFilterJson: JSON.stringify(input.targetFilter ?? {}),
    touchPlanJson: JSON.stringify(touches),
  }).run();
  const t0 = nowIso();
  getDb().insert(sendCampaignTargets).values(eligible.map(cid => ({
    campaignId: id, contactId: cid, status: "pending", round: 0, nextTouchAt: t0, updatedAt: t0,
  }))).run();
  Log.info("campaign.create", `任务 ${id}「${name}」：名单 ${eligible.length} 人（排除 ${excluded}），${touches.length} 触点，autoSend=${input.autoSend !== false}`);
  return okResult({ id, eligible: eligible.length, excluded });
}

// ── 生命周期控制（Phase B 工具与发送中心按钮共用）──────────────────
export function setCampaignStatus(id: string, status: "running" | "paused" | "stopped"): Result<void> {
  const c = getDb().select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  getDb().update(sendCampaigns).set({ status, updatedAt: nowIso() }).where(eq(sendCampaigns.id, id)).run();
  if (status === "stopped") {
    // 终止 = 清空全部待发触点（在途批次照常被引擎发完，不追回）
    getDb().update(sendCampaignTargets)
      .set({ status: "skipped", nextTouchAt: null, updatedAt: nowIso() })
      .where(and(eq(sendCampaignTargets.campaignId, id), inArray(sendCampaignTargets.status, ["pending", "queued"]))).run();
  }
  Log.info("campaign.status", `任务 ${id} → ${status}`);
  return okResult(undefined);
}

// ── 发送结果回调（send.service 成功/失败路径惰性调用）──────────────
/** 一封真实发出（SMTP 确认）→ 该联系人名下 queued 目标推进一轮 */
export function onCampaignSendSent(contactId: number): void {
  try {
    const db = getDb();
    const targets = db.select().from(sendCampaignTargets)
      .where(and(eq(sendCampaignTargets.contactId, contactId), eq(sendCampaignTargets.status, "queued"))).all();
    for (const t of targets) {
      const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, t.campaignId)).get();
      if (!c || c.status === "stopped") { markTarget(t.id, "skipped", null); continue; }
      const plan = safePlan(c.touchPlanJson);
      const nextRound = t.round + 1;
      if (nextRound >= plan.length) {
        markTarget(t.id, "sent", null, nextRound, nowIso());      // 计划走完
      } else {
        markTarget(t.id, "pending", plusDays(plan[nextRound]!.delayDays), nextRound, nowIso());   // nextRound<plan.length 已判
      }
    }
    refreshCampaignDone(contactId);
  } catch (err) {
    Log.warn("campaign.progress", `推进失败 contact=${contactId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 一封最终失败（重试耗尽）→ 目标回到待发，明天再试（不无声丢触点） */
export function onCampaignSendFailed(contactId: number): void {
  try {
    const db = getDb();
    const targets = db.select().from(sendCampaignTargets)
      .where(and(eq(sendCampaignTargets.contactId, contactId), eq(sendCampaignTargets.status, "queued"))).all();
    for (const t of targets) markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
  } catch { /* 失败回退不阻塞发送主流程 */ }
}

/** 联系人信号止损（inbox 分类钩子）：回复/退订/bounce 止损，OOO 顺延 3 天 */
export function onContactSignal(contactId: number, kind: "replied" | "bounce" | "autoreply"): void {
  try {
    const db = getDb();
    if (kind === "autoreply") {
      // OOO 不止损：待发触点顺延 3 天（"暂缓"语义落进调度）
      db.update(sendCampaignTargets)
        .set({ nextTouchAt: plusDays(3), updatedAt: nowIso() })
        .where(and(eq(sendCampaignTargets.contactId, contactId), eq(sendCampaignTargets.status, "pending"))).run();
      return;
    }
    const to = kind === "replied" ? "replied" : "bounced";
    db.update(sendCampaignTargets)
      .set({ status: to, nextTouchAt: null, updatedAt: nowIso() })
      .where(and(eq(sendCampaignTargets.contactId, contactId), inArray(sendCampaignTargets.status, ["pending", "queued"]))).run();
    refreshCampaignDone(contactId);
    if (kind === "replied") Log.info("campaign.stoploss", `联系人 ${contactId} 已回复 → 名单内待发跟进全部止损`);
  } catch { /* 止损失败不阻塞收信主流程 */ }
}

// ── 调度扫描：到期触点 → 组队列（引擎侧硬闸在此）────────────────────
export async function scanDueCampaigns(): Promise<void> {
  if (!enqueueFn) return;   // transport 未装配（如单测未注入）就不动
  try {
    const db = getDb();
    // 僵尸对账：queued 超 24h 没等到成功/失败回调（熔断批量判死、进程中断等）→ 回 pending 明天再试。
    // 成功回调会推进目标并刷新 updated_at，所以这里仍是 queued 且 24h 未动 = 回调确实没来。
    db.update(sendCampaignTargets)
      .set({ status: "pending", nextTouchAt: plusDays(1), updatedAt: nowIso() })
      .where(and(eq(sendCampaignTargets.status, "queued"), lte(sendCampaignTargets.updatedAt, plusDays(-1)))).run();
    const due = db.select({
      t: sendCampaignTargets,
      cStatus: contacts.status,
      cLanguage: contacts.language,
      companyName: contacts.lastName,
      email: contacts.email,
    }).from(sendCampaignTargets)
      .innerJoin(contacts, eq(contacts.id, sendCampaignTargets.contactId))
      .innerJoin(sendCampaigns, eq(sendCampaigns.id, sendCampaignTargets.campaignId))
      .where(and(
        eq(sendCampaignTargets.status, "pending"),
        eq(sendCampaigns.status, "running"),
        lte(sendCampaignTargets.nextTouchAt, nowIso()),
      )).all();
    if (!due.length) return;

    // 按任务分组；资格硬闸（第二重）：扫描时联系人是 replied/reached → 标 skipped 不入队
    const byCampaign = new Map<string, typeof due>();
    for (const row of due) {
      if (row.cStatus && BLOCKED_STATUS.has(row.cStatus)) {
        markTarget(row.t.id, "skipped", null);
        continue;
      }
      const list = byCampaign.get(row.t.campaignId) ?? [];
      list.push(row);
      byCampaign.set(row.t.campaignId, list);
    }

    for (const [campaignId, list] of byCampaign) {
      const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, campaignId)).get();
      if (!c || c.status !== "running") continue;
      const plan = safePlan(c.touchPlanJson);
      const items: SendItem[] = [];
      const enqueuedTargets: Array<{ id: number; contactId: number }> = [];
      for (const row of list) {
        const t = row.t;
        const step = plan[t.round];
        if (!step) { markTarget(t.id, "sent", null, t.round); continue; }   // 计划走完兜底
        // 冷却：该联系人在任何任务里已有"已入队未发"的触点 → 本轮跳过顺延（防重复打扰）
        const inflight = db.select({ n: sql<number>`count(*)` }).from(sendCampaignTargets)
          .where(and(eq(sendCampaignTargets.contactId, t.contactId), eq(sendCampaignTargets.status, "queued")))
          .get()?.n ?? 0;
        if (inflight > 0) { markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt); continue; }
        const tpl = pickCampaignTemplate(step.stage, row.cLanguage, step.templateId);
        if (!tpl) {
          Log.warn("campaign.scan", `任务 ${campaignId} 缺 stage=${step.stage} 的启用模板，触点顺延 1 天`);
          markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
          continue;
        }
        // buildDynamicQueue 自按联系人变量渲染 subject/body（含公司分组/BCC 语义），传原始模板即可
        const qr = buildDynamicQueue([t.contactId], tpl.subject, tpl.body);
        if (!qr.success || !qr.data.length) {
          Log.warn("campaign.scan", `任务 ${campaignId} 组装失败 contact=${t.contactId}: ${qr.success ? "空" : qr.error}`);
          markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
          continue;
        }
        items.push(...qr.data);
        enqueuedTargets.push({ id: t.id, contactId: t.contactId });
      }
      if (!items.length) continue;
      // 先标记 queued 再入队（并发扫描不会双入队）；入队失败回退 pending 顺延
      for (const et of enqueuedTargets) markTarget(et.id, "queued", null);
      const q = await enqueueFn(items, c.autoSend === 1);
      if (!q.success) {
        for (const et of enqueuedTargets) markTarget(et.id, "pending", plusDays(1));
        Log.warn("campaign.scan", `任务 ${campaignId} 入队失败，${enqueuedTargets.length} 个触点顺延 1 天: ${q.error}`);
        continue;
      }
      Log.info("campaign.scan", `任务 ${campaignId}「${c.name}」入队 ${items.length} 组（autoSend=${c.autoSend === 1}，批次 ${(q.data as { batchId?: string }).batchId ?? "?"}）`);
    }
  } catch (err) {
    Log.error("campaign.scan", "扫描失败", err instanceof Error ? (err.stack ?? String(err)) : String(err));
  }
}

/** 常驻调度器（transport 层启动，对齐 inbox 自动抓取的既有模式） */
let schedTimer: ReturnType<typeof setInterval> | null = null;
export function startCampaignScheduler(intervalMs = 10 * 60 * 1000): void {
  if (schedTimer) return;
  schedTimer = setInterval(() => { void scanDueCampaigns(); }, intervalMs);
  Log.info("campaign.sched", `发信任务调度器已启动（每 ${Math.round(intervalMs / 60000)} 分钟扫描到期触点）`);
}

// ── 查询（agent status 工具与发送中心任务区共用）──────────────────
export interface CampaignOverviewItem {
  id: string; name: string; status: string; autoSend: boolean;
  total: number; pending: number; queued: number; sent: number;
  replied: number; bounced: number; unsubscribed: number; skipped: number;
  planRounds: number;
  createdAt: string;
}
export function getCampaignOverview(): CampaignOverviewItem[] {
  const db = getDb();
  const campaigns = db.select().from(sendCampaigns).all();
  const counts = db.select({
    campaignId: sendCampaignTargets.campaignId, status: sendCampaignTargets.status, n: sql<number>`count(*)`,
  }).from(sendCampaignTargets).groupBy(sendCampaignTargets.campaignId, sendCampaignTargets.status).all();
  const byCampaign = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const m = byCampaign.get(c.campaignId) ?? {};
    m[c.status] = c.n;
    byCampaign.set(c.campaignId, m);
  }
  return campaigns.map(c => {
    const m = byCampaign.get(c.id) ?? {};
    const g = (k: string) => m[k] ?? 0;
    let planRounds = 0;
    try { planRounds = (JSON.parse(c.touchPlanJson) as CampaignTouch[]).length; } catch { /* 坏计划按 0 */ }
    return {
      id: c.id, name: c.name, status: c.status, autoSend: c.autoSend === 1, planRounds,
      total: Object.values(m).reduce((a, b) => a + b, 0),
      pending: g("pending"), queued: g("queued"), sent: g("sent"),
      replied: g("replied"), bounced: g("bounced"), unsubscribed: g("unsubscribed"), skipped: g("skipped"),
      createdAt: c.createdAt,
    };
  });
}

export function getCampaignDetail(id: string): Result<{
  campaign: CampaignOverviewItem | null;
  targets: Array<{ contactId: number; name: string; email: string; status: string; round: number; nextTouchAt: string | null; lastSentAt: string | null }>;
}> {
  const db = getDb();
  const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  const overview = getCampaignOverview().find(x => x.id === id) ?? null;
  const targets = db.select({
    contactId: sendCampaignTargets.contactId, status: sendCampaignTargets.status,
    round: sendCampaignTargets.round, nextTouchAt: sendCampaignTargets.nextTouchAt,
    lastSentAt: sendCampaignTargets.lastSentAt,
    firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
  }).from(sendCampaignTargets)
    .leftJoin(contacts, eq(contacts.id, sendCampaignTargets.contactId))
    .where(eq(sendCampaignTargets.campaignId, id)).all();
  return okResult({
    campaign: overview,
    targets: targets.map(t => ({
      contactId: t.contactId, status: t.status, round: t.round,
      nextTouchAt: t.nextTouchAt, lastSentAt: t.lastSentAt,
      name: [t.firstName, t.lastName].filter(Boolean).join(" ") || t.email || "",
      email: t.email ?? "",
    })),
  });
}

// ── 内部 ────────────────────────────────────────────────────────
function safePlan(json: string): CampaignTouch[] {
  try {
    const arr = JSON.parse(json) as CampaignTouch[];
    return Array.isArray(arr) ? arr.filter(t => t && typeof t.stage === "string") : [];
  } catch { return []; }
}
function markTarget(id: number, status: string, nextTouchAt: string | null, round?: number, lastSentAt?: string | null): void {
  getDb().update(sendCampaignTargets)
    .set({ status, nextTouchAt, updatedAt: nowIso(), ...(round != null ? { round } : {}), ...(lastSentAt !== undefined ? { lastSentAt } : {}) })
    .where(eq(sendCampaignTargets.id, id)).run();
}
/** 该联系人名下全部目标终态 → 任务收尾 done */
function refreshCampaignDone(contactId: number): void {
  const db = getDb();
  const rows = db.select({ campaignId: sendCampaignTargets.campaignId, status: sendCampaignTargets.status })
    .from(sendCampaignTargets).where(eq(sendCampaignTargets.contactId, contactId)).all();
  const ids = [...new Set(rows.map(r => r.campaignId))];
  for (const cid of ids) {
    const remaining = db.select({ n: sql<number>`count(*)` }).from(sendCampaignTargets)
      .where(and(eq(sendCampaignTargets.campaignId, cid), ne(sendCampaignTargets.status, "done"),
        sql`${sendCampaignTargets.status} NOT IN ('sent','replied','bounced','unsubscribed','skipped')`))
      .get()?.n ?? 0;
    if (remaining === 0) {
      db.update(sendCampaigns).set({ status: "done", updatedAt: nowIso() })
        .where(and(eq(sendCampaigns.id, cid), eq(sendCampaigns.status, "running"))).run();
    }
  }
}
/** 挑任务触点模板：指定 id 优先；否则 stage 匹配里挑联系人语言，再回落任意启用模板 */
function pickCampaignTemplate(stage: string, language: string | null, templateId?: number): { subject: string; body: string } | null {
  const db = getDb();
  if (templateId) {
    const t = db.select().from(templates).where(eq(templates.id, templateId)).get();
    if (t && t.isActive) return { subject: t.subject, body: t.body };
  }
  const rows = db.select().from(templates)
    .where(and(eq(templates.stage, stage), eq(templates.isActive, 1))).all();
  if (!rows.length) return null;
  const lang = (language ?? "").toUpperCase();
  return rows.find(t => t.language.toUpperCase() === lang) ?? rows[0]!;
}
