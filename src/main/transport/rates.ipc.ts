import { ipcMain, shell } from "electron";
import { IPC } from "../contract";
import * as Rates from "../services/rate-sync.service";
import { okResult, failResult } from "../errors";

export function registerRatesIPC() {
  // 从远程运价库（公司电脑 board_server）刷新本地镜像（全量刷新，幂等；失败保留旧数据并给友好提示）
  ipcMain.handle(IPC.RATES.SYNC, () => Rates.sync());

  // 条件查价
  ipcMain.handle(IPC.RATES.LIST, (_e, filters: Rates.QuoteFilters) => Rates.listQuotes(filters || {}));

  // 镜像统计
  ipcMain.handle(IPC.RATES.STATUS, () => Rates.status());

  // 在系统浏览器打开台账工作台（board_server 自带 web 界面；地址跟随 RATES_REMOTE_URL，不硬编码）。
  // 先探测局域网可达：不通就不开浏览器（免得留一个白屏标签），把错误回给界面提示。
  ipcMain.handle(IPC.RATES.OPEN_BOARD, async () => {
    if (!await Rates.probeBoard()) return failResult("连接不上公司电脑的运价服务，请确认两台电脑在同一网络");
    await shell.openExternal(Rates.remoteBase());
    return okResult(undefined);
  });

  // 启动定时同步：5 秒后首拉 + 每 4 小时轮询（失败只记日志，不打扰用户）
  Rates.startAutoSync();
}
