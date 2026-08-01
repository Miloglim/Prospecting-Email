import { ipcMain, BrowserWindow } from "electron";
import * as nodemailer from "nodemailer";
import { IPC } from "../contract";
import * as SendService from "../services/send.service";
import { Log } from "../logger";
import { failResult, okResult, type Result } from "../errors";
import { loadConfig } from "../config";

async function sendBcc(item: SendService.SendItem): Promise<Result<void>> {
  try {
    const config = loadConfig();
    const account = config.smtpAccounts.find((a: { id: number }) => a.id === item.accountId);
    if (!account) return failResult("账号未找到");

    const transporter = nodemailer.createTransport({
      host: account.host, port: account.port,
      secure: account.port === 465,
      auth: { user: account.email, pass: account.encryptedPass },
      connectionTimeout: 15000, socketTimeout: 15000,
    });

    const emails = item.recipients.map(r => r.email);
    await transporter.sendMail({
      from: account.email, bcc: emails,
      subject: item.subject || "Regarding our logistics partnership",
      text: item.body || "Hello, I hope this email finds you well.\n\nBest regards",
    });
    transporter.close();
    Log.debug("send.bcc", `${item.companyName}: ${emails.length} 人`);
    return okResult(undefined);
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

  ipcMain.handle(IPC.SEND.START, (_e, payload: { keys: string[]; template?: SendService.SendTemplate }) => {
    if (!payload?.keys || payload.keys.length === 0) return failResult("请选择至少一个时间桶");
    return SendService.startSend(payload.keys, payload.template);
  });
  ipcMain.handle(IPC.SEND.PAUSE, () => SendService.pauseSend());
  ipcMain.handle(IPC.SEND.RESUME, () => SendService.resumeSend());
  ipcMain.handle(IPC.SEND.STATUS, () => SendService.getSendStatus());
  ipcMain.handle("send:getTimeBuckets", () => SendService.getTimeBuckets());
  ipcMain.handle("send:preview", (_e, template: SendService.SendTemplate) => {
    if (!template?.subject || !template?.body) return failResult("模板不完整");
    return SendService.previewTemplate(template);
  });

  ipcMain.handle(IPC.SEND.TEST, async (_e, input: { to: string; accountId: number }) => {
    if (!input?.to) return failResult("收件人必填");
    return sendBcc({ id: "test", companyName: "测试", companyId: 0, recipients: [{ contactId: 0, email: input.to, name: "Test" }], accountId: input.accountId, subject: input.to, body: "Test email from Prospector.", status: "sending" });
  });
}
