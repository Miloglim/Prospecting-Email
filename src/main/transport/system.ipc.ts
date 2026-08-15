import { ipcMain, app, dialog, BrowserWindow } from "electron";
import { IPC } from "../contract";
import { loadConfig, saveConfig, DEFAULT_SCHEDULE } from "../config";
import { Log } from "../logger";
import { okResult, failResult } from "../errors";

export function registerSystemIPC() {
  ipcMain.handle(IPC.SYSTEM.SELECT_DIRECTORY, async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const r = win
      ? await dialog.showOpenDialog(win, { title: "选择旧版 Prospecting Email 目录", properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ title: "选择旧版 Prospecting Email 目录", properties: ["openDirectory"] });
    if (r.canceled || r.filePaths.length === 0) return failResult("已取消");
    return okResult(r.filePaths[0]);
  });
  ipcMain.handle(IPC.SYSTEM.GET_CONFIG, () => {
    try {
      return okResult(loadConfig());
    } catch (err) {
      return okResult(loadConfig());
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
