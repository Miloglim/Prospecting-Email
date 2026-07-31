import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { listContacts } from "./contact.service";

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
