import { getDb } from "../db";
import { contacts, type ContactRow, type InsertContactRow } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { eq, like, or, and, count, desc, sql as dsql, type SQL } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";
import * as XLSX from "xlsx";

// ── 导入：列名别名 → 字段映射 ──
const COLUMN_ALIASES: Record<string, string[]> = {
  email:        ["email", "e-mail", "mail", "邮箱", "邮件"],
  companyName:  ["company", "公司", "company name", "企业", "organization", "org", "公司名称"],
  companyDomain:["website", "domain", "网站", "网址", "域名"],
  firstName:    ["first name", "firstname", "given name", "名", "名字", "first"],
  lastName:     ["last name", "lastname", "surname", "姓", "姓氏", "last"],
  title:        ["title", "职位", "职务", "job title", "job"],
  phone:        ["phone", "电话", "手机", "tel", "telephone", "mobile"],
  linkedinUrl:  ["linkedin", "领英", "linkedin url", "linkedinurl"],
  country:      ["country", "国家", "语言", "language", "lang"],
  stage:        ["stage", "阶段", "发送阶段"],
  status:       ["status", "状态"],
  clientType:   ["client type", "clienttype", "客户类型", "类型", "type"],
  tags:         ["tags", "标签"],
  assignee:     ["assignee", "负责人", "跟进人", "owner", "assigned to"],
  createdAt:    ["createdat", "添加时间", "创建时间", "added at", "date added"],
  extraNote:    ["备注", "跟进备注", "notes", "note", "退信原因", "bounce reason"],
};

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[-_.\s]+/g, "");
}

function buildAliasMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) m.set(normalizeKey(a), field);
  }
  return m;
}

function autoMap(headers: string[]): Record<string, string> {
  const aliasMap = buildAliasMap();
  const mapping: Record<string, string> = {};
  for (const h of headers) {
    mapping[h] = aliasMap.get(normalizeKey(h)) || "";
  }
  return mapping;
}

function parseRows(type: string, raw: string): string[][] {
  try {
    if (type === "xlsx") {
      Log.debug("contact.parseRows.xlsx", `raw len=${raw.length}`);
      const buf = Buffer.from(raw, "base64");
      Log.debug("contact.parseRows.xlsx", `buffer len=${buf.length}`);
      const wb = XLSX.read(buf, { type: "buffer" });
      Log.debug("contact.parseRows.xlsx", `sheets=${wb.SheetNames.join(",")}`);
      const name = wb.SheetNames[0];
      if (!name || !wb.Sheets[name]) return [];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1 }) as string[][];
      Log.debug("contact.parseRows.xlsx", `rows=${rows.length}`);
      return rows;
    }
    if (type === "csv") {
      Log.debug("contact.parseRows.csv", `raw len=${raw.length}`);
      const wb = XLSX.read(raw, { type: "string" });
      const name = wb.SheetNames[0];
      if (!name || !wb.Sheets[name]) return [];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1 }) as string[][];
      Log.debug("contact.parseRows.csv", `rows=${rows.length}`);
      return rows;
    }
    // tsv（粘贴）
    Log.debug("contact.parseRows.tsv", `raw len=${raw.length}`);
    const lines = raw.trim().split("\n");
    if (lines.length === 0) return [];
    // 检测分隔符：如果第一行 tab 数量 > 逗号数量，用 tab
    const tabs0 = (lines[0]?.match(/\t/g) || []).length;
    const commas0 = (lines[0]?.match(/,/g) || []).length;
    const sep = tabs0 >= commas0 ? "\t" : ",";
    return lines.map(line => line.split(sep));
  } catch (err) {
    Log.error("contact.parseRows", err instanceof Error ? err.stack || err.message : String(err));
    return [];
  }
}

export async function getContactById(id: number): Promise<Result<ContactRow>> {
  Log.debug("contact.getById", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) return failResult(`无效的 ID: ${id}`);
  const row = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return failResult(`联系人不存在: id=${id}`);
  return okResult(row);
}

