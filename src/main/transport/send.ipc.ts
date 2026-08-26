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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
const isHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s);

/** 把 HTML 里的 base64 内联图片转成 cid 附件（主流邮件客户端会过滤 base64 内联图，cid 附件才可靠） */
function inlineImagesToCid(html: string): { html: string; attachments: Array<{ filename: string; content: Buffer; cid: string }> } {
  const attachments: Array<{ filename: string; content: Buffer; cid: string }> = [];
  let idx = 0;
  const newHtml = html.replace(/<img\b[^>]*\bsrc="(data:image\/[^"]+)"/gi, (match, dataUrl: string) => {
    const m = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m || !m[1] || !m[2]) return match;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const cid = `img${idx}@prospector`;
    attachments.push({ filename: `img${idx}.${ext}`, content: Buffer.from(m[2], "base64"), cid });
    idx++;
    return match.replace(dataUrl, `cid:${cid}`);
  });
  return { html: newHtml, attachments };
}


/** 发送一封 BCC 邮件。账号从 DB email_accounts 表读取（唯一数据源），密码解密后传给 nodemailer。 */
async function sendBcc(item: SendService.SendItem & { body: string }): Promise<Result<{ messageId: string | null }>> {
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
    const signature = (account.signature || config.signature || "").trim();
    const body = item.body || "Hello, I hope this email finds you well.\n\nBest regards";

    const from = displayName ? `"${displayName}" <${account.email}>` : account.email;
    const subject = item.subject || "Regarding our logistics partnership";

    let info: { messageId?: string } | null = null;
    if (isHtml(body) || isHtml(signature)) {
      const bodyHtml = isHtml(body) ? body : escapeHtml(body).replace(/\n/g, "<br>");
      const sigHtml = isHtml(signature) ? signature : escapeHtml(signature).replace(/\n/g, "<br>");
      const { html, attachments } = inlineImagesToCid(bodyHtml + (sigHtml ? `<br><br>${sigHtml}` : ""));
      info = await transporter.sendMail({
        from, bcc: emails, subject,
        text: stripHtml(body + (signature ? `\n\n${signature}` : "")),
        html,
        attachments,
      });
    } else {
      info = await transporter.sendMail({
        from, bcc: emails, subject,
        text: body + (signature ? `\n\n${signature}` : ""),
      });
    }
    Log.debug("send.bcc", `${item.companyName}: ${emails.length} 人`);
    return okResult({ messageId: info?.messageId || null });
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

  ipcMain.handle(IPC.SEND.START, (_e, payload: { keys: string[]; templates?: SendService.SendTemplate[]; autoStart?: boolean }) => {
    if (!payload?.keys || payload.keys.length === 0) return failResult("请选择至少一个时间桶");
    // autoStart 缺省为 true 保持旧行为；前端传 false = 只入队，等队列页手动开始
    return SendService.startSend(payload.keys, payload.templates, payload.autoStart !== false);
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
    // 句库预览：{ lang, clientType, stage }
    if (typeof payload?.lang === "string") {
      return SendService.previewSentence(payload.lang, payload.clientType, payload.stage);
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

  ipcMain.handle(IPC.SEND.DYNAMIC, async (_e, input: { contactIds: number[]; subject: string; body: string; autoStart?: boolean }) => {
    if (!input?.contactIds || !Array.isArray(input.contactIds) || input.contactIds.length === 0) return failResult("请选择联系人");
    if (!input?.subject?.trim()) return failResult("主题必填");
    if (!input?.body?.trim()) return failResult("正文必填");
    return SendService.startDynamicSend(input.contactIds, input.subject, input.body, input.autoStart !== false);
  });

  ipcMain.handle(IPC.SEND.TEST, async (_e, input: {
    to: string; accountId: number; subject?: string; body?: string; contactId?: number;
  }) => {
    if (!input?.to) return failResult("收件人必填");
    if (!input?.accountId) return failResult("发件账号必填");

    // 发信阻隔：带 contactId = CRM 快速发信，收件人是真实客户，必须挡。
    // 设置页的「测试发信」不传 contactId，仍可发出去验证 SMTP 配置。
    if (input.contactId && loadConfig().test.dryRun) {
      Log.info("send.dryRun", `CRM 快速发信 → ${input.to}：测试模式，跳过真实发送`);
      return okResult({ messageId: null });
    }

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
      tplBody: "", contactVars: { email: input.to },
    });
  });
}
