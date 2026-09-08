// ── 读侧运价清洗器：纯函数，页面与助手共用一份 ─────────────────────
// 台账仍是脏长表：起运港粘连多港、一柜型一行、多价与目免只活在原文里且按港分行。
// 这里在**查询时**把它洗成规范形态，不写回库。铁律：归一不了就保留原文 + 标 unverified，绝不猜。
// 禁止 IO（不碰 getDb/fs/fetch/Log）；触库查询留在 rate-sync.service.ts。
// 规范：docs/rates-query-spec.md §2、docs/rates-query-impl-spec.md §0（真源实测）
import portmapJson from "./rates-portmap.json";

// ══ 起运港：固定十值 ═══════════════════════════════════════════════
export const POL_STANDARD = [
  "蛇口", "南沙", "盐田", "华南基本港", "上海", "厦门", "宁波", "青岛", "天津", "大连",
] as const;
export type PolStandard = typeof POL_STANDARD[number];

/** 起运港别名/港区 → 固定值。深圳系港区（深圳/大铲湾）不猜一个，三个候选都给，报价表再按港拆行 */
const POL_ALIASES: Record<string, PolStandard[]> = {
  "深圳": ["蛇口", "盐田", "南沙"], "SHENZHEN": ["蛇口", "盐田", "南沙"], "SZX": ["蛇口", "盐田", "南沙"],
  "大铲湾": ["蛇口", "盐田", "南沙"], "DACHANWAN": ["蛇口", "盐田", "南沙"],
  "蛇口": ["蛇口"], "SHEKOU": ["蛇口"],
  "盐田": ["盐田"], "YANTIAN": ["盐田"], "YAT": ["盐田"],
  "南沙": ["南沙"], "NANSHA": ["南沙"], "NSA": ["南沙"],
  "广州": ["南沙"], "GUANGZHOU": ["南沙"],
  "华南基本港": ["华南基本港"], "华南": ["华南基本港"],
  "上海": ["上海"], "SHANGHAI": ["上海"], "SHA": ["上海"],
  "厦门": ["厦门"], "XIAMEN": ["厦门"], "XMN": ["厦门"],
  "宁波": ["宁波"], "宁波港": ["宁波"], "NINGBO": ["宁波"], "NGB": ["宁波"], "NGBO": ["宁波"],
  "青岛": ["青岛"], "QINGDAO": ["青岛"], "TAO": ["青岛"],
  "天津": ["天津"], "天津新港": ["天津"], "新港": ["天津"], "TIANJIN": ["天津"],
  "TSN": ["天津"], "XINGANG": ["天津"],
  "大连": ["大连"], "DALIAN": ["大连"], "DLC": ["大连"],
};
/** 实测存在但不在十值白名单里的口岸：保留原文、标 unverified，不硬塞进十值 */
const POL_SPLIT_RE = /[/、,，;；&|+()\s（）]+/;

// ══ 船司：国际标准缩写（按真源 26 个实测值补）═══════════════════════
const CARRIER_ALIASES: Record<string, string> = {
  "中远海特": "COSCO", "中远海运": "COSCO", "中远": "COSCO", "COSCO": "COSCO", "CSC": "COSCO",
  "外运": "SINOTRANS", "SINOTRANS 外运": "SINOTRANS", "SINOTRANS": "SINOTRANS",
  "达飞": "CMA", "CMA CGM": "CMA", "CMACGM": "CMA", "CMA": "CMA",
  "马士基": "MSK", "MAERSK": "MSK", "MSK": "MSK",
  "地中海航运": "MSC", "MSC": "MSC",
  "长荣": "EMC", "EVERGREEN": "EMC", "EMC": "EMC", "EGS": "EMC",
  "海洋网联": "ONE", "ONE": "ONE",
  "现代": "HMM", "HMM": "HMM",
  "以星": "ZIM", "ZIM": "ZIM",
  "阳明": "YML", "YANGMING": "YML", "YML": "YML",
  "太平太平洋": "PIL", "PIL": "PIL",
  "赫伯罗特": "HPL", "HAPAGLLOYD": "HPL", "HAPAG": "HPL", "HPL": "HPL",
};
/** 台账里的"未注明"不是船司名：呈现为 —，客户报价表里为 / */
const CARRIER_UNKNOWN = ["未注明", "未知", "N/A", "NA", "-"];

// ══ 航线小字与区域词（真源 route 枚举 12 个 + 常见区域简称）══════════
const LANE_TAGS = [
  "地东", "地西", "欧地", "欧基港", "欧西", "地中海", "黑海", "波海", "波罗的海", "红海", "波斯湾",
  "阿拉伯海", "南亚", "东南亚", "西非", "东非", "北非", "北欧", "大洋洲", "拉美",
  "加勒比", "墨西哥", "南美东", "南美西", "中美洲", "美东", "美西",
];

