// ── 自动发送 — IPC 路由层 ──────────────────────────────────────────────────
// 只做路由分发和基础参数校验，业务逻辑委托给 AutoScheduler。

"use strict";

const { AutoScheduler } = require("./services/scheduler");
const { Log } = require("../core/logger");

/** @type {AutoScheduler|null} */
let _scheduler = null;

/**
 * 注册自动发送相关的 IPC 处理器。
 * @param {import('electron').IpcMain} ipcMain
 * @param {object} deps - 来自 main.js 的全局 deps 对象
 */
function register(ipcMain, deps) {
  if (!_scheduler) {
    _scheduler = new AutoScheduler(deps);
  }

  // ── auto:start ──────────────────────────────────────────────────────────
  ipcMain.handle("auto:start", async () => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    try {
      const result = await _scheduler.start();
      return { ok: result.ok, data: result.message };
    } catch (e) {
      Log.error("auto-send-ipc", "启动失败", e);
      return { ok: false, error: e.message };
    }
  });

  // ── auto:stop ───────────────────────────────────────────────────────────
  ipcMain.handle("auto:stop", async () => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    try {
      const result = await _scheduler.stop();
      return { ok: result.ok, data: result.message };
    } catch (e) {
      Log.error("auto-send-ipc", "停止失败", e);
      return { ok: false, error: e.message };
    }
  });

  // ── auto:status ─────────────────────────────────────────────────────────
  ipcMain.handle("auto:status", async () => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    try {
      const status = _scheduler.getStatus();
      return { ok: true, data: status };
    } catch (e) {
      Log.error("auto-send-ipc", "获取状态失败", e);
      return { ok: false, error: e.message };
    }
  });

  // ── auto:updateRules ────────────────────────────────────────────────────
  ipcMain.handle("auto:updateRules", async (_e, newRules) => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    if (!newRules || typeof newRules !== "object") {
      return { ok: false, error: "规则参数无效" };
    }
    try {
      const result = await _scheduler.updateRules(newRules);
      return { ok: result.ok };
    } catch (e) {
      Log.error("auto-send-ipc", "更新规则失败", e);
      return { ok: false, error: e.message };
    }
  });

  // ── auto:forecast ───────────────────────────────────────────────────────
  ipcMain.handle("auto:forecast", async () => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    try {
      const forecast = _scheduler.getForecast();
      return { ok: true, data: forecast };
    } catch (e) {
      Log.error("auto-send-ipc", "获取规划失败", e);
      return { ok: false, error: e.message };
    }
  });

  // ── auto:plan ──────────────────────────────────────────────────────────
  ipcMain.handle("auto:plan", async () => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    try {
      const plan = _scheduler.getPlan();
      return { ok: true, data: plan };
    } catch (e) {
      Log.error("auto-send-ipc", "获取计划失败", e);
      return { ok: false, error: e.message };
    }
  });

  // ── auto:decisionLog ────────────────────────────────────────────────────
  ipcMain.handle("auto:decisionLog", async (_e, n) => {
    if (!_scheduler) return { ok: false, error: "调度器未初始化" };
    try {
      const limit = typeof n === "number" && n > 0 ? n : 20;
      const logs = _scheduler.getDecisionLog(limit);
      return { ok: true, data: logs };
    } catch (e) {
      Log.error("auto-send-ipc", "获取日志失败", e);
      return { ok: false, error: e.message };
    }
  });
}

/**
 * 应用退出时清理。
 */
function cleanup() {
  if (_scheduler) {
    _scheduler.stop().catch(() => {});
    _scheduler = null;
  }
}

module.exports = { register, cleanup };
