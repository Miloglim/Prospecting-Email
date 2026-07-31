import { ipcMain } from "electron";
import { IPC } from "../contract";
import { Log } from "../logger";
import { failResult, okResult } from "../errors";

// ponytail: send 和 inbox 需要 SMTP/IMAP 库，先留桩，后续集成 send.service.ts

export function registerSendIPC() {
  ipcMain.handle(IPC.SEND.STATUS, () => {
    Log.debug("ipc.send.status", "");
    return okResult({ queueLength: 0, sentToday: 0, isPaused: false, currentBatch: null });
  });

  ipcMain.handle(IPC.SEND.START, (_e, _config) => {
    return failResult("发送引擎尚未集成");
  });

  ipcMain.handle(IPC.SEND.PAUSE, () => okResult(undefined));
  ipcMain.handle(IPC.SEND.RESUME, () => okResult(undefined));
  ipcMain.handle(IPC.SEND.RETRY_FAILED, (_e, _batchId: string) => failResult("尚未集成"));
  ipcMain.handle(IPC.SEND.TEST, (_e, _input) => failResult("尚未集成"));
}
