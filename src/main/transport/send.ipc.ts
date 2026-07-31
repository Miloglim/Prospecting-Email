import { ipcMain, BrowserWindow } from "electron";
import * as nodemailer from "nodemailer";
import { IPC } from "../contract";
import * as SendService from "../services/send.service";
import { Log } from "../logger";
import { failResult, okResult, type Result } from "../errors";

// ── SMTP 发送器 ──

function createMailSender(item: SendService.QueueItem): Promise<Result<void>> {
  return new Promise(async (resolve) => {
    try {
      // ponytail: 从 config 读 SMTP 配置
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadConfig } = require("../config");
      const config = loadConfig();
      const account = config.smtpAccounts.find((a: { id: number }) => a.id === item.accountId);

      if (!account) {
        resolve(failResult(`账号未找到: id=${item.accountId}`));
        return;
      }

      const transporter = nodemailer.createTransport({
        host: account.host,
        port: account.port,
        secure: account.port === 465,
        auth: {
          user: account.email,
          pass: account.encryptedPass,
        },
        connectionTimeout: 15_000,
        socketTimeout: 15_000,
      });

      await transporter.sendMail({
        from: account.email,
        to: item.contactEmail,
        subject: item.subject,
        text: item.body,
      });

      transporter.close();
      resolve(okResult(undefined));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Log.error("send.mail", `${item.contactEmail} 发送失败`, err instanceof Error ? err.stack : msg);
      resolve(failResult(msg));
    }
  });
}

// ── 进度推送 ──

function createPushFn() {
  return (channel: string, data: unknown) => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // 静默降级：窗口可能已关闭
    }
  };
}

// ── IPC 注册 ──

export function registerSendIPC() {
  // 注入外部依赖（ponytail: 不 import BrowserWindow 到 service）
  SendService.setSendMailFn(createMailSender);
  SendService.setPushFn(createPushFn());

  ipcMain.handle(IPC.SEND.START, async (_e, config: SendService.SendConfig) => {
    Log.debug("ipc.send.start", JSON.stringify(config));
    return SendService.startSend(config || {});
  });

  ipcMain.handle(IPC.SEND.PAUSE, () => {
    Log.debug("ipc.send.pause", "");
    return SendService.pauseSend();
  });

  ipcMain.handle(IPC.SEND.RESUME, () => {
    Log.debug("ipc.send.resume", "");
    return SendService.resumeSend();
  });

  ipcMain.handle(IPC.SEND.STATUS, () => {
    return SendService.getSendStatus();
  });

  ipcMain.handle(IPC.SEND.RETRY_FAILED, (_e, _batchId: string) => {
    return failResult("重试功能尚未实现");
  });

  ipcMain.handle(IPC.SEND.TEST, async (_e, input: { to: string; subject: string; body: string; accountId: number }) => {
    Log.debug("ipc.send.test", `to=${input?.to}`);
    if (!input?.to) return failResult("收件人必填");

    try {
      const result = await createMailSender({
        id: "test",
        contactEmail: input.to,
        contactId: 0,
        contactName: "Test",
        subject: input.subject || "Test Email",
        body: input.body || "This is a test email from Prospector.",
        accountId: input.accountId,
        status: "sending",
      });
      return result;
    } catch (err: unknown) {
      return failResult(err instanceof Error ? err.message : "发送失败");
    }
  });
}
