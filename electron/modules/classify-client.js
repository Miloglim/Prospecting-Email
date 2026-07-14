// ── 客户分类逻辑（代理 / 直客 / 未标签）─────────────────────────────────────
const { API } = require('./core/contract');
const { Log } = require('./core/logger');

function classifyClient(company, category) {
  const companyText = (company || '').toLowerCase();
  const catText = (category || '').toLowerCase();
  const text = companyText + ' ' + catText;
  const hasCategory = catText.length > 1; // 客户表有类型列时才用弱信号

  // ponytail: 代理强信号 — 明确的物流公司身份词（无类型列也可靠）
  const agentStrong = [
    'freight forwarder', 'freight forwarding', 'forwarding',
    'agencia de carga', 'agencia de aduana', 'agente de carga',
    'despachante', 'despachos aduaneros',
    'customs broker', 'customs brokerage',
    'naviera', 'shipping line', 'shipping agency',
    'transitário', 'transitario',
    'operador logistico', 'operador logístico',
    '3pl', 'third party logistics',
    'nvocc', 'nvoc',
    'courier', 'cargo express', 'carga express',
    'international movers', 'consolidator', 'consolidador',
    '代理', '货代', 'agente de cargas',
    // 拉美常见货代强信号：公司名含这些词几乎都是物流公司
    'logística', 'logistic', 'logistics',
    'comércio exterior', 'comercio exterior',
    'comex', 'despacho aduaneiro', 'despacho aduanero',
    'assessoria aduaneira', 'consultoria aduaneira',
    'carga internacional', 'cargas internacionais',
    'transporte internacional', 'transportes internacionais',
    'freight', 'cargo',
  ];
  if (agentStrong.some(kw => text.includes(kw))) return 'agent';

  // ponytail: 仅当客户表有类型列时，才用弱信号（避免误伤公司名含 ship/transport 等通用词）
  if (hasCategory) {
    const agentWeak = [
      'shipping', 'transport', 'transporte', 'transportes', 'transportadora',
      'agencia', 'agente', 'agência',
      'aduana', 'customs', 'carrier', 'maritime', 'marítimo',
      'ship', 'vessel', 'terminal', 'portuario', 'portuaria',
      'armador', 'forwarder', 'logistico', 'logístico',
    ];
    if (agentWeak.some(kw => text.includes(kw))) return 'agent';
  }

  // ponytail: 直客强信号 — 明确的制造商/品牌商
  const directStrong = [
    'manufactur', 'fabricante', 'fabricación', 'fabrica', 'factory', 'fábrica',
    'importadora', 'importador', 'exportadora', 'exportador',
    'automotriz', 'automotive', 'auto parts', 'autopeças', 'autopartes',
    'alimentos', 'food', 'beverage', 'bebidas', 'alimenticia',
    'farmacéutica', 'pharmaceutical', 'farma', 'laboratório',
    'textil', 'textile', 'têxtil', 'tejidos', 'confección',
    'electrónica', 'eletrônica', 'electronics',
    'metalurgia', 'siderurgica', 'siderúrgica',
    'química', 'chemical', 'petroquímica',
    'cosmética', 'cosmetic', 'cosméticos',
    'calçados', 'footwear', 'móveis', 'furniture',
    'embalagem', 'packaging', 'embalaje',
    'maquinaria', 'machinery', 'máquinas', 'equipamentos',
    'cerámica', 'ceramic', 'cerâmica',
    'papel', 'paper', 'celulose', 'cellulose',
    'plástico', 'plastic', 'plásticos',
    'vidro', 'glass', 'vidrio',
    'borracha', 'rubber',
    'minería', 'mining', 'mineração',
    'pintura', 'paint', 'coating',
    'agricultura', 'agricultural', 'agro',
    'hospitalar', 'medical devices',
    '直客',
  ];
  if (directStrong.some(kw => text.includes(kw))) return 'direct';

  // ponytail: 仅当客户表有类型列时，才用弱信号
  if (hasCategory) {
    const directWeak = [
      'import', 'importación', 'importer',
      'export', 'exportación', 'exporter',
      'retail', 'retailer', 'varejo', 'comercio', 'comercial',
      'distribuidora', 'distributor', 'distribución', 'distribution',
      'industria', 'industrial', 'industry',
      'plant', 'planta', 'trading',
      'equipment', 'equipos',
      'metal', 'aço', 'steel', 'alumínio', 'aluminum', 'acero',
      'filtros', 'filter', 'filtro',
      'repuestos', 'spare parts', 'componentes',
      'higiene', 'limpeza', 'cleaning',
      'hospital', 'medico', 'médica', 'medical',
      'fertilizante',
      'petróleo', 'petroleum', 'petroleo', 'oil', 'gas',
      'energia', 'energy', 'solar', 'eólica', 'eolica',
      'tool', 'tools', 'ferramentas', 'herramientas',
      'marca', 'brand', 'produtos', 'productos', 'products',
      'perfumaria', 'personal care',
      'iluminação', 'lighting', 'iluminación', 'envase',
    ];
    if (directWeak.some(kw => text.includes(kw))) return 'direct';
  }

  return 'unlabeled';
}

