// ── 今日邮箱概览（首页卡片三）──────────────────────────────────────
// 规范 docs/home-cards-spec.md §5。确定性统计、无模型调用、纯读：不改已读、不触发抓取、不代发任何邮件。
// 口径与既有页面同源：
//   · 「今天」= 北京时间自然日（复用 suggestion.service 的 beijingDay 日界，不自己另定一套）
//   · 「未读」= DB isRead（收件箱列表同源），不引入本地名单
//   · 「待你回复」= 今日客户回复且其后再无发往该邮箱的邮件
// 注意：跨模块清单/常量一律运行时取（历史上顶层派生常量在打包主进程里变空表，把功能整块打死过）。
import { getDb } from "../db";
import { inboxMessages } from "../db/schema/inbox";
import { sql as dsql } from "drizzle-orm";
import { okResult, type Result } from "../errors";
import { beijingDay } from "./suggestion.service";

export interface BriefMail {
  id: number; fromEmail: string; fromName: string | null; subject: string | null;
  classification: string | null; intent: string | null; receivedAt: string; isRead: boolean;
  matchedContactId: number | null;
}

export interface AwaitingReply extends BriefMail {
  /** 已等了多少小时（按北京时间当下） */
  waitedHours: number;
}

export interface MailBrief {
  day: string;                                  // 北京时间 YYYY-MM-DD
  inbound: number;                              // 今日来信（非 sent）
  unread: number;                               // 今日来信里未读
  byClass: Record<string, number>;              // replied/autoreply/bounce/other
  priceInquiry: number;                         // 今日询价意图
  sentToday: number;                            // 今日我方发出副本
  awaiting: AwaitingReply[];                    // 待你回复（最多 5 条，按等待久排）
  latest: BriefMail[];                          // 今日最新（最多 8 封）
  summary: string;                              // 一句人话结论，界面直接显示
}

/** 兼容 ISO 与 "YYYY-MM-DD HH:MM:SS" 两种存量写法；解析不出返回 null（不猜） */
function toEpoch(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const normalized = /[TZ:+]/i.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

function dayRangeUtc(now: Date): { start: number; end: number; day: string } {
  const day = beijingDay(now.getTime());
  const start = Date.parse(`${day}T00:00:00Z`) - 8 * 3600_000;      // 北京时间零点 = UTC 前一日 16:00
  return { start, end: start + 86400_000, day };
}

const CLASS_LABEL: Record<string, string> = {
  replied: "客户回复", autoreply: "自动回复", bounce: "退信", other: "其他来信", sent: "已发送",
};

/** 今日邮箱概览（只读快照） */
export function todayMailBrief(now: Date = new Date()): Result<MailBrief> {
  const { start, end, day } = dayRangeUtc(now);
  const rows = getDb().select({
    id: inboxMessages.id, fromEmail: inboxMessages.fromEmail, fromName: inboxMessages.fromName,
    subject: inboxMessages.subject, classification: inboxMessages.classification, intent: inboxMessages.intent,
    receivedAt: inboxMessages.receivedAt, isRead: inboxMessages.isRead,
    to: inboxMessages.to, cc: inboxMessages.cc, matchedContactId: inboxMessages.matchedContactId,
  }).from(inboxMessages).all();

  const briefRows: BriefMail[] = [];
  const sentAfter: Array<{ at: number; to: string }> = [];
  for (const r of rows) {
    const at = toEpoch(r.receivedAt);
    if (at === null) continue;
    const cls = r.classification || "other";
    if (cls === "sent" && at >= start && at < now.getTime() + 60_000) {
      sentAfter.push({ at, to: `${r.to ?? ""} ${r.cc ?? ""}`.toLowerCase() });
    }
    if (at < start || at >= end) continue;
    briefRows.push({
      id: r.id, fromEmail: r.fromEmail, fromName: r.fromName, subject: r.subject,
      classification: r.classification, intent: r.intent, receivedAt: r.receivedAt,
      isRead: !!r.isRead, matchedContactId: r.matchedContactId,
    });
  }

  const inbound = briefRows.filter(m => (m.classification || "other") !== "sent");
  const byClass: Record<string, number> = { replied: 0, autoreply: 0, bounce: 0, other: 0 };
  for (const m of inbound) {
    const k = m.classification && byClass[m.classification] !== undefined ? m.classification : "other";
    byClass[k] = (byClass[k] ?? 0) + 1;
  }
  const sentToday = rows.filter(r => (r.classification || "") === "sent"
    && (toEpoch(r.receivedAt) ?? -1) >= start && (toEpoch(r.receivedAt) ?? -1) < end).length;

  // 待你回复：今日客户回复之后，没有再发往该邮箱的邮件
  const awaiting: AwaitingReply[] = inbound
    .filter(m => m.classification === "replied")
    .filter(m => {
      const at = toEpoch(m.receivedAt) ?? 0;
      const addr = (m.fromEmail || "").toLowerCase();
      return !sentAfter.some(s => s.at > at && addr && s.to.includes(addr));
    })
    .map(m => ({ ...m, waitedHours: Math.max(0, Math.round(((now.getTime() - (toEpoch(m.receivedAt) ?? now.getTime())) / 3600_000) * 10) / 10) }))
    .sort((a, b) => b.waitedHours - a.waitedHours)
    .slice(0, 5);

  const latest = [...inbound].sort((a, b) => (b.receivedAt || "").localeCompare(a.receivedAt || "")).slice(0, 8);

  const parts: string[] = [];
  parts.push(inbound.length
    ? `今天（${day.slice(5)}）收到 ${inbound.length} 封来信，未读 ${inbound.filter(m => !m.isRead).length} 封`
    : `今天（${day.slice(5)}）还没有新来信`);
  if (byClass.replied) parts.push(`客户回复 ${byClass.replied} 封`);
  if (awaiting.length) parts.push(`其中 ${awaiting.length} 封还没回，最久已等 ${awaiting[0]!.waitedHours} 小时`);
  if (byClass.bounce) parts.push(`退信 ${byClass.bounce} 封要看下账号健康`);
  if (byClass.autoreply) parts.push(`自动回复 ${byClass.autoreply} 封（无需回）`);
  if (sentToday) parts.push(`我方今天发出 ${sentToday} 封`);

  return okResult({
    day,
    inbound: inbound.length,
    unread: inbound.filter(m => !m.isRead).length,
    byClass,
    priceInquiry: inbound.filter(m => m.intent === "price_inquiry").length,
    sentToday,
    awaiting,
    latest,
    summary: parts.join("；") + "。",
  });
}

/** 分类中文名（界面与提示词共用一份） */
export function mailClassLabel(cls: string | null | undefined): string {
  return CLASS_LABEL[cls ?? ""] ?? cls ?? "其他来信";
}
