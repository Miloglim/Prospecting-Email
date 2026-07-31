import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/crm.service";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerCrmIPC() {
  ipcMain.handle(IPC.CRM.LIST_PIPELINE, async () => {
    Log.debug("ipc.crm.listPipeline", "");
    return svc.listPipeline();
  });

  ipcMain.handle(IPC.CRM.SET_STAGE, async (_e, params: { contactId: number; stage: string }) => {
    Log.debug("ipc.crm.setStage", `id=${params?.contactId} stage=${params?.stage}`);
    if (!params?.contactId || !params?.stage) return failResult("参数错误: contactId 和 stage 必填");
    return svc.setStage(params.contactId, params.stage);
  });

  ipcMain.handle(IPC.CRM.ADD_REMINDER, async (_e, params) => {
    Log.debug("ipc.crm.addReminder", `id=${params?.contactId}`);
    return svc.addReminder(params?.contactId, params?.reminderAt, params?.reminderNote);
  });

  ipcMain.handle(IPC.CRM.LIST_RELATIONS, async (_e, contactId: number) => {
    Log.debug("ipc.crm.listRelations", `id=${contactId}`);
    return svc.listRelations(contactId);
  });
}
