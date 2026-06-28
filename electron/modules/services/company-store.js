// ── 公司级元数据存储 ─────────────────────────────────────────────────────────
// 管理 data/company-meta.json
// 格式: { "公司名": { clientType: "agent", _manualType: false, dealStage: "" } }
// clientType 手动设置后 _manualType = true，contacts:list 不再自动重新分类

const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('../config');

const META_PATH = path.join(APP_ROOT, 'data', 'company-meta.json');

/** 读取全部元数据 */
function _read() {
  try {
    if (fs.existsSync(META_PATH)) {
      return JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
    }
  } catch {}
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

module.exports = { getCompanyMeta, setCompanyType, getAllMeta, deleteCompanyMeta };
