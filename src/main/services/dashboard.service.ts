import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { interactions } from "../db/schema/interactions";
import { sql } from "drizzle-orm";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";

export interface DashboardStats {
  totalContacts: number;
  totalSent: number;
  totalReplied: number;
  bounceCount: number;
  pipelineSummary: Record<string, number>;
  recentActivity: Array<{
    type: string; contactEmail: string; subject: string | null; createdAt: string;
  }>;
}

export function getStats(): Result<DashboardStats> {
  Log.debug("dashboard.stats", "");

  const db = getDb();

  const totalContacts = db.select({ count: sql<number>`count(*)` }).from(contacts).get()?.count || 0;
  const totalSent = db.select({ count: sql<number>`count(*)` })
    .from(interactions).where(sql`type = 'sent'`).get()?.count || 0;
  const totalReplied = db.select({ count: sql<number>`count(*)` })
    .from(interactions).where(sql`type = 'replied'`).get()?.count || 0;
  const bounceCount = db.select({ count: sql<number>`count(*)` })
    .from(interactions).where(sql`type = 'bounced'`).get()?.count || 0;

  // 阶段统计 — 从 contacts.tags（CRM 管线标签）读取，crm_stages 已废弃
  const STAGE_KEYS = ["reaching", "quoting", "trial", "cooperating", "lost", "other"];
  const tagRows = db.select({ tags: contacts.tags }).from(contacts).all();
  const pipelineSummary: Record<string, number> = {};
  for (const k of STAGE_KEYS) pipelineSummary[k] = 0;
  for (const r of tagRows) {
    let tags: string[] = [];
    try { const p = JSON.parse(r.tags || "[]"); if (Array.isArray(p)) tags = p; } catch { /* 忽略坏 JSON */ }
    const stage = STAGE_KEYS.find(k => tags.includes(k));
    if (stage) pipelineSummary[stage] = (pipelineSummary[stage] || 0) + 1;
  }

  // 最近活动（前 10 条）
  const recentRows = db.select({
    type: interactions.type,
    contactEmail: contacts.email,
    subject: interactions.subject,
    createdAt: interactions.createdAt,
  })
    .from(interactions)
    .leftJoin(contacts, sql`${interactions.contactId} = ${contacts.id}`)
    .orderBy(sql`${interactions.createdAt} DESC`)
    .limit(10)
    .all();

  const recentActivity = recentRows.map(r => ({
    type: r.type,
    contactEmail: r.contactEmail || "未知",
    subject: r.subject,
    createdAt: r.createdAt,
  }));

  return okResult({
    totalContacts, totalSent, totalReplied, bounceCount,
    pipelineSummary, recentActivity,
  });
}
