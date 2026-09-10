// ── 发信任务（Campaign）服务：计划批准后的自动跟进闭环 ────────────────
// 引擎不动：本服务只"往队列喂料 + 订阅发送结果回调"（docs/smart-send-spec.md）。
//  · 队列函数经 setCampaignQueueFn 注入（对齐 setSendBccFn/setImapFetchBodyFn 的解耦惯例，
//    也让单测沙箱不必拉起整个发送引擎）；
//  · send/inbox 侧的进度与止损钩子反向调本服务，用惰性 require 避免循环依赖；
//  · 资格闸已按用户要求解除：已触达/已回复可入队（发不发由用户圈名单决定），
//    界面只在人数计数处提示包含多少位已触达/已回复。
import * as crypto from "crypto";
import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { sendCampaigns, sendCampaignTargets, contacts, templates, emailAccounts, sendQueue } from "../db/schema";
import { buildDynamicQueue, getSendStatus, getQuotaStatus, normalizeLang, type SendItem } from "./send.service";
import { assembleEmail, type Stage } from "./sentence-library";
import { isCircuitOpen } from "./sender-block.service";
import { Log } from "../logger";
import { okResult, failResult, type Result } from "../errors";

export interface CampaignTouch {
  stage: string;
  delayDays: number;
  templateId?: number;
  /** 内容模式：fixed=创建时粘贴的内容快照 / userTpl=用户模板（每轮入队取最新）/
   *  adaptive=匹配范围内随机取一条用户模板（同阶段→同语言优先，内容轮换防疲劳，规范 §0.7-3）/ system=内置句库。
   *  缺省=旧行为（用户模板优先、句库兜底），agent 创建的老任务不受影响。 */
  mode?: "fixed" | "userTpl" | "adaptive" | "system";
  /** mode=fixed 时的内容快照（subject/body 可含 {{firstName}} 等变量，入队时渲染；cc=抄送地址逗号分隔，v6.1） */
  content?: { subject: string; body: string; cc?: string };
}
export interface CampaignAccountPolicy {
  mode: "rotate" | "fixed";
  /** mode=fixed 时的账号 id 列表（非空才有效） */
  accountIds?: number[];
}
export interface CampaignSchedule {
  /** 任务级发送时段覆盖（本机时区整点，起止都填且不相等才生效）；缺省=继承全局设置 */
  windowStartHour?: number;
  windowEndHour?: number;
  /** 单日放行组数上限（组/天，0=不限）：超出部分顺延次日——定时器语义「今天到此为止，明天继续」 */
  dailyGroupCap?: number;
}
export interface CreateCampaignInput {
  name: string;
  contactIds: number[];
  /** 触点计划按数组顺序执行：第 1 项=首信（立即），之后每项在上封发出 delayDays 天后发 */
  touches: CampaignTouch[];
  autoSend?: boolean;
  targetFilter?: Record<string, unknown>;
  /** false=保存为草稿（status=draft，不排触点）；缺省/true=创建即运行 */
  startNow?: boolean;
  /** 创建入口标识（ui 向导 / agent 对话），缺省 agent（旧调用兼容） */
  createdBy?: "ui" | "agent";
  /** 发信账号策略，缺省 rotate（健康账号智能轮换） */
  accountPolicy?: CampaignAccountPolicy;
  /** 任务级调度覆盖，缺省继承全局 */
  schedule?: CampaignSchedule;
  /** 发送方式：individual=每个联系人单独一封（收件人走 To，缺省）/ bcc=同公司合并一封（v6.1 用户拍板） */
  sendMode?: "individual" | "bcc";
}

/** 已触达/已回复状态集合：不再拦截入队，仅用于界面计数提示（用户拍板：发不发由圈名单决定） */
const REACHED_REPLIED = new Set(["replied", "reached"]);

type EnqueueFn = (items: SendItem[], autoStart: boolean, opts?: { accountIds?: number[] }) => Promise<Result<{ batchId: string; deferredContactIds?: number[] }>>;
let enqueueFn: EnqueueFn | null = null;
/** 由发送 transport 注入真实队列入口（startQueue）；未注入时扫描器只记日志不动 */
export function setCampaignQueueFn(fn: EnqueueFn): void { enqueueFn = fn; }

