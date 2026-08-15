import { getDb } from "../db";
import { interactions } from "../db/schema/interactions";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { emailAccounts } from "../db/schema/accounts";
import { sql, eq, and, type SQL } from "drizzle-orm";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";

export interface SendHistoryRow {
  id: number;
  contactId: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  subject: string | null;
  accountEmail: string | null;
  sentAt: string;
}

export interface HistoryFilters {
  q?: string;         // 搜索邮箱 / 公司名
  accountId?: number; // 按发件账号筛选
  limit?: number;
}

/** 发送历史 — 按联系人/公司/账号/时间列出全部 sent 记录 */
export function listHistory(filters?: HistoryFilters): Result<SendHistoryRow[]> {
  Log.debug("history.list", JSON.stringify(filters || {}));

  const db = getDb();
  const limit = Math.min(filters?.limit || 200, 500);

  let q = db.select({
    id: interactions.id,
    contactId: interactions.contactId,
    email: contacts.email,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    companyName: companies.name,
    subject: interactions.subject,
    accountEmail: emailAccounts.email,
    sentAt: interactions.createdAt,
  }).from(interactions)
    .leftJoin(contacts, sql`${interactions.contactId} = ${contacts.id}`)
    .leftJoin(companies, sql`${contacts.companyId} = ${companies.id}`)
    .leftJoin(emailAccounts, sql`${interactions.accountId} = ${emailAccounts.id}`);

  const conds: SQL[] = [eq(interactions.type, "sent")];
  if (filters?.q) {
    const like = `%${filters.q.trim()}%`;
    conds.push(sql`(${contacts.email} LIKE ${like} OR ${companies.name} LIKE ${like})`);
  }
  if (filters?.accountId) {
    conds.push(eq(interactions.accountId, filters.accountId));
  }
  q = q.where(and(...conds)) as typeof q;

  const rows = q.orderBy(sql`${interactions.createdAt} DESC`).limit(limit).all();
  return okResult(rows);
}

/** 有发送记录的日期列表（倒序） — 用于历史页日期筛选 */
export function getSendDates(): Result<string[]> {
  const rows = getDb().select({ day: sql<string>`substr(${interactions.createdAt}, 1, 10)` })
    .from(interactions)
    .where(eq(interactions.type, "sent"))
    .groupBy(sql`substr(${interactions.createdAt}, 1, 10)`)
    .orderBy(sql`substr(${interactions.createdAt}, 1, 10) DESC`)
    .limit(90)
    .all();
  return okResult(rows.map(r => r.day));
}
