// ── Milogin's Prospector — Compose 窗口逻辑 ──────────────────────────────
// 写邮件子窗口：发件人选择、收件人管理、格式编辑、附件、发送
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── 状态 ──────────────────────────────────────────────────────────────────
let _accounts = [];
let _selectedAcct = null;
let _linkedAccount = ""; // 对接该联系人的发信邮箱
let _contactEmail = ""; // 当前联系人邮箱（草稿 key）
let _draftDirty = false; // 是否有未保存修改
let _loadingDraft = false; // 加载草稿时忽略 input 事件

// ── 工具函数 ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showToast(msg, type = "ok") {
  const el = $("#toast");
  el.className = type + " show";
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2500);
}

function getToEmails() {
  const chips = $$("#to-chips .chip");
  const arr = [];
  chips.forEach(c => { arr.push(c.dataset.email); });
  const raw = $("#to-input").value.trim();
  if (raw) raw.split(",").forEach(s => { const e = s.trim(); if (e) arr.push(e); });
  return [...new Set(arr)];
}

// ── 收件人 Chip ───────────────────────────────────────────────────────────
function addChip(email) {
  email = email.trim().toLowerCase();
  if (!email.includes("@")) return;
  const chips = $$("#to-chips .chip");
  for (const c of chips) { if (c.dataset.email === email) return; }
  const row = $("#to-chips");
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.dataset.email = email;
  chip.innerHTML = `${escapeHtml(email)} <span class="rm">&times;</span>`;
  chip.querySelector(".rm").addEventListener("click", () => chip.remove());
  row.appendChild(chip);
}

// ── 格式栏 ────────────────────────────────────────────────────────────────
function execCmd(cmd, val) {
  document.execCommand(cmd, false, val || null);
  $("#body-editor").focus();
}

function bindToolbar() {
  // 用 lucide 图标美化工具栏
  if (window.lucide) {
    $("#tb-bold").innerHTML = window.lucide("bold", 14);
    $("#tb-italic").innerHTML = window.lucide("italic", 14);
    $("#tb-underline").innerHTML = window.lucide("underline", 14);
    $("#tb-ul").innerHTML = window.lucide("list", 14);
    $("#tb-ol").innerHTML = window.lucide("list-ordered", 14);
    $("#tb-link").innerHTML = window.lucide("link", 14);
  }
  $("#tb-bold").addEventListener("click", () => execCmd("bold"));
  $("#tb-italic").addEventListener("click", () => execCmd("italic"));
  $("#tb-underline").addEventListener("click", () => execCmd("underline"));
  $("#tb-ul").addEventListener("click", () => execCmd("insertUnorderedList"));
  $("#tb-ol").addEventListener("click", () => execCmd("insertOrderedList"));
  $("#tb-link").addEventListener("click", () => {
    const url = prompt("链接地址:");
    if (url) execCmd("createLink", url);
  });

  // 快捷键更新按钮状态
  $("#body-editor").addEventListener("keyup", updateToolbarState);
  $("#body-editor").addEventListener("mouseup", updateToolbarState);
}

function updateToolbarState() {
  $$("#toolbar button").forEach(b => {
    if (b.id.startsWith("tb-")) {
      const cmd = { "tb-bold": "bold", "tb-italic": "italic", "tb-underline": "underline" }[b.id];
      if (cmd) b.classList.toggle("active", document.queryCommandState(cmd));
    }
  });
}

