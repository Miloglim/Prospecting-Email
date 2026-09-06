import * as fs from "fs";
import * as path from "path";
import { and, count, desc, eq, gte, ne, sql } from "drizzle-orm";
import { APP_ROOT } from "../config";
import { getDb, saveDatabase } from "../db";
import { agentSuggestions } from "../db/schema/agent";
import { contacts } from "../db/schema/contacts";
import { inboxMessages } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { rateQuotes } from "../db/schema/rates";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";
import { chat as llmChat } from "./ai.service";
import { checkReminders } from "./crm.service";
import { getSendStatus, getQueueItems } from "./send.service";
import { status as ratesStatus } from "./rate-sync.service";

// ── 首页「AI 建议行动」：每天一批预设，进空态只读库 ────────────────
// 六张卡以前是写死文案。现在的形状（用户定的）：
//   · 每天让模型看一遍程序的数据状况，为每个分区生成一批建议模板（每分区最多 8 条）存库；
//   · 每次切到新对话 → 骨架一闪 → 从当天批次里随机抽 2 条填上「今天」的数字；
//   · 生成永远在后台（启动后 / 当天批次缺失时补），首屏绝不等待模型；
//   · 端点没配、模型失败或产出不合规 → 那一区退回本地规则版模板，卡片照样有两条。
//
// 为什么存模板而不是成品句子：成品句子里写死「9 封未读」，一小时后变 12 封就成了假话。
// 存 {slot} 占位的模板，显示时按最新快照填槽 —— 「每天一批」与「数字永远新鲜」由此不打架。
// 填不上（该字段今天是 0 / 空）的模板直接跳过，不会出现「0 封未读要不要总结」这种废话。

export interface SuggestionItem { text: string; prompt: string }
export interface SuggestionGroup { title: string; cap: string; items: SuggestionItem[] }

/** 现状快照：只放「能变成一句建议」的字段，整份要进提示词，宁缺毋滥 */
export interface Snapshot {
  quotes: { total: number; expired: number; topPod: string | null; lastSyncDays: number | null };
  inbox: { unread: number; inquiries7d: number; latest: { who: string; subject: string } | null };
  crm: { dueToday: number; overdue: number; staleMaxDays: number; topName: string | null };
  send: { pendingGroups: number; pendingRecipients: number; failed: number; running: boolean; paused: boolean };
  accounts: { enabled: number; healthy: number; broken: string | null };
  contacts: { total: number; cold: number };
}

/** 六个分区的固定骨架（与渲染层兜底常量必须一字不差） */
export const GROUP_TITLES = ["查运价", "看市场行情", "管邮件", "跟进客户", "准备发信", "账号与公司"] as const;
export type GroupTitle = (typeof GROUP_TITLES)[number];

const CAP_FALLBACK: Record<GroupTitle, string> = {
  查运价: "接入钉钉《海运运价智能台账》本地镜像",
  看市场行情: "联网多源调研公开运价与船期，逐页核实并标注可信度",
  管邮件: "检索收件箱 + 逐封总结并给下一步建议",
  跟进客户: "联系人检索 + 到期提醒 + 记跟进（写操作需确认）",
  准备发信: "写开发信草稿 + 入队（不自动发送，需你在发送中心点开始）",
  "账号与公司": "发信账号健康检查 + 公司网络背调",
};

/**
 * 隐藏提示词的方法论前缀：卡上显示人话短句，点击时拼成「前缀 + 检索目标」发给助手。
 * 短句缺方法论约束，模型容易浅尝辄止；前缀把该分区「该怎么干、不许干什么」说死。
 * 渲染端兜底卡（CAPABILITIES）镜像了这份文案，改动须两边同步。
 */
export const GROUP_PROMPT: Record<GroupTitle, string> = {
  查运价: "在本地运价台账镜像中检索，按目的港、船司、柜型汇总报价并注明有效期；只报台账里真实存在的条目，查不到就明说，不要用市场价或记忆补数。",
  看市场行情: "围绕指定业务目标检索多个可信公开来源，交叉核对信息，整理可用资源、关键结论、发布日期和来源链接。明确标注无法核实或可能过期的信息。",
  管邮件: "检索本地收件箱，逐封给出发件人、主题、一句话摘要和下一步建议；需要回复或导出时先给草稿或清单等我确认，不要编造邮件里没有的内容。",
  跟进客户: "在联系人库与跟进记录里检索，给出匹配对象、最近跟进时间与状态；要写入跟进记录时先把内容给我确认。查不到就明说，不要猜测或张冠李戴。",
  准备发信: "撰写开发信草稿或查看发送队列状态；草稿先给我过目，只能入队不能自动发送，开始发送必须我自己在发送中心确认。写内容前先查库里的联系人与公司信息。",
  "账号与公司": "检查发信账号的健康状态，或对指定公司做公开网络背调；账号问题给出原因与修复建议，背调只依据可查到的公开信息并标注可信度，查不到的部分明确说查不到。",
};

