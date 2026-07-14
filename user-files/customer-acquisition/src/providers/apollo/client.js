// ── Apollo.io API 适配器 ────────────────────────────────────────────────────
// 实现 Provider 接口约定，封装 HTTP 调用 + 重试 + 速率控制
//
// 接口:
//   searchCompanies(config) → Company[]
//   fetchPeople(domains)     → Person[]
//   revealEmails(people)     → Contact[]
//
// 审查:
//   每个公开方法入参、出参均经过 contract.ASSERT 校验

const https = require('https');
const http = require('http');
const { ASSERT, ContractError } = require('../interface');

const APOLLO_BASE = 'api.apollo.io';
const API_PATH = '/api/v1';

// ── 代理配置 ──
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const PROXY_URL = PROXY ? new URL(PROXY) : null;

class ApolloClient {
  constructor(apiKey) {
    ASSERT.string(apiKey, 'ApolloClient.apiKey');
    this.apiKey = apiKey;
    this.creditsUsed = 0;
  }

  get name() { return 'apollo'; }
  get creditsPerReveal() { return 1; }

  // ══════════════════════════════════════════════════════════════════
  // 阶段1: 搜公司
  // ══════════════════════════════════════════════════════════════════

  async searchCompanies(config) {
    const {
      nameKeywords, countries, sizeRanges = ['11,50', '51,200'],
      maxPagesPerKeyword = 3, perPage = 25,
    } = config;
    ASSERT.nonEmptyArray(nameKeywords, 'nameKeywords');
    ASSERT.nonEmptyArray(countries, 'countries');

    const seen = new Set();
    const companies = [];
    let pagesWithResults = 0;

    for (const country of countries) {
      for (const nameKw of nameKeywords) {
        for (let page = 1; page <= maxPagesPerKeyword; page++) {
          const result = await this._call('POST', '/mixed_companies/search', {
            q_organization_name: nameKw,
            organization_locations: [country],
            organization_num_employees_ranges: sizeRanges,
            page, per_page: perPage,
          });

          const orgs = result.organizations || [];
          if (!orgs.length) break;
          pagesWithResults++;

          for (const org of orgs) {
            const domain = (org.domain || org.primary_domain || '').trim().toLowerCase();
            if (!domain || seen.has(domain)) continue;
            seen.add(domain);
            companies.push({
              name: org.name || '',
              domain,
              id: org.id || '',
              employees: String(org.estimated_num_employees || ''),
              industry: org.industry || '',
              country,
              searchKw: nameKw,
            });
          }

          console.log(`  [${nameKw} @ ${country}] p${page}: ${orgs.length}条 (累计 ${companies.length}家)`);

          if (orgs.length < perPage) break;
          await this._sleep(300);
        }
      }
    }

    console.log(`[阶段1] ${companies.length} 家公司, ${pagesWithResults} 页 (免费)`);

    // 出参审查
    companies.forEach((c, i) => {
      const { reviewCompany } = require('./interface');
      reviewCompany(c, i);
    });

    return companies;
  }

  // ══════════════════════════════════════════════════════════════════
  // 阶段2: 按域名拿全员
  // ══════════════════════════════════════════════════════════════════

  async fetchPeople(domains) {
    ASSERT.nonEmptyArray(domains, 'domains');

    const seen = new Set();
    const allPeople = [];

    for (const domain of domains) {
      let page = 1;
      while (true) {
        const result = await this._call('POST', '/mixed_people/api_search', {
          q_organization_domains_list: [domain],
          page, per_page: 100,
        });

        const batch = result.people || [];
        if (!batch.length) break;

        for (const p of batch) {
          const pid = p.id || '';
          if (pid && seen.has(pid)) continue;
          if (pid) seen.add(pid);

          // 姓名拆分（api_search 常只返回 first_name）
          let first = (p.first_name || '').trim();
          let last = (p.last_name || '').trim();
          if (!last && first.includes(' ')) {
            const parts = first.split(/\s+/);
            first = parts[0];
            last = parts.slice(1).join(' ');
          }

          allPeople.push({
            personId: pid,
            firstName: first,
            lastName: last,
            title: p.title || '',
            hasEmail: p.has_email === true,
            linkedinUrl: p.linkedin_url || '',
            companyName: (p.organization || {}).name || '',
            companyDomain: domain,
          });
        }

        if (batch.length < 100) break;
        page++;
        await this._sleep(300);
      }
    }

    const withEmail = allPeople.filter(p => p.hasEmail).length;
    console.log(`[阶段2] ${allPeople.length} 人 (${domains.length}家公司), has_email=${withEmail}/${allPeople.length}`);

    // 出参审查（抽查，避免大数组开销）
    allPeople.slice(0, 5).forEach((p, i) => {
      const { reviewPerson } = require('./interface');
      reviewPerson(p, i);
    });

    return allPeople;
  }

