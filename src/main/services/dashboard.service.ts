import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { interactions } from "../db/schema/interactions";
import { crmStages } from "../db/schema/crm";
import { inboxMessages } from "../db/schema/inbox";
import { sql } from "drizzle-orm";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";

export interface DashboardStats {
  totalContacts: number;
  totalSent: number;
  totalReplied: number;
  bounceCount: number;
  openRate: number;
  replyRate: number;
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

  // 阶段统计
  const stages = db.select({ stage: crmStages.stage, count: sql<number>`count(*)` })
    .from(crmStages).groupBy(crmStages.stage).all();
  const pipelineSummary: Record<string, number> = {};
  for (const s of stages) {
    pipelineSummary[s.stage] = s.count;
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

  const openRate = totalSent > 0 ? (bounceCount + totalReplied) / totalSent : 0;
  const replyRate = totalSent > 0 ? totalReplied / totalSent : 0;

  return okResult({
    totalContacts, totalSent, totalReplied, bounceCount,
    openRate: Math.round(openRate * 100) / 100,
    replyRate: Math.round(replyRate * 100) / 100,
    pipelineSummary, recentActivity,
  });
}