// ── 发件人自定义下拉 ──────────────────────────────────────────────────────
function renderFromSelect() {
  const wrap = $("#from-wrap");
  const display = $("#from-display");
  const drop = $("#from-drop");

  // 默认选中第一个可用账号（仅在尚未确定时）
  if (!_selectedAcct) _selectedAcct = _accounts.find(a => a.active && !a.fused) || _accounts[0];

  function refreshDisplay() {
    const a = _selectedAcct || _accounts[0];
    if (!a) return;
    const color = a.active ? (a.fused ? "#e6a817" : "#22a644") : "#999";
    const dot = display.querySelector(".dot");
    const label = display.querySelector(".label");
    dot.style.background = color;
    label.textContent = a.label || a.email;
  }

  function renderOptions() {
    // 判断哪个账号是此联系人的对接邮箱
    const isLinked = (a) => _linkedAccount && (
      a.email === _linkedAccount || a.label === _linkedAccount || a.id === _linkedAccount
    );
    drop.innerHTML = _accounts.map(a => {
      const color = a.active ? (a.fused ? "#e6a817" : "#22a644") : "#999";
      const status = !a.active ? "已停用" : a.fused ? "熔断中" : "";
      const linked = isLinked(a) ? " · 对接邮箱" : "";
      const isActive = _selectedAcct && (_selectedAcct.email === a.email || _selectedAcct.id === a.id);
      return `<div class="item${isActive ? " active" : ""}" data-email="${escapeHtml(a.email)}" data-id="${escapeHtml(a.id||a.email)}">
        <span class="dot" style="background:${color}"></span>
        <span class="info">
          <div>${escapeHtml(a.label || a.email)}</div>
          <div class="email">${escapeHtml(a.email)}${linked}${status ? " · " + status : ""}</div>
        </span>
      </div>`;
    }).join("");

    drop.querySelectorAll(".item").forEach(item => {
      item.addEventListener("click", () => {
        const email = item.dataset.email;
        const id = item.dataset.id;
        _selectedAcct = _accounts.find(a => a.email === email || a.id === id) || _accounts[0];
        refreshDisplay();
        renderOptions();
        closeDrop();
        upsertSignature();
      });
    });
  }

  function openDrop() {
    drop.classList.add("open");
    wrap.classList.add("open");
  }

  function closeDrop() {
    drop.classList.remove("open");
    wrap.classList.remove("open");
  }

  // 防止重复绑定事件
  if (!wrap._bound) {
    wrap._bound = true;
    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      drop.classList.contains("open") ? closeDrop() : openDrop();
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) closeDrop();
    });
  }

  refreshDisplay();
  renderOptions();
}

// ── 签名嵌入 ──────────────────────────────────────────────────────────────
const SIG_ID = 'signature-block';

function upsertSignature() {
  const editor = $('#body-editor');
  const sigHtml = _selectedAcct?.signatureHtml || '';
  let sigBlock = document.getElementById(SIG_ID);
  const quoteHtml = editor.dataset.quoteHtml || '';

  if (sigBlock) {
    // 切换账号：替换已有签名
    sigBlock.innerHTML = sigHtml;
  } else if (sigHtml) {
    // 确保正文区至少有一个空行（光标落点）
    if (!editor.textContent.trim()) {
      editor.innerHTML = '<p><br></p>';
    }
    // 签名块：不可编辑，防止光标误入
    sigBlock = document.createElement('div');
    sigBlock.id = SIG_ID;
    sigBlock.contentEditable = 'false';
    sigBlock.innerHTML = sigHtml;
    editor.appendChild(sigBlock);

    // 光标定位到正文区末尾（签名块之前）
    const range = document.createRange();
    const bodyEnd = editor.lastChild === sigBlock
      ? sigBlock.previousSibling || editor.firstChild
      : editor.lastChild;
    range.setStartAfter(bodyEnd);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 引用块：签名之后追加
  let quoteBlock = document.getElementById('quote-block');
  if (quoteHtml) {
    if (!quoteBlock) {
      quoteBlock = document.createElement('div');
      quoteBlock.id = 'quote-block';
      quoteBlock.contentEditable = 'false';
      editor.appendChild(quoteBlock);
    }
    quoteBlock.innerHTML = quoteHtml;
  } else if (quoteBlock) {
    quoteBlock.remove();
  }
}

// ── 标题栏 ────────────────────────────────────────────────────────────────
let _maximized = false;
function bindTitleBar() {
  if (window.lucide) {
    $("#btn-max").innerHTML = window.lucide("square", 14);
    $("#btn-close").innerHTML = window.lucide("x", 16);
  }
  $("#btn-max").addEventListener("click", () => window.composeAPI?.toggleMaximize());
  $("#btn-close").addEventListener("click", () => closeWithPrompt());

  // 监听窗口最大化/还原状态
  if (window.composeAPI?.onWindowState) {
    window.composeAPI.onWindowState(({ maximized }) => {
      _maximized = maximized;
      if (window.lucide) {
        $("#btn-max").innerHTML = window.lucide(maximized ? "copy" : "square", 14);
      }
    });
  }
}

// ── 关闭前检查 ────────────────────────────────────────────────────────────
function hasContent() {
  const to = getToEmails().length > 0;
  const subject = $("#subject-input").value.trim();
  const body = $("#body-editor").innerHTML.replace(/<br\s*\/?>/gi,"").trim();
  return to || subject || body;
}

async function closeWithPrompt() {
  if (!_draftDirty || !hasContent()) {
    window.composeAPI?.close();
    return;
  }
  const action = await showComposeConfirm("是否保存草稿？", ["保存", "不保存", "取消"]);
  if (action === "保存") {
    await doSaveDraft();
    window.composeAPI?.close();
  } else if (action === "不保存") {
    window.composeAPI?.close();
  }
  // "取消" → 什么都不做
}

function showComposeConfirm(msg, buttons) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center";
    const html = buttons.map((b, i) =>
      `<button class="cfm-btn" data-idx="${i}" style="${i === 0 ? "background:var(--primary);color:#fff" : ""}">${b}</button>`
    ).join("");
    overlay.innerHTML = `<div style="background:var(--card-bg);border-radius:8px;padding:24px 28px;box-shadow:0 8px 32px rgba(0,0,0,.12);text-align:center;min-width:260px">
      <p style="margin:0 0 20px;font-size:14px;color:var(--text)">${msg}</p>
      <div style="display:flex;gap:8px;justify-content:center">${html}</div>
    </div>`;
    overlay.querySelectorAll(".cfm-btn").forEach(btn => {
      Object.assign(btn.style, {
        padding: "6px 18px", border: "1px solid var(--border)", borderRadius: "5px",
        cursor: "pointer", fontSize: "13px", background: "var(--card-bg)", color: "var(--text)",
      });
      btn.addEventListener("click", () => { overlay.remove(); resolve(buttons[parseInt(btn.dataset.idx)]); });
    });
    document.body.appendChild(overlay);
  });
}

