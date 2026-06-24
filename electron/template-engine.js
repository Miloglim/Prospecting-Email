// ── 模板引擎：解析 general-templates.md → 结构化 JS 对象 ──────────────
const fs = require('fs');
const path = require('path');

function parseTemplateLibrary() {
  const mdPath = path.join(__dirname, '..', 'templates', 'general-templates.md');
  if (!fs.existsSync(mdPath)) {
    console.error('模板文件未找到:', mdPath);
    return null;
  }

  let text;
  try {
    text = fs.readFileSync(mdPath, 'utf-8');
  } catch (e) {
    console.error('模板文件读取失败:', mdPath, e.message);
    return null;
  }

  // 通用 Hook（排除阿根廷变体 H-A*）
  const allHooks = parseTableByPrefix(text, 'H-');
  const hooks = allHooks.filter(h => !h.id.startsWith('H-A'));
  const hooksAR = allHooks.filter(h => h.id.startsWith('H-A'));

  // CTA（排除阿根廷变体 C-A*）
  const allCtas = parseCTAs(text);
  const ctas = allCtas.filter(c => !c.id.startsWith('C-A'));
  const ctasAR = allCtas.filter(c => c.id.startsWith('C-A'));

  const lib = {
    hooks,
    hooksAR,                        // 🇦🇷 阿根廷 Hook 变体
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
    ctas,
    ctasAR,                         // 🇦🇷 阿根廷 CTA 变体
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
    lib.hooks.length + (lib.hooksAR?.length || 0) +
    lib.painPoints.agent.length + lib.painPoints.direct.length + lib.painPoints.unlabeled.length +
    lib.proofs.agent.length + lib.proofs.direct.length + lib.proofs.unlabeled.length +
    lib.ctas.length + (lib.ctasAR?.length || 0) +
    lib.followUps.f1.length + lib.followUps.f2.length + lib.followUps.f3.length + lib.followUps.f4.length;

  // 注入中文标签
  applyLabels(lib);

  console.log(`模板库加载完成: ${total} 条句库 (含 ${lib.hooksAR?.length||0} 阿根廷Hook + ${lib.ctasAR?.length||0} 阿根廷CTA), ${Object.keys(lib.subjects).length} 套主题行`);
  return lib;
}

// ── 中文标签映射：代号 → 可读中文 ──────────────────────────────────
const LABEL_MAP = {
  // Hook
  'H-1': '破冰 · 一周顺利', 'H-2': '破冰 · 运营顺畅', 'H-3': '破冰 · 一切顺利',
  'H-4': '破冰 · 关注市场', 'H-5': '破冰 · 路线动态', 'H-6': '破冰 · 分享信息',
  'H-A1':'破冰🇦🇷 · 一周愉快','H-A2':'破冰🇦🇷 · 运营顺利','H-A3':'破冰🇦🇷 · 关注市场',
  'H-A4':'破冰🇦🇷 · 路线动态','H-A5':'破冰🇦🇷 · 分享信息',
  // Pain — Agent
  'PA-1':'代理痛点 · 旺季舱位','PA-2':'代理痛点 · 运价波动','PA-3':'代理痛点 · 失去竞争力',
  'PA-4':'代理痛点 · 紧急出货','PA-5':'代理痛点 · 船司依赖',
  // Pain — Direct
  'PD-1':'直客痛点 · 清关延误','PD-2':'直客痛点 · 海关成本','PD-3':'直客痛点 · 进口不确定',
  'PD-4':'直客痛点 · 单一渠道','PD-5':'直客痛点 · 货物滞留',
  // Pain — Unlabeled
  'PU-1':'通用痛点 · 物流效率','PU-2':'通用痛点 · 运输意外','PU-3':'通用痛点 · 供应链优化',
  'PU-4':'通用痛点 · 物流支撑',
  // Proof — Agent
  'RA-1':'代理证明 · 资质资源','RA-2':'代理证明 · 全球网络','RA-3':'代理证明 · 拉美航线',
  'RA-4':'代理证明 · 弹性替代',
  // Proof — Direct
  'RD-1':'直客证明 · 本地能力','RD-2':'直客证明 · 港口覆盖','RD-3':'直客证明 · 自主清关',
  'RD-4':'直客证明 · 规模背书',
  // Proof — Unlabeled
  'RU-1':'通用证明 · 资质覆盖','RU-2':'通用证明 · 资源优势','RU-3':'通用证明 · 拉美航线',
  'RU-4':'通用证明 · 灵活适配',
  // CTA
  'C-1':'CTA · 发资料','C-2':'CTA · 轻聊','C-3':'CTA · 分享洞察','C-4':'CTA · 留门',
  'C-A1':'CTA🇦🇷 · 发资料','C-A2':'CTA🇦🇷 · 轻聊','C-A3':'CTA🇦🇷 · 分享洞察','C-A4':'CTA🇦🇷 · 留门',
  // Follow-up F1
  'F1-1':'跟进1 · 新角度','F1-2':'跟进1 · 新思路','F1-3':'跟进1 · 换个视角',
  // Follow-up F2
  'F2-1':'跟进2 · 市场变化','F2-2':'跟进2 · 环境波动','F2-3':'跟进2 · 行业格局',
  // Follow-up F3
  'F3-1':'跟进3 · 时差留门','F3-2':'跟进3 · 无压提醒','F3-3':'跟进3 · 不打扰',
  // Follow-up F4
  'F4-1':'跟进4 · 最后联系','F4-2':'跟进4 · 不越界','F4-3':'跟进4 · 转为观察',
};

function applyLabels(lib) {
  const apply = (arr) => { if (arr) arr.forEach(item => { item.label = LABEL_MAP[item.id] || item.id; }); };
  apply(lib.hooks);
  apply(lib.hooksAR);
  apply(lib.painPoints?.agent);
  apply(lib.painPoints?.direct);
  apply(lib.painPoints?.unlabeled);
  apply(lib.proofs?.agent);
  apply(lib.proofs?.direct);
  apply(lib.proofs?.unlabeled);
  apply(lib.ctas);
  apply(lib.ctasAR);
  apply(lib.followUps?.f1);
  apply(lib.followUps?.f2);
  apply(lib.followUps?.f3);
  apply(lib.followUps?.f4);
}

// ── 应用用户覆盖层到基础库（subjects + AR变体）────────────────────
// 注意：_stages 覆盖由渲染进程 initTemplateEditor 负责，不在此处处理
function applyOverrides(lib, overrides) {
  if (!overrides) return lib;

  // 合并主题行
  if (overrides.subjects) {
    for (const type of Object.keys(overrides.subjects)) {
      if (lib.subjects[type]) {
        Object.assign(lib.subjects[type], overrides.subjects[type]);
      }
    }
  }

  // 合并 🇦🇷 阿根廷变体（按 ID 匹配逐句覆盖）
  for (const arKey of ['hooksAR', 'ctasAR']) {
    if (!overrides[arKey] || !overrides[arKey].length) continue;
    if (!lib[arKey]) lib[arKey] = [];
    const dstById = {};
    lib[arKey].forEach(item => { dstById[item.id] = item; });
    for (const srcItem of overrides[arKey]) {
      if (dstById[srcItem.id]) {
        dstById[srcItem.id].es = srcItem.es;
        dstById[srcItem.id].pt = srcItem.pt;
        dstById[srcItem.id].en = srcItem.en;
        if (srcItem.type) dstById[srcItem.id].type = srcItem.type;
      }
    }
  }

  return lib;
}

// ── 将 _stages 覆盖层应用到已完整初始化的 _stages（按 ID 逐句覆盖）─
// 调用时机：initTemplateEditor 创建完整 _stages 之后
function applyStageOverrides(stages, overridesStages) {
  if (!overridesStages) return stages;
  for (const type of Object.keys(overridesStages)) {
    if (!stages[type]) stages[type] = {};
    for (const stage of Object.keys(overridesStages[type])) {
      const src = overridesStages[type][stage];
      const dst = stages[type][stage];
      if (!dst) { stages[type][stage] = src; continue; }
      for (const key of ['hooks','pains','proofs','ctas','followups']) {
        if (!src[key]) continue;
        const dstById = {};
        (dst[key] || []).forEach(item => { dstById[item.id] = item; });
        for (const srcItem of src[key]) {
          if (dstById[srcItem.id]) {
            dstById[srcItem.id].es = srcItem.es;
            dstById[srcItem.id].pt = srcItem.pt;
            dstById[srcItem.id].en = srcItem.en;
          }
        }
      }
    }
  }
  return stages;
}

// ── 工具函数：按编号前缀解析表格行（支持 ES/PT/EN 三语）──────────────
function parseTableByPrefix(text, prefix) {
  const results = [];
  // 匹配 4 列表格：编号 | 西语 | 葡语 | 英语（编号支持 H-1, H-A1, PA-1 等）
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

module.exports = { parseTemplateLibrary, applyOverrides, applyStageOverrides };
