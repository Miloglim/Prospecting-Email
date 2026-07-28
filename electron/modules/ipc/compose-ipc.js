// ── Milogin's Prospector — Compose IPC 处理 ─────────────────────────────────
// 写邮件子窗口相关的 IPC handler：打开窗口、获取账号、发送邮件、查历史
"use strict";

const path = require("path");
const fs = require("fs");
const { BrowserWindow, ipcMain } = require("electron");
const { APP_ROOT } = require("../config");
const { Log } = require("../core/logger");
const { ok, fail } = require("../core/contract");

/** @type {BrowserWindow|null} */
let composeWin = null;
let composeInitData = null;

function createComposeWindow(initData, mainWindow) {
  // 复用已有窗口
  if (composeWin && !composeWin.isDestroyed()) {
    composeWin.focus();
    if (initData) {
      composeInitData = initData;
      composeWin.webContents.send("compose:init", initData);
    }
    return composeWin;
  }

  const preloadPath = __dirname.includes("dist")
    ? path.join(__dirname, "../../../preload/compose-preload.js")
    : path.join(__dirname, "../../compose-preload.js");

  composeInitData = initData || null;
  composeWin = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 500,
    minHeight: 420,
    title: "写邮件 — Milogin's Prospector",
    parent: mainWindow,
    frame: false,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发 / 打包路径
  if (process.env.VITE_DEV_SERVER_URL) {
    composeWin.loadURL(process.env.VITE_DEV_SERVER_URL + "#compose");
  } else {
    composeWin.loadFile(
        path.join(__dirname, "..", "..", "renderer", "compose.html"),
      );
  }

  composeWin.once("ready-to-show", () => {
    composeWin.show();
    if (composeInitData) {
      composeWin.webContents.send("compose:init", composeInitData);
    }
  });

  // 窗口状态变化 → 推送给渲染进程更新图标
  const emitState = () => {
    if (composeWin && !composeWin.isDestroyed()) {
      composeWin.webContents.send("compose:windowState", {
        maximized: composeWin.isMaximized(),
      });
    }
  };
  composeWin.on("maximize", emitState);
  composeWin.on("unmaximize", emitState);

  composeWin.on("closed", () => {
    composeWin = null;
    composeInitData = null;
  });

  return composeWin;
}

