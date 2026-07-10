// ── 自动发送 — 调度引擎 ────────────────────────────────────────────────────
// 职责：定时巡检 → 决策 → 组装邮件 → 触发发送 → 记录结果。
// 独立队列，不跟人工发送的 sendQueue 混用。
// 依赖：core/rules（纯决策）、services/state（持久化）、services/assembler（邮件组装）

"use strict";

const fs = require("fs");
const path = require("path");
const { APP_ROOT } = require("../../config");
const { Log } = require("../../core/logger");
const rules = require("../core/rules");
const { getState } = require("./state");
const assembler = require("./assembler");
const engine = require("../../services/send-engine");

// ── 常量 ─────────────────────────────────────────────────────────────────────
const CONTACTS_PATH = path.join(APP_ROOT, "data", "contacts.json");
const CONFIG_PATH = path.join(APP_ROOT, "send", "config.json");

// ── AutoScheduler 类 ─────────────────────────────────────────────────────────

class AutoScheduler {
  /**
   * @param {object} deps - 依赖注入
   * @param {object} deps.mainWindow - Electron BrowserWindow
   * @param {boolean} deps._sendInProgress - 是否正在发送
   * @param {object[]} deps.sendQueue - 共享发送队列
   * @param {boolean} deps.isPaused - 暂停标志
   * @param {boolean} deps.currentSendAbort - 取消标志
   * @param {object|null} deps.templateLib - 模板库
   * @param {object|null} deps.currentTransporter - 当前 transporter
   * @param {object|null} deps.currentAccount - 当前账号
   */
  constructor(deps) {
    this._deps = deps;
    this._state = getState();
    this._timer = null;
    /** @type {object[]} 自动发送独立队列 */
    this._autoQueue = [];
  }

  // ── 启动/停止 ────────────────────────────────────────────────────────────

  /**
   * 启动调度器。如果已在运行则忽略。
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async start() {
    if (this._timer) return { ok: false, message: "调度器已在运行中" };

    try {
      const state = await this._state.updateWithLock((s) => {
        s.status = "running";
        return s;
      });

      this._startTimer(state.rules.scanIntervalMinutes || 5);
      Log.info(
        "auto-scheduler",
        "调度器已启动, 巡检间隔 " +
          (state.rules.scanIntervalMinutes || 5) +
          " 分钟",
      );
      this._pushStatus();

      return { ok: true, message: "已启动" };
    } catch (e) {
      Log.error("auto-scheduler", "启动失败", e);
      return { ok: false, message: "启动失败: " + e.message };
    }
  }

  /**
   * 停止调度器。
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async stop() {
    this._clearTimer();

    try {
      await this._state.updateWithLock((s) => {
        s.status = "idle";
        return s;
      });
      Log.info("auto-scheduler", "调度器已停止");
      this._pushStatus();
      return { ok: true, message: "已停止" };
    } catch (e) {
      Log.error("auto-scheduler", "停止失败", e);
      return { ok: false, message: "停止失败" };
    }
  }

  // ── 获取状态 ──────────────────────────────────────────────────────────────

  /**
   * 获取当前调度器状态。
   * @returns {{ status: string, lastScanAt: string|null, nextScanAt: string|null, todaySent: number, dailyLimit: number, rules: object }}
   */
  getStatus() {
    const s = this._state.load();
    return {
      status: s.status,
      lastScanAt: s.lastScanAt,
      nextScanAt: s.nextScanAt,
      todaySent: s.todaySent,
      todayDate: s.todayDate,
      dailyLimit: (s.rules || {}).dailyLimit || 200,
      rules: { ...(s.rules || {}) },
    };
  }

  // ── 近日规划 ──────────────────────────────────────────────────────────────

  /**
   * 计算今明两日预计发送情况（聚合统计）。
   * @returns {{ today: object, tomorrow: object }}
   */
  getForecast() {
    const contacts = this._loadContacts();
    const s = this._state.load();
    const mergedRules = rules.mergeRules(s.rules);
    const nowDate = rules.beijingToday();
    return rules.buildForecast(
      contacts,
      s.contactStageCache,
      mergedRules,
      nowDate,
    );
  }