// ── 保存草稿（按联系人邮箱覆盖）─────────────────────────────────────────
async function doSaveDraft() {
  if (!_contactEmail) { showToast("缺少联系人邮箱", "err"); return; }
  const data = {
    to: getToEmails().join(", "),
    cc: $("#cc-input").value.trim(),
    bcc: $("#bcc-input").value.trim(),
    subject: $("#subject-input").value.trim(),
    body: $("#body-editor").innerHTML,
    accountId: _selectedAcct?.email || _selectedAcct?.id || "",
  };
  try {
    const r = await window.composeAPI.saveDraft(_contactEmail, data);
    if (r.ok) { showToast("已保存", "ok"); _draftDirty = false; }
    else showToast("保存失败", "err");
  } catch { showToast("保存失败", "err"); }
}

// ── 加载草稿 ──────────────────────────────────────────────────────────────
async function loadDraft(email) {
  try {
    const r = await window.composeAPI.loadDraft(email);
    if (!r.ok || !r.data) return;
    _loadingDraft = true;
    const d = r.data;
    if (d.to) d.to.split(",").forEach(s => addChip(s.trim()));
    if (d.cc) $("#cc-input").value = d.cc;
    if (d.bcc) $("#bcc-input").value = d.bcc;
    if (d.subject) $("#subject-input").value = d.subject;
    if (d.body) $("#body-editor").innerHTML = d.body;
    if (d.accountId) {
      const acct = _accounts.find(a => a.email === d.accountId || a.id === d.accountId);
      if (acct && acct.active && !acct.fused) _selectedAcct = acct;
    }
    // 展开抄送/密送（如果有内容）
    if (d.cc || d.bcc) {
      if (d.cc) { $("#cc-row").classList.add("open"); $("#toggle-cc").style.fontWeight = "600"; }
      if (d.bcc) { $("#bcc-row").classList.add("open"); if (!$("#cc-row").classList.contains("open")) $("#toggle-cc").style.fontWeight = "600"; }
      $("#cc-row").classList.toggle("open", !!d.cc);
      $("#bcc-row").classList.toggle("open", !!d.bcc);
      if (d.cc || d.bcc) $("#toggle-cc").style.fontWeight = "600";
    }
    _draftDirty = false;
  } catch { /* 降级 */ }
  _loadingDraft = false;
}

// ── 收件人输入 ────────────────────────────────────────────────────────────
function bindRecipients() {
  const inp = $("#to-input");
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = inp.value.trim().replace(/,/g, "");
      if (val) { addChip(val); inp.value = ""; }
    }
    if (e.key === "Backspace" && !inp.value) {
      const chips = $$("#to-chips .chip");
      if (chips.length) chips[chips.length - 1].remove();
    }
  });

  // 抄送/密送 合并折叠
  $("#toggle-cc").addEventListener("click", () => {
    const open = $("#cc-row").classList.toggle("open");
    $("#bcc-row").classList.toggle("open", open);
    $("#toggle-cc").style.fontWeight = open ? "600" : "";
  });

  // 标记脏数据
  function markDirty() { if (!_loadingDraft) _draftDirty = true; }
  $("#to-input").addEventListener("input", markDirty);
  $("#cc-input").addEventListener("input", markDirty);
  $("#bcc-input").addEventListener("input", markDirty);
  $("#subject-input").addEventListener("input", markDirty);
  $("#body-editor").addEventListener("input", markDirty);
}

