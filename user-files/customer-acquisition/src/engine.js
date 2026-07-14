// ── 客户开发引擎（通用调度层）──────────────────────────────────────────────
// 不碰数据源细节，负责流程编排: 搜索 → 获取 → 打分 → 报告 → 揭示

const path = require('path');
const fs = require('fs');
const { scoreAndRank } = require('./scoring');
const { reviewProviderContract } = require('./providers/interface');

class CustomerAcquisitionEngine {
  constructor(provider) {
    const review = reviewProviderContract(provider);
    if (!review.valid) {
      throw new Error(`Provider 契约审查未通过: ${review.issues.join(', ')}`);
    }
    this.provider = provider;
  }

  static loadProfile(profileId, profilesDir) {
    const filePath = path.join(profilesDir, `${profileId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`搜索画像不存在: ${filePath}`);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const { companyDiscovery, contactFilter } = raw;
    if (!companyDiscovery?.nameKeywords?.length) throw new Error(`画像 ${profileId} 缺少 nameKeywords`);
    if (!companyDiscovery?.countries?.length) throw new Error(`画像 ${profileId} 缺少 countries`);
    return raw;
  }

  static listProfiles(profilesDir) {
    if (!fs.existsSync(profilesDir)) return [];
    return fs.readdirSync(profilesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const raw = JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf-8'));
        return { profileId: raw.profileId || f.replace('.json',''), label: raw.label || '', countries: raw.companyDiscovery?.countries || [] };
      });
  }

  async searchPhase(profile) {
    const { companyDiscovery, contactFilter } = profile;
    console.log('[Engine] 阶段1: 搜公司...');
    const companies = await this.provider.searchCompanies(companyDiscovery);
    if (!companies.length) return { companies: [], people: [], report: this._emptyReport() };

    const domains = companies.map(c => c.domain);
    console.log(`[Engine] 阶段2: 获取 ${domains.length} 家公司全员...`);
    const allPeople = await this.provider.fetchPeople(domains);

    const withEmail = allPeople.filter(p => p.hasEmail);
    const ranked = scoreAndRank(withEmail, contactFilter.titleScoring || {}, contactFilter.perCompanyLimit || 0);
    const report = this._buildReport(companies, ranked);
    return { companies, people: ranked, report, rawPeople: allPeople };
  }

  async revealPhase(people, profile, maxCredits) {
    const { emailReveal = {} } = profile;
    const candidates = people.slice(0, maxCredits);
    console.log(`[Engine] 阶段3: 揭示 ${candidates.length} 人 (<=${maxCredits}c)`);
    return this.provider.revealEmails(candidates, {
      smartMode: emailReveal.smartMode !== false,
      smartSampleSize: emailReveal.smartSampleSize || 3,
    });
  }

  _buildReport(companies, people) {
    const map = new Map();
    for (const p of people) map.set(p.companyName, (map.get(p.companyName)||0)+1);
    const top = [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([n,c])=>({name:n,count:c}));
    const preview = {};
    for (const p of people.slice(0,25)) {
      if (!preview[p.companyName]) preview[p.companyName] = [];
      if (preview[p.companyName].length < 3) preview[p.companyName].push({name:`${p.firstName} ${p.lastName}`.trim(),title:p.title,score:p.score});
    }
    const prev = Object.entries(preview).slice(0,5).map(([c,m])=>({company:c,members:m}));
    return { totalCompanies: companies.length, companiesWithPeople: map.size, totalPeople: people.length, creditsNeeded: Math.min(people.length, 999), topCompanies: top, preview: prev, source: this.provider.name };
  }

  _emptyReport() {
    return { totalCompanies:0, companiesWithPeople:0, totalPeople:0, creditsNeeded:0, topCompanies:[], preview:[], source:this.provider.name };
  }
}

module.exports = { CustomerAcquisitionEngine };