  /**
   * 获取当前详细发送计划（谁、什么阶段、为什么）。
   * 纯预览，无副作用，不执行发送。
   * @returns {{ items: object[], stats: object, rules: object }}
   */
  getPlan() {
    const contacts = this._loadContacts();
    const s = this._state.load();
    const mergedRules = rules.mergeRules(s.rules);
    const nowDate = rules.beijingToday();

    const plan = rules.buildAutoSendPlan(
      contacts,
      s.contactStageCache,
      mergedRules,
      nowDate,
      { todaySent: s.todaySent || 0, queuePending: this._autoQueue.length },
    );

    // 为每条计划附加语言和关键联系人信息
    const items = plan.toSend.map((item) => ({
      company: item.contact.company || "未命名",
      email: item.contact.email || "",
      name: item.contact.firstName ||
        item.contact.contactName ||
        item.contact.email ||
        "",
      country: item.contact.country || "",
      type: item.type,
      stage: item.stage,
      reason: item.reason,
      lang: assembler.countryToLang(item.contact.country || ""),
    }));

    // 只展示真正被"跳过"的（标签过滤/无邮箱），排除已达上限的（只是推迟）
    const meaningfulSkipped = plan.skipped
      .filter((s) => s.reason !== "已达每日上限")
      .map((s) => ({
        company: s.contact?.company || "",
        email: s.contact?.email || "",
        reason: s.reason,
      }));

    return {
      items,
      skipped: meaningfulSkipped,
      stats: {
        ...plan.stats,
        skipped: meaningfulSkipped.length, // 覆写为真正的跳过数
        dailyLimit: mergedRules.dailyLimit || 200,
        todaySent: s.todaySent || 0,
        remaining: Math.max(
          0,
          (mergedRules.dailyLimit || 200) - (s.todaySent || 0),
        ),
      },
      rules: { ...mergedRules },
    };
  }

  // ── 更新规则 ──────────────────────────────────────────────────────────────

  /**
   * 更新阶段间隔等规则配置。
   * @param {object} newRules
   * @returns {Promise<{ ok: boolean }>}
   */
  async updateRules(newRules) {
    try {
      await this._state.updateWithLock((s) => {
        s.rules = { ...s.rules, ...newRules };
        return s;
      });
      Log.info("auto-scheduler", "规则已更新");
      return { ok: true };
    } catch (e) {
      Log.error("auto-scheduler", "更新规则失败", e);
      return { ok: false, message: e.message };
    }
  }

  // ── 决策日志 ──────────────────────────────────────────────────────────────

  /**
   * 获取最近 N 条决策日志。
   * @param {number} [n=20]
   * @returns {object[]}
   */
  getDecisionLog(n) {
    return this._state.getRecentLogs(n);
  }

  // ── 内部：定时器 ──────────────────────────────────────────────────────────

  /** @param {number} intervalMinutes */
  _startTimer(intervalMinutes) {
    this._clearTimer();
    const ms = (intervalMinutes || 5) * 60 * 1000;

    // 立即执行一次
    this._scan().catch((e) => Log.error("auto-scheduler", "首次巡检异常", e));

    this._timer = setInterval(() => {
      this._scan().catch((e) => Log.error("auto-scheduler", "巡检异常", e));
    }, ms);
  }

  _clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ── 内部：巡检核心（两阶段：决策持锁 → 执行放锁）───────────────────────