// ── 发送 ──────────────────────────────────────────────────────────────────
async function doSend() {
  const toList = getToEmails();
  if (!toList.length) { showToast("请填写收件人", "err"); return; }
  const subject = $("#subject-input").value.trim();
  if (!subject) { showToast("请填写主题", "err"); return; }
  const body = $("#body-editor").innerHTML.trim();
  if (!body || body === "<br>") { showToast("请填写正文", "err"); return; }

  const btn = $("#btn-send");
  btn.disabled = true;
  btn.classList.add("loading");
  btn.textContent = "发送中...";

  const params = {
    to: toList.join(", "),
    cc: $("#cc-input").value.trim() || "",
    bcc: $("#bcc-input").value.trim() || "",
    subject,
    body,
    accountId: _selectedAcct?.email || _selectedAcct?.id || "",
  };

  try {
    const r = await window.composeAPI.send(params);
    if (r.ok) {
      showToast("发送成功", "ok");
      setTimeout(() => window.composeAPI.close(), 800);
    } else {
      showToast(r.error || "发送失败", "err");
    }
  } catch (e) {
    showToast("发送异常: " + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = "发送";
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────
async function init() {
  bindTitleBar();
  bindToolbar();
  bindRecipients();

  // Ctrl+Enter 发送
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      doSend();
    }
  });

  // 加载账号
  try {
    const r = await window.composeAPI.getAccounts();
    if (r.ok) _accounts = r.data || [];
    renderFromSelect();
  } catch { /* 降级 */ }
  

  // 获取预填数据
  try {
    const r = await window.composeAPI.getInitData();
    if (r.ok && r.data) {
      const d = r.data;
      if (d.to) {
        if (Array.isArray(d.to)) d.to.forEach(addChip);
        else d.to.split(",").forEach(s => addChip(s.trim()));
      }
      if (d.subject) $("#subject-input").value = d.subject;
      if (d.body) $("#body-editor").innerHTML = d.body;
      if (d.quoteHtml) $("#body-editor").dataset.quoteHtml = d.quoteHtml;
      // 标记对接邮箱并自动选中
      if (d.linkedAccount) {
        _linkedAccount = d.linkedAccount;
        const linked = _accounts.find(a =>
          a.email === d.linkedAccount || a.label === d.linkedAccount || a.id === d.linkedAccount
        );
        if (linked && linked.active && !linked.fused) {
          _selectedAcct = linked;
        }
      }
      // 记录联系人邮箱，用于草稿去重
      if (d.contactEmail) _contactEmail = d.contactEmail;
    }
  } catch { /* 无预填数据 */ }
  // 渲染下拉（_selectedAcct 已确定后再渲染）
  renderFromSelect();
  // 加载该联系人的草稿（如有则覆盖默认内容）
  if (_contactEmail) await loadDraft(_contactEmail);

  // 默认嵌入所选账号的签名
  upsertSignature();

  // 监听主进程推送的 init 数据
  if (window.composeAPI._onInit) {
    // ponytail: compose-preload does not expose _onInit; use getInitData pattern
  }

  // 拖拽添加附件
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files?.length) addAttachments(files);
  });

  // 发送按钮
  $("#btn-send").addEventListener("click", doSend);

  // 草稿按钮
  $("#btn-draft").addEventListener("click", doSaveDraft);

  // 聚焦收件人
  $("#to-input").focus();
}

// ── 附件 ──────────────────────────────────────────────────────────────────
let _attachments = [];

function addAttachments(files) {
  for (const f of files) {
    if (_attachments.find(a => a.name === f.name && a.size === f.size)) continue;
    _attachments.push(f);
    const el = $("#attachments");
    el.classList.add("has");
    const item = document.createElement("span");
    item.className = "att-item";
    item.innerHTML = `📎 ${escapeHtml(f.name)} (${(f.size / 1024).toFixed(1)}KB) <span class="rm">&times;</span>`;
    item.querySelector(".rm").addEventListener("click", () => {
      _attachments = _attachments.filter(a => a.name !== f.name || a.size !== f.size);
      item.remove();
      if (!_attachments.length) el.classList.remove("has");
    });
    el.appendChild(item);
  }
}

init();
