// ── 背调 + 翻译 IPC 处理器 ─────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const https = require('https');
const cheerio = require('cheerio');
const { APP_ROOT, loadSearchConfig, createRequest } = require('./config');
const { sanitizeFilename } = require('./utils');
const { autoRate } = require('./auto-rate');
const { callScraplingAPI } = require('./scrapling');
const { verifyEmailWithAgnes } = require('./agnes-verify');

// 浏览器引擎：CloakBrowser 优先，降级 puppeteer-extra+stealth
let _browserCache = null;
function getBrowser() {
  if (_browserCache !== null) return _browserCache;
  // 1. CloakBrowser（C++ 源码级反检测，通过率最高）
  try {
    const { chromium } = require('cloakbrowser');
    _browserCache = { engine: 'cloakbrowser', launch: () => chromium.launch({ headless: true, args: ['--no-sandbox'] }) };
    console.log('[浏览器] CloakBrowser 就绪');
    return _browserCache;
  } catch {}
  // 2. Puppeteer + Stealth（JS 层反检测，降级方案）
  try {
    const p = require('puppeteer-extra');
    p.use(require('puppeteer-extra-plugin-stealth')());
    _browserCache = { engine: 'puppeteer', launch: () => p.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] }) };
    console.log('[浏览器] Puppeteer+Stealth 就绪（降级）');
    return _browserCache;
  } catch (e) { _browserCache = false; console.log('[浏览器] 不可用，搜索已禁用'); return null; }
}