/** 点击时实际发送的提示词 = 分区方法论前缀 + 显示文本作为检索目标（填槽后的今天数字一并带上） */
export function buildItemPrompt(title: GroupTitle, displayText: string): string {
  return `${GROUP_PROMPT[title]}\n检索目标：${displayText}`;
}

const DAY = 86400_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** 批次归属日按北京时间切，跨零点才算新的一天（与用户体感一致） */
export const beijingDay = (at = Date.now()) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);

// ── 槽位 ──────────────────────────────────────────────────

interface SlotDef { path: string; desc: string; unit: "count" | "days" | "text" }

const SLOTS: SlotDef[] = [
  { path: "quotes.total", desc: "台账里报价总条数", unit: "count" },
  { path: "quotes.expired", desc: "其中已过期的条数", unit: "count" },
  { path: "quotes.topPod", desc: "台账里条目最多的目的港（原文照抄，别翻译）", unit: "text" },
  { path: "quotes.lastSyncDays", desc: "台账距上次同步过了几天", unit: "days" },
  { path: "inbox.unread", desc: "未读邮件封数", unit: "count" },
  { path: "inbox.inquiries7d", desc: "近 7 天询盘封数", unit: "count" },
  { path: "inbox.latestWho", desc: "最新一封未读的发件人称呼", unit: "text" },
  { path: "inbox.latestSubject", desc: "最新一封未读的主题（会被截短）", unit: "text" },
  { path: "crm.overdue", desc: "逾期要跟进的**人数**（不是天数）", unit: "count" },
  { path: "crm.dueToday", desc: "今天到期跟进的人数", unit: "count" },
  { path: "crm.staleMaxDays", desc: "最久没跟进的**天数**", unit: "days" },
  { path: "crm.topName", desc: "逾期最久的那位联系人姓名", unit: "text" },
  { path: "send.pendingGroups", desc: "发送队列待发的组数", unit: "count" },
  { path: "send.pendingRecipients", desc: "队列待发里的收件人数", unit: "count" },
  { path: "send.failed", desc: "本轮发送失败的组数", unit: "count" },
  { path: "accounts.enabled", desc: "启用的发信账号数", unit: "count" },
  { path: "accounts.healthy", desc: "健康的发信账号数", unit: "count" },
  { path: "accounts.broken", desc: "有故障的那个账号邮箱（原文照抄）", unit: "text" },
  { path: "contacts.total", desc: "联系人总数", unit: "count" },
  { path: "contacts.cold", desc: "还在冷启动阶段的联系人数", unit: "count" },
];
const SLOT_BY_PATH = new Map(SLOTS.map(s => [s.path, s] as const));

/** 槽位 → 当前值。0 / 空 / null 的槽不进表：引用它的条目会被自动跳过 */
export function slotValues(s: Snapshot): Map<string, string> {
  const m = new Map<string, string>();
  const add = (path: string, v: number | string | null | undefined) => {
    if (typeof v === "number") { if (v > 0) m.set(path, String(v)); return; }
    const t = (v ?? "").trim();
    if (t) m.set(path, t);
  };
  add("quotes.total", s.quotes.total);
  add("quotes.expired", s.quotes.expired);
  add("quotes.topPod", s.quotes.topPod);
  add("quotes.lastSyncDays", s.quotes.lastSyncDays);
  add("inbox.unread", s.inbox.unread);
  add("inbox.inquiries7d", s.inbox.inquiries7d);
  add("inbox.latestWho", s.inbox.latest?.who);
  add("inbox.latestSubject", s.inbox.latest ? s.inbox.latest.subject.slice(0, 18) : null);
  add("crm.overdue", s.crm.overdue);
  add("crm.dueToday", s.crm.dueToday);
  add("crm.staleMaxDays", s.crm.staleMaxDays);
  add("crm.topName", s.crm.topName);
  add("send.pendingGroups", s.send.pendingGroups);
  add("send.pendingRecipients", s.send.pendingRecipients);
  add("send.failed", s.send.failed);
  add("accounts.enabled", s.accounts.enabled);
  add("accounts.healthy", s.accounts.healthy);
  add("accounts.broken", s.accounts.broken);
  add("contacts.total", s.contacts.total);
  add("contacts.cold", s.contacts.cold);
  return m;
}