const nowIso = () => new Date().toISOString();
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const plusMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/** 触点计划入参校验与规范化：轮数上限、delayDays 范围、fixed 模式必须有内容快照 */
function normalizeTouches(touches: CampaignTouch[]): Result<CampaignTouch[]> {
  const list = (touches ?? []).filter(t => t && typeof t.stage === "string" && t.stage.trim());
  if (!list.length) return failResult("触点计划不能为空（至少一轮）");
  if (list.length > 6) return failResult("触点计划最多 6 轮");
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    const d = Math.max(0, Math.min(60, Math.floor(Number(t.delayDays) || 0)));
    list[i] = { ...t, delayDays: d };
    if (i === 0 && d !== 0) return failResult("首轮（第 1 封）无需间隔天数");
    if (t.mode === "fixed") {
      const s = (t.content?.subject ?? "").trim();
      const b = (t.content?.body ?? "").trim();
      if (!s || !b) return failResult(`第 ${i + 1} 轮选了「固定内容」但主题或正文为空`);
      const cc = (t.content?.cc ?? "").trim();
      list[i] = { ...t, delayDays: d, templateId: undefined, content: { subject: s, body: b, ...(cc ? { cc } : {}) } };
    }
  }
  return okResult(list);
}

/** 账号策略入参校验：fixed 必须带非空账号列表且账号存在 */
function normalizeAccountPolicy(policy?: CampaignAccountPolicy): Result<CampaignAccountPolicy> {
  if (!policy || policy.mode === "rotate") return okResult({ mode: "rotate" });
  const ids = [...new Set((policy.accountIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return failResult("指定发信账号需至少选择一个账号");
  const rows = getDb().select({ id: emailAccounts.id }).from(emailAccounts).where(inArray(emailAccounts.id, ids)).all();
  if (rows.length !== ids.length) return failResult("指定的发信账号里有不存在的账号");
  return okResult({ mode: "fixed", accountIds: ids });
}

function normalizeSchedule(schedule?: CampaignSchedule): CampaignSchedule {
  if (!schedule) return {};
  const h = (v: unknown): number | undefined => {
    const n = Math.floor(Number(v));
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : undefined;
  };
  const out: CampaignSchedule = {};
  const ws = h(schedule.windowStartHour);
  const we = h(schedule.windowEndHour);
  if (ws !== undefined && we !== undefined && ws !== we) { out.windowStartHour = ws; out.windowEndHour = we; }
  const cap = Math.floor(Number(schedule.dailyGroupCap));
  if (Number.isInteger(cap) && cap > 0) out.dailyGroupCap = cap;
  return out;
}

// ── 创建（名单定格，所见即所发）──────────────────────────────────
/** 创建前预览：与 createCampaign 同一判据（已触达/已回复照常入队），供确认卡展示「命中/包含已触达回复/样本名单」 */
export function previewCampaign(contactIds: number[]): Result<{
  total: number; eligible: number; excluded: number; reachedReplied: number;
  sample: Array<{ id: number; name: string; email: string }>;
}> {
  const ids = [...new Set((contactIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return failResult("名单为空");
  const rows = getDb().select({
    id: contacts.id, status: contacts.status,
    firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
  }).from(contacts).where(inArray(contacts.id, ids)).all();
  const found = new Map(rows.map(r => [r.id, r]));
  const eligibleRows = ids.map(id => found.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  return okResult({
    total: ids.length,
    eligible: eligibleRows.length,
    excluded: ids.length - eligibleRows.length,
    reachedReplied: eligibleRows.filter(r => REACHED_REPLIED.has(r.status ?? "")).length,
    sample: eligibleRows.slice(0, 5).map(r => ({
      id: r.id,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
      email: r.email,
    })),
  });
}

/** 创建/草稿编辑共用的校验与构建（名单资格闸 + 计划/账号/时段规范化） */
function buildCampaignCore(input: CreateCampaignInput): Result<{
  name: string; touches: CampaignTouch[]; eligible: number[]; excluded: number;
  accountPolicy: CampaignAccountPolicy; schedule: CampaignSchedule; sendMode: "individual" | "bcc";
}> {
  const name = input.name?.trim();
  if (!name) return failResult("任务名必填");
  const touchesRes = normalizeTouches(input.touches);
  if (!touchesRes.success) return failResult(touchesRes.error);
  const touches = touchesRes.data;
  const ids = [...new Set((input.contactIds ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return failResult("名单为空：先圈定收件人");
  const acctRes = normalizeAccountPolicy(input.accountPolicy);
  if (!acctRes.success) return failResult(acctRes.error);
  const schedule = normalizeSchedule(input.schedule);

  // 名单对账（资格闸已解除）：只剔除已不在库的联系人；已触达/已回复照常入队，
  // 界面在人数计数处提示包含多少位（发不发由用户圈名单决定）
  const rows = getDb().select({ id: contacts.id })
    .from(contacts).where(inArray(contacts.id, ids)).all();
  const found = new Set(rows.map(r => r.id));
  const eligible = ids.filter(id => found.has(id));
  const excluded = ids.length - eligible.length;
  if (!eligible.length) {
    return failResult("名单里的联系人都已不在库，无可发对象");
  }
  return okResult({ name, touches, eligible, excluded, accountPolicy: acctRes.data, schedule,
    sendMode: input.sendMode === "bcc" ? "bcc" : "individual" });
}

export function createCampaign(input: CreateCampaignInput): Result<{ id: string; eligible: number; excluded: number }> {
  const core = buildCampaignCore(input);
  if (!core.success) return failResult(core.error);
  const { name, touches, eligible, excluded, accountPolicy, schedule, sendMode } = core.data;

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const isDraft = input.startNow === false;
  getDb().insert(sendCampaigns).values({
    id, name,
    status: isDraft ? "draft" : "running",
    autoSend: input.autoSend === false ? 0 : 1,
    targetFilterJson: JSON.stringify(input.targetFilter ?? {}),
    touchPlanJson: JSON.stringify(touches),
    createdBy: input.createdBy === "ui" ? "ui" : "agent",
    accountPolicy: accountPolicy.mode,
    accountIdsJson: accountPolicy.mode === "fixed" ? JSON.stringify(accountPolicy.accountIds) : null,
    scheduleJson: Object.keys(schedule).length ? JSON.stringify(schedule) : null,
    sendMode,
  }).run();
  // 草稿的 nextTouchAt=null（启动时才计时）；运行中=立即到期，下个扫描周期入队
  const t0 = isDraft ? null : nowIso();
  getDb().insert(sendCampaignTargets).values(eligible.map(cid => ({
    campaignId: id, contactId: cid, status: "pending", round: 0, nextTouchAt: t0, updatedAt: nowIso(),
  }))).run();
  Log.info("campaign.create", `任务 ${id}「${name}」：名单 ${eligible.length} 人（排除 ${excluded}），${touches.length} 触点，${isDraft ? "草稿" : "运行"}，autoSend=${input.autoSend !== false}，账号=${accountPolicy.mode}`);
  return okResult({ id, eligible: eligible.length, excluded });
}

/** 草稿编辑（发送中心向导）：仅 draft 态可改，名单与计划全量替换（草稿从未排触点，无在途状态可保） */
export function updateCampaignDraft(id: string, input: CreateCampaignInput): Result<{ eligible: number; excluded: number }> {
  const c = getDb().select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  if (c.status !== "draft") return failResult("只有草稿可以编辑");
  const core = buildCampaignCore(input);
  if (!core.success) return failResult(core.error);
  const { name, touches, eligible, excluded, accountPolicy, schedule, sendMode } = core.data;

  getDb().update(sendCampaigns).set({
    name, touchPlanJson: JSON.stringify(touches),
    autoSend: input.autoSend === false ? 0 : 1,
    targetFilterJson: JSON.stringify(input.targetFilter ?? c.targetFilterJson),
    accountPolicy: accountPolicy.mode,
    accountIdsJson: accountPolicy.mode === "fixed" ? JSON.stringify(accountPolicy.accountIds) : null,
    scheduleJson: Object.keys(schedule).length ? JSON.stringify(schedule) : null,
    sendMode,
    updatedAt: nowIso(),
  }).where(eq(sendCampaigns.id, id)).run();
  getDb().delete(sendCampaignTargets).where(eq(sendCampaignTargets.campaignId, id)).run();
  getDb().insert(sendCampaignTargets).values(eligible.map(cid => ({
    campaignId: id, contactId: cid, status: "pending", round: 0, nextTouchAt: null, updatedAt: nowIso(),
  }))).run();
  Log.info("campaign.updateDraft", `草稿 ${id}「${name}」已更新：${eligible.length} 人 × ${touches.length} 轮`);
  return okResult({ eligible: eligible.length, excluded });
}

// ── 生命周期控制（Phase B 工具与发送中心按钮共用）──────────────────
export function setCampaignStatus(id: string, status: "running" | "paused" | "stopped"): Result<void> {
  const c = getDb().select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  // 草稿 → running = 启动：待发触点从现在开始计时（首信下个扫描周期入队）
  if (status === "running" && c.status === "draft") {
    getDb().update(sendCampaignTargets)
      .set({ nextTouchAt: nowIso(), updatedAt: nowIso() })
      .where(and(eq(sendCampaignTargets.campaignId, id), eq(sendCampaignTargets.status, "pending"))).run();
  }
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
    // 引擎忙（含暂停）：本轮跳过不空转——扫描器每 10 分钟再来，引擎空了自然接上
    const st = getSendStatus();
    if (st.success && st.data.isRunning) return;
    // 全局配额预算（-1=不限）：autoSend 任务入队前逐封扣减，预算耗尽的触点顺延次日，不再靠引擎裁剪丢组
    const quota = getQuotaStatus();
    let quotaBudget = quota.ok ? quota.remaining : 0;
    // 僵尸对账：queued 超 24h 没等到成功/失败回调（熔断批量判死、进程中断等）→ 回 pending 明天再试。
    // 成功回调会推进目标并刷新 updated_at，所以这里仍是 queued 且 24h 未动 = 回调确实没来。
    db.update(sendCampaignTargets)
      .set({ status: "pending", nextTouchAt: plusDays(1), updatedAt: nowIso() })
      .where(and(eq(sendCampaignTargets.status, "queued"), lte(sendCampaignTargets.updatedAt, plusDays(-1)))).run();
    const due = db.select({
      t: sendCampaignTargets,
      cLanguage: contacts.language,
      cClientType: contacts.clientType,
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

    // 按任务分组（资格闸已解除：已触达/已回复照常入队，发不发由用户圈名单决定）
    const byCampaign = new Map<string, typeof due>();
    for (const row of due) {
      const list = byCampaign.get(row.t.campaignId) ?? [];
      list.push(row);
      byCampaign.set(row.t.campaignId, list);
    }

    for (const [campaignId, list] of byCampaign) {
      const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, campaignId)).get();
      if (!c || c.status !== "running") continue;
      const plan = safePlan(c.touchPlanJson);
      const sched = safeSchedule(c.scheduleJson);

      // 任务级时段覆盖（起止齐备才生效）：时段外不喂料，触点原样等下个扫描周期
      if (sched.windowStartHour !== undefined && sched.windowEndHour !== undefined) {
        const h = new Date().getHours();
        const inWin = sched.windowStartHour < sched.windowEndHour
          ? h >= sched.windowStartHour && h < sched.windowEndHour
          : h >= sched.windowStartHour || h < sched.windowEndHour;
        if (!inWin) continue;
      }

      // 账号策略：fixed=指定账号里筛掉熔断的；全熔断则整批顺延，不静默换号
      let fixedIds: number[] | null = null;
      if (c.accountPolicy === "fixed") {
        const ids = safeIds(c.accountIdsJson);
        fixedIds = healthyAccountIds(ids);
        if (fixedIds.length === 0) {
          for (const row of list) markTarget(row.t.id, "pending", plusDays(1), row.t.round, row.t.lastSentAt);
          Log.warn("campaign.scan", `任务 ${campaignId}「${c.name}」指定账号全部熔断/停用，${list.length} 触点顺延 1 天`);
          continue;
        }
      }

      const items: SendItem[] = [];
      const enqueuedTargets: Array<{ id: number; contactId: number }> = [];
      let cappedOut = 0;
      for (const row of list) {
        const t = row.t;
        const step = plan[t.round];
        if (!step) { markTarget(t.id, "sent", null, t.round); continue; }   // 计划走完兜底
        // 单日放行上限：本轮该任务放够了 → 余下触点顺延次日继续（定时器语义）
        const dailyCap = sched.dailyGroupCap ?? 0;
        if (dailyCap > 0 && enqueuedTargets.length >= dailyCap) {
          cappedOut++;
          markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
          continue;
        }
        // 今日配额耗尽 → 同样顺延次日
        if (c.autoSend === 1 && quotaBudget === 0) {
          cappedOut++;
          markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
          continue;
        }
        // 冷却：该联系人在任何任务里已有"已入队未发"的触点 → 本轮跳过顺延（防重复打扰）
        const inflight = db.select({ n: sql<number>`count(*)` }).from(sendCampaignTargets)
          .where(and(eq(sendCampaignTargets.contactId, t.contactId), eq(sendCampaignTargets.status, "queued")))
          .get()?.n ?? 0;
        if (inflight > 0) { markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt); continue; }
        // 内容按轮次模式解析：fixed=快照 / userTpl=用户模板(缺了句库兜底) / adaptive=匹配范围内随机一条 / system=句库 / 缺省=旧混合行为
        const content = resolveTouchContent(step, row.cLanguage, row.cClientType);
        if (!content) {
          Log.warn("campaign.scan", `任务 ${campaignId} 内容缺失 contact=${t.contactId}（round=${t.round} mode=${step.mode ?? "auto"}），顺延 1 天`);
          markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
          continue;
        }
        // buildDynamicQueue 自按联系人变量渲染 subject/body；sendMode 随任务（单发 To / 合并 BCC）、cc 随 fixed 快照
        const qr = buildDynamicQueue([t.contactId], content.subject, content.body, content.cc, c.sendMode === "bcc" ? "bcc" : "individual");
        if (!qr.success || !qr.data.length) {
          Log.warn("campaign.scan", `任务 ${campaignId} 组装失败 contact=${t.contactId}: ${qr.success ? "空" : qr.error}`);
          markTarget(t.id, "pending", plusDays(1), t.round, t.lastSentAt);
          continue;
        }
        items.push(...qr.data.map(it => ({ ...it, campaignId })));
        enqueuedTargets.push({ id: t.id, contactId: t.contactId });
      }
      if (!items.length) {
        if (cappedOut > 0) Log.info("campaign.scan", `任务 ${campaignId}「${c.name}」本轮放行上限/配额已满，${cappedOut} 触点顺延次日`);
        continue;
      }
      // 先标记 queued 再入队（并发扫描不会双入队）；入队失败回退 pending 顺延
      for (const et of enqueuedTargets) markTarget(et.id, "queued", null);
      const q = await enqueueFn(items, c.autoSend === 1, fixedIds ? { accountIds: fixedIds } : undefined);
      if (!q.success) {
        // 引擎刚被别的批次占用 → 10 分钟后重试（别把触点一脚踹到明天）；其他失败照旧顺延 1 天
        const busy = q.error.includes("运行中");
        const retryAt = busy ? plusMinutes(10) : plusDays(1);
        for (const et of enqueuedTargets) markTarget(et.id, "pending", retryAt);
        Log.warn("campaign.scan", `任务 ${campaignId} 入队失败，${enqueuedTargets.length} 个触点${busy ? "10 分钟后重试" : "顺延 1 天"}: ${q.error}`);
        continue;
      }
      // 亲和缓发（send.service 不换人发纪律）：历史发信账号熔断中的触点回 pending 明天再试，其余照发
      const deferredIds = new Set(q.data.deferredContactIds ?? []);
      if (deferredIds.size > 0) {
        for (const et of enqueuedTargets) {
          if (deferredIds.has(et.contactId)) markTarget(et.id, "pending", plusDays(1));
        }
        Log.info("campaign.scan", `任务 ${campaignId}「${c.name}」${deferredIds.size} 个触点因历史发信账号熔断缓发（不换人发），顺延次日`);
      }
      if (c.autoSend === 1 && quotaBudget >= 0) {
        quotaBudget -= items.filter(it => !deferredIds.has(it.recipients[0]?.contactId ?? -1)).reduce((n, it) => n + it.recipients.length, 0);
      }
      Log.info("campaign.scan", `任务 ${campaignId}「${c.name}」入队 ${items.length - deferredIds.size} 组（autoSend=${c.autoSend === 1}，批次 ${q.data.batchId}）`);
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
  /** 触点（封数）口径进度（规范 §0.7-1）：分子=Σ已发轮次，分母=终态触点已完成轮数 + 未终态触点×计划轮数 */
  touchesSent: number; touchesPlanned: number;
  /** 发送队列里仍归属本任务的组数（pending+sending）——运行情况挂在卡片背后 */
  queuedGroups: number;
  createdAt: string;
}
/** 触点终态：不再排新触点。进度分母对它们只计「已发出的轮数」——止损一个，分母收缩一个 */
const TERMINAL_TARGET_SQL = sql`${sendCampaignTargets.status} IN ('sent','replied','bounced','unsubscribed','skipped')`;
const asNum = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

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
  // 封数进度（多轮任务发送途中 sent 恒为 0，用它才有"正在往前走"的读数）
  const touchRows = db.select({
    campaignId: sendCampaignTargets.campaignId,
    sent: sql<number>`coalesce(sum(${sendCampaignTargets.round}), 0)`,
    stopped: sql<number>`coalesce(sum(case when ${TERMINAL_TARGET_SQL} then ${sendCampaignTargets.round} else 0 end), 0)`,
    open: sql<number>`coalesce(sum(case when ${TERMINAL_TARGET_SQL} then 0 else 1 end), 0)`,
  }).from(sendCampaignTargets).groupBy(sendCampaignTargets.campaignId).all();
  const tMap = new Map<string, { sent: number; stopped: number; open: number }>();
  for (const t of touchRows) tMap.set(t.campaignId, { sent: asNum(t.sent), stopped: asNum(t.stopped), open: asNum(t.open) });
  // 队列组归属（v5.9 任务驱动）：pending+sending 各分组计数，卡片进度与抽屉运行情况共用
  const qMap = new Map<string, number>();
  const qGroups = db.select({ campaignId: sendQueue.campaignId, status: sendQueue.status, n: sql<number>`count(*)` })
    .from(sendQueue).where(inArray(sendQueue.status, ["pending", "sending"]))
    .groupBy(sendQueue.campaignId, sendQueue.status).all();
  for (const q of qGroups) if (q.campaignId) qMap.set(q.campaignId, (qMap.get(q.campaignId) ?? 0) + q.n);
  return campaigns.map(c => {
    const m = byCampaign.get(c.id) ?? {};
    const g = (k: string) => m[k] ?? 0;
    let planRounds = 0;
    try { planRounds = (JSON.parse(c.touchPlanJson) as CampaignTouch[]).length; } catch { /* 坏计划按 0 */ }
    const t = tMap.get(c.id) ?? { sent: 0, stopped: 0, open: 0 };
    return {
      id: c.id, name: c.name, status: c.status, autoSend: c.autoSend === 1, planRounds,
      total: Object.values(m).reduce((a, b) => a + b, 0),
      pending: g("pending"), queued: g("queued"), sent: g("sent"),
      replied: g("replied"), bounced: g("bounced"), unsubscribed: g("unsubscribed"), skipped: g("skipped"),
      touchesSent: t.sent, touchesPlanned: t.stopped + t.open * Math.max(1, planRounds),
      queuedGroups: qMap.get(c.id) ?? 0,
      createdAt: c.createdAt,
    };
  });
}

export function getCampaignDetail(id: string): Result<{
  campaign: CampaignOverviewItem | null;
  targets: Array<{ contactId: number; name: string; email: string; status: string; round: number; nextTouchAt: string | null; lastSentAt: string | null }>;
  /** 该任务在发送队列里的组（运行情况：点开卡片看），按创建时间倒序 */
  queue: Array<{ id: string; companyName: string; recipientCount: number; status: string; error: string | null; sentAt: string | null; accountEmail: string | null }>;
  /** 原始配置（草稿编辑预填：触点计划/账号策略/调度覆盖），任务不存在时为 null */
  raw: {
    touches: CampaignTouch[];
    accountPolicy: "rotate" | "fixed";
    accountIds: number[];
    schedule: CampaignSchedule;
    autoSend: boolean;
  } | null;
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
  const queueRows = db.select({
    id: sendQueue.id, companyName: sendQueue.companyName, recipients: sendQueue.recipients,
    status: sendQueue.status, error: sendQueue.error, sentAt: sendQueue.sentAt,
    accountEmail: sendQueue.accountEmail, createdAt: sendQueue.createdAt,
  }).from(sendQueue).where(eq(sendQueue.campaignId, id)).all();
  return okResult({
    campaign: overview,
    targets: targets.map(t => ({
      contactId: t.contactId, status: t.status, round: t.round,
      nextTouchAt: t.nextTouchAt, lastSentAt: t.lastSentAt,
      name: [t.firstName, t.lastName].filter(Boolean).join(" ") || t.email || "",
      email: t.email ?? "",
    })),
    queue: queueRows
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(q => ({
        id: q.id, companyName: q.companyName ?? "",
        recipientCount: (() => { try { return (JSON.parse(q.recipients) as unknown[]).length; } catch { return 0; } })(),
        status: q.status, error: q.error, sentAt: q.sentAt, accountEmail: q.accountEmail,
      })),
    raw: {
      touches: safePlan(c.touchPlanJson),
      accountPolicy: c.accountPolicy === "fixed" ? "fixed" : "rotate",
      accountIds: safeIds(c.accountIdsJson),
      schedule: safeSchedule(c.scheduleJson),
      autoSend: c.autoSend === 1,
      sendMode: c.sendMode === "bcc" ? "bcc" : "individual",
    },
  });
}

// ── 内部 ────────────────────────────────────────────────────────
function safePlan(json: string): CampaignTouch[] {
  try {
    const arr = JSON.parse(json) as CampaignTouch[];
    return Array.isArray(arr) ? arr.filter(t => t && typeof t.stage === "string") : [];
  } catch { return []; }
}
function safeSchedule(json: string | null): CampaignSchedule {
  if (!json) return {};
  try {
    const s = JSON.parse(json) as CampaignSchedule;
    const out: CampaignSchedule = {};
    const ws = s?.windowStartHour, we = s?.windowEndHour;
    if (Number.isInteger(ws) && Number.isInteger(we) && ws !== we) {
      out.windowStartHour = ws;
      out.windowEndHour = we;
    }
    const cap = s?.dailyGroupCap;
    if (Number.isInteger(cap) && (cap as number) > 0) out.dailyGroupCap = cap;
    return out;
  } catch { return {}; }
}
function safeIds(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  } catch { return []; }
}
/** 指定账号里筛健康的（启用 + 熔断不在生效期）——口径与发送引擎 selectableAccounts 一致 */
function healthyAccountIds(ids: number[]): number[] {
  if (!ids.length) return [];
  const rows = getDb().select({
    id: emailAccounts.id, isActive: emailAccounts.isActive,
    circuitOpenAt: emailAccounts.circuitOpenAt, circuitResetAfter: emailAccounts.circuitResetAfter,
  }).from(emailAccounts).where(inArray(emailAccounts.id, ids)).all();
  const ok = new Set(rows.filter(r => r.isActive === 1 && !isCircuitOpen(r)).map(r => r.id));
  return ids.filter(id => ok.has(id));
}
/** 轮次内容解析：fixed=创建时快照 / userTpl=用户模板（缺了句库兜底）/ adaptive=匹配范围内随机一条 /
 *  system=句库 / 缺省=旧混合行为（模板优先句库兜底） */
function resolveTouchContent(
  step: CampaignTouch, language: string | null, clientType: string | null,
): { subject: string; body: string; cc?: string } | null {
  if (step.mode === "fixed") {
    const s = (step.content?.subject ?? "").trim();
    const b = (step.content?.body ?? "").trim();
    if (!s || !b) return null;
    const cc = (step.content?.cc ?? "").trim();
    return cc ? { subject: s, body: b, cc } : { subject: s, body: b };
  }
  if (step.mode !== "system") {
    const tpl = pickCampaignTemplate(step.stage, language, step.templateId, step.mode === "adaptive");
    if (tpl) return tpl;
  }
  const ct = clientType === "direct" || clientType === "peer" ? clientType : "general";
  try {
    return assembleEmail({ lang: normalizeLang(language), clientType: ct, stage: step.stage as Stage });
  } catch { return null; }
}
function markTarget(id: number, status: string, nextTouchAt: string | null, round?: number, lastSentAt?: string | null): void {
  getDb().update(sendCampaignTargets)
    .set({ status, nextTouchAt, updatedAt: nowIso(), ...(round != null ? { round } : {}), ...(lastSentAt !== undefined ? { lastSentAt } : {}) })
    .where(eq(sendCampaignTargets.id, id)).run();
}
/** 该联系人名下全部目标终态 → 任务收尾 done（fixed 轮内容快照随即清空：新周期不许盲发旧内容） */
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
      const c = db.select().from(sendCampaigns).where(and(eq(sendCampaigns.id, cid), eq(sendCampaigns.status, "running"))).get();
      if (!c) continue;
      const clearedPlan = clearFixedContent(c.touchPlanJson);
      db.update(sendCampaigns).set({ status: "done", updatedAt: nowIso(), ...(clearedPlan ? { touchPlanJson: clearedPlan } : {}) })
        .where(eq(sendCampaigns.id, cid)).run();
      if (clearedPlan) Log.info("campaign.done", `任务 ${cid} 完结：固定内容快照已清空（再启动新周期前需重填，防旧内容重发）`);
    }
  }
}

/** 完结时清空 fixed 轮内容快照；计划里没有 fixed 快照返回 null（免写库）。JSON.stringify 会丢弃 undefined 键 */
function clearFixedContent(json: string): string | null {
  try {
    const plan = JSON.parse(json) as CampaignTouch[];
    if (!Array.isArray(plan) || !plan.some(t => t?.mode === "fixed" && t.content)) return null;
    return JSON.stringify(plan.map(t => (t?.mode === "fixed" ? { ...t, content: undefined } : t)));
  } catch { return null; }
}

// ── 再启动（done → 新周期）────────────────────────────────────────
/** 完结任务再启动新周期：退信/退订保持终态（再发只会再退），其余触点重置待发（round 0、立即到期）。
 *  fixed 轮快照已随上周期完结清空 → 转回草稿让用户先补新内容，绝不盲发旧内容。 */
export function restartCampaign(id: string): Result<{ reset: number }> {
  const db = getDb();
  const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  if (c.status !== "done") return failResult("只有已完成的任务可以再启动新周期");
  const plan = safePlan(c.touchPlanJson);
  const missing = plan.findIndex(t => t.mode === "fixed" && (!(t.content?.subject ?? "").trim() || !(t.content?.body ?? "").trim()));
  if (missing >= 0) {
    db.update(sendCampaigns).set({ status: "draft", updatedAt: nowIso() }).where(eq(sendCampaigns.id, id)).run();
    Log.info("campaign.restart", `任务 ${id}「${c.name}」固定内容已清空 → 转回草稿待补内容`);
    return failResult(`第 ${missing + 1} 轮是固定内容，上周期完结时已清空——已转回草稿，请编辑补好新内容再启动`);
  }
  const resetN = db.select({ n: sql<number>`count(*)` }).from(sendCampaignTargets)
    .where(and(eq(sendCampaignTargets.campaignId, id), inArray(sendCampaignTargets.status, ["sent", "replied", "skipped"])))
    .get()?.n ?? 0;
  db.update(sendCampaignTargets)
    .set({ status: "pending", round: 0, nextTouchAt: nowIso(), lastSentAt: null, updatedAt: nowIso() })
    .where(and(eq(sendCampaignTargets.campaignId, id), inArray(sendCampaignTargets.status, ["sent", "replied", "skipped"]))).run();
  db.update(sendCampaigns).set({ status: "running", updatedAt: nowIso() }).where(eq(sendCampaigns.id, id)).run();
  Log.info("campaign.restart", `任务 ${id}「${c.name}」再启动新周期：重置 ${resetN} 触点（退信/退订保持终态）`);
  return okResult({ reset: resetN });
}

/** 删除任务：任务行 + 触点账本一起删；发送队列与历史记录保留（send_queue.campaign_id 变悬挂，历史页照旧可查，
 *  不跟着删用户数据）。running/paused 拒删——在途批次的回调要靠 campaignId 找任务，边发边删会让账本对不上。 */
export function deleteCampaign(id: string): Result<{ deletedTargets: number }> {
  const db = getDb();
  const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  if (c.status === "running" || c.status === "paused") return failResult("任务还在跑，先点「终止」再删除");
  // 计数用 select count(*)：sql.js 与 better-sqlite3 的 delete().run() 返回形状不一致，拿 changes 会在两边读出两个数
  const n = db.select({ n: sql<number>`count(*)` }).from(sendCampaignTargets)
    .where(eq(sendCampaignTargets.campaignId, id)).get()?.n ?? 0;
  db.delete(sendCampaignTargets).where(eq(sendCampaignTargets.campaignId, id)).run();
  db.delete(sendCampaigns).where(eq(sendCampaigns.id, id)).run();
  Log.info("campaign.delete", `任务 ${id}「${c.name}」已删除（触点 ${n} 条；队列与发送历史保留）`);
  return okResult({ deletedTargets: n });
}
/** 挑任务触点模板：指定 id 优先；否则 stage 匹配里挑联系人语言，再回落任意启用模板。
 *  adaptive=同一匹配范围内随机取一条（内容轮换防模板疲劳，规范 §0.7-3），此时不认指定 id */
function pickCampaignTemplate(
  stage: string, language: string | null, templateId?: number, adaptive = false,
): { subject: string; body: string } | null {
  const db = getDb();
  if (!adaptive && templateId) {
    const t = db.select().from(templates).where(eq(templates.id, templateId)).get();
    if (t && t.isActive) return { subject: t.subject, body: t.body };
  }
  const rows = db.select().from(templates)
    .where(and(eq(templates.stage, stage), eq(templates.isActive, 1))).all();
  if (!rows.length) return null;
  const lang = (language ?? "").toUpperCase();
  const sameLang = rows.filter(t => t.language.toUpperCase() === lang);
  const pool = sameLang.length ? sameLang : rows;
  if (adaptive && pool.length > 1) return pool[Math.floor(Math.random() * pool.length)]!;
  return pool[0]!;
}
