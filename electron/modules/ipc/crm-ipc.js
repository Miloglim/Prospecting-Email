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
      // AI 分析函数 — DeepSeek
      const aiFn = (data) => {
        try {
          const cfgPath = path.join(require("../config").APP_ROOT, "send", "config.json");
          if (!fs.existsSync(cfgPath)) return "";
          const apiKey = JSON.parse(fs.readFileSync(cfgPath, "utf-8")).apiKeys?.deepseek;
          if (!apiKey) return "";
          const prompt = `你是货代CRM分析师。用简洁中文分析今日数据，3段：
1. 整体表现 2. 回复质量 3. 优化建议（短期/中期/系统）
数据：发出${data.sentToday}封失败${data.failedToday}封，回复${data.replies}封退信${data.bounces}封，回复率${data.replyRate}%。管线触达中${data.stageCounts?.reaching||0}报价中${data.stageCounts?.quoting||0}试单${data.stageCounts?.trial||0}合作中${data.stageCounts?.cooperating||0}。${data.dueCount||0}人待跟进${data.overdueCount||0}人逾期。`;
          const body = JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 500 });
          return new Promise((resolve) => {
            const https = require("https");
            const req = https.request({ hostname: "api.deepseek.com", path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }, timeout: 15000 }, (res) => {
              let d = ""; res.on("data", c => d += c); res.on("end", () => {
                try { resolve(JSON.parse(d)?.choices?.[0]?.message?.content?.split("\n").filter(Boolean).map(p => `<p>${p}</p>`).join("") || ""); }
                catch { resolve(""); }
              });
            });
            req.on("error", () => resolve(""));
            req.on("timeout", () => { req.destroy(); resolve(""); });
            req.end(body);
          });
        } catch { return ""; }
      };
      const reportService = require("../services/report-service");
      const result = await reportService.generate(aiFn);
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
