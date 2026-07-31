import { ipcMain } from "electron";
import { IPC } from "../contract";
import { Log } from "../logger";
import { okResult, failResult } from "../errors";

export function registerAccountIPC() {
  ipcMain.handle(IPC.ACCOUNTS.LIST, () => {
    Log.debug("ipc.accounts.list", "");
    return okResult([]);
  });

  ipcMain.handle(IPC.ACCOUNTS.VALIDATE, (_e, _id: number) => {
    return failResult("账号验证尚未集成");
  });

  ipcMain.handle(IPC.ACCOUNTS.CIRCUIT_STATUS, (_e, _id: number) => {
    return okResult({ consecutiveFails: 0, isOpen: false });
  });

  ipcMain.handle(IPC.ACCOUNTS.UPSERT, (_e, _input) => {
    return failResult("账号管理尚未集成");
  });

  ipcMain.handle(IPC.ACCOUNTS.DELETE, (_e, _id: number) => {
    return failResult("账号管理尚未集成");
  });
}
