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

// ── 工具函数：按编号前缀解析表格行（支持 ES/PT/EN 三语）──────────────
function parseTableByPrefix(text, prefix) {
  const results = [];
  // 匹配 4 列表格：编号 | 西语 | 葡语 | 英语（编号支持 H-1, H-A1, PA-1, PA-A1 等）
  const pattern = prefix.replace('-', '\\-');
  const regex4 = new RegExp(
    `\\|\\s*${pattern}([A-Z]?\\d+)\\s*\\|\\s*(.+?)\\s*\\|\\s*(.+?)\\s*\\|\\s*(.+?)\\s*\\|`,
    'g'
  );
  let match;
  while ((match = regex4.exec(text)) !== null) {
    results.push({
      id: `${prefix}${match[1]}`,
      es: match[2].trim(),
      pt: match[3].trim(),
      en: match[4].trim(),
    });
  }
  if (results.length > 0) return results;
  // 回退：匹配旧 3 列表格：编号 | 西语 | 英语
  const regex3 = new RegExp(
    `\\|\\s*${pattern}([A-Z]?\\d+)\\s*\\|\\s*(.+?)\\s*\\|\\s*(.+?)\\s*\\|`,
    'g'
  );
  while ((match = regex3.exec(text)) !== null) {
    results.push({
      id: `${prefix}${match[1]}`,
      es: match[2].trim(),
      pt: '',
      en: match[3].trim(),
    });
  }
  return results;
}

// ── CTA 特殊解析（类型 | 编号 | 西语 | 葡语 | 英语）─ 支持 C-A1 等 ────
function parseCTAs(text) {
  const results = [];
  // 5 列格式（含葡语）
  const regex5 = /\|\s*(.+?)\s*\|\s*(C-[A-Z]?\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/g;
  let match;
  while ((match = regex5.exec(text)) !== null) {
    if (match[1].includes('类型') || match[1].includes(':-')) continue;
    results.push({ type: match[1].trim(), id: match[2].trim(), es: match[3].trim(), pt: match[4].trim(), en: match[5].trim() });
  }
  if (results.length > 0) return results;
  // 回退 4 列
  const regex4 = /\|\s*(.+?)\s*\|\s*(C-[A-Z]?\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/g;
  while ((match = regex4.exec(text)) !== null) {
    if (match[1].includes('类型') || match[1].includes(':-')) continue;
    results.push({ type: match[1].trim(), id: match[2].trim(), es: match[3].trim(), pt: '', en: match[4].trim() });
  }
  return results;
}

// ── 解析主题行（三语：西语 | 葡语 | 英语）─────────────────────────────
function parseSubjects(text) {
  const subjects = { agent: {}, direct: {}, unlabeled: {} };
  const sections = [
    { key: 'agent', re: /### 3\.1 代理/ },
    { key: 'direct', re: /### 3\.2 直客/ },
    { key: 'unlabeled', re: /### 3\.3 未标签/ },
  ];
  for (const { key, re } of sections) {
    const start = text.search(re);
    if (start < 0) continue;
    const chunk = text.slice(start, start + 800);
    // 提取三语主题行
    const esM = chunk.match(/西语\s*\|\s*(.+?)\s*\|/);
    const ptM = chunk.match(/葡语\s*\|\s*(.+?)\s*\|/);
    const enM = chunk.match(/英语\s*\|\s*(.+?)\s*\|/);
    subjects[key] = {
      es: esM ? esM[1].trim() : '',
      pt: ptM ? ptM[1].trim() : '',
      en: enM ? enM[1].trim() : '',
    };
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
