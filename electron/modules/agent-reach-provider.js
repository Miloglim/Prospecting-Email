// ── Agent-Reach 多平台背调（Exa + Jina + Tavily）─────────────────────────
const path = require('path'); const fs = require('fs'); const https = require('https');
const { APP_ROOT, loadSearchConfig } = require('./config');
const { API } = require('./core/contract');
const { sanitizeFilename } = require('./utils'); const { autoRate } = require('./auto-rate');

function httpsPost(hostname, port, pathname, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const opts = { hostname, port, method: 'POST', path: pathname, headers, timeout: timeoutMs || 25000 };
    const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
function httpsGet(urlStr, headers, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const opts = { hostname: u.hostname, port: u.port || 443, method: 'GET', path: u.pathname + u.search, headers: headers || {}, timeout: timeoutMs || 25000, rejectUnauthorized: false };
      const req = https.request(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { httpsGet(res.headers.location, headers, timeoutMs).then(resolve); return; }
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
      }); req.on('error', () => resolve('')); req.on('timeout', () => { req.destroy(); resolve(''); }); req.end();
    } catch { resolve(''); }
  });
}

async function research(cname, company, notifyProgress) {
  const cfg = loadSearchConfig(); const exaKey = cfg.search?.exaKey || '';
  const SUFFIXES = /\b(LTDA|S\.A\.?( DE C\.?V\.?)?|S DE R\.?L DE C\.?V\.?|SA DE CV|S\.?R\.?L\.?|LTD\.?|INC\.?|LLC|CORP\.?|GMBH|S\.?L\.?U\.?|PTY\.? LTD\.?)\b/gi;
  const cleanName = (cname || '').replace(SUFFIXES, '').replace(/\s{2,}/g, ' ').trim() || cname;
  let country = (company.country || '').trim(), category = (company.category || '').trim(), website = (company.website || '').trim();
  if (website && !website.startsWith('http')) website = '';

  notifyProgress('Exa AI 搜索公司信息...');
  let exaUrl = '', entity = null;
  try {
    const r1 = await httpsPost(API.EXA.hostname, 443, API.EXA.path, { 'Content-Type': 'application/json', 'x-api-key': exaKey }, JSON.stringify({ query: `${cleanName}${country ? ' ' + country : ''} company profile overview`, numResults: 5, type: 'auto' }), 30000);
    if (r1?.results?.length) {
      for (const r of r1.results) { if (r.entities?.length) { for (const e of r.entities) { if (e.type === 'company' && e.properties) { entity = e.properties; break; } } if (entity) break; } }
      exaUrl = r1.results[0]?.url || '';
      if (exaUrl?.includes('linkedin.com') || exaUrl?.includes('exa.ai')) { for (const r of r1.results) { const u = r.url || ''; if (u && !u.includes('linkedin.com') && !u.includes('exa.ai')) { exaUrl = u; break; } } }
    }
  } catch { /* 外部服务请求失败 → 降级返回空结果 */ }
  if (!country && entity?.headquarters?.country) country = entity.headquarters.country;
  if (!category && entity?.description) { const d = entity.description.toLowerCase(); for (const [k, v] of [['automotive','汽车零部件'],['pharmaceutical','制药'],['food','食品'],['mining','采矿'],['steel','钢铁'],['textile','纺织'],['electronics','电子'],['machinery','机械'],['chemical','化工'],['medical','医疗器械'],['construction','建筑']]) { if (d.includes(k)) { category = v; break; } } }

  notifyProgress('Exa AI 搜索贸易数据...');
  let tradeText = '';
  try {
    const r2 = await httpsPost(API.EXA.hostname, 443, API.EXA.path, { 'Content-Type': 'application/json', 'x-api-key': exaKey }, JSON.stringify({ query: `${cleanName}${country ? ' ' + country : ''} import export trade`, numResults: 5, type: 'auto' }), 30000);
    if (r2?.results?.length) { const ts = r2.results.filter(r => { const u = (r.url || '').toLowerCase(); return ['exportgenius','tendata','volza','importgenius','tradeimex','seair'].some(s => u.includes(s)); }); if (ts.length) tradeText = ts.map(r => `- **${r.title || '贸易'}**\n  ${r.url || ''}`).join('\n'); }
  } catch { /* 外部服务请求失败 → 降级返回空结果 */ }

  notifyProgress('Jina Reader 抓取官网...');
  let websiteText = ''; const urlToRead = website || exaUrl;
  if (urlToRead?.startsWith('http')) { try { const raw = await httpsGet('https://' + API.JINA.hostname + '/' + urlToRead, { 'Accept': 'text/markdown' }, 30000); if (raw?.length > 100) websiteText = raw.slice(0, 4000); } catch { /* 外部服务请求失败 → 降级返回空结果 */ } }

  notifyProgress('Tavily 搜索新闻...'); let tavilyText = '';
  try { const tk = cfg?.search?.apiKey || ''; if (tk) { const r = await httpsPost(API.TAVILY.hostname, 443, API.TAVILY.path, { 'Content-Type': 'application/json' }, JSON.stringify({ api_key: tk, query: `${cleanName}${country ? ' ' + country : ''}`, search_depth: 'basic', max_results: 5, include_answer: true }), 25000); if (r?.answer) tavilyText = r.answer + '\n\n'; if (r?.results?.length) tavilyText += r.results.map(r => `- **${r.title || ''}**\n  ${r.content || r.snippet || ''}\n  ${r.url || ''}`).join('\n\n'); } } catch { /* 外部服务请求失败 → 降级返回空结果 */ }

  notifyProgress('生成报告...');
  const { rating, signals } = autoRate([entity?.description || '', websiteText, tavilyText, tradeText].join('\n'), company);
  const stars = '⭐'.repeat(Math.min(5, Math.max(1, rating))); const fname = sanitizeFilename(cname).trim(); const dateStr = new Date().toISOString().slice(0, 10);
  const lines = []; lines.push('# ' + cname + ' — 背调信息卡'); lines.push('');
  const op = []; if (country) op.push('**国家：** ' + country); if (category) op.push('**品类：** ' + category); if (urlToRead) op.push('**官网：** ' + urlToRead);
  const wf = entity?.workforce?.total || entity?.workforce || ''; const wt = entity?.webTraffic?.visitsMonthly || ''; const fd = entity?.foundedYear || '';
  let ss = ''; if (wf) ss += wf + ' 人'; if (wt) ss += (ss ? '，' : '') + '月访问 ' + wt + ' 次'; if (fd) ss += (ss ? '，' : '') + '成立 ' + fd; if (ss) op.push('**规模：** ' + ss);
  lines.push(op.join('  |  '));
  if (entity?.description) { lines.push(''); lines.push('## 业务描述'); const ps = entity.description.replace(/\n{3,}/g, '\n\n').trim().split('\n').filter(p => p.trim().length > 20); lines.push(ps.slice(0, 4).join('\n\n')); }
  const hq = entity?.headquarters; const dl = []; if (hq?.address) dl.push('- **总部：** ' + hq.address); else if (hq?.city) dl.push('- **总部：** ' + [hq.city, hq.country].filter(Boolean).join(', ')); if (fd) dl.push('- **成立：** ' + fd); if (wf) dl.push('- **员工：** ' + wf + ' 人'); if (dl.length) { lines.push(''); lines.push('## 公司详情'); lines.push(dl.join('\n')); }
  if (websiteText.length > 100) { lines.push(''); lines.push('## 官网分析'); lines.push(websiteText.slice(0, 3000)); }
  if (tradeText) { lines.push(''); lines.push('## 贸易活动'); lines.push(tradeText); }
  if (tavilyText) { lines.push(''); lines.push('## 近期动态'); lines.push(tavilyText.slice(0, 2500)); }
  lines.push(''); lines.push('## 开发信号');
  if (signals.found.length) { lines.push('### ✅ 正向信号'); for (const s of signals.found) lines.push('- ' + s); }
  if (signals.warn.length) { lines.push('### ⚠️ 风险信号'); for (const s of signals.warn) lines.push('- ' + s); }
  if (signals.missing.length) { lines.push('### ❌ 缺失信号'); for (const s of signals.missing) lines.push('- ' + s); }
  lines.push('> **国家：** ' + (country || '未知') + ' | **品类：** ' + (category || '未知') + ' | **开发价值：** ' + stars + '（' + rating + '/5）');
  if (rating >= 4) lines.push('高价值 — 优先开发'); else if (rating >= 3) lines.push('中等价值 — 可跟进'); else lines.push('低价值 — 信号不足');
  lines.push(''); lines.push('---'); lines.push('> 📅 ' + dateStr + ' · Agent-Reach 多平台 API');
  const report = lines.join('\n'); const rp = path.join(APP_ROOT, 'reports', '客户背调-' + fname + '.md');
  const dir = path.dirname(rp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(rp, report);
  return { ok: true, status: 'done', rating, message: '报告已生成' };
}

module.exports = { research };