function register(ipcMain, deps) {

  const backcheckStatusPath = path.join(APP_ROOT, 'data', 'backcheck-status.json');

  function readBackcheckStatus() {
    try { return fs.existsSync(backcheckStatusPath) ? JSON.parse(fs.readFileSync(backcheckStatusPath, 'utf-8')) : {}; }
    catch { return {}; }
  }
  function writeBackcheckStatus(status) {
    const dir = path.dirname(backcheckStatusPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(backcheckStatusPath, JSON.stringify(status, null, 2));
  }
  function notifyBackcheck(cname, data) {
    if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
      deps.mainWindow.webContents.send('backcheck:progress', { company: cname, ...data });
    }
  }
  function checkReportExists(cname) {
    const fname = sanitizeFilename(cname);
    const rp = path.join(APP_ROOT, 'reports', `客户背调-${fname}.md`);
    return fs.existsSync(rp) ? rp : null;
  }

  // ── 官网爬虫 ──
  async function crawlWebsite(url) {
    if (!url || !url.startsWith('http')) return '';
    const skip = ['linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com', 'youtube.com', 'tiktok.com'];
    try { if (skip.some(d => new URL(url).hostname.toLowerCase().includes(d))) return ''; } catch { return ''; }
    return new Promise((resolve) => {
      const u = new URL(url);
      const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' } };
      const req = createRequest(opts);
      req.on('response', (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { crawlWebsite(res.headers.location).then(resolve); return; }
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const $ = cheerio.load(data);
            $('script, style, nav, footer, iframe, noscript, [aria-hidden="true"]').remove();
            const sections = [];
            const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
            if (metaDesc) sections.push(`**简介:** ${metaDesc.trim()}`);
            const seen = new Set();
            $('h1, h2, h3, h4').each((_, h) => {
              const t = $(h).text().trim();
              if (!t || t.length < 3 || t.length > 80 || /^(menu|search|cart|login|sign|subscribe|follow|share|home)$/i.test(t)) return;
              if (seen.has(t.toLowerCase())) return; seen.add(t.toLowerCase());
              let c = '', el = $(h).next(), n = 0;
              while (el.length && n < 6) { const tx = el.text().trim(); if (tx && tx.length > 15) { c += tx + ' '; n++; } el = el.next(); }
              if (c) sections.push(`**${t}:** ${c.trim().slice(0, 300)}`);
            });
            if (sections.length < 2) { $('script, style').remove(); const raw = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2500); if (raw.length > 100) sections.push(raw); }
            resolve(sections.join('\n').slice(0, 2500));
          } catch { resolve(data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)); }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  // ── DDG 搜索 ──
  async function ddgSearch(cname) {
    let browser;
    try {
      const br = getBrowser(); if (!br) return '';
      browser = await br.launch({ headless: true, args: ['--no-sandbox', '--proxy-server=127.0.0.1:7890'], timeout: 30000 });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent('"' + cname + '"')}&ia=web`, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 2000));
      if (await page.evaluate(() => document.body.innerText.includes('No results found'))) {
        await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(cname)}&ia=web`, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));
      }
      const results = await page.evaluate(() => {
        const items = []; const skip = ['linkedin.', 'facebook.', 'twitter.', 'instagram.', 'youtube.', 'wikipedia.', 'duckduckgo.', 'apple.', 'reddit.', 'google.']; const seen = new Set();
        document.querySelectorAll('a[href^="http"]').forEach(a => {
          const href = a.href || ''; const text = (a.textContent || '').trim().replace(/\\s+/g, ' ');
          if (text.length < 10 || href.length < 30) return;
          if (a.closest('nav') || a.closest('footer') || a.closest('header')) return;
          try { const host = new URL(href).hostname; if (skip.some(d => host.includes(d))) return; const k = host; if (seen.has(k)) return; seen.add(k); items.push({ title: text.slice(0, 100), link: href, host }); } catch {}
        });
        return items.slice(0, 8);
      });
      await browser.close();
      const foundUrl = results.length > 0 ? (() => { try { return new URL(results[0].link).origin; } catch { return ''; } })() : '';
      return { foundUrl, snippets: results.map(r => `- **${r.title}**: ${r.host}`).join('\n') };
    } catch (e) {
      if (browser) try { await browser.close(); } catch {}
      return { foundUrl: '', snippets: '', error: e.message };
    }
  }

  // ── DeepSeek 通用搜索引擎 ──
  async function searchThenDeepSeek(cname, company, searcher) {
    const cfg = loadSearchConfig();
    const apiKey = cfg?.translate?.deepseek?.apiKey || '';
    const exaKey = cfg.search?.exaKey || '';
    const serperKey = cfg.search?.serperKey || '';
    const tvlyKey = cfg.search?.apiKey || '';
    const country = (company.country || '').trim() || 'Mexico';
    const fname = sanitizeFilename(cname).trim();
    const dateStr = new Date().toISOString().slice(0, 10);

    notifyBackcheck(cname, { type: 'research-progress', progress: searcher + ' 搜索...' });
    let searchContext = '';

    if (searcher === 'exa' && exaKey) {
      try {
        const raw = await new Promise(r => {
          const b = JSON.stringify({ query: cname + ' ' + country + ' company', numResults: 8, type: 'auto' });
          const o = { hostname: 'api.exa.ai', port: 443, method: 'POST', path: '/search', headers: { 'Content-Type': 'application/json', 'x-api-key': exaKey }, timeout: 15000, rejectUnauthorized: false };
          const req = https.request(o, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
          req.on('error', () => r(null)); req.on('timeout', () => { req.destroy(); r(null); }); req.end(b);
        });
        if (raw?.results?.length) searchContext = raw.results.slice(0, 6).map(r => '标题：' + (r.title || '') + '\nURL：' + (r.url || '') + '\n内容：' + (r.text || '').slice(0, 400)).join('\n\n');
      } catch {}
    } else if (searcher === 'serper' && serperKey) {
      try {
        const raw = await new Promise(r => {
          const b = JSON.stringify({ q: cname + ' ' + country, num: 8 });
          const o = { hostname: 'google.serper.dev', port: 443, method: 'POST', path: '/search', headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey }, timeout: 15000, rejectUnauthorized: false };
          const req = https.request(o, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
          req.on('error', () => r(null)); req.on('timeout', () => { req.destroy(); r(null); }); req.end(b);
        });
        if (raw?.organic?.length) searchContext = raw.organic.slice(0, 6).map(r => '标题：' + (r.title || '') + '\nURL：' + (r.link || '') + '\n内容：' + (r.snippet || '').slice(0, 400)).join('\n\n');
      } catch {}
    } else if (searcher === 'tavily' && tvlyKey) {
      try {
        const raw = await new Promise(r => {
          const b = JSON.stringify({ api_key: tvlyKey, query: cname + ' ' + country, search_depth: 'advanced', max_results: 8, include_answer: true });
          const o = { hostname: 'api.tavily.com', port: 443, method: 'POST', path: '/search', headers: { 'Content-Type': 'application/json' }, timeout: 15000, rejectUnauthorized: false };
          const req = https.request(o, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(null); } }); });
          req.on('error', () => r(null)); req.on('timeout', () => { req.destroy(); r(null); }); req.end(b);
        });
        if (raw?.answer) searchContext += 'AI摘要：' + raw.answer + '\n\n';
        if (raw?.results?.length) searchContext += raw.results.slice(0, 6).map(r => '标题：' + (r.title || '') + '\nURL：' + (r.url || '') + '\n内容：' + (r.content || '').slice(0, 400)).join('\n\n');
      } catch {}
    }

    notifyBackcheck(cname, { type: 'research-progress', progress: 'DeepSeek 分析...' });
    if (!apiKey) return { ok: false, status: 'error', message: '请配置 DeepSeek API Key' };

    const systemPrompt = '你是YQN物流集团的商业情报分析师。直接输出报告，禁止前置寒暄。\n\n# ' + cname + ' ⭐X/5\n\n> 国家 · 品类 | 开发价值 ⭐X/5\n\n| 项目 | 内容 |\n|------|------|\n| 官网 | URL |\n\n## 深度分析\n\n结论，不写推理。\n\n## 近期动态\n\n- YYYY-MM 事件\n\n## 开发信号\n\n- ✅/❌ 信号 — 证据\n\n## 评级\n\nX/5。\n\n## 开发信（西语）\n\n**Subject:** [15词以内]\n\n正文。\n\n**Saludos** ← 以这个词结尾，其后不写任何落款/署名/名片信息\n\n> 🈲 禁止使用 [Su Nombre]、[Su Empresa]、[Su Cargo]、[Nombre del Contacto] 等占位符\n> 🈲 禁止在 Saludos 之后写落款、署名、职位、公司名\n> 📅 ' + dateStr;

    try {
      const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: '公司名：' + cname + '\n国家：' + country + (searchContext ? '\n\n【搜索结果】\n' + searchContext : '') + '\n\n请开始分析。' }], temperature: 0.3, max_tokens: 4000 });
      const result = await new Promise((resolve) => {
        const opts = { hostname: 'api.deepseek.com', port: 443, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, timeout: 60000, rejectUnauthorized: false };
        const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
        req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end(body);
      });
      if (!result?.choices?.[0]?.message?.content) return { ok: false, status: 'error', message: 'DeepSeek 返回空' };
      const fullText = result.choices[0].message.content;
      const rating = parseInt((fullText.match(/⭐(\d)\/5/) || [])[1]) || 3;

      const dir = path.join(APP_ROOT, 'reports'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '客户背调-' + fname + '.md'), fullText);

      const emailSplit = fullText.split(/\n##\s*开发信/);
      if (emailSplit.length > 1) {
        const eb = ('## 开发信' + emailSplit[1]).trim();
        if (eb.length >= 20) fs.writeFileSync(path.join(dir, '客户背调-' + fname + '-email.md'), eb);
      }
      notifyBackcheck(cname, { type: 'research-progress', progress: '报告已生成' });
      return { ok: true, status: 'done', rating, message: '报告已生成' };
    } catch (e) { return { ok: false, status: 'error', message: '请求失败: ' + (e.message || '未知') }; }
  }

  // ── 搜索提供商 ──
  function buildReport(cname, company, searchSnippets, websiteText, urlToCrawl, providerLabel) {
    const allText = ((searchSnippets || '') + ' ' + websiteText).trim();
    const { rating, signals } = autoRate(allText, company);
    const sp = []; if (signals.found.length) sp.push('✅ ' + signals.found.join(' / '));
    if (signals.warn.length) sp.push('⚠️ ' + signals.warn.join(' / '));
    if (signals.missing.length) sp.push('❌ ' + signals.missing.join(' / '));
    const st = sp.length ? ' ' + sp.join(' | ') : '';
    const stars = '⭐'.repeat(Math.min(5, Math.max(1, rating)));
    const tags = [company.country, company.category].filter(Boolean).join(' · ') || '信息待补充';
    const fname = sanitizeFilename(cname).trim();
    const dateStr = new Date().toISOString().slice(0, 10);
    const hasWebsite = websiteText.length > 100;

    const lines = [];
    lines.push('# ' + cname);
    lines.push('> ' + tags + ' | 开发价值 ' + stars + '（' + rating + '/5）' + st);
    lines.push('---');
    lines.push('## 基本信息');
    lines.push('| 项目 | 内容 |'); lines.push('|------|------|');
    lines.push('| **公司** | ' + cname + ' |');
    if (company.country) lines.push('| **国家** | ' + company.country + ' |');
    if (company.category) lines.push('| **品类** | ' + company.category + ' |');
    if (company.email) lines.push('| **邮箱** | ' + company.email + ' |');
    if (urlToCrawl) lines.push('| **网站** | ' + urlToCrawl + ' |');
    if (searchSnippets) { lines.push('## 搜索发现'); lines.push(searchSnippets.slice(0, 2000)); }
    lines.push('## 官网洞察');
    lines.push(hasWebsite ? websiteText.slice(0, 2500) : (urlToCrawl ? '_官网已抓取但内容有限_' : '_未找到官网_'));
    lines.push('---');
    lines.push('> 📅 ' + dateStr + ' · ' + providerLabel);

    const report = lines.join('\n');
    const rp = path.join(APP_ROOT, 'reports', '客户背调-' + fname + '.md');
    const dir = path.dirname(rp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(rp, report);
    return { ok: true, status: 'done', rating, message: '报告已生成' };
  }

  const searchProviders = {
    'scrapling': {
      name: 'Scrapling 智能抓取',
      research: async (cname, company) => {
        notifyBackcheck(cname, { type: 'research-progress', progress: '搜索公司信息...' });
        const sr = await callScraplingAPI(`/search/web?q=${encodeURIComponent(cname)}&n=8`);
        let url = sr?.foundUrl || (company.website?.startsWith('http') ? company.website : '');
        let wt = '';
        if (url) { notifyBackcheck(cname, { type: 'research-progress', progress: '抓取官网...' });
          try { const wr = await callScraplingAPI(`/scrape/website?url=${encodeURIComponent(url)}&stealth=true&max_chars=3000`);
            if (wr?.ok) { const p = []; if (wr.meta_desc) p.push(`**简介:** ${wr.meta_desc}`); if (wr.text) p.push(wr.text); wt = p.join('\n'); } } catch {} }
        return buildReport(cname, company, sr?.snippets || '', wt, url, 'Scrapling 智能抓取');
      }
    },
    'ddg-crawl': {
      name: 'DDG + 官网',
      research: async (cname, company) => {
        notifyBackcheck(cname, { type: 'research-progress', progress: 'DDG 搜索中...' });
        const ddg = await ddgSearch(cname);
        let url = ddg.foundUrl, wt = '';
        if (!url && company.website?.startsWith('http')) { try { if (!new URL(company.website).hostname.includes('linkedin.com')) url = company.website; } catch {} }
        if (url) { notifyBackcheck(cname, { type: 'research-progress', progress: '抓取官网...' }); try { wt = await crawlWebsite(url); } catch {} }
        return buildReport(cname, company, ddg.snippets || '', wt, url, 'DDG + 官网爬虫');
      }
    },
    'serper-deepseek': { name: 'Google 搜索', research: async (c, co) => searchThenDeepSeek(c, co, 'serper') },
    'tavily-deepseek': { name: 'Tavily 搜索', research: async (c, co) => searchThenDeepSeek(c, co, 'tavily') },
    'deep-research': { name: 'Exa 搜索', research: async (c, co) => searchThenDeepSeek(c, co, 'exa') },
    'agent-reach': {
      name: 'Agent-Reach 多平台',
      research: async (cname, company) => {
        const agentReach = require('./agent-reach-provider');
        return agentReach.research(cname, company, (msg) => notifyBackcheck(cname, { type: 'research-progress', progress: msg }));
      }
    },
  };

  // ── IPC 注册 ──
  ipcMain.handle('backcheck:getReports', async () => {
    const rd = path.join(APP_ROOT, 'reports'); if (!fs.existsSync(rd)) return [];
    return fs.readdirSync(rd).filter(f => f.endsWith('.md')).map(f => ({ name: f.replace('.md', ''), path: path.join(rd, f) }));
  });

  ipcMain.handle('backcheck:getStatus', async () => {
    const status = readBackcheckStatus(); let changed = false;
    for (const [cn, st] of Object.entries(status)) { if (st.status === 'done' && !checkReportExists(cn)) { delete status[cn]; changed = true; } }
    if (changed) writeBackcheckStatus(status); return status;
  });

  ipcMain.handle('backcheck:getDetail', async (_e, companyName) => {
    const fname = sanitizeFilename(companyName);
    const ep = path.join(APP_ROOT, 'reports', `客户背调-${fname}.md`);
    let content = ''; if (fs.existsSync(ep)) content = fs.readFileSync(ep, 'utf-8');
    if (!content) return { website: '', scale: '', category: '', imports: '', contact: '', news: '', rating: 0, raw: '' };
    let rating = 0;
    const tm = content.match(/^#\s+.+?\s*([⭐★]{1,5})\s*(\d)\/5/m);
    if (tm) rating = parseInt(tm[2]) || tm[1].length;
    if (!rating) { const om = content.match(/(?:货代)?开发价值[：:]\*\*\s*([⭐★1-5]+)/); if (om) rating = (om[1].match(/[⭐★]/g) || []).length || parseInt(om[1]) || 0; }
    function fv(l) { const tr = new RegExp(`\\|\\s*\\*{0,2}${l}\\*{0,2}\\s*\\|\\s*(.+?)\\s*\\|`, 'i'); const tm = content.match(tr); if (tm) return tm[1].replace(/\*\*/g, '').trim(); const or = new RegExp(`${l}[：:]\\s*(.+?)(?:\\n|$)`, 'i'); const om = content.match(or); return om ? om[1].trim() : ''; }
    const emailPath = path.join(APP_ROOT, 'reports', '客户背调-' + fname + '-email.md');
    let emailBody = ''; if (fs.existsSync(emailPath)) emailBody = fs.readFileSync(emailPath, 'utf-8');
    return { website: fv('官网') || fv('网站') || fv('Website'), scale: fv('规模') || fv('Scale'), category: fv('品类') || fv('Category'), imports: fv('进口特征') || fv('进口'), contact: fv('收件人') || fv('To'), news: fv('近期动态') || fv('动态'), country: fv('国家'), rating, raw: content, emailBody };
  });

  ipcMain.handle('backcheck:research', async (_e, company, providerKey) => {
    const cn = company.company; const st = readBackcheckStatus();
    if (st[cn]?.status === 'researching') return { ok: false, message: '该公司正在背调中' };
    const er = checkReportExists(cn); if (er) { try { fs.unlinkSync(er); } catch {} delete st[cn]; writeBackcheckStatus(st); }
    st[cn] = { status: 'researching', requestedAt: new Date().toISOString(), progress: '搜索启动...' };
    writeBackcheckStatus(st); notifyBackcheck(cn, { type: 'research-start' });
    researchInBackground(cn, company, providerKey || 'deep-research').catch(e => {
      console.error('[背调致命]', cn, e); updateStatus(cn, 'error', 0, e.message || '未知');
      notifyBackcheck(cn, { type: 'research-done', status: 'error', message: e.message });
    });
    return { ok: true, message: '背调已启动' };
  });

  async function researchInBackground(cn, co, pk) {
    try {
      pk = pk || 'deep-research'; const provider = searchProviders[pk] || searchProviders['deep-research'];
      notifyBackcheck(cn, { type: 'research-progress', progress: provider.name + ' 搜索中...' });
      const r = await provider.research(cn, co);
      if (r.ok) updateStatus(cn, 'done', r.rating || 0, '报告已生成'); else updateStatus(cn, r.status || 'error', 0, r.message);
    } catch (e) { console.error('[背调异常]', cn, e); updateStatus(cn, 'error', 0, e.message || '未知'); }
    notifyBackcheck(cn, { type: 'research-done', status: readBackcheckStatus()[cn]?.status || 'error' });
  }
  function updateStatus(cn, status, rating, progress) {
    const st = readBackcheckStatus(); st[cn] = { status, rating, completedAt: new Date().toISOString(), progress }; writeBackcheckStatus(st);
  }

  ipcMain.handle('backcheck:markDone', async (_e, cn, rating) => {
    const st = readBackcheckStatus(); st[cn] = { status: 'done', completedAt: new Date().toISOString(), rating: rating || st[cn]?.rating || 0 }; writeBackcheckStatus(st); return { ok: true };
  });
  ipcMain.handle('backcheck:verifyEmail', async (_e, eb) => verifyEmailWithAgnes(eb));
  ipcMain.handle('backcheck:cancel', async (_e, cn) => { const st = readBackcheckStatus(); delete st[cn]; writeBackcheckStatus(st); return { ok: true }; });

}

module.exports = { register };
