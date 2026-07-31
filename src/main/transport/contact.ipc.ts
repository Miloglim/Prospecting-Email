import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/contact.service";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerContactIPC() {
  ipcMain.handle(IPC.CONTACTS.GET_BY_ID, async (_e, id: number) => {
    Log.debug("ipc.contact.getById", `id=${id}`);
    if (id == null || typeof id !== "number") return failResult("参数错误: id 必须是数字");
    return svc.getContactById(id);
  });

  ipcMain.handle(IPC.CONTACTS.LIST, async (_e, params) => {
    Log.debug("ipc.contact.list", JSON.stringify(params));
    return svc.listContacts(params || {});
  });

  ipcMain.handle(IPC.CONTACTS.UPSERT, async (_e, input) => {
    Log.debug("ipc.contact.upsert", `email=${input?.email}`);
    if (!input?.email) return failResult("参数错误: email 必填");
    return svc.upsertContact(input);
  });

  ipcMain.handle(IPC.CONTACTS.DELETE, async (_e, id: number) => {
    Log.debug("ipc.contact.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return svc.deleteContact(id);
  });

  ipcMain.handle(IPC.CONTACTS.COUNT, async (_e, _params?) => {
    Log.debug("ipc.contact.count", "");
    const result = await svc.listContacts({ page: 1, pageSize: 1 });
    if (!result.success) return result;
    return { success: true as const, data: result.data.total };
  });
}