/**
 * 填槽：所有槽都有值才返回文本，否则 null（这条建议今天不该出现在卡上）。
 * 顺手挡住词性用错：{crm.overdue} 后面接「天」、{crm.staleMaxDays} 后面接「位/人」判废
 * —— 实测模型就把「逾期 5 位」写成了「逾期 5 天」。
 */
export function fillTemplate(template: string, values: Map<string, string>): string | null {
  let out = "";
  let cursor = 0;
  for (const m of template.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)) {
    const path = m[1]!;
    const val = values.get(path);
    if (!val) return null;
    const after = template.slice((m.index ?? 0) + m[0].length);
    const unit = SLOT_BY_PATH.get(path)?.unit;
    if (unit === "count" && /^\s*天/.test(after)) return null;
    if (unit === "days" && /^\s*(位|人|封|条|组)/.test(after)) return null;
    out += template.slice(cursor, m.index) + val;
    cursor = (m.index ?? 0) + m[0].length;
  }
  out += template.slice(cursor);
  const t = out.replace(/\s+/g, " ").trim();
  return t.length >= 6 && t.length <= 40 ? t : null;
}

// ── 现状快照（全本地 SQL，毫秒级；单块失败只让建议变笼统，不炸首屏）──

export function readSnapshot(): Snapshot {
  const s: Snapshot = {
    quotes: { total: 0, expired: 0, topPod: null, lastSyncDays: null },
    inbox: { unread: 0, inquiries7d: 0, latest: null },
    crm: { dueToday: 0, overdue: 0, staleMaxDays: 0, topName: null },
    send: { pendingGroups: 0, pendingRecipients: 0, failed: 0, running: false, paused: false },
    accounts: { enabled: 0, healthy: 0, broken: null },
    contacts: { total: 0, cold: 0 },
  };
  const db = getDb();

  try {
    const r = ratesStatus();
    if (r.success) {
      s.quotes.total = r.data.total;
      s.quotes.expired = Math.max(0, r.data.total - r.data.active);
      s.quotes.lastSyncDays = r.data.lastSyncAt
        ? Math.max(0, Math.floor((Date.now() - Date.parse(r.data.lastSyncAt)) / DAY))
        : null;
    }
    // 条目最多的目的港 = 最常问的那条线，拿它当建议落点比"随便举条航线"有用
    const top = db.select({ pod: rateQuotes.podRaw, n: count() }).from(rateQuotes)
      .groupBy(rateQuotes.podRaw).orderBy(sql`count(*) desc`).limit(1).all()[0];
    s.quotes.topPod = top?.pod?.trim() || null;
  } catch (err) { Log.warn("suggest.quotes", `读运价快照失败：${msg(err)}`); }

  try {
    // 「未读」口径与收件箱一致：我方自己发出的副本不算待处理
    const unread = db.select({ n: count() }).from(inboxMessages)
      .where(and(eq(inboxMessages.isRead, 0), ne(inboxMessages.classification, "sent"))).get();
    s.inbox.unread = Number(unread?.n ?? 0);
    const week = db.select({ n: count() }).from(inboxMessages)
      .where(and(eq(inboxMessages.classification, "inquiry"),
        gte(inboxMessages.receivedAt, new Date(Date.now() - 7 * DAY).toISOString()))).get();
    s.inbox.inquiries7d = Number(week?.n ?? 0);
    const latest = db.select({
      fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail, subject: inboxMessages.subject,
    }).from(inboxMessages)
      .where(and(eq(inboxMessages.isRead, 0), ne(inboxMessages.classification, "sent")))
      .orderBy(desc(inboxMessages.receivedAt)).limit(1).all()[0];
    if (latest) s.inbox.latest = { who: latest.fromName?.trim() || latest.fromEmail, subject: latest.subject || "(无主题)" };
  } catch (err) { Log.warn("suggest.inbox", `读邮件快照失败：${msg(err)}`); }

  try {
    const r = checkReminders();
    if (r.success) {
      s.crm.dueToday = r.data.due.length;
      s.crm.overdue = r.data.overdue.length;
      const stale = r.data.overdue.map(c => c.staleDays ?? 0);
      s.crm.staleMaxDays = stale.length ? Math.max(...stale) : 0;
      const t0 = r.data.overdue[0];
      s.crm.topName = t0 ? [t0.firstName, t0.lastName].filter(Boolean).join(" ") || t0.email : null;
    }
  } catch (err) { Log.warn("suggest.crm", `读跟进快照失败：${msg(err)}`); }

  try {
    const st = getSendStatus();
    if (st.success) {
      s.send.running = st.data.isRunning;
      s.send.paused = st.data.isPaused;
      s.send.failed = st.data.failedCount;
    }
    const q = getQueueItems();
    if (q.success) {
      const pending = q.data.filter(i => i.status === "pending");
      s.send.pendingGroups = pending.length;
      s.send.pendingRecipients = pending.reduce((n, i) => n + i.recipients.length, 0);
    }
  } catch (err) { Log.warn("suggest.send", `读队列快照失败：${msg(err)}`); }

  try {
    const rows = db.select({
      email: emailAccounts.email, isActive: emailAccounts.isActive, circuitOpenAt: emailAccounts.circuitOpenAt,
      consecutiveFails: emailAccounts.consecutiveFails, fetchFailCount: emailAccounts.fetchFailCount,
    }).from(emailAccounts).all();
    s.accounts.enabled = rows.filter(r => r.isActive === 1).length;
    s.accounts.healthy = rows.filter(r =>
      r.isActive === 1 && !r.circuitOpenAt && r.consecutiveFails === 0 && (r.fetchFailCount ?? 0) === 0).length;
    const bad = rows.find(r => r.isActive !== 1 || r.circuitOpenAt || r.consecutiveFails > 0 || (r.fetchFailCount ?? 0) > 0);
    s.accounts.broken = bad ? bad.email : null;
  } catch (err) { Log.warn("suggest.accounts", `读账号快照失败：${msg(err)}`); }

  try {
    s.contacts.total = Number(db.select({ n: count() }).from(contacts).get()?.n ?? 0);
    s.contacts.cold = Number(db.select({ n: count() }).from(contacts).where(eq(contacts.stage, "cold")).get()?.n ?? 0);
  } catch (err) { Log.warn("suggest.contacts", `读联系人快照失败：${msg(err)}`); }

  return s;
}

