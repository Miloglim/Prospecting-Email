import { ipcMain, app, dialog, BrowserWindow, shell } from "electron";
import * as path from "path";
import { IPC } from "../contract";
import { loadConfig, saveConfig, DEFAULT_SCHEDULE, DB_PATH } from "../config";
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

  // 开机自启（新手向导 step3 用）；同时持久化到 config.general.autoLaunch 供 UI 回显
  ipcMain.handle(IPC.SYSTEM.SET_AUTO_LAUNCH, (_e, enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      const current = loadConfig();
      saveConfig({ ...current, general: { ...(current.general || {}), autoLaunch: !!enabled } });
      Log.info("system.autoLaunch", enabled ? "已开启开机自启" : "已关闭开机自启");
      return okResult(undefined);
    } catch (err) {
      return failResult(`设置失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipcMain.handle(IPC.SYSTEM.UPDATE_CONFIG, (_e, partial) => {
    const current = loadConfig();
    // schedule / sentenceSubjects 深度合并，避免前端只传部分字段时覆盖丢失
    const merged = {
      ...current,
      ...partial,
      schedule: { ...DEFAULT_SCHEDULE, ...(current.schedule || {}), ...(partial?.schedule || {}) },
      sentenceSubjects: { ...(current.sentenceSubjects || {}), ...(partial?.sentenceSubjects || {}) },
    };
    saveConfig(merged);
    return okResult(undefined);
  });

  ipcMain.handle(IPC.SYSTEM.APP_VERSION, () => okResult(app.getVersion()));

  ipcMain.handle(IPC.SYSTEM.OPEN_PATH, async (_e, type: string) => {
    try {
      const dataDir = path.dirname(DB_PATH);
      if (type === "data") {
        await shell.openPath(dataDir);
        return okResult(undefined);
      }
      if (type === "archive") {
        const archive = path.join(dataDir, "inbox-archive.jsonl");
        shell.showItemInFolder(archive);
        return okResult(undefined);
      }
      return failResult("参数错误: 未知的路径类型");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Log.error("ipc.system.openPath", msg, err instanceof Error ? err.stack : undefined);
      return failResult(msg);
    }
  });

}
