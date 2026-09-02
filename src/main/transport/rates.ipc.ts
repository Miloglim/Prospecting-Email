import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as Rates from "../services/rate-sync.service";

export function registerRatesIPC() {
  // 从快照文件刷新本地运价镜像（全量刷新，幂等）
  ipcMain.handle(IPC.RATES.SYNC, () => Rates.sync());

  // 条件查价
  ipcMain.handle(IPC.RATES.LIST, (_e, filters: Rates.QuoteFilters) => Rates.listQuotes(filters || {}));

  // 镜像统计
  ipcMain.handle(IPC.RATES.STATUS, () => Rates.status());
}
