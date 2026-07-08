// ── 自动发送 — 调度器状态持久化（SchedulerState 类）─────────────────────────
// 负责 data/auto-scheduler-state.json 的原子读写 + 并发锁 + 环形日志。
// 不依赖 Electron API，仅使用 Node.js fs/path。

"use strict";

const fs = require("fs");
const path = require("path");
const { APP_ROOT } = require("../../config");
const { Log } = require("../../core/logger");

/** 状态文件路径 */
const STATE_PATH = path.join(APP_ROOT, "data", "auto-scheduler-state.json");

/** 环形日志最大容量 */
const LOG_CAPACITY = 500;

// ── SchedulerState 类 ────────────────────────────────────────────────────────

class SchedulerState {
  constructor() {
    this._lock = false;
    /** @type {object|null} 内存缓存 */
    this._cache = null;
  }

  // ── 读取 ──────────────────────────────────────────────────────────────────

  /**
   * 加载状态（优先走内存缓存）。
   * @returns {object}
   */
  load() {
    if (this._cache) return this._cache;
    try {
      if (fs.existsSync(STATE_PATH)) {
        const raw = fs.readFileSync(STATE_PATH, "utf-8");
        this._cache = JSON.parse(raw);
        // 兼容旧格式：确保必要字段存在
        if (!this._cache.decisionLog) this._cache.decisionLog = [];
        if (!this._cache.logIndex) this._cache.logIndex = 0;
        if (!this._cache.contactStageCache) this._cache.contactStageCache = {};
        return this._cache;
      }
    } catch (e) {
      Log.warn("auto-scheduler", "状态文件损坏，降级为空状态", e.stack);
    }
    this._cache = this._defaultState();
    return this._cache;
  }

  // ── 带锁更新 ──────────────────────────────────────────────────────────────

  /**
   * 原子更新状态：读 → 改 → 写，全程持锁。
   * 防止巡检定时器和用户手动操作并发写入。
   *
   * @param {(state: object) => object|Promise<object>} updateFn
   * @returns {Promise<object>} 更新后的状态
   */
  async updateWithLock(updateFn) {
    if (this._lock) throw new Error("State busy");
    this._lock = true;
    try {
      const state = this.load();
      const newState = await updateFn(state);
      await this._save(newState);
      return newState;
    } finally {
      this._lock = false;
    }
  }

  // ── 环形日志追加（仅内存，需配合 save 落盘）───────────────────────────────

  /**
   * 向内存中的决策日志追加一条（环形覆盖）。
   * 调用后需手动 save 或通过 updateWithLock 落盘。
   *
   * @param {object} entry - 决策日志条目
   */
  addLog(entry) {
    if (!this._cache) this.load();
    if (!this._cache) return;
    if (!Array.isArray(this._cache.decisionLog)) {
      this._cache.decisionLog = [];
    }
    const idx = this._cache.logIndex % LOG_CAPACITY;
    this._cache.decisionLog[idx] = {
      ts: new Date().toISOString(),
      ...entry,
    };
    this._cache.logIndex = (this._cache.logIndex + 1) % LOG_CAPACITY;
  }

  /**
   * 获取最近 N 条决策日志（按时间排序）。
   * @param {number} [n=20]
   * @returns {object[]}
   */
  getRecentLogs(n) {
    const limit = n || 20;
    const state = this.load();
    const logs = state.decisionLog || [];
    // 过滤空槽位，取最近的
    const filled = logs.filter(Boolean);
    return filled.slice(-limit).reverse();
  }

  // ── 内部：保存 ────────────────────────────────────────────────────────────

  /**
   * 原子写盘（tmp → rename）。
   * @param {object} state
   */
  async _save(state) {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this._cache = state;
    const tmp = STATE_PATH + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
      Log.error("auto-scheduler", "状态写入失败", e);
      throw e;
    }
  }

  // ── 默认状态 ──────────────────────────────────────────────────────────────

  /** @returns {object} */
  _defaultState() {
    return {
      status: "idle", // 'idle' | 'running' | 'paused'
      lastScanAt: null,
      nextScanAt: null,
      todaySent: 0,
      todayDate: "",
      rules: {
        cold_to_f1_days: 3,
        f1_to_f2_days: 4,
        f2_to_f3_days: 5,
        f3_to_f4_days: 6,
        dailyLimit: 200,
        scanIntervalMinutes: 5,
      },
      contactStageCache: {},
      decisionLog: [],
      logIndex: 0,
    };
  }
}

// ── 单例导出 ─────────────────────────────────────────────────────────────────

/** @type {SchedulerState} */
let _instance = null;

/**
 * 获取 SchedulerState 单例。
 * @returns {SchedulerState}
 */
function getState() {
  if (!_instance) _instance = new SchedulerState();
  return _instance;
}

module.exports = { SchedulerState, getState, STATE_PATH, LOG_CAPACITY };