  async _scan() {
    // 阶段一：决策（持锁，快速完成）
    let batch = null;
    try {
      batch = await this._state.updateWithLock(async (s) => {
        if (s.status !== "running") return null; // 已停止

        const nowDate = rules.beijingToday();

        // 跨日重置计数
        if (s.todayDate !== nowDate) {
          s.todayDate = nowDate;
          s.todaySent = 0;
        }

        const mergedRules = rules.mergeRules(s.rules);
        const contacts = this._loadContacts();

        const plan = rules.buildAutoSendPlan(
          contacts,
          s.contactStageCache,
          mergedRules,
          nowDate,
          {
            todaySent: s.todaySent,
            queuePending: this._autoQueue.length,
          },
        );

        Log.info(
          "auto-scheduler",
          `巡检: ${plan.toSend.length} 待发, ${plan.skipped.length} 跳过`,
        );

        s.lastScanAt = new Date().toISOString();
        s.nextScanAt = new Date(
          Date.now() + (mergedRules.scanIntervalMinutes || 5) * 60000,
        ).toISOString();

        if (!plan.toSend.length) return null;

        // 组装邮件
        const emails = this._assembleBatch(plan.toSend, s);
        if (!emails.length) return null;

        // 检查是否已有发送任务在进行
        if (this._deps._sendInProgress) {
          Log.info("auto-scheduler", "发送任务进行中，跳过本次执行");
          return null;
        }

        // 返回批次数据（不在这里执行发送）
        return { emails, plan, s };
      });
    } catch (e) {
      if (e.message === "State busy") {
        Log.info("auto-scheduler", "上一次巡检未完成，跳过");
      } else {
        Log.error("auto-scheduler", "巡检决策失败", e);
      }
      return;
    }

    if (!batch) return;

    // 阶段二：执行发送（不持锁）
    try {
      await this._executeSend(batch.emails, batch.plan);
    } catch (e) {
      Log.error("auto-scheduler", "巡检执行失败", e);
    }

    // 阶段三：更新状态（持锁，回写结果）
    try {
      await this._state.updateWithLock(async (s) => {
        for (const email of batch.emails) {
          const recipientEmail = (email.to || "").toLowerCase().trim();
          if (!recipientEmail) continue;

          s.contactStageCache[recipientEmail] = {
            stage: email._stage || "cold",
            lastSentAt: rules.beijingToday(),
          };

          // 同步阶段到 contacts 表
          try {
            const contactsDb = require("../../services/contacts-db");
            const contact = contactsDb.getByEmail(recipientEmail);
            if (contact && email._stage) contactsDb.setStage(contact.id, email._stage, "auto:send");
          } catch { /* 降级 */ }

          s.todaySent = (s.todaySent || 0) + 1;

          this._state.addLog({
            email: recipientEmail,
            company: email.company,
            decision: `send_${email._stage}`,
            stage: email._stage,
            reason:
              batch.plan.toSend.find(
                (p) =>
                  (p.contact?.email || "").toLowerCase() === recipientEmail,
              )?.reason || "",
            template: email._tplInfo || "",
            result: "sent",
          });
        }
        this._pushStatus();
        return s;
      });
    } catch (e) {
      Log.error("auto-scheduler", "巡检结果回写失败", e);
    }
  }

  // ── 内部：组装邮件批次 ────────────────────────────────────────────────────

  /**
   * @param {object[]} planItems - buildAutoSendPlan 返回的 toSend 数组
   * @param {object} s - 当前状态
   * @returns {object[]} 组装好的邮件对象（可直接送 send-engine）
   */
  _assembleBatch(planItems, s) {
    const tplLib = this._deps.templateLib;
    const config = this._loadConfig();
    const senderName =
      config?.sender?.bodyName || config?.sender?.name || "Zayne";
    const senderEmail = config?.sender?.email || "";
    const sigPath = path.join(APP_ROOT, "send", "signature.html");
    let sigText = "";
    try {
      if (fs.existsSync(sigPath)) sigText = fs.readFileSync(sigPath, "utf-8");
    } catch {
      /* 签名文件读取失败不影响组装 */
    }

    const emails = [];

    for (const item of planItems) {
      const { contact, stage, type } = item;
      const lang = assembler.countryToLang(contact.country || "");
      const usedIds = []; // ponytail: 当前批次内去重，不做跨批次去重

      const picked = assembler.randomPick(tplLib, type, stage, usedIds);
      if (picked.hook) usedIds.push(picked.hook.id);
      if (picked.pain) usedIds.push(picked.pain.id);
      if (picked.proof) usedIds.push(picked.proof.id);
      if (picked.cta) usedIds.push(picked.cta.id);
      if (picked.followup) usedIds.push(picked.followup.id);

      const assembled = assembler.assembleEmail(
        lang,
        picked,
        stage,
        type,
        senderName,
        contact.firstName || contact.contactName || "",
        contact.company || "",
      );

      if (!assembled.subject || !assembled.body) {
        this._state.addLog({
          email: contact.email,
          company: contact.company,
          decision: "skip",
          reason: "模板组装失败",
          result: "skipped",
        });
        continue;
      }

      // 构建 send-engine 兼容的邮件对象
      const recipients = [contact.email].filter(Boolean);
      emails.push({
        id:
          "auto_" +
          Date.now().toString(36) +
          Math.random().toString(36).slice(2, 6),
        company: contact.company || "未命名",
        to: contact.email,
        recipients,
        subject: assembled.subject,
        body: assembled.body,
        _stage: stage,
        _lang: lang,
        _type: type,
        _country: contact.country || "",
        _tplInfo: picked.hook ? `hook:${picked.hook.id}` : "",
        _templateSource: "preset",
        _templateLabel: "自动发送",
        _batchLabel: "auto",
        _recipientStatus: recipients.map((r) => ({
          email: r,
          status: "pending",
        })),
        status: "pending",
      });
    }

    return emails;
  }

