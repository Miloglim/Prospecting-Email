// ── Prospector — CRM + 报告 IPC 路由转发 ──────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const crmService = require("../services/crm-service");
const { IPC } = require("../core/contract");

function register(ipcMain, deps) {

  // ── CRM 管道 ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.CRM.LIST_PIPELINE, async (_e, filters) => {
    try { return { ok: true, data: crmService.listPipeline(filters || {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle(IPC.CRM.SET_STAGE, async (_e, contactId, newStage) => {
    try {
      if (!contactId || !newStage) return { ok: false, error: "参数缺失" };
      const result = crmService.setStage(contactId, newStage);
      if (!result.ok) return { ok: false, error: result.error };
      deps.mainWindow?.webContents.send(IPC.CRM.CHANGED, { contactId, tags: result.data.tags });
      return { ok: true, data: result.data };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle(IPC.CRM.UPDATE_EXTRA, async (_e, contactId, patch) => {
    try {
      if (!contactId || !patch) return { ok: false, error: "参数缺失" };
      const result = crmService.updateExtra(contactId, patch);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle(IPC.CRM.GET_DETAIL, async (_e, contactId) => {
    try {
      if (!contactId) return { ok: false, error: "参数缺失" };
      const result = crmService.getDetail(contactId);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle(IPC.CRM.SAVE_NOTE, async (_e, contactId, content) => {
    try {
      if (!contactId || !content) return { ok: false, error: "参数缺失" };
      const result = crmService.saveNote(contactId, content);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle(IPC.CRM.CHECK_REMINDERS, async () => {
    try { return { ok: true, data: crmService.checkReminders().data }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("crm:getContactEmails", async (_e, contactId) => {
    try {
      const result = crmService.getContactEmails(contactId);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("crm:getEmailBody", async (_e, uid, accountId) => {
    try {
      const result = crmService.getEmailBody(uid, accountId);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 今日报告 ──────────────────────────────────────────────────────────

  ipcMain.handle("report:generate", async () => {
    try {
      const reportService = require("../services/report-service");
      const result = reportService.generate(null);
      reportService.saveToDb(result.data);

      const { BrowserWindow } = require("electron");
      const win = new BrowserWindow({ width: 800, height: 1000, show: false });
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(result.html));
      const { APP_ROOT } = require("../config");
      const today = new Date().toISOString().slice(0, 10);
      const pdfPath = path.join(APP_ROOT, "send", "reports", `今日报告-${today}.pdf`);
      const dir = path.dirname(pdfPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const pdfData = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      fs.writeFileSync(pdfPath, pdfData);
      win.close();
      return { ok: true, data: { path: pdfPath } };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle("report:exportPdf", async (_e, html) => {
    try {
      const { BrowserWindow } = require("electron");
      const win = new BrowserWindow({ width: 800, height: 1000, show: false });
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      const { APP_ROOT } = require("../config");
      const today = new Date().toISOString().slice(0, 10);
      const pdfPath = path.join(APP_ROOT, "send", "reports", `今日报告-${today}.pdf`);
      const dir = path.dirname(pdfPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      fs.writeFileSync(pdfPath, data);
      win.close();
      return { ok: true, data: { path: pdfPath } };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { register };
