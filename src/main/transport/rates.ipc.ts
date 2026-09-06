import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as Rates from "../services/rate-sync.service";

export function registerRatesIPC() {
  // 从远程运价库（公司电脑 board_server）刷新本地镜像（全量刷新，幂等；失败保留旧数据并给友好提示）
  ipcMain.handle(IPC.RATES.SYNC, () => Rates.sync());

  // 条件查价
  ipcMain.handle(IPC.RATES.LIST, (_e, filters: Rates.QuoteFilters) => Rates.listQuotes(filters || {}));

  // 镜像统计
  ipcMain.handle(IPC.RATES.STATUS, () => Rates.status());

  // 启动定时同步：5 秒后首拉 + 每 10 分钟轮询（失败只记日志，不打扰用户）
  Rates.startAutoSync();
}