export async function listContacts(params?: {
  page?: number; pageSize?: number; search?: string;
  stage?: string; status?: string; tags?: string; clientType?: string; country?: string;
}): Promise<Result<{ items: (ContactRow & { companyName: string | null })[]; total: number }>> {
  const page = params?.page || 1;
  const pageSize = params?.pageSize || 50;
  const search = params?.search?.trim();
  const filters = {
    stage: params?.stage as string | undefined,
    status: params?.status as string | undefined,
    tags: params?.tags as string | undefined,
    clientType: params?.clientType as string | undefined,
    country: params?.country as string | undefined,
  };
  // 构建 where 条件（count 与分页查询复用）
  const conds: (SQL | undefined)[] = [];
  if (search) {
    const pattern = `%${search}%`;
    conds.push(or(
      like(contacts.email, pattern),
      like(contacts.firstName, pattern),
      like(contacts.lastName, pattern),
      like(contacts.title, pattern),
      like(companies.name, pattern),
    ));
  }
  if (filters.stage) conds.push(eq(contacts.stage, filters.stage));
  if (filters.status) conds.push(eq(contacts.status, filters.status));
  if (filters.tags) conds.push(like(contacts.tags, `%${filters.tags}%`));
  if (filters.clientType) conds.push(eq(contacts.clientType, filters.clientType));
  if (filters.country) conds.push(eq(contacts.country, filters.country));
  const where = (conds.length ? and(...conds) : dsql`1=1`) as SQL;

  // 总数：COUNT 一次，不查全表
  const total = Number(getDb().select({ n: count() })
    .from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(where).get()?.n) || 0;

  // 真分页：SQL LIMIT/OFFSET
  const items = getDb().select({
    id: contacts.id, email: contacts.email, companyId: contacts.companyId,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    country: contacts.country, language: contacts.language, clientType: contacts.clientType,
    stage: contacts.stage, status: contacts.status,
    tags: contacts.tags, extra: contacts.extra,
    assignee: contacts.assignee,
    source: contacts.source, sourceDetail: contacts.sourceDetail,
    createdAt: contacts.createdAt, updatedAt: contacts.updatedAt,
    companyName: companies.name,
  }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(where)
    .orderBy(dsql`${contacts.updatedAt} DESC`)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return okResult({ items, total });
}

/** 解析 tags 列（JSON 数组文本 → string[]），坏 JSON/空 → [] */
function parseTagsArr(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export async function upsertContact(input: Partial<InsertContactRow> & { id?: number; email?: string }): Promise<Result<ContactRow>> {
  Log.debug("contact.upsert", `email=${input.email}`);
  if (!input.email) return failResult("email 必填");
  // ponytail: 空字符串 → null（clientType 等可选字段）
  const cleanInput = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, v === "" ? null : v])
  ) as typeof input;

  const existing = getDb().select().from(contacts).where(eq(contacts.email, input.email)).get();
  const now = new Date().toISOString();

  // 公司名 → companyId 解析（新增/编辑联系人时传入 companyName 而非 companyId）
  const companyName = (input as Record<string, unknown>).companyName as string | undefined;
  const hasCompanyName = "companyName" in (input as Record<string, unknown>);
  if (companyName) {
    let company = getDb().select().from(companies).where(eq(companies.name, companyName)).get();
    if (!company) {
      getDb().insert(companies).values({ name: companyName, createdAt: now, updatedAt: now }).run();
      company = getDb().select().from(companies).where(eq(companies.name, companyName)).get()!;
    }
    cleanInput.companyId = company.id;
  } else if (hasCompanyName) {
    // 显式传了空 companyName → 清除公司关联
    cleanInput.companyId = null;
  }
  const oldCompanyId = existing?.companyId;
  delete (cleanInput as Record<string, unknown>).companyName;

  if (existing) {
    // v4.0 status/tags 双向联动（tags = CRM 分类，固定 6 值单选）
    const newTags = cleanInput.tags !== undefined ? parseTagsArr(cleanInput.tags) : null;
    // 反向：设置分类（有值）且非已触达 → 强制已触达，使其进入 CRM 管线
    if (newTags && newTags.length > 0 && existing.status !== "reached") {
      cleanInput.status = "reached";
    }
    // 正向：最终状态为已触达 且 无分类 → 自动写触达中（默认值）
    const finalStatus = cleanInput.status ?? existing.status;
    const finalTags = newTags ?? parseTagsArr(existing.tags);
    if (finalStatus === "reached" && finalTags.length === 0) {
      cleanInput.tags = JSON.stringify(["reaching"]);
    }
    // 单向清除：status 被显式改为非 reached → 清空 tags（用户没同时设 tags 时才清）
    if (cleanInput.status !== undefined && cleanInput.status !== "reached" && cleanInput.tags === undefined) {
      cleanInput.tags = null;
    }

    // 合并更新：只更新传入的字段
    getDb().update(contacts).set({
      ...cleanInput,
      updatedAt: now,
    } as InsertContactRow).where(eq(contacts.id, existing.id)).run();

    // 公司变更时清理旧空壳公司（含清空公司的情况）
    const newCid = cleanInput.companyId !== undefined ? cleanInput.companyId : oldCompanyId;
    if (oldCompanyId && oldCompanyId !== newCid) {
      const remaining = getDb().select({ id: contacts.id })
        .from(contacts).where(eq(contacts.companyId, oldCompanyId)).all();
      if (remaining.length === 0) {
        getDb().delete(companies).where(eq(companies.id, oldCompanyId)).run();
      }
    }

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
    companyId: cleanInput.companyId ?? null,
    country: input.country,
    language: (input as Record<string, unknown>).language as string || null,
    clientType: input.clientType || null,
    source: input.source || "manual",
    status: input.status || "",
    tags: input.tags ?? null,
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
  const companyId = existing.companyId;
  getDb().delete(contacts).where(eq(contacts.id, id)).run();

  // 公司无联系人时自动清理
  if (companyId) {
    const remaining = getDb().select({ id: contacts.id })
      .from(contacts).where(eq(contacts.companyId, companyId)).all();
    if (remaining.length === 0) {
      getDb().delete(companies).where(eq(companies.id, companyId)).run();
      Log.debug("contact.delete", `已删除空壳公司 id=${companyId}`);
    }
  }
  saveDatabase();
  return okResult(undefined);
}

