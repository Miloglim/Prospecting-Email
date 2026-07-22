// ── Prospector — CRM + 报告 IPC 路由转发 ──────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const { Log } = require("../core/logger");
const crmService = require("../services/crm-service");
const { IPC } = require("../core/contract");

function register(ipcMain, deps) {

  // 启动时清理旧格式 AI 缓存（没有 ai_brief 列的历史数据）
  try { const n = crmService.clearAllAiCache(); if (n > 0) Log.info("AI", "清理旧缓存 " + n + " 条"); } catch { /* 降级 */ }

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
      if (result.ok) deps.mainWindow?.webContents.send(IPC.CRM.CHANGED, { contactId });
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

  // ── AI 邮件总结 ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.AI.SUMMARIZE_EMAIL, async (_e, { uid, accountId, subject, body, fromName, contactId, preview, retry }) => {
    const trace = []; const addTrace = (s) => { trace.push(s); Log.info("AI邮件总结", s); };
    try {
      addTrace("① uid=" + (uid||'?') + " preview=" + !!preview + " retry=" + !!retry + " cid=" + (contactId||'?'));

      if (!retry) {
        const cached = crmService.getAiSummary(uid, accountId);
        if (cached.ai_summary) {
          const brief = cached.ai_brief || cached.ai_summary || '';
          addTrace("② 缓存命中"); return { ok: true, data: { summary: cached.ai_summary, summaryBrief: brief, suggestion: cached.ai_suggestion, cached: true }, _trace: trace };
        }
        addTrace("② 缓存未命中");
      } else { addTrace("② retry → 跳过缓存"); }

      if (preview) { addTrace("③ preview → 空返回"); return { ok: true, data: { summary: '', suggestion: '', cached: false }, _trace: trace }; }

      const { APP_ROOT } = require("../config");
      const cfgPath = path.join(APP_ROOT, "send", "config.json");
      addTrace("③ cfg=" + cfgPath);
      let apiKey = "", senderName = "";
      try { if (fs.existsSync(cfgPath)) { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); apiKey = cfg?.translate?.deepseek?.apiKey || ""; senderName = cfg?.sender?.name || ""; } } catch (e) { addTrace("③ err:" + e.message); }
      if (!apiKey) { addTrace("④ 无Key"); return { ok: false, error: "请先配置 DeepSeek API Key", _trace: trace }; }
      addTrace("④ Key=..." + apiKey.slice(-4) + " sender=" + (senderName||'?'));

      // ── CRM 上下文 ──
      const stageMap = { reaching: '触达中', quoting: '报价中', trial: '试单', cooperating: '合作中', lost: '已流失' };
      let stageLabel = '', historyText = '', prefsText = '';
      if (contactId) {
        try {
          const detail = crmService.getDetail(contactId);
          if (detail.ok) {
            const c = detail.data.contact;
            stageLabel = stageMap[c.stage] || stageMap[c.opp_stage] || c.stage || '';
            const prefs = c._extra?.crmPreferences || {};
            const parts = [];
            if (c.company) parts.push(c.company);
            if (c.country) parts.push(c.country);
            if (prefs.preferredRoutes) parts.push('航线:' + prefs.preferredRoutes);
            if (prefs.cargoTypes?.length) parts.push('货:' + prefs.cargoTypes.join('/'));
            prefsText = parts.join(' | ');
          }
        } catch { /* 降级 */ }
        try { historyText = crmService.getEmailHistorySummary(contactId, 3, senderName); } catch { /* 降级 */ }
        addTrace("⑤ ctx stage=" + (stageLabel||'?') + " hist=" + historyText.length + " prefs=" + (prefsText||'?'));
      }

      const promptBody = (body || subject || '').slice(0, 15000);
      addTrace("⑥ body=" + promptBody.length + "字");

      const prompt = `你是顶级货代销冠，坐在同事旁边递纸条。不要像AI写报告。

【铁律】
- 开头给结论，不铺垫
- 有明确倾向——"做X，别做Y"
- 话术给原文，可复制发送
- 像人说话，不像机器
${stageLabel ? '- 当前阶段：' + stageLabel : ''}
- 【AI回复】用客户邮件的语言写（根据邮件正文自动判断）

${senderName ? '【我方身份】你是 ' + senderName + '，货代销售。不要在回复中混淆自己和客户的身份。' : ''}
${prefsText ? '客户画像：' + prefsText : ''}
${historyText ? '最近往来（最近3封）：\n' + historyText : ''}

客户邮件${fromName ? '（' + fromName + '）' : ''}：
---
${promptBody}
---

回复格式（不用markdown）：
【摘要】15字以内一句话概括
【总结】客户意图、决策链、真实诉求
【下一步建议】具体打法和心理博弈策略
【AI回复】用客户语言写，直接可用的回复文案`;

      addTrace("⑦ API prompt=" + prompt.length + "字");
      const resp = await new Promise((resolve, reject) => {
        const https = require("https");
        const req = https.request({
          hostname: "api.deepseek.com", path: "/v1/chat/completions", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
          timeout: 25000,
        }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => {
          addTrace("⑧ HTTP" + res.statusCode + " len=" + d.length);
          try { resolve(JSON.parse(d)); } catch (e) { addTrace("⑧ JSON失败"); reject(new Error("JSON解析失败")); }
        }); });
        req.on("error", (e) => { addTrace("⑧ net:" + e.message); reject(e); });
        req.on("timeout", () => { addTrace("⑧ timeout"); req.destroy(); reject(new Error("请求超时")); });
        req.end(JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: 600 }));
      });

      const text = resp?.choices?.[0]?.message?.content || "";
      addTrace("⑨ resp=" + text.length + "字 preview=" + text.slice(0,80));
      if (!text) { addTrace("⑨ 空"); return { ok: false, error: "DeepSeek 返回空内容", _trace: trace }; }

      const extract = (label) => {
        for (const p of ['【' + label + '】', label + '：', label + ':']) {
          const idx = text.indexOf(p);
          if (idx < 0) continue;
          let r = text.slice(idx + p.length);
          const next = r.search(/【(?:摘要|总结|下一步建议|AI回复)】/);
          if (next > 0) r = r.slice(0, next);
          return r.trim();
        }
        return '';
      };
      const clean = (s) => s.replace(/[《》「」『』]/g, '').replace(/[""]/g, '"').replace(/['']/g, "'").trim();
      const brief = clean(extract('摘要')) || '';
      const analysis = clean(extract('总结'));
      const strategy = clean(extract('下一步建议'));
      const script = clean(extract('AI回复'));
      const summary = analysis || clean(text.split('\n').filter(Boolean)[0] || '');
      const suggestion = strategy || '';
      const summaryBrief = brief || (summary || '').split(/[。.！!？?]/)[0] || summary;
      addTrace("⑩ 解析OK brief=" + summaryBrief);

      crmService.saveAiSummary(uid, accountId, summary, suggestion, summaryBrief);
      addTrace("⑪ 缓存完成");

      return { ok: true, data: { summary, summaryBrief, suggestion, analysis, strategy, script, cached: false }, _trace: trace };
    } catch (e) {
      addTrace("💥 " + (e.message || ''));
      Log.error("AI邮件总结", "异常", e.stack || e);
      return { ok: false, error: e.message, _trace: trace };
    }
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
