// ── 自动发送 — 渲染层界面 v2 ──────────────────────────────────────────────
// 布局：状态栏 → [详细计划(左宽) + 规则+预计(右窄)] → 决策日志(底)

import { lucide, escapeHtml, showToast } from "./shared.js";

// ── 轮询 ─────────────────────────────────────────────────────────────────────
let _statusTimer = null;
let _logTimer = null;

// ── 初始化/销毁 ───────────────────────────────────────────────────────────────

export async function initAutoSend() {
  renderShell();
  bindEvents();
  startPolling();
  await refreshAll();
}

export function teardownAutoSend() {
  stopPolling();
}

// ══════════════════════════════════════════════════════════════════════════════
// 页面骨架
// ══════════════════════════════════════════════════════════════════════════════

function renderShell() {
  const c = document.getElementById("page-auto-send");
  if (!c) return;

  c.innerHTML = `
    <!-- ── 状态栏 ── -->
    <div class="as-statusbar" id="as-statusbar">
      <div class="as-status-left">
        <span class="as-status-dot" id="as-status-dot"></span>
        <strong id="as-status-text">未启动</strong>
        <span class="as-status-sep">·</span>
        <span>下次巡检 <strong id="as-next-scan">—</strong></span>
        <span class="as-status-sep">·</span>
        <span>今日 <strong id="as-today-sent">0</strong>/<span id="as-daily-limit">200</span></span>
        <span id="as-quota-remaining" style="font-size:11px;color:var(--text-secondary)"></span>
      </div>
      <div class="as-status-right">
        <button id="as-btn-start" class="as-btn-primary">${lucide("play", 14)} 启动</button>
        <button id="as-btn-stop" class="as-btn-secondary" disabled>${lucide("square", 14)} 暂停</button>
      </div>
    </div>

    <!-- ── 主内容：左宽(计划) + 右窄(规则+预计) ── -->
    <div class="as-main">
      <!-- 左：发送计划 -->
      <div class="as-card as-plan">
        <div class="as-card-header">
          <h3>${lucide("clipboard-list", 14)} 待发送计划 <span id="as-plan-summary" style="font-weight:400;font-size:11px;color:var(--text-secondary)"></span></h3>
          <button id="as-btn-refresh" class="as-btn-sm">${lucide("refresh-cw", 12)} 刷新</button>
        </div>
        <div class="as-plan-table-wrap">
          <table class="as-plan-table" id="as-plan-table">
            <thead><tr>
              <th>公司</th><th>联系人</th><th>邮箱</th><th>阶段</th><th>类型</th><th>语言</th><th>原因</th>
            </tr></thead>
            <tbody id="as-plan-tbody">
              <tr><td colspan="7" class="as-empty-row">加载中...</td></tr>
            </tbody>
          </table>
        </div>
        <div id="as-plan-skipped" style="font-size:10px;color:var(--text-secondary);padding:4px 8px"></div>
      </div>

      <!-- 右：规则 + 预计 -->
      <div class="as-side">
        <div class="as-card as-rules">
          <div class="as-card-header">
            <h3>${lucide("sliders", 14)} 阶段规则</h3>
          </div>
          <div class="as-rules-grid">
            <div class="as-rule-item"><label>cold→F1</label><input type="number" id="as-rule-cold-f1" min="1" max="30" value="3"><span>天</span></div>
            <div class="as-rule-item"><label>F1→F2</label><input type="number" id="as-rule-f1-f2" min="1" max="30" value="4"><span>天</span></div>
            <div class="as-rule-item"><label>F2→F3</label><input type="number" id="as-rule-f2-f3" min="1" max="30" value="5"><span>天</span></div>
            <div class="as-rule-item"><label>F3→F4</label><input type="number" id="as-rule-f3-f4" min="1" max="30" value="6"><span>天</span></div>
            <div class="as-rule-item"><label>上限</label><input type="number" id="as-rule-limit" min="1" max="2000" value="200"><span>封/天</span></div>
            <div class="as-rule-item"><label>巡检</label><input type="number" id="as-rule-interval" min="1" max="60" value="5"><span>分</span></div>
          </div>
          <button id="as-btn-save-rules" class="as-btn-primary" style="margin-top:8px;width:100%">保存配置</button>
          <div id="as-save-feedback" style="font-size:10px;color:var(--success);margin-top:4px;min-height:14px"></div>
        </div>

        <div class="as-card as-forecast">
          <div class="as-card-header">
            <h3>${lucide("calendar", 14)} 近日预计</h3>
          </div>
          <div class="as-fc-day">
            <div class="as-fc-label">📅 今日</div>
            <div class="as-fc-stats" id="as-fc-today-stats">—</div>
            <div class="as-fc-breakdown" id="as-fc-today-detail"></div>
          </div>
          <div class="as-fc-day" style="margin-top:6px">
            <div class="as-fc-label">📅 明日</div>
            <div class="as-fc-stats" id="as-fc-tomorrow-stats">—</div>
            <div class="as-fc-breakdown" id="as-fc-tomorrow-detail"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 决策日志 ── -->
    <div class="as-card as-log">
      <div class="as-card-header">
        <h3>${lucide("file-text", 14)} 决策日志 <span style="font-weight:400;font-size:10px;color:var(--text-secondary)">最近20条</span></h3>
      </div>
      <div class="as-log-list" id="as-log-list">
        <div class="as-log-empty">暂无日志，启动后自动记录</div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 事件绑定
// ══════════════════════════════════════════════════════════════════════════════

function bindEvents() {
  document.getElementById("as-btn-start")?.addEventListener("click", async () => {
    const r = await window.electronAPI.autoStart();
    if (r.ok) { showToast("已启动", "ok"); await refreshAll(); }
    else showToast("启动失败: " + (r.error || r.data), "error");
  });

  document.getElementById("as-btn-stop")?.addEventListener("click", async () => {
    const r = await window.electronAPI.autoStop();
    if (r.ok) { showToast("已暂停", "ok"); await refreshAll(); }
    else showToast("暂停失败", "error");
  });

  document.getElementById("as-btn-refresh")?.addEventListener("click", () => refreshAll());
  document.getElementById("as-btn-save-rules")?.addEventListener("click", saveRules);
}

// ══════════════════════════════════════════════════════════════════════════════
// 数据刷新
// ══════════════════════════════════════════════════════════════════════════════

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshPlan(), refreshForecast(), refreshLog()]);
}

// ── 状态 ─────────────────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const r = await window.electronAPI.autoStatus();
    if (!r.ok || !r.data) return;
    const s = r.data;

    const statusText = document.getElementById("as-status-text");
    statusText.textContent = s.status === "running" ? "运行中" : s.status === "idle" ? "已暂停" : s.status;

    const dot = document.getElementById("as-status-dot");
    dot.className = "as-status-dot " + (s.status === "running" ? "running" : "idle");

    const ns = document.getElementById("as-next-scan");
    if (s.nextScanAt) {
      ns.textContent = new Date(s.nextScanAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } else { ns.textContent = "—"; }

    document.getElementById("as-today-sent").textContent = s.todaySent || 0;
    document.getElementById("as-daily-limit").textContent = s.dailyLimit || 200;
    const remaining = Math.max(0, (s.dailyLimit || 200) - (s.todaySent || 0));
    const remainingEl = document.getElementById("as-quota-remaining");
    if (remainingEl) remainingEl.textContent = `(剩余${remaining})`;

    const running = s.status === "running";
    document.getElementById("as-btn-start").disabled = running;
    document.getElementById("as-btn-stop").disabled = !running;

    // 填充规则输入框
    if (s.rules) {
      setVal("as-rule-cold-f1", s.rules.cold_to_f1_days);
      setVal("as-rule-f1-f2", s.rules.f1_to_f2_days);
      setVal("as-rule-f2-f3", s.rules.f2_to_f3_days);
      setVal("as-rule-f3-f4", s.rules.f3_to_f4_days);
      setVal("as-rule-limit", s.rules.dailyLimit);
      setVal("as-rule-interval", s.rules.scanIntervalMinutes);
    }
  } catch { /* 降级 */ }
}

function setVal(id, val) {
  const e = document.getElementById(id);
  if (e && e.value != val) e.value = val;
}

// ── 详细计划 ─────────────────────────────────────────────────────────────────

async function refreshPlan() {
  try {
    const r = await window.electronAPI.autoPlan();
    if (!r.ok || !r.data) return;
    const plan = r.data;
    const { items, stats, skipped } = plan;

    // 摘要
    const summary = document.getElementById("as-plan-summary");
    if (summary) {
      const stageParts = [];
      if (stats.byStage) {
        for (const [s, n] of Object.entries(stats.byStage)) stageParts.push(`${s}:${n}`);
      }
      summary.textContent = `${stats.toSend || items.length}封 · ${items.length}人 · ${stageParts.join(" ")} · 上限${stats.dailyLimit}(剩${stats.remaining})`;
    }

    // 表格
    const tbody = document.getElementById("as-plan-tbody");
    if (!tbody) return;

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="as-empty-row">暂无待发 — 所有联系人均未满足发送条件</td></tr>';
    } else {
      const STAGE_LABEL = { cold: "冷开发", f1: "F1", f2: "F2", f3: "F3", f4: "F4" };
      const TYPE_LABEL = { agent: "代理", direct: "直客", unlabeled: "通用" };
      const LANG_LABEL = { es: "ES", pt: "PT", en: "EN" };

      tbody.innerHTML = items.map((i) => `
        <tr>
          <td title="${escapeHtml(i.company)}">${escapeHtml(i.company)}</td>
          <td>${escapeHtml(i.name)}</td>
          <td class="as-email-cell" title="${escapeHtml(i.email)}">${escapeHtml(i.email)}</td>
          <td><span class="as-stage-chip stage-${i.stage}">${STAGE_LABEL[i.stage] || i.stage}</span></td>
          <td>${TYPE_LABEL[i.type] || i.type}</td>
          <td>${LANG_LABEL[i.lang] || i.lang}</td>
          <td class="as-reason-cell">${escapeHtml(i.reason)}</td>
        </tr>
      `).join("");
    }

    // 底部汇总行
    const skippedEl = document.getElementById("as-plan-skipped");
    if (skippedEl) {
      const total = stats.total || 0;
      skippedEl.innerHTML = `${total} 人总计 · ${items.length} 人待发`;
    }
  } catch { /* 降级 */ }
}

// ── 预计 ─────────────────────────────────────────────────────────────────────

async function refreshForecast() {
  try {
    const r = await window.electronAPI.autoForecast();
    if (!r.ok || !r.data) return;
    renderDay("as-fc-today-stats", "as-fc-today-detail", r.data.today);
    renderDay("as-fc-tomorrow-stats", "as-fc-tomorrow-detail", r.data.tomorrow);
  } catch { /* 降级 */ }
}

function renderDay(statsId, detailId, day) {
  const statsEl = document.getElementById(statsId);
  const detailEl = document.getElementById(detailId);
  if (!statsEl || !detailEl) return;

  if (!day || (!day.companies && !day.totalPeople)) {
    statsEl.innerHTML = '<span style="color:var(--text-secondary);font-size:11px">—</span>';
    detailEl.innerHTML = "";
    return;
  }

  statsEl.innerHTML = `${lucide("building", 11)} ${day.companies}家 · ${lucide("users", 11)} ${day.totalPeople}人`;

  const order = ["cold", "f1", "f2", "f3", "f4"];
  const stages = day.byStage || {};
  let h = "";
  for (const s of order) {
    if (stages[s]) h += `<span class="as-stage-chip stage-${s}">${s}:${stages[s]}</span> `;
  }
  detailEl.innerHTML = h || '<span style="color:var(--text-secondary);font-size:10px">—</span>';
}

// ── 日志 ─────────────────────────────────────────────────────────────────────

async function refreshLog() {
  try {
    const r = await window.electronAPI.autoDecisionLog(20);
    if (!r.ok || !r.data) return;
    const logs = r.data;
    const el = document.getElementById("as-log-list");
    if (!el) return;

    if (!logs.length) { el.innerHTML = '<div class="as-log-empty">暂无日志</div>'; return; }

    el.innerHTML = logs.map((l) => {
      const icon = l.result === "sent" ? lucide("check-circle", 12) : "skip" === l.decision ? lucide("minus-circle", 12) : lucide("info", 12);
      const ts = l.ts ? new Date(l.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="as-log-entry">
        <span class="as-log-icon">${icon}</span><span class="as-log-ts">${ts}</span>
        <span class="as-log-email">${escapeHtml(l.email || "")}</span>
        <span class="as-log-company">${escapeHtml(l.company || "")}</span>
        <span>→</span><span class="as-log-decision">${escapeHtml(l.decision || "")}</span>
        <span class="as-log-reason">${escapeHtml(l.reason || "")}</span>
      </div>`;
    }).join("");
  } catch { /* 降级 */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// 保存规则（热更新）
// ══════════════════════════════════════════════════════════════════════════════

async function saveRules() {
  const rules = {
    cold_to_f1_days: intVal("as-rule-cold-f1", 3),
    f1_to_f2_days: intVal("as-rule-f1-f2", 4),
    f2_to_f3_days: intVal("as-rule-f2-f3", 5),
    f3_to_f4_days: intVal("as-rule-f3-f4", 6),
    dailyLimit: intVal("as-rule-limit", 200),
    scanIntervalMinutes: intVal("as-rule-interval", 5),
  };

  try {
    const r = await window.electronAPI.autoUpdateRules(rules);
    const fb = document.getElementById("as-save-feedback");
    if (r.ok) {
      if (fb) { fb.textContent = "✓ 已保存"; setTimeout(() => fb.textContent = "", 2000); }
      // 热更新：规则变更后立即刷新全部数据
      await refreshAll();
    } else {
      if (fb) { fb.textContent = "✗ 保存失败"; fb.style.color = "var(--danger)"; }
      showToast("保存失败", "error");
    }
  } catch (e) {
    showToast("保存失败: " + e.message, "error");
  }
}

function intVal(id, fallback) {
  return parseInt(document.getElementById(id)?.value) || fallback;
}

// ══════════════════════════════════════════════════════════════════════════════
// 轮询
// ══════════════════════════════════════════════════════════════════════════════

function startPolling() {
  stopPolling();
  _statusTimer = setInterval(() => { refreshStatus(); refreshPlan(); }, 30000);
  _logTimer = setInterval(() => refreshLog(), 60000);
}

function stopPolling() {
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  if (_logTimer) { clearInterval(_logTimer); _logTimer = null; }
}

// ── 页面处理器 ───────────────────────────────────────────────────────────────
window.__pageHandlers = window.__pageHandlers || {};
window.__pageHandlers["auto-send"] = () => initAutoSend();
