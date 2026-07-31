import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/export.service";
import { Log } from "../logger";

export function registerExportIPC() {
  ipcMain.handle(IPC.EXPORT.CONTACTS_TO_EXCEL, async (_e, filter?: { search?: string }) => {
    Log.debug("ipc.export.contactsToExcel", "");
    return svc.exportContactsToExcel(filter);
  });
}
