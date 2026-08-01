import { ipcMain, app } from "electron";
import { IPC } from "../contract";
import { loadConfig, saveConfig } from "../config";
import { Log } from "../logger";
import { okResult } from "../errors";

export function registerSystemIPC() {
  ipcMain.handle(IPC.SYSTEM.GET_CONFIG, () => {
    try {
      return okResult(loadConfig());
    } catch (err) {
      return okResult({
        smtpAccounts: [],
        schedule: { minDelaySeconds: 30, maxPerBatch: 50 },
      });
    }
  });

  ipcMain.handle(IPC.SYSTEM.UPDATE_CONFIG, (_e, partial) => {
    const current = loadConfig();
    const merged = { ...current, ...partial };
    saveConfig(merged);
    return okResult(undefined);
  });

  ipcMain.handle(IPC.SYSTEM.APP_VERSION, () => okResult(app.getVersion()));

}