/** 港 → 国别/区域关键词：目免与 ETD 在原文里常按国别写（"埃及目免21，土耳其14"），靠它定位 */
const POD_COUNTRY: Record<string, string[]> = {
  "ISTANBUL": ["土耳其", "TURKEY", "TURKIYE"], "IZMIT": ["土耳其", "TURKEY"],
  "MERSIN": ["土耳其", "TURKEY"], "ALIAGA": ["土耳其", "TURKEY"], "GEBZE": ["土耳其", "TURKEY"],
  "ALEX": ["埃及", "EGYPT"], "ALEXANDRIA": ["埃及", "EGYPT"], "PORTSAID": ["埃及", "EGYPT"],
  "PIRAEUS": ["希腊", "GREECE"], "SANTOS": ["巴西", "BRAZIL"], "PARANAGUA": ["巴西", "BRAZIL"],
  "MANZANILLO": ["墨西哥", "MEXICO"], "CALLAO": ["秘鲁", "PERU"],
};

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CN_RE = /[\u4e00-\u9fa5]/;
/** 柜型 → 三列。真源枚举是 20GP / 40HQ/HC / 40NOR；40GP 与 40HC 归 40HQ|HC 列 */
const COL_OF: Record<string, "p20" | "p40" | "pNor"> = {
  "20GP": "p20", "20HC": "p20", "20": "p20",
  "40HQ/HC": "p40", "40HQ": "p40", "40HC": "p40", "40GP": "p40", "45HQ": "p40", "40": "p40",
  "40NOR": "pNor", "20NOR": "pNor", "NOR": "pNor",
};
const RE_PRICE_PAIR = /(?:USD\s*)?(\d[\d,]{2,8})\s*\/\s*(\d[\d,]{2,8})\s*(?:\/\s*(\d[\d,]{2,8}))?\s*\+?/i;
/** matchAll 专用全局克隆（matchAll 强制要求 /g；exec 保持非全局，防 lastIndex 串状态） */
const RE_PRICE_PAIR_G = /(?:USD\s*)?(\d[\d,]{2,8})\s*\/\s*(\d[\d,]{2,8})\s*(?:\/\s*(\d[\d,]{2,8}))?\s*\+?/gi;
const RE_HIGH = /高\s*柜?\s*[:：]?\s*(\d[\d,]{2,8})/;
const RE_SMALL = /小\s*柜?\s*[:：]?\s*(\d[\d,]{2,8})/;
const RE_FREE_POD = /(\d{1,2})\s*(?:天|days?)?\s*(?:目免|combined|FT|free\s*time)/i;
const RE_FREE_BY_COUNTRY = /(目免|free\s*time|FT)\s*(\d{1,2})/i;
const RE_CUTOFF_ETD = /(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[晚早]?\s*开\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/;
const RE_MD = /(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?/;

function dedupe<T>(xs: T[]): T[] { return [...new Set(xs)]; }
function pad(x: string | number): string { return String(x).padStart(2, "0"); }
function money(s: string | null | undefined): number | null {
  const n = Number(String(s ?? "").replace(/[$,\s]|USD/gi, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
function sanePrice(n: number | null): number | null { return n != null && n >= 100 && n <= 30000 ? Math.round(n) : null; }

/** 北京时间今日 YYYY-MM-DD（有效期与状态都按北京时间判） */
export function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 目的港尾巴可能粘连台账网页里的小字航线标签（旧库形态 "ISTANBUL 伊斯坦布尔(土耳其) 地东"）。
 * 护栏：只剥最后一个空白分隔、长度 ≤6、不含括号的尾段——"BALBOA, PA 巴尔博亚(巴拿马)" 不会被切碎。
 */
export function stripLaneTag(podRaw: string, lane: string | null): { podRaw: string; lane: string | null } {
  const s = (podRaw ?? "").trim();
  const i = s.lastIndexOf(" ");
  if (i <= 0) return { podRaw: s, lane };
  const head = s.slice(0, i).trim();
  const tail = s.slice(i + 1).trim();
  if (!head || !tail || tail.length > 6 || /[()（）\[\]]/.test(tail)) return { podRaw: s, lane };
  if (!LANE_TAGS.includes(tail) && tail !== lane?.trim()) return { podRaw: s, lane };
  return { podRaw: head, lane: lane?.trim() || tail };
}

interface PortMap {
  lanes: string[]; regionToLane: Record<string, string>;
  ports: Array<{ name: string; lane: string; aliases: string[] }>;
}
function loadPortmap(): PortMap { return portmapJson as unknown as PortMap; }

/** 用户输入的港口（任意写法）→ 词表标准港名；认不出原样大写返回（不猜） */
export function resolveQueryPod(q: string): string {
  const up = (q || "").trim().toUpperCase();
  for (const p of loadPortmap().ports) {
    for (const a of [...p.aliases, p.name]) {
      const A = a.toUpperCase();
      if (A.length <= 3) { if (new RegExp(`(?<![A-Z])${A}(?![A-Z])`).test(up)) return p.name; }
      else if (up.includes(A)) return p.name;
    }
  }
  return up;
}

/** 起运港原文 → 固定十值集合：拆 `+ / ；、,` 与全角括号、英文形态归一；拆不出的进 leftovers + unverified */
export function cleanPol(raw: string | null | undefined): { pols: PolStandard[]; leftovers: string[]; unverified: string[] } {
  const s = (raw ?? "").trim();
  if (!s) return { pols: [], leftovers: [], unverified: [] };
  const lookup = (tok: string): PolStandard[] | null => {
    const t = tok.trim().replace(/[（(][^（）()]*[)）]/g, "").trim();   // 天津新港（Xingang）→ 天津新港
    if (!t) return null;
    const hit = POL_ALIASES[t] ?? POL_ALIASES[t.toUpperCase()] ?? POL_ALIASES[t.replace(/\s+/g, "").toUpperCase()];
    return hit ?? null;
  };
  const direct = lookup(s);
  if (direct) return { pols: dedupe(direct), leftovers: [], unverified: [] };
  // 英文长串 "Shekou, Shenzhen, Guangdong, China;…" 先按 ; 切，再取每段第一个词
  const parts = s.split(POL_SPLIT_RE).map(x => x.trim()).filter(Boolean);
  const pols: PolStandard[] = [];
  const leftovers: string[] = [];
  for (const p of parts) {
    const hit = lookup(p) ?? lookup(p.split(/\s+/)[0] ?? "");
    if (hit) pols.push(...hit); else leftovers.push(p);
  }
  const uniq = dedupe(pols);
  if (!uniq.length) return { pols: [], leftovers: [s], unverified: [`起运港未归一：${s}`] };
  const extra = dedupe(leftovers).filter(x => x.length <= 24);
  return {
    pols: uniq, leftovers: extra,
    unverified: extra.length ? [`起运港含非十值口岸：${extra.join("/")}`] : [],
  };
}

function onePod(seg: string): string {
  let s = stripLaneTag(seg.trim(), null).podRaw;
  s = s.replace(/[（(][^（）()]*[)）]\s*$/, "").trim();      // 尾部括注：(土耳其)/(巴拿马)
  const cn = s.search(CN_RE);
  if (cn > 0) s = s.slice(0, cn).trim();                    // 英文港名后跟中文译名 → 只留英文
  s = s.replace(/,\s*[A-Z]{2}$/i, "").trim();               // "BALBOA, PA" → BALBOA
  s = s.replace(/^(?:PORT OF|PORT)\s+/i, "").trim();
  const canon = resolveQueryPod(s);
  return (canon || s).toUpperCase();
}

/** 目的港原文 → 标准英文唯一港名集合（全大写；剥译名/国别/航线小字；多港拆开） */
export function cleanPod(raw: string | null | undefined): { pods: string[]; unverified: string[] } {
  const s = (raw ?? "").trim();
  if (!s) return { pods: [], unverified: [] };
  const parts = s.split(/[/、;；&|+]+|\s{2,}/).map(x => x.trim()).filter(Boolean);
  const pods: string[] = [];
  const unverified: string[] = [];
  for (const p of parts) {
    const one = onePod(p);
    if (!one || pods.includes(one)) continue;
    if (CN_RE.test(one)) unverified.push(`目的港未标准化：${one}`);
    pods.push(one);
  }
  if (!pods.length) return { pods: [s.toUpperCase()], unverified: [`目的港未标准化：${s}`] };
  return { pods, unverified };
}

/** 船司 → 国际标准缩写；"未注明"归空（呈现 —、客户表 /）；未知三字码原样采信，其余标 unverified */
export function cleanCarrier(raw: string | null | undefined): { carrier: string; unverified: string[] } {
  const s = (raw ?? "").trim();
  if (!s) return { carrier: "", unverified: [] };
  if (CARRIER_UNKNOWN.includes(s.toUpperCase()) || CARRIER_UNKNOWN.includes(s)) return { carrier: "", unverified: [] };
  const up = s.toUpperCase();
  const hit = CARRIER_ALIASES[s] ?? CARRIER_ALIASES[up] ?? CARRIER_ALIASES[up.replace(/\s+/g, "")];
  if (hit) return { carrier: hit, unverified: [] };
  if (/^[A-Z]{3,4}$/.test(up)) return { carrier: up, unverified: [] };
  return { carrier: s, unverified: [`船司未归一：${s}`] };
}

/**
 * 原文按港定位：在 message_text 里找**含该行目的港**的那些行（含中文译名/别名/同港组行），
 * 返回这些行拼成的文本。定位不到返回 null —— 调用方据此决定能否采用"全篇唯一值"兜底。
 * 这是防错价的核心：样例 B 里 ALEX 4200/5100 与 ISTANBUL/MERSIN/ALIAGA 4100/4800 并存，
 * 抓"原文第一个 X/Y"会把亚历山大的价填给 ALIAGA。
 */
export function locatePodLines(messageText: string | null, pods: string[], aliasWords: string[] = []): string | null {
  const txt = (messageText ?? "").trim();
  if (!txt) return null;
  const keys = dedupe([...pods, ...aliasWords].map(x => (x ?? "").trim().toUpperCase()).filter(x => x.length >= 3));
  if (!keys.length) return null;
  const lines = txt.split(/\r?\n/);
  const hit = lines.filter(l => {
    const up = l.toUpperCase();
    return keys.some(k => up.includes(k));
  });
  return hit.length ? hit.join("\n") : null;
}

export interface ThreePrices { p20: number | null; p40: number | null; pNor: number | null; unverified: string[] }

/**
 * 三列柜型价（宽表在读侧合成）。优先级：结构化列 → **该行 pod 定位到的原文行** → 全篇唯一多价（港组共享）。
 * 全篇有多处不同价又定位不到本港时**不猜**，留空并标 unverified。
 * 支持：`USD3300/3900+`（2 价=20GP/40HQ|HC）、`4100/4800/5200`（3 价=+40NOR）、`高 2000`、`小 1000`。
 */
export function parsePrices(o: {
  container: string | null; oceanUsd: number | null; messageText: string | null;
  note: string | null; pods: string[];
}): ThreePrices {
  const out: ThreePrices = { p20: null, p40: null, pNor: null, unverified: [] };
  const fill = (k: "p20" | "p40" | "pNor", raw: string | number | null | undefined) => {
    if (out[k] != null) return;
    const v = sanePrice(typeof raw === "number" ? raw : money(raw));
    if (v != null) out[k] = v;
  };
  // 1) 结构化列最可信：container_type 真源枚举是 20GP / 40HQ/HC / 40NOR
  const col = COL_OF[(o.container ?? "").trim().toUpperCase()];
  if (col && o.oceanUsd != null) {
    const v = sanePrice(o.oceanUsd);
    if (v != null) out[col] = v;
    else out.unverified.push(`价格可疑（${o.oceanUsd}），未采信`);
  }
  // 2) 原文按港定位：取含本行目的港的行，**再加它们的下一行**——真源形态是
  //    港名行（ISTANBUL/ IZMIT/ MERSIN/ ALIAGA）的下一行才是价行（USD3300/3900+），
  //    只取含港名的行会永远漏掉价。仅用于本服务的作用域，不动 locatePodLines 的对外语义。
  const txt = o.messageText ?? "";
  const keys = o.pods.map(x => (x ?? "").trim().toUpperCase()).filter(x => x.length >= 3);
  let scoped: string | null = null;
  if (txt.trim() && keys.length) {
    const lines = txt.split(/\r?\n/);
    const hitIdx = lines.reduce<number[]>((acc, l, i) => {
      if (keys.some(k => l.toUpperCase().includes(k))) acc.push(i);
      return acc;
    }, []);
    if (hitIdx.length) {
      const keep = new Set(hitIdx);
      for (const i of hitIdx) keep.add(i + 1);
      scoped = [...keep].sort((a, b) => a - b).map(i => lines[i] ?? "").join("\n");
    }
  }
  const fromText = (t: string | null) => {
    if (!t) return;
    const m = RE_PRICE_PAIR.exec(t);
    if (m) {
      fill("p20", m[1]);
      fill("p40", m[2]);
      if (m[3]) fill("pNor", m[3]);
    }
    fill("p40", RE_HIGH.exec(t)?.[1]);
    fill("p20", RE_SMALL.exec(t)?.[1]);
  };
  fromText(scoped);
  // 3) 定位不到本港时：全篇只有一处多价 → 视为港组共享价采用；多处不同价 → 不猜。
  //    连多价都没有 → 试"高 2000 / 小 1000"整文兜底（无港可定位时的独立价写法）。
  if (!scoped) {
    const all = [...txt.matchAll(RE_PRICE_PAIR_G)].map(m => `${m[1]}/${m[2]}`);
    const uniq = dedupe(all);
    if (uniq.length === 1) fromText(txt);
    else if (uniq.length > 1) out.unverified.push("原文多处价且未按港定位，未采信（需人工核对）");
    else if (out.p20 == null && out.p40 == null && out.pNor == null) {
      fill("p40", RE_HIGH.exec(txt)?.[1]);
      fill("p20", RE_SMALL.exec(txt)?.[1]);
    }
  }
  if (out.p20 == null && out.p40 == null && out.pNor == null) out.unverified.push("价：三列未解析");
  return out;
}

/**
 * 目免（Freetime）：真源 free_days 全库为 null，值只在原文/备注里，且**按国别分**
 * （"埃及目免21，土耳其14"）。所以先按本行目的港的国别关键词定位，再取数字；
 * 定位不到才用"全篇唯一值"兜底；仍取不到 → null（原文已在备注里，不猜）。
 * 采信范围 1-30 天，越界转备注。
 */
export function cleanFreeDays(o: {
  freeDays: string | null; messageText: string | null; note: string | null; pods: string[];
}): { days: number | null; intoNote: string | null } {
  const direct = Number(String(o.freeDays ?? "").replace(/[^\d]/g, ""));
  if (o.freeDays && Number.isFinite(direct) && direct > 0) {
    return direct <= 30 ? { days: direct, intoNote: null } : { days: null, intoNote: `目免异常（${o.freeDays}），已转备注` };
  }
  const txt = `${o.messageText ?? ""}\n${o.note ?? ""}`;
  if (!txt.trim()) return { days: null, intoNote: null };
  const countries = dedupe(o.pods.flatMap(p => POD_COUNTRY[p] ?? []));
  // 1) 国别 + 目免关键词同段："埃及目免21"（关键词在场，数字绝不会被当成日期）
  for (const c of countries) {
    const re = new RegExp(`${c}[^\\n]{0,10}?(?:目免|free\\s*time|FT)[^0-9]{0,6}(\\d{1,2})`, "i");
    const m = re.exec(txt);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 30) return { days: n, intoNote: null };
    }
  }
  // 2) 国别 + 紧邻裸数字："土耳其14"。数字后随 . / ~ 月 一律拒绝（"土耳其推广 9.1~9.30"
  //    是促销+船期行，9 不是目免——这正是旧实现采错 9 的根因）。
  for (const c of countries) {
    const re = new RegExp(`${c}[^\\n0-9]{0,4}(\\d{1,2})(?![.\\-/~月]\\d)`, "i");
    const m = re.exec(txt);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 30) return { days: n, intoNote: null };
    }
  }
  // 3) 全文唯一免词兜底："21 combined"（无限定词但全篇唯一）/"目免21"/"免21天"。
  //    多个不同值且定位不到国别 → 不猜，转备注。
  const kw = [...txt.matchAll(/(\d{1,2})\s*(?:combined|days?\s*free)|目免[^0-9]{0,4}(\d{1,2})|免\s*(\d{1,2})\s*天/gi)]
    .map(m => Number(m[1] ?? m[2] ?? m[3])).filter(n => Number.isFinite(n) && n > 0);
  const uniqKw = dedupe(kw).filter(n => n <= 30);
  if (uniqKw.length === 1) return { days: uniqKw[0]!, intoNote: null };
  if (uniqKw.length > 1) return { days: null, intoNote: `目免多值（${uniqKw.join("/")}），已转备注` };
  return { days: null, intoNote: null };
}

/**
 * ETD → YYYY-MM-DD。优先级：结构化 etd → 本港定位行里的"截关+开船"合写（9.6晚开9.10 → 9.10）
 * → 定位行里的月.日。缺年份按参考时间（消息时间）推，落在过去则 +1 年。解析不出返回 null，不猜。
 */
export function cleanEtd(o: { etd: string | null; messageText: string | null; msgTime: string | null; pods: string[] }): string | null {
  const ref = o.msgTime ? new Date(o.msgTime) : new Date();
  const baseYear = Number.isNaN(ref.getTime()) ? new Date().getFullYear() : ref.getFullYear();
  const mk = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
  const fix = (m: number, d: number) => (mk(baseYear, m, d) < todayBeijing() ? mk(baseYear + 1, m, d) : mk(baseYear, m, d));
  const fromMd = (s: string): string | null => {
    const ce = RE_CUTOFF_ETD.exec(s);                       // "9.6晚开9.10"：前截关、后开船
    if (ce) {
      const m = Number(ce[3]); const d = Number(ce[4]);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return fix(m, d);
    }
    const mm = RE_MD.exec(s);
    if (!mm) return null;
    const m = Number(mm[1]); const d = Number(mm[2]);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? fix(m, d) : null;
  };
  const raw = (o.etd ?? "").trim();
  if (raw) {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
    if (iso) return `${iso[1]}-${pad(iso[2]!)}-${pad(iso[3]!)}`;
    const v = fromMd(raw);
    if (v) return v;
  }
  return fromMd(locatePodLines(o.messageText, o.pods) ?? "");
}

/** 目免越界/异常与无法解析的内容一律转备注，不丢信息 */
export function quoteState(validTo: string | null | undefined, today = todayBeijing()): "当前有效" | "已过期" {
  return !validTo || validTo >= today ? "当前有效" : "已过期";
}
export type QuoteState = ReturnType<typeof quoteState>;

/** 有效期 → 报价格式："1-15 Sep"（同月）/"31 Aug – 6 Sep"（跨月）/"16 Sep"（单边）/"/"（都缺） */
export function fmtValidity(from: string | null | undefined, to: string | null | undefined): string {
  const d = (s: string | null | undefined) => {
    const mt = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
    return mt ? { mo: Number(mt[1]), dy: Number(mt[2]) } : null;
  };
  const a = d(from); const b = d(to);
  const tag = (x: { mo: number; dy: number }) => `${x.dy} ${MONTHS_EN[x.mo - 1]}`;
  if (a && b) return a.mo === b.mo ? `${a.dy}-${b.dy} ${MONTHS_EN[a.mo - 1]}` : `${tag(a)} – ${tag(b)}`;
  if (a) return tag(a);
  if (b) return tag(b);
  return "/";
}

/** ETD → 报价格式 "16 Sep"；缺则 "/" */
export function fmtEtdShort(iso: string | null | undefined): string {
  const mt = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return mt ? `${Number(mt[2])} ${MONTHS_EN[Number(mt[1]) - 1]}` : "/";
}

/** 清洗器输入（含原文，只在主进程内部流转） */
export interface QuoteRowRaw {
  carrier: string | null; pol: string | null; podRaw: string | null; lane: string | null;
  container: string | null; containerRaw: string | null; oceanUsd: number | null;
  freeDays: string | null; etd: string | null; validityRaw: string | null;
  validFrom: string | null; validTo: string | null;
  note: string | null; sourceGroup: string | null; sender: string | null; msgTime: string | null;
  syncedAt: string | null; status: string | null; messageText: string | null;
}

/** 清洗后的规范行（呈现与两张表都从这里出） */
export interface CleanQuote {
  carrier: string; pols: PolStandard[]; polText: string;
  pod: string; pods: string[]; lane: string | null;
  p20: number | null; p40: number | null; pNor: number | null;
  freeDays: number | null; etd: string | null;
  validFrom: string | null; validTo: string | null; validityRaw: string | null; state: QuoteState;
  note: string; source: string; sender: string;
  msgTime: string | null; syncedAt: string | null; imageUrl: string | null;
  unverified: string[];
}

/** 一行镜像 → 一行规范运价（纯函数）。imageUrl 由调用方拼好传入 */
export function cleanQuoteRow(row: QuoteRowRaw, imageUrl: string | null = null): CleanQuote {
  const pol = cleanPol(row.pol);
  const pod = cleanPod(row.podRaw);
  const carrier = cleanCarrier(row.carrier);
  const prices = parsePrices({
    container: row.container, oceanUsd: row.oceanUsd,
    messageText: row.messageText, note: row.note, pods: pod.pods,
  });
  const free = cleanFreeDays({ freeDays: row.freeDays, messageText: row.messageText, note: row.note, pods: pod.pods });
  const etd = cleanEtd({ etd: row.etd, messageText: row.messageText, msgTime: row.msgTime, pods: pod.pods });
  // 柜型为 null 的行带独立价（实测同一消息 20GP=8444、40HQ/HC=10794、null 柜型=9894）：
  // 塞进任何一列都是错价，改为进备注保留信息
  const noColPrice = !COL_OF[(row.container ?? "").trim().toUpperCase()] && row.oceanUsd != null
    ? `未标柜型价 $${row.oceanUsd.toLocaleString("en-US")}`
    : null;
  const notes = dedupe([row.note, noColPrice, row.validityRaw && !row.validFrom && !row.validTo ? `有效期原文：${row.validityRaw}` : null, free.intoNote]
    .filter((x): x is string => !!x && !!x.trim()));
  return {
    carrier: carrier.carrier,
    pols: pol.pols,
    polText: pol.pols.length ? pol.pols.join("/") : (pol.leftovers[0] ?? (row.pol ?? "").trim()),
    pod: pod.pods[0] ?? "",
    pods: pod.pods,
    lane: stripLaneTag(row.podRaw ?? "", row.lane).lane,
    p20: prices.p20, p40: prices.p40, pNor: prices.pNor,
    freeDays: free.days, etd,
    validFrom: row.validFrom ?? null, validTo: row.validTo ?? null,
    validityRaw: row.validityRaw ?? null,
    state: quoteState(row.validTo),
    note: notes.join("；"),
    source: (row.sourceGroup ?? "").trim(),
    sender: (row.sender ?? "").trim(),
    msgTime: row.msgTime ?? null,
    syncedAt: row.syncedAt ?? null,
    imageUrl,
    unverified: dedupe([...pol.unverified, ...pod.unverified, ...carrier.unverified, ...prices.unverified]).slice(0, 6),
  };
}

/** 同船司 + 同港组 + 同目的港 + 同有效期 合并成一行三列（读侧合成宽表，不写回库） */
export function pivotQuotes(rows: CleanQuote[]): CleanQuote[] {
  const map = new Map<string, CleanQuote>();
  for (const r of rows) {
    const key = [r.carrier, r.pols.join(","), r.pod, r.validFrom ?? "", r.validTo ?? ""].join("|");
    const prev = map.get(key);
    if (!prev) { map.set(key, r); continue; }
    const merge = (k: "p20" | "p40" | "pNor") => {
      if (prev[k] != null && r[k] != null && prev[k] !== r[k]) {
        const tag = "同条运价三列价冲突，取较早一条";
        if (!prev.unverified.includes(tag)) prev.unverified.push(tag);
        return prev[k];
      }
      return prev[k] ?? r[k];
    };
    map.set(key, {
      ...prev,
      p20: merge("p20"), p40: merge("p40"), pNor: merge("pNor"),
      note: dedupe([prev.note, r.note].filter(Boolean)).join("；"),
      msgTime: [prev.msgTime, r.msgTime].filter(Boolean).sort().pop() ?? prev.msgTime,
      etd: prev.etd ?? r.etd,
      freeDays: prev.freeDays ?? r.freeDays,
      imageUrl: prev.imageUrl ?? r.imageUrl,
      unverified: dedupe([...prev.unverified, ...r.unverified]).slice(0, 6),
    });
  }
  return [...map.values()];
}

export interface PolGroup { pol: string; count: number; cheapest: number | null; cheapestCol: string | null }

/** 按起运港分组给最低价与条数（不指定起运港时用它答，混排挑最低会报错港） */
export function groupByPol(rows: CleanQuote[]): PolGroup[] {
  const out = new Map<string, PolGroup>();
  for (const r of rows) {
    const pols = r.pols.length ? r.pols : [r.polText || "未标注"];
    for (const pol of pols) {
      const g = out.get(pol) ?? { pol, count: 0, cheapest: null, cheapestCol: null };
      g.count += 1;
      for (const [col, v] of [["20GP", r.p20], ["40HQ/HC", r.p40], ["40NOR", r.pNor]] as const) {
        if (v == null) continue;
        if (g.cheapest == null || v < g.cheapest) { g.cheapest = v; g.cheapestCol = col; }
      }
      out.set(pol, g);
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

const usd = (n: number | null) => (n != null ? `$${n.toLocaleString("en-US")}` : "—");

/** 第一张表（工作结果）：字段顺序锁死，见规范 §3 */
export function cleanTableMarkdown(rows: CleanQuote[], max = 20): string {
  const head = ["| 船司 | 起运港 | 目的港 | 20GP | 40HQ/HC | 40NOR | 目免 | 有效期 | 备注 | 来源 | 发送人 | 入库时间 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|"];
  const body = rows.slice(0, max).map(r =>
    `| ${r.carrier || "—"} | ${r.polText || "—"} | ${r.pod || "—"} | ${usd(r.p20)} | ${usd(r.p40)} | ${usd(r.pNor)} `
    + `| ${r.freeDays ?? "—"} | ${r.validFrom || r.validTo ? fmtValidity(r.validFrom, r.validTo) : (r.validityRaw ?? "—")} `
    + `| ${r.note || "—"} | ${r.source || "—"} | ${r.sender || "—"} | ${(r.syncedAt ?? "").slice(0, 10) || "—"} |`);
  return [...head, ...body].join("\n");
}

/** 十值口岸 → 客户报价表英文港名（对外报价表 POL 列全大写英文；未映射的回落原文大写） */
const POL_EN: Record<string, string> = {
  "蛇口": "SHEKOU", "盐田": "YANTIAN", "南沙": "NANSHA", "华南基本港": "SOUTH CHINA",
  "上海": "SHANGHAI", "厦门": "XIAMEN", "宁波": "NINGBO", "青岛": "QINGDAO",
  "天津": "TIANJIN", "大连": "DALIAN",
};

// ── 客户表 REMARK 英化（用户定案：客户报价表全英文，中文/内部信息一律不出现在对外交付物里）──
// 台账备注是中文群消息原文（内部操作语），这里做有限词表的机械替换；
// 换完仍含中文 → 整条置 "/"（宁可空，绝不中英混排给客户）。

/** 内部信息整条判丢：这些词进了客户表就是事故（成本价、内部舱位操作状态…） */
const INTERNAL_REMARK = /成本价|底价|刷箱|批价|锁价|可以申请|抢舱|保舱|特价合约|合约舱|内部|对比\s*FAK/;

/** 备注机械译英词表（有序：先中英文边界补空格防粘连，长模式在前） */
const NOTE_EN: Array<[RegExp, string]> = [
  [/([A-Za-z0-9%$])(?=[\u4e00-\u9fa5])/g, "$1 "],
  [/([\u4e00-\u9fa5])(?=[A-Za-z0-9])/g, "$1 "],
  [/重柜费\s*[:：]/g, "Heavy-duty surcharge: "],
  [/随机抽单收碳排放/g, "random carbon audit"],
  [/毛重/g, "gross weight"],
  [/(\d+(?:\.\d+)?)\s*吨\s*及以上/g, "$1t and above "],
  [/低于\s*(\d+(?:\.\d+)?)\s*吨/g, " under $1t "],
  [/(\d+(?:\.\d+)?)\s*吨/g, "$1t "],
  [/可(?=\s*[-+])/g, " "],
  [/含\s*/g, " incl. "],
  [/降价更新/g, "rate update"],
  [/参考价格/g, "ref. rate"],
  [/图片价格表/g, "price sheet"],
  [/可以继续收货/g, "open for booking"],
  [/拖班到\s*/g, "shifted to "],
  [/delay\s*至\s*/gi, "delayed to "],
  [/现舱/g, "spot space"],
  [/舱位/g, "space"],
  [/开船/g, "sailing"],
  [/截关/g, "closing"],
  [/高柜/g, "HQ"],
  [/南美东/g, "S.America"],
  [/南美西/g, "W.S.America"],
  [/加勒比/g, "Caribbean"],
  [/中美洲/g, "Central America"],
  [/地东/g, "Med-E"],
  [/地西/g, "Med-W"],
  [/蛇口/g, "SHEKOU"], [/盐田/g, "YANTIAN"], [/南沙/g, "NANSHA"],
  [/宁波/g, "NINGBO"], [/青岛/g, "QINGDAO"], [/天津/g, "TIANJIN"],
  [/上海/g, "SHANGHAI"], [/厦门/g, "XIAMEN"], [/大连/g, "DALIAN"],
  [/（/g, "("], [/）/g, ")"],
  [/，/g, ", "], [/；/g, "; "], [/：/g, ": "],
];

/** 客户报价表专用：内部备注判丢 → 有限词表译英 → 残中文置 "/"。导出供单测。 */
export function customerRemarkEn(raw: string | null | undefined): string {
  const s = (raw || "").trim();
  if (!s) return "/";
  if (INTERNAL_REMARK.test(s)) return "/";
  let out = s;
  for (const [re, en] of NOTE_EN) out = out.replace(re, en);
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,;])/g, "$1").trim();
  return /[\u4e00-\u9fa5]/.test(out) ? "/" : (out || "/");
}

/** 客户报价表：列与占位锁死（POL/POD 唯一全大写、缺项 "/"、TT 恒 "/"），多起运港拆行 */
export function customerQuoteMarkdown(rows: CleanQuote[], max = 20): string {
  const head = ["| CARRIER | POL | POD | 20GP | 40HQ/HC | 40NOR | FT | ETD | VALIDITY | TT | REMARK |",
    "|---|---|---|---|---|---|---|---|---|---|---|"];
  const body: string[] = [];
  for (const r of rows) {
    const pols = r.pols.length ? r.pols : [r.polText];
    for (const pol of pols.slice(0, 3)) {
      if (body.length >= max) break;
      const polEn = POL_EN[pol] ?? (pol || "");
      body.push(`| ${r.carrier || "/"} | ${polEn.toUpperCase() || "/"} | ${(r.pod || "").toUpperCase() || "/"} `
        + `| ${r.p20 ?? "/"} | ${r.p40 ?? "/"} | ${r.pNor ?? "/"} | ${r.freeDays ?? "/"} `
        + `| ${fmtEtdShort(r.etd)} | ${fmtValidity(r.validFrom, r.validTo)} | / | ${customerRemarkEn(r.note)} |`);
    }
  }
  return [...head, ...body].join("\n");
}
