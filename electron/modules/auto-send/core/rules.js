// ── 自动发送 — 纯决策逻辑（零依赖，零副作用）─────────────────────────────
// 本文件不碰 fs / Electron / IPC / S.*，可独立单元测试。

"use strict";

// ── 默认规则 ─────────────────────────────────────────────────────────────────
/** @type {AutoSendRules} */
const DEFAULT_RULES = {
  cold_to_f1_days: 3,
  f1_to_f2_days: 4,
  f2_to_f3_days: 5,
  f3_to_f4_days: 6,
  dailyLimit: 200,
  scanIntervalMinutes: 5,
};

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 这些标签的联系人永久跳过，不参与自动发送 */
const SKIP_TAGS = ["replied", "bounced_by_contact", "autoreply"];

/** 阶段顺序（用于下一阶段推导） */
const STAGE_ORDER = ["cold", "f1", "f2", "f3", "f4"];

/** 阶段 → 下一阶段的间隔天数 key */
const INTERVAL_KEYS = {
  cold: "cold_to_f1_days",
  f1: "f1_to_f2_days",
  f2: "f2_to_f3_days",
  f3: "f3_to_f4_days",
};

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 获取上海时区今天的日期字符串 YYYY-MM-DD。
 * @returns {string}
 */
function beijingToday() {
  const [d] = new Date()
    .toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })
    .split(", ");
  const [m, day, y] = d.split("/");
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * 日期字符串 → 天数偏移（today - dateStr）。
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} today - YYYY-MM-DD
 * @returns {number}
 */
function daysBetween(dateStr, today) {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr + "T00:00:00+08:00");
  const t = new Date(today + "T00:00:00+08:00");
  return Math.floor((t - d) / 86400000);
}

/**
 * 日期加减天数。
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} days - 正数加、负数减
 * @returns {string}
 */
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00+08:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 获取下一阶段名。f4 是终点，返回 null。
 * @param {string} stage
 * @returns {string|null}
 */
function nextStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

/**
 * 浅合并用户规则到默认规则。
 * @param {AutoSendRules} [overrides]
 * @returns {AutoSendRules}
 */
function mergeRules(overrides) {
  if (!overrides || typeof overrides !== "object") return { ...DEFAULT_RULES };
  return { ...DEFAULT_RULES, ...overrides };
}

// ── 核心评估 ─────────────────────────────────────────────────────────────────

/**
 * 评估一个联系人是否应该自动发送。
 *
 * @param {object} contact - 联系人对象（含 email, tags, company 等）
 * @param {object} contactCache - contactStageCache 中该联系人的缓存记录 { stage, lastSentAt }
 * @param {AutoSendRules} rules - 合并后的规则
 * @param {string} nowDate - 今日日期 YYYY-MM-DD
 * @returns {{ shouldSend: boolean, stage: string, reason: string }}
 */
function evaluateContact(contact, contactCache, rules, nowDate) {
  // 1. 标签过滤
  const tags = contact.tags || [];
  for (const t of SKIP_TAGS) {
    if (tags.includes(t)) {
      return { shouldSend: false, stage: "", reason: `已标记 ${t}` };
    }
  }

  // 2. 无邮箱 → 跳过
  if (!contact.email || !contact.email.includes("@")) {
    return { shouldSend: false, stage: "", reason: "无有效邮箱" };
  }

  const email = contact.email.toLowerCase().trim();

  // 3. 从缓存获取或推导阶段
  let currentStage = "cold";
  let lastSentAt = null;

  if (contactCache && contactCache[email]) {
    currentStage = contactCache[email].stage || "cold";
    lastSentAt = contactCache[email].lastSentAt || null;
  }

  // 4. 如果没有任何发送记录 → 冷开发
  if (!lastSentAt) {
    return { shouldSend: true, stage: "cold", reason: "新联系人" };
  }

  // 5. 已到 f4 → 终点，不再发送
  if (currentStage === "f4") {
    return { shouldSend: false, stage: "f4", reason: "已达最终阶段 f4" };
  }

  // 6. 计算是否到了下一阶段的时间
  const next = nextStage(currentStage);
  if (!next) {
    return { shouldSend: false, stage: currentStage, reason: "无下一阶段" };
  }

  const intervalKey = INTERVAL_KEYS[currentStage];
  const intervalDays = rules[intervalKey] || 5;
  const daysElapsed = daysBetween(lastSentAt, nowDate);

  if (daysElapsed >= intervalDays) {
    return {
      shouldSend: true,
      stage: next,
      reason: `${currentStage}→${next},间隔${intervalDays}天(已过${daysElapsed}天)`,
    };
  }

  return {
    shouldSend: false,
    stage: currentStage,
    reason: `等待间隔: ${currentStage}→${next} 需${intervalDays}天(已过${daysElapsed}天)`,
  };
}

// ── 批量评估：构建发送计划 ───────────────────────────────────────────────────

