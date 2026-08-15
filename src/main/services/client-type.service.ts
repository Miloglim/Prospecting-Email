// ── 客户分类（代理 / 直客 / 未设置）──
// 迁移自旧 PE classify-client.js，纯函数无 IO

export type ClientType = "agent" | "direct" | null;

const AGENT_STRONG = [
  "freight forwarder", "freight forwarding", "forwarding",
  "agencia de carga", "agencia de aduana", "agente de carga",
  "despachante", "despachos aduaneros",
  "customs broker", "customs brokerage",
  "naviera", "shipping line", "shipping agency",
  "transitário", "transitario",
  "operador logistico", "operador logístico",
  "3pl", "third party logistics",
  "nvocc", "nvoc",
  "courier", "cargo express", "carga express",
  "international movers", "consolidator", "consolidador",
  "代理", "货代", "agente de cargas",
  "logística", "logistic", "logistics",
  "comércio exterior", "comercio exterior",
  "comex", "despacho aduaneiro", "despacho aduanero",
  "assessoria aduaneira", "consultoria aduaneira",
  "carga internacional", "cargas internacionais",
  "transporte internacional", "transportes internacionais",
  "freight", "cargo",
];

const DIRECT_STRONG = [
  "manufactur", "fabricante", "fabricación", "fabrica", "factory", "fábrica",
  "importadora", "importador", "exportadora", "exportador",
  "automotriz", "automotive", "auto parts", "autopeças", "autopartes",
  "alimentos", "food", "beverage", "bebidas", "alimenticia",
  "farmacéutica", "pharmaceutical", "farma", "laboratório",
  "textil", "textile", "têxtil", "tejidos", "confección",
  "electrónica", "eletrônica", "electronics",
  "metalurgia", "siderurgica", "siderúrgica",
  "química", "chemical", "petroquímica",
  "cosmética", "cosmetic", "cosméticos",
  "calçados", "footwear", "móveis", "furniture",
  "embalagem", "packaging", "embalaje",
  "maquinaria", "machinery", "máquinas", "equipamentos",
  "cerámica", "ceramic", "cerâmica",
  "papel", "paper", "celulose", "cellulose",
  "plástico", "plastic", "plásticos",
  "vidro", "glass", "vidrio",
  "borracha", "rubber",
  "minería", "mining", "mineração",
  "pintura", "paint", "coating",
  "agricultura", "agricultural", "agro",
  "hospitalar", "medical devices",
  "直客",
];

/** 根据公司名识别客户类型。返回 "agent" | "direct" | null（无法判断） */
export function classifyClientType(companyName: string): ClientType {
  const text = (companyName || "").toLowerCase();
  if (!text) return null;
  if (AGENT_STRONG.some(kw => text.includes(kw))) return "agent";
  if (DIRECT_STRONG.some(kw => text.includes(kw))) return "direct";
  return null;
}

/** 中英文标签 → 系统代码（用户手动选择 / 迁移） */
export function normalizeClientType(raw: string | null | undefined): ClientType {
  if (!raw) return null;
  const t = raw.toLowerCase().trim();
  if (t === "agent" || t === "direct") return t;
  const map: Record<string, ClientType> = {
    "代理": "agent", "货代": "agent", "货运代理": "agent",
    "agente": "agent", "agencia": "agent", "forwarder": "agent",
    "直客": "direct", "directo": "direct",
  };
  return map[raw] || map[t] || null;
}

/** 系统代码 → 中文标签 */
export function clientTypeLabel(t: string | null | undefined): string {
  if (t === "agent") return "代理";
  if (t === "direct") return "直客";
  return "未设置";
}