// ── 规则版模板（首批与 AI 不可用时的兜底；同样靠填槽保鲜）──────────

export const RULE_TEMPLATES: Record<GroupTitle, string[]> = {
  查运价: [
    "{quotes.topPod} 现在最便宜到多少",
    "台账里 {quotes.expired} 条过期报价，按航线列一下",
    "{quotes.topPod} 有哪些船司在报价，柜型怎么分",
    "台账 {quotes.total} 条报价都覆盖了哪些航线",
    "运价台账 {quotes.lastSyncDays} 天没同步了，现在拉一次",
    "{quotes.topPod} 最便宜的报价现在还有效吗",
    "运价库里现在总共有多少条报价",
    "按柜型对比一下我们台账里最便宜的价",
  ],
  看市场行情: [
    "{quotes.topPod} 公开市场现在报多少",
    "我们台账上的价在市场上算什么水平",
    "{quotes.topPod} 最近有没有新船期",
    "过期的那 {quotes.expired} 条，市场上现在什么价",
    "把 {quotes.topPod} 的公开价和台账价做成一张对比",
    "上海到桑托斯现在公开市场报多少",
  ],
  管邮件: [
    "{inbox.unread} 封未读里最值得回的三封，总结一下",
    "回一下 {inbox.latestWho} 那封「{inbox.latestSubject}」",
    "近 7 天 {inbox.inquiries7d} 封询盘，按优先级排一下",
    "把未读邮件都总结一下，导出成文件",
    "{inbox.latestWho} 之前还发过什么邮件",
    "今天有什么新邮件",
  ],
  跟进客户: [
    "逾期最久的「{crm.topName}」沉默 {crm.staleMaxDays} 天了，先处理他",
    "列出 {crm.overdue} 位逾期和 {crm.dueToday} 位今天到期的清单",
    "我今天该跟进谁",
    "帮我查公司名带「物流」的联系人",
    "{contacts.total} 个联系人里，沉默最久的是哪几个",
    "把今天到期的跟进排个顺序",
  ],
  准备发信: [
    "队列还压着 {send.pendingGroups} 组，看看卡在哪",
    "{send.pendingRecipients} 个收件人还在待发，先估个发送时间",
    "发送队列现在什么状态",
    "{contacts.cold} 个冷启动客户里挑 5 个写开发信",
    "失败的 {send.failed} 组是什么原因，要不要重试",
    "给 ACME 的 Juan 写一封西语开发信",
  ],
  "账号与公司": [
    "{accounts.broken} 这个账号最近怎么了，怎么修",
    "{accounts.healthy}/{accounts.enabled} 个账号健康，异常那个先查",
    "我现在有几个发信账号能用",
    "给 ACME 这家公司做个背调",
    "启用的账号里有没有触发熔断的",
  ],
};

