// ── Prospector — CRM IPC 路由转发 ──────────────────────────────────────────
"use strict";

const crmService = require("../services/crm-service");
const { IPC } = require("../core/contract");

/**
 * 注册 CRM 相关 IPC handler
 * @param {import("electron").IpcMain} ipcMain
 * @param {object} deps
 */
function register(ipcMain, deps) {
  ipcMain.handle(IPC.CRM.LIST_PIPELINE, async (_e, filters) => {
    try {
      const result = crmService.listPipeline(filters || {});
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.CRM.SET_STAGE, async (_e, contactId, newStage) => {
    try {
      if (!contactId || !newStage) return { ok: false, error: "参数缺失" };
      const result = crmService.setStage(contactId, newStage);
      if (!result.ok) return { ok: false, error: result.error };
      // 广播变更事件
      deps.mainWindow?.webContents.send(IPC.CRM.CHANGED, { contactId, tags: result.data.tags });
      return { ok: true, data: result.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.CRM.UPDATE_EXTRA, async (_e, contactId, patch) => {
    try {
      if (!contactId || !patch) return { ok: false, error: "参数缺失" };
      const result = crmService.updateExtra(contactId, patch);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: result.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.CRM.GET_DETAIL, async (_e, contactId) => {
    try {
      if (!contactId) return { ok: false, error: "参数缺失" };
      const result = crmService.getDetail(contactId);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: result.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.CRM.SAVE_NOTE, async (_e, contactId, content) => {
    try {
      if (!contactId || !content) return { ok: false, error: "参数缺失" };
      const result = crmService.saveNote(contactId, content);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, data: result.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.CRM.CHECK_REMINDERS, async () => {
    try {
      const result = crmService.checkReminders();
      return { ok: true, data: result.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
