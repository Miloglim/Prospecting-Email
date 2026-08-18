import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as HistoryService from "../services/history.service";

export function registerHistoryIPC() {
  ipcMain.handle(IPC.HISTORY.LIST, (_e, filters?: HistoryService.HistoryFilters) =>
    HistoryService.listHistory(filters));
  ipcMain.handle(IPC.HISTORY.GET_DATES, () => HistoryService.getSendDates());
  ipcMain.handle(IPC.HISTORY.CLEAR, () => HistoryService.clearHistory());
}