/** 规则版批次：只保留今天填得上槽的模板 */
export function ruleBatches(s: Snapshot, perGroup = 8): Array<{ title: GroupTitle; templates: string[] }> {
  const values = slotValues(s);
  return GROUP_TITLES.map(title => ({
    title,
    templates: RULE_TEMPLATES[title].filter(t => fillTemplate(t, values) !== null).slice(0, perGroup),
  }));
}

// ── 取用：读库 → 填槽 → 每区随机两条 ────────────────────────────

export const MAX_PER_GROUP = 8;     // 用户定的分区上限
export const PICK_PER_GROUP = 2;    // 每张卡显示两条

const lastPick = new Map<string, string[]>();     // 连开两次首页不该看到同一批
let generating: Promise<void> | null = null;     // 同一时刻只允许一个生成任务在飞

/** 首屏取建议：纯本地（读当天批次 + 填今天的数字），不碰模型；缺批次则后台补 */
export function suggestions(): Result<SuggestionGroup[]> {
  const snap = readSnapshot();
  const values = slotValues(snap);
  const day = beijingDay();
  let stored: Array<{ groupName: string; template: string; source: string }> = [];
  try {
    stored = getDb().select({
      groupName: agentSuggestions.groupName,
      template: agentSuggestions.template,
      source: agentSuggestions.source,
    }).from(agentSuggestions).where(eq(agentSuggestions.day, day)).all();
  } catch (err) { Log.warn("suggest.read", `读当天批次失败，改用规则版：${msg(err)}`); }

  const byGroup = new Map<string, string[]>();
  for (const row of stored) byGroup.set(row.groupName, [...(byGroup.get(row.groupName) ?? []), row.template]);
  const rule = ruleBatches(snap);
  // 某区今天没条目（还没生成 / 生成的都填不上）→ 就地补规则版，卡上不会空
  for (const g of rule) if (!(byGroup.get(g.title)?.length)) byGroup.set(g.title, g.templates);

  const groups = GROUP_TITLES.map(title => {
    const filled = [...new Set((byGroup.get(title) ?? [])
      .map(t => fillTemplate(t, values))
      .filter((x): x is string => !!x))];
    // 卡上显示短句，点击时发送方法论前缀拼成的完整提示词（填槽后的今天数字一并进目标）
    const items = pickTwo(title, filled).map(text => ({ text, prompt: buildItemPrompt(title, text) }));
    return { title, cap: capLine(title, snap), items };
  });
  if (groups.some(g => g.items.length < PICK_PER_GROUP) || !stored.some(r => r.source === "ai")) {
    void ensureBatch();
  } else {
    // 当天批次已在：只有「该关心什么」真的变了才再打模型，且受冷却与每日次数封顶
    const why = shouldRegenerate(readState(), fingerprint(snap));
    if (why) { Log.info("suggest.batch", `数据面貌变了（${why}）→ 重排当天批次`); void regenerateBatch(); }
  }
  return okResult(groups);
}

/** 随机抽两条（导出供单测钉死「不重复、不足两条就有几条给几条」）；连开两次首页不给同一批 */
export function pickTwo(title: string, pool: string[]): string[] {
  if (pool.length <= PICK_PER_GROUP) return pool;
  const prev = lastPick.get(title) ?? [];
  const fresh = pool.filter(t => !prev.includes(t));
  const bag = (fresh.length >= PICK_PER_GROUP ? fresh : pool).slice();
  const out: string[] = [];
  while (out.length < PICK_PER_GROUP && bag.length) {
    out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]!);
  }
  lastPick.set(title, out);
  return out;
}

/** 卡上的数据行始终本地算，不让模型写数字 */
function capLine(title: GroupTitle, s: Snapshot): string {
  switch (title) {
    case "查运价": return s.quotes.total
      ? `台账镜像 ${s.quotes.total} 条${s.quotes.expired ? `，${s.quotes.expired} 条已过期` : ""}`
      : CAP_FALLBACK["查运价"];
    case "管邮件": return `未读 ${s.inbox.unread} 封 · 近 7 天询盘 ${s.inbox.inquiries7d} 封`;
    case "跟进客户": return `${s.crm.overdue} 位逾期 · ${s.crm.dueToday} 位今天到期`;
    case "准备发信": return s.send.pendingGroups
      ? `队列待发 ${s.send.pendingGroups} 组 / ${s.send.pendingRecipients} 人`
      : CAP_FALLBACK["准备发信"];
    case "账号与公司": return `${s.accounts.healthy}/${s.accounts.enabled} 个发信账号健康`;
    default: return CAP_FALLBACK["看市场行情"];
  }
}

