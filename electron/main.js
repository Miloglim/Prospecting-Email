// ── Milogin's Prospector — Electron 主进程 ────────────────────────────────
require('./logger'); // 全局劫持 console → 写文件，所有日志自动落盘
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseTemplateLibrary, applyOverrides, applyStageOverrides } = require('./template-engine');
const XLSX = require('xlsx');
const https = require('https');
const cheerio = require('cheerio');
const http = require('http');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { execSync, spawn } = require('child_process');

// ── 配置读取（模块级，proxy/network/translate 共用）─────────────────
function loadSearchConfig() {
  const configPath = path.join(__dirname, '..', 'send', 'config.json');
  if (fs.existsSync(configPath)) {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { }
  }
  return {};
}

// ── Scrapling 抓取服务调用 ──────────────────────────────────────────
const SCRAPLING_PORT = 8765;
let scraplingProcess = null;

// ── Agnes 开发信验证 ─────────────────────────────────────────────────
const AGNES_ENDPOINT = 'https://apihub.agnes-ai.com/v1/chat/completions';
// ponytail: 从 config 读 key，打包时 config 预配置
function getAgnesKey() {
  try {
    const cfgPath = path.join(__dirname, '..', 'send', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return cfg.verify?.agnesKey || '';
    }
  } catch {}
  return '';
}

async function verifyEmailWithAgnes(emailBody) {
  const apiKey = getAgnesKey();
  if (!apiKey) return { ok: false, error: '未配置 Agnes API Key' };
  const checklist = [
    '对象类型正确（代理不提本地仓库/本地团队；直客可提墨西哥本地化；未标签用通用语言）',
    '无广告垃圾词（最高级/紧迫词/夸大承诺/价格诱饵/排名宣称/全大写/感叹号）',
    '无空洞形容词（competitivo/eficiente），líder不超过1次且有事实支撑',
    '无 digital/AI/平台/technology 等技术词汇',
    '全文第二人称，不教客户做事',
    '首段无"Somos/We are"开头',
    'CTA是给不是要',
    '无占位符残留[XXX]',
    'Saludos 后无任何文字',
    '同一封不同时出现船东名+具体运价',
    '使用了公司资料中的真实数字',
    '列出了2-3个权威背书',
  ];

  const prompt = `你是一个开发信质检员。对照以下清单逐条检查这封开发信。\n\n【检查清单】\n${checklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n【开发信正文】\n${emailBody}\n\n逐条回复，格式：\n1. ✅/❌ 简述（10字以内）\n2. ✅/❌ 简述\n...\n\n最后一行写总结：通过 X/12 项。`;

  try {
    const body = JSON.stringify({
      model: 'agnes-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 512,
    });

    const result = await new Promise((resolve) => {
      const url = new URL(AGNES_ENDPOINT);
      const opts = {
        hostname: url.hostname, port: 443, method: 'POST', path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        timeout: 30000, rejectUnauthorized: false,
      };
      const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d, _status: res.statusCode }); } }); });
      req.on('error', (e) => resolve({ _error: e.message })); req.on('timeout', () => { req.destroy(); resolve({ _error: 'timeout' }); }); req.end(body);
    });

    if (result._error) return { ok: false, error: '网络: ' + result._error };
    if (result._raw) return { ok: false, error: 'HTTP ' + result._status + ': ' + (result._raw || '').slice(0, 200) };
    if (result.error) return { ok: false, error: 'API错误: ' + JSON.stringify(result.error).slice(0, 200) };
    if (!result?.choices?.[0]?.message?.content) return { ok: false, error: 'Agnes 返回空: ' + JSON.stringify(result).slice(0, 200) };
    const content = result.choices[0].message.content;
    const scoreMatch = content.match(/(\d+)\/12/);
    const passed = scoreMatch ? parseInt(scoreMatch[1]) : 0;
    return { ok: true, passed, total: 12, details: content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function callScraplingAPI(endpoint) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${SCRAPLING_PORT}${endpoint}`;
    http.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'parse_error' }); }
      });
    }).on('error', (e) => resolve({ ok: false, error: e.message }))
      .on('timeout', function() { this.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function startScraplingService() {
  return new Promise((resolve) => {
    // 先检查服务是否已在运行
    http.get(`http://127.0.0.1:${SCRAPLING_PORT}/health`, { timeout: 2000 }, (res) => {
      console.log('[scrapling] 服务已在运行');
      resolve(true);
    }).on('error', () => {
      // 启动 Python 服务
      const serviceDir = path.join(__dirname, '..', 'scrapling-service');
      const scriptPath = path.join(serviceDir, 'scrape_service.py');
      if (!fs.existsSync(scriptPath)) {
        console.log('[scrapling] 服务脚本未找到，跳过');
        resolve(false);
        return;
      }
      console.log('[scrapling] 启动抓取服务...');
      scraplingProcess = spawn('python', [scriptPath], {
        cwd: serviceDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(SCRAPLING_PORT) },
      });
      scraplingProcess.stdout?.on('data', d => console.log('[scrapling]', d.toString().trim()));
      scraplingProcess.stderr?.on('data', d => console.error('[scrapling]', d.toString().trim()));
      scraplingProcess.on('exit', code => console.log('[scrapling] 服务退出, code:', code));

      // 等待服务就绪（轮询 health，最多等 10 秒）
      let attempts = 0;
      const check = setInterval(() => {
        attempts++;
        http.get(`http://127.0.0.1:${SCRAPLING_PORT}/health`, { timeout: 2000 }, (res) => {
          clearInterval(check);
          console.log('[scrapling] 服务就绪');
          resolve(true);
        }).on('error', () => {
          if (attempts >= 20) {
            clearInterval(check);
            console.log('[scrapling] 服务启动超时');
            resolve(false);
          }
        });
      }, 500);
    });
  });
}

function stopScraplingService() {
  if (scraplingProcess) {
    scraplingProcess.kill();
    scraplingProcess = null;
  }
}

// ── 代理支持 ──────────────────────────────────────────────────────────
function getProxyConfig() {
  const cfg = loadSearchConfig();
  const host = cfg?.proxy?.host;
  if (!host) return null;
  const [hostname, portStr] = host.split(':');
  return { hostname: hostname.trim(), port: parseInt(portStr) || 7890 };
}

// 通过代理创建 TLS 连接
function proxyTlsConnect(targetHost, targetPort, callback) {
  const proxy = getProxyConfig();
  if (!proxy) {
    const sock = require('tls').connect({ host: targetHost, port: targetPort, servername: targetHost }, () => callback(null, sock));
    sock.on('error', callback);
    return;
  }
  const req = http.request({
    hostname: proxy.hostname, port: proxy.port,
    method: 'CONNECT', path: `${targetHost}:${targetPort}`,
    timeout: 10000,
  });
  req.on('connect', (_res, socket) => {
    const tls = require('tls');
    const tlsSock = tls.connect({ socket, host: targetHost, servername: targetHost }, () => callback(null, tlsSock));
    tlsSock.on('error', callback);
  });
  req.on('error', callback);
  req.on('timeout', () => { req.destroy(); callback(new Error('代理连接超时')); });
  req.end();
}

