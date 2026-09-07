# 查运价实现规范（执行版：可粘贴核心代码 + 接线清单 + 验收断言）

日期：2026-09-07　执行者：标准模型会话
业务规范（规则来源，冲突时以它为准）：`docs/rates-query-spec.md`
匹配与定论（已实现，本轮不改其语义）：`docs/rates-query-fallback-spec.md`

**范围**：只做查询侧。不改台账（board）、不重灌数据、不动心跳写入口径、不加新工具、不动审批红线。

---

## 0. 执行须知（红线与坑，违反即返工）

1. **只改本文件列出的文件**。工作区若有他人未提交的改动（`git status` 里出现不在清单内的文件）不要碰、不要 checkout、不要 stash。
2. **不要手写 `needsApproval`**：审批闸门在 `buildHarnessTools` 返回处按注册表派生（`tools.ts` 末尾），手写字段无效且会被锁测判失败。本轮不新增工具，正常情况碰不到。
3. **改 schema 必须同步四处**：`src/main/db/schema/rates.ts` + `src/main/db/schema-sql.ts`（`BASE_SCHEMA_SQL`）+ `src/main/db/index.ts`（`runMigrations` 的 ALTER 守卫）+ 手工沙箱 DDL（`grep -rn "CREATE TABLE rate_quotes" tests/`，当前在 `tests/unit/agent-tools-inbox.test.ts`）。漏一处 → drizzle 全列 INSERT 报 `no column named etd`，整套测试崩。
4. **别用脚本改代码**：`.ts`/`.tsx` 一律用 Edit/Write 工具；`Edit` 的 `old_string` 必须覆盖到整块结尾，只圈块首会把旧尾巴留在文件里（本仓库踩过一次，产生重复代码块）。改完立刻 `npx tsc --noEmit`。
5. **纯函数不许有 IO**：`rates-clean.ts` 里不得出现 `getDb()`、`fs`、`fetch`、`Log`。触库的一律留在 `rate-sync.service.ts`。
6. **原文 `message_text` 只在主进程内部流转**：不得进 `QuoteDto`、不得进任何 IPC 返回（页面轮询整表会把几 KB×全量拖进渲染进程，本仓库踩过这个坑）。
7. 中文文件跑校验脚本要 `PYTHONUTF8=1`；vitest 里 `await import(...)` 必须写在所有 `vi.mock(...)` 之后。
8. 每步做完跑一次 `npx tsc --noEmit`；全部做完跑 `npm run typecheck && npm test && npm run build`，三绿才算完。

---

## 1. 文件清单

**新建**
- `src/main/services/rates-clean.ts`（读侧清洗器，纯函数）
- `tests/unit/rates-clean.test.ts`（清洗器单测）

**修改**
- `src/main/db/schema/rates.ts`（`rate_quotes` 补 `etd`/`status`/`messageText` 三列）
- `src/main/db/schema-sql.ts`（`BASE_SCHEMA_SQL` 里 `rate_quotes` 补三列）
- `src/main/db/index.ts`（`runMigrations` 补 `rate_quotes` 的 ALTER 守卫）
- `src/main/services/rate-sync.service.ts`（`stripLaneTag` 外迁、`mapRemoteRow` 补三字段、`QuoteFilters.termLanes`、`listQuotesForClean`、`laneCandidates`、`autoRefreshIfStale`）
- `src/main/services/agent/tools.ts`（`quote_search` 接清洗器；入参加 `forCustomer`；删标准层调用）
- `src/renderer/pages/rates/RateBoard.tsx`（列表显示归一）
- `tests/unit/agent-tools-inbox.test.ts`（沙箱 DDL 补三列）
- `tests/unit/rates-query-fallback.test.ts`（沙箱走 `BASE_SCHEMA_SQL` 自动带上三列；补 etd 断言）

**删除**
- `src/main/services/rates-standard.ts`（`loadStandard`/`queryStandard`/`standardToMarkdown`/`podRawExpansion`/`laneOfPod` 全删；`resolveQueryPod` 与词表加载**搬进** `rates-clean.ts`）
- 保留不动：`src/main/services/rates-portmap.json`（词表，随包内联）、`data/rates-standard.json`（文件留在磁盘但**程序不再读**）、`scripts/build-rates-standard.py`（离线脚本，下一期改成只产词表，本轮不动）

---

## 2. 步骤一：镜像补三列

### 2.1 `src/main/db/schema/rates.ts`

在 `rateQuotes` 里 `imageName` 之后、`syncedAt` 之前插入（保持列序可读）：

```ts
  etd:          text("etd"),                    // 船期 ETD（源端文本，读侧再归一为 YYYY-MM-DD）
  status:       text("status"),                 // 记录状态（台账口径：当前生效/已被覆盖）
  messageText:  text("message_text"),           // 消息原文 raw：三列价的解析素材大多只在这里，不过 IPC
```

### 2.2 `src/main/db/schema-sql.ts`

`CREATE TABLE IF NOT EXISTS rate_quotes (...)` 里 `image_name text,` 之后加一行：

```sql
  etd text, status text, message_text text,
```

### 2.3 `src/main/db/index.ts`

`runMigrations()` 里已有 `send_queue` 的列守卫写法（`PRAGMA table_info` → 缺列才 ALTER）。照同一模式，在其后追加：

```ts
  // 运价镜像补列（etd/status/原文）：老库缺列会让 drizzle 全列 INSERT 直接崩，必须逐列守卫
  const rcols = (raw.prepare("PRAGMA table_info(rate_quotes)").all() as Array<{ name: string }>).map(c => c.name);
  if (rcols.length) {
    if (!rcols.includes("etd")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN etd text;"); added = true; }
    if (!rcols.includes("status")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN status text;"); added = true; }
    if (!rcols.includes("message_text")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN message_text text;"); added = true; }
  }
```

（若该函数里 `added` 变量名不同，沿用文件里已有的同名标志；没有就不要引入，直接删掉 `added = true;`。）

### 2.4 手工沙箱 DDL

`tests/unit/agent-tools-inbox.test.ts` 的 `CREATE TABLE rate_quotes (...)` 末尾 `image_name text,` 之后补：

```sql
  etd text, status text, message_text text,
```

用 `grep -rn "CREATE TABLE rate_quotes" tests/` 确认没有第二个手工沙箱漏掉。

---

## 3. 步骤二：新建 `src/main/services/rates-clean.ts`（整份粘贴）

