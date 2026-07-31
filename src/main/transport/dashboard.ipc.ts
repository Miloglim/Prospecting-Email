import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/dashboard.service";
import { Log } from "../logger";

export function registerDashboardIPC() {
  ipcMain.handle(IPC.DASHBOARD.STATS, () => {
    Log.debug("ipc.dashboard.stats", "");
    return svc.getStats();
  });
}
