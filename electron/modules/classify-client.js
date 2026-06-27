// ── 客户分类逻辑（代理 / 直客 / 未标签）─────────────────────────────────────
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
  ];
  if (agentStrong.some(kw => text.includes(kw))) return 'agent';

  // ponytail: 仅当客户表有类型列时，才用弱信号（避免误伤公司名含 ship/cargo 等词）
  if (hasCategory) {
    const agentWeak = [
      'logistics', 'logistic', 'logística', 'logistico', 'logístico',
      'freight', 'forwarder', 'cargo', 'shipping',
      'transport', 'transporte', 'transportes', 'transportadora',
      'agencia', 'agente', 'agência',
      'aduana', 'customs', 'carrier', 'maritime', 'marítimo',
      'ship', 'vessel', 'terminal', 'portuario', 'portuaria',
      'armador',
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
    return { company: (raw || '未命名') + ' ⚠️ 待确认', _suspicious: true };
  }
  return { company: raw, _suspicious: false };
}

const EMAIL_RE = /^[^\s@,"<>\[\]\\]+@[^\s@,"<>\[\]\\]+\.[^\s@,"<>\[\]\\]{2,}$/;

module.exports = { classifyClient, markSuspicious, EMAIL_RE };
