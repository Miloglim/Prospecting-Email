// ── Prospecting Email — Electron 主进程 ────────────────────────────────
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseTemplateLibrary } = require('./template-engine');
const XLSX = require('xlsx');
const https = require('https');
const { execSync, spawn } = require('child_process');

// 消除 Windows 磁盘缓存权限错误
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// ── 全局状态 ──────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let isQuitting = false;
let templateLib = null;       // 模板句库（启动时解析）
let sendQueue = [];           // 发送队列（内存）
let isPaused = false;         // 发送暂停标志
let currentSendAbort = null;   // 发送取消回调

// ── 创建主窗口 ─────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    title: 'Prospecting Email — 拉美开发信工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 关闭 → 最小化到托盘（如果托盘已创建）
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ===== IPC 处理器 =====================================================

function setupIPC() {

  // ── 仪表盘 ─────────────────────────────────────────────────────────
  ipcMain.handle('dashboard:getStats', async () => {
    const logPath = path.join(__dirname, '..', 'send', 'send-log.json');
    const configPath = path.join(__dirname, '..', 'send', 'config.json');

    let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500;

    if (fs.existsSync(logPath)) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      const today = new Date().toISOString().slice(0, 10);
      sentToday = log.sent.filter((r) => r.time && r.time.startsWith(today)).length;
      totalSent = log.sent.filter((r) => r.status === 'sent').length;
      totalFailed = log.sent.filter((r) => r.status === 'failed').length;
    }
    if (fs.existsSync(configPath)) {
      dailyLimit = JSON.parse(fs.readFileSync(configPath, 'utf-8')).schedule?.max_per_day || 500;
    }

    return {
      sentToday, dailyLimit,
      remaining: Math.max(0, dailyLimit - sentToday),
      totalSent, totalFailed,
      queueLength: sendQueue.length,
    };
  });

  ipcMain.handle('smtp:checkStatus', async () => {
    const configPath = path.join(__dirname, '..', 'send', 'config.json');
    if (!fs.existsSync(configPath)) return { ok: false, host: '未配置' };
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { ok: !!(cfg.smtp?.host && cfg.smtp?.user), host: cfg.smtp?.host || '未配置', user: cfg.smtp?.user || '' };
  });

  // ── 客户表导入 ────────────────────────────────────────────────────
  ipcMain.handle('table:importFile', async (_e, filePath) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
        return { error: '不支持的文件格式，请使用 Excel (.xlsx) 或 CSV' };
      }

      // 统一用 XLSX 解析（支持 CSV + Excel + 大文件）
      let wb;
      if (ext === '.csv') {
        // CSV 需要先读文本去 BOM，否则 XLSX 解析乱码
        let text = fs.readFileSync(filePath, 'utf-8');
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
        wb = XLSX.read(text, { type: 'string', codepage: 65001 });
      } else {
        wb = XLSX.readFile(filePath, { type: 'file', codepage: 65001 });
      }
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      // 标准化列名（兼容所有常见中文/英文列名）
      const clients = rows.map(r => ({
        company: r['公司名称'] || r['公司名'] || r['公司'] || r['Company'] || r['company'] || r['empresa'] || r['客户名称'] || r['客户'] || '',
        country: r['国家'] || r['Country'] || r['country'] || '',
        category: r['公司类型'] || r['品类'] || r['Category'] || r['category'] || r['rubro'] || r['行业'] || '',
        email: r['联系方式'] || r['邮箱'] || r['Email'] || r['email'] || r['收件人'] || r['to'] || r['邮件'] || r['E-mail'] || '',
        website: r['网站'] || r['Website'] || r['website'] || r['官网'] || r['网址'] || r['LinkedIn'] || '',
        contactName: r['姓名 | 职位'] || r['姓名'] || r['联系人'] || r['Contact'] || r['contact'] || '',
        position: r['职位'] || r['Position'] || r['position'] || r['title'] || '',
        phone: r['Phone'] || r['phone'] || r['电话'] || r['Tel'] || r['tel'] || '',
      })).filter(c => c.company);

      return { clients, total: clients.length };
    } catch (e) {
      return { error: e.message };
    }
  });

  // ── 背调报告 ──────────────────────────────────────────────────────
  const backcheckStatusPath = path.join(__dirname, '..', 'data', 'backcheck-status.json');

  function readBackcheckStatus() {
    try { return fs.existsSync(backcheckStatusPath) ? JSON.parse(fs.readFileSync(backcheckStatusPath, 'utf-8')) : {}; }
    catch { return {}; }
  }

  function writeBackcheckStatus(status) {
    const dir = path.dirname(backcheckStatusPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(backcheckStatusPath, JSON.stringify(status, null, 2));
  }

  ipcMain.handle('backcheck:getReports', async () => {
    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) return [];
    return fs.readdirSync(reportsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f.replace('.md', ''), path: path.join(reportsDir, f) }));
  });

  ipcMain.handle('backcheck:getStatus', async () => readBackcheckStatus());

  ipcMain.handle('backcheck:getDetail', async (_e, companyName) => {
    // 精确匹配报告文件：客户背调-公司名.md
    const fname = sanitizeFilename(companyName);
    const exactPath = path.join(__dirname, '..', 'reports', `客户背调-${fname}.md`);
    let content = '';
    if (fs.existsSync(exactPath)) {
      content = fs.readFileSync(exactPath, 'utf-8');
    }

    if (!content) return { website: '', scale: '', category: '', imports: '', contact: '', news: '', rating: 0, raw: '' };

    // 提取星级评定
    const ratingMatch = content.match(/货代开发价值[：:]\*\*\s*([⭐★1-5]+)/);
    let rating = 0;
    if (ratingMatch) {
      const stars = ratingMatch[1];
      rating = (stars.match(/[⭐★]/g) || []).length || parseInt(stars) || 0;
    }

    return {
      website: extractField(content, '官网') || extractField(content, '网站') || extractField(content, 'Website'),
      scale: extractField(content, '规模') || extractField(content, 'Scale'),
      category: extractField(content, '品类') || extractField(content, 'Category'),
      imports: extractField(content, '进口特征') || extractField(content, '进口'),
      contact: extractField(content, '收件人') || extractField(content, 'To'),
      news: extractField(content, '近期动态') || extractField(content, '动态'),
      rating,
      raw: content,
    };
  });

  // 后台搜索调用：生成背调请求文件，用户可到 Claude Code 处理
  ipcMain.handle('backcheck:research', async (_e, company) => {
    const cname = company.company;
    const fname = sanitizeFilename(cname);
    const reportPath = path.join(__dirname, '..', 'reports', `客户背调-${fname}.md`);

    // 标记调查中
    const status = readBackcheckStatus();
    status[cname] = {
      status: 'researching',
      requestedAt: new Date().toISOString(),
      progress: '启动搜索...',
    };
    writeBackcheckStatus(status);

    // 异步执行背调（不阻塞 UI）
    runAutoResearch(cname, company, reportPath, status);

    return { ok: true, message: `背调已启动: ${cname}` };
  });

  function sendBackcheckProgress(cname, progress) {
    const st = readBackcheckStatus();
    if (st[cname]) st[cname].progress = progress;
    writeBackcheckStatus(st);
  }

  async function runAutoResearch(cname, company, reportPath, initialStatus) {
    const results = { company: '', scale: '', category: '', imports: '', news: '', rating: 0 };
    let searchOk = false;

    // 尝试自动搜索（5秒超时）
    sendBackcheckProgress(cname, '搜索公司概况...');
    const r1 = await searchWithTimeout(`"${cname}" company profile`, 5000);
    if (r1) { results.company = r1; searchOk = true; }

    sendBackcheckProgress(cname, '搜索进口/供应链...');
    const r2 = await searchWithTimeout(`"${cname}" importação shipping container`, 5000);
    if (r2) results.imports = r2;

    sendBackcheckProgress(cname, '搜索近期新闻...');
    const r3 = await searchWithTimeout(`"${cname}" notícias 2025 2026`, 5000);
    if (r3) results.news = r3;

    if (!searchOk) {
      // 搜索全部失败 → 回落请求文件
      sendBackcheckProgress(cname, '网络不通，生成请求文件...');
      const requestFile = path.join(__dirname, '..', 'reports', `背调请求-${sanitizeFilename(cname)}.md`);
      const fields = [];
      if (company.country) fields.push(`**国家:** ${company.country}`);
      if (company.category) fields.push(`**品类:** ${company.category}`);
      if (company.email) fields.push(`**邮箱:** ${company.email}`);
      if (company.website) fields.push(`**网站:** ${company.website}`);
      const req = [
        `# 背调请求 — ${cname}`,
        '',
        '## 已有信息',
        fields.length > 0 ? fields.join('\n') : '（信息有限）',
        '',
        '## 调查任务',
        '1. 公司官网与规模 2. 主营业务 3. 进口特征 4. 近期动态 5. 决策人',
        '',
        `> ${new Date().toISOString()}`,
      ].join('\n');
      fs.writeFileSync(requestFile, req);

      const st = readBackcheckStatus();
      st[cname] = { ...st[cname], status: 'pending_claude', progress: '等待 Claude Code 处理...' };
      writeBackcheckStatus(st);
      return;
    }

    // 搜索成功 → 自动评级 + 生成报告
    sendBackcheckProgress(cname, '分析结果并评级...');
    const combined = [r1, r2, r3].join('\n');
    results.rating = autoRate(combined, company);

    sendBackcheckProgress(cname, '生成报告...');
    const report = buildReport(cname, company, results);
    const dir = path.dirname(reportPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(reportPath, report);

    const st = readBackcheckStatus();
    st[cname] = { status: 'done', completedAt: new Date().toISOString(), rating: results.rating, progress: '完成' };
    writeBackcheckStatus(st);
  }

  // 带超时的搜索
  async function searchWithTimeout(query, ms) {
    try {
      const result = await Promise.race([
        duckDuckGoSearch(query),
        new Promise(r => setTimeout(() => r(''), ms)),
      ]);
      return result;
    } catch { return ''; }
  }

  function duckDuckGoSearch(query) {
    return new Promise((resolve) => {
      const q = encodeURIComponent(query);
      const options = {
        hostname: 'html.duckduckgo.com',
        path: `/html/?q=${q}`,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ProspectingEmail/1.0' },
        timeout: 5000,
      };
      const req = https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const snippets = [];
          const re = /class="result__snippet"[^>]*>(.*?)<\/a>/g;
          let m;
          while ((m = re.exec(data)) !== null) {
            const text = m[1].replace(/<[^>]+>/g, '').trim();
            if (text.length > 30) snippets.push(text);
          }
          resolve(snippets.slice(0, 8).join('\n'));
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  function buildReport(cname, company, r) {
    const stars = '⭐'.repeat(Math.min(5, Math.max(1, r.rating || 3)));
    const ratingText = r.rating >= 5 ? '极高价值 — 优先开发'
      : r.rating >= 4 ? '高价值 — 建议开发'
      : r.rating >= 3 ? '中等价值 — 选择性开发'
      : r.rating >= 2 ? '低价值 — 暂不优先'
      : '不建议开发';

    return [
      `# ${cname} — 背调信息卡`,
      '',
      '## 公司概况',
      '',
      `**公司名:** ${cname}`,
      company.country ? `**国家:** ${company.country}` : '',
      company.category ? `**品类:** ${company.category}` : '',
      company.email ? `**邮箱:** ${company.email}` : '',
      company.website ? `**网站:** ${company.website}` : '',
      '',
      r.company || r.category ? `**搜索结果摘要:** ${(r.company + ' ' + r.category).slice(0, 500)}` : '',
      r.scale ? `**规模:** ${r.scale}` : '',
      '',
      r.imports ? '## 进口/供应链\n\n' + r.imports.slice(0, 2000) : '',
      '',
      r.news ? '## 近期动态\n\n' + r.news.slice(0, 2000) : '',
      '',
      '## 背调结论',
      '',
      `**货代开发价值:** ${stars}（${r.rating}/5）— ${ratingText}`,
      '',
      '---',
      `> 自动背调 | ${new Date().toISOString()}`,
    ].filter(Boolean).join('\n');
  }

  function autoRate(combined, company) {
    let score = 3; // 默认中等
    const text = combined.toLowerCase();

    // 加分项
    if (text.includes('import') || text.includes('export') || text.includes('shipping') || text.includes('container')) score++;
    if (text.includes('expansion') || text.includes('investment') || text.includes('growth') || text.includes('new plant')) score++;
    if (text.includes('china') || text.match(/chin[ea]/)) score++;
    if (text.includes('manufacturing') || text.includes('factory') || text.includes('plant')) score++;
    if (company.country && company.category) score++;

    // 减分项
    if (text.includes('subsidiary') && (text.includes('japan') || text.includes('germany'))) score--;
    if (text.includes('internal') && text.includes('supply chain')) score--;
    if (!text.includes('import') && !text.includes('shipping')) score--;

    return Math.max(1, Math.min(5, score));
  }

  ipcMain.handle('backcheck:markDone', async (_e, companyName, rating) => {
    const status = readBackcheckStatus();
    status[companyName] = {
      status: 'done',
      completedAt: new Date().toISOString(),
      rating: rating || status[companyName]?.rating || 0,
    };
    writeBackcheckStatus(status);
    return { ok: true };
  });

  ipcMain.handle('app:openReports', async () => {
    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    shell.openPath(reportsDir);
  });

  ipcMain.handle('backcheck:cancel', async (_e, companyName) => {
    const status = readBackcheckStatus();
    delete status[companyName];
    writeBackcheckStatus(status);
    // 同时删除请求文件
    const reqFile = path.join(__dirname, '..', 'reports', `背调请求-${sanitizeFilename(companyName)}.md`);
    if (fs.existsSync(reqFile)) fs.unlinkSync(reqFile);
    return { ok: true };
  });

  // ── 联系人（持久化存储）─────────────────────────────────────────────
  const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');

  function readContacts() {
    try {
      if (fs.existsSync(contactsPath)) return JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
    } catch (e) { /* ignore */ }
    return [];
  }

  function writeContacts(contacts) {
    const dir = path.dirname(contactsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2));
  }

  ipcMain.handle('contacts:list', async () => readContacts());

  ipcMain.handle('contacts:import', async (_e, clients) => {
    const existing = readContacts();
    // 按邮箱去重（同公司多人应分别保存）
    const existingKeys = new Set(existing.map(c => `${c.company.toLowerCase()}||${(c.email || '').toLowerCase()}`));
    let added = 0, skipped = 0;
    for (const c of clients) {
      if (!c.company && !c.email) { skipped++; continue; }
      const key = `${(c.company || '').toLowerCase()}||${(c.email || '').toLowerCase()}`;
      if (existingKeys.has(key)) { skipped++; continue; }
      existing.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        company: c.company || '未命名',
        country: c.country || '',
        category: c.category || '',
        email: c.email || '',
        website: c.website || '',
        contactName: c.contactName || '',
        position: c.position || '',
        phone: c.phone || '',
        addedAt: new Date().toISOString(),
      });
      existingKeys.add(key);
      added++;
    }
    writeContacts(existing);
    return { total: existing.length, added, skipped };
  });

  ipcMain.handle('contacts:delete', async (_e, id) => {
    let contacts = readContacts();
    contacts = contacts.filter(c => c.id !== id);
    writeContacts(contacts);
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteAll', async () => {
    writeContacts([]);
    return { ok: true };
  });

  ipcMain.handle('contacts:search', async (_e, query) => {
    const contacts = readContacts();
    const q = query.toLowerCase();
    return contacts.filter(c =>
      c.company.toLowerCase().includes(q) ||
      (c.country || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q)
    );
  });

  // ── 模板引擎 ───────────────────────────────────────────────────────
  ipcMain.handle('template:getLibrary', async () => {
    if (!templateLib) templateLib = parseTemplateLibrary();
    return templateLib;
  });

  ipcMain.handle('template:getSubjects', async (_e, type) => {
    if (!templateLib) templateLib = parseTemplateLibrary();
    return templateLib?.subjects?.[type] || { es: '', en: '' };
  });

  // ── 发送引擎 ───────────────────────────────────────────────────────
  ipcMain.handle('send:start', async (_e, emails) => {
    sendQueue = emails;
    isPaused = false;
    await runSendBatch();
    return { finished: true };
  });

  ipcMain.handle('send:pause', async () => {
    isPaused = true;
    return { paused: true };
  });

  ipcMain.handle('send:status', async () => {
    const logPath = path.join(__dirname, '..', 'send', 'send-log.json');
    let dailyCount = 0, lastDate = '';
    if (fs.existsSync(logPath)) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      dailyCount = log.daily_count || 0;
      lastDate = log.last_date || '';
    }
    return { queueLength: sendQueue.length, isPaused, dailyCount, lastDate };
  });

  // ── 系统 ───────────────────────────────────────────────────────────
  ipcMain.handle('app:minimizeToTray', async () => {
    mainWindow?.hide();
  });
}

