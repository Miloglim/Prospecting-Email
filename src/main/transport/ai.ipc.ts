import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as Ai from "../services/ai.service";
import { saveBackcheck } from "../services/company.service";
import { classifyClientType } from "../services/client-type.service";
import { failResult } from "../errors";
import { Log } from "../logger";
import { getDb } from "../db";
import { companies, type CompanyRow } from "../db/schema/companies";
import { contacts } from "../db/schema/contacts";
import { eq } from "drizzle-orm";

export function registerAiIPC() {
  // 配置状态
  ipcMain.handle(IPC.AI.STATUS, () => ({ success: true as const, data: Ai.isAiConfigured() }));

  // API 密钥状态（不返回明文）
  ipcMain.handle(IPC.AI.GET_KEYS, () => Ai.getApiKeyStatus());
  // 写入密钥到 .env（空值=清除）
  ipcMain.handle(IPC.AI.SET_KEY, (_e, input: { name?: string; value?: string }) => {
    if (!input?.name) return failResult("缺少密钥名");
    return Ai.setApiKey(input.name as Ai.ApiKeyName, input.value ?? "");
  });

  // 公司背调：先搜索，再生成报告，自动存 companies.backcheckData
  ipcMain.handle(IPC.AI.BACKCHECK, async (_e, input: Ai.BackcheckInput) => {
    if (!input?.companyName?.trim()) return failResult("请填写公司名");
    Log.debug("ai.backcheck", input.companyName);
    const hits = await Ai.searchCompany(input.companyName + (input.website ? " " + input.website : ""));
    if (!hits.success) return hits;
    const report = await Ai.generateBackcheckReport(input, hits.data);
    if (!report.success) return report;
    const saved = await saveBackcheck({
      name: input.companyName.trim(),
      domain: input.website ? input.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : undefined,
      report: report.data,
    });
    if (!saved.success) return saved;

    // 自动识别代理/直客，回写该公司所有联系人
    const ctype = classifyClientType(input.companyName);
    if (ctype) {
      try {
        getDb().update(contacts).set({ clientType: ctype, updatedAt: new Date().toISOString() })
          .where(eq(contacts.companyId, saved.data.id)).run();
      } catch { /* 回写失败不影响背调结果 */ }
    }

    return { success: true as const, data: { report: report.data, companyId: saved.data.id, clientType: ctype } };
  });

  // AI 开发信：自动带上该公司已存的背调报告（若有）
  ipcMain.handle(IPC.AI.GENERATE_DRAFT, async (_e, input: Ai.EmailDraftInput) => {
    if (!input?.companyName?.trim() || !input?.contactName?.trim()) return failResult("公司名和联系人必填");
    if (!input.language) return failResult("请选择语言");
    let backcheck: Ai.BackcheckReport | null = null;
    try {
      const comp = getDb().select().from(companies)
        .where(eq(companies.name, input.companyName.trim())).get() as CompanyRow | undefined;
      if (comp?.backcheckData) backcheck = JSON.parse(comp.backcheckData) as Ai.BackcheckReport;
    } catch { /* 无背调或坏 JSON，忽略 */ }
    return Ai.generateEmailDraft({ ...input, backcheck });
  });

  // AI 邮件总结
  ipcMain.handle(IPC.AI.SUMMARIZE_EMAIL, async (_e, input: Ai.EmailSummaryInput) => {
    if (!input?.subject && !input?.bodyPreview) return failResult("邮件内容为空");
    return Ai.summarizeEmail(input);
  });
}