```ts
// ── 读侧运价清洗器：纯函数，页面与助手共用一份 ─────────────────────
// 台账仍是脏长表：起运港粘连多港、目的港带中文译名与国别括注、一柜型一行、
// 「1000/2000」这类多价表述只活在原文里。这里在**查询时**把它洗成规范形态，不写回库。
// 本文件禁止 IO（不碰 getDb/fs/fetch/Log）；触库的查询留在 rate-sync.service.ts。
// 规范：docs/rates-query-spec.md §2、docs/rates-query-impl-spec.md
import portmapJson from "./rates-portmap.json";

// ══ 起运港：固定十值 ═══════════════════════════════════════════════
export const POL_STANDARD = [
  "蛇口", "南沙", "盐田", "华南基本港", "上海", "厦门", "宁波", "青岛", "天津", "大连",
] as const;
export type PolStandard = typeof POL_STANDARD[number];

/** 起运港别名/港区 → 固定值。深圳是港区集合，不猜一个，三个都给（呈现与报价表再按港拆行） */
const POL_ALIASES: Record<string, PolStandard[]> = {
  "深圳": ["蛇口", "盐田", "南沙"], "SHENZHEN": ["蛇口", "盐田", "南沙"], "SZX": ["蛇口", "盐田", "南沙"],
  "蛇口": ["蛇口"], "SHEKOU": ["蛇口"],
  "盐田": ["盐田"], "YANTIAN": ["盐田"],
  "南沙": ["南沙"], "NANSHA": ["南沙"], "NSA": ["南沙"],
  "广州": ["南沙"], "GUANGZHOU": ["南沙"],
  "华南基本港": ["华南基本港"], "华南": ["华南基本港"],
  "上海": ["上海"], "SHANGHAI": ["上海"], "SHA": ["上海"],
  "厦门": ["厦门"], "XIAMEN": ["厦门"], "XMN": ["厦门"],
  "宁波": ["宁波"], "宁波港": ["宁波"], "NINGBO": ["宁波"], "NGB": ["宁波"], "NGBO": ["宁波"],
  "青岛": ["青岛"], "QINGDAO": ["青岛"], "TAO": ["青岛"],
  "天津": ["天津"], "天津新港": ["天津"], "新港": ["天津"], "TIANJIN": ["天津"], "TSN": ["天津"], "XINGANG": ["天津"],
  "大连": ["大连"], "DALIAN": ["大连"], "DLC": ["大连"],
};
const POL_SPLIT_RE = /[/、,，;；&|()\s]+/;

// ══ 船司：国际标准缩写 ═════════════════════════════════════════════
const CARRIER_ALIASES: Record<string, string> = {
  "中远海特": "COSCO", "中远海运": "COSCO", "中远": "COSCO", "COSCO": "COSCO", "CSC": "COSCO",
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

// ══ 航线小字与区域词 ═══════════════════════════════════════════════
const LANE_TAGS = [
  "地东", "地西", "欧地", "欧西", "地中海", "黑海", "波海", "波罗的海", "红海", "波斯湾", "阿拉伯海",
  "南亚", "东南亚", "西非", "东非", "北非", "北欧", "大洋洲",
  "加勒比", "墨西哥", "南美东", "南美西", "中美洲", "美东", "美西",
];

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CN_RE = /[\u4e00-\u9fa5]/;
const PRICE_RE3 = /(\d[\d,]{2,8})\s*\/\s*(\d[\d,]{2,8})\s*\/\s*(\d[\d,]{2,8})/;
const PRICE_RE2 = /(\d[\d,]{2,8})\s*\/\s*(\d[\d,]{2,8})(?!\s*\/)/;
const RE_HIGH = /高\s*柜?\s*[:：]?\s*(\d[\d,]{2,8})/;
const RE_SMALL = /小\s*柜?\s*[:：]?\s*(\d[\d,]{2,8})/;
const RE_NOR = /NOR\s*[:：]?\s*(\d[\d,]{2,8})/i;
/** 40GP 归 40HQ|HC 列（规范：40HQ/HC 通常同价不做区分，40GP 同列） */
const COL_OF: Record<string, "p20" | "p40" | "pNor"> = {
  "20GP": "p20", "20HC": "p20",
  "40HQ": "p40", "40HC": "p40", "40GP": "p40", "45HQ": "p40",
  "NOR": "pNor", "40NOR": "pNor", "20NOR": "pNor",
};

function dedupe<T>(xs: T[]): T[] { return [...new Set(xs)]; }
function pad(x: string | number): string { return String(x).padStart(2, "0"); }
function money(s: string | null | undefined): number | null {
  const n = Number(String(s ?? "").replace(/[$,\s]|USD/gi, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
function sanePrice(n: number): number | null { return n >= 100 && n <= 30000 ? Math.round(n) : null; }

/** 北京时间今日 YYYY-MM-DD（有效期与状态都按北京时间判） */
export function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 目的港尾巴上可能粘连台账网页里的小字航线标签（"ISTANBUL 伊斯坦布尔(土耳其) 地东"）。
 * 护栏：只剥最后一个空白分隔、长度 ≤6、不含括号的尾段——
 * 正常形态 "BALBOA, PA 巴尔博亚(巴拿马)" 绝不会被切碎。
 */
export function stripLaneTag(podRaw: string, lane: string | null): { podRaw: string; lane: string | null } {
  const s = podRaw.trim();
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

/** 用户输入的港口（任意写法）→ 词表标准港名；认不出就原样大写返回（不猜） */
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

/** 起运港原文 → 固定十值集合（多港拆开、去重保序）；归不了的原文进 unverified，不猜 */
export function cleanPol(raw: string | null | undefined): { pols: PolStandard[]; leftovers: string[]; unverified: string[] } {
  const s = (raw ?? "").trim();
  if (!s) return { pols: [], leftovers: [], unverified: [] };
  const direct = POL_ALIASES[s] ?? POL_ALIASES[s.toUpperCase()];
  if (direct) return { pols: dedupe(direct), leftovers: [], unverified: [] };
  const parts = s.replace(/全口岸|全部口岸|多港/g, " ").split(POL_SPLIT_RE).map(x => x.trim()).filter(Boolean);
  const pols: PolStandard[] = [];
  const leftovers: string[] = [];
  for (const p of parts) {
    const hit = POL_ALIASES[p] ?? POL_ALIASES[p.toUpperCase()];
    if (hit) pols.push(...hit); else leftovers.push(p);
  }
  const uniq = dedupe(pols);
  if (!uniq.length) return { pols: [], leftovers: [s], unverified: [`起运港未归一：${s}`] };
  return {
    pols: uniq, leftovers,
    unverified: leftovers.length ? [`起运港部分未归一：${leftovers.join("/")}`] : [],
  };
}

function onePod(seg: string): string {
  let s = stripLaneTag(seg.trim(), null).podRaw;
  s = s.replace(/[（(][^（）()]*[)）]\s*$/, "").trim();      // 去掉尾部括注：(土耳其)/(巴拿马)
  const cn = s.search(CN_RE);
  if (cn > 0) s = s.slice(0, cn).trim();                    // 英文港名后跟中文译名 → 只留英文
  s = s.replace(/,\s*[A-Z]{2}$/i, "").trim();               // "BALBOA, PA" → BALBOA
  s = s.replace(/^(?:PORT OF|PORT)\s+/i, "").trim();
  return resolveQueryPod(s) || s;
}

/** 目的港原文 → 标准英文唯一港名集合（剥译名/国别/航线小字，多港拆开）；仍带中文则标 unverified */
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
  if (!pods.length) return { pods: [s], unverified: [`目的港未标准化：${s}`] };
  return { pods, unverified };
}

/** 船司 → 国际标准缩写；三字码原样采信，其余归不了就保留原文并标 unverified */
export function cleanCarrier(raw: string | null | undefined): { carrier: string; unverified: string[] } {
  const s = (raw ?? "").trim();
  if (!s) return { carrier: "", unverified: [] };
  const up = s.toUpperCase();
  const hit = CARRIER_ALIASES[s] ?? CARRIER_ALIASES[up] ?? CARRIER_ALIASES[up.replace(/\s+/g, "")];
  if (hit) return { carrier: hit, unverified: [] };
  if (/^[A-Z]{3}$/.test(up)) return { carrier: up, unverified: [] };
  return { carrier: s, unverified: [`船司未归一：${s}`] };
}

export interface ThreePrices { p20: number | null; p40: number | null; pNor: number | null; unverified: string[] }

/**
 * 三列柜型价（宽表在读侧合成）：结构化字段优先，原文里的多价表述只填空，
 * 都解析不出就留空并标 unverified——不填 0、不猜、不推算。
 * 支持："1000/2000"（20GP/40HQ）、"1000/2000/1200"（+40NOR）、"高 2000"、"小 1000"、"NOR 1200"。
 */
export function parsePrices(o: {
  container: string | null; oceanUsd: number | null; messageText: string | null; note: string | null;
}): ThreePrices {
  const out: ThreePrices = { p20: null, p40: null, pNor: null, unverified: [] };
  const col = COL_OF[(o.container ?? "").trim().toUpperCase()];
  if (col && o.oceanUsd != null) {
    const v = sanePrice(o.oceanUsd);
    if (v != null) out[col] = v;
    else out.unverified.push(`价格可疑（${o.oceanUsd}），未采信`);
  }
  const fill = (k: "p20" | "p40" | "pNor", raw: string | null | undefined) => {
    const v = money(raw);
    if (v == null || out[k] != null) return;
    const sane = sanePrice(v);
    if (sane != null) out[k] = sane;
  };
  const txt = `${o.messageText ?? ""} ${o.note ?? ""}`;
  const m3 = PRICE_RE3.exec(txt);
  if (m3) { fill("p20", m3[1]); fill("p40", m3[2]); fill("pNor", m3[3]); }
  else { const m2 = PRICE_RE2.exec(txt); if (m2) { fill("p20", m2[1]); fill("p40", m2[2]); } }
  fill("p40", RE_HIGH.exec(txt)?.[1]);
  fill("p20", RE_SMALL.exec(txt)?.[1]);
  fill("pNor", RE_NOR.exec(txt)?.[1]);
  if (out.p20 == null && out.p40 == null && out.pNor == null) out.unverified.push("价：三列未解析");
  return out;
}

/** 目免：0-30 采信；越界或非数字转备注，不丢弃 */
export function cleanFreeDays(raw: string | null | undefined): { days: number | null; intoNote: string | null } {
  const s = (raw ?? "").trim();
  if (!s) return { days: null, intoNote: null };
  const n = Number(s.replace(/[^\d]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return { days: null, intoNote: `目免无法解析（${s}），已转备注` };
  if (n > 30) return { days: null, intoNote: `目免异常（${s}），已转备注` };
  return { days: n, intoNote: null };
}

/** ETD → YYYY-MM-DD：支持 "9.6"/"ETD9.6"/"2026-09-06"/"9月6日"；缺年份按参考时间推，落在过去则 +1 年 */
export function cleanEtd(raw: string | null | undefined, refIso?: string | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
  const md = /(?:etd\s*[:：]?\s*)?(\d{1,2})\s*[.\-/月]\s*(\d{1,2})\s*日?/i.exec(s);
  if (!md) return null;
  const m = Number(md[1]);
  const d = Number(md[2]);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const ref = refIso ? new Date(refIso) : new Date();
  const baseYear = Number.isNaN(ref.getTime()) ? new Date().getFullYear() : ref.getFullYear();
  const mk = (y: number) => `${y}-${pad(m)}-${pad(d)}`;
  return mk(baseYear) < todayBeijing() ? mk(baseYear + 1) : mk(baseYear);
}

export type QuoteState = "当前有效" | "已过期";
/** 记录状态由有效期函数判断（不新增存储列）：无止日视为长期有效 */
export function quoteState(validTo: string | null | undefined, today = todayBeijing()): QuoteState {
  return !validTo || validTo >= today ? "当前有效" : "已过期";
}

/** 有效期 → 报价格式："1-15 Sep"（同月）/"31 Aug – 6 Sep"（跨月）/"16 Sep"（单边） */
export function fmtValidity(from: string | null | undefined, to: string | null | undefined): string {
  const d = (s: string | null | undefined) => {
    const mt = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
    return mt ? { mo: Number(mt[1]), dy: Number(mt[2]) } : null;
  };
  const a = d(from);
  const b = d(to);
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
  freeDays: string | null; etd: string | null; validFrom: string | null; validTo: string | null;
  note: string | null; sourceGroup: string | null; sender: string | null; msgTime: string | null;
  syncedAt: string | null; status: string | null; messageText: string | null;
}

/** 清洗后的规范行（呈现与报价表都从这里出） */
export interface CleanQuote {
  carrier: string;
  pols: PolStandard[]; polText: string;
  pod: string; pods: string[]; lane: string | null;
  p20: number | null; p40: number | null; pNor: number | null;
  freeDays: number | null; etd: string | null;
  validFrom: string | null; validTo: string | null; state: QuoteState;
  note: string; source: string; sender: string;
  msgTime: string | null; syncedAt: string | null; imageUrl: string | null;
  unverified: string[];
}

/** 一行镜像 → 一行规范运价（纯函数）。imageUrl 由调用方拼好传入（清洗器不碰网络/配置） */
export function cleanQuoteRow(row: QuoteRowRaw, imageUrl: string | null = null): CleanQuote {
  const pol = cleanPol(row.pol);
  const pod = cleanPod(row.podRaw);
  const carrier = cleanCarrier(row.carrier);
  const prices = parsePrices(row);
  const free = cleanFreeDays(row.freeDays);
  const etd = cleanEtd(row.etd, row.msgTime);
  const notes = dedupe([row.note, free.intoNote].filter((x): x is string => !!x && !!x.trim()));
  return {
    carrier: carrier.carrier,
    pols: pol.pols,
    polText: pol.pols.length ? pol.pols.join("/") : (pol.leftovers[0] ?? (row.pol ?? "").trim()),
    pod: pod.pods[0] ?? "",
    pods: pod.pods,
    lane: stripLaneTag(row.podRaw ?? "", row.lane).lane,
    p20: prices.p20, p40: prices.p40, pNor: prices.pNor,
    freeDays: free.days,
    etd,
    validFrom: row.validFrom ?? null,
    validTo: row.validTo ?? null,
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
        if (!prev.unverified.includes("同条运价三列价冲突，取较早一条")) prev.unverified.push("同条运价三列价冲突，取较早一条");
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

/** 按起运港分组给最低价与条数（不指定起运港时用它答，避免混排挑最低报错港） */
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
    + `| ${r.freeDays ?? "—"} | ${r.validFrom || r.validTo ? fmtValidity(r.validFrom, r.validTo) : "—"} `
    + `| ${r.note || "—"} | ${r.source || "—"} | ${r.sender || "—"} | ${(r.syncedAt ?? "").slice(0, 10) || "—"} |`);
  return [...head, ...body].join("\n");
}

/** 客户报价表：列与占位规则锁死，见规范 §4（POL 唯一、缺失一律 "/"、TT 恒 "/"） */
export function customerQuoteMarkdown(rows: CleanQuote[], max = 20): string {
  const head = ["| CARRIER | POL | POD | 20GP | 40HQ/HC | 40NOR | FT | ETD | VALIDITY | TT | REMARK |",
    "|---|---|---|---|---|---|---|---|---|---|---|"];
  const body: string[] = [];
  for (const r of rows) {
    const pols = r.pols.length ? r.pols : [r.polText];
    for (const pol of pols.slice(0, 3)) {
      if (body.length >= max) break;
      body.push(`| ${r.carrier || "/"} | ${(pol || "").toUpperCase() || "/"} | ${(r.pod || "").toUpperCase() || "/"} `
        + `| ${r.p20 ?? "/"} | ${r.p40 ?? "/"} | ${r.pNor ?? "/"} | ${r.freeDays ?? "/"} `
        + `| ${fmtEtdShort(r.etd)} | ${fmtValidity(r.validFrom, r.validTo)} | / | ${r.note || "/"} |`);
    }
  }
  return [...head, ...body].join("\n");
}
```

