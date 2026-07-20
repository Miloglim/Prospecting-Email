// ── Prospector — 今日报告服务 ──────────────────────────────────────────────
"use strict";

const path = require("path");
const fs = require("fs");
const { getDb } = require("./db");
const { Log } = require("../core/logger");

const TAG_COLORS = {
  reaching: "#ff9800", quoting: "#2196f3", trial: "#8e24aa",
  cooperating: "#4caf50", lost: "#b0b0b0",
};

// ── 数据采集 ──────────────────────────────────────────────────────────────────

async function generate(aiFn) {
  const db = getDb();
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }))
    .toISOString().slice(0, 10); // 上海时区当日
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const dateCN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }))
    .toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

  // 发送数据
  const sentToday = db.prepare(
    "SELECT COUNT(*) as n FROM send_log WHERE time_beijing LIKE ?"
  ).get(today + "%").n;
  const failedToday = db.prepare(
    "SELECT COUNT(*) as n FROM send_log WHERE time_beijing LIKE ? AND status = 'failed'"
  ).get(today + "%").n;
  const successRate = sentToday > 0 ? Math.round((sentToday - failedToday) / sentToday * 1000) / 10 : 0;

  // 收件数据
  const inboxToday = db.prepare(
    "SELECT type, COUNT(*) as n FROM inbox WHERE date LIKE ? GROUP BY type"
  ).all(today + "%");
  const inboxMap = {};
  for (const r of inboxToday) inboxMap[r.type] = r.n;
  const newMails = (inboxMap.reply || 0) + (inboxMap["auto-reply"] || 0) + (inboxMap.bounce || 0) + (inboxMap.other || 0);
  const replies = inboxMap.reply || 0;
  const autoreplies = inboxMap["auto-reply"] || 0;
  const bounces = inboxMap.bounce || 0;
  const replyRate = sentToday > 0 ? Math.round(replies / sentToday * 1000) / 10 : 0;
  const bounceRate = sentToday > 0 ? Math.round(bounces / sentToday * 1000) / 10 : 0;

  // 管线数据
  const crmService = require("./crm-service");
  const stageCounts = { reaching: 0, quoting: 0, trial: 0, cooperating: 0, lost: 0 };
  let totalInPipeline = 0;
  try {
    const pipeline = crmService.listPipeline();
    if (pipeline?.columns) {
      for (const col of pipeline.columns) {
        stageCounts[col.key] = col.contacts.length;
        totalInPipeline += col.contacts.length;
      }
    }
  } catch (e) { Log.warn("报告", "管线数据获取失败", e.message); }
  // 已触达联系人总数（_status 或 tags 含 已触达/reached）
  let reachedCount = 0;
  try {
    const r = db.prepare(
      "SELECT COUNT(*) as n FROM contacts WHERE _status IN ('已触达','reached') OR tags LIKE '%已触达%' OR tags LIKE '%reached%'"
    ).get();
    reachedCount = r?.n || 0;
  } catch { /* 降级 */ }

  const quoteRate = reachedCount > 0 ? Math.round(stageCounts.quoting / reachedCount * 1000) / 10 : 0;
  const orderRate = stageCounts.quoting > 0 ? Math.round(stageCounts.trial / stageCounts.quoting * 1000) / 10 : 0;
  const coopRate = reachedCount > 0 ? Math.round(stageCounts.cooperating / reachedCount * 1000) / 10 : 0;

  // 待跟进
  const reminders = crmService.checkReminders();
  const dueCount = (reminders.data?.due || []).length + (reminders.data?.overdue || []).length;
  const overdueCount = (reminders.data?.overdue || []).length;
  const followupItems = [
    ...((reminders.data?.overdue || []).map(r => ({ ...r, status: "overdue" }))),
    ...((reminders.data?.due || []).map(r => ({ ...r, status: "today" }))),
  ].slice(0, 10);

  // AI 分析
  let aiText = "";
  if (aiFn) {
    aiText = await aiFn({
      sentToday, failedToday, successRate, newMails, replies, autoreplies, bounces,
      replyRate, bounceRate, stageCounts, quoteRate, orderRate, coopRate,
      dueCount, overdueCount, followupItems,
    }) || "";
  }

  const html = buildHtml({
    dateCN, now, sentToday, failedToday, successRate,
    newMails, replies, autoreplies, bounces, replyRate, bounceRate,
    stageCounts, reachedCount, quoteRate, orderRate, coopRate,
    dueCount, overdueCount, followupItems, aiText,
  });

  const data = { dateCN, now, sentToday, failedToday, successRate, newMails, replies, autoreplies, bounces, replyRate, bounceRate, stageCounts, reachedCount, quoteRate, orderRate, coopRate, dueCount, overdueCount };
  return { html, data };
}

