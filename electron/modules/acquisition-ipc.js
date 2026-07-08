// ── 客户开发 IPC — Provider 注册表 + 搜索/揭示/画像管理 ───────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT, loadSearchConfig } = require('./config');
const { Log } = require('./core/logger');

// ═══════════════════════════════════════════════════════════════════════════════
// Provider 注册表 — 后期加新数据源只需在这里加一个 entry
// ═══════════════════════════════════════════════════════════════════════════════

const PROVIDER_REGISTRY = {
  apollo: {
    key: 'apollo',
    label: 'Apollo.io',
    icon: 'globe',
    requiresAuth: true,
    authField: 'apolloApiKey',       // 从 send/config.json 读取的 key
    factory(apiKey) {
      const { ApolloClient } = require('../../tools/customer-acquisition/src/providers/apollo/client');
      return new ApolloClient(apiKey);
    },
  },
  // 后期:
  // linkedin: {
  //   key: 'linkedin',
  //   label: 'LinkedIn 爬虫',
  //   icon: 'linkedin',
  //   requiresAuth: true,
  //   authField: 'linkedinCookie',
  //   requiresRuntime: 'puppeteer',
  //   factory(cookie) {
  //     const { LinkedInProvider } = require('../../tools/customer-acquisition/src/providers/linkedin/client');
  //     return new LinkedInProvider(cookie);
  //   },
  // },
  // customs: {
  //   key: 'customs',
  //   label: '海关数据',
  //   icon: 'ship',
  //   requiresAuth: false,
  //   factory() {
  //     const { CustomsProvider } = require('../../tools/customer-acquisition/src/providers/customs/client');
  //     return new CustomsProvider();
  //   },
  // },
};

// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

const PROFILES_DIR = path.join(APP_ROOT, '..', 'tools', 'customer-acquisition', 'profiles');
const { CustomerAcquisitionEngine } = require('../../tools/customer-acquisition/src/engine');

// 运行时缓存（同一会话复用引擎实例）
const _cache = {};

function _loadProfile(profileId) {
  const filePath = path.join(PROFILES_DIR, `${profileId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`画像不存在: ${profileId}`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // 补全 profileId
  if (!raw.profileId) raw.profileId = profileId;
  return raw;
}

function _saveProfile(profileId, data) {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const filePath = path.join(PROFILES_DIR, `${profileId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function _getApiKey(source) {
  const entry = PROVIDER_REGISTRY[source];
  if (!entry || !entry.requiresAuth) return '';
  const cfg = loadSearchConfig();
  return cfg?.[entry.authField] || process.env.APOLLO_API_KEY || '';
}

async function _getOrCreateEngine(source) {
  const apiKey = _getApiKey(source);
  if (!apiKey) throw new Error(`缺少 API Key: 请在设置中配置 ${PROVIDER_REGISTRY[source]?.authField || 'apiKey'}`);

  const cacheKey = `${source}_${apiKey}`;
  if (!_cache[cacheKey]) {
    const provider = PROVIDER_REGISTRY[source].factory(apiKey);
    _cache[cacheKey] = new CustomerAcquisitionEngine(provider);
  }
  return _cache[cacheKey];
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC 注册
// ═══════════════════════════════════════════════════════════════════════════════

function register(ipcMain, deps) {
  // ── 画像管理 ────────────────────────────────────────────────────────────

  ipcMain.handle('discover:profiles', async () => {
    try {
      return CustomerAcquisitionEngine.listProfiles(PROFILES_DIR);
    } catch (e) {
      Log.error('客户开发', 'listProfiles 失败', e.message);
      return [];
    }
  });

  ipcMain.handle('discover:getProfile', async (_e, profileId) => {
    try {
      return { ok: true, profile: _loadProfile(profileId) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('discover:saveProfile', async (_e, profileId, data) => {
    try {
      if (!data?.companyDiscovery?.nameKeywords?.length) throw new Error('缺少公司名关键词');
      if (!data?.companyDiscovery?.countries?.length) throw new Error('缺少目标国家');
      _saveProfile(profileId, data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('discover:deleteProfile', async (_e, profileId) => {
    try {
      const fp = path.join(PROFILES_DIR, `${profileId}.json`);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 数据源列表 ──────────────────────────────────────────────────────────

  ipcMain.handle('discover:providers', async () => {
    return Object.values(PROVIDER_REGISTRY).map(p => ({
      key: p.key, label: p.label, icon: p.icon, requiresAuth: p.requiresAuth,
    }));
  });

  // ── 搜索（免费）────────────────────────────────────────────────────────

  ipcMain.handle('discover:search', async (_e, profileId) => {
    try {
      const profile = _loadProfile(profileId);
      const source = profile.companyDiscovery?.source || 'apollo';
      const engine = await _getOrCreateEngine(source);

      Log.info('客户开发', `开始搜索: ${profileId} (${source})`);
      const { companies, people, report, rawPeople } = await engine.searchPhase(profile);

      // 缓存本次搜索（供 reveal 阶段用）
      _cache._lastSearch = { profile, people, rawPeople, engine, report, profileId, source };

      Log.info('客户开发', `搜索完成: ${report.totalCompanies}家公司, ${report.totalPeople}人`);
      return { ok: true, companies: companies.slice(0, 200), people: people.slice(0, 500), report };
    } catch (e) {
      Log.error('客户开发', '搜索失败', e.message);
      return { ok: false, error: e.message };
    }
  });

  // ── 公司详情（联系人列表）───────────────────────────────────────────────

  ipcMain.handle('discover:companyDetail', async (_e, companyDomain) => {
    try {
      const last = _cache._lastSearch;
      if (!last) return { ok: false, error: '请先执行搜索' };

      const allPeople = last.rawPeople || last.people || [];
      const companyPeople = allPeople.filter(p =>
        (p.companyDomain || '').toLowerCase() === companyDomain.toLowerCase()
      );

      return {
        ok: true,
        companyName: companyPeople[0]?.companyName || '',
        domain: companyDomain,
        total: companyPeople.length,
        withEmail: companyPeople.filter(p => p.hasEmail).length,
        people: companyPeople.slice(0, 100),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 揭示邮箱（付费）────────────────────────────────────────────────────

  ipcMain.handle('discover:reveal', async (_e, profileId, maxCredits, domainFilter) => {
    try {
      const last = _cache._lastSearch;
      if (!last || last.profileId !== profileId) {
        return { ok: false, error: '请先重新搜索，缓存已过期' };
      }

      let people = last.people;
      // 可选：只揭示某家公司的
      if (domainFilter) {
        people = people.filter(p =>
          (p.companyDomain || '').toLowerCase() === domainFilter.toLowerCase()
        );
      }

      if (!people.length) return { ok: false, error: '没有可揭示的联系人' };

      Log.info('客户开发', `开始揭示: ${people.length} 人, 预算 ${maxCredits}c`);
      const contacts = await last.engine.revealPhase(people, last.profile, maxCredits);

      const revealed = contacts.filter(c => c.emailSource === 'revealed').length;
      const inferred = contacts.filter(c => c.emailSource === 'inferred').length;

      return { ok: true, contacts, stats: { revealed, inferred, total: contacts.length } };
    } catch (e) {
      Log.error('客户开发', '揭示失败', e.message);
      return { ok: false, error: e.message };
    }
  });

  // ── 搜索进度（主进程推送 → 渲染进程）───────────────────────────────────

  ipcMain.handle('discover:searchProgress', async () => {
    // 渲染进程通过 on 监听，这里只给回调注册点
    return true;
  });
}

module.exports = { register, PROVIDER_REGISTRY };