/** 查询联系人互动历史 */
export async function getContactInteractions(id: number): Promise<Result<Array<{
  type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string;
}>>> {
  if (!Number.isInteger(id) || id <= 0) return failResult("无效的 ID");
  const rows = getDb().select().from(interactions)
    .where(eq(interactions.contactId, id))
    .orderBy(desc(interactions.createdAt))
    .limit(50)
    .all();
  return okResult(rows);
}

/** 更新联系人状态（send/inbox 引擎调用） */
export function updateContactStatus(id: number, status: string): void {
  const set: { status: string; updatedAt: string; tags?: string } = {
    status, updatedAt: new Date().toISOString(),
  };
  // v4.0 正向联动：状态改为已触达 且 无分类 → 自动写触达中
  if (status === "reached") {
    const contact = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
    if (contact && parseTagsArr(contact.tags).length === 0) set.tags = JSON.stringify(["reaching"]);
  }
  getDb().update(contacts).set(set as InsertContactRow).where(eq(contacts.id, id)).run();
  saveDatabase();
}

/** 标记退信（退信原因记录在 interactions type=bounced） */
export function markAsBounced(id: number): void {
  getDb().update(contacts).set({
    status: "bounced",
    updatedAt: new Date().toISOString(),
  } as InsertContactRow).where(eq(contacts.id, id)).run();
  saveDatabase();
}

// ── 批量导入 ──

