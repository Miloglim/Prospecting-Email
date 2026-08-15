import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as MigrateService from "../services/migrate.service";
import { failResult } from "../errors";
import { Log } from "../logger";

export function registerMigrateIPC() {
  ipcMain.handle(IPC.MIGRATE.DETECT, async () => {
    Log.debug("migrate.detect", "");
    return MigrateService.detectLegacyDirs();
  });

  ipcMain.handle(IPC.MIGRATE.PREVIEW, async (_e, dir?: string) => {
    Log.debug("migrate.preview", dir || "");
    if (!dir) return failResult("请选择旧 PE 目录");
    return MigrateService.previewMigration(dir);
  });

  ipcMain.handle(IPC.MIGRATE.RUN, async (_e, dir?: string) => {
    Log.debug("migrate.run", dir || "");
    if (!dir) return failResult("请选择旧 PE 目录");
    return MigrateService.runMigration(dir);
  });
}
