import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/contact.service";
import { Log } from "../logger";
import { failResult } from "../errors";
import { readFileSync } from "fs";

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

  // 解析 data：优先 filePath（直接读文件→快），fallback data（粘贴/小文件）
  function resolveData(p: { type?: string; data?: string; filePath?: string }) {
    let { type, data } = p;
    if (p.filePath && !data) {
      const buf = readFileSync(p.filePath);
      type = type || (p.filePath.endsWith(".csv") ? "csv" : "xlsx");
      data = type === "csv" ? buf.toString("utf8") : buf.toString("base64");
    }
    if (type !== "csv" && type !== "xlsx" && type !== "tsv") return { type: undefined, data: undefined };
    return { type, data };
  }

  ipcMain.handle(IPC.CONTACTS.IMPORT, async (_e, params) => {
    Log.debug("ipc.contact.import", `mode=${params?.mode}, filePath=${!!params?.filePath}, data=${!!params?.data}`);
    if (!params?.mode || !["preview", "execute"].includes(params.mode))
      return failResult("参数错误: mode 必填 (preview | execute)");
    const resolved = resolveData(params);
    if (!resolved.type || !resolved.data) return failResult("参数错误: type 和 data 必填（或提供 filePath）");
    const type = resolved.type as "csv" | "xlsx" | "tsv";
    if (params.mode === "preview") {
      return svc.importContacts({ mode: "preview", type, data: resolved.data });
    }
    if (!params.mapping) return failResult("参数错误: mapping 必填");
    return svc.importContacts({ mode: "execute", type, data: resolved.data, mapping: params.mapping });
  });
}
