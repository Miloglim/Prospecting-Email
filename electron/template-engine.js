// ── 模板引擎：解析 general-templates.md → 结构化 JS 对象 ──────────────
const fs = require('fs');
const path = require('path');

function parseTemplateLibrary() {
  const mdPath = path.join(__dirname, '..', 'templates', 'general-templates.md');
  if (!fs.existsSync(mdPath)) {
    console.error('模板文件未找到:', mdPath);
    return null;
  }

  const text = fs.readFileSync(mdPath, 'utf-8');

  const lib = {
    hooks: parseTableByPrefix(text, 'H-'),
    painPoints: {
      agent: parseTableByPrefix(text, 'PA-'),
      direct: parseTableByPrefix(text, 'PD-'),
      unlabeled: parseTableByPrefix(text, 'PU-'),
    },
    proofs: {
      agent: parseTableByPrefix(text, 'RA-'),
      direct: parseTableByPrefix(text, 'RD-'),
      unlabeled: parseTableByPrefix(text, 'RU-'),
    },
    ctas: parseCTAs(text),
    followUps: {
      f1: parseTableByPrefix(text, 'F1-'),
      f2: parseTableByPrefix(text, 'F2-'),
      f3: parseTableByPrefix(text, 'F3-'),
      f4: parseTableByPrefix(text, 'F4-'),
    },
    subjects: parseSubjects(text),
    spamWords: parseSpamWords(text),
  };

  const total =
    lib.hooks.length +
    lib.painPoints.agent.length + lib.painPoints.direct.length + lib.painPoints.unlabeled.length +
    lib.proofs.agent.length + lib.proofs.direct.length + lib.proofs.unlabeled.length +
    lib.ctas.length +
    lib.followUps.f1.length + lib.followUps.f2.length + lib.followUps.f3.length + lib.followUps.f4.length;

  console.log(`模板库加载完成: ${total} 条句库, ${Object.keys(lib.subjects).length} 套主题行`);
  return lib;
}

// ── 工具函数：按编号前缀解析表格行 ────────────────────────────────────
function parseTableByPrefix(text, prefix) {
  const results = [];
  const regex = new RegExp(
    `\\|\\s*${prefix}(\\d+)\\s*\\|\\s*(.+?)\\s*\\|\\s*(.+?)\\s*\\|`,
    'g'
  );

  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({
      id: `${prefix}${match[1]}`,
      es: match[2].trim(),
      en: match[3].trim(),
    });
  }
  return results;
}

// ── CTA 特殊解析（多一列"类型"）───────────────────────────────────────
function parseCTAs(text) {
  const results = [];
  const regex = /\|\s*(.+?)\s*\|\s*(C-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    // 跳过表头行
    if (match[1].includes('类型') || match[1].includes(':-')) continue;
    results.push({
      type: match[1].trim(),
      id: match[2].trim(),
      es: match[3].trim(),
      en: match[4].trim(),
    });
  }
  return results;
}

// ── 解析主题行 ────────────────────────────────────────────────────────
function parseSubjects(text) {
  const subjects = { agent: {}, direct: {}, unlabeled: {} };

  // 代理主题行
  const agentMatch = text.match(/### 3\.1 代理[\s\S]*?🇲🇽 西语 \|\s*(.+?)\s*\|[\s\S]*?🇬🇧 英语 \|\s*(.+?)\s*\|/);
  if (agentMatch) {
    subjects.agent = { es: agentMatch[1].trim(), en: agentMatch[2].trim() };
  }

  // 直客主题行
  const directMatch = text.match(/### 3\.2 直客[\s\S]*?🇲🇽 西语 \|\s*(.+?)\s*\|[\s\S]*?🇬🇧 英语 \|\s*(.+?)\s*\|/);
  if (directMatch) {
    subjects.direct = { es: directMatch[1].trim(), en: directMatch[2].trim() };
  }

  // 未标签主题行
  const unlabeledMatch = text.match(/### 3\.3 未标签[\s\S]*?🇲🇽 西语 \|\s*(.+?)\s*\|[\s\S]*?🇬🇧 英语 \|\s*(.+?)\s*\|/);
  if (unlabeledMatch) {
    subjects.unlabeled = { es: unlabeledMatch[1].trim(), en: unlabeledMatch[2].trim() };
  }

  return subjects;
}

// ── 解析垃圾词黑名单 ──────────────────────────────────────────────────
function parseSpamWords(text) {
  const banned = {
    es: [],
    en: [],
  };

  // 从 2.1 硬禁止表格中提取
  const tableRegex = /\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|/g;
  let match;
  let inBannedTable = false;

  // 更简单的方式：直接匹配已知垃圾词
  const esBanned = [
    'más grande', 'el mejor', 'número uno', 'insuperable', 'único',
    'incomparable', 'excepcional', 'extraordinario', 'urgente', 'actúa ahora',
    'no esperes', 'última oportunidad', 'tiempo limitado', 'date prisa',
    'corre', 'garantizado', '100% seguro', 'sin riesgo', 'resultados asegurados',
    'cero preocupaciones', 'oferta especial', 'descuento exclusivo', 'precio increíble',
    'ganga', 'barato', 'rebaja', 'promoción', 'top 5', 'top 10', 'los primeros',
    'entre los mejores', 'clasificado', 'rankeado', 'millones de dólares',
    'fortunas', 'miles de millones', 'enriquecer', 'gratis', 'competitivo', 'eficiente',
  ];

  const enBanned = [
    'best', 'largest', '#1', 'number one', 'unmatched', 'unbeatable',
    'exceptional', 'extraordinary', 'urgent', 'act now', "don't wait",
    'last chance', 'limited time', 'hurry', 'run', 'guaranteed', '100%',
    'risk-free', 'results guaranteed', 'zero worries', 'special offer',
    'exclusive discount', 'amazing price', 'deal', 'cheap', 'sale',
    'promotion', 'top 5', 'top 10', 'ranked', 'rated #', 'leading the pack',
    'millions of dollars', 'fortune', 'billions', 'get rich', 'free',
    'competitive', 'efficient',
  ];

  return { es: esBanned, en: enBanned };
}

module.exports = { parseTemplateLibrary };
