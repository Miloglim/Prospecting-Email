import { ipcMain, BrowserWindow } from "electron";
import * as nodemailer from "nodemailer";
import { IPC } from "../contract";
import * as SendService from "../services/send.service";
import * as CampaignService from "../services/campaign.service";
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


// ── SMTP 连接池（按账号缓存）─────────────────────────────────────
// 旧实现每发一封都新建连接（TCP+TLS+AUTH 全套握手），大批次整批耗时被握手放大。
// 改为 pooled transporter 按账号复用（maxConnections:1 与全局串行调度匹配）：
// 缓存键含 host/port/密码指纹 → 账号改配置自动重建，不会拿旧凭据硬发；
// 发送成功保留连接，发送失败立即剔除（下次重连新鲜连接，坏连接不会反复失败）。
type PooledTransporter = {
  sendMail: (opts: Record<string, unknown>) => Promise<{ messageId?: string }>;
  close: () => void;
};
const transporterPool = new Map<number, { transporter: PooledTransporter; key: string }>();

function passFingerprint(pass: string): string {
  let h = 5381;
  for (let i = 0; i < pass.length; i++) h = ((h << 5) + h + pass.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function acquireTransporter(account: { id: number; email: string; smtpHost: string | null; smtpPort: number | null }, pass: string): PooledTransporter {
  const port = account.smtpPort || 587;
  const key = `${account.smtpHost}|${port}|${passFingerprint(pass)}`;
  const hit = transporterPool.get(account.id);
  if (hit && hit.key === key) return hit.transporter;
  if (hit) {
    try { hit.transporter.close(); } catch { /* 已断 */ }
    transporterPool.delete(account.id);
    Log.debug("send.pool", `账号 ${account.email} 配置变更，重建连接`);
  }
  const transporter = nodemailer.createTransport({
    host: account.smtpHost || "",
    port,
    secure: port === 465,
    requireTLS: true, // P0-3: 587/25 等端口强制 STARTTLS，拒绝明文发信（465 隐式 TLS 不受影响）
    auth: { user: account.email, pass },
    pool: true, maxConnections: 1, maxMessages: 100,
    connectionTimeout: 15000, socketTimeout: 15000,
  }) as unknown as PooledTransporter;
  transporterPool.set(account.id, { transporter, key });
  return transporter;
}

function evictTransporter(accountId: number, why: string): void {
  const hit = transporterPool.get(accountId);
  if (!hit) return;
  try { hit.transporter.close(); } catch { /* 已断 */ }
  transporterPool.delete(accountId);
  Log.debug("send.pool", `剔除连接（${why}）`);
}

/** 池化连接被服务端闲置掐断的典型报错：不算真失败，换新连接重试一次 */
function idleConnectionError(msg: string): boolean {
  return /idle|connection|socket|ECONNRESET|EPIPE|timed?\s?out/i.test(msg);
}

/** 发送一封 BCC 邮件。账号从 DB email_accounts 表读取（唯一数据源），密码解密后传给 nodemailer。 */
async function sendBcc(item: SendService.SendItem & { body: string }): Promise<Result<{ messageId: string | null }>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, item.accountId)).get();
  if (!account) return failResult("账号未找到");

  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return failResult("账号密码解密失败: " + passRes.error);

  try {
    const config = loadConfig();
    const displayName = account.displayName || config.fromName || "";
    const emails = item.recipients.map(r => r.email);
    const signature = (account.signature || "").trim();
    const body = item.body || "Hello, I hope this email finds you well.\n\nBest regards";

    const from = displayName ? `"${displayName}" <${account.email}>` : account.email;
    const subject = item.subject || "Regarding our logistics partnership";

    // 抄送：收件人仍走 BCC 互不可见，抄送方放 CC（对客户可见，用于同事存档）
    const ccList = (item.cc || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const ccField = ccList.length > 0 ? { cc: ccList } : {};

    let mailOptions: Record<string, unknown>;
    if (isHtml(body) || isHtml(signature)) {
      const bodyHtml = isHtml(body) ? body : escapeHtml(body).replace(/\n/g, "<br>");
      const sigHtml = isHtml(signature) ? signature : escapeHtml(signature).replace(/\n/g, "<br>");
      const { html, attachments } = inlineImagesToCid(bodyHtml + (sigHtml ? `<br><br>${sigHtml}` : ""));
      mailOptions = {
        from, bcc: emails, ...ccField, subject,
        text: stripHtml(body + (signature ? `\n\n${signature}` : "")),
        html,
        attachments,
      };
    } else {
      mailOptions = {
        from, bcc: emails, ...ccField, subject,
        text: body + (signature ? `\n\n${signature}` : ""),
      };
    }

    let info: { messageId?: string } | null = null;
    try {
      info = await acquireTransporter(account, passRes.data).sendMail(mailOptions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      evictTransporter(account.id, msg.slice(0, 60));
      // 池化连接闲置被掐：换新连接原参数重试一次，不计为发送失败（防误触连续失败/熔断）
      if (idleConnectionError(msg)) {
        Log.debug("send.pool", `闲置连接断开，重连重试：${msg.slice(0, 60)}`);
        info = await acquireTransporter(account, passRes.data).sendMail(mailOptions);
      } else {
        return failResult(msg);
      }
    }
    Log.debug("send.bcc", `${item.companyName}: ${emails.length} 人`);
    return okResult({ messageId: info?.messageId || null });
  } catch (err: unknown) {
    return failResult(err instanceof Error ? err.message : "发送失败");
  }
}

function createPushFn() {
  return (c: string, d: unknown) => { try { BrowserWindow.getAllWindows()[0]?.webContents.send(c, d); } catch { /* */ } };
}

export function registerSendIPC() {
  SendService.setSendBccFn(sendBcc);
  SendService.setPushFn(createPushFn());
  SendService.setSaveConfigFn((c) => { try { saveConfig(c); } catch { /* */ } });

  ipcMain.handle(IPC.SEND.START, (_e, payload: { keys: string[]; templates?: SendService.SendTemplate[]; autoStart?: boolean; contactIds?: number[] }) => {
    const hasTargets = (payload?.keys && payload.keys.length > 0) || (payload?.contactIds && payload.contactIds.length > 0);
    if (!hasTargets) return failResult("请选择发送对象");
    // autoStart 缺省为 true 保持旧行为；前端传 false = 只入队，等队列页手动开始。contactIds 直选（新选人表格）优先于分桶 keys
    return SendService.startSend(payload.keys || [], payload.templates, payload.autoStart !== false, payload.contactIds);
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

  ipcMain.handle(IPC.SEND.DYNAMIC, async (_e, input: { contactIds: number[]; subject: string; body: string; autoStart?: boolean; cc?: string }) => {
    if (!input?.contactIds || !Array.isArray(input.contactIds) || input.contactIds.length === 0) return failResult("请选择联系人");
    if (!input?.subject?.trim()) return failResult("主题必填");
    if (!input?.body?.trim()) return failResult("正文必填");
    const cc = (input.cc || "").trim();
    // 邮箱格式校验 — 地址写错会导致整批 SMTP 拒收
    if (cc) {
      const bad = cc.split(/[,;]/).map(s => s.trim()).filter(Boolean)
        .filter(e => !SendService.isValidEmail(e));
      if (bad.length > 0) return failResult(`抄送邮箱格式错误: ${bad.join(", ")}`);
    }
    return SendService.startDynamicSend(input.contactIds, input.subject, input.body, input.autoStart !== false, cc || undefined);
  });

  // ── 发信任务（Campaign，docs/smart-send-spec.md）────────────────
  ipcMain.handle(IPC.SEND.CAMPAIGNS, () => CampaignService.getCampaignOverview());
  ipcMain.handle(IPC.SEND.CAMPAIGN_DETAIL, (_e, id: string) => {
    if (!id?.trim()) return failResult("缺少任务 id");
    return CampaignService.getCampaignDetail(id.trim());
  });
  ipcMain.handle(IPC.SEND.CAMPAIGN_CONTROL, (_e, input: { campaignId?: string; action?: string }) => {
    const action = (input?.action ?? "").trim().toLowerCase();
    if (!["pause", "resume", "stop"].includes(action)) return failResult("action 仅支持 pause/resume/stop");
    if (!input?.campaignId?.trim()) return failResult("缺少任务 id");
    const status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
    return CampaignService.setCampaignStatus(input.campaignId.trim(), status);
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