// ── 变化触发：只比本地已经读到的快照，零额外查询；带冷却与每日上限 ──

/** 生成当时的数据指纹。判的是「该关心什么变了」，不是「数字变了」（数字靠填槽，本来就新鲜） */
export interface Fingerprint {
  quotesTotal: number; quotesExpired: number; lastSyncDays: number | null;
  unread: number; inquiries7d: number;
  overdue: number; dueToday: number; staleMaxDays: number;
  pendingGroups: number; failedGroups: number;
  enabledAccounts: number; healthyAccounts: number; broken: string | null;
}

export function fingerprint(s: Snapshot): Fingerprint {
  return {
    quotesTotal: s.quotes.total, quotesExpired: s.quotes.expired, lastSyncDays: s.quotes.lastSyncDays,
    unread: s.inbox.unread, inquiries7d: s.inbox.inquiries7d,
    overdue: s.crm.overdue, dueToday: s.crm.dueToday, staleMaxDays: s.crm.staleMaxDays,
    pendingGroups: s.send.pendingGroups, failedGroups: s.send.failed,
    enabledAccounts: s.accounts.enabled, healthyAccounts: s.accounts.healthy, broken: s.accounts.broken,
  };
}

/** 命中返回一句原因（进日志，便于事后看是哪类变化推动了重排）；没变返回 null */
export function signalsMoved(prev: Fingerprint, now: Fingerprint): string | null {
  if (now.quotesExpired !== prev.quotesExpired || now.quotesTotal !== prev.quotesTotal) return "运价台账刷新";
  if ((prev.lastSyncDays ?? -1) > 0 && now.lastSyncDays === 0) return "运价台账今日已同步";
  if (now.unread >= prev.unread + 3) return `新到 ${now.unread - prev.unread} 封未读`;
  if (now.pendingGroups >= prev.pendingGroups + 5) return `队列又压 ${now.pendingGroups - prev.pendingGroups} 组`;
  if (now.failedGroups > prev.failedGroups) return "出现新的发送失败";
  if (prev.overdue === 0 && now.overdue > 0) return "跟进开始逾期";
  if (now.overdue >= prev.overdue + 3) return "逾期面扩大";
  if (now.broken && now.broken !== prev.broken) return "账号出现故障";
  if (now.healthyAccounts < prev.healthyAccounts) return "健康账号变少";
  return null;
}

const MIN_GAP_MS = 30 * 60_000;      // 两次生成至少隔 30 分钟：防数据反复抖动连着打模型
const MAX_TRIES_PER_DAY = 6;         // 一天封顶 6 次（失败的尝试也计，端点故障时不反复烧）

export interface GenState { day: string; tries: number; lastAt: number; fp: Fingerprint }
const statePath = () => path.join(APP_ROOT, "data", "suggestion-state.json");

function readState(): GenState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf-8")) as Partial<GenState> | null;
    return raw && typeof raw.day === "string" && raw.fp ? (raw as GenState) : null;
  } catch { return null; }      // 没有状态文件 = 今天还没生成过
}

function writeState(s: GenState): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(s), "utf-8");
  } catch (err) { Log.debug("suggest.state", `状态写不下（不影响功能，最多多试一次）：${msg(err)}`); }
}

/** 要不要为「变化」再打一次模型？纯判定，好单测：冷却未到 / 当天次数已满 / 指纹没动 → null */
export function shouldRegenerate(st: GenState | null, now: Fingerprint, at = Date.now()): string | null {
  if (!st || st.day !== beijingDay(at)) return null;    // 当天还没批次，那是常规补批次的路径，不算重排
  if (at - st.lastAt < MIN_GAP_MS) return null;
  if (st.tries >= MAX_TRIES_PER_DAY) return null;
  return signalsMoved(st.fp, now);
}

// ── 生成：每天一批（后台跑，启动后与跨天时各来一次）─────────────────

/** 每区能引用的字段与该区真做得到的动作（防串数据、防给做不到的事出题） */
const GROUP_BRIEF: Record<GroupTitle, string> = {
  查运价: "只能用 quotes.*；动作限于查本地运价台账（航线/目的港/船司/柜型/有效期）",
  看市场行情: "只能用 quotes.*；动作限于联网调研公开市场运价与船期、拿台账价对比市场水平",
  管邮件: "只能用 inbox.*；动作限于检索收件箱、逐封总结给建议、导出邮件汇总",
  跟进客户: "只能用 crm.* 与 contacts.*；动作限于今日待跟进清单、查联系人、给某位记跟进",
  准备发信: "只能用 send.* 与 contacts.*；动作限于写开发信草稿、看发送队列状态、把草稿入队",
  "账号与公司": "只能用 accounts.*；动作限于查账号健康与故障原因、给公司做网络背调",
};

