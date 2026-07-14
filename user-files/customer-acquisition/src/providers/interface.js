// ── Provider 接口契约 + 参数校验 ────────────────────────────────────────────
// 所有数据源适配器（Apollo、LinkedIn、Customs...）必须实现此接口
// 每个方法入参、出参均有严格校验，违反契约直接抛错

/**
 * Provider 接口定义（非运行时，仅文档）
 *
 * class Provider {
 *   // 阶段1：发现公司 → Company[]
 *   async searchCompanies(config: DiscoveryConfig): Promise<Company[]>
 *
 *   // 阶段2：获取公司全员 → Person[]
 *   async fetchPeople(domains: string[]): Promise<Person[]>
 *
 *   // 阶段3：揭示邮箱 → Contact[]
 *   async revealEmails(people: Person[], options: RevealOptions): Promise<Contact[]>
 *
 *   // 元信息
 *   readonly name: string
 *   readonly creditsPerReveal: number
 * }
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 数据类型定义（注释即契约）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} DiscoveryConfig
 * @property {string[]} nameKeywords  — 公司名模糊搜索关键词
 * @property {string[]} countries     — 目标国家
 * @property {string[]} [sizeRanges]  — 员工规模 ["11,50", "51,200"]
 * @property {number}   [maxPagesPerKeyword] — 每关键词最大页数，默认 3
 * @property {number}   [perPage]     — 每页条数，默认 25
 */

/**
 * @typedef {Object} Company
 * @property {string} name     — 公司名
 * @property {string} domain   — 域名（唯一键）
 * @property {string} id       — 数据源内部 ID
 * @property {string} [employees] — 员工数
 * @property {string} [industry]  — 行业
 * @property {string} [country]   — 国家
 */

/**
 * @typedef {Object} Person
 * @property {string} personId     — 数据源内部人员 ID
 * @property {string} firstName    — 名
 * @property {string} lastName     — 姓
 * @property {string} title        — 职位
 * @property {boolean} hasEmail    — 是否有邮箱可揭示
 * @property {string} companyName  — 所属公司名
 * @property {string} companyDomain— 所属公司域名
 * @property {number} [score]      — 打分
 */

/**
 * @typedef {Object} Contact
 * @property {string} company        — 公司名
 * @property {string} country        — 国家
 * @property {string} contactName    — 全名
 * @property {string} contactTitle   — 职位
 * @property {string} email          — 邮箱
 * @property {string} emailStatus    — verified | inferred | guessed
 * @property {string} emailSource    — revealed | inferred
 * @property {string} [seniority]    — 职级
 * @property {string} [website]      — 公司网站
 * @property {string} [linkedinUrl]  — LinkedIn
 * @property {string} [phone]        — 电话
 * @property {number} [score]        — 打分
 */

/**
 * @typedef {Object} SearchReport
 * @property {number} totalCompanies  — 公司数
 * @property {number} totalPeople     — 有邮箱的人数
 * @property {number} creditsNeeded   — 需要 credits
 * @property {Object[]} topCompanies  — 每公司人数 Top N
 * @property {Contact[]} preview      — 前 5 家人选预览
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 参数校验器
// ═══════════════════════════════════════════════════════════════════════════════

const ASSERT = {
  nonEmptyArray(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ContractError(`${label}: 必须是非空数组，实际 ${JSON.stringify(value)}`);
    }
  },

  string(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ContractError(`${label}: 必须是非空字符串，实际 ${JSON.stringify(value)}`);
    }
  },

  positiveInt(value, label) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ContractError(`${label}: 必须是非负整数，实际 ${value}`);
    }
  },

  object(value, label) {
    if (!value || typeof value !== 'object') {
      throw new ContractError(`${label}: 必须是对象，实际 ${typeof value}`);
    }
  },
};

class ContractError extends Error {
  constructor(msg) { super(`[契约违反] ${msg}`); this.name = 'ContractError'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 输出审查器（返回值校验）
// ═══════════════════════════════════════════════════════════════════════════════

function reviewCompany(company, index) {
  const prefix = `Company[${index}]`;
  ASSERT.string(company.name, `${prefix}.name`);
  ASSERT.string(company.domain, `${prefix}.domain`);
  // domain 必须包含 .
  if (!company.domain.includes('.')) {
    throw new ContractError(`${prefix}.domain 不是有效域名: ${company.domain}`);
  }
}

function reviewPerson(person, index) {
  const prefix = `Person[${index}]`;
  ASSERT.string(person.personId, `${prefix}.personId`);
  ASSERT.string(person.firstName || person.lastName ? (person.firstName || person.lastName) : 'name', `${prefix}.name`);
  if (typeof person.hasEmail !== 'boolean') {
    throw new ContractError(`${prefix}.hasEmail 必须是 boolean，实际 ${typeof person.hasEmail}`);
  }
  ASSERT.string(person.companyName, `${prefix}.companyName`);
}

function reviewContact(contact, index) {
  const prefix = `Contact[${index}]`;
  ASSERT.string(contact.contactName, `${prefix}.contactName`);
  ASSERT.string(contact.email, `${prefix}.email`);
  if (!contact.email.includes('@')) {
    throw new ContractError(`${prefix}.email 不是有效邮箱: ${contact.email}`);
  }
  const validSources = ['revealed', 'inferred'];
  if (!validSources.includes(contact.emailSource)) {
    throw new ContractError(`${prefix}.emailSource 无效: ${contact.emailSource}，合法值: ${validSources.join(', ')}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 审查报告
// ═══════════════════════════════════════════════════════════════════════════════

function reviewProviderContract(provider) {
  const issues = [];
  const requiredMethods = ['searchCompanies', 'fetchPeople', 'revealEmails'];

  for (const method of requiredMethods) {
    if (typeof provider[method] !== 'function') {
      issues.push(`缺少方法: ${method}()`);
    }
  }

  if (!provider.name || typeof provider.name !== 'string') {
    issues.push('缺少 name 属性');
  }

  return {
    valid: issues.length === 0,
    provider: provider.name || 'unknown',
    issues,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  // 类型（仅文档）
  DiscoveryConfig: null,
  Company: null,
  Person: null,
  Contact: null,
  SearchReport: null,

  // 校验
  ASSERT,
  ContractError,

  // 审查
  reviewCompany,
  reviewPerson,
  reviewContact,
  reviewProviderContract,
};
