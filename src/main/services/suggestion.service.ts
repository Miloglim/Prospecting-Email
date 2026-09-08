import * as fs from "fs";
import * as path from "path";
import { and, count, desc, eq, gt, gte, inArray, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { APP_ROOT } from "../config";
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { inboxMessages } from "../db/schema/inbox";
import { interactions } from "../db/schema/interactions";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";
import { checkReminders, type ReminderContact } from "./crm.service";
import { getSendStatus, getQueueItems } from "./send.service";
import { ratesDiff, type RatesDiff } from "./rate-sync.service";
import { internalDomains } from "./inbox.service";

// ── 新对话「行动建议」信息流（docs/suggestion-feed-spec.md）──────────
// 形态：开场气泡里 3–4 个可点 chip。候选全部本地生成（SQL+拼装，零模型调用），
// 数据事件经 suggestion-bus 触发重算推送，空态 ≤1s 就地热更新。
// 旧的「LLM 每天一批模板 + 填槽 + 指纹重排」整套已退役：模板装不下
// 「MSC 美西线 40HQ 降到 $2800」这类结构化事实，而本地拼装更快更准。

export type Tone = "urgent" | "mail" | "intel" | "neutral";
export type Bucket = "followup" | "mail" | "intel" | "static" | "action";

/** 一键采纳的行动载荷（规范 docs/mail-action-suggestion-spec.md §3-4）：
 *  点击 chip 直接走 contacts:upsert，不经模型、不再叠一层确认框 */
export interface ReplyAction {
  kind: "addContact" | "markReached";
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  contactId?: number | null;
}

export interface FeedItem {
  key: string;          // 去重 / dismissed 记忆用（跨重算稳定）
  text: string;         // chip 文案（本地拼装，数字与名字都来自库）
  prompt: string;       // 点击发送的完整提示词（方法论前缀 + 检索目标）
  tone: Tone;           // 驱动 chip 状态色条
  bucket: Bucket;
  href?: string;        // 可选：跳转查看（联系人/队列页）
  contactId?: number;   // ctx 锚点命中时置顶用
  action?: ReplyAction; // 有它 = 一键执行型建议（点击先执行 IPC，成功后再 dismiss）
}

export interface SuggestionFeed {
  greeting: string;
  items: FeedItem[];
}

/** 方法论前缀（沿用旧机制的分区文案；chip 点击时拼在检索目标前面） */
export const GROUP_PROMPT = {
  查运价: "在本地运价台账镜像中检索，按目的港、船司、柜型汇总报价并注明有效期；只报台账里真实存在的条目，查不到就明说，不要用市场价或记忆补数。",
  同步运价: "用定向运价更新方案能力（rate_update_plan）：按客户港口偏好分组（没登记偏好的按其所在国家当期代表港兜底，"
    + "范围可选跟进看板或联系人库+国家），取台账当期真价出方案，把「谁收到哪个港的哪张价表」讲清楚给我确认；"
    + "价格一律以本地镜像为准，工具返回的 facts/preview 里没有的细节（船期延迟、中转、附加费）不许说；"
    + "查不到有效价的港口不许编；确认后才入队，入队不等于发送，开始发送必须我自己在发送中心点。",
  管邮件: "检索本地收件箱，逐封给出发件人、主题、一句话摘要和下一步建议；需要回复或导出时先给草稿或清单等我确认，不要编造邮件里没有的内容。",
  跟进客户: "在联系人库与跟进记录里检索，给出匹配对象、最近跟进时间与状态；要写入跟进记录时先把内容给我确认。查不到就明说，不要猜测或张冠李戴。",
  准备发信: "撰写开发信草稿或查看发送队列状态；草稿先给我过目，只能入队不能自动发送，开始发送必须我自己在发送中心确认。写内容前先查库里的联系人与公司信息。",
  账号与公司: "检查发信账号的健康状态，或对指定公司做公开网络背调；账号问题给出原因与修复建议，背调只依据可查到的公开信息并标注可信度，查不到的部分明确说查不到。",
} as const;
type Prefix = keyof typeof GROUP_PROMPT;

const withPrefix = (p: Prefix, text: string) => `${GROUP_PROMPT[p]}\n检索目标：${text}`;

/** 北京时间今日 YYYY-MM-DD（dismissed 记忆按日切） */
export const beijingDay = (at = Date.now()) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);

// ── 候选 ──────────────────────────────────────────────────