---

## 4. 步骤三：`rate-sync.service.ts` 接线

### 4.1 `stripLaneTag` 外迁

删掉本文件里的 `LANE_TAGS` 常量与 `stripLaneTag` 函数，改为：

```ts
import { stripLaneTag } from "./rates-clean";
```

（`mapRemoteRow` / `mapRemoteSpace` 里对 `stripLaneTag` 的调用不用改。若本文件里 `todayBeijing()` 与 `rates-clean` 的同名函数重复，删掉本文件那份，改为从 `rates-clean` 导入。）

### 4.2 `mapRemoteRow` 补三字段

在返回对象里 `imageName:` 之后加：

```ts
    etd: pick(row, ["etd"]),
    status: pick(row, ["status"]),
    messageText: pick(row, ["message_text", "messageText"]),
```

### 4.3 过滤条件加航线展开

`QuoteFilters` 里加一个字段（`terms` 之后）：

```ts
  /** 由镜像实时反推的航线候选（查 SANTOS 时 podRaw/lane 只写「南美东」的航线级行也要命中） */
  termLanes?: string[];
```

`quoteConds()` 的 `terms` 循环改成：

```ts
  const lanes = (f.termLanes ?? []).filter(Boolean);
  for (const t of f.terms ?? []) {
    const w = t.trim();
    if (!w) continue;
    conds.push(or(
      like(rateQuotes.lane, `%${w}%`), like(rateQuotes.podRaw, `%${w}%`), like(rateQuotes.pol, `%${w}%`),
      ...(lanes.length ? [inArray(rateQuotes.lane, lanes)] : []),
    ));
  }
```

