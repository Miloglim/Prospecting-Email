// ── 来信询价要素解析 + 工作台真价匹配（纯本地正则，不调模型）──────────
// 为什么：generate_draft 回信时此前拿不到「这封邮件要什么柜型/哪条航线」和「之前查到的真运价」，
// 只能留 {{占位}} 或编造（P2 根因）。这里把来信正文解析成结构化要素，再按柜型/港从会话工作台
// 里挑出匹配的真运价行，喂给起草提示 —— 草稿据真数据作答，占位符只在真没数据时出现。
// 原则对齐运价线：抽不到就留 null，绝不猜（猜错比查不到更糟，会写进客户报价）。

export interface EmailInquiry {
  container: string | null;   // 归一柜型：20GP/40GP/40HQ/40NOR…
  containerRaw: string | null;
  pol: string | null;         // 起运港（原文名，可能含中文）
  polCode: string | null;     // UN/LOCODE，如 CNNBG
  pod: string | null;         // 目的港
  podCode: string | null;     // 如 BRSSZ
  incoterm: string | null;    // FOB/CIF/…
  cargo: string | null;       // 货描
  cargoValueUsd: number | null;
  quoteRef: string | null;    // QUOTE-xxxx
  volumeCbm: number | null;
  weightKg: number | null;
}

/** 柜型归一：40HC/40'HQ/40HQ→40HQ，20GP，40NOR/NOR→40NOR；识别不了返回原样大写或 null */
export function normContainer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/['’\s]/g, "");
  const m = s.match(/(20|40|45)(GP|HQ|HC|NOR|OT|RF|FR)?/);
  if (!m) return null;
  const size = m[1];
  let type = m[2] ?? "";
  if (type === "HC") type = "HQ";           // HC 与 HQ 同义，统一到 HQ
  if (type === "NOR") return `${size}NOR`;
  if (!type) return size === "20" ? "20GP" : `${size}HQ`;   // 光写 40 默认高柜
  return `${size}${type}`;
}

