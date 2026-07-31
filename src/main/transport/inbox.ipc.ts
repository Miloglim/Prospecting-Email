import { ipcMain } from "electron";
import { IPC } from "../contract";
import { Log } from "../logger";
import { okResult, failResult } from "../errors";

export function registerInboxIPC() {
  ipcMain.handle(IPC.INBOX.FETCH, (_e, _accountId?: number) => {
    Log.debug("ipc.inbox.fetch", "");
    return okResult([]);
  });

  ipcMain.handle(IPC.INBOX.CLASSIFY, (_e, _id: number) => {
    return failResult("收件箱分类尚未集成");
  });
}