（`inArray` 已在文件顶部从 `drizzle-orm` 导入；没有就加进那条 import。）

### 4.4 航线归属实时反推（取代旧 `podRawExpansion`）

在 `quoteOptions` 附近新增：

```ts
/**
 * 从镜像实时反推「这个词属于哪些航线」：Santos 在库里出现过 → 取它的 lane（南美东），
 * 于是目的港只写「南美东」的航线级报价也能命中。不养第二份死词表。
 */
export function laneCandidates(words: string[], limit = 5): string[] {
  const ws = [...new Set(words.map(w => (w ?? "").trim()).filter(w => w.length > 0))];
  if (!ws.length) return [];
  const db = getDb();
  const lanes = new Set<string>();
  for (const w of ws) {
    const rows = db.select({ lane: rateQuotes.lane }).from(rateQuotes)
      .where(or(like(rateQuotes.podRaw, `%${w}%`), like(rateQuotes.pol, `%${w}%`), like(rateQuotes.lane, `%${w}%`)))
      .limit(200).all();
    for (const r of rows) if (r.lane && r.lane.trim()) lanes.add(r.lane.trim());
    if (lanes.size >= limit) break;
  }
  return [...lanes].slice(0, limit);
}
```

### 4.5 清洗专用查询（含原文，不过 IPC）

在 `listQuotes` 之后新增：

```ts
/** 清洗器专用：返回含原文的完整行 + 拼好的截图 URL（原文只在主进程内部用，绝不进 QuoteDto / IPC） */
export function listQuotesForClean(f: QuoteFilters): Array<QuoteRowRaw & { imageUrl: string | null }> {
  const conds = quoteConds(f);
  const base = REMOTE_BASE.replace(/\/$/, "");
  return getDb().select({
    carrier: rateQuotes.carrier, pol: rateQuotes.pol, podRaw: rateQuotes.podRaw, lane: rateQuotes.lane,
    container: rateQuotes.container, containerRaw: rateQuotes.containerRaw, oceanUsd: rateQuotes.oceanUsd,
    freeDays: rateQuotes.freeDays, etd: rateQuotes.etd, validFrom: rateQuotes.validFrom, validTo: rateQuotes.validTo,
    note: rateQuotes.note, sourceGroup: rateQuotes.sourceGroup, sender: rateQuotes.sender,
    msgTime: rateQuotes.msgTime, syncedAt: rateQuotes.syncedAt, status: rateQuotes.status,
    messageText: rateQuotes.messageText, imageName: rateQuotes.imageName,
  }).from(rateQuotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(rateQuotes.oceanUsd)
    .limit(Math.min(f.limit ?? 20, 500))
    .all()
    .map(({ imageName, ...rest }) => ({
      ...rest,
      imageUrl: imageName ? `${base}/images/${encodeURIComponent(imageName)}` : null,
    }));
}
```

（`QuoteRowRaw` 从 `./rates-clean` 导入；`imageName` **不进** `QuoteRowRaw` 类型，只在本函数里消费成 `imageUrl`。）

### 4.6 自动刷新（缓存重建，节流 + 超时）

```ts
let autoRefreshing: Promise<boolean> | null = null;

/**
 * 查价路径上的自动刷新：镜像可疑（超过 minAgeMinutes 没同步）时静默重拉一次再查。
 * 定级：本地缓存重建（只重写 rate_quotes/space_records，不碰业务表、不外发），
 * 失败保留旧数据 —— 见 docs/rates-query-spec.md §5。
 * 节流：10 分钟内不重复刷、并发只跑一次、整次同步最多等 timeoutMs。
 */
export async function autoRefreshIfStale(opts: { minAgeMinutes?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const minAge = (opts.minAgeMinutes ?? 10) * 60_000;
  const timeout = opts.timeoutMs ?? 20_000;
  const at = lastSync?.at ? Date.parse(lastSync.at) : 0;
  if (at && Date.now() - at < minAge) return false;
  if (autoRefreshing) return autoRefreshing;
  autoRefreshing = Promise.race([
    sync().then(r => r.success),
    new Promise<boolean>(res => setTimeout(() => res(false), timeout)),
  ]).finally(() => { autoRefreshing = null; });
  const ok = await autoRefreshing;
  Log.debug("rates.auto", ok ? "查价前自动刷新镜像完成" : "查价前自动刷新未完成（用旧镜像继续答）");
  return ok;
}
```

---

## 5. 步骤四：`quote_search` 接线（`src/main/services/agent/tools.ts`）

### 5.1 入参加一个扁平布尔

`quoteSearchSchema` 末尾加：

```ts
  forCustomer: optBool().describe("用户已同意「做成客户报价表」时才传 true：返回 CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK 十一列报价表。未同意就不要传，也不要自己生成客户报价表"),
```

