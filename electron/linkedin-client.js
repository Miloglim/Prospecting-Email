// ── LinkedIn 客户端（MCP stdio 协议，独立 profile）────────────────
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Log } = require('./modules/core/logger');

let proc = null;
let pending = new Map();
let reqId = 0;
let ready = false;
let initPromise = null;

// 独立 profile 目录（不跟 Claude Code 共享，避免 Cookie 锁冲突）
const PROFILE_DIR = path.join(process.env.USERPROFILE || '~', '.linkedin-mcp', 'standalone');

function start() {
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve) => {
    const exe = findExe();
    if (!exe) { resolve(false); return; }

    const args = ['-m', 'linkedin_mcp_server.cli_main',
      '--transport', 'stdio', '--log-level', 'ERROR',
      '--user-data-dir', PROFILE_DIR];

    Log.info('linkedin', '启动独立服务...');
    proc = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            const { resolve: rs } = pending.get(msg.id);
            pending.delete(msg.id);
            rs(msg);
          }
        } catch { /* JSON 解析失败 → 跳过非 JSON 行 */ }
      }
    });

    proc.stderr.on('data', (d) => { /* 静默 */ });
    proc.on('exit', () => { ready = false; initPromise = null; proc = null; });

    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'prospector', version: '1.0' },
    }).then(rsp => {
      if (rsp.result) {
        ready = true;
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        Log.info('linkedin', '✅ 就绪');
        resolve(true);
      } else {
        Log.error('linkedin', '初始化失败');
        resolve(false);
      }
    }).catch(() => resolve(false));
  });

  return initPromise;
}

function findExe() {
  // 优先 D: 盘 Python
  const candidates = ['D:/Python/python.exe', 'python', 'python3'];
  for (const c of candidates) {
    try { const out = require('child_process').execSync(`"${c}" --version`, { encoding: 'utf-8' }); if (out) return c; }
    catch { /* 候选解释器不存在 → 继续尝试下一个 */ }
  }
  return null;
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    if (!proc || proc.killed) return reject(new Error('未运行'));
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
    try { proc.stdin.write(msg); } catch (e) { pending.delete(id); reject(e); }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('超时')); } }, 30000);
  });
}

async function searchPeople(keywords) {
  try {
    if (!ready) { const ok = await start(); if (!ok) return []; }
    const rsp = await send('tools/call', { name: 'search_people', arguments: { keywords } });
    const text = (rsp?.result?.content || []).find(c => c.type === 'text')?.text || '';
    return parseSearchResults(text);
  } catch (e) {
    Log.error('linkedin', '搜索跳过', e.stack);
    return [];
  }
}

async function getProfile(username) {
  try {
    if (!ready) { const ok = await start(); if (!ok) return null; }
    const rsp = await send('tools/call', { name: 'get_person_profile', arguments: { linkedin_username: username } });
    return (rsp?.result?.content || []).find(c => c.type === 'text')?.text || null;
  } catch (e) {
    Log.error('linkedin', '档案跳过', e.stack);
    return null;
  }
}

function parseSearchResults(text) {
  const people = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let name = lines[i].replace(/^[•·]\s*/, '').trim();
    if (name.length < 3 || name.length > 60) continue;
    if (/^(这些结果|LinkedIn|关于|无障碍|帮助中心|隐私|广告|商业服务|获取领英|更多|下一步|No valid)/.test(name)) continue;
    if (name.includes('共同好友') || name.includes('关注') || name.includes('加为好友')) continue;

    const title = (lines[i+1]?.length > 5 && lines[i+1]?.length < 120) ? lines[i+1] : '';
    const location = (title && lines[i+2]?.length > 3 && lines[i+2]?.length < 60) ? lines[i+2] : '';

    if (title) {
      people.push({ name, title, location, source: 'linkedin' });
      i += location ? 2 : 1;
    }
  }
  return people;
}

function stop() {
  if (proc && !proc.killed) { proc.kill(); proc = null; ready = false; initPromise = null; }
}

module.exports = { start, stop, searchPeople, getProfile };
