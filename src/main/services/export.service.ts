import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { listContacts } from "./contact.service";
import { getDb } from "../db";
import { interactions } from "../db/schema/interactions";
import { contacts } from "../db/schema/contacts";
import { sql } from "drizzle-orm";

export async function exportContactsToExcel(filter?: { search?: string }): Promise<Result<string>> {
  Log.debug("export.contactsToExcel", "");

  const result = await listContacts({ page: 1, pageSize: 99999, search: filter?.search });

  if (!result.success) {
    return failResult("导出失败: " + result.error);
  }

  const items = result.data.items;
  if (items.length === 0) {
    return failResult("没有可导出的联系人");
  }

  // ponytail: 生成 CSV（不依赖 xlsx 库），Excel 可直接打开
  const headers = ["邮箱", "名", "姓", "职位", "电话", "LinkedIn", "公司ID", "来源", "创建时间"];
  const rows = items.map(c => [
    c.email,
    c.firstName || "",
    c.lastName || "",
    c.title || "",
    c.phone || "",
    c.linkedinUrl || "",
    String(c.companyId || ""),
    c.source || "",
    c.createdAt || "",
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  // BOM for Excel UTF-8
  const bom = "﻿";
  const content = bom + csvContent;

  return okResult(content);
}

/** 导出全部跟进记录（interactions type=note），按时间倒序 */
export function exportNotesToCsv(): Result<string> {
  Log.debug("export.notesToCsv", "");

  const rows = getDb().select({
    contactEmail: contacts.email,
    contactName: sql<string>`${contacts.firstName} || ' ' || ${contacts.lastName}`,
    text: interactions.bodyPreview,
    createdAt: interactions.createdAt,
  })
    .from(interactions)
    .leftJoin(contacts, sql`${interactions.contactId} = ${contacts.id}`)
    .where(sql`${interactions.type} = 'note'`)
    .orderBy(sql`${interactions.createdAt} DESC`)
    .all();

  if (rows.length === 0) {
    return failResult("没有跟进记录可导出");
  }

  const headers = ["联系人邮箱", "姓名", "跟进内容", "时间"];
  const data = rows.map(r => [
    r.contactEmail || "",
    (r.contactName || "").trim(),
    r.text || "",
    r.createdAt || "",
  ]);

  const csvContent = [headers, ...data]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return okResult("﻿" + csvContent);
}
