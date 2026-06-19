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

  // ── 客户分类 ──────────────────────────────────────────────────────
  function classifyClient(company, category) {
    const text = ((company || '') + ' ' + (category || '')).toLowerCase();
    // 代理关键词
    const agentKw = [
      'logistics', 'logistic', 'logística', 'logistico', 'logístico',
      'freight', 'forwarder', 'forwarding', 'freight forwarder',
      'cargo', 'shipping', 'transport', 'transporte', 'transportes',
      'transportadora', 'transitário', 'transitario',
      'agencia', 'agente', 'agent', 'agência',
      'despachante', 'aduana', 'customs', 'customs broker',
      'courier', 'carrier', 'naviera', 'maritime', 'marítimo',
      'operador logistico', 'operador logístico', 'operator logistics',
      '3pl', 'third party logistics', 'nvoc', 'nvocc',
      'international movers', 'cargo express', 'carga express',
      'ship', 'vessel', 'terminal', 'portuario', 'portuaria',
      'armador', 'consolidator', 'consolidador',
    ];
    if (agentKw.some(kw => text.includes(kw))) return 'agent';
    // 直客关键词（进口商 / 制造商 / 品牌商 / 分销商）
    const directKw = [
      'import', 'importación', 'importadora', 'importador', 'importer',
      'export', 'exportación', 'exportadora', 'exportador', 'exporter',
      'manufactur', 'fabricante', 'fabricación', 'fabrica', 'factory', 'fábrica', 'plant', 'planta',
      'retail', 'retailer', 'varejo', 'comercio', 'comercial', 'trading',
      'distribuidora', 'distributor', 'distribución', 'distribution',
      'industria', 'industrial', 'industry',
      'automotriz', 'automotive', 'auto parts', 'autopeças', 'autopartes',
      'alimentos', 'food', 'beverage', 'bebidas', 'alimenticia',
      'textil', 'textile', 'têxtil', 'tejidos', 'confección',
      'electronics', 'electrónica', 'eletrônica', 'electronic', 'eletronicos',
      'farmacéutica', 'pharmaceutical', 'farma', 'laboratório',
      'construção', 'construction', 'construcción', 'constructora',
      'maquinaria', 'machinery', 'máquinas', 'equipamentos', 'equipment', 'equipos',
      'metalurgia', 'metal', 'aço', 'steel', 'alumínio', 'aluminum', 'acero',
      'plástico', 'plastic', 'plásticos', 'plasticos', 'plast',
      'química', 'chemical', 'química', 'quimica',
      'embalagem', 'packaging', 'embalaje', 'envase',
      'móveis', 'furniture', 'muebles', 'moveis',
      'calçados', 'footwear', 'shoes', 'zapatos', 'calzado',
      'iluminação', 'lighting', 'iluminación', 'luminaria',
      'filtros', 'filter', 'filtro',
      'autopeças', 'repuestos', 'spare parts', 'componentes',
      'cosmética', 'cosmetic', 'cosméticos', 'perfumaria',
      'higiene', 'limpeza', 'cleaning', 'personal care',
      'papel', 'paper', 'celulose', 'cellulose',
      'vidro', 'glass', 'vidrio', 'cristal',
      'cerámica', 'ceramic', 'cerâmica',
      'borracha', 'rubber', 'caucho', 'hule',
      'pintura', 'paint', 'coating', 'revestimento',
      'médica', 'medical', 'hospitalar', 'hospital', 'medico',
      'agricultura', 'agricultural', 'agro', 'fertilizante',
      'minería', 'mining', 'mineração', 'mineral',
      'petróleo', 'petroleum', 'petroleo', 'oil', 'gas',
      'energia', 'energy', 'solar', 'eólica', 'eolica',
      'tool', 'tools', 'ferramentas', 'herramientas',
      'marca', 'brand', 'produtos', 'productos', 'products',
    ];
    if (directKw.some(kw => text.includes(kw))) return 'direct';
    return 'unlabeled';
  }

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
        clientType: classifyClient(
          r['公司名称'] || r['公司名'] || r['公司'] || r['Company'] || r['company'] || r['empresa'] || r['客户名称'] || r['客户'] || '',
          r['公司类型'] || r['品类'] || r['Category'] || r['category'] || r['rubro'] || r['行业'] || ''
        ),
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

  // ── 自动评级 ──────────────────────────────────────────────────────
  function autoRate(combined, company) {
    let score = 3;
    const text = combined.toLowerCase();
    if (text.includes('import') || text.includes('export') || text.includes('shipping') || text.includes('container')) score++;
    if (text.includes('expansion') || text.includes('investment') || text.includes('growth') || text.includes('new plant')) score++;
    if (text.includes('china') || text.match(/chin[ea]/)) score++;
    if (text.includes('manufacturing') || text.includes('factory') || text.includes('plant')) score++;
    if (company.country && company.category) score++;
    if (text.includes('subsidiary') && (text.includes('japan') || text.includes('germany'))) score--;
    if (text.includes('internal') && text.includes('supply chain')) score--;
    if (!text.includes('import') && !text.includes('shipping')) score--;
    return Math.max(1, Math.min(5, score));
  }

  // ── 搜索提供者（可替换配置）────────────────────────────────────────
  function loadSearchConfig() {
    const configPath = path.join(__dirname, '..', 'send', 'config.json');
    if (fs.existsSync(configPath)) {
      try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { return {}; }
    }
    return {};
  }

  // 翻译引擎：有道优先 → 百度备选 → 原文兜底
  const crypto = require('crypto');

  async function translateToChinese(text) {
    if (!text || text.length < 20) return text;
    const cfg = loadSearchConfig();
    const tlCfg = (cfg && cfg.translate) || {};

    const paragraphs = text.split('\n').filter(p => p.trim().length > 10);
    const results = [];
    for (const p of paragraphs) {
      const chunk = p.slice(0, 500);
      let translated = '';
      // 1) 有道
      if (tlCfg.youdao?.appKey && tlCfg.youdao?.appSecret) {
        translated = await youdaoTranslate(chunk, tlCfg.youdao);
      }
      // 2) 百度
      if (!translated && tlCfg.baidu?.appId && tlCfg.baidu?.key) {
        translated = await baiduTranslate(chunk, tlCfg.baidu);
      }
      results.push(translated || chunk);
    }
    return results.join('\n\n');
  }

  function youdaoTranslate(text, cfg) {
    return new Promise((resolve) => {
      const salt = Date.now().toString();
      const sign = crypto.createHash('md5').update(cfg.appKey + text + salt + cfg.appSecret).digest('hex');
      const body = new URLSearchParams({ q: text, from: 'auto', to: 'zh-CHS', appKey: cfg.appKey, salt, sign }).toString();
      const req = https.request({
        hostname: 'openapi.youdao.com', path: '/api', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            resolve((j.translation || []).join('') || (j.basic?.explains?.join('; ')) || '');
          } catch { resolve(''); }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.write(body); req.end();
    });
  }

  function baiduTranslate(text, cfg) {
    return new Promise((resolve) => {
      const salt = Date.now().toString();
      const sign = crypto.createHash('md5').update(cfg.appId + text + salt + cfg.key).digest('hex');
      const body = new URLSearchParams({ q: text, from: 'auto', to: 'zh', appid: cfg.appId, salt, sign }).toString();
      const req = https.request({
        hostname: 'fanyi-api.baidu.com', path: '/api/trans/vip/translate', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            resolve((j.trans_result || []).map(r => r.dst).join('') || '');
          } catch { resolve(''); }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.write(body); req.end();
    });
  }

  // 官网爬虫：抓取首页 HTML → 提取文本信息
  async function crawlWebsite(url) {
    if (!url || !url.startsWith('http')) return '';
    return new Promise((resolve) => {
      const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
        // 跟随重定向一次
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          crawlWebsite(res.headers.location).then(resolve);
          return;
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          // 提取文本：去掉 script/style/HTML 标签
          const text = data
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&[a-z]+;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          // 取前 3000 字符
          resolve(text.slice(0, 3000));
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  // Tavily API 直接调用
  async function tavilySearch(query, apiKey) {
    return new Promise((resolve) => {
      const body = JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 8, include_answer: true });
      const req = https.request({
        hostname: 'api.tavily.com', path: '/search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const snippets = (j.results || []).map(r => `- ${r.title}: ${r.content}`).join('\n');
            resolve({ answer: j.answer || '', snippets, ok: true });
          } catch { resolve({ answer: '', snippets: '', ok: false }); }
        });
      });
      req.on('error', () => resolve({ answer: '', snippets: '', ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ answer: '', snippets: '', ok: false }); });
      req.write(body);
      req.end();
    });
  }

  const searchProviders = {
    // Tavily API：自动生成结构化基础报告 + 请求文件（供 AI 深度增强）
    'tavily': {
      name: 'Tavily',
      research: async (cname, company) => {
        const cfg = loadSearchConfig();
        if (!cfg.search?.apiKey) return { ok: false, status: 'no_key', message: '未配置 search.apiKey' };

        const country = company.country || '';

        // 四维并行搜索
        notifyBackcheck(cname, { type: 'research-progress', progress: '多维度搜索中...' });
        const tasks = [
          { key: 'profile',  q: `"${cname}" company profile overview business` },
          { key: 'trade',    q: `"${cname}" import export trade data shipments` },
          { key: 'news',     q: `"${cname}" news expansion investment 2025 2026` },
          { key: 'people',   q: `"${cname}" (CEO OR director OR manager OR采购 OR compras OR supply chain) linkedin` },
        ];

        const results = {};
        for (const { key, q } of tasks) {
          const r = await tavilySearch(q, cfg.search?.apiKey);
          results[key] = r.ok ? (r.answer + '\n\n' + r.snippets).slice(0, 2000) : '';
        }

        // 官网爬虫
        let websiteText = '';
        if (company.website && company.website.startsWith('http')) {
          notifyBackcheck(cname, { type: 'research-progress', progress: '抓取官网...' });
          websiteText = await crawlWebsite(company.website);
        }

        const hasAnyData = Object.values(results).some(v => v.length > 50) || websiteText.length > 100;
        if (!hasAnyData) return { ok: false, status: 'no_results', message: '搜索无结果' };

        // 评级
        const allText = websiteText + ' ' + Object.values(results).join(' ');
        const rating = autoRate(allText, company);
        const stars = '⭐'.repeat(Math.min(5, Math.max(1, rating)));
        const ratingLabel = rating >= 5 ? '极高价值 — 优先开发'
          : rating >= 4 ? '高价值 — 建议开发'
          : rating >= 3 ? '中等价值 — 选择性开发'
          : rating >= 2 ? '低价值 — 暂不优先' : '不建议开发';

        // 组装报告
        const fname = sanitizeFilename(cname).trim();
        const dateStr = new Date().toISOString().slice(0, 10);
        const report = [
          `# ${cname} — 背调信息卡`,
          '',
          '## 公司概况',
          '',
          `| 项目 | 内容 |`,
          `|------|------|`,
          `| **公司名** | ${cname} |`,
          company.country ? `| **国家** | ${company.country} |` : '',
          company.category ? `| **品类** | ${company.category} |` : '',
          company.email ? `| **邮箱** | ${company.email} |` : '',
          company.website ? `| **网站** | ${company.website} |` : '',
          '',
          '## 官网信息',
          '',
          websiteText.length > 100 ? websiteText.slice(0, 2000) : '_未抓取到官网信息，建议补充 website 字段_',
          '',
          '## 业务与规模',
          '',
          results.profile || '_无数据_',
          '',
          '## 进口特征与贸易数据',
          '',
          results.trade || '_无数据_',
          '',
          '## 近期动态',
          '',
          results.news || '_无数据_',
          '',
          '## 决策人线索',
          '',
          results.people || '_无数据_',
          '',
          '## 背调结论',
          '',
          `> **国家：** ${company.country || '未知'} | **品类：** ${company.category || '未知'} | **货代开发价值：** ${stars}（${rating}/5）`,
          '',
          `**${ratingLabel}**`,
          '',
          '---',
          `> 自动背调 · ${dateStr}`,
        ].join('\n');

        const reportPath = path.join(__dirname, '..', 'reports', `客户背调-${fname}.md`);
        const dir = path.dirname(reportPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(reportPath, report);

        return { ok: true, status: 'done', rating, message: '报告已生成' };
      }
    },
  };

  // 后台：检测报告文件是否已生成
  function checkReportExists(cname) {
    const fname = sanitizeFilename(cname);
    const reportPath = path.join(__dirname, '..', 'reports', `客户背调-${fname}.md`);
    return fs.existsSync(reportPath) ? reportPath : null;
  }

  // 从报告中提取星级
  function extractRating(content) {
    const m = content.match(/货代开发价值[：:]\*\*\s*([⭐★1-5]+)/);
    return m ? (m[1].match(/[⭐★]/g) || []).length || parseInt(m[1]) || 0 : 0;
  }

  // ── 背调：异步执行 + 实时进度推送 ───────────────────────────────
  ipcMain.handle('backcheck:research', async (_e, company) => {
    const cname = company.company;
    const st = readBackcheckStatus();

    // 已有报告
    const existingReport = checkReportExists(cname);
    if (existingReport) {
      const content = fs.readFileSync(existingReport, 'utf-8');
      st[cname] = { status: 'done', completedAt: new Date().toISOString(), rating: extractRating(content), progress: '已有报告' };
      writeBackcheckStatus(st);
      return { ok: true, message: '报告已存在' };
    }

    // 立即返回，后台执行
    st[cname] = { status: 'researching', requestedAt: new Date().toISOString(), progress: '搜索启动...' };
    writeBackcheckStatus(st);
    notifyBackcheck(cname, { type: 'research-start' });

    // 后台异步
    researchInBackground(cname, company);

    return { ok: true, message: '背调已启动' };
  });

  // 后台搜索 + 进度推送
  async function researchInBackground(cname, company) {
    try {
      const cfg = loadSearchConfig();
      if (!cfg.search?.apiKey) {
        // 无 Key → 生成请求文件
        const fname = sanitizeFilename(cname).trim();
        const requestFile = path.join(__dirname, '..', 'reports', `背调请求-${fname}.md`);
        const fields = [];
        if (company.country) fields.push(`- 国家: ${company.country}`);
        if (company.category) fields.push(`- 品类: ${company.category}`);
        if (company.email) fields.push(`- 邮箱: ${company.email}`);
        notifyBackcheck(cname, { type: 'research-progress', progress: '生成请求文件...' });
        fs.writeFileSync(requestFile, `# 背调请求 — ${cname}\n\n## 已知信息\n${fields.join('\n') || '（信息有限）'}\n\n> ${new Date().toISOString()}`);
        updateStatus(cname, 'pending', 0, '请求文件已生成，需配置 Tavily API Key');
        notifyBackcheck(cname, { type: 'research-done', status: 'pending' });
        return;
      }

      // Tavily 搜索
      const provider = searchProviders['tavily'];
      notifyBackcheck(cname, { type: 'research-progress', progress: '搜索 + 翻译中...' });
      const result = await provider.research(cname, company);

      if (result.ok) {
        updateStatus(cname, 'done', result.rating || 0, '报告已生成');
        notifyBackcheck(cname, { type: 'research-done', status: 'done' });
      } else {
        updateStatus(cname, result.status || 'error', 0, result.message);
        notifyBackcheck(cname, { type: 'research-done', status: result.status || 'error', message: result.message });
      }
    } catch (e) {
      updateStatus(cname, 'error', 0, e.message);
      notifyBackcheck(cname, { type: 'research-done', status: 'error', message: e.message });
    }
  }

  function updateStatus(cname, status, rating, progress) {
    const st = readBackcheckStatus();
    st[cname] = { status, rating, completedAt: new Date().toISOString(), progress };
    writeBackcheckStatus(st);
  }

  function notifyBackcheck(cname, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backcheck:progress', { company: cname, ...data });
    }
  }

  function getBackcheckDetail(cname) {
    const reportPath = checkReportExists(cname);
    if (!reportPath) return { rating: 0, raw: '' };
    try {
      const content = fs.readFileSync(reportPath, 'utf-8');
      return {
        website: extractField(content, '官网') || extractField(content, '网站') || extractField(content, 'Website'),
        scale: extractField(content, '规模') || extractField(content, 'Scale'),
        category: extractField(content, '品类') || extractField(content, 'Category'),
        imports: extractField(content, '进口特征') || extractField(content, '进口'),
        contact: extractField(content, '收件人') || extractField(content, 'To'),
        news: extractField(content, '近期动态') || extractField(content, '动态'),
        rating: extractRating(content),
        raw: content,
      };
    } catch { return { rating: 0, raw: '' }; }
  }

  // ── 报告文件监听器 ─────────────────────────────────────────────────
  const reportWatchers = new Map();

  function startReportWatcher(cname) {
    if (reportWatchers.has(cname)) return;
    let attempts = 0;
    const maxAttempts = 300; // 最长等 10 分钟（2s × 300）
    const timer = setInterval(() => {
      attempts++;
      const reportPath = checkReportExists(cname);
      if (reportPath) {
        clearInterval(timer);
        reportWatchers.delete(cname);
        try {
          const content = fs.readFileSync(reportPath, 'utf-8');
          const rating = extractRating(content);
          const st = readBackcheckStatus();
          st[cname] = { status: 'done', completedAt: new Date().toISOString(), rating, progress: '报告已生成' };
          writeBackcheckStatus(st);
        } catch (e) { /* ignore */ }
      } else if (attempts >= maxAttempts) {
        clearInterval(timer);
        reportWatchers.delete(cname);
        const st = readBackcheckStatus();
        st[cname] = { ...st[cname], status: 'timeout', progress: '超时 — 请检查请求文件' };
        writeBackcheckStatus(st);
      }
    }, 2000);
    reportWatchers.set(cname, timer);
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

  ipcMain.handle('app:openSendFolder', async () => {
    const sendDir = path.join(__dirname, '..', 'send');
    if (!fs.existsSync(sendDir)) fs.mkdirSync(sendDir, { recursive: true });
    shell.openPath(sendDir);
  });

  // ── 翻译报告 ─────────────────────────────────────────────────────
  ipcMain.handle('translate:report', async (_e, rawMd) => {
    const cfg = loadSearchConfig();
    const tlCfg = (cfg && cfg.translate) || {};
    const hasYoudao = !!(tlCfg.youdao?.appKey && tlCfg.youdao?.appSecret);
    const hasBaidu = !!(tlCfg.baidu?.appId && tlCfg.baidu?.key);
    if (!hasYoudao && !hasBaidu) return { ok: false, error: 'no_keys', message: '请先在设置中配置有道或百度翻译 API Key' };

    try {
      // 只翻译正文段落，保留 Markdown 结构和标题
      const lines = rawMd.split('\n');
      const translated = [];
      for (const line of lines) {
        // 标题、表格、分隔线、空行不翻译
        if (/^(#+\s|\||[-*]{3,}|>\s|$)/.test(line)) {
          translated.push(line);
        } else if (line.trim().length > 30) {
          const zh = await translateToChinese(line);
          translated.push(zh || line);
        } else {
          translated.push(line);
        }
      }
      return { ok: true, text: translated.join('\n') };
    } catch (e) {
      return { ok: false, error: 'api_error', message: '翻译接口异常: ' + (e.message || '未知') };
    }
  });

  ipcMain.handle('backcheck:cancel', async (_e, companyName) => {
    // 停止监听器
    if (reportWatchers.has(companyName)) {
      clearInterval(reportWatchers.get(companyName));
      reportWatchers.delete(companyName);
    }
    const status = readBackcheckStatus();
    delete status[companyName];
    writeBackcheckStatus(status);
    // 删除请求文件
    const reqFile = path.join(__dirname, '..', 'reports', `背调请求-${sanitizeFilename(companyName)}.md`);
    if (fs.existsSync(reqFile)) fs.unlinkSync(reqFile);
    return { ok: true };
  });

  // ── 联系人（持久化存储 + 内存缓存）──────────────────────────────────
  const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');
  let contactsCache = null;  // 缓存解析结果，避免重复读 715KB 文件

  function readContacts() {
    if (contactsCache) return contactsCache;
    try {
      if (fs.existsSync(contactsPath)) {
        contactsCache = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        return contactsCache;
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function writeContacts(contacts) {
    contactsCache = contacts;  // 更新缓存
    const dir = path.dirname(contactsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2));
  }

  ipcMain.handle('contacts:list', async () => {
    const contacts = readContacts();
    // 每次读取时补齐/重新分类（兼容旧数据 + 分类规则更新）
    let changed = false;
    for (const c of contacts) {
      const newType = classifyClient(c.company, c.category);
      if (c.clientType !== newType) {
        c.clientType = newType;
        changed = true;
      }
    }
    if (changed) writeContacts(contacts);
    return contacts;
  });

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
        clientType: c.clientType || classifyClient(c.company, c.category),
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

  let currentTransporter = null;

  ipcMain.handle('send:cancel', async () => {
    isPaused = true;
    currentSendAbort = true;
    sendQueue = [];
    try { currentTransporter?.close(); } catch {}
    return { cancelled: true };
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

  // ── 发送历史 / 跟进阶段 ──────────────────────────────────────────
  const sendHistoryPath = path.join(__dirname, '..', 'data', 'send-history.json');

  function readSendHistory() {
    try { return fs.existsSync(sendHistoryPath) ? JSON.parse(fs.readFileSync(sendHistoryPath, 'utf-8')) : {}; }
    catch { return {}; }
  }

  function writeSendHistory(h) {
    const dir = path.dirname(sendHistoryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sendHistoryPath, JSON.stringify(h, null, 2));
  }

  ipcMain.handle('history:get', async () => readSendHistory());

  ipcMain.handle('history:advance', async (_e, companies) => {
    const h = readSendHistory();
    const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4'];
    for (const name of companies) {
      const cur = h[name]?.stage || 'cold'; // 首次发送从 cold 起步
      const idx = STAGES.indexOf(cur);
      const nextIdx = idx >= 0 && idx < STAGES.length - 1 ? idx + 1 : idx; // F4 停留
      h[name] = { ...h[name], stage: STAGES[nextIdx], lastSent: new Date().toISOString(), sentCount: (h[name]?.sentCount || 0) + 1 };
    }
    writeSendHistory(h);
    return h;
  });

  // ── 退信检查 ──────────────────────────────────────────────────────
  ipcMain.handle('bounce:check', async () => {
    const configPath = path.join(__dirname, '..', 'send', 'config.json');
    if (!fs.existsSync(configPath)) return { ok: false, error: '配置文件不存在' };
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const imapCfg = config.imap;
    if (!imapCfg?.host || !imapCfg?.user || !imapCfg?.pass) {
      return { ok: false, error: 'IMAP 未配置，请在设置中填写' };
    }

    const Imap = require('imap');
    return new Promise((resolve) => {
      const imap = new Imap({
        user: imapCfg.user, password: imapCfg.pass,
        host: imapCfg.host, port: imapCfg.port || 993, tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 15000, authTimeout: 10000,
      });

      const bounced = [];
      imap.once('ready', () => {
        imap.openBox('INBOX', false, () => {
          // 搜索退信邮件（过去30天）
          const since = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
          imap.search([['SINCE', since], ['OR', ['SUBJECT', 'undelivered'], ['SUBJECT', 'returned']], ['OR', ['SUBJECT', 'failure'], ['SUBJECT', 'bounce']], ['OR', ['SUBJECT', '退信'], ['SUBJECT', '失败']], ['OR', ['SUBJECT', 'Undelivered'], ['SUBJECT', 'Returned']]], (err, results) => {
            if (err || !results.length) {
              imap.end();
              return resolve({ ok: true, bounced: [], message: '未发现退信' });
            }
            // 只取最近20封
            const fetch = imap.fetch(results.slice(-20), { bodies: 'HEADER.FIELDS (SUBJECT FROM DATE)', struct: true });
            fetch.on('message', (msg) => {
              msg.on('body', (stream) => {
                let data = '';
                stream.on('data', c => data += c);
                stream.on('end', () => {
                  const subj = (data.match(/Subject: (.+)/i) || [])[1] || '';
                  bounced.push({ subject: subj.trim(), date: (data.match(/Date: (.+)/i) || [])[1] || '' });
                });
              });
            });
            fetch.once('end', () => {
              imap.end();
              resolve({ ok: true, bounced, message: `发现 ${bounced.length} 封退信` });
            });
          });
        });
      });
      imap.once('error', (e) => { resolve({ ok: false, error: 'IMAP 连接失败: ' + (e.message || e) }); });
      imap.connect();
    });
  });

  // ── 签名管理 ──────────────────────────────────────────────────────
  const sigFilePath = path.join(__dirname, '..', 'send', 'signature.html');

  ipcMain.handle('signature:load', async () => {
    try {
      if (fs.existsSync(sigFilePath)) return { ok: true, html: fs.readFileSync(sigFilePath, 'utf-8') };
      // 默认签名
      const defaultSig = '<div style="font-family:Arial,sans-serif;color:#333;border-top:1px solid #ddd;padding-top:12px;margin-top:16px"><p style="margin:0 0 4px;font-size:14px"><strong>Zayne Jin</strong></p><p style="margin:0 0 4px;font-size:13px;color:#666">Overseas Sales · LatAm Desk</p><p style="margin:0 0 8px;font-size:13px;color:#666">YQN Logistics Technology Group</p><p style="margin:0;font-size:12px;color:#999">📧 zayne_jin@yqn.com &nbsp;|&nbsp; 📱 +86 18487665870 &nbsp;|&nbsp; 🌐 www.yqn.com</p></div>';
      return { ok: true, html: defaultSig };
    } catch { return { ok: false, html: '' }; }
  });

  ipcMain.handle('signature:save', async (_e, html) => {
    try {
      const dir = path.dirname(sigFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(sigFilePath, html);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── 设置 ───────────────────────────────────────────────────────────
  ipcMain.handle('config:load', async () => {
    const configPath = path.join(__dirname, '..', 'send', 'config.json');
    try {
      if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {}
    return null;
  });

  ipcMain.handle('config:save', async (_e, config) => {
    const configPath = path.join(__dirname, '..', 'send', 'config.json');
    try {
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
  const signatureText = config.signature?.text || '金颖哲 Zayne Jin | Overseas Sales · LatAm Desk\nYQN Logistics Technology Group\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com';
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

  currentSendAbort = false;
  currentTransporter = nodemailer.createTransport({
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

    const lines = bodyText.split('\n');
    const htmlLines = [];
    let isFirstLine = true;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { htmlLines.push('<br>'); continue; }
      if (t === '--' || t === '---') { htmlLines.push('<br>'); continue; }
      const content = (isFirstLine && /^(Buen día|Bom dia|Hello|Hola|Olá|Estimado|Prezado)/i.test(t))
        ? `<strong style="font-size:15px">${t}</strong>`
        : t;
      htmlLines.push(`<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6">${content}</p>`);
      isFirstLine = false;
    }
    const htmlBody = htmlLines.join('\n');
    const html = htmlBody + '\n<br>\n' + signatureHtml;
    return { text: textBody, html };
  }

  for (let i = 0; i < sendQueue.length; i++) {
    if (currentSendAbort) {
      sendProgress({ type: 'cancelled', index: i, total: sendQueue.length, message: '发送已取消' });
      break;
    }

    if (isPaused) {
      sendProgress({ type: 'paused', index: i, total: sendQueue.length });
      break;
    }

    if (log.daily_count >= maxPerDay) {
      sendProgress({ type: 'limit', index: i, total: sendQueue.length, message: `已达每日上限 ${maxPerDay}` });
      break;
    }

    // 等待时间窗口（测试模式跳过）
    const testMode = config.test?.enabled && config.test?.email;
    while (!inWindow() && !isPaused && !testMode && !currentSendAbort) {
      sendProgress({ type: 'waiting', message: '等待发送窗口 (北京时间 19:00-03:00)...' });
      await sleep(30000);
    }
    if (isPaused || currentSendAbort) break;

    const email = sendQueue[i];
    const toList = email.recipients || email.to.split(',').map(s => s.trim()).filter(Boolean);
    let toField = toList.join(', ');
    const { text, html } = buildContent(email.body);

    // 测试模式：所有收件人替换为测试邮箱
    const testEmail = config.test?.email;
    const testEnabled = config.test?.enabled && testEmail;
    if (testEnabled) {
      toField = testEmail;
    }

    try {
      const info = await currentTransporter.sendMail({
        from: `"${config.sender.name}" <${config.sender.email}>`,
        to: toField,
        subject: testEnabled ? `[测试] ${email.subject}` : email.subject,
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

      sendProgress({ type: 'sent', id: email.id, index: i + 1, total: sendQueue.length, company: email.company, to: toField, count: toList.length });
    } catch (err) {
      log.sent.push({
        index: log.sent.length + 1, to: toField, company: email.company || '',
        subject: email.subject, time: new Date().toISOString(), count: toList.length,
        status: 'failed', error: err.message,
      });
      // 失败不计入每日限额
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

      sendProgress({ type: 'failed', id: email.id, index: i + 1, total: sendQueue.length, company: email.company, to: toField, error: err.message });
    }

    // 最后一封不延迟
    if (i < sendQueue.length - 1 && log.daily_count < maxPerDay && !isPaused) {
      const delay = randomDelay();
      sendProgress({ type: 'delay', seconds: Math.round(delay / 1000) });
      await sleep(delay);
    }
  }

  await currentTransporter.close();

  // 发送完成通知
  const sentCount = log.sent.filter(r => r.status === 'sent' && r.time?.startsWith(today)).length;
  const failedCount = log.sent.filter(r => r.status === 'failed' && r.time?.startsWith(today)).length;
  if (tray && !isPaused && !currentSendAbort) {
    new Notification({ title: 'Prospecting Email', body: `发送完成: 成功 ${sentCount} 封` + (failedCount ? `, 失败 ${failedCount} 封` : '') }).show();
  }

  sendProgress({ type: 'complete', total: sendQueue.length, sent: sentCount, failed: failedCount });
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
  return (name || '').trim().replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
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
