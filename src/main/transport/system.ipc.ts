import { ipcMain, app } from "electron";
import { IPC } from "../contract";
import { loadConfig, saveConfig, DEFAULT_SCHEDULE } from "../config";
import { Log } from "../logger";
import { okResult } from "../errors";

export function registerSystemIPC() {
  ipcMain.handle(IPC.SYSTEM.GET_CONFIG, () => {
    try {
      return okResult(loadConfig());
    } catch (err) {
      return okResult({ smtpAccounts: [], schedule: DEFAULT_SCHEDULE });
    }
  });

  ipcMain.handle(IPC.SYSTEM.UPDATE_CONFIG, (_e, partial) => {
    const current = loadConfig();
    // schedule 深度合并，避免前端只传部分字段时覆盖丢失
    const merged = {
      ...current,
      ...partial,
      schedule: { ...DEFAULT_SCHEDULE, ...(current.schedule || {}), ...(partial?.schedule || {}) },
    };
    saveConfig(merged);
    return okResult(undefined);
  });

  ipcMain.handle(IPC.SYSTEM.APP_VERSION, () => okResult(app.getVersion()));

}