export interface ImportPreview {
  headers: string[];
  previewRows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  duplicateEmails: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

export async function importContacts(params: {
  mode: "preview"; type: "csv" | "xlsx" | "tsv"; data: string;
}): Promise<Result<ImportPreview>>;
export async function importContacts(params: {
  mode: "execute"; type: "csv" | "xlsx" | "tsv"; data: string; mapping: Record<string, string>;
}): Promise<Result<ImportResult>>;
export async function importContacts(params: {
  mode: "preview" | "execute";
  type?: "csv" | "xlsx" | "tsv";
  data?: string;
  mapping?: Record<string, string>;
}): Promise<Result<ImportPreview | ImportResult>> {
  if (params.mode === "preview") {
    Log.debug("contact.importPreview", `type=${params.type}`);
    if (!params.data) return failResult("数据为空");
    const allRows = parseRows(params.type!, params.data);
    if (allRows.length < 2) return failResult("至少需要一行表头 + 一行数据");

    const headerRow = allRows[0]!;
    const headers = headerRow.map(c => String(c ?? "").trim()).filter(h => h !== "");
    if (headers.length === 0) return failResult("表头为空");
    const dataRows = allRows.slice(1).map(row => headers.map((_, i) => String(row[i] ?? "").trim()));
    const previewRows = dataRows.slice(0, 20);
    const suggestedMapping = autoMap(headers);

    // 检测预览中已在库的邮箱
    const emailCol = headers.find(h => suggestedMapping[h] === "email");
    const duplicateEmails: string[] = [];
    if (emailCol) {
      const emailIdx = headers.indexOf(emailCol);
      const existingSet = new Set(
        getDb().select({ e: contacts.email }).from(contacts).all().map(r => r.e.toLowerCase()),
      );
      for (const row of dataRows) {
        const e = (row[emailIdx] || "").toLowerCase().trim();
        if (e && existingSet.has(e)) duplicateEmails.push(e);
      }
    }

    return okResult({ headers, previewRows, totalRows: dataRows.length, suggestedMapping, duplicateEmails });
  }

  // ── execute ──
  Log.debug("contact.importExecute", `type=${params.type}`);
  const allRows = parseRows(params.type!, params.data!);
  if (allRows.length < 2) return failResult("数据为空");
  const headerRow = allRows[0]!;
  const headers = headerRow.map(c => String(c ?? "").trim()).filter(h => h !== "");
  const dataRows = allRows.slice(1).map(row => headers.map((_, i) => String(row[i] ?? "").trim()));
  const mapping = params.mapping!;

  const emailHeader = headers.find(h => mapping[h] === "email");
  if (!emailHeader) return failResult("未映射 email 列");
  const emailIdx = headers.indexOf(emailHeader);
  const now = new Date().toISOString();

  const existingSet = new Set(
    getDb().select({ e: contacts.email }).from(contacts).all().map(r => r.e.toLowerCase()),
  );

  let imported = 0, skipped = 0;

  for (const row of dataRows) {
    const email = (row[emailIdx] || "").toLowerCase().trim();
    if (!email) { skipped++; continue; }
    if (existingSet.has(email)) { skipped++; continue; }

    // 收集映射字段
    const fields: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (!field || field === "email") continue;
      const idx = headers.indexOf(header);
      const val = (row[idx] || "").trim();
      if (val) fields[field] = val;
    }

    // 旧 PE 中文值 → 新系统 key 翻译
    const STAGE_XLATE: Record<string, string> = {
      "冷开发": "cold", "跟进1": "f1", "跟进2": "f2", "跟进3": "f3", "跟进4": "f4",
      "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
    };
    const STATUS_XLATE: Record<string, string> = {
      "未触达": "", "已触达": "reached", "有回复": "replied", "已回复": "replied",
      "退信": "bounced", "自动回复": "autoreply",
    };
    const CTYPE_XLATE: Record<string, string> = { "代理": "agent", "直客": "direct", "同行": "agent" };
    if (fields.stage && STAGE_XLATE[fields.stage] !== undefined) fields.stage = STAGE_XLATE[fields.stage]!;
    if (fields.status !== undefined && STATUS_XLATE[fields.status] !== undefined) fields.status = STATUS_XLATE[fields.status]!;
    if (fields.clientType && CTYPE_XLATE[fields.clientType]) fields.clientType = CTYPE_XLATE[fields.clientType]!;

    // 公司名 → companyId（含 domain 更新）
    let companyId: number | null = null;
    if (fields.companyName) {
      let company = getDb().select().from(companies).where(eq(companies.name, fields.companyName)).get();
      if (!company) {
        getDb().insert(companies).values({
          name: fields.companyName,
          domain: fields.companyDomain || null,
          createdAt: now, updatedAt: now,
        }).run();
        company = getDb().select().from(companies).where(eq(companies.name, fields.companyName)).get()!;
      } else if (fields.companyDomain && !company.domain) {
        getDb().update(companies).set({ domain: fields.companyDomain, updatedAt: now })
          .where(eq(companies.id, company.id)).run();
      }
      companyId = company.id;
      delete fields.companyName;
    }
    delete fields.companyDomain;

    // 备注 / 退信原因 → extra JSON
    let extra: Record<string, unknown> = {};
    if (fields.extraNote) {
      extra.note = fields.extraNote;
      delete fields.extraNote;
    }

    const insert: Record<string, unknown> = {
      email,
      companyId,
      source: "import",
      stage: fields.stage || "cold",
      status: fields.status || "",
      extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : "{}",
      createdAt: fields.createdAt || now,
      updatedAt: now,
    };
    delete fields.createdAt;
    delete fields.status;
    // ponytail: 字段已写入 insert，从 fields 中移除避免重复写
    for (const [k, v] of Object.entries(fields)) {
      if (k === "stage") continue;
      insert[k] = v;
    }

    try {
      getDb().insert(contacts).values(insert as InsertContactRow).run();
      imported++;
      existingSet.add(email);
    } catch (err) {
      Log.warn("contact.import", `跳过 ${email}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  if (imported > 0) saveDatabase();
  Log.info("contact.import", `导入 ${imported} 条，跳过 ${skipped} 条`);
  return okResult({ imported, skipped });
}