// ===== 发送引擎核心 ====================================================

async function runSendBatch() {
  const nodemailer = require('nodemailer');
  const configPath = path.join(__dirname, '..', 'send', 'config.json');
  const logPath = path.join(__dirname, '..', 'send', 'send-log.json');
  const sigPath = path.join(__dirname, '..', 'send', 'signature.html');

  if (!fs.existsSync(configPath)) {
    sendProgress({ error: 'config.json 未找到' });
    return;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // 安全：SMTP 密码优先从环境变量读取
  if (process.env.SMTP_PASS) {
    config.smtp.pass = process.env.SMTP_PASS;
  }

  const signatureHtml = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf-8') : '';
  const signatureText = config.signature?.text || '';
  const maxPerDay = config.schedule?.max_per_day || 500;
  const minDelay = (config.schedule?.min_delay_seconds || 45) * 1000;
  const maxDelay = (config.schedule?.max_delay_seconds || 120) * 1000;
  const startHour = config.schedule?.start_hour_beijing || 19;
  const endHour = config.schedule?.end_hour_beijing || 3;

  // 今日计数
  let log = { sent: [], daily_count: 0, last_date: '' };
  if (fs.existsSync(logPath)) {
    log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  }
  const today = new Date().toISOString().slice(0, 10);
  if (log.last_date !== today) { log.daily_count = 0; log.last_date = today; }

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    tls: { rejectUnauthorized: false },
  });

  // 时间窗口检查
  function inWindow() {
    const beijingHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getHours();
    if (startHour < endHour) return beijingHour >= startHour && beijingHour < endHour;
    return beijingHour >= startHour || beijingHour < endHour;
  }

  function randomDelay() {
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  }

  function buildContent(bodyText) {
    const textBody = bodyText + '\n--\n' + signatureText;
    const htmlBody = bodyText.split('\n').map(line => {
      const t = line.trim();
      if (!t) return '<br>';
      if (t === '--' || t === '---') return '<br>';
      return `<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${t}</p>`;
    }).join('\n');
    const html = htmlBody + '\n' + signatureHtml;
    return { text: textBody, html };
  }

  for (let i = 0; i < sendQueue.length; i++) {
    if (isPaused) {
      sendProgress({ type: 'paused', index: i, total: sendQueue.length });
      break;
    }

    if (log.daily_count >= maxPerDay) {
      sendProgress({ type: 'limit', index: i, total: sendQueue.length, message: `已达每日上限 ${maxPerDay}` });
      break;
    }

    // 等待时间窗口
    while (!inWindow() && !isPaused) {
      sendProgress({ type: 'waiting', message: '等待发送窗口 (北京时间 19:00-03:00)...' });
      await sleep(60000);
    }
    if (isPaused) break;

    const email = sendQueue[i];
    const toList = email.recipients || email.to.split(',').map(s => s.trim()).filter(Boolean);
    const toField = toList.join(', ');
    const { text, html } = buildContent(email.body);

    try {
      const info = await transporter.sendMail({
        from: `"${config.sender.name}" <${config.sender.email}>`,
        to: toField,
        subject: email.subject,
        text,
        html,
      });

      log.sent.push({
        index: log.daily_count + 1, to: toField, company: email.company || '',
        subject: email.subject, messageId: info.messageId, count: toList.length,
        time: new Date().toISOString(), status: 'sent',
      });
      log.daily_count++;
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

      sendProgress({ type: 'sent', index: i + 1, total: sendQueue.length, company: email.company, to: toField, count: toList.length });
    } catch (err) {
      log.sent.push({
        index: log.daily_count + 1, to: toField, company: email.company || '',
        subject: email.subject, time: new Date().toISOString(), count: toList.length,
        status: 'failed', error: err.message,
      });
      log.daily_count++;
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

      sendProgress({ type: 'failed', index: i + 1, total: sendQueue.length, company: email.company, to: toField, error: err.message });
    }

    // 最后一封不延迟
    if (i < sendQueue.length - 1 && log.daily_count < maxPerDay && !isPaused) {
      const delay = randomDelay();
      sendProgress({ type: 'delay', seconds: Math.round(delay / 1000) });
      await sleep(delay);
    }
  }

  await transporter.close();

  // 发送完成通知
  if (tray && !isPaused) {
    new Notification({ title: 'Prospecting Email', body: `发送完成: ${log.daily_count} 封` }).show();
  }

  sendProgress({ type: 'complete', total: sendQueue.length });
  mainWindow?.show();
}

function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('send:progress', data);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 工具函数 ========================================================

function extractField(content, label) {
  const regex = new RegExp(`${label}[：:]\\s*(.+?)(?:\\n|$)`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

function extractFirst(text, regex) {
  const m = text.match(regex);
  return m ? m[1] || m[0] : '';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
}

// ===== 应用生命周期 =====================================================

app.whenReady().then(() => {
  templateLib = parseTemplateLibrary();
  setupIPC();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ===== 系统托盘 ========================================================

function createTray() {
  // 使用简单的 16x16 透明图标（内嵌 base64）
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon;

  if (fs.existsSync(iconPath)) {
    trayIcon = iconPath;
  } else {
    // 回退：生成简单图标
    trayIcon = path.join(__dirname, 'tray-icon.png');
  }

  try {
    tray = new Tray(trayIcon);
  } catch (e) {
    // 图标不存在时用 nativeImage 创建
    const { nativeImage } = require('electron');
    const img = nativeImage.createEmpty();
    tray = new Tray(img);
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '暂停发送', click: () => { isPaused = true; } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Prospecting Email — 拉美开发信工具');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
