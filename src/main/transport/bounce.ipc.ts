import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as BounceService from "../services/bounce.service";

export function registerBounceIPC() {
  ipcMain.handle(IPC.BOUNCE.LIST, (_e, filters?: BounceService.BounceFilters) =>
    BounceService.listBounces(filters));
}
