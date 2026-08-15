import { getDb } from "../db";
import { interactions } from "../db/schema/interactions";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { sql, eq, and, type SQL } from "drizzle-orm";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";

export interface BounceRow {
  id: number;
  contactId: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  subject: string | null;
  reason: string | null;
  detectedAt: string;
}

export interface BounceFilters {
  q?: string; // 搜索邮箱 / 公司名
}

/** 退信日志 — 基于 interactions type=bounced 记录 */
export function listBounces(filters?: BounceFilters): Result<BounceRow[]> {
  Log.debug("bounce.list", JSON.stringify(filters || {}));

  const db = getDb();

  let q = db.select({
    id: interactions.id,
    contactId: interactions.contactId,
    email: contacts.email,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    companyName: companies.name,
    subject: interactions.subject,
    reason: interactions.bodyPreview,
    detectedAt: interactions.createdAt,
  }).from(interactions)
    .leftJoin(contacts, sql`${interactions.contactId} = ${contacts.id}`)
    .leftJoin(companies, sql`${contacts.companyId} = ${companies.id}`);

  const conds: SQL[] = [eq(interactions.type, "bounced")];
  if (filters?.q) {
    const like = `%${filters.q.trim()}%`;
    conds.push(sql`(${contacts.email} LIKE ${like} OR ${companies.name} LIKE ${like})`);
  }
  q = q.where(and(...conds)) as typeof q;

  const rows = q.orderBy(sql`${interactions.createdAt} DESC`).limit(200).all();
  return okResult(rows);
}