// ── HTML 生成 ─────────────────────────────────────────────────────────────────

function buildHtml(d) {
  const stageOrder = ["reaching", "quoting", "trial", "cooperating", "lost"];
  const stageLabels = { reaching: "触达中", quoting: "报价中", trial: "试单", cooperating: "合作中", lost: "已流失" };
  const pipelineHtml = stageOrder.map(k => {
    const n = d.stageCounts[k] || 0;
    const c = TAG_COLORS[k] || "#999";
    return `<div class="pipe-item"><div class="n" style="color:${c}">${n}</div><div class="t">${stageLabels[k]}</div></div>`;
  }).join("");

  const followupHtml = d.followupItems.length ? d.followupItems.map(r => `
    <div class="followup-item">
      <span class="fu-dot ${r.status}"></span>
      <span class="fu-name">${esc(r.first_name || "")} ${esc(r.last_name || "")}</span>
      <span class="fu-co">${esc(r.company_name || "")}</span>
    </div>`).join("") : '<div class="followup-item"><span style="font-size:12px;color:var(--text2)">暂无</span></div>';

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#fff;--text:#1d1d1f;--text2:#6e6e73;--text3:#aeaeb2;--line:#e5e5ea}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;justify-content:center;padding:40px 24px;-webkit-font-smoothing:antialiased}
.report{width:620px;max-width:100%}
.report-header{padding-bottom:20px;margin-bottom:24px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;justify-content:space-between}
.report-title{font-size:24px;font-weight:600;letter-spacing:-.02em}
.report-date{font-size:13px;color:var(--text2)}
.section{margin-bottom:20px}
.section-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;font-weight:600;letter-spacing:-.01em}
.section-head::before{content:'';display:inline-block;width:3px;height:14px;border-radius:1.5px;background:var(--text)}
.metric-row{display:flex;flex-direction:column;gap:6px}
.metric-card{display:flex;align-items:baseline;justify-content:space-between;border-bottom:.5px solid var(--line);padding:8px 0}
.metric-card .val{font-size:16px;font-weight:600;letter-spacing:-.02em;min-width:60px}
.metric-card .lbl{font-size:12px;color:var(--text2);text-align:right}
.funnel-row{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.pipe-item{flex:1;text-align:center;padding:12px 4px;border-right:1px solid var(--line);background:#fafafa}
.pipe-item:last-child{border-right:none}
.pipe-item .n{font-size:18px;font-weight:600;letter-spacing:-.02em}
.pipe-item .t{font-size:11px;color:var(--text2);margin-top:1px}
.text-report{border:1px solid var(--line);border-radius:8px;padding:16px 18px}
.text-report h3{font-size:13px;font-weight:600;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.text-report p{font-size:13px;line-height:1.7;color:var(--text2);margin-bottom:8px}
.text-report p:last-child{margin-bottom:0}
.text-report .hl{color:var(--text);font-weight:500}
.followup-list{display:flex;flex-direction:column;gap:4px}
.followup-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--line);border-radius:6px}
.fu-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.fu-dot.overdue{background:#ff3b30}.fu-dot.today{background:#ff9f0a}
.fu-name{font-size:13px;font-weight:500}.fu-co{font-size:12px;color:var(--text2);margin-left:auto}
.report-footer{margin-top:20px;padding-top:12px;border-top:1px solid var(--line);font-size:11px;color:var(--text3);display:flex;justify-content:space-between}
@media print{@page{size:A4;margin:16mm}body{background:#fff;padding:0}.metric-card{border-color:#e5e5ea}.section{page-break-inside:avoid}}
</style></head><body><div class="report">

<div class="report-header"><span class="report-title">今日报告</span><span class="report-date">${d.dateCN}</span></div>

<div class="section"><div class="section-head">收发</div><div class="metric-row">
  <div class="metric-card"><div class="val">${d.sentToday}<span style="font-size:14px;font-weight:400;color:var(--text2)"> 封</span></div><div class="lbl">已发 · <span style="color:#d93025">${d.failedToday}</span> 封失败</div></div>
  <div class="metric-card"><div class="val" style="color:#22a644">${d.replies}</div><div class="lbl">回复</div></div>
  <div class="metric-card"><div class="val" style="color:#e6a817">${d.autoreplies}</div><div class="lbl">自动回复</div></div>
  <div class="metric-card"><div class="val" style="color:#d93025">${d.bounces}</div><div class="lbl">退信</div></div>
</div></div>

<div class="section"><div class="section-head">客户跟进总览</div>
  <div class="funnel-row">${pipelineHtml}</div>
</div>

<div class="section"><div class="section-head">数据快报</div><div class="text-report">
  <p style="line-height:2">
    已发 <span class="hl">${d.sentToday}</span> 封，失败 <span class="hl" style="color:#d93025">${d.failedToday}</span> 封&nbsp; · &nbsp; 新邮件 <span class="hl">${d.newMails}</span> 封，回复 <span class="hl" style="color:#22a644">${d.replies}</span> 封，退信 <span class="hl" style="color:#d93025">${d.bounces}</span> 封<br>
    触达中 <span class="hl" style="color:#ff9800">${d.stageCounts.reaching||0}</span>&nbsp; 报价中 <span class="hl" style="color:#2196f3">${d.stageCounts.quoting||0}</span>&nbsp; 试单 <span class="hl" style="color:#8e24aa">${d.stageCounts.trial||0}</span>&nbsp; 合作中 <span class="hl" style="color:#4caf50">${d.stageCounts.cooperating||0}</span>&nbsp; 已流失 <span class="hl" style="color:#b0b0b0">${d.stageCounts.lost||0}</span>&nbsp; · &nbsp; 待跟进 <span class="hl">${d.dueCount}</span> 人，逾期 <span class="hl" style="color:#d93025">${d.overdueCount}</span> 人
  </p>
</div></div>

<div class="section"><div class="section-head">指标</div><div class="metric-row">
  <div class="metric-card"><div class="val" style="color:#22a644">${d.replyRate}%</div><div class="lbl">回复率 · ${d.replies}/${d.sentToday}</div></div>
  <div class="metric-card"><div class="val" style="color:#d93025">${d.bounceRate}%</div><div class="lbl">退信率 · ${d.bounces}/${d.sentToday}</div></div>
  <div class="metric-card"><div class="val">${d.successRate}%</div><div class="lbl">送达率 · ${d.sentToday-d.failedToday}/${d.sentToday}</div></div>
  <div class="metric-card"><div class="val" style="color:#2196f3">${d.quoteRate}%</div><div class="lbl">报价率 · 报价中 ${d.stageCounts.quoting||0} / 已触达 ${d.reachedCount||0}</div></div>
  <div class="metric-card"><div class="val" style="color:#8e24aa">${d.orderRate}%</div><div class="lbl">出单率 · 试单 ${d.stageCounts.trial||0} / 报价中 ${d.stageCounts.quoting||0}</div></div>
  <div class="metric-card"><div class="val" style="color:#4caf50">${d.coopRate}%</div><div class="lbl">合作率 · 合作中 ${d.stageCounts.cooperating||0} / 已触达 ${d.reachedCount||0}</div></div>
</div></div>

${d.aiText ? `<div class="section"><div class="section-head">AI 分析与建议</div><div class="text-report">${d.aiText}</div></div>` : ""}

<div class="section"><div class="section-head">今日待跟进</div><div class="followup-list">${followupHtml}</div></div>

<div class="report-footer"><span>Prospector</span><span>${d.now}</span></div>

</div></body></html>`;
}

function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ── 写库 ──────────────────────────────────────────────────────────────────────

function saveToDb(d) {
  const db = getDb();
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }))
    .toISOString().slice(0, 10);
  const sc = d.stageCounts || {};
  db.prepare(`INSERT OR REPLACE INTO daily_reports
    (date, sent_total, sent_failed, success_rate, inbox_total, replies, autoreplies, bounces,
     reply_rate, bounce_rate, stage_reaching, stage_quoting, stage_trial, stage_cooperating, stage_lost,
     to_quoting_rate, to_trial_rate, to_coop_rate, due_count, overdue_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    today, d.sentToday||0, d.failedToday||0, d.successRate||0,
    d.newMails||0, d.replies||0, d.autoreplies||0, d.bounces||0,
    d.replyRate||0, d.bounceRate||0,
    sc.reaching||0, sc.quoting||0, sc.trial||0, sc.cooperating||0, sc.lost||0,
    d.quoteRate||0, d.orderRate||0, d.coopRate||0,
    d.dueCount||0, d.overdueCount||0
  );
  Log.info("报告", `日报数据已写入 ${today}`);
}

module.exports = { generate, saveToDb };
