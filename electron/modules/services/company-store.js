// ── 公司级元数据存储 ─────────────────────────────────────────────────────────
// 管理 data/company-meta.json + data/companies.json
// 格式: { "公司名": { clientType: "agent", _manualType: false, dealStage: "" } }
// clientType 手动设置后 _manualType = true，contacts:list 不再自动重新分类
//
// companies.json — 公司索引（规范化名称 → UUID）
// { "index": { "uuid": { "name": "原始名", "normalized": "规范名", "createdAt": "..." } } }

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { APP_ROOT } = require('../config');

const META_PATH = path.join(APP_ROOT, 'data', 'company-meta.json');
const INDEX_PATH = path.join(APP_ROOT, 'data', 'companies.json');

// ── 公司名规范化 ─────────────────────────────────────────────────────────

/** 拉美公司后缀变体 → 标准化去除 */
// ponytail: 长模式在前，防止 S.A. 误匹配 S.A.S.
const SUFFIX_PATTERN = /\b(S\.?A\.? DE C\.?V\.?|S\.?R\.?L\.? DE C\.?V\.?|PTY\.? LTD\.?|SA DE CV|S\.?A\.?S\.?|S\.?C\.?S\.?|S\.?C\.?A\.?|S\.?A\.?|S\.?R\.?L\.?|S\.?L\.?U\.?|E\.?I\.?R\.?L\.?|LTDA\.?|LTD\.?|INC\.?|LLC|CORP\.?|GMBH|SCP|SPA)\b/gi;

/**
 * 规范化公司名：trim → lowercase → 去后缀 → 去标点 → 合并空格
 * @param {string} name - 原始公司名
 * @returns {string} 规范化名称
 */
function normalizeCompany(name) {
  if (!name || !name.trim()) return '';
  let n = name.trim().toLowerCase();
  n = n.replace(SUFFIX_PATTERN, '');
  // 去除残留的点、逗号、多余空格
  n = n.replace(/[.,]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return n;
}

/** 生成简短 UUID（前8位，适合 JSON key） */
function _shortId() {
  return crypto.randomUUID().slice(0, 8);
}

// ── 公司索引读写 ──────────────────────────────────────────────────────────

let _indexCache = null;

function _readIndex() {
  if (_indexCache) return _indexCache;
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
      _indexCache = raw.index || {};
    }
  } catch { /* 公司索引文件读取失败 → 返回空索引 */ }
  if (!_indexCache) _indexCache = {};
  return _indexCache;
}

function _writeIndex(index) {
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const wrapper = { index };
  fs.writeFileSync(INDEX_PATH, JSON.stringify(wrapper, null, 2));
  _indexCache = index;
}

/**
 * 按公司名解析 companyId（无则自动创建）
 * @param {string} name - 原始公司名
 * @returns {{ companyId: string, normalized: string, isNew: boolean }}
 */
function resolveCompanyId(name) {
  const normalized = normalizeCompany(name);
  if (!normalized) return { companyId: '', normalized: '', isNew: false };

  const index = _readIndex();
  // 查找已存在的规范化名称
  for (const [id, info] of Object.entries(index)) {
    if (info.normalized === normalized) {
      return { companyId: id, normalized, isNew: false };
    }
  }

  // 新建
  const companyId = _shortId();
  index[companyId] = { name: name.trim(), normalized, createdAt: new Date().toISOString() };
  _writeIndex(index);
  return { companyId, normalized, isNew: true };
}

/**
 * 批量建索引（迁移用）：扫描 contacts，给所有公司分配 companyId
 * @param {Array<{company: string}>} contacts
 * @returns {Map<string, string>} companyName → companyId 映射
 */
function buildIndexFromContacts(contacts) {
  const index = _readIndex();
  const nameToId = new Map();
  let changed = false;

  for (const c of contacts) {
    if (!c.company || !c.company.trim()) continue;
    const name = c.company.trim();
    if (nameToId.has(name.toLowerCase())) continue;

    const normalized = normalizeCompany(name);
    // 查索引
    let found = null;
    for (const [id, info] of Object.entries(index)) {
      if (info.normalized === normalized) { found = id; break; }
    }
    if (found) {
      nameToId.set(name.toLowerCase(), found);
    } else {
      const companyId = _shortId();
      index[companyId] = { name, normalized, createdAt: new Date().toISOString() };
      nameToId.set(name.toLowerCase(), companyId);
      changed = true;
    }
  }
  if (changed) _writeIndex(index);
  return nameToId;
}

/**
 * 获取公司索引信息
 * @param {string} companyId
 * @returns {{ name: string, normalized: string }|null}
 */
function getCompanyById(companyId) {
  const index = _readIndex();
  return index[companyId] || null;
}

/** 读取全部元数据 */
function _read() {
  try {
    if (fs.existsSync(META_PATH)) {
      return JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
    }
  } catch { /* 公司索引文件读取失败 → 返回空索引 */ }
  return {};
}

/** 写入全部元数据 */
function _write(meta) {
  const dir = path.dirname(META_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

/**
 * 获取指定公司的元数据
 * @param {string} company - 公司名
 * @returns {{ clientType: string, _manualType: boolean, dealStage: string }}
 */
function getCompanyMeta(company) {
  const meta = _read();
  return meta[company] || { clientType: 'unlabeled', _manualType: false, dealStage: '' };
}

/**
 * 手动设置公司客户类型（标记 _manualType = true，后续不再自动分类）
 * @param {string} company - 公司名
 * @param {string} type - "agent" | "direct" | "unlabeled"
 */
function setCompanyType(company, type) {
  const meta = _read();
  const existing = meta[company] || {};
  meta[company] = { ...existing, clientType: type, _manualType: true };
  _write(meta);
}

/** 返回全部元数据 */
function getAllMeta() {
  return _read();
}

/**
 * 级联清理：删除公司时调用
 * @param {string} company - 公司名
 */
function deleteCompanyMeta(company) {
  const meta = _read();
  delete meta[company];
  _write(meta);
}

module.exports = {
  getCompanyMeta, setCompanyType, getAllMeta, deleteCompanyMeta,
  normalizeCompany, resolveCompanyId, buildIndexFromContacts, getCompanyById,
};
