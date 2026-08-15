import { ipcMain, BrowserWindow } from "electron";
import * as nodemailer from "nodemailer";
import { IPC } from "../contract";
import * as SendService from "../services/send.service";
import { Log } from "../logger";
import { failResult, okResult, type Result } from "../errors";
import { getDb } from "../db";
import { emailAccounts } from "../db/schema/accounts";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { eq } from "drizzle-orm";
import { getDecryptedPassword } from "../services/account.service";
import { loadConfig, saveConfig } from "../config";


/** 发送一封 BCC 邮件。账号从 DB email_accounts 表读取（唯一数据源），密码解密后传给 nodemailer。 */
async function sendBcc(item: SendService.SendItem): Promise<Result<void>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, item.accountId)).get();
  if (!account) return failResult("账号未找到");

  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return failResult("账号密码解密失败: " + passRes.error);

  const port = account.smtpPort || 587;
  const transporter = nodemailer.createTransport({
    host: account.smtpHost || "",
    port,
    secure: port === 465,
    auth: { user: account.email, pass: passRes.data },
    connectionTimeout: 15000, socketTimeout: 15000,
  });

  try {
    const config = loadConfig();
    const displayName = account.displayName || config.fromName || "";
    const emails = item.recipients.map(r => r.email);
    const body = (item.body || "Hello, I hope this email finds you well.\n\nBest regards")
      + (config.signature ? `\n\n${config.signature}` : "");
    await transporter.sendMail({
      from: displayName ? `"${displayName}" <${account.email}>` : account.email,
      bcc: emails,
      subject: item.subject || "Regarding our logistics partnership",
      text: body,
    });
    Log.debug("send.bcc", `${item.companyName}: ${emails.length} 人`);
    return okResult(undefined);
  } catch (err: unknown) {
    return failResult(err instanceof Error ? err.message : "发送失败");
  } finally {
    try { transporter.close(); } catch { /* 已关闭 */ }
  }
}

function createPushFn() {
  return (c: string, d: unknown) => { try { BrowserWindow.getAllWindows()[0]?.webContents.send(c, d); } catch { /* */ } };
}

export function registerSendIPC() {
  SendService.setSendBccFn(sendBcc);
  SendService.setPushFn(createPushFn());
  SendService.setSaveConfigFn((c) => { try { saveConfig(c); } catch { /* */ } });

  ipcMain.handle(IPC.SEND.START, (_e, payload: { keys: string[]; templates?: SendService.SendTemplate[] }) => {
    if (!payload?.keys || payload.keys.length === 0) return failResult("请选择至少一个时间桶");
    return SendService.startSend(payload.keys, payload.templates);
  });
  ipcMain.handle(IPC.SEND.PAUSE, () => SendService.pauseSend());
  ipcMain.handle(IPC.SEND.RESUME, () => SendService.resumeSend());
  ipcMain.handle(IPC.SEND.CANCEL, () => SendService.cancelSend());
  ipcMain.handle(IPC.SEND.STATUS, () => SendService.getSendStatus());
  ipcMain.handle(IPC.SEND.GET_QUEUE, () => SendService.getQueueItems());
  ipcMain.handle(IPC.SEND.RESUME_QUEUE, () => SendService.resumeQueue());
  ipcMain.handle(IPC.SEND.GET_TIME_BUCKETS, () => SendService.getTimeBuckets());
  ipcMain.handle(IPC.SEND.GET_STAGE_BUCKETS, () => SendService.getStageBuckets());
  ipcMain.handle(IPC.SEND.GET_SEND_TIME_BUCKETS, () => SendService.getSendTimeBuckets());
  ipcMain.handle(IPC.SEND.GET_QUOTA, () => ({ success: true as const, data: SendService.getQuotaStatus() }));
  ipcMain.handle(IPC.SEND.PREVIEW, (_e, payload) => {
    // 句库预览：已禁用
    if (typeof payload?.lang === "string") {
      return failResult("预设句库已禁用");
    }
    // 收件人预览：{ keys, templates? } — 无模板时自适应组装
    if (payload?.keys && Array.isArray(payload.keys)) {
      if (payload.keys.length === 0) return failResult("请选择至少一个时间桶");
      if (payload.templates && payload.templates.length > 0) {
        return SendService.buildQueue(payload.keys, payload.templates);
      }
      return SendService.buildAdaptiveQueue(payload.keys);
    }
    // 单模板预览：{ subject, body }
    if (!payload?.subject || !payload?.body) return failResult("模板不完整");
    return SendService.previewTemplate(payload);
  });

  ipcMain.handle(IPC.SEND.TEST, async (_e, input: {
    to: string; accountId: number; subject?: string; body?: string; contactId?: number;
  }) => {
    if (!input?.to) return failResult("收件人必填");
    if (!input?.accountId) return failResult("发件账号必填");

    // 渲染：有 contactId → 用真实联系人数据；否则用虚拟数据
    let name = "Test User";
    let company = "ACME Corp";
    let companyId = 0;
    let firstName = "Test";
    let lastName = "User";
    let contactId = 0;

    if (input.contactId) {
      const c = getDb().select().from(contacts).where(eq(contacts.id, input.contactId)).get();
      if (c) {
        firstName = c.firstName || "Test";
        lastName = c.lastName || "User";
        name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email;
        contactId = c.id;
        if (c.companyId) {
          const comp = getDb().select().from(companies).where(eq(companies.id, c.companyId)).get();
          if (comp) { company = comp.name; companyId = comp.id; }
        }
      }
    }

    const subject = (input.subject || "Test")
      .replace(/\{\{firstName\}\}/g, firstName)
      .replace(/\{\{lastName\}\}/g, lastName)
      .replace(/\{\{company\}\}/g, company)
      .replace(/\{\{email\}\}/g, input.to);
    const body = (input.body || "Test email from Prospector.")
      .replace(/\{\{firstName\}\}/g, firstName)
      .replace(/\{\{lastName\}\}/g, lastName)
      .replace(/\{\{company\}\}/g, company)
      .replace(/\{\{email\}\}/g, input.to);
    return sendBcc({
      id: "crm", companyName: company, companyId,
      recipients: [{ contactId, email: input.to, name }],
      accountId: input.accountId, subject, body, status: "sending",
    });
  });
}
