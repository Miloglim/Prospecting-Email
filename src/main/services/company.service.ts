import { getDb } from "../db";
import { companies, type CompanyRow, type InsertCompanyRow } from "../db/schema/companies";
import { eq, like, or } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

export async function getCompanyById(id: number): Promise<Result<CompanyRow>> {
  Log.debug("company.getById", `id=${id}`);

  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }

  const row = getDb().select().from(companies).where(eq(companies.id, id)).get();

  if (!row) {
    return failResult(`公司不存在: id=${id}`);
  }

  return okResult(row);
}

export async function listCompanies(search?: string): Promise<Result<CompanyRow[]>> {
  Log.debug("company.list", `search=${search}`);

  let query = getDb().select().from(companies);

  if (search?.trim()) {
    const pattern = `%${search.trim()}%`;
    query = query.where(
      or(like(companies.name, pattern), like(companies.domain, pattern))
    ) as typeof query;
  }

  return okResult(query.all());
}

export async function upsertCompany(input: InsertCompanyRow): Promise<Result<CompanyRow>> {
  Log.debug("company.upsert", `name=${input.name}`);

  if (!input.name) {
    return failResult("公司名称必填");
  }

  const now = new Date().toISOString();

  // 按名称或域名查重
  let existing: CompanyRow | undefined;
  if (input.domain) {
    existing = getDb().select().from(companies).where(eq(companies.domain, input.domain)).get();
  }
  if (!existing) {
    existing = getDb().select().from(companies).where(eq(companies.name, input.name)).get();
  }

  if (existing) {
    getDb().update(companies).set({ ...input, updatedAt: now })
      .where(eq(companies.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(companies).where(eq(companies.id, existing.id)).get()!;
    return okResult(updated);
  }

  getDb().insert(companies).values({ ...input, createdAt: now, updatedAt: now }).run();
  saveDatabase();
  const created = getDb().select().from(companies).where(eq(companies.name, input.name)).get()!;
  return okResult(created);
}

export async function deleteCompany(id: number): Promise<Result<void>> {
  Log.debug("company.delete", `id=${id}`);

  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }

  const existing = getDb().select().from(companies).where(eq(companies.id, id)).get();
  if (!existing) {
    return failResult(`公司不存在: id=${id}`);
  }

  getDb().delete(companies).where(eq(companies.id, id)).run();
  saveDatabase();
  return okResult(undefined);
}