function register(mainIpc, deps) {
  // 主窗口触发：打开写邮件窗口
  mainIpc.handle("compose:open", async (_e, initData) => {
    try {
      createComposeWindow(initData, deps.mainWindow);
      return ok();
    } catch (e) {
      Log.error("compose", "打开窗口失败", e.stack);
      return fail(e.message);
    }
  });

  // 子窗口触发：获取初始化数据
  mainIpc.handle("compose:getInitData", async () => {
    return ok(composeInitData);
  });

  // 子窗口触发：获取可用发信账号
  mainIpc.handle("compose:getAccounts", async () => {
    try {
      const configPath = path.join(APP_ROOT, "send", "config.json");
      if (!fs.existsSync(configPath)) return ok([]);
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const accounts = (config.smtpAccounts || []).map((a) => ({
        id: a.id || "",
        label: a.label || a.smtp?.user || "",
        email: a.smtp?.user || "",
        host: a.smtp?.host || "",
        active: a.active !== false,
        fused: !!a.fused,
        signatureText: a.signatureText || config.signature?.text || "",
      }));
      return ok(accounts);
    } catch (e) {
      Log.error("compose", "读取账号失败", e.stack);
      return fail(e.message);
    }
  });

  // 子窗口触发：发送邮件
  mainIpc.handle("compose:send", async (_e, params) => {
    const { to, cc, bcc, subject, body, accountId } = params || {};
    if (!to || !subject || !body) return fail("收件人/主题/正文不能为空");

    try {
      // 读取配置
      const configPath = path.join(APP_ROOT, "send", "config.json");
      if (!fs.existsSync(configPath)) return fail("config.json 未找到");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const accounts = config.smtpAccounts || [];
      const account = accountId
        ? accounts.find((a) => a.id === accountId || a.smtp?.user === accountId)
        : accounts.find((a) => a.active !== false);
      if (!account?.smtp?.host) return fail("无可用发信账号");

      // 密码优先用环境变量
      const pass = process.env.SMTP_PASS || account.smtp.pass || "";

      // 构建签名
      const sigText =
        account.signatureText ||
        config.signature?.text ||
        "金颖哲 Zayne Jin | YQN Logistics\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com";
      const sigStore = require("../services/signature-store");
      const sigHtml = sigStore.readSignature(account.id);

      // 正文 + 签名
      const { buildContent } = require("../services/send-engine");
      const { textBody, html } = buildContent(body, sigText, sigHtml);

      // 发件人
      const fromName = config.sender?.name || account.label || "";
      const fromAddr = `"${fromName}" <${account.smtp.user}>`;

      // 构建收件人列表
      const toList =
        typeof to === "string"
          ? to
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : to;
      const ccList = cc
        ? typeof cc === "string"
          ? cc
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : cc
        : [];
      const bccList = bcc
        ? typeof bcc === "string"
          ? bcc
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : bcc
        : [];

      // ponytail: nodemailer transporter
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port || 587,
        secure: account.smtp.port === 465,
        auth: { user: account.smtp.user, pass },
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });

      const mailOpts = {
        from: fromAddr,
        to: toList.join(", "),
        subject,
        text: textBody,
        html,
      };
      if (ccList.length) mailOpts.cc = ccList.join(", ");
      if (bccList.length) mailOpts.bcc = bccList.join(", ");

      const info = await transporter.sendMail(mailOpts);
      await transporter.close();

      // 写发送记录
      try {
        const sendLogDb = require("../services/send-log-db");
        const beijingToday = () => {
          // borrow from send-engine or inline
          const d = new Date();
          const dp = d.toLocaleDateString("en-CA", {
            timeZone: "Asia/Shanghai",
          });
          return dp;
        };
        for (const addr of toList) {
          sendLogDb.add({
            index: 0,
            to: addr,
            company: "",
            subject,
            messageId: info.messageId,
            count: 1,
            bodyId: "",
            _stage: "",
            _lang: "",
            _type: "unlabeled",
            _country: "",
            _tplInfo: "",
            _templateSource: "",
            _templateLabel: "",
            _batchLabel: "manual",
            time: new Date().toISOString(),
            time_beijing: beijingToday(),
            status: "sent",
            error: "",
            _test: false,
            _accountId: account.id || account.smtp?.user || "",
          });
        }
      } catch (e) {
        Log.error("compose", "写发送记录失败", e.stack);
      }

      // 更新联系人 last_sent_at
      try {
        const contactsDb = require("../services/contacts-db");
        const now = new Date().toISOString();
        for (const addr of toList) {
          const contact = contactsDb.getByEmail(addr);
          if (contact)
            contactsDb.update(contact.id, {
              last_sent_at: now,
              last_sent_acct: account.label || account.smtp?.user || "",
            });
        }
      } catch {
        /* 静默跳过 */
      }

      // 记录互动
      try {
        const contactsDb = require("../services/contacts-db");
        const interactionsDb = require("../services/interactions-db");
        for (const addr of toList) {
          const contact = contactsDb.getByEmail(addr);
          if (contact)
            interactionsDb.add({
              contact_id: contact.id,
              company_id: contact.company_id || "",
              type: "sent",
              direction: "outbound",
              subject,
              snippet: (body || "").slice(0, 200),
            });
        }
      } catch {
        /* 互动记录不影响发送 */
      }

      Log.info("compose", `手动发信: ${toList.length} 人 → ${subject}`);
      return ok({ messageId: info.messageId });
    } catch (e) {
      Log.error("compose", "发送失败", e.stack);
      return fail(e.message);
    }
  });

  // 子窗口触发：查发送历史
  mainIpc.handle("compose:getThread", async (_e, email) => {
    try {
      const sendLogDb = require("../services/send-log-db");
      const records = sendLogDb.getByEmail(email, 20);
      return ok(records);
    } catch (e) {
      Log.error("compose", "查历史失败", e.stack);
      return fail(e.message);
    }
  });

  // 子窗口触发：最大化/还原
  mainIpc.handle("compose:toggleMaximize", async () => {
    if (composeWin && !composeWin.isDestroyed()) {
      if (composeWin.isMaximized()) composeWin.unmaximize();
      else composeWin.maximize();
    }
    return ok();
  });

  // 子窗口触发：保存草稿（按联系人邮箱覆盖）
  mainIpc.handle("compose:saveDraft", async (_e, contactEmail, data) => {
    try {
      const draftsPath = path.join(APP_ROOT, "data", "drafts.json");
      const dir = path.dirname(draftsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let drafts = {};
      try {
        if (fs.existsSync(draftsPath))
          drafts = JSON.parse(fs.readFileSync(draftsPath, "utf-8"));
      } catch { /* 文件损坏 → 空对象 */ }
      const key = (contactEmail || "").toLowerCase().trim();
      drafts[key] = { ...data, savedAt: new Date().toISOString() };
      // 清理无内容的草稿
      if (!data.to && !data.subject && !data.body) delete drafts[key];
      // 最多保留 200 条
      const keys = Object.keys(drafts);
      if (keys.length > 200) {
        keys.sort((a, b) => (drafts[a].savedAt || "").localeCompare(drafts[b].savedAt || ""));
        keys.slice(0, keys.length - 200).forEach(k => delete drafts[k]);
      }
      fs.writeFileSync(draftsPath, JSON.stringify(drafts, null, 2));
      Log.info("compose", `草稿已保存: ${key}`);
      return ok();
    } catch (e) {
      Log.error("compose", "保存草稿失败", e.stack);
      return fail(e.message);
    }
  });

  // 子窗口触发：加载草稿
  mainIpc.handle("compose:loadDraft", async (_e, contactEmail) => {
    try {
      const draftsPath = path.join(APP_ROOT, "data", "drafts.json");
      if (!fs.existsSync(draftsPath)) return ok(null);
      const drafts = JSON.parse(fs.readFileSync(draftsPath, "utf-8"));
      const key = (contactEmail || "").toLowerCase().trim();
      return ok(drafts[key] || null);
    } catch {
      return ok(null);
    }
  });

  // 子窗口触发：关闭窗口
  mainIpc.handle("compose:close", async () => {
    composeInitData = null;
    if (composeWin && !composeWin.isDestroyed()) composeWin.close();
    return ok();
  });
}

function closeComposeWindow() {
  if (composeWin && !composeWin.isDestroyed()) composeWin.close();
}

module.exports = { register, createComposeWindow, closeComposeWindow };