/** 生成器提示词（导出是为了单测与验收脚本复用同一份，不各写一份漂移的） */
export function buildBatchPrompt(s: Snapshot): string {
  const slotLines = SLOTS.map(d =>
    `{${d.path}} = ${d.desc}${d.unit === "count" ? "（数量，后面别接「天」）" : d.unit === "days" ? "（天数，后面别接「位/人/封/条/组」）" : ""}`);
  return [
    "我程序当前的数据状况（JSON）：",
    JSON.stringify(s),
    "",
    "可用槽位（写模板时**只能用这些占位符**，展示时才被换成当天的真实数字，所以建议不会过时）：",
    slotLines.join("\n"),
    "",
    `给六个分区各写 6–8 条「建议行动」模板，只输出 JSON 数组：`,
    `[{"title":"查运价","items":["{quotes.topPod} 现在最便宜到多少", …]}, …]`,
    `六个 title 必须依次是：${GROUP_TITLES.join("、")}。`,
    "硬要求：",
    "1) 模板是用户点一下就能直接发给助手的话，8–26 字，中文口语短句，不加序号不加引号；",
    "2) 每条至少含一个槽位；除了柜型这类固定写法（20GP / 40HQ / 45HC），句子里不许出现任何裸数字 —— 数量一律走 {槽位}（要表达「还能用的报价」这类派生概念就别带数字）；",
    "3) 每组只能用与该组相关的槽位，且只能是该组真做得到的动作：" + GROUP_TITLES.map(t => `${t}→${GROUP_BRIEF[t]}`).join("；"),
    "4) 槽名照抄（不许把 {crm.overdue} 写成 {overdue}）；人名地名一律用槽位，不要自己写死、不要翻译；",
    "5) 同组内角度要不同（六条别都在问同一件事）；整体优先「此刻最该办」：逾期与今天到期 > 未读询盘 > 队列待发与账号故障 > 运价与行情。",
  ].join("\n");
}

/** 剥掉柜型固定写法后才判断「有没有写死数字」：20GP / 40HQ / 45HC 这类不是统计值，是行业词 */
const CONTAINER_TOKEN = /\b\d{2}(GP|HQ|HC|OT|FR|RF)\b/gi;
const hasHardNumber = (t: string) => /\d/.test(t.replace(CONTAINER_TOKEN, ""));

/**
 * 模板按「填完之后」的长度判，不能按模板原文量 —— 一个 {quotes.topPod} 就占 15 个字符，
 * 量原文会把模型正常产出整批误杀（实测踩过）。今天没值的槽按 4 字估。
 */
const renderedLen = (t: string, values: Map<string, string> | undefined) =>
  t.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, p: string) => "一".repeat(Math.max(1, values?.get(p)?.length ?? 4))).length;

/**
 * 准入校验。任何一条不合格的句子先丢掉；某区凑不满 5 条 → 整版判 null（宁可全用规则版）。
 * 实测模型会自己拿 132-12 算出「能用 120 条」、把「逾期 5 位」写成「逾期 5 天」、
 * 把 Santos 翻成「桑托斯」—— 这三类在这里都被挡住。
 */
