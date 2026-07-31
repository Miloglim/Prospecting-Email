import { getDb } from "../db";
import { contacts, type ContactRow, type InsertContactRow } from "../db/schema/contacts";
import { eq, like, or, and, sql as dsql } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

export async function getContactById(id: number): Promise<Result<ContactRow>> {
  Log.debug("contact.getById", `id=${id}`);

  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }

  const row = getDb().select().from(contacts).where(eq(contacts.id, id)).get();

  if (!row) {
    return failResult(`联系人不存在: id=${id}`);
  }

  return okResult(row);
}

export async function listContacts(params?: {
  page?: number; pageSize?: number; search?: string;
}): Promise<Result<{ items: ContactRow[]; total: number }>> {
  Log.debug("contact.list", JSON.stringify(params));

  const page = params?.page || 1;
  const pageSize = params?.pageSize || 50;
  const search = params?.search?.trim();

  let query = getDb().select().from(contacts);

  if (search) {
    const pattern = `%${search}%`;
    query = query.where(
      or(
        like(contacts.email, pattern),
        like(contacts.firstName, pattern),
        like(contacts.lastName, pattern),
        like(contacts.title, pattern),
      )
    ) as typeof query;
  }

  const all = query.all();
  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);

  return okResult({ items, total });
}

export async function upsertContact(input: InsertContactRow): Promise<Result<ContactRow>> {
  Log.debug("contact.upsert", `email=${input.email}`);

  if (!input.email) {
    return failResult("email 必填");
  }

  const existing = getDb().select().from(contacts)
    .where(eq(contacts.email, input.email)).get();

  const now = new Date().toISOString();

  if (existing) {
    getDb().update(contacts).set({
      ...input,
      updatedAt: now,
    }).where(eq(contacts.id, existing.id)).run();
    saveDatabase();

    const updated = getDb().select().from(contacts)
      .where(eq(contacts.id, existing.id)).get()!;
    return okResult(updated);
  }

  getDb().insert(contacts).values({
    ...input,
    createdAt: now,
    updatedAt: now,
  }).run();
  saveDatabase();

  const created = getDb().select().from(contacts)
    .where(eq(contacts.email, input.email)).get()!;
  return okResult(created);
}

export async function deleteContact(id: number): Promise<Result<void>> {
  Log.debug("contact.delete", `id=${id}`);

  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }

  const existing = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
  if (!existing) {
    return failResult(`联系人不存在: id=${id}`);
  }

  getDb().delete(contacts).where(eq(contacts.id, id)).run();
  saveDatabase();
  return okResult(undefined);
}