/**
 * 为全部联系人构建自动发送计划。
 * 返回待发送列表 + 跳过列表 + 统计。
 *
 * @param {object[]} contacts - 全部联系人
 * @param {object} contactCache - contactStageCache { email: { stage, lastSentAt } }
 * @param {AutoSendRules} rules - 合并后的规则
 * @param {string} nowDate - 今日日期
 * @param {{ todaySent: number, queuePending: number }} limits - 上限信息
 * @returns {{ toSend: object[], skipped: object[], stats: object }}
 */
function buildAutoSendPlan(contacts, contactCache, rules, nowDate, limits) {
  if (!Array.isArray(contacts))
    return {
      toSend: [],
      skipped: [],
      stats: { total: 0, toSend: 0, skipped: 0 },
    };

  const toSend = [];
  const skipped = [];
  const byStage = {};
  const byType = {};

  for (const c of contacts) {
    const result = evaluateContact(c, contactCache, rules, nowDate);

    if (result.shouldSend) {
      // 检查上限
      const remaining =
        (rules.dailyLimit || 200) - (limits.todaySent || 0) - toSend.length;
      if (remaining <= 0) {
        skipped.push({ contact: c, reason: "已达每日上限" });
        continue;
      }

      toSend.push({
        contact: c,
        stage: result.stage,
        reason: result.reason,
        type: c.clientType || "unlabeled",
      });

      byStage[result.stage] = (byStage[result.stage] || 0) + 1;
      byType[c.clientType || "unlabeled"] =
        (byType[c.clientType || "unlabeled"] || 0) + 1;
    } else if (result.reason && !result.reason.startsWith("等待间隔")) {
      // 跳过的（排除等待间隔这种正常情况，减少噪音）
      skipped.push({ contact: c, reason: result.reason });
    }
  }

  return {
    toSend,
    skipped,
    stats: {
      total: contacts.length,
      toSend: toSend.length,
      skipped: skipped.length,
      byStage,
      byType,
    },
  };
}

// ── 近日规划（今明预计）───────────────────────────────────────────────────────

/**
 * 模拟计算今明两日预计发送的公司数/人数。
 *
 * @param {object[]} contacts - 全部联系人
 * @param {object} contactCache - contactStageCache
 * @param {AutoSendRules} rules - 合并后的规则
 * @param {string} nowDate - 今日日期
 * @returns {{ today: object, tomorrow: object, rules: AutoSendRules }}
 */
function buildForecast(contacts, contactCache, rules, nowDate) {
  const todayDate = nowDate || beijingToday();
  const tomorrowDate = addDays(todayDate, 1);

  const initDay = () => ({
    companies: new Set(),
    totalPeople: 0,
    byStage: {},
    noTemplate: 0,
  });

  const today = initDay();
  const tomorrow = initDay();

  for (const c of contacts) {
    // 跳过标签
    const tags = c.tags || [];
    if (SKIP_TAGS.some((t) => tags.includes(t))) continue;
    if (!c.email || !c.email.includes("@")) continue;

    const email = c.email.toLowerCase().trim();
    const cache = contactCache?.[email];
    let currentStage = "cold";
    let lastSentAt = null;

    if (cache) {
      currentStage = cache.stage || "cold";
      lastSentAt = cache.lastSentAt || null;
    }

    // 已到终态
    if (currentStage === "f4") continue;

    if (!lastSentAt) {
      // 从未发过 → 计入今日 cold
      addToDay(today, c, "cold");
      continue;
    }

    const next = nextStage(currentStage);
    if (!next) continue;

    const intervalKey = INTERVAL_KEYS[currentStage];
    const intervalDays = rules[intervalKey] || 5;
    const dueDate = addDays(lastSentAt, intervalDays);

    if (dueDate <= todayDate) {
      addToDay(today, c, next);
    } else if (dueDate === tomorrowDate) {
      addToDay(tomorrow, c, next);
    }
    // else: 远于明天，不纳入近期规划
  }

  return {
    today: formatDay(today),
    tomorrow: formatDay(tomorrow),
  };
}

/** @param {object} day @param {object} contact @param {string} stage */
function addToDay(day, contact, stage) {
  day.companies.add(contact.company || "未命名");
  day.totalPeople++;
  day.byStage[stage] = (day.byStage[stage] || 0) + 1;
}

/** @param {object} day @returns {object} */
function formatDay(day) {
  return {
    companies: day.companies.size,
    totalPeople: day.totalPeople,
    byStage: { ...day.byStage },
  };
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_RULES,
  SKIP_TAGS,
  STAGE_ORDER,
  INTERVAL_KEYS,
  beijingToday,
  daysBetween,
  addDays,
  nextStage,
  mergeRules,
  evaluateContact,
  buildAutoSendPlan,
  buildForecast,
};

// ══════════════════════════════════════════════════════════════════════════════
// JSDoc 类型定义
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {{
 *   cold_to_f1_days: number,
 *   f1_to_f2_days: number,
 *   f2_to_f3_days: number,
 *   f3_to_f4_days: number,
 *   dailyLimit: number,
 *   scanIntervalMinutes: number,
 * }} AutoSendRules
 */