export function parseBatch(
  raw: string, values?: Map<string, string>, why?: { msg?: string },
): Array<{ title: GroupTitle; templates: string[] }> | null {
  let arr: unknown;
  try {
    const fence = /\[[\s\S]*\]/.exec(raw);   // 模型爱在 JSON 外面包解释或 ```json 围栏
    arr = JSON.parse(fence ? fence[0] : raw);
  } catch { if (why) why.msg = "JSON 解析不了（外层不是数组或含未转义内容）"; return null; }
  if (!Array.isArray(arr)) { if (why) why.msg = "输出不是数组"; return null; }
  if (arr.length !== GROUP_TITLES.length) { if (why) why.msg = `分组数 ${arr.length} ≠ ${GROUP_TITLES.length}`; return null; }
  const out: Array<{ title: GroupTitle; templates: string[] }> = [];
  const dropped = { len: 0, hardNum: 0, slot: 0 };   // 逐条丢弃计数：全版被拒时据此定位是哪道门太紧
  for (const [i, item] of arr.entries()) {
    const title = GROUP_TITLES[i]!;
    const o = item as { title?: unknown; items?: unknown };
    if (typeof o?.title !== "string" || o.title.trim() !== title) { if (why) why.msg = `第 ${i + 1} 区标题不匹配（应为「${title}」）`; return null; }
    if (!Array.isArray(o.items)) { if (why) why.msg = `第 ${i + 1} 区 items 不是数组`; return null; }
    const ok: string[] = [];
    for (const x of o.items) {
      if (typeof x !== "string") continue;
      const t = x.trim();
      const len = renderedLen(t, values);
      if (len < 8 || len > 32) { dropped.len++; continue; }                          // 卡上一行放得下：提示词要 8–26，收到 32 是容忍模型略超
      if (hasHardNumber(t)) { dropped.hardNum++; continue; }                          // 数量必须走槽位，不许写死
      const names = [...t.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)].map(m => m[1]!);
      if (!names.length || names.some(n => !SLOT_BY_PATH.has(n))) { dropped.slot++; continue; }  // 槽名必须照抄白名单
      if (!ok.includes(t)) ok.push(t);
    }
    if (ok.length < 5) {
      if (why) why.msg = `「${title}」仅 ${ok.length} 条过准入（需 ≥5）；丢弃统计: 长度${dropped.len}/写死数字${dropped.hardNum}/槽名${dropped.slot}`;
      return null;
    }
    out.push({ title, templates: ok.slice(0, MAX_PER_GROUP) });
  }
  return out;
}

/** 当天还没有 ai 批次时补一批（启动后 30s、以及每次读库时轻查）；已生成过就直接返回 */
export function ensureBatch(): Promise<void> { return generate(false); }

/** 数据面貌真的变了 → 重排当天批次（冷却与每日上限由 shouldRegenerate 判） */
export function regenerateBatch(): Promise<void> { return generate(true); }

/** 跑一次生成并落状态；force=true 时忽略「今天已有批次」的短路 */
async function generate(force: boolean): Promise<void> {
  if (generating) return generating;
  const day = beijingDay();
  if (!force && storedAiCount(day) > 0) return;        // 今天已生成过，常规路径不必再动
  const before = readState();
  const tries = (before && before.day === day ? before.tries : 0) + 1;   // 失败也算一次，端点故障时不反复烧
  let snap: Snapshot | null = null;
  /** 记下「本次生成时间 + 当天第几次 + 生成时的数据指纹」，变化触发就拿它当基准 */
  const remember = (): void => {
    try { writeState({ day, tries, lastAt: Date.now(), fp: fingerprint(snap ?? readSnapshot()) }); }
    catch { /* 状态写不下就认了：最坏是多试一次生成，不影响卡片有内容 */ }
  };
  generating = (async () => {
    try {
      snap = readSnapshot();
      const r = await llmChat(
        "你是外贸邮件助手「建议行动」的生成器。只输出 JSON，不要任何解释文字。",
        buildBatchPrompt(snap),
      );
      if (!r.success) { Log.debug("suggest.batch", `生成失败，先用规则版：${r.error}`); return; }
      const why: { msg?: string } = {};
      const parsed = parseBatch(r.data, slotValues(snap), why);
      if (!parsed) { Log.debug("suggest.batch", `产出不合规，先用规则版（${why.msg ?? "未知原因"}）`); return; }
      const rows = parsed.flatMap(g => g.templates.map(t => ({
        day, groupName: g.title, template: t, source: "ai",
      })));
      const db = getDb();
      db.delete(agentSuggestions).where(eq(agentSuggestions.day, day)).run();
      db.insert(agentSuggestions).values(rows).run();
      db.delete(agentSuggestions).where(
        sql`${agentSuggestions.day} < ${beijingDay(Date.now() - 7 * DAY)}`,
      ).run();                                        // 只留最近 7 天，别让表长
      saveDatabase();
      Log.info("suggest.batch", `当天建议批次已生成：${rows.length} 条模板`);
    } catch (err) {
      Log.debug("suggest.batch", `异常，先用规则版：${msg(err)}`);
    } finally {
      remember();                                     // 成败都记账：冷却计时与当天次数都靠它
      generating = null;
    }
  })();
  return generating;
}

function storedAiCount(day: string): number {
  try {
    const row = getDb().select({ n: count() }).from(agentSuggestions)
      .where(and(eq(agentSuggestions.day, day), eq(agentSuggestions.source, "ai"))).get();
    return Number(row?.n ?? 0);
  } catch { return 0; }
}