### 5.2 导入替换

删掉：

```ts
import { queryStandard, standardToMarkdown, resolveQueryPod, podRawExpansion } from "../rates-standard";
```

换成：

```ts
import { resolveQueryPod, cleanQuoteRow, pivotQuotes, groupByPol, cleanTableMarkdown, customerQuoteMarkdown } from "../rates-clean";
```

`rate-sync.service` 那条导入补上 `laneCandidates, autoRefreshIfStale, listQuotesForClean, type QuoteRowRaw`。

### 5.3 execute 主体替换（从 `const podQ = trimmed(args.pod);` 到 `return total === 0 ? payload : finishRead(...)` 整段）

```ts
      const podQ = trimmed(args.pod);
      const qQ = trimmed(args.q);
      const laneQ = trimmed(args.lane)?.replace(/航线$/, "").replace(/线$/, "").trim() || undefined;
      // L1 机械层：每个词各自跨字段 OR（航线/目的港/起运港），词之间 AND——
      // 「地东」是航线还是港名不由机械层猜、也不由模型猜（猜错字段就是漏查）
      const termWords = [...new Set([qQ, laneQ, podQ].filter((x): x is string => !!x)
        .flatMap(w => [w, resolveQueryPod(w)].map(t => t.trim()).filter(Boolean)))];
      // 航线归属实时从镜像反推（Santos→南美东），目的港只写航线名的航线级报价才命中
      const termLanes = laneCandidates(termWords);
      const filters = {
        carrier: trimmed(args.carrier)?.toUpperCase(),
        terms: termWords.length ? termWords : undefined,
        termLanes: termLanes.length ? termLanes : undefined,
        container: normalizeContainer(trimmed(args.container) ?? null) ?? trimmed(args.container)?.toUpperCase() ?? undefined,
        includeExpired: args.includeExpired ?? undefined,
      };
      const limit = args.limit && args.limit > 0 ? args.limit : 20;
      // 镜像可疑（没同步过 / 超 24h / 本轮还没命中）时先静默刷一次再查：
      // 同步只重写本地镜像表，不外发、失败保留旧数据（缓存重建定级，见规范 §5）
      const attempt = ctx.counts?.get("quote_search") ?? 1;
      await autoRefreshIfStale({ minAgeMinutes: 1440 });
      const rows = listQuotesForClean({ ...filters, limit });
      const total = countQuotes(filters);
      // 读侧清洗：起运港十值归一、目的港标准英文名、船司缩写、三列柜型价（原文里的 1000/2000 也解析）
      const cleaned = pivotQuotes(rows.map(r => cleanQuoteRow(r, r.imageUrl)));
      const byPol = groupByPol(cleaned);
      const unverified = [...new Set(cleaned.flatMap(c => c.unverified))].slice(0, 6);
      const cleanTable = cleaned.length ? cleanTableMarkdown(cleaned) : "";
      const customerTable = (args.forCustomer && cleaned.length) ? customerQuoteMarkdown(cleaned) : "";
      // 舱位与运价同行（规则）：同一次调用并联查舱位镜像；附带查询不打挂主查询
      let spaces: SpaceDto[] = [];
      try {
        const sp = listSpaces({ terms: termWords.length ? termWords : undefined, carrier: filters.carrier, limit: 8 });
        if (sp.success) spaces = sp.data;
      } catch { /* 宁可不带舱位，也不让查价失败 */ }
      const spaceTable = spaces.length
        ? [
          "| 舱位动态 | 船名航次 | ETD | 截关 | 航线 | 目的港 | 柜型/箱量 | 价格USD | 时间 | 来源群 |",
          "|---|---|---|---|---|---|---|---|---|---|",
          ...spaces.map(s => `| ${s.spaceType ?? "—"} | ${s.vessel ?? "—"} | ${s.etd ?? "—"} | ${s.cutoffRaw ?? "—"} `
            + `| ${s.lane ?? "—"} | ${s.podRaw ?? "—"} | ${[s.container, s.boxQty].filter(Boolean).join(" ") || "—"} `
            + `| ${s.priceUsd ?? "—"} | ${s.msgTime ?? "—"} | ${s.sourceGroup ?? "—"} |`),
        ].join("\n")
        : "";
      // 时效行：每次都要有（镜像条数 / 最近同步 / 真源可达性）。
      // 可达性是三态：null=本轮没探测（命中时不花这个网络等待），false=探测过且连不上
      const opts = quoteOptions();
      const reachable = total === 0 ? await probeBoardCached() : null;
      const freshness = {
        rows: opts.rows,
        latestSyncAt: opts.latestSyncAt,
        remoteHost: (() => { try { return new URL(remoteBase()).host; } catch { return remoteBase(); } })(),
        reachable,
      };
      const cheapest = cleaned[0] ?? null;
      const answer = cheapest
        ? `最低 ${usdText(cheapest)}（${cheapest.carrier || "—"} · ${cheapest.polText || "—"}→${cheapest.pod || "—"}），共 ${total} 条。`
        : "";
      const noticeLines: string[] = [];
      if (total === 0) {
        // L2/L3：查不到 ≠ 没有。第一轮回候选让模型换词重试，两轮不过才定论
        const likeWords = termWords.map(w => w.toLowerCase());
        const score = (v: string) => {
          const s = v.toLowerCase();
          if (likeWords.some(w => s.includes(w) || w.includes(s))) return 0;
          return likeWords.some(w => { for (let i = 0; i + 2 <= w.length; i++) if (s.includes(w.slice(i, i + 2))) return true; return false; }) ? 1 : 2;
        };
        const rank = <T extends { v: string; c: number }>(items: T[]): T[] =>
          [...items].sort((a, b) => score(a.v) - score(b.v) || b.c - a.c).slice(0, 12);
        const candidates = { lanes: rank(opts.lanes), pods: rank(opts.pods) };
        const syncAt = opts.latestSyncAt ? beijingTime(opts.latestSyncAt) : "未知（本次运行还没同步过）";
        const stale = !opts.latestSyncAt || Date.now() - Date.parse(opts.latestSyncAt) > 24 * 3600_000;
        noticeLines.push(attempt <= 1
          ? "机械匹配第一轮没命中，这不是「库里没有」。candidates 是本地镜像里真实存在的航线与目的港（带条数，已按贴合度排序）："
            + "请判断用户说的词是否对应其中某一项（区域简称、中英文译名、同一航线的不同叫法都算）。"
            + "对得上就换成 candidates 里的原值再查一次（重试一次为限，别用同样的词重复调用）；对不上再等下一轮结论。"
          : (reachable === false || stale
            ? `两轮都没命中。本地镜像共 ${opts.rows} 条、最近同步 ${syncAt}，局域网台账${reachable === false ? "现在连不上" : "可达"}`
              + "——很可能是镜像没跟上真源。请照实说「本地镜像里查不到这条」，不要说成「该航线没有报价」；"
              + "再给用户两条路：到「运价库」页点同步刷新镜像，或让你联网查当前市场行情。"
            : `两轮都没命中，且镜像刚同步过（${syncAt}）、台账可达——可以确定台账里没有这个航线/港口。`
              + "请如实告诉用户库里没有，并问一句要不要你联网查当前市场行情；用户明确同意前不要自行联网。"));
        const out = {
          total: 0, count: 0, quotes: [], cleaned: [], cleanTable: "", customerTable: "", answer: "",
          byPol: [], unverified, freshness, candidates, spaceCount: spaces.length,
          ...(spaces.length ? { spaces, spaceTable } : {}),
          empty: true, notice: noticeLines.join("\n"),
          ...(attempt > 1 ? {
            actions: [
              navAction("去运价页同步镜像", "#/rates"),
              promptAction("联网查市场行情",
                `本地镜像没查到「${termWords.join(" ") || "这个航线"}」的运价。请联网调研该航线当前的市场行情与船期，`
                + "回答时注明这是外部行情、不是公司台账报价。"),
            ],
          } : {}),
        };
        audit(ctx, "quote_search", "read", args, out, "auto");
        return okOut(out);                            // 空结果不进读缓存：同词重试要真跑，才走得到定论
      }
      noticeLines.push(rows.length < total
        ? `共命中 ${total} 条，本批返回 ${rows.length} 条，回答时必须注明。`
        : "命中数据已全部返回，无需再调用本工具，直接作答。");
      noticeLines.push(
        "回答格式（固定，勿自由发挥）：第一句用 answer 字段（数字与船司不改）；"
          + "未指定起运港时按 byPol 分组说（每个起运港给最低价与条数），不要把不同起运港的价混成一句；"
          + "明细表已由界面渲染，正文禁止再手写整张表。",
        "客户要报价表时才走第二步：先问一句「要不要把这份价做成可发客户的报价表？」，"
          + "用户同意后带 forCustomer=true 再调一次本工具，把返回的 customerTable 原样贴出（列已锁死，缺项是 /，TT 恒为 /，不要补）。"
          + "未同意就不要生成客户报价表，也不要自己编列名。",
        unverified.length
          ? `有 ${unverified.length} 项字段没洗干净（${unverified.join("；")}）：回答里必须如实说明哪几项待核实，不得静默抹平或自行补值。`
          : "字段已全部归一，无需额外说明。",
        `时效固定一行：镜像 ${freshness.rows} 条 · 最近同步 ${freshness.latestSyncAt ? beijingTime(freshness.latestSyncAt) : "未知"} · 台账 ${freshness.remoteHost}${freshness.reachable === false ? "（现在连不上）" : ""}；镜像价为参考价，以船司实时报价为准。`,
      );
      if (spaces.length) {
        noticeLines.push(
          `相关舱位动态 ${spaces.length} 条（最近 21 天，见 spaceTable）：回答必须在运价之后再用一两句带上——`
          + "舱位类型、船名航次、ETD、截关、箱量一律照表里的原值说，不得编造或推算；"
          + "并补一句「舱位为群内动态，以订舱时确认为准」。售罄/撤载改期/截关这类负面动态必须一并说，不能只挑有舱的报。",
        );
      } else {
        noticeLines.push("本次没有该航线/港口最近 21 天的舱位动态。如实说「舱位这边没有近期动态，需要时我再查」，不要拿更早的记录或外部印象当现状。");
      }
      const out = {
        total, count: rows.length, quotes: rows.map(({ messageText: _mt, ...rest }) => rest),
        cleaned, cleanTable,
        ...(customerTable ? { customerTable } : {}),
        answer, byPol, unverified, freshness,
        spaceCount: spaces.length,
        ...(spaces.length ? { spaces, spaceTable } : {}),
        ...(rows.length >= total ? { complete: true } : {}),
        say: `共 ${total} 条` + (args.q || args.lane || args.pod || args.carrier || args.container
          ? `（当前筛选条件下的命中数）` : `（镜像库全量）`)
          + `，返回 ${rows.length} 条${cheapest ? `，最低 ${usdText(cheapest)}` : ""}`
          + `；相关舱位动态 ${spaces.length} 条`,
        actions: [
          ...(args.forCustomer ? [] : [promptAction("做成客户报价表", "把刚才查到的运价做成可发客户的报价表（CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK，缺项用 / 占位）")]),
          promptAction("按这批价写一封报价信", "根据刚才查到的运价，选最便宜的那条给客户写一封报价信，注明有效期和「以船司实时报价为准」的提醒；刚才那批相关舱位动态（船名航次/ETD/截关/舱位类型）也一并写进去，并注明舱位以订舱时确认为准"),
          navAction("在运价库筛选", "#/rates"),
        ],
      };
      audit(ctx, "quote_search", "read", args, out, "auto");
      return finishRead(ctx, "quote_search", args, okOut(out));
```