export interface Candidate {
  bucket: Bucket; key: string; text: string; tone: Tone; score: number;
  prefix?: Prefix; href?: string; contactId?: number; freshAt?: number;
  action?: ReplyAction;
}

export interface FeedInputs {
  now: number;
  reminders: { due: ReminderContact[]; overdue: ReminderContact[] } | null;
  send: { failed: number; pendingGroups: number; pendingRecipients: number; paused: boolean } | null;
  mail: {
    unread: number;
    latest: { who: string; subject: string; receivedAt: string } | null;
    unreplied: { id: number; from: string; subject: string; receivedAt: string; contactId: number | null } | null;
    bounce3d: number;
  };
  /** 客户回复带来的一键行动（新客建档 / 老客放回跟进列表），来源见 gatherReplyActions */
  replyActions: ReplyAction[];
  diff: RatesDiff | null;
  /** pod 主段 → 最近 30 天有往来的联系人（intel 桶「可以给 XX 同步」用） */
  related: Map<string, { id: number; name: string }>;
  dismissed: Set<string>;
  ctxContactId?: number;
}

const contactName = (c: { firstName: string | null; lastName: string | null; email: string }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;

/** pod 原文取英文主段（"SANTOS 桑托斯(巴西)"→SANTOS；"BALBOA, PA …"→BALBOA）；用于往来匹配 */
export function podToken(podRaw: string): string | null {
  const m = /[A-Za-z][A-Za-z0-9-]{2,}/.exec(podRaw);
  return m ? m[0].toUpperCase() : null;
}

/** 三桶候选生成（纯函数，导出供单测；explore 兜底桶已砍——凑不满就有几条给几条） */
export function collectCandidates(inp: FeedInputs): Candidate[] {
  const out: Candidate[] = [];
  const { now } = inp;

  // A. 跟进发信
  const rem = inp.reminders;
  if (rem) {
    const top = rem.overdue[0];
    if (top) {
      const days = top.staleDays ?? 0;
      out.push({
        bucket: "followup", key: `fu-stale-${top.id}`, tone: days >= 14 ? "urgent" : "neutral",
        text: `「${contactName(top)}」沉默 ${days} 天了，先处理他`,
        score: 28 + Math.min(days, 12), prefix: "跟进客户", contactId: top.id,
        href: `#/customers?view=table&detail=${top.id}`,
      });
    }
    if (rem.due.length) {
      out.push({
        bucket: "followup", key: "fu-due", tone: "neutral",
        text: `今天有 ${rem.due.length} 位该跟进，帮我排个顺序`,
        score: 25, prefix: "跟进客户",
      });
    }
  }
  const send = inp.send;
  if (send) {
    if (send.failed > 0) {
      out.push({
        bucket: "followup", key: "fu-failed", tone: "urgent",
        text: `发送失败的 ${send.failed} 组是什么原因，要不要重试`,
        score: 38, prefix: "准备发信", href: "#/queue",
      });
    } else if (send.pendingGroups > 0) {
      out.push({
        bucket: "followup", key: "fu-pending", tone: "neutral",
        text: send.paused
          ? `队列暂停中，还压着 ${send.pendingGroups} 组待发`
          : `队列还压着 ${send.pendingGroups} 组待发，看看卡在哪`,
        score: 15, prefix: "准备发信", href: "#/queue",
      });
    }
  }

  // A2. 一键行动（客户回复 → 建档 / 放回跟进列表）
  // 新客刚回信是黄金窗口，分数压在行情/运价类之上；同桶 ≤2 由 selectItems 统一管
  for (const a of inp.replyActions) {
    const who = [a.firstName, a.lastName].filter(Boolean).join(" ") || a.email;
    if (a.kind === "addContact") {
      out.push({
        bucket: "action", key: `act:new:${a.email.toLowerCase()}`, tone: "urgent",
        text: `把 ${who}（${a.email}）加入联系人并标为已触达`,
        score: 100, action: a, href: "#/customers?view=table",
      });
    } else {
      out.push({
        bucket: "action", key: `act:reached:${a.contactId ?? a.email.toLowerCase()}`, tone: "mail",
        text: `把 ${who} 放回跟进列表（标为已触达）`,
        score: 80, contactId: a.contactId ?? undefined, action: a,
        href: a.contactId ? `#/customers?view=table&detail=${a.contactId}` : "#/customers?view=table",
      });
    }
  }

  // B. 邮件
  const u = inp.mail.unreplied;
  if (u) {
    const ageH = (now - Date.parse(u.receivedAt)) / 3600_000;
    out.push({
      bucket: "mail", key: `mail-unreplied-${u.id}`, tone: "mail",
      text: `${u.from} 的「${u.subject}」还没回，起草回复`,
      score: 30 + (ageH <= 2 ? 8 : ageH <= 24 ? 4 : 0), prefix: "管邮件",
      contactId: u.contactId ?? undefined, freshAt: Date.parse(u.receivedAt),
      ...(u.contactId ? { href: `#/customers?view=table&detail=${u.contactId}` } : {}),
    });
  }
  if (inp.mail.bounce3d > 0) {
    out.push({
      bucket: "mail", key: "mail-bounce", tone: "urgent",
      text: `近 3 天 ${inp.mail.bounce3d} 封退信要处理`,
      score: 35, prefix: "管邮件", href: "#/inbox",
    });
  }
  if (inp.mail.unread > 0 && inp.mail.latest) {
    const ageH = (now - Date.parse(inp.mail.latest.receivedAt)) / 3600_000;
    if (ageH <= 2) {
      out.push({
        bucket: "mail", key: "mail-unread", tone: "mail",
        text: `${inp.mail.unread} 封未读，最新是 ${inp.mail.latest.who} 的「${inp.mail.latest.subject}」`,
        score: 20, prefix: "管邮件", href: "#/inbox",
      });
    }
  }

  // C. 可同步资讯（原料 = 镜像 diff，规范 §6）
  const d = inp.diff;
  if (d) {
    const drop = d.priceDrops[0];
    if (drop) {
      const token = podToken(drop.podRaw);
      const rel = token ? inp.related.get(token) : undefined;
      const pod = token ?? drop.podRaw;
      out.push({
        bucket: "intel",
        key: `intel-drop-${drop.podRaw}-${drop.carrier ?? ""}-${drop.container ?? ""}`,
        tone: "intel",
        text: `${pod} ${drop.carrier ?? ""} ${drop.container ?? ""} 降到 $${drop.newUsd}（原 $${drop.oldUsd}），${rel ? `可以给 ${rel.name} 同步` : "可以同步给客户"}`.replace(/\s+/g, " "),
        score: 30 + Math.min(10, Math.round(((drop.oldUsd - drop.newUsd) / drop.oldUsd) * 40)) + (rel ? 4 : 0),
        prefix: "同步运价", contactId: rel?.id,
        // 深链到跟进看板的运价更新面板（同一个方案引擎，不打字也能一键看到方案）
        href: "#/customers?view=board&ratepush=1",
      });
    }
    const add = d.addedPods[0];
    if (add) {
      const token = podToken(add.podRaw);
      out.push({
        bucket: "intel", key: `intel-added-${add.podRaw}`, tone: "intel",
        text: `台账新上 ${token ?? add.podRaw} 航线 ${add.n} 条报价`,
        score: 20, prefix: "查运价",
      });
    }
    const exp = d.expiringSoon[0];
    if (exp) {
      const token = podToken(exp.podRaw);
      out.push({
        bucket: "intel", key: `intel-expiring-${exp.podRaw}`, tone: "intel",
        text: `${token ?? exp.podRaw} 的 ${exp.n} 条报价 ${exp.minDays} 天后过期，要不要先锁价`,
        score: 22 - Math.min(exp.minDays, 7), prefix: "查运价",
      });
    }
    const sp = d.spacesClosing[0];
    if (sp) {
      const token = sp.podRaw ? podToken(sp.podRaw) : null;
      out.push({
        bucket: "intel", key: `intel-space-${sp.podRaw ?? ""}-${sp.vessel ?? ""}`, tone: "intel",
        text: `${token ?? sp.podRaw ?? "航线"} ${sp.vessel ?? ""} ${sp.etd ?? ""} 开船${sp.boxQty ? `，还剩 ${sp.boxQty}` : ""}，舱位要锁吗`.replace(/\s+/g, " "),
        score: 24 - sp.days * 2, prefix: "查运价",
      });
    }
  }
  return out;
}

/**
 * 兜底预备库（用户定的「看来还是需要兜底预备库」）：真实候选不足 MIN_ITEMS 时补齐，
 * 保证气泡区永远有东西可点。全部是常青能力入口（不依赖任何数据），带各自方法论前缀；
 * 数据丰富的正常路径永远轮不到它们上场。
 */
export const PREPARED_POOL: FeedItem[] = [
  { key: "pool-mail-unread", text: "总结一下我的未读邮件", prompt: withPrefix("管邮件", "总结未读邮件，逐封给一句话摘要和下一步建议"), tone: "neutral", bucket: "static" },
  { key: "pool-followup-today", text: "我今天该跟进谁", prompt: withPrefix("跟进客户", "我今天该跟进谁，按紧迫度排个顺序"), tone: "neutral", bucket: "static" },
  { key: "pool-rates-coverage", text: "查一下运价台账覆盖了哪些航线", prompt: withPrefix("查运价", "运价台账现在覆盖了哪些航线，按目的港汇总"), tone: "neutral", bucket: "static" },
  { key: "pool-mail-week", text: "近 7 天的询盘按优先级排一下", prompt: withPrefix("管邮件", "近 7 天的询盘邮件按优先级排一下"), tone: "neutral", bucket: "static" },
  { key: "pool-followup-stale", text: "沉默最久的客户是哪几个", prompt: withPrefix("跟进客户", "沉默最久的联系人是哪几个，列出最近跟进时间"), tone: "neutral", bucket: "static" },
  { key: "pool-draft-cold", text: "挑几个冷启动客户写开发信草稿", prompt: withPrefix("准备发信", "从冷启动阶段的联系人里挑几个写开发信草稿"), tone: "neutral", bucket: "static" },
  { key: "pool-rates-cheapest", text: "台账里最便宜的几条报价是哪些", prompt: withPrefix("查运价", "台账里最便宜的几条报价是哪些，按价格升序"), tone: "neutral", bucket: "static" },
  { key: "pool-accounts", text: "我现在有几个发信账号能用", prompt: withPrefix("账号与公司", "我现在有几个发信账号能用，健康状态如何"), tone: "neutral", bucket: "static" },
  { key: "pool-queue", text: "发送队列现在什么状态", prompt: withPrefix("准备发信", "发送队列现在什么状态"), tone: "neutral", bucket: "static" },
];

/** 少于这个数就从预备库补齐（用户要「减压但不空」：3–4 条，真实候选优先） */
const MIN_ITEMS = 3;

/** 补齐：真实候选不足 MIN_ITEMS 时从预备库补；轮换起点错开，避免每次都补同几条 */
function padWithPool(picked: FeedItem[], rotate: number): FeedItem[] {
  if (picked.length >= MIN_ITEMS) return picked;
  const usedKeys = new Set(picked.map(p => p.key));
  const pool = PREPARED_POOL.filter(p => !usedKeys.has(p.key));
  const off = (picked.length + rotate) % Math.max(1, pool.length);
  const ordered = [...pool.slice(off), ...pool.slice(0, off)];
  return [...picked, ...ordered].slice(0, MIN_ITEMS);
}

/** 选取：过滤 dismissed → ctx 置顶 → 分数排序 → 同桶 ≤2 → 最多 4 条；不足 3 条从预备库补齐。
 *  rotate = 「换一批」页码：跳过前 rotate 批已选，从候选池取下一组（不重新查询） */
export function selectItems(cands: Candidate[], inp: FeedInputs, rotate = 0): FeedItem[] {
  const base = cands
    .filter(c => !inp.dismissed.has(c.key))
    .map(c => (inp.ctxContactId && c.contactId === inp.ctxContactId ? { ...c, score: c.score + 50 } : c))
    .sort((a, b) => b.score - a.score || (b.freshAt ?? 0) - (a.freshAt ?? 0));
  const pickOnce = (pool: Candidate[]): FeedItem[] => {
    const perBucket = new Map<Bucket, number>();
    const picked: FeedItem[] = [];
    for (const c of pool) {
      if (picked.length >= 4) break;
      const n = perBucket.get(c.bucket) ?? 0;
      if (n >= 2) continue;
      perBucket.set(c.bucket, n + 1);
      picked.push({
        key: c.key, text: c.text, tone: c.tone, bucket: c.bucket,
        prompt: c.prefix ? withPrefix(c.prefix, c.text) : c.text,
        ...(c.href ? { href: c.href } : {}),
        ...(c.contactId ? { contactId: c.contactId } : {}),
        ...(c.action ? { action: c.action } : {}),
      });
    }
    return picked;
  };
  let pool = base;
  let picked = pickOnce(pool);
  for (let i = 0; i < rotate && picked.length; i++) {
    const used = new Set(picked.map(p => p.key));
    const rest = pool.filter(c => !used.has(c.key));
    const next = pickOnce(rest);
    if (!next.length) break;   // 池子轮空 → 停在上一批，再由预备库补齐
    pool = rest;
    picked = next;
  }
  return padWithPool(picked, rotate);
}

/** 问候行：只报有值的项，全空就说干净（数字全部本地算，不经模型） */
export function buildGreeting(inp: FeedInputs): string {
  const h = new Date(inp.now + 8 * 3600_000).getUTCHours();
  const hello = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const facts: string[] = [];
  const overdue = inp.reminders?.overdue.length ?? 0;
  if (overdue > 0) facts.push(`${overdue} 位客户逾期没跟进`);
  if (inp.mail.unread > 0) facts.push(`${inp.mail.unread} 封未读`);
  if (inp.diff && inp.now - Date.parse(inp.diff.syncedAt) <= 6 * 3600_000) facts.push("运价镜像刚更新");
  return facts.length ? `${hello}。今天${facts.join("、")}。` : `${hello}。今天收件箱很干净，没有急着要办的事。`;
}

/** 纯函数总装（导出供单测） */
export function buildFeed(inp: FeedInputs): SuggestionFeed {
  return { greeting: buildGreeting(inp), items: selectItems(collectCandidates(inp), inp) };
}

// ── dismissed 记忆（当天有效，落盘防重启丢失）──────────────────

const DISMISS_PATH = () => path.join(APP_ROOT, "data", "suggestion-dismissed.json");
let dismissState: { day: string; keys: string[] } | null = null;

function dismissedSet(): Set<string> {
  const day = beijingDay();
  if (!dismissState || dismissState.day !== day) {
    try {
      const raw = JSON.parse(fs.readFileSync(DISMISS_PATH(), "utf-8")) as { day?: string; keys?: string[] };
      dismissState = raw?.day === day && Array.isArray(raw.keys) ? { day, keys: raw.keys } : { day, keys: [] };
    } catch { dismissState = { day, keys: [] }; }
  }
  return new Set(dismissState.keys);
}

/** chip 被点击 → 当天不再出（同一条 diff/同一封邮件不反复推荐） */
export function dismiss(key: string): void {
  const set = dismissedSet();
  if (set.has(key)) return;
  set.add(key);
  dismissState = { day: beijingDay(), keys: [...set] };
  try {
    fs.mkdirSync(path.dirname(DISMISS_PATH()), { recursive: true });
    fs.writeFileSync(DISMISS_PATH(), JSON.stringify(dismissState), "utf-8");
  } catch (err) {
    Log.debug("suggest.dismiss", `记忆落盘失败（不影响本次会话）：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 取数（全本地 SQL，毫秒级；单块失败只让建议变少，不炸空态）──────

const DAY = 86400_000;

// ── 客户回复 → 一键行动（规范 docs/mail-action-suggestion-spec.md）────────
// 解析工作其实早在邮件落库时就做完了（classification + 联系人匹配，见 inbox.ipc 的入库路径），
// 这里不二次调模型，只查这张已解析完的表：classification='replied' AND my_role='to'。

/** from_name 常带签名尾巴：「Isabella Mendes | Three Logistics」「Mandy深圳运去哪(奥南)」 */
export function cleanPersonName(raw: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const s = (raw || "").replace(/[|(（].*$/, "").replace(/\s{2,}/g, " ").trim();
  if (!s) return { firstName: null, lastName: null };
  const parts = s.split(/\s+/);
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

/** 公共/机器人信箱的「回复」不是客户意向（noreply、postmaster、mailer-daemon、info@…）。
 *  只认「本地名整个就是这个词（可跟数字/分隔后缀）」——`marketing.manager@…` 是真人，不能误杀。 */
const BOT_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|bounce|bounces|abuse|admin|support|info|sales|marketing|news|notify|notification|automated|auto-reply|webmaster)([-_.]?\d*)?$/i;
export function isBotMailbox(email: string): boolean {
  const local = (email.split("@")[0] || "").trim();
  return !local || BOT_LOCAL.test(local);
}

export interface ReplyActionSourceRow { fromEmail: string; fromName: string | null }
export interface ReplyActionContact {
  id: number; email: string; status: string | null; firstName: string | null; lastName: string | null;
}

/**
 * 纯决策（导出供单测）：近期「客户回复」来信 + 库内已有联系人 + 我方内部域列表 → 一键行动清单。
 * 规则：内部域名（同事互转）与公共信箱排除；同邮箱只出一条（取最新一封）；
 *      库里没有 → addContact；有但 status≠reached → markReached；已在跟进列表（reached）→ 不出。
 */
export function decideReplyActions(
  rows: ReplyActionSourceRow[],
  existing: ReplyActionContact[],
  internalDomains: string[],
): ReplyAction[] {
  const byEmail = new Map(existing.map(c => [c.email.trim().toLowerCase(), c]));
  const seen = new Set<string>();
  const out: ReplyAction[] = [];
  for (const r of rows) {
    const email = (r.fromEmail || "").trim();
    const key = email.toLowerCase();
    const domain = (key.split("@")[1] || "").trim();
    if (!key.includes("@") || !domain.includes(".")) continue;
    if (seen.has(key)) continue;
    // 我方内部域名（同事之间的 Re: 转发在分类里也是 replied，不是客户回复）
    if (internalDomains.some(d => d && (domain === d || domain.endsWith(`.${d}`)))) continue;
    if (isBotMailbox(email)) continue;
    seen.add(key);
    const hit = byEmail.get(key);
    if (!hit) {
      const nm = cleanPersonName(r.fromName);
      out.push({ kind: "addContact", email, firstName: nm.firstName, lastName: nm.lastName });
    } else if (hit.status !== "reached") {
      out.push({
        kind: "markReached", email, contactId: hit.id,
        firstName: hit.firstName, lastName: hit.lastName,
      });
    }
  }
  return out;
}

/** 取数：任何一步失败只让候选变少，不打挂整个 feed */
function gatherReplyActions(): ReplyAction[] {
  try {
    const db = getDb();
    const mails = db.select({
      fromEmail: inboxMessages.fromEmail, fromName: inboxMessages.fromName,
    }).from(inboxMessages).where(and(
      eq(inboxMessages.classification, "replied"),
      eq(inboxMessages.myRole, "to"),
    )).orderBy(desc(inboxMessages.receivedAt)).limit(40).all();
    if (!mails.length) return [];
    const emails = [...new Set(mails.map(m => (m.fromEmail || "").trim().toLowerCase()).filter(Boolean))];
    const hits = db.select({
      id: contacts.id, email: contacts.email, status: contacts.status,
      firstName: contacts.firstName, lastName: contacts.lastName,
    }).from(contacts).where(inArray(contacts.email, emails)).all();
    return decideReplyActions(mails, hits, internalDomains()).slice(0, 4);
  } catch { return []; }
}

function gatherMail(now: number): FeedInputs["mail"] {
  const out: FeedInputs["mail"] = { unread: 0, latest: null, unreplied: null, bounce3d: 0 };
  const db = getDb();
  try {
    const unread = db.select({ n: count() }).from(inboxMessages)
      .where(and(eq(inboxMessages.isRead, 0), ne(inboxMessages.classification, "sent"))).get();
    out.unread = Number(unread?.n ?? 0);
    const latest = db.select({
      fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
      subject: inboxMessages.subject, receivedAt: inboxMessages.receivedAt,
    }).from(inboxMessages)
      .where(and(eq(inboxMessages.isRead, 0), ne(inboxMessages.classification, "sent")))
      .orderBy(desc(inboxMessages.receivedAt)).limit(1).all()[0];
    if (latest) {
      out.latest = {
        who: latest.fromName?.trim() || latest.fromEmail,
        subject: (latest.subject || "(无主题)").slice(0, 24),
        receivedAt: latest.receivedAt,
      };
    }
    // 未回询盘：客户来信（replied 且已匹配联系人）之后没有我方 outbound（规范 §4B SQL 口径）
    // created_at 是 "YYYY-MM-DD HH:MM:SS"（UTC），received_at 是 ISO——replace 对齐后字典序可比
    const unreplied = db.select({
      id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
      subject: inboxMessages.subject, receivedAt: inboxMessages.receivedAt,
      matchedContactId: inboxMessages.matchedContactId,
    }).from(inboxMessages).where(and(
      eq(inboxMessages.classification, "replied"),
      isNotNull(inboxMessages.matchedContactId),
      sql`NOT EXISTS (SELECT 1 FROM interactions t WHERE t.contact_id = ${inboxMessages.matchedContactId} AND t.type IN ('sent','replied') AND t.created_at > replace(replace(${inboxMessages.receivedAt},'T',' '),'Z',''))`,
    )).orderBy(desc(inboxMessages.receivedAt)).limit(1).all()[0];
    if (unreplied) {
      out.unreplied = {
        id: unreplied.id,
        from: (unreplied.fromName?.trim() || unreplied.fromEmail).slice(0, 24),
        subject: (unreplied.subject || "(无主题)").slice(0, 24),
        receivedAt: unreplied.receivedAt,
        contactId: unreplied.matchedContactId,
      };
    }
    const bounce = db.select({ n: count() }).from(inboxMessages)
      .where(and(eq(inboxMessages.classification, "bounce"),
        gte(inboxMessages.receivedAt, new Date(now - 3 * DAY).toISOString()))).get();
    out.bounce3d = Number(bounce?.n ?? 0);
  } catch (err) { Log.warn("suggest.mail", `读邮件候选失败：${err instanceof Error ? err.message : String(err)}`); }
  return out;
}

function gatherSend(): FeedInputs["send"] {
  try {
    const st = getSendStatus();
    const q = getQueueItems();
    if (!st.success || !q.success) return null;
    const pending = q.data.filter(i => i.status === "pending");
    return {
      failed: st.data.failedCount,
      pendingGroups: pending.length,
      pendingRecipients: pending.reduce((n, i) => n + i.recipients.length, 0),
      paused: st.data.isPaused,
    };
  } catch (err) { Log.warn("suggest.send", `读队列候选失败：${err instanceof Error ? err.message : String(err)}`); return null; }
}

function gatherReminders(): FeedInputs["reminders"] {
  try {
    const r = checkReminders();
    return r.success ? r.data : null;
  } catch (err) { Log.warn("suggest.crm", `读跟进候选失败：${err instanceof Error ? err.message : String(err)}`); return null; }
}

/** pod 主段 → 最近 30 天有往来（主题/正文提到该港）的联系人，取最近一位；对不上不猜 */
function gatherRelated(tokens: string[]): Map<string, { id: number; name: string }> {
  const out = new Map<string, { id: number; name: string }>();
  if (!tokens.length) return out;
  try {
    const db = getDb();
    for (const token of tokens) {
      const q = `%${token}%`;
      const row = db.select({
        id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email,
      }).from(interactions)
        .innerJoin(contacts, eq(contacts.id, interactions.contactId))
        .where(and(
          gt(interactions.createdAt, new Date(Date.now() - 30 * DAY).toISOString().replace("T", " ").replace("Z", "")),
          or(like(interactions.subject, q), like(interactions.bodyPreview, q)),
        ))
        .orderBy(desc(interactions.createdAt)).limit(1).all()[0];
      if (row) out.set(token, { id: row.id, name: contactName(row) });
    }
  } catch (err) { Log.warn("suggest.related", `往来匹配失败（intel 文案退化为不带客户名）：${err instanceof Error ? err.message : String(err)}`); }
  return out;
}

/** ctx 锚点（"contact:12"）→ 联系人 id */
export function ctxContactId(ctx?: string): number | undefined {
  const m = /^contact:(\d+)$/.exec(ctx ?? "");
  return m ? Number(m[1]) : undefined;
}

/** 组装一次完整 feed（gather 全是本地毫秒级查询；任何一块失败只让候选变少） */
export function feed(ctx?: string, rotate = 0): SuggestionFeed {
  const now = Date.now();
  const diff = ratesDiff();
  const tokens = [...new Set([
    ...(diff?.priceDrops.map(x => x.podRaw) ?? []),
    ...(diff?.addedPods.map(x => x.podRaw) ?? []),
  ].map(podToken).filter((x): x is string => !!x))].slice(0, 8);
  const inp: FeedInputs = {
    now,
    reminders: gatherReminders(),
    send: gatherSend(),
    mail: gatherMail(now),
    replyActions: gatherReplyActions(),
    diff,
    related: gatherRelated(tokens),
    dismissed: dismissedSet(),
    ctxContactId: ctxContactId(ctx),
  };
  return { greeting: buildGreeting(inp), items: selectItems(collectCandidates(inp), inp, rotate) };
}

/** IPC 入口（agent:suggestions）：统一包络 */
export function suggestions(ctx?: string, rotate = 0): Result<SuggestionFeed> {
  return okResult(feed(ctx, rotate));
}