// 伪公司名检测
const PLACEHOLDER_NAMES = /^(公司提供|未命名|未知|N\/A|暂无|-|\.+|\s*)$/i;
function markSuspicious(company) {
  const raw = (company || '').trim();
  if (!raw || PLACEHOLDER_NAMES.test(raw)) {
    return { company: raw || '未命名', _suspicious: true };
  }
  return { company: raw, _suspicious: false };
}

const EMAIL_RE = /^[^\s@,"<>\[\]\\]+@[^\s@,"<>\[\]\\]+\.[^\s@,"<>\[\]\\]{2,}$/;

// ── AI 客户分类：通过 DeepSeek API 识别代理/直客/未标签 ─────────────────
// ponytail: 关键词兜底 + AI 增强，AI 不可用时静默降级
async function classifyClientAI(company, category, apiKey) {
  if (!apiKey) return classifyClient(company, category);
  const text = `公司名: ${company || ''}\n品类: ${category || ''}`;
  try {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是外贸物流客户分类专家。给定公司名和品类，判断该公司属于：agent（货代/物流服务商）、direct（直客/制造商/品牌商/进出口商）还是 unlabeled（无法判断）。只返回一个词：agent、direct 或 unlabeled。' },
        { role: 'user', content: text },
      ],
      temperature: 0, max_tokens: 10,
    });
    const result = await new Promise((resolve) => {
      const https = require('https');
      const req = https.request({
        ...API.DEEPSEEK, port: 443, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        timeout: 10000, rejectUnauthorized: false,
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(body);
    });
    const answer = (result?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    if (!result) { Log.warn('[AI分类]', `${company} — API 无响应，降级关键词`); }
    else if (answer) { Log.info('[AI分类]', `${company} — DeepSeek: "${answer}"`); }
    else {
      const errMsg = result?.error?.message || '';
      Log.warn('[AI分类]', `${company} — ${errMsg || '空内容'}，原始: ${JSON.stringify(result).slice(0, 300)}`);
      // ponytail: 认证失败/权限错误 → 直接终止，不浪费后续调用
      if (errMsg.includes('Authentication') || errMsg.includes('invalid')) {
        throw new Error('DeepSeek_API_Key_Invalid');
      }
    }
    // ponytail: API 可能返回多余文本（如 "agent." 或 "This company is an agent"），用 includes 兜底
    if (answer.includes('agent')) return 'agent';
    if (answer.includes('direct')) return 'direct';
    if (answer.includes('unlabeled')) return 'unlabeled';
  } catch (e) {
    if (e.message === 'DeepSeek_API_Key_Invalid') throw e; // 往上抛给 IPC 层终止
    Log.error('[AI分类]', `${company} AI请求异常`, e.stack);
  }
  return classifyClient(company, category);
}

module.exports = { classifyClient, classifyClientAI, markSuspicious, EMAIL_RE };
