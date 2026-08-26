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

  // 值 → 中文标签
  const CLIENT_TYPE: Record<string, string> = { agent: "代理", direct: "直客" };
  const STATUS: Record<string, string> = { reached: "已触达", replied: "已回复", bounced: "退信", autoreply: "自动回复" };
  // 与界面一致（renderer STAGE_META / send STAGE_BUCKET_DEFS），导出的表格才对得上界面
  const STAGE: Record<string, string> = { cold: "Cold", f1: "F1", f2: "F2", f3: "F3", f4: "F4" };
  const CRM_TAGS: Record<string, string> = { reaching: "触达中", quoting: "报价中", trial: "试单", cooperating: "合作中", lost: "已流失", other: "其他" };

  const fmtDate = (s: string | null | undefined): string => {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtTags = (s: string | null): string => {
    if (!s) return "";
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) ? a.map((k: string) => CRM_TAGS[k] || k).join("、") : "";
    } catch { return ""; }
  };

  // ponytail: 生成 CSV（不依赖 xlsx 库），Excel 可直接打开
  const headers = ["邮箱", "名", "姓", "公司", "职位", "电话", "LinkedIn", "国家", "语言", "客户类型", "状态", "阶段", "负责人", "标签", "来源", "创建时间", "更新时间"];
  const rows = items.map(c => [
    c.email,
    c.firstName || "",
    c.lastName || "",
    c.companyName || "",
    c.title || "",
    c.phone || "",
    c.linkedinUrl || "",
    c.country || "",
    c.language || "",
    CLIENT_TYPE[c.clientType || ""] || c.clientType || "",
    STATUS[c.status || ""] || c.status || "",
    STAGE[c.stage || ""] || c.stage || "",
    c.assignee || "",
    fmtTags(c.tags),
    c.source || "",
    fmtDate(c.createdAt),
    fmtDate(c.updatedAt),
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  // BOM for Excel UTF-8
  return okResult("﻿" + csvContent);
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
