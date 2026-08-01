import { getDb } from "../db";
import { contacts, type ContactRow, type InsertContactRow } from "../db/schema/contacts";
import { eq, like, or, sql as dsql } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

export async function getContactById(id: number): Promise<Result<ContactRow>> {
  Log.debug("contact.getById", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) return failResult(`无效的 ID: ${id}`);
  const row = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return failResult(`联系人不存在: id=${id}`);
  return okResult(row);
}

export async function listContacts(params?: {
  page?: number; pageSize?: number; search?: string;
}): Promise<Result<{ items: ContactRow[]; total: number }>> {
  const page = params?.page || 1;
  const pageSize = params?.pageSize || 50;
  const search = params?.search?.trim();
  let query = getDb().select().from(contacts);

  if (search) {
    const pattern = `%${search}%`;
    query = query.where(or(
      like(contacts.email, pattern),
      like(contacts.firstName, pattern),
      like(contacts.lastName, pattern),
      like(contacts.title, pattern),
    )) as typeof query;
  }

  query = query.orderBy(dsql`${contacts.updatedAt} DESC`) as typeof query;
  const all = query.all();
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);
  return okResult({ items, total });
}

export async function upsertContact(input: Partial<InsertContactRow> & { id?: number; email?: string }): Promise<Result<ContactRow>> {
  Log.debug("contact.upsert", `email=${input.email}`);
  if (!input.email) return failResult("email 必填");

  const existing = getDb().select().from(contacts).where(eq(contacts.email, input.email)).get();
  const now = new Date().toISOString();

  if (existing) {
    // 合并更新：只更新传入的字段
    getDb().update(contacts).set({
      ...input,
      updatedAt: now,
    } as InsertContactRow).where(eq(contacts.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(contacts).where(eq(contacts.id, existing.id)).get()!;
    return okResult(updated);
  }

  // 插入新联系人
  getDb().insert(contacts).values({
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    title: input.title,
    phone: input.phone,
    companyId: input.companyId,
    country: input.country,
    clientType: input.clientType || "unlabeled",
    source: input.source || "manual",
    status: input.status || "",
    tags: input.tags || "[]",
    extra: input.extra || "{}",
    stage: input.stage || "cold",
    createdAt: now,
    updatedAt: now,
  } as InsertContactRow).run();
  saveDatabase();

  const created = getDb().select().from(contacts).where(eq(contacts.email, input.email)).get()!;
  return okResult(created);
}

export async function deleteContact(id: number): Promise<Result<void>> {
  Log.debug("contact.delete", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) return failResult(`无效的 ID: ${id}`);
  const existing = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
  if (!existing) return failResult(`联系人不存在: id=${id}`);
  getDb().delete(contacts).where(eq(contacts.id, id)).run();
  saveDatabase();
  return okResult(undefined);
}

/** 更新联系人状态（send/inbox 引擎调用） */
export function updateContactStatus(id: number, status: string): void {
  getDb().update(contacts).set({
    status, updatedAt: new Date().toISOString(),
  } as InsertContactRow).where(eq(contacts.id, id)).run();
  saveDatabase();
}

/** 标记退信 */
export function markAsBounced(id: number, reason?: string): void {
  getDb().update(contacts).set({
    isBounced: 1, bounceReason: reason || null,
    status: "bounced",
    updatedAt: new Date().toISOString(),
  } as InsertContactRow).where(eq(contacts.id, id)).run();
  saveDatabase();
}
