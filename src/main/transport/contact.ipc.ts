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

  ipcMain.handle(IPC.CONTACTS.LIST_FOR_MATCH, async () => {
    return svc.listContactsForMatch();
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

  // 跨页"选择全部匹配项"：返回当前 search/筛选下的全部联系人 id（不分页）
  ipcMain.handle(IPC.CONTACTS.LIST_IDS, async (_e, params?) => {
    Log.debug("ipc.contact.listIds", JSON.stringify(params));
    return svc.listContactIds(params || {});
  });

  // 批量删除：一次级联 + 一次落盘（替代前端循环调 DELETE 的 N 次落盘）
  ipcMain.handle(IPC.CONTACTS.DELETE_BATCH, async (_e, ids: number[]) => {
    Log.debug("ipc.contact.deleteBatch", `${Array.isArray(ids) ? ids.length : 0} 个`);
    if (!Array.isArray(ids) || ids.length === 0) return failResult("参数错误: ids 不能为空");
    return svc.deleteContactsBatch(ids);
  });

  ipcMain.handle(IPC.CONTACTS.COUNT, async (_e, _params?) => {
    Log.debug("ipc.contact.count", "");
    const result = await svc.listContacts({ page: 1, pageSize: 1 });
    if (!result.success) return result;
    return { success: true as const, data: result.data.total };
  });

  ipcMain.handle(IPC.CONTACTS.INTERACTIONS, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return svc.getContactInteractions(id);
  });

  // 解析 data（P0-4: 不再接受渲染端 filePath —— 主进程按任意路径读文件等于渲染端可读全盘；
  // 前端一律经 File API 读内容后传 data，路径只能由用户的文件选择动作产生）
  function resolveData(p: { type?: string; data?: string }) {
    const { type, data } = p;
    if (type !== "csv" && type !== "xlsx" && type !== "tsv") return { type: undefined, data: undefined };
    return { type, data };
  }

  ipcMain.handle(IPC.CONTACTS.IMPORT, async (_e, params) => {
    Log.debug("ipc.contact.import", `mode=${params?.mode}, data=${!!params?.data}`);
    if (!params?.mode || !["preview", "execute"].includes(params.mode))
      return failResult("参数错误: mode 必填 (preview | execute)");
    const resolved = resolveData(params);
    if (!resolved.type || !resolved.data) return failResult("参数错误: type 和 data 必填");
    const type = resolved.type as "csv" | "xlsx" | "tsv";
    if (params.mode === "preview") {
      return svc.importContacts({ mode: "preview", type, data: resolved.data });
    }
    if (!params.mapping) return failResult("参数错误: mapping 必填");
    return svc.importContacts({ mode: "execute", type, data: resolved.data, mapping: params.mapping });
  });
}