const pick = (re: RegExp, text: string, group = 1): string | null => {
  const m = text.match(re);
  const v = m?.[group]?.trim();
  return v ? v.replace(/\s+/g, " ") : null;
};
const pickNum = (re: RegExp, text: string): number | null => {
  const v = pick(re, text);
  if (v == null) return null;
  const n = Number(v.replace(/[,，\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** 从「桑托斯 (BRSSZ, 圣保罗州)」这类串里单取五字 LOCODE */
const pickLocode = (segment: string | null): string | null => {
  if (!segment) return null;
  const m = segment.toUpperCase().match(/\b([A-Z]{5})\b/);
  return m?.[1] ?? null;
};

export function parseEmailInquiry(bodyText: string): EmailInquiry {
  const t = (bodyText || "").replace(/\r/g, "");
  const containerRaw =
    pick(/柜型[:：]\s*([^\n（(]+)/, t) ??
    pick(/container\s*(?:type)?[:：]\s*([^\n（(]+)/i, t) ??
    pick(/(\d+\s*[×xX*]\s*\d{2}\s*['’]?\s*(?:GP|HQ|HC|NOR|OT|RF))/i, t) ??
    pick(/\b((?:20|40|45)\s*['’]?\s*(?:GP|HQ|HC|NOR|OT|RF))\b/i, t);
  const polSeg = pick(/起运港[:：]\s*([^\n]+)/, t) ?? pick(/(?:\bPOL\b|port\s+of\s+loading|origin)[:：]\s*([^\n]+)/i, t);
  const podSeg = pick(/目的港[:：]\s*([^\n]+)/, t) ?? pick(/(?:\bPOD\b|destination|port\s+of\s+discharge|to)[:：]\s*([^\n]+)/i, t);
  return {
    container: normContainer(containerRaw),
    containerRaw: containerRaw?.trim() ?? null,
    pol: polSeg ? polSeg.replace(/[（(].*$/, "").trim() : null,
    polCode: pickLocode(polSeg),
    pod: podSeg ? podSeg.replace(/[（(].*$/, "").trim() : null,
    podCode: pickLocode(podSeg),
    incoterm: pick(/\b(FOB|CIF|CFR|EXW|DDP|DAP|FCA)\b/i, t)?.toUpperCase() ?? null,
    cargo: pick(/货物[:：]\s*([^\n]+)/, t) ?? pick(/(?:cargo|goods|commodity)[:：]\s*([^\n]+)/i, t),
    cargoValueUsd: pickNum(/货值[:：]\s*(?:USD?|US\$|\$)?\s*([\d,，.]+)/i, t)
      ?? pickNum(/(?:cargo\s+value|value)[:：]\s*(?:USD?|US\$|\$)?\s*([\d,，.]+)/i, t),
    quoteRef: pick(/(QUOTE[-\s]?[0-9][0-9A-Z-]*)/i, t) ?? pick(/报价编号[:：]\s*([^\n]+)/, t),
    volumeCbm: pickNum(/([\d.]+)\s*CBM/i, t),
    weightKg: pickNum(/([\d,.]+)\s*(?:KGS?|千克|公斤)/i, t),
  };
}

// ── 工作台真价匹配 ───────────────────────────────────────────────
export interface RateRow { carrier: string | null; container: string | null; pol: string | null; pod: string | null; price: number | null; validFrom: string | null; validTo: string | null; note: string | null; }
export interface RatesPayload { pod?: string | null; lane?: string | null; container?: string | null; total?: number; rows?: RateRow[]; [k: string]: unknown; }

/** 港/航线词元重叠：把两边的拉丁词与 LOCODE 拿出来比对（跨中英文不硬翻，只对得上才算） */
function podOverlap(a: EmailInquiry, p: RatesPayload): boolean {
  const hay = [p.pod, p.lane, ...(p.rows ?? []).slice(0, 5).map(r => r.pod)].filter(Boolean).join(" ").toUpperCase();
  if (!hay) return false;
  const probes = [a.podCode, a.pod, a.polCode].filter(Boolean) as string[];
  for (const raw of probes) {
    for (const tok of raw.toUpperCase().split(/[^A-Z0-9]+/).filter(x => x.length >= 4)) {
      if (hay.includes(tok)) return true;
    }
  }
  return false;
}

/**
 * 从会话工作台里挑出与这封来信最匹配的一份运价。
 * 打分：柜型命中 +2（跨语言最可靠的连接键），港/航线词元命中 +1。
 * 全 0 分时：只有一份候选就用它（读信→查价→起草的常见单查询流），多份则返回 null（宁可提示先查价，不乱注入）。
 * 命中后按柜型过滤 rows（柜型未知则不过滤）。
 */
export function pickRatesForEmail(inq: EmailInquiry, items: Array<{ refId: string; payload: unknown }>): RatesPayload | null {
  const cands = items
    .map(it => ({ it, p: (it.payload ?? {}) as RatesPayload }))
    .filter(x => Array.isArray(x.p.rows) && (x.p.rows as RateRow[]).length > 0);
  if (!cands.length) return null;
  const pc = normContainer(inq.container);
  const scored = cands.map(({ p }, i) => {
    let s = 0;
    if (pc) {
      if (normContainer(p.container) === pc) s += 2;
      else if ((p.rows ?? []).some(r => normContainer(r.container) === pc)) s += 2;
    }
    if (podOverlap(inq, p)) s += 1;
    return { p, s, i };
  }).sort((a, b) => (b.s - a.s) || (a.i - b.i));   // 分数高优先，同分取更近（items 已新→旧）
  const best = scored[0]!;
  if (best.s === 0 && cands.length > 1) return null;
  const p = best.p;
  if (!pc) return p;
  const filtered = (p.rows ?? []).filter(r => normContainer(r.container) === pc);
  return { ...p, rows: filtered.length ? filtered : p.rows };
}
