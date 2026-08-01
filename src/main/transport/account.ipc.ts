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
    if (!input?.email || !input?.password || !input?.smtpHost) {
      return failResult("参数错误: email、password、smtpHost 必填");
    }
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

  ipcMain.handle(IPC.ACCOUNTS.CIRCUIT_STATUS, async (_e, id: number) => {
    Log.debug("ipc.accounts.circuitStatus", `id=${id}`);
    const result = await AccountService.listAccounts();
    if (!result.success) return result;
    // eslint-disable-next-line prefer-const
    let account: { consecutiveFails: number; circuitOpenAt: string | null } | undefined;
    for (const a of result.data) {
      if (a.id === id) { account = a; break; }
    }
    if (!account) return failResult("账号不存在");
    return { success: true as const, data: {
      consecutiveFails: account.consecutiveFails,
      isOpen: !!account.circuitOpenAt,
    }};
  });
}
