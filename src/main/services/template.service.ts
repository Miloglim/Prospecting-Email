import { getDb } from "../db";
import { templates, type TemplateRow, type InsertTemplateRow } from "../db/schema/templates";
import { eq, and } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

export async function listTemplates(language?: string): Promise<Result<TemplateRow[]>> {
  Log.debug("template.list", `language=${language}`);

  let query = getDb().select().from(templates);

  if (language) {
    query = query.where(eq(templates.language, language)) as typeof query;
  }

  return okResult(query.all().filter(t => t.isActive === 1));
}

export async function upsertTemplate(input: InsertTemplateRow): Promise<Result<TemplateRow>> {
  Log.debug("template.upsert", `name=${input.name}`);

  if (!input.name || !input.subject || !input.body) {
    return failResult("name、subject、body 必填");
  }

  const now = new Date().toISOString();

  // 按名称 + 语言判重
  const existing = getDb().select().from(templates)
    .where(and(eq(templates.name, input.name), eq(templates.language, input.language || "EN")))
    .get();

  if (existing) {
    getDb().update(templates).set({
      ...input,
      version: (existing.version || 1) + 1,
      updatedAt: now,
    }).where(eq(templates.id, existing.id)).run();
    saveDatabase();
    const updated = getDb().select().from(templates).where(eq(templates.id, existing.id)).get()!;
    return okResult(updated);
  }

  getDb().insert(templates).values({
    ...input,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }).run();
  saveDatabase();
  const created = getDb().select().from(templates)
    .where(and(eq(templates.name, input.name), eq(templates.language, input.language || "EN")))
    .get()!;
  return okResult(created);
}

export async function deleteTemplate(id: number): Promise<Result<void>> {
  Log.debug("template.delete", `id=${id}`);

  if (!Number.isInteger(id) || id <= 0) {
    return failResult(`无效的 ID: ${id}`);
  }

  // 软删除
  getDb().update(templates).set({ isActive: 0, updatedAt: new Date().toISOString() })
    .where(eq(templates.id, id)).run();
  saveDatabase();
  return okResult(undefined);
}

/** ponytail: Liquid 变量替换 — 正则匹配 {{ contact.xxx }} */
export function renderTemplate(template: TemplateRow, contact: Record<string, unknown>): Result<string> {
  if (!template.body) return failResult("模板内容为空");

  let result = template.body;
  let subject = template.subject;

  for (const [key, value] of Object.entries(contact)) {
    const pattern = new RegExp(`\\{\\{\\s*contact\\.${key}\\s*\\}\\}`, "gi");
    const replacement = value != null ? String(value) : "";
    result = result.replace(pattern, replacement);
    subject = subject.replace(pattern, replacement);
  }

  return okResult(result);
}