function createRequest(options) {
  const hostname = options.hostname || options.host;
  const port = options.port || 443;
  options.createConnection = (_opts, cb) => proxyTlsConnect(hostname, port, cb);
  return https.request(options);
}

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
    title: "Milogin's Prospector",
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
  const { checkBounces, testConnection } = require('./bounce-checker');

  // ── 仪表盘 ─────────────────────────────────────────────────────────
  ipcMain.handle('dashboard:getStats', async () => {
    const logPath = path.join(__dirname, '..', 'send', 'send-log.json');
    const configPath = path.join(__dirname, '..', 'send', 'config.json');

    let sentToday = 0, totalSent = 0, totalFailed = 0, dailyLimit = 500;

    if (fs.existsSync(logPath)) {
      let log = { sent: [], daily_count: 0, last_date: '' };
      try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch {}
      const todayBJT = beijingToday();
      sentToday = log.sent.filter((r) => {
        if (r.status !== 'sent') return false;
        // 优先用 time_beijing（精确日期），回退到 UTC time 转北京日期
        if (r.time_beijing) return r.time_beijing === todayBJT;
        return r.time && beijingDateFromISO(r.time) === todayBJT;
      }).length;
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
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
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
      const clients = rows.map(r => {
        // 提取并转为字符串（Excel 数字单元格会是 number 类型）
        const getStr = (obj, ...keys) => {
          for (const k of keys) {
            const v = obj[k];
            if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
          }
          return '';
        };
        return {
        company: getStr(r, '公司名称', '公司名', '公司', 'Company', 'company', 'empresa', '客户名称', '客户'),
        country: getStr(r, '国家', 'Country', 'country'),
        category: getStr(r, '公司类型', '品类', 'Category', 'category', 'rubro', '行业'),
        email: getStr(r, '联系方式', '邮箱', '邮箱地址', 'Email', 'email', '收件人', 'to', '邮件', 'E-mail', 'e-mail', '邮件地址'),
        website: getStr(r, '网站', 'Website', 'website', '官网', '网址'),
        linkedin: getStr(r, 'LinkedIn'),
        contactName: getStr(r, '姓名 | 职位', '姓名', '联系人', 'Contact', 'contact'),
        position: getStr(r, '职位', 'Position', 'position', 'title'),
        phone: getStr(r, 'Phone', 'phone', '电话', 'Tel', 'tel'),
        clientType: classifyClient(
          getStr(r, '公司名称', '公司名', '公司', 'Company', 'company', 'empresa', '客户名称', '客户'),
          getStr(r, '公司类型', '品类', 'Category', 'category', 'rubro', '行业')
        ),
      }}).filter(c => c.company);

      return { clients, total: clients.length };
    } catch (e) {
      return { error: e.message };
    }
  });

  // ── 飞书表格导入 ──────────────────────────────────────────────────

  ipcMain.handle('table:importFeishu', async (_e, baseToken, tableId) => {
    try {
      // 1. 获取字段名列表
      const fieldCmd = `lark-cli base +field-list --base-token "${baseToken}" --table-id "${tableId}" --limit 200`;
      const fieldOut = execSync(fieldCmd, { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
      const fd = JSON.parse(fieldOut);
      const fields = fd.data?.fields || fd.fields || [];
      const allFieldNames = fields.map(f => f.name);

      // 2. 匹配目标字段名 → 实际字段名
      const TARGETS = [
        { keys: ['公司名称','公司名','公司','Company','company','empresa','客户名称'], field: 'company' },
        { keys: ['国家','Country','country'], field: 'country' },
        { keys: ['公司类型','品类','行业','Category','category','rubro'], field: 'category' },
        { keys: ['邮箱','联系方式','邮箱地址','Email','email','收件人'], field: 'email' },
        { keys: ['网站','Website','website','官网','LinkedIn'], field: 'website' },
        { keys: ['姓名','联系人','Contact','contact'], field: 'contactName' },
        { keys: ['职位','Position','position'], field: 'position' },
        { keys: ['电话','Phone','phone','Tel','tel'], field: 'phone' },
      ];
      const selectedNames = []; // 按 TARGETS 顺序，未匹配的留空
      for (const t of TARGETS) {
        const name = allFieldNames.find(n => t.keys.some(k => n === k || (n && n.includes(k))));
        selectedNames.push(name || '');
      }
      // 如果核心字段「公司名称」没匹配到，取前 3 个兜底
      if (!selectedNames.some(Boolean)) {
        selectedNames.splice(0, selectedNames.length, ...allFieldNames.slice(0, 3));
        while (selectedNames.length < TARGETS.length) selectedNames.push('');
      }
      const validNames = selectedNames.filter(Boolean);

      // 3. 分页拉取（--format json 返回二维数组，列序 = fields）
      const allRecords = [];
      const seenRecordIds = new Set();
      const pageSize = 200;
      let offset = 0;
      const idArgs = validNames.map(n => ` --field-id "${n}"`).join('');
      while (true) {
        const cmd = `lark-cli base +record-list --base-token "${baseToken}" --table-id "${tableId}" --offset ${offset} --limit ${pageSize} --format json${idArgs}`;
        const output = execSync(cmd, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        const resp = JSON.parse(output);
        const rows = resp.data?.data || resp.data || [];
        if (!rows.length) break;
        // 用 record_id 去重（防御 offset 分页可能的重叠/遗漏）
        const ids = resp.data?.record_id_list || [];
        const newRows = [];
        const newIds = [];
        for (let i = 0; i < rows.length; i++) {
          const rid = ids[i] || String(i + offset);
          if (seenRecordIds.has(rid)) continue;
          seenRecordIds.add(rid);
          newRows.push(rows[i]);
          newIds.push(rid);
        }
        // 构建列名→索引映射
        const colMap = {};
        (resp.data?.fields || []).forEach((name, i) => { colMap[name] = i; });
        // 将每行数组转成 { targetField: value } 对象
        for (const row of newRows) {
          const obj = {};
          for (let ti = 0; ti < TARGETS.length; ti++) {
            const actualName = selectedNames[ti];
            if (!actualName) continue;
            const colIdx = colMap[actualName];
            const val = colIdx !== undefined && colIdx < row.length ? row[colIdx] : '';
            // 清洗：数组/对象/Markdown链接/mailto/tel → 纯文本
            let clean = '';
            if (Array.isArray(val)) {
              const first = val[0];
              clean = (first && typeof first === 'object') ? (first.link || first.text || first.url || '') : String(first ?? '');
            } else if (val && typeof val === 'object') {
              clean = val.link || val.text || val.url || '';
            } else {
              clean = String(val ?? '');
            }
            clean = clean.trim();
            // 处理 Markdown 链接格式：[text](mailto:xxx) / [text](tel:xxx) / [text](http:xxx)
            const md = clean.match(/^\[(.+?)\]\((.+?)\)$/);
            if (md) {
              const url = md[2];
              if (url.startsWith('mailto:')) clean = url.slice(7);
              else if (url.startsWith('tel:')) clean = url.slice(4);
              else if (url.includes('@')) clean = url.replace(/^https?:\/\//, ''); // 含@则可能是邮箱
              else clean = url;
            }
            // 去掉常见误输入前缀
            if (clean.startsWith('mailto:')) clean = clean.slice(7);
            else if (clean.startsWith('tel:')) clean = clean.slice(4);
            else if (clean.includes('@')) clean = clean.replace(/^https?:\/\//, '');
            obj[TARGETS[ti].field] = (typeof clean === 'string' ? clean : String(clean)).trim();
          }
          allRecords.push(obj);
        }
        const hasMore = resp.data?.has_more;
        // 如果服务端说没了，或本页不足 pageSize，或已无新记录（全页去重），结束
        if (!hasMore || rows.length < pageSize || !newRows.length) break;
        offset += pageSize;
      }

      if (!allRecords.length) return { error: '未读取到任何记录，请检查表格是否有数据' };

      // 4. 公司名空 / 伪名 → 标记待确认
      const rawCount = allRecords.length;
      let suspiciousCount = 0;
      for (const r of allRecords) {
        const marked = markSuspicious(r.company);
        r.company = marked.company;
        r._suspicious = marked._suspicious;
        if (marked._suspicious) suspiciousCount++;
        r.clientType = classifyClient(r.company, r.category);
      }
      if (!allRecords.length) return { error: '未读取到任何记录，请检查表格是否有数据' };
      return { clients: allRecords, total: allRecords.length, rawCount, suspiciousCount };
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('not found') || msg.includes('command not found')) return { error: 'lark-cli 未安装，请先运行: npm install -g @larksuite/lark-cli' };
      if (msg.includes('auth') || msg.includes('unauthorized')) return { error: '飞书未授权，请先运行: lark-cli auth login' };
      if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) return { error: '飞书请求超时，请检查网络' };
      return { error: '飞书读取失败: ' + msg };
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

  ipcMain.handle('backcheck:getStatus', async () => {
    const status = readBackcheckStatus();
    let changed = false;
    for (const [cname, st] of Object.entries(status)) {
      if (st.status === 'done' && !checkReportExists(cname)) {
        // 报告文件已被手动删除 → 清除状态
        delete status[cname];
        changed = true;
      }
    }
    if (changed) writeBackcheckStatus(status);
    return status;
  });

  ipcMain.handle('backcheck:getDetail', async (_e, companyName) => {
    // 精确匹配报告文件：客户背调-公司名.md
    const fname = sanitizeFilename(companyName);
    const exactPath = path.join(__dirname, '..', 'reports', `客户背调-${fname}.md`);
    let content = '';
    if (fs.existsSync(exactPath)) {
      content = fs.readFileSync(exactPath, 'utf-8');
    }

    if (!content) return { website: '', scale: '', category: '', imports: '', contact: '', news: '', rating: 0, raw: '' };

    // 提取星级（兼容新旧格式）
    let rating = 0;
    // 新格式：标题行 `# Mando Corporation  ⭐⭐⭐⭐⭐ 5/5`
    const titleMatch = content.match(/^#\s+.+?\s*([⭐★]{1,5})\s*(\d)\/5/m);
    if (titleMatch) {
      rating = parseInt(titleMatch[2]) || titleMatch[1].length;
    }
    // 旧格式：`货代开发价值：** ⭐⭐⭐⭐⭐（5/5）`
    if (!rating) {
      const oldMatch = content.match(/(?:货代)?开发价值[：:]\*\*\s*([⭐★1-5]+)/);
      if (oldMatch) {
        const stars = oldMatch[1];
        rating = (stars.match(/[⭐★]/g) || []).length || parseInt(stars) || 0;
      }
    }

    // 字段提取（兼容新旧：新格式用表格 `| **官网** | xxx |`，旧格式用 `官网：xxx`）
    function fieldVal(label) {
      // 新格式：表格行（label 可能被 ** 包裹）
      const tableRe = new RegExp(`\\|\\s*\\*{0,2}${label}\\*{0,2}\\s*\\|\\s*(.+?)\\s*\\|`, 'i');
      const tableM = content.match(tableRe);
      if (tableM) return tableM[1].replace(/\*\*/g, '').trim();
      // 旧格式：键值对
      const oldRe = new RegExp(`${label}[：:]\\s*(.+?)(?:\\n|$)`, 'i');
      const oldM = content.match(oldRe);
      return oldM ? oldM[1].trim() : '';
    }

    // 读取独立开发信文件
    const emailPath = path.join(__dirname, '..', 'reports', '客户背调-' + fname + '-email.md');
    let emailBody = '';
    if (fs.existsSync(emailPath)) emailBody = fs.readFileSync(emailPath, 'utf-8');

    return {
      website: fieldVal('官网') || fieldVal('网站') || fieldVal('Website'),
      scale: fieldVal('规模') || fieldVal('Scale'),
      category: fieldVal('品类') || fieldVal('Category'),
      imports: fieldVal('进口特征') || fieldVal('进口'),
      contact: fieldVal('收件人') || fieldVal('To'),
      news: fieldVal('近期动态') || fieldVal('动态'),
      country: fieldVal('国家'),
      rating,
      raw: content,
      emailBody,
    };
  });

  // ── 信号评分（基于开发证据，非关键词）─────────────────────────────
  // 评分逻辑：基准 1 分 + 硬信号加分 - 闭门信号减分
  function autoRate(combined, company) {
    const text = combined.toLowerCase();
    let score = 1;
    const signals = { found: [], missing: [], warn: [] };

    // ── A 级信号：招标/RFQ（最强——公司在主动选供应商）────────────
    const hasRFQ = text.includes('rfq') || text.includes('request for quotation') ||
                   text.includes('tender') || text.includes('招标') || text.includes('licitación') ||
                   text.includes('bidding') || text.includes('request for proposal');
    if (hasRFQ) { score += 3; signals.found.push('A: 公开招标/RFQ'); }

    // ── B 级信号：物流团队扩张（多个岗位同时招 > 单个岗位）─────────
    const hiringKeywords = [
      'logistics specialist', 'logistics manager', 'logistics team leader',
      'supply chain manager', 'supply chain specialist', 'supply chain analyst',
      'customs manager', 'customs compliance', 'customs specialist',
      'trade compliance', 'import/export analyst', 'import export analyst',
      'freight quote', 'customs cost', 'shipping coordinator',
      'transportation manager', 'logistics coordinator', 'procurement specialist',
      'supply chain director', 'logistics director'
    ];
    let hiringCount = 0;
    for (const kw of hiringKeywords) {
      if (text.includes(kw)) hiringCount++;
    }
    const hasHiring = hiringCount > 0;

    if (hiringCount >= 3) {
      score += 3; signals.found.push('B: 多个物流/关务岗位同时招聘（团队扩张）');
    } else if (hiringCount >= 1) {
      score += 2; signals.found.push('B: 物流/关务岗位招聘中');
    }

    // ── C 级信号：进口结构 ──────────────────────────────────────────
    // 进口量级
    const importVolumeMatch = text.match(/(?:import|shipment|贸易|进出口).*?(?:[\d,]+)\s*(?:shipments?|票|笔)/i);
    const shipmentCount = importVolumeMatch ? parseInt(importVolumeMatch[0].replace(/[^\d]/g, '')) : 0;
    const importValueMatch = text.match(/(?:\$\s*|USD\s*|贸易额\s*)([\d,.]+)\s*(?:百万|[mM]illion|[万萬]|[bB]illion)/);
    const importLarge = shipmentCount > 200 || (text.includes('million') && text.match(/\$\s*(\d+)\s*million/i));
    const importMedium = shipmentCount > 50;

    // 中国依赖度
    const chinaPctMatch = text.match(/(?:china|chinese|中国).*?(\d{1,3})\s*%/i);
    const chinaDependent = chinaPctMatch && parseInt(chinaPctMatch[1]) > 40;

    const hasChinaTrade =
      (text.includes('china') || text.includes('chinese') || text.includes('ningbo') ||
       text.includes('shanghai') || text.includes('shenzhen') || text.includes('yantian')) &&
      (text.includes('import') || text.includes('shipment') || text.includes('supplier'));

    if (hasChinaTrade && chinaDependent) {
      score += 2; signals.found.push('C: 从中国进口占比>' + chinaPctMatch[1] + '%（高依赖）');
    } else if (hasChinaTrade && importLarge) {
      score += 2; signals.found.push('C: 从中国进口体量大（>' + shipmentCount + '票）');
    } else if (hasChinaTrade) {
      score += 1; signals.found.push('C: 从中国进口贸易记录');
    }

    // ── D 级信号：关务复杂度 ────────────────────────────────────────
    const hasCustomsComplexity =
      text.includes('immex') || text.includes(' bonded ') || text.includes('bonded warehouse') ||
      text.includes('oea') || text.includes('authorized economic operator') ||
      text.includes('recinto fiscalizado') || text.includes('recinto fiscal');
    if (hasCustomsComplexity) {
      score += 1; signals.found.push('D: 关务复杂度高（IMMEX/保税/OEA）');
    }

    // ── E 级信号：扩张 ──────────────────────────────────────────────
    const isExpanding =
      text.includes('expansion') || text.includes('new plant') || text.includes('new facility') ||
      text.includes('investment') || text.includes('扩建') || text.includes('产能');
    if (isExpanding) {
      score += 1; signals.found.push('E: 产能/业务扩张中');
    }

    // ── F 级信号：决策人可达性 ──────────────────────────────────────
    // 注：这在 autoRate 中只能靠文本猜测，准确判断需 Agent 手动确认
    const hasDecisionMaker =
      text.includes('general manager') || text.includes('country manager') ||
      text.includes('supply chain director') || text.includes('logistics director') ||
      text.includes('procurement director') || text.includes('compras');
    if (hasDecisionMaker) {
      score += 1; signals.found.push('F: 决策人可定位');
    } else {
      signals.warn.push('未定位到物流/采购决策人');
    }

    // ── 缺失信号 ────────────────────────────────────────────────────
    if (!hasHiring && !hasRFQ) {
      signals.missing.push('未发现物流招聘或招标信号');
    }
    if (!hasChinaTrade) {
      signals.missing.push('未发现从中国进口贸易记录');
    }

    // ── 负向信号（大概率不需要外部货代）─────────────────────────────
    const hasInternalLogistics =
      (text.includes('internal') && (text.includes('supply chain') || text.includes('logistics'))) ||
      text.includes('self-operated logistics') || text.includes('in-house logistics') ||
      text.includes('own fleet') || text.includes('自有物流') ||
      text.includes('global logistics network') || text.includes('global supply chain network');

    const fortuneOrGiant =
      (text.includes('fortune 500') || text.includes('fortune global')) &&
      (text.includes('employee') || text.match(/\d{3,}\s*(?:employees|workers|员工)/i)); // 必须同时提到员工数才算

    if (hasInternalLogistics) {
      score -= 3; signals.missing.push('X: 有内部/自建物流网络');
    }
    if (fortuneOrGiant && !hasHiring && !hasRFQ) {
      score -= 1; signals.warn.push('超大型集团且无物流招聘');
    }

    return { rating: Math.max(1, Math.min(5, score)), signals };
  }


  // 翻译引擎：DeepSeek prompt 注入翻译
  // 全文本翻译：整份报告送入 DeepSeek，全文输出中文
  async function translateFullReport(markdown, apiKey) {
    if (!markdown || !apiKey) return markdown;
    try {
      const body = JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content:
            '你是YQN物流集团的内部翻译。公司主营中国↔拉美海运/空运/报关/保税仓储，客户为拉美进口制造商。\n' +
            '\n' +
            '【任务】将以下整份背调报告全文翻译为中文，并进行专业排版。\n' +
            '\n' +
            '【排版规则 — 严格遵守】\n' +
            '1. 标题层级：原文 # → #，## → ##，### → ###，标题文字翻译为中文\n' +
            '2. 表格：完整保留表格结构（|列|列| 和 |--|--|），表头翻译，单元格内容翻译但保留数字/URL\n' +
            '3. 列表：保留 - 或数字列表格式，列表项内容翻译\n' +
            '4. 粗体/斜体：保留 **粗体** 标记，内部文字翻译\n' +
            '5. 引用块：保留 > 格式，内容翻译\n' +
            '6. 链接/URL：原样保留，不要修改\n' +
            '7. 分隔线 ---：保留\n' +
            '8. 空行：保留原文的段落间距\n' +
            '\n' +
            '【翻译规则】\n' +
            '- 西语/葡语/英语 → 中文\n' +
            '- 公司名/人名/地名/URL/邮箱/电话号码 → 不翻译\n' +
            '- 物流术语用行业中文：freight forwarder→货代, customs broker→报关行, IMMEX→出口加工区, bonded warehouse→保税仓, pedimento→报关单, LCL→拼箱, FCL→整柜, cross-dock→越库, supply chain→供应链, NVOCC→无船承运人, 3PL→第三方物流, OEA→AEO认证\n' +
            '- 背调术语：development value→开发价值, signals→开发信号, expansion→扩张, hiring→招聘, import→进口\n' +
            '\n' +
            '【输出】完整排版后的中文报告，无前缀、无解释、无总结。' },
          { role: 'user', content: markdown }
        ],
        temperature: 0.1, max_tokens: 4000,
      });
      const result = await new Promise((resolve) => {
        const opts = { hostname: 'api.deepseek.com', port: 443, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, timeout: 60000, rejectUnauthorized: false };
        const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
        req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end(body);
      });
      if (result?.choices?.[0]?.message?.content) {
        // 后处理：修复常见格式丢失
        let out = result.choices[0].message.content;
        // 确保以 # 标题开头
        if (!out.startsWith('#') && markdown.startsWith('#')) {
          out = markdown.match(/^(# .+)/)?.[1] + '\n\n' + out;
        }
        return out;
      }
    } catch {}
    return markdown;
  }

  // 官网爬虫：抓取首页 HTML → 提取文本信息
  async function crawlWebsite(url) {
    if (!url || !url.startsWith('http')) return '';
    // 跳过非公司官网
    const nonCompany = ['linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com', 'youtube.com', 'tiktok.com'];
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (nonCompany.some(d => host.includes(d))) return '';
    } catch { return ''; }
    return new Promise((resolve) => {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' },
      };
      const req = createRequest(opts);
      req.on('response', (res) => {
        // 跟随重定向一次
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          crawlWebsite(res.headers.location).then(resolve);
          return;
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const $ = cheerio.load(data);
            // 去掉无用元素
            $('script, style, nav, footer, iframe, noscript, [aria-hidden="true"]').remove();

            const sections = [];

            // Meta description
            const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
            if (metaDesc) sections.push(`**简介:** ${metaDesc.trim()}`);

            // 提取 heading 引导的段落
            const headings = $('h1, h2, h3, h4');
            const seen = new Set();
            headings.each((_, h) => {
              const text = $(h).text().trim();
              // 只保留有意义的标题（跳过导航类）
              if (!text || text.length < 3 || text.length > 80) return;
              if (/^(menu|search|cart|login|sign|subscribe|follow|share|home)$/i.test(text)) return;
              if (seen.has(text.toLowerCase())) return;
              seen.add(text.toLowerCase());

              // 取标题后的文本内容
              let content = '';
              let el = $(h).next();
              let count = 0;
              while (el.length && count < 6) {
                const t = el.text().trim();
                if (t && t.length > 15) {
                  content += t + ' ';
                  count++;
                }
                el = el.next();
              }
              if (content) sections.push(`**${text}:** ${content.trim().slice(0, 300)}`);
            });

            // 如果结构化提取太少，回退到纯文本
            if (sections.length < 2) {
              $('script, style').remove();
              const rawText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2500);
              if (rawText.length > 100) {
                sections.push(rawText);
              }
            }

            resolve(sections.join('\n').slice(0, 2500));
          } catch {
            // Cheerio 解析失败，回退纯文本
            const text = data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
            resolve(text);
          }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  // DDG 搜索（Puppeteer 真实浏览器）
  async function ddgSearch(cname) {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--proxy-server=127.0.0.1:7890'],
        timeout: 30000,
      });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent('"' + cname + '"')}&ia=web`, {
        waitUntil: 'networkidle2',
        timeout: 25000,
      });
      await new Promise(r => setTimeout(r, 2000));

      // 判断是否有结果
      const noResults = await page.evaluate(() => document.body.innerText.includes('No results found'));
      if (noResults) {
        // 放宽搜索：去掉引号
        await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(cname)}&ia=web`, {
          waitUntil: 'networkidle2',
          timeout: 20000,
        });
        await new Promise(r => setTimeout(r, 2000));
      }

      // 提取所有结果链接
      const results = await page.evaluate(() => {
        const items = [];
        const skip = ['linkedin.','facebook.','twitter.','instagram.','youtube.','wikipedia.','duckduckgo.','apple.','reddit.','google.'];
        const seen = new Set();
        document.querySelectorAll('a[href^=\"http\"]').forEach(a => {
          const href = a.href || '';
          const text = (a.textContent || '').trim().replace(/\\s+/g, ' ');
          if (text.length < 10 || href.length < 30) return;
          if (a.closest('nav') || a.closest('footer') || a.closest('header')) return;
          try {
            const host = new URL(href).hostname;
            if (skip.some(d => host.includes(d))) return;
            const k = host;
            if (seen.has(k)) return;
            seen.add(k);
            items.push({ title: text.slice(0, 100), link: href, host });
          } catch {}
        });
        return items.slice(0, 8);
      });

      await browser.close();

      const foundUrl = results.length > 0 ? (() => {
        try { return new URL(results[0].link).origin; } catch { return ''; }
      })() : '';
      const snippets = results.map(r => `- **${r.title}**: ${r.host}`).join('\n');

      return { foundUrl, snippets };
    } catch (e) {
      if (browser) try { await browser.close(); } catch {}
      return { foundUrl: '', snippets: '', error: e.message };
    }
  }

  // ── 双语开发信生成 ──────────────────────────────────────────────
  function generateDevLetter(cname, country, category, website, signals, lang) {
    const es = (lang === 'es');
    const name = cname || 'your company';
    const stars = signals.found.length > 0 ? signals.found.join(', ') : '';
    const hasExpansion = signals.found.some(s => s.includes('E:') || s.includes('扩张') || s.includes('expansion'));
    const hasImport = signals.found.some(s => s.includes('C:') || s.includes('进口') || s.includes('import'));
    const hasHiring = signals.found.some(s => s.includes('B:') || s.includes('招聘') || s.includes('hiring'));

    const esLetter = `## 📧 开发信（西语）

**Asunto:** Soporte logístico para ${name}

Buen día,

Espero que sus operaciones estén marchando sobre ruedas.
${hasExpansion ? `
He seguido con atención las noticias sobre la expansión de ${name} — una señal clara de crecimiento y ambición.` : ''}
${hasImport ? `
Sabemos que para un fabricante como ustedes, la cadena de suministro entre Asia y México es el corazón del negocio. Un contenedor atascado en aduana no es una opción.` : ''}
${hasHiring ? `
Notamos que están reforzando su equipo de compras/logística, lo que sugiere que están evaluando nuevos proveedores.` : ''}

Somos YQN Logistics Technology Group, especializados en logística integral Asia-México para fabricantes. Gestionamos:

- **Flete marítimo Asia → Manzanillo/Lázaro Cárdenas**
- **Despacho aduanal IMMEX** (pedimentos, certificación de origen, anexos 24/31)
- **Transporte terrestre a planta** (cross-dock en Monterrey si se requiere)
- **Regímenes de importación temporal** y administración de inventario in-bond

¿Están evaluando nuevos proveedores logísticos? Me encantaría conversar 5 minutos para entender sus necesidades y mostrarle cómo trabajamos.

Quedo atento,
**Zayne Jin** | Overseas Sales · LatAm Desk
YQN Logistics Technology Group
zayne_jin@yqn.com | +86 18487665870 | www.yqn.com`;

    const enLetter = `## 📧 Development Letter (English)

**Subject:** Logistics support for ${name}

Hi,

Hope your operations are running smoothly.
${hasExpansion ? `
I've been following ${name}'s recent expansion — impressive growth trajectory.` : ''}
${hasImport ? `
As a manufacturer with Asia-Mexico supply chains, we understand that a container stuck in customs is simply not an option for your production line.` : ''}
${hasHiring ? `
I noticed your team is growing on the procurement/logistics side — often a sign that new supplier relationships are being evaluated.` : ''}

We are YQN Logistics Technology Group, specializing in end-to-end Asia-Mexico logistics for manufacturers. We handle:

- **Ocean freight Asia → Manzanillo/Lázaro Cárdenas**
- **IMMEX customs clearance** (pedimentos, origin certification, annexes 24/31)
- **Inland transport to your plant** (cross-dock in Monterrey if needed)
- **Temporary import regimes** and in-bond inventory management

Are you evaluating new logistics partners? I'd love to chat for 5 minutes to understand your needs and show you how we work.

Best regards,
**Zayne Jin** | Overseas Sales · LatAm Desk
YQN Logistics Technology Group
zayne_jin@yqn.com | +86 18487665870 | www.yqn.com`;

    if (lang === 'pt') {
      return `## 📧 Carta de Desenvolvimento (Português)

**Assunto:** Suporte logístico para ${name}

Bom dia,

Espero que suas operações estejam indo bem.
${hasExpansion ? `
Acompanhei as notícias sobre a expansão da ${name} — um sinal claro de crescimento.` : ''}

Somos a YQN Logistics Technology Group, especializados em logística integrada Ásia-Brasil. Gerenciamos frete marítimo, despacho aduaneiro e transporte terrestre até sua fábrica.

Podemos conversar 5 minutos?

Atenciosamente,
**Zayne Jin** | Overseas Sales · LatAm Desk
YQN Logistics Technology Group
zayne_jin@yqn.com | +86 18487665870 | www.yqn.com

---
${enLetter}`;
    }

    return esLetter + '\n\n---\n\n' + enLetter;
  }

  // ── 通用背调引擎：搜索 → cheerio抓取 → DeepSeek写报告 ────────
  async function searchThenDeepSeek(cname, company, searcher) {
    const cfg = loadSearchConfig();
    const apiKey = cfg?.translate?.deepseek?.apiKey || '';
    const exaKey = cfg.search?.exaKey || '';
    const serperKey = cfg.search?.serperKey || '';
    const tvlyKey = cfg.search?.apiKey || '';
    const country = (company.country || '').trim() || 'Mexico';
    const category = (company.category || '').trim();
    const fname = sanitizeFilename(cname).trim();
    const dateStr = new Date().toISOString().slice(0, 10);
    const isBrazil = /bra[sz]il/i.test(country);
    const emailSection = (isBrazil
      ? '## 开发信（葡语）\n\n' +
        '**Subject:** [15词以内，基于背调发现的具体痛点]\n\n' +
        '一句话自我介绍 + 点名对方一个具体情况建立关联。\n\n' +
        '【能力展示 — 分点列出，每条加粗关键词】\n' +
        '- **海运头程：** 使用公司资料真实数字\n' +
        '- **关务清关：** 使用公司资料真实数字\n' +
        '- **仓储配送：** 使用公司资料真实数字\n\n' +
        '【信任背书 — 择2-3个相关者列出】\n' +
        '- 认证/投资/规模等\n\n' +
        'CTA一句，给帮助不索要。\n\n' +
        '**Saludos**\n'
      : '## 开发信（西语）\n\n' +
        '**Subject:** [15词以内，基于背调发现的具体痛点]\n\n' +
        '一句话自我介绍 + 点名对方一个具体情况建立关联。\n\n' +
        '【能力展示 — 分点列出，每条加粗关键词】\n' +
        '- **海运头程：** 使用公司资料真实数字\n' +
        '- **关务清关：** 使用公司资料真实数字\n' +
        '- **仓储配送：** 使用公司资料真实数字\n\n' +
        '【信任背书 — 择2-3个相关者列出】\n' +
        '- 认证/投资/规模等\n\n' +
        'CTA一句，给帮助不索要。\n\n' +
        '**Saludos**\n'
    ) +
    '【开发信规则】①禁止"Espero que este mensaje...""Somos líderes""Estimado/a"等废话开头 ②禁止空洞形容词（competitivo/eficiente）和技术词（digital/AI/平台）③禁止最高级/紧迫词/夸大承诺/价格诱饵/全大写/感叹号 ④同一封不同时出现船东名+具体运价 ⑤全文第二人称不教客户 ⑥Saludos后无任何文字 ⑦必须引用公司资料真实数字\n';

    // Phase 1: 搜索
    notifyBackcheck(cname, { type: 'research-progress', progress: searcher + ' 搜索...' });
    let searchContext = '';
    if (searcher === 'exa' && exaKey) {
      try {
        const raw = await new Promise(r => {
          const body = JSON.stringify({ query: cname + ' ' + country + ' company', numResults: 8, type: 'auto' });
          const opts = { hostname: 'api.exa.ai', port: 443, method: 'POST', path: '/search', headers: { 'Content-Type': 'application/json', 'x-api-key': exaKey }, timeout: 15000, rejectUnauthorized: false };
          const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
          req.on('error', () => r(null)); req.on('timeout', () => { req.destroy(); r(null); }); req.end(body);
        });
        if (raw?.results?.length) {
          searchContext = raw.results.slice(0, 6).map(r => '标题：' + (r.title || '') + '\nURL：' + (r.url || '') + '\n内容：' + (r.text || '').slice(0, 400)).join('\n\n');
        }
      } catch {}
    } else if (searcher === 'serper' && serperKey) {
      try {
        const raw = await new Promise(r => {
          const body = JSON.stringify({ q: cname + ' ' + country, num: 8 });
          const opts = { hostname: 'google.serper.dev', port: 443, method: 'POST', path: '/search', headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey }, timeout: 15000, rejectUnauthorized: false };
          const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
          req.on('error', () => r(null)); req.on('timeout', () => { req.destroy(); r(null); }); req.end(body);
        });
        if (raw?.organic?.length) {
          searchContext = raw.organic.slice(0, 6).map(r => '标题：' + (r.title || '') + '\nURL：' + (r.link || '') + '\n内容：' + (r.snippet || '').slice(0, 400)).join('\n\n');
        }
      } catch {}
    } else if (searcher === 'tavily' && tvlyKey) {
      try {
        const raw = await new Promise(r => {
          const body = JSON.stringify({ api_key: tvlyKey, query: cname + ' ' + country, search_depth: 'advanced', max_results: 8, include_answer: true });
          const opts = { hostname: 'api.tavily.com', port: 443, method: 'POST', path: '/search', headers: { 'Content-Type': 'application/json' }, timeout: 15000, rejectUnauthorized: false };
          const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
          req.on('error', () => r(null)); req.on('timeout', () => { req.destroy(); r(null); }); req.end(body);
        });
        if (raw?.answer) searchContext += 'AI摘要：' + raw.answer + '\n\n';
        if (raw?.results?.length) {
          searchContext += raw.results.slice(0, 6).map(r => '标题：' + (r.title || '') + '\nURL：' + (r.url || '') + '\n内容：' + (r.content || '').slice(0, 400)).join('\n\n');
        }
      } catch {}
    } else if (searcher === 'none') {
      // 纯 DeepSeek，不搜索，基于训练数据
      searchContext = '';
    }

    // Phase 2: DeepSeek 生成报告
    notifyBackcheck(cname, { type: 'research-progress', progress: 'DeepSeek 分析...' });
    if (!apiKey) return { ok: false, status: 'error', message: '请配置 DeepSeek API Key' };

    const systemPrompt = '你是YQN物流集团（主营中国↔拉美海运/空运/报关/保税仓储）的商业情报分析师。' +
      '直接输出报告，禁止任何前置寒暄、问候语、"好的"、"以下是"等废话。第一行必须是 # 标题。\n\n' +
      '【输出模板 — 严格遵循】\n\n' +
      '# 公司名 ⭐X/5\n\n> 国家 · 品类 | 货代开发价值 ⭐X/5\n\n' +
      '| 项目 | 内容 |\n|------|------|\n| 官网 | URL |\n| 国家 | |\n| 品类 | |\n| 规模 | |\n| 总部 | |\n| 业务 | |\n\n' +
      '## 深度分析\n\n2-3段，覆盖：业务模式、供应链结构、是否从亚洲/中国进口、关务复杂度。只写结论，不写推理过程。\n\n' +
      '## 近期动态\n\n每条一行，格式：- YYYY-MM 事件简述（来源）。最多5条，搜不到写「- 未找到近期公开动态」\n\n' +
      '## 开发信号\n\n每条一行，格式：- ✅/❌ 信号名 — 一句话证据。禁止写"未找到相关信息"这种废话，直接写- ❌ 信号名\n\n' +
      '## 评级\n\n总分 X/5。A(+3) B(+2~3) C(+1~2) D(+1) E(+1) F(+1)，内部物流-3。一句话说明理由。\n\n' +
      emailSection +
      '\n> 📅 ' + dateStr + ' · ' + searcher + ' + DeepSeek\n\n' +
      '【硬约束】' +
      '① 直接输出报告，禁止"好的""以下是""根据搜索结果"等开场白 ' +
      '② 评分必须用数字 ⭐X/5，禁止只写星星 ' +
      '③ 表格 | 项目 | 内容 | 第二列必须填，未知写 ⚠️待验证 ' +
      '④ 信号行简洁：- ✅ C: 从中国进口 — 官网显示主营亚洲货源。禁止写成"未找到相关信息"长句 ' +
      '⑤ 开发信以真人商务口吻写，禁止出现"AI""分析报告""评估""情报"等词。正文后只写 Saludos 即结束，其后绝对不写任何文字（禁止姓名/职位/公司名/联系方式） ' +
      '⑥ 禁止复述用户输入（如"您提供的国家为Mexico"），直接写结论 ' +
      '⑦ 不同公司必须有不同的分析内容，禁止模板化复制 ' +
      '⑧ 开发信只生成' + (isBrazil ? '葡语' : '西语') + '版本，不生成英语。Saludos 后无任何文字\n\n' +
      '【公司资料 — 开发信引用以下真实数字，禁止编造】\n' +
      'YQN Logistics：全球1500+员工、25+分公司（含墨西哥直属）、服务35000+企业、合作300+船司（COSCO/Maersk/CMA CGM/MSC等）、18个海外仓600万+sqft（含墨西哥）、覆盖200+国家、年营收近80亿元。红杉中国/Coatue投资、D轮独角兽。AEO认证。\n' +
      '墨西哥本地：直属分公司+海外仓+清关团队（非外包）、RFC合规正清（通关3-5天、查验率<5%）、正清通过率95%+。\n' +
      '能力：海运/空运/报关/保税仓储/全程可视化/AI订舱30分钟出预配/300+船司实时比价。\n' +
      '发信人：' + (cfg?.sender?.name || 'Zayne') + ' | Overseas Sales · LatAm Desk | YQN Logistics\n\n' +
      '【开发信自查清单 — 生成后逐项确认】\n' +
      '- 对象类型正确（代理不提本地仓库/本地团队；直客可提墨西哥本地化；未标签用通用语言，不提本地也不否定）\n' +
      '- 无广告垃圾词（最高级/紧迫词/夸大承诺/价格诱饵/排名宣称/全大写/感叹号）\n' +
      '- 无空洞形容词（competitivo/eficiente等），líder不超过1次且有事实支撑\n' +
      '- 无 digital/AI/平台/technology 等技术词汇\n' +
      '- 全文第二人称，不教客户做事\n' +
      '- 首段无"Somos/We are"（Hook说客户不说自己）\n' +
      '- CTA是给不是要\n' +
      '- 无占位符残留[XXX]\n' +
      '- Saludos 后无任何文字（无姓名/职位/公司名）\n' +
      '- 同一封不同时出现船东名+具体运价';

    const userPrompt = '公司名：' + cname + '\n国家：' + country + '\n品类：' + (category || '未知') +
      (searchContext ? '\n\n【实时搜索结果】\n\n' + searchContext : '\n\n（无实时搜索结果，基于你的知识分析）') +
      '\n\n请开始分析。';

    try {
      const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.3, max_tokens: 4000 });
      const result = await new Promise((resolve) => {
        const opts = { hostname: 'api.deepseek.com', port: 443, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, timeout: 60000, rejectUnauthorized: false };
        const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
        req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end(body);
      });
      if (!result?.choices?.[0]?.message?.content) return { ok: false, status: 'error', message: 'DeepSeek 返回空' };
      const fullText = result.choices[0].message.content;
      const rating = parseInt((fullText.match(/⭐(\d)\/5/) || [])[1]) || 3;

      // 保存完整报告（含开发信）+ 同时另存开发信独立文件给加入队列用
      const dir = path.join(__dirname, '..', 'reports');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const reportPath = path.join(dir, '客户背调-' + fname + '.md');
      fs.writeFileSync(reportPath, fullText);

      const emailSplit = fullText.split(/\n##\s*开发信/);
      if (emailSplit.length > 1) {
        const emailBody = ('## 开发信' + emailSplit[1]).trim();
        if (emailBody.length >= 20) {
          const emailPath = path.join(dir, '客户背调-' + fname + '-email.md');
          fs.writeFileSync(emailPath, emailBody);
        }
      }
      notifyBackcheck(cname, { type: 'research-progress', progress: '报告已生成' });
      return { ok: true, status: 'done', rating, message: '报告已生成' };
    } catch (e) { return { ok: false, status: 'error', message: '请求失败: ' + (e.message || '未知') }; }
  }

  const searchProviders = {
    // ── Scrapling 智能抓取（默认，推荐）──────────────────────────
    'scrapling': {
      name: 'Scrapling 智能抓取',
      research: async (cname, company) => {
        // 1. DDG 搜索
        notifyBackcheck(cname, { type: 'research-progress', progress: '搜索公司信息...' });
        const searchResult = await callScraplingAPI(
          `/search/web?q=${encodeURIComponent(cname)}&n=8`
        );

        let urlToCrawl = searchResult?.foundUrl || '';
        if (!urlToCrawl && company.website && company.website.startsWith('http')) {
          urlToCrawl = company.website;
        }

        // 2. 官网抓取
        let websiteText = '';
        if (urlToCrawl) {
          notifyBackcheck(cname, { type: 'research-progress', progress: '抓取官网...' });
          try {
            const webResult = await callScraplingAPI(
              `/scrape/website?url=${encodeURIComponent(urlToCrawl)}&stealth=true&max_chars=3000`
            );
            if (webResult?.ok) {
              const parts = [];
              if (webResult.meta_desc) parts.push(`**简介:** ${webResult.meta_desc}`);
              if (webResult.text) parts.push(webResult.text);
              websiteText = parts.join('\n');
            }
          } catch {}
        }

        // 3. 评分 + 报告生成（与 ddg-crawl 共用逻辑）
        const allText = ((searchResult?.snippets || '') + ' ' + websiteText).trim();
        const { rating, signals } = autoRate(allText, company);
        const signalParts = [];
        if (signals.found.length) signalParts.push('✅ ' + signals.found.join(' / '));
        if (signals.warn.length) signalParts.push('⚠️ ' + signals.warn.join(' / '));
        if (signals.missing.length) signalParts.push('❌ ' + signals.missing.join(' / '));
        const signalText = signalParts.length ? ' ' + signalParts.join(' | ') : '';
        const stars = '⭐'.repeat(Math.min(5, Math.max(1, rating)));
        const tags = [company.country, company.category].filter(Boolean).join(' · ') || '信息待补充';
        const fname = sanitizeFilename(cname).trim();
        const dateStr = new Date().toISOString().slice(0, 10);
        const hasWebsite = websiteText.length > 100;

        const lines = [];
        lines.push('# ' + cname);
        lines.push('');
        lines.push('> ' + tags + ' | 开发价值 ' + stars + '（' + rating + '/5）' + signalText);
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push('## 基本信息');
        lines.push('');
        lines.push('| 项目 | 内容 |');
        lines.push('|------|------|');
        lines.push('| **公司** | ' + cname + ' |');
        if (company.country) lines.push('| **国家** | ' + company.country + ' |');
        if (company.category) lines.push('| **品类** | ' + company.category + ' |');
        if (company.email) lines.push('| **邮箱** | ' + company.email + ' |');
        if (urlToCrawl) lines.push('| **网站** | ' + urlToCrawl + ' |');
        lines.push('');

        if (searchResult?.snippets) {
          lines.push('## 搜索发现');
          lines.push('');
          lines.push(searchResult.snippets.slice(0, 2000));
          lines.push('');
        }

        lines.push('## 官网洞察');
        lines.push('');
        if (hasWebsite) {
          lines.push(websiteText.slice(0, 2500));
        } else if (urlToCrawl) {
          lines.push('_官网已抓取但内容有限_');
        } else {
          lines.push('_未找到官网。请在数据中补充网站字段后重新背调。_');
        }
        lines.push('');
        lines.push('---');
        lines.push('> 📅 ' + dateStr + ' · Scrapling 智能抓取（TLS 指纹伪装 + Cloudflare 绕过）');

        const report = lines.join('\n');
        const reportPath = path.join(__dirname, '..', 'reports', '客户背调-' + fname + '.md');
        const dir = path.dirname(reportPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(reportPath, report);

        return { ok: true, status: 'done', rating, message: '报告已生成' };
      }
    },

    // ── DDG + 官网爬虫（旧版 Puppeteer，保留备用）───────────────
    'ddg-crawl': {
      name: 'DDG + 官网',
      research: async (cname, company) => {
        notifyBackcheck(cname, { type: 'research-progress', progress: 'DDG 搜索中...' });
        const ddg = await ddgSearch(cname);

        let websiteText = '', urlToCrawl = ddg.foundUrl;
        if (!urlToCrawl && company.website && company.website.startsWith('http')) {
          try {
            const host = new URL(company.website).hostname;
            if (host && !host.includes('linkedin.com') && !host.includes('facebook.com')) urlToCrawl = company.website;
          } catch {}
        }
        if (urlToCrawl) {
          notifyBackcheck(cname, { type: 'research-progress', progress: '抓取官网...' });
          try { websiteText = await crawlWebsite(urlToCrawl); } catch {}
        }

        const allText = (ddg.snippets + ' ' + websiteText).trim();
        const { rating, signals } = autoRate(allText, company);
        const signalParts = [];
        if (signals.found.length) signalParts.push('✅ ' + signals.found.join(' / '));
        if (signals.warn.length) signalParts.push('⚠️ ' + signals.warn.join(' / '));
        if (signals.missing.length) signalParts.push('❌ ' + signals.missing.join(' / '));
        const signalText = signalParts.length ? ' ' + signalParts.join(' | ') : '';
        const stars = "\u2B50".repeat(Math.min(5, Math.max(1, rating)));
        const tags = [company.country, company.category].filter(Boolean).join(" · ") || "信息待补充";
        const fname = sanitizeFilename(cname).trim();
        const dateStr = new Date().toISOString().slice(0, 10);
        const hasWebsite = websiteText.length > 100;

        const lines = [];
        lines.push("# " + cname);
        lines.push("");
        lines.push("> " + tags + " | 开发价值 " + stars + "（" + rating + "/5）" + signalText);
        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push("## 基本信息");
        lines.push("");
        lines.push("| 项目 | 内容 |");
        lines.push("|------|------|");
        lines.push("| **公司** | " + cname + " |");
        if (company.country) lines.push("| **国家** | " + company.country + " |");
        if (company.category) lines.push("| **品类** | " + company.category + " |");
        if (company.email) lines.push("| **邮箱** | " + company.email + " |");
        if (urlToCrawl) lines.push("| **网站** | " + urlToCrawl + " |");
        lines.push("");

        if (ddg.snippets) {
          lines.push("## DDG 搜索结果");
          lines.push("");
          lines.push(ddg.snippets.slice(0, 2000));
          lines.push("");
        }

        lines.push("## 官网洞察");
        lines.push("");
        if (hasWebsite) {
          lines.push(websiteText.slice(0, 2500));
        } else if (urlToCrawl) {
          lines.push("_官网已抓取但内容有限_");
        } else {
          lines.push("_未找到官网。请在数据中补充网站字段后重新背调。_");
        }
        lines.push("");
        lines.push("---");
        lines.push("> 📅 " + dateStr + " · DDG + 官网爬虫");

        const report = lines.join("\n");
        const reportPath = path.join(__dirname, "..", "reports", "客户背调-" + fname + ".md");
        const dir = path.dirname(reportPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(reportPath, report);

        return { ok: true, status: "done", rating, message: "报告已生成" };
      }
    },

    // ── Google 搜索 → DeepSeek 写报告 ──────────────────────────
    'serper-deepseek': {
      name: 'Google + DeepSeek',
      research: async (cname, company) => searchThenDeepSeek(cname, company, 'serper')
    },

    // ── Tavily 搜索 → DeepSeek 写报告 ─────────────────────────
    'tavily-deepseek': {
      name: 'Tavily + DeepSeek',
      research: async (cname, company) => searchThenDeepSeek(cname, company, 'tavily')
    },

    // ── 纯 DeepSeek（无搜索，最快，基于训练数据）──────────────
    'ds-only': {
      name: 'DeepSeek 快速',
      research: async (cname, company) => searchThenDeepSeek(cname, company, 'none')
    },

    // ── Agent-Reach 多平台背调（纯 HTTP API，零 CLI 依赖）─────────────
    'agent-reach': {
      name: 'Agent-Reach 多平台',
      research: async (cname, company) => {
        const cfg = loadSearchConfig();

        // ── 公司名清洗 ──
        const SUFFIXES = /\b(LTDA|S\.A\.?( DE C\.?V\.?)?|S DE R\.?L DE C\.?V\.?|SA DE CV|S\.?R\.?L\.?|LTD\.?|INC\.?|LLC|CORP\.?|GMBH|S\.?L\.?U\.?|PTY\.? LTD\.?)\b/gi;
        const cleanName = cname.replace(SUFFIXES, '').replace(/\s{2,}/g, ' ').trim();
        const displayName = cleanName || cname;

        // ── 从表字段获取辅助信息 ──
        let country = (company.country || '').trim();
        let category = (company.category || '').trim();
        let website = (company.website || '').trim();
        if (website && !website.startsWith('http')) website = '';

        // ── HTTPS 请求封装 ──
        function httpsPost(hostname, port, path, headers, body, timeoutMs) {
          return new Promise((resolve) => {
            const opts = { hostname, port, method: 'POST', path, headers, timeout: timeoutMs || 25000 };
            const req = https.request(opts, (res) => {
              let d = '';
              res.on('data', c => d += c);
              res.on('end', () => resolve(d));
            });
            req.on('error', (e) => { console.error('[agent-reach] httpsPost error:', hostname, e.message); resolve(''); });
            req.on('timeout', () => { req.destroy(); resolve(''); });
            req.end(typeof body === 'string' ? body : JSON.stringify(body));
          });
        }

        function httpsGet(urlStr, headers, timeoutMs) {
          return new Promise((resolve) => {
            try {
              const u = new URL(urlStr);
              const opts = {
                hostname: u.hostname, port: u.port || 443, method: 'GET', rejectUnauthorized: false,
                path: u.pathname + u.search, headers: headers || {},
                timeout: timeoutMs || 25000,
              };
              const req = https.request(opts, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                  httpsGet(res.headers.location, headers, timeoutMs).then(resolve);
                  return;
                }
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => resolve(d));
              });
              req.on('error', (e) => { console.error('[agent-reach] httpsGet error:', urlStr.slice(0,60), e.message); resolve(''); });
              req.on('timeout', () => { req.destroy(); resolve(''); });
              req.end();
            } catch (e) { console.error('[agent-reach] httpsGet parse error:', e.message); resolve(''); }
          });
        }
        const exaKey = cfg.search?.exaKey || '';

        // ── 辅助：提取 Exa entities 中的结构化数据 ──
        function extractEntities(results) {
          let entity = null;
          for (const r of results) {
            if (r.entities && r.entities.length > 0) {
              for (const e of r.entities) {
                if (e.type === 'company' && e.properties) {
                  entity = e.properties; break;
                }
              }
              if (entity) break;
            }
          }
          return entity;
        }

        // ════════════════════════════════════════════════════════════════
        // 搜索 1：Exa 公司概览 + 实体数据
        // ════════════════════════════════════════════════════════════════
        notifyBackcheck(cname, { type: 'research-progress', progress: 'Exa AI 搜索公司信息...' });
        let exaUrl = '', entity = null;
        try {
          const q1 = `${cleanName}${country ? ' ' + country : ''} company profile overview`;
          const exaRaw1 = await httpsPost('api.exa.ai', 443, '/search',
            { 'Content-Type': 'application/json', 'x-api-key': exaKey },
            JSON.stringify({ query: q1, numResults: 5, type: 'auto' }), 30000);
          if (exaRaw1) {
            const j1 = JSON.parse(exaRaw1);
            const results = j1.results || [];
            entity = extractEntities(results);
            if (results.length > 0) {
              exaUrl = entity?.headquarters ? results[0]?.url || '' : results[0]?.url || '';
              // 如果 entity 没给官网，从结果中找看起来像官网的URL
              if (!exaUrl || exaUrl.includes('linkedin.com') || exaUrl.includes('exa.ai')) {
                for (const r of results) {
                  const u = r.url || '';
                  if (u && !u.includes('linkedin.com') && !u.includes('exa.ai') && !u.includes('bnamericas.com')) {
                    exaUrl = u; break;
                  }
                }
              }
            }
          }
        } catch (e) { console.error('[agent-reach] Exa search 1:', e.message); }

        // ── 从 entity 推断缺失字段 ──
        if (!country && entity?.headquarters?.country) {
          country = entity.headquarters.country;
        }
        if (!category && entity?.description) {
          // 从描述中提取行业关键词
          const desc = entity.description.toLowerCase();
          for (const [kw, cat] of [['pneumatic', '气动元件/工业自动化'], ['automotive', '汽车零部件'], ['packaging', '包装'],
            ['pharmaceutical', '制药'], ['food', '食品'], ['mining', '采矿'], ['steel', '钢铁'], ['oil', '石油天然气'],
            ['textile', '纺织'], ['electronics', '电子'], ['machinery', '机械'], ['chemical', '化工'],
            ['automation', '工业自动化'], ['auto parts', '汽车零部件'], ['medical', '医疗器械'],
            ['cosmetic', '化妆品'], ['furniture', '家具'], ['construction', '建筑']]) {
            if (desc.includes(kw)) { category = cat; break; }
          }
        }

        // ════════════════════════════════════════════════════════════════
        // 搜索 2：Exa 贸易/进口特征
        // ════════════════════════════════════════════════════════════════
        notifyBackcheck(cname, { type: 'research-progress', progress: 'Exa AI 搜索贸易数据...' });
        let tradeText = '';
        try {
          const q2 = `${cleanName}${country ? ' ' + country : ''} import export trade shipments`;
          const exaRaw2 = await httpsPost('api.exa.ai', 443, '/search',
            { 'Content-Type': 'application/json', 'x-api-key': exaKey },
            JSON.stringify({ query: q2, numResults: 5, type: 'auto' }), 30000);
          if (exaRaw2) {
            const j2 = JSON.parse(exaRaw2);
            if (!entity) entity = extractEntities(j2.results || []);
            const tradeResults = j2.results || [];
            // 过滤出真正的贸易数据页面
            const tradeSites = tradeResults.filter(r => {
              const u = (r.url || '').toLowerCase();
              return u.includes('exportgenius') || u.includes('tendata') || u.includes('volza') ||
                     u.includes('importgenius') || u.includes('tradeimex') || u.includes('seair') ||
                     u.includes('panjiva') || u.includes('marketinsidedata');
            });
            if (tradeSites.length > 0) {
              tradeText = tradeSites.map(r =>
                `- **${r.title || '贸易数据'}**\n  ${r.url || ''}`
              ).join('\n');
            }
          }
        } catch (e) { console.error('[agent-reach] Exa search 2:', e.message); }

        // ════════════════════════════════════════════════════════════════
        // 搜索 3：Jina Reader 官网深度抓取
        // ════════════════════════════════════════════════════════════════
        notifyBackcheck(cname, { type: 'research-progress', progress: 'Jina Reader 抓取官网...' });
        let websiteText = '';
        const urlToRead = website || exaUrl;
        if (urlToRead && urlToRead.startsWith('http')) {
          try {
            const jinaRaw = await httpsGet('https://r.jina.ai/' + urlToRead,
              { 'Accept': 'text/markdown' }, 30000);
            if (jinaRaw && jinaRaw.length > 100) {
              websiteText = jinaRaw.length > 4000 ? jinaRaw.slice(0, 4000) : jinaRaw;
            }
          } catch (e) { console.error('[agent-reach] Jina:', e.message); }
        }

        // ════════════════════════════════════════════════════════════════
        // 搜索 4：Tavily 新闻动态
        // ════════════════════════════════════════════════════════════════
        notifyBackcheck(cname, { type: 'research-progress', progress: 'Tavily 搜索新闻动态...' });
        let tavilyText = '';
        try {
          const tvlyKey = (cfg?.search?.apiKey) || '';
          if (tvlyKey) {
            const tvlyQuery = `${cleanName}${country ? ' ' + country : ''}`;
            const tvlyBody = JSON.stringify({
              api_key: tvlyKey, query: tvlyQuery,
              search_depth: 'basic', max_results: 5, include_answer: true,
            });
            const tvlyRaw = await httpsPost('api.tavily.com', 443, '/search',
              { 'Content-Type': 'application/json' }, tvlyBody, 25000);
            if (tvlyRaw) {
              const tvlyJson = JSON.parse(tvlyRaw);
              const results = tvlyJson.results || [];
              if (tvlyJson.answer) tavilyText = tvlyJson.answer + '\n\n';
              tavilyText += results.map(r =>
                `- **${r.title || ''}**\n  ${r.content || r.snippet || ''}\n  ${r.url || ''}`
              ).join('\n\n');
            }
          }
        } catch (e) { console.error('[agent-reach] Tavily:', e.message); }

        // ════════════════════════════════════════════════════════════════
        // 组装报告
        // ════════════════════════════════════════════════════════════════
        notifyBackcheck(cname, { type: 'research-progress', progress: '生成报告...' });

        const combined = [
          entity?.description || '', websiteText, tavilyText, tradeText
        ].join('\n');
        const { rating, signals } = autoRate(combined, company);
        const stars = '⭐'.repeat(Math.min(5, Math.max(1, rating)));
        const signalParts = [];
        if (signals.found.length) signalParts.push('✅ ' + signals.found.join(' / '));
        if (signals.warn.length) signalParts.push('⚠️ ' + signals.warn.join(' / '));
        if (signals.missing.length) signalParts.push('❌ ' + signals.missing.join(' / '));
        const signalText = signalParts.length ? ' ' + signalParts.join(' | ') : '';
        const fname = sanitizeFilename(cname).trim();
        const dateStr = new Date().toISOString().slice(0, 10);
        const hasEntity = !!entity?.description;
        const hasWebsite = websiteText.length > 100;
        const hasNews = tavilyText.length > 50;
        const hasTrade = tradeText.length > 20;

        // 规模信息
        const workforce = entity?.workforce?.total || entity?.workforce || '';
        const hq = entity?.headquarters;
        const founded = entity?.foundedYear || '';
        const webTraffic = entity?.webTraffic?.visitsMonthly || '';

        const lines = [];
        lines.push('# ' + displayName + ' — 背调信息卡');
        lines.push('');

        // ── 公司概况 ──
        lines.push('## 公司概况');
        lines.push('');
        const overviewParts = [];
        if (country) overviewParts.push('**国家：** ' + country);
        if (category) overviewParts.push('**品类：** ' + category);
        if (urlToRead) overviewParts.push('**官网：** ' + urlToRead);
        let scaleStr = '';
        if (workforce) scaleStr += workforce + ' 人';
        if (webTraffic) scaleStr += (scaleStr ? '，' : '') + '月访问 ' + webTraffic + ' 次';
        if (founded) scaleStr += (scaleStr ? '，' : '') + '成立 ' + founded;
        if (entity?.description) {
          // 从描述中提取母公司线索
          const parentMatch = entity.description.match(/(?:subsidiary|子公司|集团|group|corporation)\s+(?:of\s+)?([A-Z][A-Za-z\s&]+?)(?:,|\.|in\s|headquarters|headquartered|\n|$)/i);
          if (parentMatch && !entity.description.toLowerCase().includes('smc')) scaleStr += '';
        }
        if (scaleStr) overviewParts.push('**规模：** ' + scaleStr);
        lines.push(overviewParts.join('  |  '));
        lines.push('');
        // 兼容字段提取
        lines.push('网站：' + (urlToRead || '未知'));
        if (country) lines.push('国家：' + country);
        if (category) lines.push('品类：' + category);
        if (company.email) lines.push('邮箱：' + company.email);

        // ── 业务描述 ──
        if (hasEntity) {
          lines.push('');
          lines.push('## 业务描述');
          lines.push('');
          const desc = entity.description.replace(/\n{3,}/g, '\n\n').trim();
          // 去掉过于冗长的部分，保留核心业务描述
          const paragraphs = desc.split('\n').filter(p => p.trim().length > 20);
          lines.push(paragraphs.slice(0, 4).join('\n\n'));
        }

        // ── 公司详情 ──
        const details = [];
        if (hq?.address) details.push('- **总部：** ' + hq.address);
        else if (hq?.city) details.push('- **总部：** ' + [hq.city, hq.country].filter(Boolean).join(', '));
        if (founded) details.push('- **成立：** ' + founded);
        if (workforce) details.push('- **员工：** ' + workforce + ' 人');
        if (entity?.description) {
          const globalMatch = entity.description.match(/(\d+)\s*(?:countries|国家|países|paises)/i);
          if (globalMatch) details.push('- **全球布局：** ' + globalMatch[1] + ' 个国家');
          const shareMatch = entity.description.match(/(\d+)%/);
          if (shareMatch) details.push('- **市场份额：** ' + shareMatch[0]);
        }
        if (details.length > 0) {
          lines.push('');
          lines.push('## 公司详情');
          lines.push('');
          lines.push(details.join('\n'));
        }

        // ── 官网信息 ──
        if (hasWebsite) {
          lines.push('');
          lines.push('## 官网分析');
          lines.push('');
          lines.push(websiteText.slice(0, 3000));
        }

        // ── 贸易数据 ──
        if (hasTrade) {
          lines.push('');
          lines.push('## 贸易活动');
          lines.push('');
          lines.push(tradeText);
        }

        // ── 近期动态 ──
        if (hasNews) {
          lines.push('');
          lines.push('## 近期动态');
          lines.push('');
          lines.push(tavilyText.slice(0, 2500));
        }

        // ── 开发信号评估（基于证据，非推断）─────────────────────
        lines.push('');
        lines.push('## 开发信号');
        lines.push('');
        if (signals.found.length) {
          lines.push('### ✅ 正向信号');
          lines.push('');
          for (const s of signals.found) lines.push('- ' + s);
          lines.push('');
        }
        if (signals.warn.length) {
          lines.push('### ⚠️ 风险信号');
          lines.push('');
          for (const s of signals.warn) lines.push('- ' + s);
          lines.push('');
        }
        if (signals.missing.length) {
          lines.push('### ❌ 缺失信号');
          lines.push('');
          for (const s of signals.missing) lines.push('- ' + s);
          lines.push('');
        }
        if (!signals.found.length && !signals.missing.length && !signals.warn.length) {
          lines.push('未发现明确信号，需人工判断。');
          lines.push('');
        }

        lines.push('> **国家：** ' + (country || '未知') + ' | **品类：** ' + (category || '未知') + ' | **货代开发价值：** ' + stars + '（' + rating + '/5）');
        lines.push('');
        const summaryParts = [];
        if (signals.found.length) summaryParts.push('✅ ' + signals.found.join(' / '));
        if (signals.warn.length) summaryParts.push('⚠️ ' + signals.warn.join(' / '));
        if (signals.missing.length) summaryParts.push('❌ ' + signals.missing.join(' / '));
        if (summaryParts.length) {
          lines.push('**' + summaryParts.join(' | ') + '**');
        }
        if (rating >= 4) lines.push('高价值 — 优先开发');
        else if (rating >= 3) lines.push('中等价值 — 可跟进');
        else lines.push('低价值 — 信号不足，建议补充数据后重新背调');
        lines.push('');
        lines.push('---');
        lines.push('> 📅 ' + dateStr + ' · Agent-Reach 多平台 API');

        const report = lines.join('\n');
        const reportPath = path.join(__dirname, '..', 'reports', '客户背调-' + fname + '.md');
        const dir = path.dirname(reportPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(reportPath, report);

        return { ok: true, status: 'done', rating, message: '报告已生成' };
      }
    },

    // ── Exa + DeepSeek（推荐）──────────────────────────────────
    'deep-research': {
      name: 'Exa + DeepSeek',
      research: async (cname, company) => searchThenDeepSeek(cname, company, 'exa')
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
    const m = content.match(/(?:货代)?开发价值[：:]\*\*\s*([⭐★1-5]+)/);
    return m ? (m[1].match(/[⭐★]/g) || []).length || parseInt(m[1]) || 0 : 0;
  }

  // ── 背调：异步执行 + 实时进度推送 ───────────────────────────────
  ipcMain.handle('backcheck:research', async (_e, company, providerKey) => {
    const cname = company.company;
    const st = readBackcheckStatus();

    // 已在调查中 → 阻止重复提交
    if (st[cname]?.status === 'researching') {
      return { ok: false, message: '该公司正在背调中，请等待完成' };
    }

    // 已有报告 → 删掉旧的，重新调查
    const existingReport = checkReportExists(cname);
    if (existingReport) {
      try { fs.unlinkSync(existingReport); } catch {}
      delete st[cname];
      writeBackcheckStatus(st);
    }

    // 立即返回，后台执行
    st[cname] = { status: 'researching', requestedAt: new Date().toISOString(), progress: '搜索启动...' };
    writeBackcheckStatus(st);
    notifyBackcheck(cname, { type: 'research-start' });

    // 后台异步（catch 防止未处理异常静默失败）
    researchInBackground(cname, company, providerKey || 'deep-research').catch(e => {
      console.error('[背调致命异常]', cname, e);
      updateStatus(cname, 'error', 0, e.message || '未知');
      notifyBackcheck(cname, { type: 'research-done', status: 'error', message: e.message });
    });

    return { ok: true, message: '背调已启动' };
  });

  // 后台搜索 + 进度推送
  async function researchInBackground(cname, company, providerKey) {
    try {
      // 使用渲染进程传来的 provider，不回退到 config
      providerKey = providerKey || 'deep-research';
      const provider = searchProviders[providerKey] || searchProviders['deep-research'];
      notifyBackcheck(cname, { type: 'research-progress', progress: provider.name + ' 搜索中...' });
      const result = await provider.research(cname, company);

      if (result.ok) {
        updateStatus(cname, 'done', result.rating || 0, '报告已生成');
      } else {
        updateStatus(cname, result.status || 'error', 0, result.message);
      }
    } catch (e) {
      console.error('[背调异常]', cname, e);
      updateStatus(cname, 'error', 0, e.message || '未知错误');
    }
    // 无论成功失败，都通知渲染进程
    const st = readBackcheckStatus();
    notifyBackcheck(cname, { type: 'research-done', status: st[cname]?.status || 'error' });
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
        country: extractField(content, '国家'),
        rating: extractRating(content),
        raw: content,
      };
    } catch { return { rating: 0, raw: '' }; }
  }

  // 批量更新联系人国家标签
  ipcMain.handle('contacts:updateCountry', async (_e, companyName, newCountry) => {
    const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');
    try {
      if (!fs.existsSync(contactsPath)) return { ok: false, error: '联系人文件不存在' };
      const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
      let updated = 0;
      for (const c of contacts) {
        if ((c.company || '').trim() === companyName.trim()) {
          c.country = newCountry;
          updated++;
        }
      }
      if (updated > 0) {
        fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2));
      }
      return { ok: true, updated, total: contacts.filter(c => (c.company || '').trim() === companyName.trim()).length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

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

  ipcMain.handle('backcheck:verifyEmail', async (_e, emailBody) => {
    return verifyEmailWithAgnes(emailBody);
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

  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (!url || typeof url !== 'string') return { ok: false, error: 'Invalid URL' };
    // 只允许 https 链接，防止滥用
    if (!url.startsWith('https://')) return { ok: false, error: 'Only HTTPS URLs allowed' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // ── 翻译报告 → 生成独立译文文件 ──────────────────────────────────
  function getReportPaths(companyName) {
    const fname = sanitizeFilename(companyName);
    return {
      src: path.join(__dirname, '..', 'reports', `客户背调-${fname}.md`),
      zh:  path.join(__dirname, '..', 'reports', `客户背调-${fname}-zh.md`),
    };
  }

  ipcMain.handle('translate:report', async (_e, companyName) => {
    const cfg = loadSearchConfig();
    const apiKey = cfg?.translate?.deepseek?.apiKey || '';
    if (!apiKey) return { ok: false, error: 'no_keys', message: '请先在设置中配置 DeepSeek API Key' };

    const { src, zh: zhPath } = getReportPaths(companyName);
    if (!fs.existsSync(src)) return { ok: false, error: 'no_report', message: '未找到背调报告文件' };

    const outDir = path.dirname(zhPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    try {
      const rawMd = fs.readFileSync(src, 'utf-8');
      // 全文本翻译：整份报告送入 DeepSeek，保留所有短文本
      const zhText = await translateFullReport(rawMd, apiKey);
      fs.writeFileSync(zhPath, zhText, 'utf-8');
      return { ok: true, text: zhText, zhPath };
    } catch (e) {
      return { ok: false, error: 'api_error', message: '翻译异常: ' + (e.message || '未知') };
    }
  });

  ipcMain.handle('translate:loadZh', async (_e, companyName) => {
    const { zh: zhPath } = getReportPaths(companyName);
    if (!fs.existsSync(zhPath)) return { ok: false, error: 'not_found' };
    try {
      return { ok: true, text: fs.readFileSync(zhPath, 'utf-8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('backcheck:cancel', async (_e, companyName) => {
    const status = readBackcheckStatus();
    delete status[companyName];
    writeBackcheckStatus(status);
    return { ok: true };
  });

  // ── 联系人（持久化存储 + 内存缓存 + 写锁）──────────────────────────
  const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');
  let contactsCache = null;  // 缓存解析结果，避免重复读 715KB 文件
  let contactsWriteLock = false; // 防并发写入

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
    contactsCache = contacts;  // 先更新缓存
    contactsWriteLock = true;
    try {
      const dir = path.dirname(contactsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2));
    } finally {
      contactsWriteLock = false;
    }
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

  // 邮箱格式校验正则
  const EMAIL_RE = /^[^\s@,"<>\[\]\\]+@[^\s@,"<>\[\]\\]+\.[^\s@,"<>\[\]\\]{2,}$/;

  // ── 伪公司名检测 ──────────────────────────────────────────────────
  const PLACEHOLDER_NAMES = /^(公司提供|未命名|未知|N\/A|暂无|-|\.+|\s*)$/i;
  function markSuspicious(company) {
    const raw = (company || '').trim();
    if (!raw || PLACEHOLDER_NAMES.test(raw)) {
      return { company: (raw || '未命名') + ' ⚠️ 待确认', _suspicious: true };
    }
    return { company: raw, _suspicious: false };
  }

  ipcMain.handle('contacts:import', async (_e, clients) => {
    // 强制刷新缓存，防止并发写入导致数据丢失
    contactsCache = null;
    const existing = readContacts();
    // 按邮箱去重（同公司多人应分别保存）
    const existingKeys = new Set(existing.map(c => `${c.company.toLowerCase()}||${(c.email || '').toLowerCase()}`));
    let added = 0, skipped = 0, invalidEmail = 0;
    for (const c of clients) {
      if (!c.company && !c.email) { skipped++; continue; }
      const key = `${(c.company || '').toLowerCase()}||${(c.email || '').toLowerCase()}`;
      if (existingKeys.has(key)) { skipped++; continue; }
      // 清洗并校验邮箱
      const cleanEmail = (c.email || '').trim();
      if (cleanEmail && !EMAIL_RE.test(cleanEmail)) {
        invalidEmail++;
        // 仍然导入（用户可手动修正），但标记出来
      }
      const { company, _suspicious } = markSuspicious(c.company);
      existing.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        company,
        country: c.country || '',
        category: c.category || '',
        email: cleanEmail,
        website: c.website || '',
        linkedin: c.linkedin || '',
        contactName: c.contactName || '',
        position: c.position || '',
        phone: c.phone || '',
        clientType: c.clientType || classifyClient(c.company, c.category),
        _suspicious,
        addedAt: new Date().toISOString(),
      });
      existingKeys.add(key);
      added++;
    }
    writeContacts(existing);
    return { total: existing.length, added, skipped, invalidEmail };
  });

  ipcMain.handle('contacts:delete', async (_e, id) => {
    contactsCache = null;
    let contacts = readContacts();
    contacts = contacts.filter(c => c.id !== id);
    writeContacts(contacts);
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteAll', async () => {
    writeContacts([]);
    return { ok: true };
  });

  ipcMain.handle('contacts:deleteCompany', async (_e, company) => {
    contactsCache = null;
    let contacts = readContacts();
    const before = contacts.length;
    contacts = contacts.filter(c => c.company !== company);
    writeContacts(contacts);
    return { ok: true, deleted: before - contacts.length };
  });

  // ── 退信标记写回联系人 ──────────────────────────────────────────
  ipcMain.handle('contacts:updateBounce', async (_e, email, bounceData) => {
    const contacts = readContacts();
    const key = (email || '').toLowerCase().trim();
    let updated = 0;
    for (const c of contacts) {
      if ((c.email || '').toLowerCase().trim() === key) {
        c.bounced = true;
        c.bounceType = bounceData.type || 'unknown';
        c.bounceReason = bounceData.reason || '';
        c.bouncedAt = c.bouncedAt || new Date().toISOString();
        updated++;
      }
    }
    if (updated) writeContacts(contacts);
    return { ok: true, updated };
  });

  // ── 清除联系人退信标记 ──────────────────────────────────────────
  ipcMain.handle('contacts:clearBounce', async (_e, email) => {
    const contacts = readContacts();
    const key = (email || '').toLowerCase().trim();
    for (const c of contacts) {
      if ((c.email || '').toLowerCase().trim() === key) {
        c.bounced = false;
        c.bounceType = '';
        c.bounceReason = '';
        c.bouncedAt = '';
      }
    }
    writeContacts(contacts);
    return { ok: true };
  });

  ipcMain.handle('contacts:search', async (_e, query) => {
    const contacts = readContacts();
    const q = query.toLowerCase();
    return contacts.filter(c =>
      c.company.toLowerCase().includes(q) ||
      (c.country || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    );
  });

  // ── 决策人深挖（并行：官网抓取 + LinkedIn 搜索）───────────────
  ipcMain.handle('contacts:deepSearch', async (_e, website, companyName) => {
    if (!website || !website.startsWith('http')) {
      return { ok: false, error: 'no_website', message: '该公司未填写官网' };
    }

    const linkedinClient = require('./linkedin-client');
    const searchName = companyName || '';

    // 3 路并行：官网抓取 + 2 路 LinkedIn 搜索（任一路失败不影响其他）
    const [scrapeResult, linkedin1, linkedin2] = await Promise.all([
      callScraplingAPI(`/scrape/contacts?url=${encodeURIComponent(website)}&company=${encodeURIComponent(searchName)}`),
      linkedinClient.searchPeople(`${searchName} supply chain OR logistics OR procurement OR buyer`).catch(() => []),
      linkedinClient.searchPeople(`${searchName} compras OR importación OR importação OR comprador`).catch(() => []),
    ]);

    // 合并 + 去重
    const websitePeople = (scrapeResult?.people || []).map(p => ({ ...p, source: 'website' }));
    const seenNames = new Set(websitePeople.map(p => p.name.toLowerCase()));
    const linkedinPeople = [...linkedin1, ...linkedin2].filter(p => {
      const key = p.name.toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    const allPeople = [...websitePeople, ...linkedinPeople];

    // 角色分类
    const LOGISTICS_KW = ['supply chain','logistics','procurement','compras','buyer',
      'import','export','customs','shipping','freight','logística','adquisiciones',
      'importación','exportación','comprador','suprimentos','supply','purchasing','sourcing'];
    const EXECUTIVE_KW = ['ceo','president','director','general manager','vp ',
      'managing director','country manager','plant manager','director general',
      'gerente geral','presidente'];

    for (const p of allPeople) {
      const low = (p.title || '').toLowerCase();
      p.department = LOGISTICS_KW.some(kw => low.includes(kw)) ? 'logistics'
        : EXECUTIVE_KW.some(kw => low.includes(kw)) ? 'management' : 'other';
    }

    return {
      ok: true,
      company_info: scrapeResult?.company_info || {},
      people: allPeople,
      stats: {
        total: allPeople.length,
        logistics: allPeople.filter(p => p.department === 'logistics').length,
        management: allPeople.filter(p => p.department === 'management').length,
        from_website: websitePeople.length,
        from_linkedin: linkedinPeople.length,
      },
    };
  });

  // ── 模板引擎 ───────────────────────────────────────────────────────
  ipcMain.handle('template:getLibrary', async () => {
    if (!templateLib) {
      templateLib = parseTemplateLibrary();
      const overrides = readOverrides();
      if (templateLib && overrides) applyOverrides(templateLib, overrides);
    }
    return templateLib;
  });

  ipcMain.handle('template:getSubjects', async (_e, type) => {
    if (!templateLib) templateLib = parseTemplateLibrary();
    return templateLib?.subjects?.[type] || { es: '', en: '' };
  });

  // ── 模板覆盖层持久化 ──────────────────────────────────────────────
  const overridesPath = path.join(__dirname, '..', 'data', 'template-overrides.json');

  function readOverrides() {
    try { return fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf-8')) : null; }
    catch { return null; }
  }

  function writeOverrides(data) {
    const dir = path.dirname(overridesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(overridesPath, JSON.stringify(data, null, 2));
  }

  ipcMain.handle('template:saveOverrides', async (_e, overrides) => {
    writeOverrides(overrides);
    // 实时合并到内存中的 templateLib
    if (templateLib) applyOverrides(templateLib, overrides);
    return { ok: true };
  });

  ipcMain.handle('template:getOverrides', async () => {
    return readOverrides();
  });

  // ── 模板重新加载（清除缓存 → 重解析 → 合并覆盖层）────────────────
  ipcMain.handle('template:reload', async () => {
    templateLib = parseTemplateLibrary();
    const overrides = readOverrides();
    if (templateLib && overrides) applyOverrides(templateLib, overrides);
    return { ok: true, totalHooks: templateLib?.hooks?.length || 0 };
  });

  // ── 应用 _stages 覆盖层（渲染进程在 initTemplateEditor 后调用）────
  ipcMain.handle('template:applyStageOverrides', async (_e, stages, overridesStages) => {
    return applyStageOverrides(stages, overridesStages);
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
      lastDate = log.last_date_beijing || log.last_date || '';
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
    const now = new Date().toISOString();
    const STAGES = ['cold', 'f1', 'f2', 'f3', 'f4', 'archived'];
    for (const name of companies) {
      const cur = h[name]?.stage || 'cold';
      const idx = STAGES.indexOf(cur);
      const nextIdx = idx >= 0 && idx < STAGES.length - 1 ? idx + 1 : idx;
      const next = STAGES[nextIdx];
      const update = { ...h[name], stage: next, lastSent: now, sentCount: (h[name]?.sentCount || 0) + 1, sentContacts: [] };
      // 首次进入冷开发 → 记录开发起始日期
      if (!h[name]?.startedAt) update.startedAt = now;
      // 归档 → 记录归档日期
      if (next === 'archived') update.archivedAt = now;
      h[name] = update;
    }
    writeSendHistory(h);
    return h;
  });

  // ── 记录已用句子（序列去重）────────────────────────────────────────
  ipcMain.handle('history:recordSentences', async (_e, company, sentenceIds) => {
    const h = readSendHistory();
    const entry = h[company] || {};
    const used = entry.usedSentences || [];
    // 追加本次使用的句子 ID，去重
    const merged = [...new Set([...used, ...(sentenceIds || [])])];
    // 超过 5 次发送（一个完整序列）后重置，开始新一轮
    h[company] = { ...entry, usedSentences: (entry.sentCount || 0) >= 5 ? [...(sentenceIds || [])] : merged };
    writeSendHistory(h);
    return { ok: true };
  });

  // ── 重新激活（archived → cold，清空序列记录）─────────────────────
  ipcMain.handle('history:reactivate', async (_e, company) => {
    const h = readSendHistory();
    const now = new Date().toISOString();
    h[company] = { ...h[company], stage: 'cold', usedSentences: [], lastSent: now,
      archivedAt: undefined,  // 重新激活时清除归档日期
      // startedAt 保留（首次开发日期不变）
    };
    writeSendHistory(h);
    return { ok: true };
  });

  // ── 协议检测 ────────────────────────────────────────────────────
  function isPop3(cfg) {
    const h = (cfg.host || '').toLowerCase();
    return cfg.port === 995 || h.includes('pop');
  }

  // ── POP3 连接 ─────────────────────────────────────────────────────
  const tls = require('tls');

  function pop3Connect(host, port) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(sock));
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); reject(new Error('连接超时')); }, 20000);
    });
  }

  // 读单行（兼容 \r\n 和裸 \n）
  function pop3ReadLine(sock, timeoutMs) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读行超时')); }, timeoutMs || 15000);
      const onData = (d) => {
        buf += d.toString();
        const rn = buf.indexOf('\r\n');
        const n = buf.indexOf('\n');
        const end = rn >= 0 ? rn : n;
        if (end >= 0) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(buf.slice(0, end).trim());
        }
      };
      sock.on('data', onData);
    });
  }

  // 读多行（直到行内只有一个 . ）
  function pop3ReadMulti(sock, timeoutMs) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => { sock.removeAllListeners('data'); reject(new Error('读多行超时')); }, timeoutMs || 15000);
      const onData = (d) => {
        buf += d.toString();
        if (/\r?\n\.\r?\n/.test(buf)) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(buf.replace(/\r?\n\.\r?\n.*/, '').split(/\r?\n/).filter(Boolean));
        }
      };
      sock.on('data', onData);
    });
  }

  function pop3Cmd(sock, cmd) {
    sock.write(cmd + '\r\n');
    if (cmd === 'QUIT') return Promise.resolve([]);
    // 多行响应（以 . 结尾）
    if (/^(LIST|TOP|UIDL|RETR)/i.test(cmd)) return pop3ReadMulti(sock);
    // STAT 和认证命令都是单行
    return pop3ReadLine(sock).then(line => [line]);
  }

  // ── 退信检测 + 记录持久化 ──────────────────────────────────────
  const bounceLogPath = path.join(__dirname, '..', 'data', 'bounce-log.json');

  ipcMain.handle('imap:test', async (_e, cfg) => testConnection(cfg));

  ipcMain.handle('bounce:check', async () => {
    try {
      return await Promise.race([
        checkBounces(),
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: '检测超时（60秒），请检查网络后重试' }), 60000))
      ]);
    } catch (e) {
      return { ok: false, error: '检测异常: ' + (e.message || String(e)) };
    }
  });

  ipcMain.handle('bounce:loadLog', async () => {
    try {
      if (fs.existsSync(bounceLogPath)) {
        return { ok: true, data: JSON.parse(fs.readFileSync(bounceLogPath, 'utf-8')) };
      }
    } catch {}
    return { ok: true, data: [] };
  });

  ipcMain.handle('bounce:saveLog', async (_e, data) => {
    try {
      const dir = path.dirname(bounceLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(bounceLogPath, JSON.stringify(data, null, 2));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 发送总览 ──────────────────────────────────────────────────
  ipcMain.handle('history:getLog', async (_e, params) => {
    const { limit, offset, search, type, lang, country, stage } = params || {};
    const logPath = path.join(__dirname, '..', 'send', 'send-log.json');
    try {
      if (!fs.existsSync(logPath)) return { total: 0, records: [] };
      let records = JSON.parse(fs.readFileSync(logPath, 'utf-8')).sent || [];
      records.reverse();
      if (search) {
        const q = search.toLowerCase();
        records = records.filter(r =>
          (r.company||'').toLowerCase().includes(q) ||
          (r.subject||'').toLowerCase().includes(q) ||
          (r.to||'').toLowerCase().includes(q) ||
          (r._stage||'').toLowerCase().includes(q) ||
          (r._type||'').toLowerCase().includes(q) ||
          (r._lang||'').toLowerCase().includes(q) ||
          (r._country||'').toLowerCase().includes(q)
        );
      }
      if (type) records = records.filter(r => (r._type || 'unlabeled') === type);
      if (lang) records = records.filter(r => (r._lang || '') === lang);
      if (country) records = records.filter(r => (r._country || '') === country);
      if (stage) records = records.filter(r => r._stage === stage);
      const total = records.length;
      const o = offset || 0;
      const l = limit || 50;
      records = records.slice(o, o + l);
      records = records.map(r => { const { body, ...rest } = r; return rest; });
      return { total, records };
    } catch (e) {
      console.error('发送日志读取失败:', e.message);
      return { total: 0, records: [] };
    }
  });

  ipcMain.handle('history:getBody', async (_e, bodyId) => {
    if (!bodyId) return '';
    const bodies = loadBodies();
    return bodies[bodyId] || '';
  });

  ipcMain.handle('history:delete', async (_e, indices) => {
    if (!indices || !indices.length) return { ok: false, error: '无选中项' };
    const logPath = path.join(__dirname, '..', 'send', 'send-log.json');
    const testPath = path.join(__dirname, '..', 'send', 'send-log-test.json');
    for (const lp of [logPath, testPath]) {
      if (!fs.existsSync(lp)) continue;
      try {
        const log = JSON.parse(fs.readFileSync(lp, 'utf-8'));
        const before = log.sent.length;
        const idxSet = new Set(indices.map(String));
        log.sent = log.sent.filter(r => !idxSet.has(String(r.index)));
        fs.writeFileSync(lp, JSON.stringify(log, null, 2));
        console.log(`history:delete ${lp} — ${before} → ${log.sent.length}`);
      } catch (e) { console.error('history:delete error:', e.message); }
    }
    return { ok: true, deleted: indices.length };
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
    return loadSearchConfig();
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

  // ── 网络检查 ───────────────────────────────────────────────────────
  ipcMain.handle('network:check', async () => {
    const proxy = getProxyConfig();
    const targets = [
      { name: '百度 (国内)', host: 'www.baidu.com' },
      { name: 'Bing (国内)', host: 'cn.bing.com' },
      { name: 'Google', host: 'www.google.com' },
      { name: 'Wikipedia', host: 'en.wikipedia.org' },

      { name: 'Bing 国际', host: 'www.bing.com' },
    ];
    const results = [];
    for (const t of targets) {
      const start = Date.now();
      try {
        await new Promise((resolve, reject) => {
          const req = createRequest({ hostname: t.host, path: '/', method: 'HEAD', timeout: 8000, headers: { 'User-Agent': 'Prospector/1.0' } });
          req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });
        results.push({ name: t.name, ok: true, ms: Date.now() - start });
      } catch (e) {
        results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e.message });
      }
    }
    return { proxy: proxy ? `${proxy.hostname}:${proxy.port}` : null, results };
  });

  // ── 客户开发搜索（代理到 scrapling service）──────────────────────────
  ipcMain.handle('discover:search', async (_e, params) => {
    const qs = new URLSearchParams(params).toString();
    return callScraplingAPI(`/search/discover?${qs}`);
  });

  ipcMain.handle('discover:lookup', async (_e, params) => {
    const qs = new URLSearchParams(params).toString();
    return callScraplingAPI(`/scrape/email-pattern?${qs}`);
  });

  // ── 队列文件持久化 ────────────────────────────────────────────────
  const queueFilePath = path.join(__dirname, '..', 'data', 'email-queue.json');

  ipcMain.handle('queue:save', async (_e, data) => {
    try {
      const dir = path.dirname(queueFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(queueFilePath, JSON.stringify(data, null, 2));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('queue:load', async () => {
    try {
      if (fs.existsSync(queueFilePath)) {
        return { ok: true, data: JSON.parse(fs.readFileSync(queueFilePath, 'utf-8')) };
      }
    } catch {}
    return { ok: false, data: [] };
  });

  // ── 发信状态持久化 ────────────────────────────────────────────────
  const sendStatePath = path.join(__dirname, '..', 'data', 'send-state.json');
  ipcMain.handle('send:saveState', async (_e, data) => {
    let cur = {};
    try { if (fs.existsSync(sendStatePath)) cur = JSON.parse(fs.readFileSync(sendStatePath, 'utf-8')); } catch {}
    try { fs.writeFileSync(sendStatePath, JSON.stringify({ ...cur, ...data }, null, 2)); return { ok: true }; } catch(e) { return { ok: false }; }
  });
  ipcMain.handle('send:loadState', async () => {
    try { return { ok: true, data: fs.existsSync(sendStatePath) ? JSON.parse(fs.readFileSync(sendStatePath, 'utf-8')) : {} }; } catch { return { ok: true, data: {} }; }
  });

  // ── 系统 ───────────────────────────────────────────────────────────
  ipcMain.handle('app:minimizeToTray', async () => {
    mainWindow?.hide();
  });
}

// ===== 正文存储（独立于日志，按需加载）===============================
const bodiesPath = path.join(__dirname, '..', 'data', 'send-bodies.json');

function loadBodies() {
  try {
    if (fs.existsSync(bodiesPath)) return JSON.parse(fs.readFileSync(bodiesPath, 'utf-8'));
  } catch {}
  return {};
}

function saveBody(text) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const bodies = loadBodies();
  bodies[id] = (text || '').slice(0, 2000);
  const keys = Object.keys(bodies);
  if (keys.length > 5000) {
    keys.sort((a, b) => parseInt(a, 36) - parseInt(b, 36));
    keys.slice(0, keys.length - 5000).forEach(k => delete bodies[k]);
  }
  const dir = path.dirname(bodiesPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bodiesPath, JSON.stringify(bodies, null, 2));
  return id;
}

// ===== 发送引擎核心 ====================================================

async function runSendBatch() {
  const nodemailer = require('nodemailer');
  const configPath = path.join(__dirname, '..', 'send', 'config.json');
  const sigPath = path.join(__dirname, '..', 'send', 'signature.html');

  if (!fs.existsSync(configPath)) {
    sendProgress({ error: 'config.json 未找到' });
    return;
  }

  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
  catch (e) { sendProgress({ error: 'config.json 解析失败: ' + e.message }); return; }

  // 安全：SMTP 密码优先从环境变量读取
  if (process.env.SMTP_PASS) {
    config.smtp.pass = process.env.SMTP_PASS;
  }

  // 测试模式：独立日志文件，不污染生产数据
  const testMode = !!(config.test?.enabled && config.test?.email);
  const logPath = path.join(__dirname, '..', 'send', testMode ? 'send-log-test.json' : 'send-log.json');

  const signatureHtml = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf-8') : '';
  const signatureText = config.signature?.text || '金颖哲 Zayne Jin | Overseas Sales · LatAm Desk\nYQN Logistics Technology Group\nzayne_jin@yqn.com | +86 18487665870 | www.yqn.com';
  const maxPerDay = config.schedule?.max_per_day ?? 500;
  const minDelay = (config.schedule?.min_delay_seconds ?? 30) * 1000;
  const maxDelay = (config.schedule?.max_delay_seconds ?? 90) * 1000;
  const companyDelayMin = (config.schedule?.company_delay_min_seconds ?? 300) * 1000;
  const companyDelayMax = (config.schedule?.company_delay_max_seconds ?? 900) * 1000;
  const startHour = config.schedule?.start_hour_beijing ?? 19;
  const endHour = config.schedule?.end_hour_beijing ?? 3;

  // 今日计数（测试模式不读生产日志）
  let log = { sent: [], daily_count: 0, last_date: '' };
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch { /* 损坏则用空日志 */ }
  }
  const todayBJT = beijingToday();
  // 用北京时间做日切（与发送窗口 inWindow() 保持一致）
  const lastDateKey = log.last_date_beijing || log.last_date;
  if (lastDateKey !== todayBJT) { log.daily_count = 0; log.last_date_beijing = todayBJT; }

  // 读取发送状态（含上次暂停的批次等待剩余秒数）
  let sendState = {};
  try { const sp = path.join(__dirname, '..', 'data', 'send-state.json'); if (fs.existsSync(sp)) sendState = JSON.parse(fs.readFileSync(sp, 'utf-8')); } catch {}
  currentSendAbort = false;
  if (!config.smtp?.host || !config.smtp?.user) {
    sendProgress({ error: 'SMTP 未配置，请在设置中填写' });
    return;
  }
  try {
    currentTransporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port || 465,
    secure: config.smtp.secure !== false,
    auth: { user: config.smtp.user, pass: config.smtp.pass || '' },
    tls: { rejectUnauthorized: false },
  });
  } catch (e) {
    sendProgress({ error: 'SMTP 连接创建失败: ' + e.message });
    return;
  }

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
    // 去重：如果正文末尾已含签名档，不再重复追加
    const sigStart = (signatureText || '').split('\n')[0]?.trim();
    const bodyEnd = bodyText.trimEnd();
    const hasSig = sigStart && bodyEnd.includes(sigStart);
    const textBody = hasSig ? bodyText : (bodyText + '\n--\n' + signatureText);

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
    const html = hasSig ? (htmlBody + '\n<br>\n' + bodyEnd.slice(bodyEnd.indexOf(sigStart))) : (htmlBody + '\n<br>\n' + signatureHtml);
    return { text: textBody, html };
  }

  // 保持原始队列顺序（同公司连续，不加交织）
  // 本轮计数器（不计历史日志）
  let batchSent = 0, batchFailed = 0, batchCount = 0;

  // 预计发送时长（含封间延迟 + 公司切换延迟）
  const pendingItems = sendQueue.filter(e => e.status === 'pending' || e.status === 'sending');
  const totalRecipients = pendingItems.reduce((sum, e) =>
    sum + (e.recipients?.length || (typeof e.to === 'string' ? e.to.split(',').filter(Boolean).length : 1)), 0);
  let avgDelaySec = Math.round(((minDelay + maxDelay) / 2) / 1000);
  const avgCompanyDelaySec = Math.round(((companyDelayMin + companyDelayMax) / 2) / 1000);
  // 统计公司切换次数（同公司连续项只算一次切换）
  let companySwitches = 0, prevCompany = '';
  for (const item of pendingItems) {
    const c = item.company || '';
    if (c && prevCompany && c !== prevCompany) companySwitches++;
    if (c) prevCompany = c;
  }
  // 公司切换延迟按收件人数缩放：单收件人短延迟，多收件人全额
  const SINGLE_RECIP_THRESHOLD = config.schedule?.single_recip_threshold ?? 2;
  const SINGLE_DELAY_MIN = (config.schedule?.single_recip_delay_min ?? 60) * 1000;
  const SINGLE_DELAY_MAX = (config.schedule?.single_recip_delay_max ?? 180) * 1000;
  const avgSingleDelay = Math.round((SINGLE_DELAY_MIN + SINGLE_DELAY_MAX) / 2000);
  let estCompanyDelaySec = 0;
  let singleSwitches = 0, fullSwitches = 0;
  prevCompany = '';
  let prevRecipCount = 1;
  for (const item of pendingItems) {
    const c = item.company || '';
    if (c && prevCompany && c !== prevCompany) {
      if (prevRecipCount <= SINGLE_RECIP_THRESHOLD) {
        estCompanyDelaySec += avgSingleDelay;
        singleSwitches++;
      } else {
        estCompanyDelaySec += avgCompanyDelaySec;
        fullSwitches++;
      }
    }
    prevRecipCount = item.recipients?.length || (typeof item.to === 'string' ? item.to.split(',').filter(Boolean).length : 1);
    if (c) prevCompany = c;
  }
  console.log(`[发信] 开始 — 待发 ${totalRecipients} 封(BCC)，${pendingItems.length} 个队列项，${companySwitches} 次公司切换 (单人=${singleSwitches}, 多人=${fullSwitches})，封间 ${minDelay/1000}~${maxDelay/1000}s，公司间 ${companyDelayMin/1000}~${companyDelayMax/1000}s，单人公司快速 ${SINGLE_DELAY_MIN/1000}~${SINGLE_DELAY_MAX/1000}s`);
  const sendMode = config.schedule?.mode || 'multi';
  let totalEstSeconds, estMin, estSec;
  if (sendMode === 'batch') {
    // 批量预估：总邮件数 / 每批封数 = 批数 × 平均暂停
    const bsz = config.schedule?.batch_size || 10;
    const pauseMin = config.schedule?.batch_pause_min || 150;
    const pauseMax = config.schedule?.batch_pause_max || 210;
    const avgPause = (pauseMin + pauseMax) / 2;
    const batches = Math.ceil(totalRecipients / bsz);
    totalEstSeconds = Math.round((batches - 1) * avgPause);
    avgDelaySec = avgPause;
    estMin = Math.floor(totalEstSeconds / 60);
    estSec = Math.round(totalEstSeconds % 60);
    console.log(`[发信] 批量模式 — 共 ${totalRecipients} 封，每批 ${bsz} 封 ≈ ${batches} 批，批间 ${pauseMin}~${pauseMax}s ≈ ${estMin}分${estSec}秒`);
  } else {
    totalEstSeconds = Math.max(0, ((pendingItems.length - 1) * avgDelaySec) + estCompanyDelaySec);
    estMin = Math.floor(totalEstSeconds / 60);
    estSec = Math.round(totalEstSeconds % 60);
  }
  const sessionStart = new Date().toISOString();
  const sessionLog = {
    startedAt: sessionStart, testMode,
    config: { maxPerDay, minDelaySec: minDelay/1000, maxDelaySec: maxDelay/1000, companyDelayMinSec: companyDelayMin/1000, companyDelayMaxSec: companyDelayMax/1000, groupSize: config.schedule?.group_size || 20, startHour, endHour },
    queue: { pendingItems: pendingItems.length, totalRecipients },
    estimate: { estMin, estSec },
  };
  sendProgress({ type: 'estimate', total: totalRecipients, avgDelay: avgDelaySec, estMin, estSec, companyDelayMin: companyDelayMin/1000, companyDelayMax: companyDelayMax/1000 });

  // 发送模式分支（sendMode 已在预估部分声明）
  if (sendMode === 'batch') {
    // ── 均匀配置：每批 N 封 → 暂停 → 下一批 ──────────────────────
    const BATCH_SIZE = config.schedule?.batch_size || 10;
    const BATCH_PAUSE_MIN = (config.schedule?.batch_pause_min || 150) * 1000;
    const BATCH_PAUSE_MAX = (config.schedule?.batch_pause_max || 210) * 1000;

    // 恢复上次暂停时未跑完的批次等待
    if (sendState?.batchPauseRemaining > 0) {
      const remain = sendState.batchPauseRemaining;
      console.log(`[发信] 恢复批次暂停: 剩余 ${remain}s`);
      sendProgress({ type: 'delay', seconds: remain, company: '恢复等待' });
      for (let s = 0; s < remain && !isPaused && !currentSendAbort; s++) await sleep(1000);
      if (isPaused || currentSendAbort) { await currentTransporter.close(); return; }
    }

    let batchEmailCount = 0;
    for (let i = 0; i < sendQueue.length; i++) {
      if (currentSendAbort) {
        sendProgress({ type: 'cancelled', index: i, total: sendQueue.length, message: '发送已取消' });
        break;
      }
      if (isPaused) {
        sendProgress({ type: 'paused', index: i, total: sendQueue.length });
        break;
      }
      if (!testMode && log.daily_count >= maxPerDay) {
        sendProgress({ type: 'limit', index: i, total: sendQueue.length, message: `已达每日上限 ${maxPerDay}` });
        break;
      }

      // 等待时间窗口
      while (!inWindow() && !isPaused && !testMode && !currentSendAbort) {
        for (let w = 0; w < 6 && !isPaused && !currentSendAbort && !inWindow(); w++) await sleep(5000);
      }
      if (isPaused || currentSendAbort) break;

      const email = sendQueue[i];
      if (email.status !== 'pending' && email.status !== 'sending') continue;
      const toList = (email.recipients?.length)
        ? email.recipients
        : (typeof email.to === 'string' ? email.to.split(',').map(s => s.trim()).filter(Boolean) : []);
      if (!toList.length) continue;

      const { text, html } = buildContent(email.body || '');
      const senderAddr = config.sender?.email || 'zayne_jin@yqn.com';
      const actualSubject = testMode ? `[测试] ${email.subject}` : email.subject;
      const actualTo = testMode ? (config.test?.email || senderAddr) : toList[0];
      const actualBcc = testMode ? [config.test?.email || senderAddr] : toList.slice(1);

      try {
        const info = await currentTransporter.sendMail({
          from: `"${config.sender?.name || 'Zayne Jin'}" <${senderAddr}>`,
          to: actualTo,
          ...(actualBcc.length ? { bcc: actualBcc.join(', ') } : {}),
          subject: actualSubject, text, html,
        });
        for (const r of toList) {
          log.sent.push({ index: log.daily_count + 1, to: r, company: email.company || '', subject: actualSubject, messageId: info.messageId, count: 1, bodyId: saveBody(email.body || ''), _stage: email._stage || '', _lang: email._lang || '', _type: email._type || 'unlabeled', _country: email._country || '', time: new Date().toISOString(), time_beijing: beijingToday(), status: 'sent' });
          batchSent++; batchCount++;
          if (!testMode) log.daily_count++;
        }
        // 记录已发联系人
        if (!testMode && email.company) {
          const sendHistoryPath = path.join(__dirname, '..', 'data', 'send-history.json');
          let sh = {};
          try { if (fs.existsSync(sendHistoryPath)) sh = JSON.parse(fs.readFileSync(sendHistoryPath, 'utf-8')); } catch {}
          const entry = sh[email.company] || {};
          const sentSet = new Set(entry.sentContacts || []);
          toList.forEach(r => sentSet.add(r.toLowerCase().trim()));
          // 确保 stage 至少为 cold，防止中断后出现无 stage 但有 sentContacts 的僵尸状态
          sh[email.company] = { ...entry, sentContacts: [...sentSet], stage: entry.stage || 'cold' };
          try { fs.writeFileSync(sendHistoryPath, JSON.stringify(sh, null, 2)); } catch {}
        }
        fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
        sendProgress({ type: 'sent', id: email.id, index: i + 1, total: sendQueue.length, company: email.company, to: toList.join(', '), count: toList.length, _testMode: testMode || undefined });
      } catch (err) {
        const errMsg = err.message || '';
        const rateKeywords = ['rate limit','too many','try again','temporarily','daily limit','quota exceeded','too frequently','421','450','451','452','454','554','suspension','blocked','throttled','behaviour','recently sending','transient reject'];
        if (rateKeywords.some(kw => errMsg.toLowerCase().includes(kw)) && !testMode) {
          isPaused = true;
          sendProgress({ type: 'ratelimit', index: i + 1, total: sendQueue.length, company: email.company, to: toList.join(', '), error: errMsg });
          if (tray) new Notification({ title: "⚠️ 发送已被限流", body: `${email.company}: ${errMsg}\n发送已自动暂停，请等待后手动恢复。` }).show();
          fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
          break;
        }
        for (const r of toList) {
          log.sent.push({ index: log.sent.length + 1, to: r, company: email.company || '', subject: actualSubject, time: new Date().toISOString(), time_beijing: beijingToday(), count: 1, bodyId: saveBody(email.body || ''), _stage: email._stage || '', _lang: email._lang || '', _type: email._type || 'unlabeled', _country: email._country || '', status: 'failed', error: errMsg });
          batchFailed++; batchCount++;
        }
        fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
        sendProgress({ type: 'failed', id: email.id, index: i + 1, total: sendQueue.length, company: email.company, to: toList.join(', '), error: errMsg, _testMode: testMode || undefined });
        // 退信特征标记
        const bounceKeywords = ['550','551','552','553','554','not found','user unknown','address rejected','mailbox','recipient rejected','不存在','拒收'];
        if (!testMode && bounceKeywords.some(kw => errMsg.toLowerCase().includes(kw))) {
          try {
            const { classifyBounce } = require('./bounce-checker');
            const { type, reason } = classifyBounce('', errMsg);
            const contacts = readContacts();
            for (const r of toList) {
              const key = (r || '').toLowerCase().trim();
              for (const c of contacts) {
                if ((c.email || '').toLowerCase().trim() === key) { c.bounced = true; c.bounceType = type; c.bounceReason = reason; c.bouncedAt = new Date().toISOString(); }
              }
            }
            writeContacts(contacts);
          } catch {}
        }
      }

      batchEmailCount += toList.length;
      // 每批发完（按实际邮件数），暂停
      if (batchEmailCount >= BATCH_SIZE && i < sendQueue.length - 1 && !testMode && !isPaused && log.daily_count < maxPerDay) {
        const pauseMs = Math.floor(Math.random() * (BATCH_PAUSE_MAX - BATCH_PAUSE_MIN + 1)) + BATCH_PAUSE_MIN;
        const pauseSec = Math.round(pauseMs / 1000);
        console.log(`[发信] 批量暂停: 已发 ${batchEmailCount} 封，等待 ${pauseSec}s (${Math.round(pauseSec/60)}min)`);
        sendProgress({ type: 'delay', seconds: pauseSec, company: `下批(${batchEmailCount}封后)` });
        // 分批睡眠，每秒检查是否暂停/取消
        let s = 0;
        for (; s < pauseSec && !isPaused && !currentSendAbort; s++) await sleep(1000);
        if (isPaused || currentSendAbort) {
          // 保存剩余等待秒数
          try {
            const sp = path.join(__dirname, '..', 'data', 'send-state.json');
            let st = {}; if (fs.existsSync(sp)) st = JSON.parse(fs.readFileSync(sp, 'utf-8'));
            st.batchPauseRemaining = pauseSec - s;
            fs.writeFileSync(sp, JSON.stringify(st, null, 2));
          } catch {}
          break;
        }
        batchEmailCount = 0;
      }
    }
    await currentTransporter.close();
    if (tray && !isPaused && !currentSendAbort && !testMode) {
      new Notification({ title: "Milogin's Prospector", body: `发送完成: 成功 ${batchSent} 封` + (batchFailed ? `, 失败 ${batchFailed} 封` : '') }).show();
    }
    if (!isPaused && !currentSendAbort) {
      // 发送完成，重置状态
      try { const sp = path.join(__dirname, '..', 'data', 'send-state.json'); fs.writeFileSync(sp, JSON.stringify({ status: 'idle' }, null, 2)); } catch {}
      sendProgress({ type: 'complete', total: sendQueue.length, sent: batchSent, failed: batchFailed, _testMode: testMode || undefined });
    }
    return;
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

    if (!testMode && log.daily_count >= maxPerDay) {
      sendProgress({ type: 'limit', index: i, total: sendQueue.length, message: `已达每日上限 ${maxPerDay}` });
      break;
    }

    // 等待时间窗口（测试模式跳过，每5秒检查暂停/取消）
    while (!inWindow() && !isPaused && !testMode && !currentSendAbort) {
      sendProgress({ type: 'waiting', message: '等待发送窗口 (北京时间 19:00-03:00)...' });
      for (let w = 0; w < 6 && !isPaused && !currentSendAbort && !inWindow(); w++) {
        await sleep(5000);
      }
    }
    if (isPaused || currentSendAbort) break;

    const email = sendQueue[i];
    const toList = (email.recipients && email.recipients.length)
      ? email.recipients
      : (typeof email.to === 'string' ? email.to.split(',').map(s => s.trim()).filter(Boolean) : []);
    if (!toList.length) {
      sendProgress({ type: 'failed', id: email.id, index: i + 1, total: sendQueue.length, company: email.company || '', to: '', error: '收件人列表为空，跳过' });
      log.sent.push({ index: log.sent.length + 1, to: '', company: email.company || '', subject: email.subject || '', time: new Date().toISOString(), time_beijing: beijingToday(), count: 0, bodyId: saveBody(email.body || ''), _stage: email._stage || '', _lang: email._lang || '', _type: email._type || 'unlabeled', _country: email._country || '', status: 'failed', error: '收件人列表为空' });
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      continue;
    }
    const { text, html } = buildContent(email.body || '');
    const senderAddr = config.sender?.email || 'zayne_jin@yqn.com';

    // 封间延迟（非首封且非测试模式）
    if (!testMode && (i > 0 || log.daily_count > 0)) {
      const microDelay = randomDelay();
      await sleep(microDelay);
    }

    // BCC 群发：TO 填第一个收件人，其余 BCC
    const actualSubject = testMode ? `[测试] ${email.subject}` : email.subject;
    const firstTo = toList[0];
    const restBcc = toList.length > 1 ? toList.slice(1) : [];
    const actualTo = testMode ? (config.test?.email || senderAddr) : firstTo;
    const actualBcc = testMode ? [config.test?.email || senderAddr] : restBcc;

    try {
      const info = await currentTransporter.sendMail({
        from: `"${config.sender?.name || 'Zayne Jin'}" <${senderAddr}>`,
        to: actualTo,
        ...(actualBcc.length ? { bcc: actualBcc.join(', ') } : {}),
        subject: actualSubject,
        text,
        html,
      });

      // 逐人记录日志
      for (const r of toList) {
        log.sent.push({
          index: log.daily_count + 1, to: r, company: email.company || '',
          subject: actualSubject, messageId: info.messageId,
          count: 1,
          bodyId: saveBody(email.body || ''), _stage: email._stage || '', _lang: email._lang || '', _type: email._type || 'unlabeled', _country: email._country || '',
          time: new Date().toISOString(),
          time_beijing: beijingToday(),
          status: 'sent',
        });
        batchSent++;
        batchCount++;
        if (!testMode) log.daily_count++;
      }
      // 记录已发联系人（防止中断重发）
      if (!testMode && email.company) {
        const sendHistoryPath = path.join(__dirname, '..', 'data', 'send-history.json');
        let sh = {};
        try { if (fs.existsSync(sendHistoryPath)) sh = JSON.parse(fs.readFileSync(sendHistoryPath, 'utf-8')); } catch {}
        const entry = sh[email.company] || {};
        const sentSet = new Set(entry.sentContacts || []);
        toList.forEach(r => sentSet.add(r.toLowerCase().trim()));
        sh[email.company] = { ...entry, sentContacts: [...sentSet], stage: entry.stage || 'cold' };
        try { fs.writeFileSync(sendHistoryPath, JSON.stringify(sh, null, 2)); } catch {}
      }
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      sendProgress({ type: 'sent', id: email.id, index: i + 1, total: sendQueue.length, company: email.company, to: toList.join(', '), count: toList.length, _testMode: testMode || undefined });
    } catch (err) {
      const errMsg = err.message || '';
      const rateKeywords = ['rate limit','too many','try again','temporarily','daily limit','quota exceeded','too frequently','421','450','451','452','454','554','suspension','blocked','throttled','behaviour','recently sending','transient reject'];
      const isRateLimited = rateKeywords.some(kw => errMsg.toLowerCase().includes(kw));
      if (isRateLimited && !testMode) {
        isPaused = true;
        sendProgress({ type: 'ratelimit', index: i + 1, total: sendQueue.length, company: email.company, to: toList.join(', '), error: errMsg, _testMode: false });
        if (tray) new Notification({ title: "⚠️ 发送已被限流", body: `${email.company}: ${errMsg}\n发送已自动暂停，请等待后手动恢复。` }).show();
        fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
        break;
      }
      // BCC 失败：逐人记录失败
      for (const r of toList) {
        log.sent.push({
          index: log.sent.length + 1, to: r, company: email.company || '',
          subject: actualSubject, time: new Date().toISOString(),
          time_beijing: beijingToday(),
          count: 1,
          bodyId: saveBody(email.body || ''), _stage: email._stage || '',
          _lang: email._lang || '', _type: email._type || 'unlabeled', _country: email._country || '',
          status: 'failed', error: errMsg,
        });
        batchFailed++;
        batchCount++;
      }
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      sendProgress({ type: 'failed', id: email.id, index: i + 1, total: sendQueue.length, company: email.company, to: toList.join(', '), error: errMsg, _testMode: testMode || undefined });
      // 退信特征标记
      const bounceKeywords = ['550','551','552','553','554','not found','user unknown','address rejected','mailbox','recipient rejected','不存在','拒收'];
      if (!testMode && bounceKeywords.some(kw => errMsg.toLowerCase().includes(kw))) {
        const { classifyBounce } = require('./bounce-checker');
        const { type, reason } = classifyBounce('', errMsg);
        try {
          const contacts = readContacts();
          for (const r of toList) {
            const key = (r || '').toLowerCase().trim();
            for (const c of contacts) {
              if ((c.email || '').toLowerCase().trim() === key) {
                c.bounced = true; c.bounceType = type; c.bounceReason = reason; c.bouncedAt = new Date().toISOString();
              }
            }
          }
          writeContacts(contacts);
        } catch {}
      }
    }

    // 公司间隔：下一个队列项换公司时，额外等待
    // 单人公司用短延迟（≤2 收件人），避免 15-20min 等待浪费在 1 封邮件上
    if (i < sendQueue.length - 1 && !testMode && !isPaused && log.daily_count < maxPerDay) {
      const nextCompany = sendQueue[i + 1]?.company;
      const curCompany = email.company;
      if (nextCompany && nextCompany !== curCompany && (companyDelayMin > 0 || companyDelayMax > 0)) {
        const curRecipients = toList.length;
        const isSingleRecipient = curRecipients <= SINGLE_RECIP_THRESHOLD;
        const useMin = isSingleRecipient ? SINGLE_DELAY_MIN : companyDelayMin;
        const useMax = isSingleRecipient ? SINGLE_DELAY_MAX : companyDelayMax;
        const pauseMs = Math.floor(Math.random() * (useMax - useMin + 1)) + useMin;
        const pauseSec = Math.round(pauseMs / 1000);
        const tag = isSingleRecipient ? '⚡快速切换' : '切换公司';
        console.log(`[发信] ${tag}: ${curCompany}(${curRecipients}人) → ${nextCompany}，等待 ${pauseSec}s (${Math.round(pauseSec/60)}min)`);
        sendProgress({ type: 'delay', seconds: pauseSec, company: nextCompany });
        await sleep(pauseMs);
      }
    }
  }

  await currentTransporter.close();

  // 发送完成通知（本轮计数，不包含历史）
  if (tray && !isPaused && !currentSendAbort && !testMode) {
    new Notification({ title: "Milogin's Prospector", body: `发送完成: 成功 ${batchSent} 封` + (batchFailed ? `, 失败 ${batchFailed} 封` : '') }).show();
  }

  if (!isPaused && !currentSendAbort) {
    // 发送完成，重置状态
    try { const sp = path.join(__dirname, '..', 'data', 'send-state.json'); fs.writeFileSync(sp, JSON.stringify({ status: 'idle' }, null, 2)); } catch {}
    sendProgress({ type: 'complete', total: sendQueue.length, sent: batchSent, failed: batchFailed, _testMode: testMode || undefined });
  }

  // 写入发信会话日志
  if (!testMode) {
    try {
      const sessionLogPath = path.join(__dirname, '..', 'send', 'session-log.json');
      let sessions = [];
      if (fs.existsSync(sessionLogPath)) {
        try { sessions = JSON.parse(fs.readFileSync(sessionLogPath, 'utf-8')); } catch {}
        if (!Array.isArray(sessions)) sessions = [];
      }
      sessions.push({
        ...sessionLog,
        finishedAt: new Date().toISOString(),
        durationSec: Math.round((Date.now() - new Date(sessionStart).getTime()) / 1000),
        result: { sent: batchSent, failed: batchFailed, total: batchSent + batchFailed },
        error: isPaused ? '已暂停' : currentSendAbort ? '已取消' : undefined,
      });
      // 只保留最近 100 条
      if (sessions.length > 100) sessions = sessions.slice(-100);
      fs.writeFileSync(sessionLogPath, JSON.stringify(sessions, null, 2));
    } catch {}
    // 发后自动退信检测：等 10 分钟后自动扫描收件箱
    scheduleAutoBounceCheck();
  }
  mainWindow?.show();
}

// ── 自动退信检测（发后 10 分钟触发）──────────────────────────────────
let autoBounceTimer = null;

function scheduleAutoBounceCheck() {
  clearTimeout(autoBounceTimer);
  autoBounceTimer = setTimeout(async () => {
    try {
      console.log('[退信] 自动检测启动...');
      const { checkBounces } = require('./bounce-checker');
      const result = await checkBounces();
      if (!result.ok) { console.log('[退信] 检测失败:', result.error); return; }
      if (!result.bounced?.length) { console.log('[退信] 未发现退信'); return; }
      console.log(`[退信] 发现 ${result.bounced.length} 封退信，匹配联系人...`);
      // 匹配联系人
      const contactsPath = path.join(__dirname, '..', 'data', 'contacts.json');
      if (!fs.existsSync(contactsPath)) return;
      let contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
      let matched = 0;
      for (const b of result.bounced) {
        if (!b.bouncedEmail) continue;
        const key = b.bouncedEmail.toLowerCase().trim();
        for (const c of contacts) {
          if ((c.email || '').toLowerCase().trim() === key) {
            c.bounced = true;
            c.bounceType = b.type || 'unknown';
            c.bounceReason = b.reason || '';
            c.bouncedAt = c.bouncedAt || new Date().toISOString();
            matched++;
          }
        }
      }
      if (matched > 0) {
        fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2));
        if (tray) new Notification({ title: '📨 退信检测', body: `发现 ${result.bounced.length} 封退信，已标记 ${matched} 个联系人` }).show();
        // 通知渲染进程
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bounce:autoDetected', { count: result.bounced.length, matched });
        }
      }
      console.log(`[退信] 完成: ${result.bounced.length} 封退信, ${matched} 人标记`);
    } catch (e) {
      console.error('[退信] 自动检测异常:', e.message);
    }
  }, 10 * 60 * 1000); // 10 分钟
  console.log('[退信] 已调度: 10 分钟后自动扫描');
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
  // 优先匹配表格格式：| **label** | value |
  const tableRe = new RegExp(`\\|\\s*\\*{0,2}${label}\\*{0,2}\\s*\\|\\s*(.+?)\\s*\\|`, 'i');
  const tableM = content.match(tableRe);
  if (tableM) return tableM[1].replace(/\*\*/g, '').trim();
  // 旧格式：label：value
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

// 北京时间日期（统一使用，避免 UTC 时区偏差）
function beijingToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}

function beijingDateFromISO(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

// ===== 应用生命周期 =====================================================

app.whenReady().then(async () => {

  try {
    templateLib = parseTemplateLibrary();
  } catch (e) {
    console.error('模板库加载失败，使用空库:', e.message);
    templateLib = { hooks: [], hooksAR: [], painPoints: {}, proofs: {}, ctas: [], ctasAR: [], followUps: {}, subjects: {}, spamWords: { es: [], en: [] } };
  }
  setupIPC();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
}).catch((err) => {
  console.error('应用启动失败:', err);
  app.quit();
});

app.on('before-quit', () => { isQuitting = true; try { stopScraplingService(); } catch {} try { require('./linkedin-client').stop(); } catch {} });
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

  tray.setToolTip("Milogin's Prospector");
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