同文件里补一个小工具函数（放在 `quote_search` 之前的模块作用域，`beijingTime` 附近）：

```ts
/** 清洗后的三列价里挑最低的那一个说结论（宽表行没有单一 oceanUsd 了） */
function usdText(q: { p20: number | null; p40: number | null; pNor: number | null }): string {
  const vals = [q.p20, q.p40, q.pNor].filter((n): n is number => n != null);
  if (!vals.length) return "议价";
  const min = Math.min(...vals);
  return `$${min.toLocaleString("en-US")}`;
}
```

> 注意：`quotes` 字段保持"镜像行形状"（前端表格卡只认前若干键），但**必须剥掉 `messageText`**（原文不过 IPC/事件）。
> `cleaned` 才是规范宽表行，供模型与两张 markdown 表用。
> `pod`/`podExtra` 两个旧过滤字段不再由工具传（`terms` + `termLanes` 已覆盖），但 `QuoteFilters` 里保留它们给页面用。

---

## 6. 步骤五：运价页显示归一（`src/renderer/pages/rates/RateBoard.tsx`）

本轮**不改布局**，只把显示值洗干净（页面与助手共用清洗器，杜绝两套真相）：

1. 顶部导入：`import { cleanPod, cleanPol, cleanCarrier } from "../../../main/services/rates-clean";`
   （渲染端引主进程纯函数模块：该文件无 IO、无 node 内建依赖，可直接被 Vite 打包；若 `rates-portmap.json` 的 import 在渲染端报错，改为把三个清洗函数抽到 `src/shared/rates-clean.ts` 并让主进程也从那里导入。）
2. 列表列的 `render`：
   - 目的港列：`(_, r) => cleanPod(r.podRaw).pods.join(" / ") || r.podRaw`
   - 起运港列：`(_, r) => cleanPol(r.pol).pols.join("/") || r.pol || "—"`
   - 船司列：`(_, r) => cleanCarrier(r.carrier).carrier || r.carrier || "—"`
3. 筛选不变（目的港框已经走 `terms` 跨字段并集）。
4. 页面**不要**渲染 `messageText`（IPC 已经不返回它）。

---

## 7. 步骤六：删标准层

1. 删文件 `src/main/services/rates-standard.ts`。
2. `grep -rn "rates-standard" src tests` 应只剩注释/文档；`tools.ts` 的导入按 §5.2 换掉。
3. 删掉 `tools.ts` 里 `stdRows`、`standardCount`、以及"customerTable 已是标准化透视表"那段旧 notice 文本（§5.3 的新代码已不含它们）。
4. `data/rates-standard.json` 与 `scripts/build-rates-standard.py` **保留在仓库**（下一期把脚本改成只产词表），但程序不再读；若发现仍有 `RATES_STANDARD_PATH` 环境变量引用，一并删掉。

