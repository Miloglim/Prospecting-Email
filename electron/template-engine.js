// ── 模板引擎：解析 general-templates.md → 结构化 JS 对象 ──────────────
const fs = require('fs');
const path = require('path');
const { Log } = require('./modules/core/logger');

function parseTemplateLibrary() {
  const mdPath = path.join(__dirname, '..', 'templates', 'general-templates.md');
  if (!fs.existsSync(mdPath)) {
    Log.error('模板', '模板文件未找到: ' + mdPath);
    return null;
  }

  let text;
  try {
    text = fs.readFileSync(mdPath, 'utf-8');
  } catch (e) {
    console.error('模板文件读取失败:', mdPath, e.message);
    return null;
  }

  // Hook：优先按类型拆分（HA-/HD-/HU-），无则共用 H-
  const hooksAgent = parseTableByPrefix(text, 'HA-');
  const hooksDirect = parseTableByPrefix(text, 'HD-');
  const hooksUnlabeled = parseTableByPrefix(text, 'HU-');
  const hooks = hooksAgent.length
    ? { agent: hooksAgent, direct: hooksDirect.length ? hooksDirect : [...hooksAgent], unlabeled: hooksUnlabeled.length ? hooksUnlabeled : [...hooksAgent] }
    : parseTableByPrefix(text, 'H-');

  // CTA：同上（CA-/CD-/CU-）
  const ctasShared = parseCTAs(text);
  const ctasAgent = parseTableByPrefix(text, 'CA-');
  const ctasDirect = parseTableByPrefix(text, 'CD-');
  const ctasUnlabeled = parseTableByPrefix(text, 'CU-');
  const ctas = ctasAgent.length
    ? { agent: ctasAgent, direct: ctasDirect.length ? ctasDirect : [...ctasAgent], unlabeled: ctasUnlabeled.length ? ctasUnlabeled : [...ctasAgent] }
    : ctasShared;

  const lib = {
    hooks,
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
    followUps: {
      f1: parseTableByPrefix(text, 'F1-'),
      f2: parseTableByPrefix(text, 'F2-'),
      f3: parseTableByPrefix(text, 'F3-'),
      f4: parseTableByPrefix(text, 'F4-'),
    },
    subjects: parseSubjects(text),
    spamWords: parseSpamWords(text),
  };

  const countArr = (v) => Array.isArray(v) ? v.length : Object.values(v).reduce((s, a) => s + a.length, 0);
  const total =
    countArr(lib.hooks) +
    countArr(lib.painPoints.agent) + countArr(lib.painPoints.direct) + countArr(lib.painPoints.unlabeled) +
    countArr(lib.proofs.agent) + countArr(lib.proofs.direct) + countArr(lib.proofs.unlabeled) +
    countArr(lib.ctas) +
    countArr(lib.followUps.f1) + countArr(lib.followUps.f2) + countArr(lib.followUps.f3) + countArr(lib.followUps.f4);

  applyLabels(lib);

  Log.info('模板', `模板库加载完成: ${total} 条句库, ${Object.keys(lib.subjects).length} 套主题行`);
  return lib;
}

