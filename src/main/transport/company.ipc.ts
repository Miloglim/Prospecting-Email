import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/company.service";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerCompanyIPC() {
  ipcMain.handle(IPC.COMPANIES.GET_BY_ID, async (_e, id: number) => {
    Log.debug("ipc.company.getById", `id=${id}`);
    if (id == null || typeof id !== "number") return failResult("参数错误: id 必须是数字");
    return svc.getCompanyById(id);
  });

  ipcMain.handle(IPC.COMPANIES.LIST, async (_e, search?: string, page?: number, pageSize?: number) => {
    Log.debug("ipc.company.list", `search=${search}`);
    return svc.listCompaniesWithCounts(search, page, pageSize);
  });

  ipcMain.handle(IPC.COMPANIES.GET_DETAIL, async (_e, companyId: number) => {
    if (!companyId || typeof companyId !== "number") return failResult("companyId 必填");
    return svc.getCompanyDetail(companyId);
  });

  ipcMain.handle(IPC.COMPANIES.UPSERT, async (_e, input) => {
    Log.debug("ipc.company.upsert", `name=${input?.name}`);
    if (!input?.name) return failResult("参数错误: name 必填");
    return svc.upsertCompany(input);
  });

  ipcMain.handle(IPC.COMPANIES.DELETE, async (_e, id: number) => {
    Log.debug("ipc.company.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return svc.deleteCompany(id);
  });
}