---

## 8. 步骤七：新建 `tests/unit/rates-clean.test.ts`（整份粘贴）

```ts
import { describe, it, expect } from "vitest";
import {
  cleanPol, cleanPod, cleanCarrier, parsePrices, cleanFreeDays, cleanEtd, quoteState,
  stripLaneTag, fmtValidity, fmtEtdShort, cleanQuoteRow, pivotQuotes, groupByPol,
  customerQuoteMarkdown, cleanTableMarkdown, type QuoteRowRaw,
} from "../../src/main/services/rates-clean";

const row = (o: Partial<QuoteRowRaw> = {}): QuoteRowRaw => ({
  carrier: null, pol: null, podRaw: null, lane: null, container: null, containerRaw: null,
  oceanUsd: null, freeDays: null, etd: null, validFrom: null, validTo: null, note: null,
  sourceGroup: null, sender: null, msgTime: null, syncedAt: null, status: null, messageText: null, ...o,
});

describe("起运港：固定十值 + 多港拆开", () => {
  it("深圳归到蛇口/盐田/南沙三个候选，不猜一个", () => {
    expect(cleanPol("深圳").pols).toEqual(["蛇口", "盐田", "南沙"]);
  });
  it("全口岸长串按白名单逐个提取，提取不出的进 leftovers", () => {
    const r = cleanPol("全口岸（大连/香港/高雄/基隆/宁波/青岛/上海/蛇口/深圳/新加坡/厦门/天津新港/盐田）");
    expect(r.pols).toContain("大连");
    expect(r.pols).toContain("天津");
    expect(r.pols).toContain("蛇口");
    expect(r.pols).not.toContain("香港");          // 非十值白名单，不硬塞
    expect(r.leftovers.join("")).toContain("香港");
    expect(r.unverified.length).toBeGreaterThan(0);
  });
  it("归不了的值原样保留并标待核实", () => {
    expect(cleanPol("火星港").pols).toEqual([]);
    expect(cleanPol("火星港").unverified[0]).toContain("火星港");
  });
});

describe("目的港：标准英文唯一名", () => {
  it("剥中文译名与国别括注、剥尾部航线小字", () => {
    expect(cleanPod("ISTANBUL 伊斯坦布尔(土耳其) 地东").pods).toEqual(["ISTANBUL"]);
    expect(cleanPod("BALBOA, PA 巴尔博亚(巴拿马)").pods).toEqual(["BALBOA"]);
    expect(cleanPod("SANTOS 桑托斯(巴西)").pods).toEqual(["SANTOS"]);
  });
  it("多港拆开且去重", () => {
    expect(cleanPod("SANTOS/PARANAGUA").pods).toEqual(["SANTOS", "PARANAGUA"]);
    expect(cleanPod("SANTOS / SANTOS").pods).toEqual(["SANTOS"]);
  });
  it("洗不出英文就标待核实，不猜", () => {
    expect(cleanPod("某个没见过的港").unverified.length).toBeGreaterThan(0);
  });
});

describe("船司：国际标准缩写", () => {
  it("中文与长名归一", () => {
    expect(cleanCarrier("中远海特").carrier).toBe("COSCO");
    expect(cleanCarrier("CMA CGM").carrier).toBe("CMA");
    expect(cleanCarrier("马士基").carrier).toBe("MSK");
  });
  it("未知三字码原样采信，其余标待核实", () => {
    expect(cleanCarrier("XYZ").carrier).toBe("XYZ");
    expect(cleanCarrier("某船司").unverified.length).toBe(1);
  });
});

describe("三列柜型价：结构化优先，原文多价只填空", () => {
  it("container+oceanUsd 直接入列（40HC 归 40HQ|HC，40GP 同列）", () => {
    expect(parsePrices({ container: "40HC", oceanUsd: 1800, messageText: null, note: null }).p40).toBe(1800);
    expect(parsePrices({ container: "40GP", oceanUsd: 1700, messageText: null, note: null }).p40).toBe(1700);
    expect(parsePrices({ container: "20GP", oceanUsd: 1000, messageText: null, note: null }).p20).toBe(1000);
    expect(parsePrices({ container: "NOR", oceanUsd: 1200, messageText: null, note: null }).pNor).toBe(1200);
  });
  it("原文 1000/2000 与 1000/2000/1200", () => {
    expect(parsePrices({ container: null, oceanUsd: null, messageText: "MSC 桑托斯 1000/2000 现舱", note: null }))
      .toMatchObject({ p20: 1000, p40: 2000, pNor: null });
    expect(parsePrices({ container: null, oceanUsd: null, messageText: "1000/2000/1200", note: null }))
      .toMatchObject({ p20: 1000, p40: 2000, pNor: 1200 });
  });
  it("高 2000 / 小 1000", () => {
    expect(parsePrices({ container: null, oceanUsd: null, messageText: "高 2000 小1000", note: null }))
      .toMatchObject({ p20: 1000, p40: 2000 });
  });
  it("结构化值不被原文覆盖", () => {
    expect(parsePrices({ container: "20GP", oceanUsd: 6815, messageText: "1000/2000", note: null }).p20).toBe(6815);
  });
  it("解析不出就三列全空并标待核实（不填 0、不猜）", () => {
    const r = parsePrices({ container: null, oceanUsd: null, messageText: "价格面议", note: null });
    expect([r.p20, r.p40, r.pNor]).toEqual([null, null, null]);
    expect(r.unverified.join()).toContain("三列未解析");
  });
  it("可疑价格不采信", () => {
    expect(parsePrices({ container: "20GP", oceanUsd: 999999, messageText: null, note: null }).p20).toBeNull();
  });
});

describe("目免 / ETD / 有效期 / 状态", () => {
  it("目免 0-30 采信，越界转备注", () => {
    expect(cleanFreeDays("14").days).toBe(14);
    expect(cleanFreeDays("14天").days).toBe(14);
    expect(cleanFreeDays("45")).toMatchObject({ days: null });
    expect(cleanFreeDays("45").intoNote).toContain("备注");
  });
  it("ETD 多写法归一为 YYYY-MM-DD，过去日期进位到明年", () => {
    expect(cleanEtd("2026-09-06")).toBe("2026-09-06");
    expect(cleanEtd("ETD9.6", "2026-09-03")).toMatch(/^\d{4}-09-06$/);
    expect(cleanEtd("9月6日", "2026-09-03")).toMatch(/^\d{4}-09-06$/);
    expect(cleanEtd(null)).toBeNull();
    expect(cleanEtd("船期待定")).toBeNull();
  });
  it("有效期报价格式与状态计算", () => {
    expect(fmtValidity("2026-09-01", "2026-09-15")).toBe("1-15 Sep");
    expect(fmtValidity("2026-08-31", "2026-09-06")).toBe("31 Aug – 6 Sep");
    expect(fmtValidity(null, "2026-09-16")).toBe("16 Sep");
    expect(fmtValidity(null, null)).toBe("/");
    expect(fmtEtdShort("2026-09-16")).toBe("16 Sep");
    expect(fmtEtdShort(null)).toBe("/");
    expect(quoteState("2099-12-31")).toBe("当前有效");
    expect(quoteState(null)).toBe("当前有效");
    expect(quoteState("2000-01-01")).toBe("已过期");
  });
});

describe("清洗成行 / 宽表透视 / 按港分组", () => {
  it("一行镜像 → 一行规范运价（含尾缀航线小字归位）", () => {
    const c = cleanQuoteRow(row({
      carrier: "中远海特", pol: "深圳", podRaw: "ISTANBUL 伊斯坦布尔(土耳其) 地东", lane: null,
      container: "40HQ", oceanUsd: 1800, freeDays: "14", etd: "2026-09-18",
      validFrom: "2026-09-01", validTo: "2099-12-31", note: "AMS 另加 30",
      sourceGroup: "航线动态群", sender: "张三", msgTime: "2026-09-03", syncedAt: "2026-09-07T01:00:00.000Z",
    }));
    expect(c.carrier).toBe("COSCO");
    expect(c.pols).toEqual(["蛇口", "盐田", "南沙"]);
    expect(c.pod).toBe("ISTANBUL");
    expect(c.lane).toBe("地东");                    // 尾缀剥下来回填 lane
    expect(c.p40).toBe(1800);
    expect(c.freeDays).toBe(14);
    expect(c.etd).toBe("2026-09-18");
    expect(c.state).toBe("当前有效");
    expect(c.unverified).toEqual([]);
  });

  it("同船司同港同效期的多柜型行合并成一行三列", () => {
    const merged = pivotQuotes([
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "20GP", oceanUsd: 1000, validTo: "2099-12-31" })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "40HQ", oceanUsd: 2000, validTo: "2099-12-31" })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "NOR", oceanUsd: 1200, validTo: "2099-12-31" })),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ p20: 1000, p40: 2000, pNor: 1200 });
  });

  it("按起运港分组给最低价与条数（多港行在每个港都计一次）", () => {
    const g = groupByPol(pivotQuotes([
      cleanQuoteRow(row({ carrier: "MSC", pol: "天津", podRaw: "SANTOS", container: "20GP", oceanUsd: 3200 })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "20GP", oceanUsd: 3000 })),
      cleanQuoteRow(row({ carrier: "CMA", pol: "深圳", podRaw: "SANTOS", container: "40HQ", oceanUsd: 2500 })),
    ]));
    expect(g.map(x => x.pol)).toContain("天津");
    expect(g.find(x => x.pol === "青岛")?.cheapest).toBe(3000);
    expect(g.find(x => x.pol === "蛇口")?.cheapest).toBe(2500);   // 深圳拆出来的候选港
  });
});

describe("两张表的形态", () => {
  const rows = pivotQuotes([cleanQuoteRow(row({
    carrier: "COSCO", pol: "宁波", podRaw: "MANZANILLO 曼萨尼略(墨西哥) 墨西哥", lane: "墨西哥",
    container: "40HQ", oceanUsd: 1800, freeDays: "7", etd: "2026-09-16",
    validFrom: "2026-09-01", validTo: "2026-09-15", sourceGroup: "墨西哥群", sender: "李四",
    msgTime: "2026-09-03", syncedAt: "2026-09-07T01:00:00.000Z", note: "含 AMS",
  }))]);

  it("工作结果表：字段顺序锁死", () => {
    const t = cleanTableMarkdown(rows);
    expect(t.split("\n")[0]).toBe("| 船司 | 起运港 | 目的港 | 20GP | 40HQ/HC | 40NOR | 目免 | 有效期 | 备注 | 来源 | 发送人 | 入库时间 |");
    expect(t).toContain("COSCO");
    expect(t).toContain("MANZANILLO");
    expect(t).toContain("1-15 Sep");
  });

  it("客户报价表：十一列、缺项与 TT 一律 /", () => {
    const t = customerQuoteMarkdown(rows);
    expect(t.split("\n")[0]).toBe("| CARRIER | POL | POD | 20GP | 40HQ/HC | 40NOR | FT | ETD | VALIDITY | TT | REMARK |");
    const body = t.split("\n")[2]!;
    expect(body).toContain("| NINGBO |");           // POL 唯一港名全大写
    expect(body).toContain("| MANZANILLO |");
    expect(body).toContain("| 16 Sep |");           // ETD 报价格式
    expect(body).toContain("| / | / |");            // 40NOR 与 TT 缺项占位
    expect(body.split("|").length).toBe(13);        // 11 列 + 首尾空段
  });

  it("多起运港在客户表里拆行（POL 唯一）", () => {
    const multi = pivotQuotes([cleanQuoteRow(row({
      carrier: "MSC", pol: "深圳", podRaw: "SANTOS", container: "20GP", oceanUsd: 3000, validTo: "2099-12-31",
    }))]);
    const lines = customerQuoteMarkdown(multi).split("\n").slice(2);
    expect(lines.length).toBe(3);                    // 蛇口 / 盐田 / 南沙 各一行
    expect(lines.join()).toContain("SHEKOU");
  });
});

describe("尾缀剥离护栏", () => {
  it("正常形态不切碎", () => {
    expect(stripLaneTag("BALBOA, PA 巴尔博亚(巴拿马)", "加勒比").podRaw).toBe("BALBOA, PA 巴尔博亚(巴拿马)");
    expect(stripLaneTag("PANAMA (MANZANILLO PA/BALBOA)", "加勒比").podRaw).toBe("PANAMA (MANZANILLO PA/BALBOA)");
    expect(stripLaneTag("MANZANILLO", "墨西哥").podRaw).toBe("MANZANILLO");
  });
});
```

