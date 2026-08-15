import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as AccountService from "../services/account.service";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerAccountIPC() {
  ipcMain.handle(IPC.ACCOUNTS.LIST, () => {
    Log.debug("ipc.accounts.list", "");
    return AccountService.listAccounts();
  });

  ipcMain.handle(IPC.ACCOUNTS.UPSERT, async (_e, input) => {
    Log.debug("ipc.accounts.upsert", `email=${input?.email}`);
    if (!input?.email || !input?.smtpHost) {
      return failResult("参数错误: email、smtpHost 必填");
    }
    // ponytail: 编辑时可不传密码，service 层做最终校验
    return AccountService.upsertAccount(input);
  });

  ipcMain.handle(IPC.ACCOUNTS.DELETE, async (_e, id: number) => {
    Log.debug("ipc.accounts.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return AccountService.deleteAccount(id);
  });

  ipcMain.handle(IPC.ACCOUNTS.VALIDATE, async (_e, id: number) => {
    Log.debug("ipc.accounts.validate", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return AccountService.validateAccount(id);
  });
}