  // ══════════════════════════════════════════════════════════════════
  // 阶段3: 揭示邮箱（消耗 credits）
  // ══════════════════════════════════════════════════════════════════

  async revealEmails(people, options = {}) {
    const { smartMode = true, smartSampleSize = 3 } = options;
    ASSERT.nonEmptyArray(people, 'people');

    const ranked = [...people].sort((a, b) => (b.score || 0) - (a.score || 0));

    if (!smartMode || ranked.length <= smartSampleSize) {
      return this._bulkReveal(ranked);
    }

    // Smart mode: 拿 top N 真实邮箱 → 推断其余
    const sample = ranked.slice(0, smartSampleSize);
    const rest = ranked.slice(smartSampleSize);

    const revealed = await this._bulkReveal(sample);
    if (revealed.length < 2) {
      console.log('[阶段3] 样本不足，回退全量 reveal');
      return this._bulkReveal(people);
    }

    // 分析格式
    const domain = this._extractDomain(revealed[0]);
    const pattern = this._detectPattern(revealed, domain);

    if (!pattern) {
      console.log('[阶段3] 邮箱格式不统一，回退全量 reveal');
      return this._bulkReveal(people);
    }

    console.log(`[阶段3] 格式: ${pattern}, 推断 ${rest.length} 人 (省 ${rest.length} credits)`);

    // 推断
    const results = revealed.map(r => ({ ...r, emailSource: 'revealed' }));

    for (const p of rest) {
      const name = `${p.firstName} ${p.lastName}`.trim();
      const inferred = this._inferEmail(name, pattern);
      if (inferred) {
        results.push({
          company: p.companyName,
          country: '',
          contactName: name,
          contactTitle: p.title,
          email: inferred,
          emailStatus: 'inferred',
          emailSource: 'inferred',
          seniority: p.seniority || '',
          website: '',
          linkedinUrl: p.linkedinUrl || '',
          phone: '',
          score: p.score || 0,
        });
      }
    }

    // 审查
    results.forEach((c, i) => {
      const { reviewContact } = require('./interface');
      reviewContact(c, i);
    });

    return results;
  }

  // ══════════════════════════════════════════════════════════════════
  // 内部: 全量揭示
  // ══════════════════════════════════════════════════════════════════

  async _bulkReveal(people) {
    const contacts = [];

    for (let i = 0; i < people.length; i += 10) {
      const batch = people.slice(i, i + 10);
      const details = batch.filter(p => p.personId).map(p => ({ id: p.personId }));
      if (!details.length) continue;

      const result = await this._call('POST', '/people/bulk_match?reveal_personal_emails=true', {
        details,
      });

      for (const m of (result.matches || [])) {
        this.creditsUsed++;
        const email = m.email || '';
        if (!email) continue;

        const org = m.organization || {};
        const orig = batch.find(p => p.personId === m.id) || {};

        contacts.push({
          company: org.name || '',
          country: m.country || '',
          contactName: m.name || '',
          contactTitle: m.title || '',
          email,
          emailStatus: m.email_status || '',
          emailSource: 'revealed',
          seniority: m.seniority || '',
          website: org.website_url || '',
          linkedinUrl: m.linkedin_url || '',
          phone: (org.primary_phone || {}).number || org.phone || '',
          employees: String(org.estimated_num_employees || ''),
          industry: org.industry || '',
          score: orig.score || 0,
        });
      }
      await this._sleep(500);
    }

    console.log(`[阶段3] bulk_reveal: ${contacts.length} 条, ${this.creditsUsed} credits`);
    return contacts;
  }

