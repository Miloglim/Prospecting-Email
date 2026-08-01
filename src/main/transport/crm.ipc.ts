import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as CrmService from "../services/crm.service";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerCrmIPC() {
  ipcMain.handle(IPC.CRM.LIST_PIPELINE, async () => CrmService.listPipeline());

  ipcMain.handle(IPC.CRM.SET_STAGE, async (_e, params: { contactId: number; stage: string }) => {
    if (!params?.contactId || !params?.stage) return failResult("contactId 和 stage 必填");
    return CrmService.setStage(params.contactId, params.stage);
  });

  ipcMain.handle(IPC.CRM.ADD_REMINDER, async (_e, params: { contactId: number; reminderAt: string; note?: string }) => {
    if (!params?.contactId || !params?.reminderAt) return failResult("contactId 和 reminderAt 必填");
    return CrmService.addReminder(params.contactId, params.reminderAt, params.note);
  });

  ipcMain.handle(IPC.CRM.GET_DETAIL, async (_e, contactId: number) => {
    if (!contactId) return failResult("contactId 必填");
    return CrmService.getDetail(contactId);
  });

  ipcMain.handle(IPC.CRM.CHECK_REMINDERS, () => CrmService.checkReminders());

  ipcMain.handle(IPC.CRM.LIST_RELATIONS, async (_e, contactId: number) => {
    if (!contactId) return failResult("contactId 必填");
    return CrmService.listRelations(contactId);
  });
}