// ── 中文标签映射：代号 → 可读中文 ──────────────────────────────────
const LABEL_MAP = {
  // Hook — Agent
  'HA-1':'代理破冰 · 货运顺利','HA-2':'代理破冰 · 航线动态','HA-3':'代理破冰 · 舱位现状',
  'HA-4':'代理破冰 · 运价波动','HA-5':'代理破冰 · 舱位紧张','HA-6':'代理破冰 · 资源介绍',
  'HA-7':'代理破冰 · 船司替代','HA-8':'代理破冰 · 随意问候',
  // Hook — Direct
  'HD-1':'直客破冰 · 进口顺利','HD-2':'直客破冰 · 进口复杂','HD-3':'直客破冰 · 备选方案',
  'HD-4':'直客破冰 · 海关延误','HD-5':'直客破冰 · 无忧进口','HD-6':'直客破冰 · 敏捷清关',
  'HD-7':'直客破冰 · 法规变化','HD-8':'直客破冰 · 清关备份',
  // Hook — Unlabeled
  'HU-1':'通用破冰 · 一切顺利','HU-2':'通用破冰 · 市场回顾','HU-3':'通用破冰 · 贸易动态',
  'HU-4':'通用破冰 · 分享价值','HU-5':'通用破冰 · 自我介绍','HU-6':'通用破冰 · 物流挑战',
  'HU-7':'通用破冰 · 优化空间','HU-8':'通用破冰 · 物流差异',
  // Pain — Agent
  'PA-1':'代理痛点 · 旺季舱位','PA-2':'代理痛点 · 运价波动','PA-3':'代理痛点 · 竞争劣势',
  'PA-4':'代理痛点 · 紧急出货','PA-5':'代理痛点 · 船司依赖','PA-6':'代理痛点 · 现货运价',
  'PA-7':'代理痛点 · 关系紧张','PA-8':'代理痛点 · 选项有限',
  // Pain — Direct
  'PD-1':'直客痛点 · 清关延误','PD-2':'直客痛点 · 海关成本','PD-3':'直客痛点 · 进口不确定',
  'PD-4':'直客痛点 · 单一渠道','PD-5':'直客痛点 · 货物滞留','PD-6':'直客痛点 · 分类问题',
  'PD-7':'直客痛点 · 法规突变','PD-8':'直客痛点 · 港口拥堵',
  // Pain — Unlabeled
  'PU-1':'通用痛点 · 物流效率','PU-2':'通用痛点 · 运输意外','PU-3':'通用痛点 · 供应链优化',
  'PU-4':'通用痛点 · 物流支撑','PU-5':'通用痛点 · 港口延误','PU-6':'通用痛点 · 不必要风险',
  'PU-7':'通用痛点 · 多点故障','PU-8':'通用痛点 · 缺乏可见性',
  // Proof — Agent
  'RA-1':'代理证明 · 资质资源','RA-2':'代理证明 · 全球网络','RA-3':'代理证明 · 拉美航线',
  'RA-4':'代理证明 · 弹性替代','RA-5':'代理证明 · 快速报价','RA-6':'代理证明 · 多船司备份',
  'RA-7':'代理证明 · 谈判赋能','RA-8':'代理证明 · 真实舱位',
  // Proof — Direct
  'RD-1':'直客证明 · 本地能力','RD-2':'直客证明 · 港口覆盖','RD-3':'直客证明 · 自主清关',
  'RD-4':'直客证明 · 规模背书','RD-5':'直客证明 · 无意外清关','RD-6':'直客证明 · 24h接管',
  'RD-7':'直客证明 · 仓关一体','RD-8':'直客证明 · 本地团队',
  // Proof — Unlabeled
  'RU-1':'通用证明 · 资质覆盖','RU-2':'通用证明 · 资源优势','RU-3':'通用证明 · 拉美航线',
  'RU-4':'通用证明 · 灵活适配','RU-5':'通用证明 · 弹性扩容','RU-6':'通用证明 · 快速响应',
  'RU-7':'通用证明 · 真实团队','RU-8':'通用证明 · 灵活服务',
  // CTA — Agent
  'CA-1':'代理CTA · 路线报告','CA-2':'代理CTA · 分享运价','CA-3':'代理CTA · 备用方案',
  'CA-4':'代理CTA · 无压留门','CA-5':'代理CTA · 快速报价','CA-6':'代理CTA · 港口比价',
  'CA-7':'代理CTA · 5分钟聊','CA-8':'代理CTA · 复杂港口',
  // CTA — Direct
  'CD-1':'直客CTA · 清关说明','CD-2':'直客CTA · 流程审查','CD-3':'直客CTA · 备用清关',
  'CD-4':'直客CTA · 优化进口','CD-5':'直客CTA · 加速清关','CD-6':'直客CTA · 延误复盘',
  'CD-7':'直客CTA · 时效分析','CD-8':'直客CTA · 简短通话',
  // CTA — Unlabeled
  'CU-1':'通用CTA · 分享信息','CU-2':'通用CTA · 市场数据','CU-3':'通用CTA · 无压支持',
  'CU-4':'通用CTA · 自我介绍','CU-5':'通用CTA · 路线更新','CU-6':'通用CTA · 优化探索',
  'CU-7':'通用CTA · 第二意见','CU-8':'通用CTA · 祝福收尾',
  // Follow-up F1
  'F1-1':'跟进1 · 新角度','F1-2':'跟进1 · 新思路','F1-3':'跟进1 · 换个视角',
  'F1-4':'跟进1 · 收件箱满','F1-5':'跟进1 · 不同方法',
  // Follow-up F2
  'F2-1':'跟进2 · 市场变化','F2-2':'跟进2 · 环境波动','F2-3':'跟进2 · 行业格局',
  'F2-4':'跟进2 · 运价动态','F2-5':'跟进2 · 法规机会',
  // Follow-up F3
  'F3-1':'跟进3 · 时差留门','F3-2':'跟进3 · 无压提醒','F3-3':'跟进3 · 不打扰',
  'F3-4':'跟进3 · 时机未到','F3-5':'跟进3 · 随时响应',
  // Follow-up F4
  'F4-1':'跟进4 · 最后联系','F4-2':'跟进4 · 不越界','F4-3':'跟进4 · 转为观察',
  'F4-4':'跟进4 · 祝福告别','F4-5':'跟进4 · 关闭序列',
};

function applyLabels(lib) {
  const apply = (arr) => { if (arr) arr.forEach(item => { item.label = LABEL_MAP[item.id] || item.id; }); };
  const applyObj = (obj) => { if (Array.isArray(obj)) apply(obj); else if (obj) Object.values(obj).forEach(apply); };
  applyObj(lib.hooks);
  apply(lib.painPoints?.agent);
  apply(lib.painPoints?.direct);
  apply(lib.painPoints?.unlabeled);
  apply(lib.proofs?.agent);
  apply(lib.proofs?.direct);
  apply(lib.proofs?.unlabeled);
  applyObj(lib.ctas);
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