  // ── 内部：执行发送 ────────────────────────────────────────────────────────

  /**
   * 执行发送（不持锁，不返回状态）。
   * @param {object[]} emails
   * @param {object} plan
   */
  async _executeSend(emails, plan) {
    this._deps._sendInProgress = true;
    this._deps.sendQueue.length = 0;
    this._deps.sendQueue.push(...emails);
    this._deps.isPaused = false;

    const sendProgress = (data) => {
      const w = this._deps.mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send("auto:progress", { ...data, _source: "auto" });
      }
    };

    Log.info("auto-scheduler", `执行发送: ${emails.length} 封`);

    try {
      await engine.runSendBatch(this._deps, sendProgress);
    } catch (e) {
      Log.error("auto-scheduler", "发送引擎异常", e);
    } finally {
      this._deps._sendInProgress = false;
      this._deps.sendQueue.length = 0;
    }
  }

  // ── 内部：同步 send-history.json ──────────────────────────────────────────

  /**
   * 将自动发送结果写入 send-history.json，确保 compose 页面能正确判断已发送。
   */
  _syncSendHistory(emails) {
    try {
      const shp = path.join(APP_ROOT, "data", "send-history.json");
      let hist = {};
      try {
        if (fs.existsSync(shp)) hist = JSON.parse(fs.readFileSync(shp, "utf-8"));
      } catch { /* 文件损坏 → 重建 */ }
      const now = new Date().toISOString();
      // 按公司分组
      const byCompany = {};
      for (const e of emails) {
        const name = e.company || "未命名";
        if (!byCompany[name]) byCompany[name] = [];
        byCompany[name].push(e.to || "");
      }
      for (const [name, recipients] of Object.entries(byCompany)) {
        const existing = hist[name] || {};
        const sentContacts = [
          ...new Set([
            ...(existing.sentContacts || []),
            ...recipients.map((r) => r.toLowerCase().trim()),
          ]),
        ];
        // 取该公司的最高已发阶段
        const companyEmails = emails.filter((e) => (e.company || "未命名") === name);
        const maxStage = companyEmails.reduce(
          (max, e) => {
            const order = ["cold", "f1", "f2", "f3", "f4"];
            return order.indexOf(e._stage) > order.indexOf(max) ? e._stage : max;
          },
          existing.stage || "cold",
        );
        hist[name] = {
          ...existing,
          stage: maxStage,
          lastSent: now,
          sentCount: (existing.sentCount || 0) + recipients.length,
          sentContacts,
          startedAt: existing.startedAt || now,
        };
      }
      const dir = path.dirname(shp);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(shp, JSON.stringify(hist, null, 2));
    } catch (e) {
      Log.error("auto-scheduler", "同步发送历史失败", e);
    }
  }

  // ── 内部：加载数据 ────────────────────────────────────────────────────────

  /** @returns {object[]} */
  _loadContacts() {
    try {
      if (fs.existsSync(CONTACTS_PATH)) {
        return JSON.parse(fs.readFileSync(CONTACTS_PATH, "utf-8"));
      }
    } catch (e) {
      Log.warn("auto-scheduler", "联系人加载失败", e.stack);
    }
    return [];
  }

  /** @returns {object|null} */
  _loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      }
    } catch (e) {
      Log.warn("auto-scheduler", "配置加载失败", e.stack);
    }
    return null;
  }

  // ── 内部：推送状态 ────────────────────────────────────────────────────────

  _pushStatus() {
    const w = this._deps.mainWindow;
    if (w && !w.isDestroyed()) {
      w.webContents.send("auto:status", this.getStatus());
    }
  }
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

module.exports = { AutoScheduler };