> 若 `customerQuoteMarkdown` 的表头与断言不一致，**以规范 §4 的列序为准改代码，不要改断言**。

---

## 9. 验收

1. `npx tsc --noEmit` 无输出。
2. `npm test`：新增 `rates-clean.test.ts` 全绿；`rates-query-fallback.test.ts`、`rates-normalize.test.ts`、`agent-tools-inbox.test.ts` 仍全绿（后两者若因新增列报 `no column named etd` → 回 §2.4 补沙箱 DDL）。
3. `npm run build` 通过。
4. `grep -rn "rates-standard\|queryStandard\|standardToMarkdown\|podRawExpansion" src` 结果为空（只允许出现在注释里）。
5. `grep -rn "messageText" src/renderer src/main/transport` 结果为空（原文不外泄）。
6. 手测（dev，主进程不热更要重启）：
   - 「深圳到Santos的价格」→ 起运港按蛇口/盐田/南沙分组，价带来源与时效行，无"暂无该航线"式措辞；
   - 「地东的价格」→ 本机镜像没有地东：应先自动刷一次（连不上台账则秒失败），再按三段式回候选、第二轮定论为"镜像没跟上真源"，给同步/联网两个出口；
   - 「宁波到曼萨尼略 40HQ」→ 命中后问一句要不要客户报价表，回"要"之后才出十一列表，TT 为 `/`。

## 10. 下一期（本轮不做，规范已记）

台账入库层做实宽表与标准名（`docs/rates-query-spec.md` §7）：`freight_rates` 改列、多港拆行、
三列价在入库解析、图片复用、`记录状态` 由有效期函数判断、相同信息源的补充挂回原条目（`supersedes`/`root_key`）、
新增「动态与行情」表与每日 AI 总结定时器。做完这一期，读侧清洗器降级为兜底。