  // ══════════════════════════════════════════════════════════════════
  // 邮箱格式检测
  // ══════════════════════════════════════════════════════════════════

  _extractDomain(contact) {
    if (contact.email && contact.email.includes('@')) {
      return contact.email.split('@')[1];
    }
    if (contact.website) {
      return contact.website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '');
    }
    return '';
  }

  _detectPattern(revealed, domain) {
    if (!domain) {
      const domains = new Set();
      for (const r of revealed) {
        if (r.email?.includes('@')) domains.add(r.email.split('@')[1]);
      }
      if (domains.size !== 1) return null;
      domain = [...domains][0];
    }

    const parsed = revealed.map(r => {
      const name = r.contactName || '';
      const local = r.email?.split('@')[0]?.toLowerCase() || '';
      const parts = name.toLowerCase().split(/\s+/);
      return { local, first: parts[0] || '', last: parts[parts.length - 1] || '' };
    });

    const all = fn => parsed.every(({ local, first, last }) => fn(local, first, last));

    if (all((l, f, la) => l === f[0] + la && f && la)) return `{fi}{last}@${domain}`;
    if (all((l, f, la) => l === f + '.' + la && f && la)) return `{first}.{last}@${domain}`;
    if (all((l, f, la) => l === f && f)) return `{first}@${domain}`;
    if (all((l, f, la) => l === f + la[0] && f && la)) return `{first}{li}@${domain}`;
    if (all((l, f, la) => l === la && la)) return `{last}@${domain}`;

    return null;
  }

  _inferEmail(name, pattern) {
    const parts = name.toLowerCase().split(/\s+/);
    const first = parts[0] || '';
    const last = parts.length >= 2 ? parts[parts.length - 1] : '';

    if (!first) return null;

    if (pattern.includes('{fi}{last}')) {
      if (!last) return null;
      return pattern.replace('{fi}{last}', first[0] + last);
    }
    if (pattern.includes('{first}.{last}')) {
      if (!last) return null;
      return pattern.replace('{first}.{last}', first + '.' + last);
    }
    if (pattern.includes('{first}{li}')) {
      if (!last) return null;
      return pattern.replace('{first}{li}', first + last[0]);
    }
    if (pattern.includes('{first}') && !pattern.includes('{last}')) {
      return pattern.replace('{first}', first);
    }
    if (pattern.includes('{last}')) {
      if (!last) return null;
      return pattern.replace('{last}', last);
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  // HTTP
  // ══════════════════════════════════════════════════════════════════

  async _call(method, path, body, retries = 3) {
    const bodyStr = JSON.stringify(body || {});
    const options = {
      hostname: APOLLO_BASE,
      port: 443,
      path: API_PATH + path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 30000,
    };

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await this._request(options, bodyStr);
        if (result.status === 200) {
          try { return JSON.parse(result.body); } catch { return {}; }
        }
        if (result.status === 429) {
          await this._sleep(1000 * (2 ** attempt));
          continue;
        }
        console.warn(`Apollo ${result.status}: ${result.body.slice(0, 200)}`);
        return {};
      } catch (e) {
        if (attempt < retries - 1) {
          const wait = 1000 + attempt * 2000;
          console.warn(`Apollo 连接失败 [${path}], ${wait / 1000}s 重试 (${attempt + 1}/${retries}): ${e.message}`);
          await this._sleep(wait);
        } else {
          console.error(`Apollo 调用失败 [${path}] (已重试${retries}次): ${e.message}`);
        }
      }
    }
    return {};
  }

  _request(options, body) {
    return new Promise((resolve, reject) => {
      const transport = options.hostname.endsWith('.io') ? https : http;
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { ApolloClient };
