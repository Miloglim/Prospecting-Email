# 查运价实现规范（执行版：可粘贴核心代码 + 接线清单 + 验收断言）

日期：2026-09-07　执行者：标准模型会话
业务规范（规则来源，冲突时以它为准）：`docs/rates-query-spec.md`
匹配与定论（已实现，本轮不改其语义）：`docs/rates-query-fallback-spec.md`

**范围**：只做查询侧。不改台账（board）、不重灌数据、不动心跳写入口径、不加新工具、不动审批红线。

## 0. 真源实测（2026-09-07 16:10 抓的，写代码前必读）

真源已从内网换成公网 HTTPS：`https://l5ruag9m.qwenwork.host`（`RATES_REMOTE_URL` 可覆盖）。
`/api/stats` → `ratesTotal 3748 / spaceTotal 381 / latestMessage 2026-09-07 15:06`。
**本地镜像只有 428 行**（落后一个数量级），重启程序会自动同步；调试前先在运价页点一次「同步」。

实测到的真实形态（清洗规则全部照这些写，不要凭想象）：

| 项 | 实测值 |
|---|---|
| `route`（航线）枚举 | 北非、地东、黑海、加勒比、拉美、美东、美西、墨西哥、南美东、南美西、欧基港、中美洲 |
| `container_type` 枚举 | **`20GP` / `40HQ/HC` / `40NOR`**（约 4.5% 为 null）——注意 `40HQ/HC` 是一个值，不是两个 |
| `carrier` 枚举（26 个） | 合德、外运、未注明、中远海特、SINOTRANS 外运、AKKON、CMA、COSCO、CUL、EMC、EMI、ESL、FESCO、GSL、HMM、HPL、MSC、MSK、ONE、OOCL、PIL、RCL、TSL、WHL、YML、ZIM |
| `pol` 脏形态 | `青岛+太仓+南沙`、`蛇口/香港/盐田/厦门`、`盐田/蛇口`、`太仓+南沙`、`天津新港（Xingang）`、`天津新港（XINGANG）`、`深圳`、`大铲湾`、`SGH/NPO/YAT/YOK/BUS；TST/HSK`、`Dalian, Dalian, Liaoning, China;…;Shekou, Shenzhen, Guangdong, China;…` |
| `pod` | 已是干净英文单港（`ALIAGA`、`MERSIN`），舱位表偶见首字母大写（`Santos`） |
| `freight_usd` | 单值字符串（`"4800"`），**全库 0 行含斜杠**——多价只在 `message_text` |
| `free_days` | **全库为 null**；目免只在 `remark`/`message_text`，且按国别分（"埃及目免21，土耳其14"、"21 combined"） |
| `valid_to` | 约 45% 有值；`validity_raw` 形如 `9.1~9.30`，也可能是船期（`直航快船CLS 9.11`） |
| `etd` | 约 20% 有值；原文里形如 `9.21 蛇口-IZMIT 3高 BEX TEXAS TRIUMPH 0BXOLW1MA`、`9.6晚开9.10`（前截关后开船） |
| `space_type` 枚举 | 现舱、放舱开放、加班船、箱子动态、舱位紧张、截关截单、售罄、撤载改期（**没有"约舱"**） |
| `origin` / `images` | 新增字段（`heartbeat`、图片数组），本轮不入镜像 |

真实原文样例 A（一条消息被拆成 4 个 pod 行，价对四港共享）：

```
CMA 土耳其推广 9.1~9.30   一水  5高    不能 电放  可以 SW或者正本
POL 盐田/蛇口   南沙
ISTANBUL/ IZMIT/ MERSIN/ ALIAGA
USD3300/3900+
21 combined
现舱
9.21   蛇口 -IZMIT   3高     BEX  TEXAS  TRIUMPH  0BXOLW1MA
9.16   蛇口-ISTanbul   1高   COSCO SHIPPING ROSE 0BXOJW1MA
```
→ 该行 `pod=ALIAGA, container_type=40HQ/HC, freight_usd=3900`：**20GP=3300 只存在于原文**，且这四个港同价。

真实原文样例 B（同一条消息里不同港不同价 —— **错价高危**）：

```
南沙 CUL  直航快船CLS9.11
ALEX   4200/5100
ISTANBUL/MERSIN/ALIAGA 4100/4800
ETD-6取消，亏仓费CNY300/柜
埃及目免21，土耳其14，+USD150/300买21
```
→ `pod=ALIAGA` 的行必须取 `4100/4800`（20GP=4100、40HQ/HC=4800），**绝不能取 ALEX 那行的 4200/5100**；
→ 目免必须取"土耳其14"，**绝不能取"埃及目免21"**。

---

## 1. 执行须知（红线与坑，违反即返工）

1. **只改本文件列出的文件**。工作区若有他人未提交的改动（`git status` 里出现不在清单内的文件）不要碰、不要 checkout、不要 stash。当前工作区已有一处他人改动：`REMOTE_BASE` 默认值换成了公网域名 —— **保留它，不要改回内网 IP**。
2. **不要手写 `needsApproval`**：审批闸门在 `buildHarnessTools` 返回处按注册表派生，手写无效且会被锁测判失败。本轮不新增工具。
3. **改 schema 必须同步四处**：`src/main/db/schema/rates.ts` + `src/main/db/schema-sql.ts`（`BASE_SCHEMA_SQL`）+ `src/main/db/index.ts`（`runMigrations` 的 ALTER 守卫）+ 手工沙箱 DDL（`grep -rn "CREATE TABLE rate_quotes" tests/`，当前在 `tests/unit/agent-tools-inbox.test.ts`）。漏一处 → drizzle 全列 INSERT 报 `no column named etd`，整套测试崩。
4. **别用脚本改代码**：`.ts`/`.tsx` 一律用 Edit/Write 工具；`Edit` 的 `old_string` 必须覆盖到整块结尾（只圈块首会把旧尾巴留在文件里，本仓库踩过）。每步改完立刻 `npx tsc --noEmit`。
5. **纯函数不许有 IO**：`rates-clean.ts` 里不得出现 `getDb()`、`fs`、`fetch`、`Log`。触库的留在 `rate-sync.service.ts`。
6. **原文 `message_text` 只在主进程内部流转**：不得进 `QuoteDto`、不得进任何 IPC 返回（页面轮询整表会把几 KB×全量拖进渲染进程）。
7. **不许猜**：归一不了的值一律保留原文 + 进 `unverified`，回答里如实说"待核实"。宁可少给一个字段，不可给错一个价。
8. vitest 里 `await import(...)` 必须写在所有 `vi.mock(...)` 之后；中文脚本要 `PYTHONUTF8=1`。
9. 每步做完 `npx tsc --noEmit`；全部做完 `npm run typecheck && npm test && npm run build`，三绿才算完。

---

## 2. 文件清单

**新建**：`src/main/services/rates-clean.ts`（读侧清洗器，纯函数）、`tests/unit/rates-clean.test.ts`
**修改**：`src/main/db/schema/rates.ts`、`src/main/db/schema-sql.ts`、`src/main/db/index.ts`、
`src/main/services/rate-sync.service.ts`、`src/main/services/agent/tools.ts`、
`src/renderer/pages/rates/RateBoard.tsx`、`tests/unit/agent-tools-inbox.test.ts`
**删除**：`src/main/services/rates-standard.ts`（`resolveQueryPod` 与词表加载搬进 `rates-clean.ts`）
**保留不动**：`src/main/services/rates-portmap.json`（词表）、`data/rates-standard.json`（不再被读）、`scripts/build-rates-standard.py`（下一期改成只产词表）

---

## 3. 步骤一：镜像补三列

### 3.1 `src/main/db/schema/rates.ts` — `rateQuotes` 里 `imageName` 之后插入

```ts
  etd:          text("etd"),                    // 船期 ETD（源端文本，读侧再归一为 YYYY-MM-DD）
  status:       text("status"),                 // 记录状态（台账口径：当前生效/已被覆盖）
  messageText:  text("message_text"),           // 消息原文 raw：三列价与目免的解析素材只在这里，不过 IPC
```

### 3.2 `src/main/db/schema-sql.ts` — `rate_quotes` 建表里 `image_name text,` 之后

```sql
  etd text, status text, message_text text,
```

### 3.3 `src/main/db/index.ts` — `runMigrations()` 里照 `send_queue` 的列守卫模式追加

```ts
  // 运价镜像补列：老库缺列会让 drizzle 全列 INSERT 直接崩，必须逐列守卫
  const rcols = (raw.prepare("PRAGMA table_info(rate_quotes)").all() as Array<{ name: string }>).map(c => c.name);
  if (rcols.length) {
    if (!rcols.includes("etd")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN etd text;"); added = true; }
    if (!rcols.includes("status")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN status text;"); added = true; }
    if (!rcols.includes("message_text")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN message_text text;"); added = true; }
  }
```

（`added` 用文件里已有的同名标志；没有就别引入，删掉 `added = true;`。）

### 3.4 `tests/unit/agent-tools-inbox.test.ts` 沙箱 DDL 的 `rate_quotes` 里同样补

```sql
  etd text, status text, message_text text,
```

---

## 4. 步骤二：新建 `src/main/services/rates-clean.ts`（整份粘贴）

```ts
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
  // 2) 原文：先只看含本行目的港的行
  const scoped = locatePodLines(o.messageText, o.pods);
  const fromText = (txt: string | null) => {
    if (!txt) return;
    const m = RE_PRICE_PAIR.exec(txt);
    if (m) {
      fill("p20", m[1]);
      fill("p40", m[2]);
      if (m[3]) fill("pNor", m[3]);
    }
    fill("p40", RE_HIGH.exec(txt)?.[1]);
    fill("p20", RE_SMALL.exec(txt)?.[1]);
  };
  fromText(scoped);
  // 3) 定位不到本港时：全篇只有一处多价 → 视为港组共享价采用；多处不同价 → 不猜
  if (!scoped && o.p20 == null && out.p20 == null && out.p40 == null) {
    const all = [...(o.messageText ?? "").matchAll(RE_PRICE_PAIR)].map(m => `${m[1]}/${m[2]}`);
    const uniq = dedupe(all);
    if (uniq.length === 1) fromText(o.messageText);
    else if (uniq.length > 1) out.unverified.push("原文多处价且未按港定位，未采信（需人工核对）");
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
  const take = (seg: string): number | null => {
    const m = RE_FREE_POD.exec(seg) ?? RE_FREE_BY_COUNTRY.exec(seg);
    const n = Number(m ? (m[2] ?? m[1]) : NaN);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // 按国别定位：取"国别词 + 目免数字"在同一片段里的那一处
  for (const c of countries) {
    const re = new RegExp(`${c}[^\\n，,。;；]{0,12}?(\\d{1,2})`, "i");
    const m = re.exec(txt);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 30) return { days: n, intoNote: null };
    }
  }
  const scoped = locatePodLines(o.messageText, o.pods);
  const v = take(scoped ?? "") ?? (() => {
    const all = [...txt.matchAll(RE_FREE_BY_COUNTRY)].map(m => Number(m[2]));
    return dedupe(all).length === 1 ? all[0]! : null;
  })();
  if (v != null && v > 0 && v <= 30) return { days: v, intoNote: null };
  if (v != null) return { days: null, intoNote: `目免异常（${v}），已转备注` };
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
    if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
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

/** 客户报价表：列与占位锁死（POL/POD 唯一全大写、缺项 "/"、TT 恒 "/"），多起运港拆行 */
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

## 5. 步骤三：`rate-sync.service.ts` 接线

1. **`stripLaneTag` 外迁**：删掉本文件里的 `LANE_TAGS` 与 `stripLaneTag`，改 `import { stripLaneTag, todayBeijing } from "./rates-clean";`（本文件原有的 `todayBeijing` 一并删掉，避免两份）。`mapRemoteRow` / `mapRemoteSpace` 的调用不用改。
2. **`mapRemoteRow` 补三字段**（`imageName:` 之后）：

```ts
    etd: pick(row, ["etd"]),
    status: pick(row, ["status"]),
    messageText: pick(row, ["message_text", "messageText"]),
```

3. **`QuoteFilters` 加航线展开字段**：

```ts
  /** 由镜像实时反推的航线候选（查 SANTOS 时 lane/podRaw 只写「南美东」的航线级行也要命中） */
  termLanes?: string[];
```

4. **`quoteConds()` 的 `terms` 循环改成**（`inArray` 已在文件顶部导入，没有就加）：

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

5. **航线归属实时反推**（取代已删的 `podRawExpansion`），放在 `quoteOptions` 附近：

```ts
/**
 * 从镜像实时反推「这个词属于哪些航线」：SANTOS 在库里出现过 → 取它的 lane（南美东），
 * 于是目的港只写航线名的航线级报价也能命中。不养第二份死词表。
 */
export function laneCandidates(words: string[], limit = 5): string[] {
  const ws = dedupeWords(words);
  if (!ws.length) return [];
  const db = getDb();
  const lanes = new Set<string>();
  for (const w of ws) {
    const rows = db.select({ lane: rateQuotes.lane }).from(rateQuotes)
      .where(or(like(rateQuotes.podRaw, `%${w}%`), like(rateQuotes.pol, `%${w}%`), like(rateQuotes.lane, `%${w}%`)))
      .limit(300).all();
    for (const r of rows) if (r.lane?.trim()) lanes.add(r.lane.trim());
    if (lanes.size >= limit) break;
  }
  return [...lanes].slice(0, limit);
}
function dedupeWords(words: string[]): string[] {
  return [...new Set((words ?? []).map(w => (w ?? "").trim()).filter(w => w.length > 0))];
}
```

6. **清洗专用查询**（`listQuotes` 之后；原文与截图 URL 只在这里出现，不进 `QuoteDto`）：

```ts
/** 清洗器专用：含原文的完整行 + 拼好的截图 URL（原文绝不进 QuoteDto / IPC） */
export function listQuotesForClean(f: QuoteFilters): Array<QuoteRowRaw & { imageUrl: string | null }> {
  const conds = quoteConds(f);
  const base = REMOTE_BASE.replace(/\/$/, "");
  return getDb().select({
    carrier: rateQuotes.carrier, pol: rateQuotes.pol, podRaw: rateQuotes.podRaw, lane: rateQuotes.lane,
    container: rateQuotes.container, containerRaw: rateQuotes.containerRaw, oceanUsd: rateQuotes.oceanUsd,
    freeDays: rateQuotes.freeDays, etd: rateQuotes.etd, validityRaw: rateQuotes.validityRaw,
    validFrom: rateQuotes.validFrom, validTo: rateQuotes.validTo,
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

（`QuoteRowRaw` 从 `./rates-clean` 导入。）

7. **自动刷新**（缓存重建定级：只重写两张镜像表，不碰业务数据、不外发，失败保留旧数据）：

```ts
let autoRefreshing: Promise<boolean> | null = null;

/**
 * 查价路径上的自动刷新：镜像超过 minAgeMinutes 没同步过就静默重拉一次再查。
 * 节流三条：minAgeMinutes 内不重复刷、并发只跑一次、整次最多等 timeoutMs（超时用旧镜像继续答）。
 */
export async function autoRefreshIfStale(opts: { minAgeMinutes?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const minAge = (opts.minAgeMinutes ?? 60) * 60_000;
  const timeout = opts.timeoutMs ?? 25_000;
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

8. **探测口径统一**：`probeBoard()` 现在用裸 `fetch`（当年为了绕开代理访问内网 IP）。真源已是公网 HTTPS，
   裸 fetch 在走企业代理的机器上反而可能失败，出现"探测说不通、同步却能通"的口径分裂。
   改成与 `sync()` 同一个通道：

```ts
export async function probeBoard(): Promise<boolean> {
  try {
    const res = await netFetch(`${REMOTE_BASE}/api/stats`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch { return false; }
}
```

（若 `netFetch` 的签名不支持 `signal`，就去掉 `signal` 参数，改用 `Promise.race` + 6 秒超时。**不要**为此改回裸 fetch。）

---

## 6. 步骤四：`quote_search` 接线（`src/main/services/agent/tools.ts`）

### 6.1 入参加一个扁平布尔（`quoteSearchSchema` 末尾）

```ts
  forCustomer: optBool().describe("用户已同意「做成客户报价表」时才传 true：返回 CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK 十一列报价表。用户没同意就不要传，也不要自己生成客户报价表"),
```

### 6.2 导入替换

删掉 `import { queryStandard, standardToMarkdown, resolveQueryPod, podRawExpansion } from "../rates-standard";`，换成：

```ts
import { resolveQueryPod, cleanQuoteRow, pivotQuotes, groupByPol, cleanTableMarkdown, customerQuoteMarkdown } from "../rates-clean";
```

`rate-sync.service` 那条导入补上 `laneCandidates, autoRefreshIfStale, listQuotesForClean, type QuoteRowRaw`（保留已有的 `listQuotes, countQuotes, listSpaces, normalizeContainer, quoteOptions, probeBoardCached, remoteBase, type SpaceDto`）。

### 6.3 模块作用域加一个小函数（放在 `beijingTime` 附近）

```ts
/** 清洗后的宽表行没有单一 oceanUsd，说结论时挑三列里最低的那个 */
function usdText(q: { p20: number | null; p40: number | null; pNor: number | null }): string {
  const vals = [q.p20, q.p40, q.pNor].filter((n): n is number => n != null);
  return vals.length ? `$${Math.min(...vals).toLocaleString("en-US")}` : "议价";
}
```

### 6.4 `execute` 主体（从 `const podQ = trimmed(args.pod);` 到函数末尾整段替换）

```ts
      const podQ = trimmed(args.pod);
      const qQ = trimmed(args.q);
      const laneQ = trimmed(args.lane)?.replace(/航线$/, "").replace(/线$/, "").trim() || undefined;
      // L1 机械层：每个词各自跨字段 OR（航线/目的港/起运港），词之间 AND ——
      // 「地东」是航线还是港名不由机械层猜、也不由模型猜（猜错字段就是漏查）
      const termWords = [...new Set([qQ, laneQ, podQ].filter((x): x is string => !!x)
        .flatMap(w => [w, resolveQueryPod(w)].map(t => t.trim()).filter(Boolean)))];
      // 镜像可疑就先静默刷一次再查（缓存重建：只重写镜像表、失败保留旧数据、25 秒超时）
      const attempt = ctx.counts?.get("quote_search") ?? 1;
      await autoRefreshIfStale({ minAgeMinutes: 60 });
      // 航线归属实时反推：SANTOS → 南美东，目的港只写航线名的航线级报价才命中
      const termLanes = laneCandidates(termWords);
      const filters = {
        carrier: trimmed(args.carrier)?.toUpperCase(),
        terms: termWords.length ? termWords : undefined,
        termLanes: termLanes.length ? termLanes : undefined,
        container: normalizeContainer(trimmed(args.container) ?? null) ?? trimmed(args.container)?.toUpperCase() ?? undefined,
        includeExpired: args.includeExpired ?? undefined,
      };
      const limit = args.limit && args.limit > 0 ? args.limit : 20;
      const rows = listQuotesForClean({ ...filters, limit });
      const total = countQuotes(filters);
      // 读侧清洗 + 宽表透视：起运港十值归一、目的港标准英文名、船司缩写、三列柜型价（按港定位原文再取价）
      const cleaned = pivotQuotes(rows.map(r => cleanQuoteRow(r, r.imageUrl)));
      const byPol = groupByPol(cleaned);
      const unverified = [...new Set(cleaned.flatMap(c => c.unverified))].slice(0, 6);
      const cleanTable = cleaned.length ? cleanTableMarkdown(cleaned) : "";
      const customerTable = (args.forCustomer && cleaned.length) ? customerQuoteMarkdown(cleaned) : "";
      // 舱位与运价同行（规则）：同批词并联查舱位镜像；附带查询不打挂主查询
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
      // 时效：每次都带（镜像条数/最近同步/真源可达性）。可达性三态：null=本轮没探测，false=探测过且连不上
      const opts = quoteOptions();
      const reachable: boolean | null = total === 0 ? await probeBoardCached() : null;
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
        const hasSub = (s: string, w: string) => {
          for (let i = 0; i + 2 <= w.length; i++) if (s.includes(w.slice(i, i + 2))) return true;
          return false;
        };
        const score = (v: string) => {
          const s = v.toLowerCase();
          if (likeWords.some(w => s.includes(w) || w.includes(s))) return 0;
          return likeWords.some(w => hasSub(s, w)) ? 1 : 2;
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
            ? `两轮都没命中。本地镜像共 ${opts.rows} 条、最近同步 ${syncAt}，台账 ${freshness.remoteHost}${reachable === false ? " 现在连不上" : " 可达"}`
              + "——很可能是镜像没跟上真源。请照实说「本地镜像里查不到这条」，不要说成「该航线没有报价」；"
              + "再给用户两条路：到「运价库」页点同步刷新镜像，或让你联网查当前市场行情。"
            : `两轮都没命中，且镜像刚同步过（${syncAt}）、台账可达——可以确定台账里没有这个航线/港口。`
              + "请如实告诉用户库里没有，并问一句要不要你联网查当前市场行情；用户明确同意前不要自行联网。"));
        const emptyOut = {
          total: 0, count: 0, quotes: [], cleaned: [], cleanTable: "", answer: "", byPol: [],
          unverified, freshness, candidates, spaceCount: spaces.length,
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
        audit(ctx, "quote_search", "read", args, emptyOut, "auto");
        return okOut(emptyOut);            // 空结果不进读缓存：同词重试要真跑，才走得到定论
      }

      noticeLines.push(rows.length < total
        ? `共命中 ${total} 条，本批返回 ${rows.length} 条，回答时必须注明。`
        : "命中数据已全部返回，无需再调用本工具，直接作答。");
      noticeLines.push(
        "回答格式（固定，勿自由发挥）：第一句用 answer 字段（数字与船司不改）；"
          + "未指定起运港时按 byPol 分组说（每个起运港给最低价与条数），不要把不同起运港的价混成一句——报错港比查不到更糟；"
          + "明细已由界面渲染成表格卡，正文禁止再手写整张表。",
        "客户要报价表才走第二步：先问一句「要不要把这份价做成可发客户的报价表？」，用户同意后带 forCustomer=true 再调一次本工具，"
          + "把返回的 customerTable 原样贴出（列已锁死，缺项是 /，TT 恒为 /，不要自己补值或改列名）。用户没同意就不要生成。",
        unverified.length
          ? `有 ${unverified.length} 项字段没洗干净（${unverified.join("；")}）：回答里必须如实说明哪几项待核实，不得静默抹平、不得自行补值。`
          : "字段已全部归一，无需额外说明。",
        `时效固定一行：镜像 ${freshness.rows} 条 · 最近同步 ${freshness.latestSyncAt ? beijingTime(freshness.latestSyncAt) : "未知"} · 台账 ${freshness.remoteHost}${freshness.reachable === false ? "（现在连不上）" : ""}；镜像价为参考价，以船司实时报价为准。`,
      );
      noticeLines.push(spaces.length
        ? `相关舱位动态 ${spaces.length} 条（最近 21 天，见 spaceTable）：回答必须在运价之后再用一两句带上——`
          + "舱位类型、船名航次、ETD、截关、箱量一律照表里的原值说，不得编造或推算；"
          + "售罄/撤载改期/截关截单/舱位紧张这类负面动态必须一并说，不能只挑有舱的报；"
          + "备注里出现「价格未生效」「在申请」这类字样要原样转述。末尾补一句「舱位为群内动态，以订舱时确认为准」。"
        : "本次没有该航线/港口最近 21 天的舱位动态。如实说「舱位这边没有近期动态，需要时我再查」，不要拿更早的记录或外部印象当现状。");

      const out = {
        total, count: rows.length,
        // quotes 保持镜像行形状（前端表格卡只认它），但必须剥掉 messageText —— 原文不过 IPC
        quotes: rows.map(({ messageText: _mt, ...rest }) => rest),
        cleaned, cleanTable, answer, byPol, unverified, freshness,
        ...(customerTable ? { customerTable } : {}),
        spaceCount: spaces.length,
        ...(spaces.length ? { spaces, spaceTable } : {}),
        ...(rows.length >= total ? { complete: true } : {}),
        say: `共 ${total} 条` + (args.q || args.lane || args.pod || args.carrier || args.container
          ? `（当前筛选条件下的命中数）` : `（镜像库全量）`)
          + `，返回 ${rows.length} 条${cheapest ? `，最低 ${usdText(cheapest)}` : ""}`
          + `；相关舱位动态 ${spaces.length} 条`,
        actions: [
          ...(args.forCustomer ? [] : [promptAction("做成客户报价表",
            "把刚才查到的运价做成可发客户的报价表（CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK，缺项用 / 占位）")]),
          promptAction("按这批价写一封报价信",
            "根据刚才查到的运价，选最便宜的那条给客户写一封报价信，注明有效期和「以船司实时报价为准」的提醒；"
            + "刚才那批相关舱位动态（船名航次/ETD/截关/舱位类型）也一并写进去，并注明舱位以订舱时确认为准"),
          navAction("在运价库筛选", "#/rates"),
        ],
      };
      audit(ctx, "quote_search", "read", args, out, "auto");
      return finishRead(ctx, "quote_search", args, okOut(out));
```

> `pod`/`podExtra` 两个旧过滤字段不再由工具传（`terms` + `termLanes` 已覆盖），但 `QuoteFilters` 里保留给页面用。
> 旧的 `stdRows` / `standardCount` / "customerTable 已是标准化透视表" 那段 notice 一并删除。

---

## 7. 步骤五：运价页显示归一（`src/renderer/pages/rates/RateBoard.tsx`）

本轮**不改布局**，只把显示值洗干净（页面与助手共用清洗器，杜绝两套真相）：

1. 顶部导入 `import { cleanPod, cleanPol, cleanCarrier } from "../../../main/services/rates-clean";`
   （该模块无 IO、无 node 内建依赖，Vite 可直接打包；若 `rates-portmap.json` 在渲染端解析报错，
   就把 `rates-clean.ts` 移到 `src/shared/rates-clean.ts`，主进程与渲染端都从那里导入。）
2. 列 `render`：目的港 `(_, r) => cleanPod(r.podRaw).pods.join(" / ") || r.podRaw`；
   起运港 `(_, r) => cleanPol(r.pol).pols.join("/") || r.pol || "—"`；
   船司 `(_, r) => cleanCarrier(r.carrier).carrier || r.carrier || "—"`。
3. 筛选不动（目的港框已走 `terms` 跨字段并集）；页面**不要**渲染 `messageText`。

---

## 8. 步骤六：删标准层

1. 删 `src/main/services/rates-standard.ts`；`tools.ts` 的导入按 §6.2 换掉。
2. `grep -rn "rates-standard\|queryStandard\|standardToMarkdown\|podRawExpansion\|laneOfPod\|loadStandard" src` 应为空（注释除外）。
3. `data/rates-standard.json` 与 `scripts/build-rates-standard.py` 留在仓库但程序不再读；有 `RATES_STANDARD_PATH` 引用就删掉。

---

## 9. 步骤七：新建 `tests/unit/rates-clean.test.ts`（整份粘贴，样例取自真源实测）

```ts
import { describe, it, expect } from "vitest";
import {
  cleanPol, cleanPod, cleanCarrier, parsePrices, cleanFreeDays, cleanEtd, quoteState,
  stripLaneTag, fmtValidity, fmtEtdShort, cleanQuoteRow, pivotQuotes, groupByPol,
  cleanTableMarkdown, customerQuoteMarkdown, locatePodLines, type QuoteRowRaw,
} from "../../src/main/services/rates-clean";

// 真源实测原文 A：一条消息拆成 4 个 pod 行，价对四港共享（USD3300/3900+）
const TEXT_A = [
  "CMA 土耳其推广 9.1~9.30   一水  5高    不能 电放  可以 SW或者正本",
  "POL 盐田/蛇口   南沙",
  "ISTANBUL/ IZMIT/ MERSIN/ ALIAGA",
  "USD3300/3900+",
  "21 combined",
  "现舱",
  "9.21   蛇口 -IZMIT   3高     BEX  TEXAS  TRIUMPH  0BXOLW1MA",
  "9.16   蛇口-ISTanbul   1高   COSCO SHIPPING ROSE 0BXOJW1MA",
].join("\n");

// 真源实测原文 B：同一条消息里不同港不同价 —— 错价高危样例
const TEXT_B = [
  "南沙 CUL  直航快船CLS9.11",
  "ALEX   4200/5100",
  "ISTANBUL/MERSIN/ALIAGA 4100/4800",
  "ETD-6取消，亏仓费CNY300/柜",
  "埃及目免21，土耳其14，+USD150/300买21",
].join("\n");

const row = (o: Partial<QuoteRowRaw> = {}): QuoteRowRaw => ({
  carrier: null, pol: null, podRaw: null, lane: null, container: null, containerRaw: null,
  oceanUsd: null, freeDays: null, etd: null, validityRaw: null, validFrom: null, validTo: null,
  note: null, sourceGroup: null, sender: null, msgTime: null, syncedAt: null, status: null,
  messageText: null, ...o,
});
const prices = (o: Partial<Parameters<typeof parsePrices>[0]> = {}) =>
  parsePrices({ container: null, oceanUsd: null, messageText: null, note: null, pods: [], ...o });

describe("起运港：固定十值 + 拆开多港（真源脏值实测）", () => {
  it("深圳与大铲湾归到蛇口/盐田/南沙三候选，不猜一个", () => {
    expect(cleanPol("深圳").pols).toEqual(["蛇口", "盐田", "南沙"]);
    expect(cleanPol("大铲湾").pols).toEqual(["蛇口", "盐田", "南沙"]);
  });
  it("+ 与 / 分隔的多港串拆开", () => {
    expect(cleanPol("青岛+太仓+南沙").pols).toEqual(["青岛", "南沙"]);
    expect(cleanPol("蛇口/香港/盐田/厦门").pols).toEqual(["蛇口", "盐田", "厦门"]);
    expect(cleanPol("盐田/蛇口").pols).toEqual(["盐田", "蛇口"]);
  });
  it("全角括号与英文长串", () => {
    expect(cleanPol("天津新港（Xingang）").pols).toEqual(["天津"]);
    expect(cleanPol("天津新港（XINGANG）").pols).toEqual(["天津"]);
    expect(cleanPol("Dalian, Dalian, Liaoning, China;Shekou, Shenzhen, Guangdong, China;Xiamen, Xiamen, Fujian, China").pols)
      .toEqual(expect.arrayContaining(["大连", "蛇口", "盐田", "南沙", "厦门"]));
  });
  it("三字码串：认得的归一，不认得的进 leftovers 并标待核实", () => {
    const r = cleanPol("SGH/NPO/YAT/YOK/BUS；TST/HSK");
    expect(r.pols).toContain("盐田");                 // YAT
    expect(r.unverified.join()).toContain("非十值");
  });
  it("非十值口岸不硬塞", () => {
    expect(cleanPol("福州").pols).toEqual([]);
    expect(cleanPol("福州").unverified[0]).toContain("福州");
  });
});

describe("目的港：标准英文唯一名（全大写）", () => {
  it("剥译名/国别括注/尾部航线小字", () => {
    expect(cleanPod("ISTANBUL 伊斯坦布尔(土耳其) 地东").pods).toEqual(["ISTANBUL"]);
    expect(cleanPod("BALBOA, PA 巴尔博亚(巴拿马)").pods).toEqual(["BALBOA"]);
    expect(cleanPod("Santos").pods).toEqual(["SANTOS"]);
  });
  it("多港拆开去重", () => {
    expect(cleanPod("ISTANBUL/ IZMIT/ MERSIN/ ALIAGA").pods)
      .toEqual(["ISTANBUL", "IZMIT", "MERSIN", "ALIAGA"]);
  });
});

describe("船司：真源 26 个实测值", () => {
  it("中文与长名归一，三字码原样采信", () => {
    expect(cleanCarrier("中远海特").carrier).toBe("COSCO");
    expect(cleanCarrier("SINOTRANS 外运").carrier).toBe("SINOTRANS");
    expect(cleanCarrier("CUL").carrier).toBe("CUL");
    expect(cleanCarrier("AKKON").carrier).toBe("AKKON");
  });
  it("「未注明」不是船司名 → 空", () => {
    expect(cleanCarrier("未注明").carrier).toBe("");
  });
});

describe("三列柜型价：结构化优先，原文按港定位（防错价）", () => {
  it("container_type 真源枚举 40HQ/HC 归 40HQ|HC 列", () => {
    expect(prices({ container: "40HQ/HC", oceanUsd: 4800 }).p40).toBe(4800);
    expect(prices({ container: "20GP", oceanUsd: 3300 }).p20).toBe(3300);
    expect(prices({ container: "40NOR", oceanUsd: 5200 }).pNor).toBe(5200);
  });
  it("样例A：结构化只有 40HQ/HC=3900，20GP=3300 从原文补（港组共享价）", () => {
    const r = prices({ container: "40HQ/HC", oceanUsd: 3900, messageText: TEXT_A, pods: ["ALIAGA"] });
    expect(r.p40).toBe(3900);
    expect(r.p20).toBe(3300);
  });
  it("样例B：pod=ALIAGA 必须取 4100/4800，绝不能取 ALEX 那行的 4200/5100", () => {
    const aliaga = prices({ container: "40HQ/HC", oceanUsd: 4800, messageText: TEXT_B, pods: ["ALIAGA"] });
    expect(aliaga.p20).toBe(4100);
    expect(aliaga.p40).toBe(4800);
    const alex = prices({ container: "40HQ/HC", oceanUsd: 5100, messageText: TEXT_B, pods: ["ALEX"] });
    expect(alex.p20).toBe(4200);
    expect(alex.p40).toBe(5100);
  });
  it("多处不同价又定位不到本港 → 不猜，标待核实", () => {
    const r = prices({ container: null, oceanUsd: null, messageText: TEXT_B, pods: ["UNKNOWNPORT"] });
    expect([r.p20, r.p40, r.pNor]).toEqual([null, null, null]);
    expect(r.unverified.join()).toContain("未按港定位");
  });
  it("高 2000 / 小 1000", () => {
    expect(prices({ messageText: "高 2000 小1000" }).p40).toBe(2000);
    expect(prices({ messageText: "高 2000 小1000" }).p20).toBe(1000);
  });
  it("解析不出三列全空并标待核实（不填 0）", () => {
    const r = prices({ messageText: "价格面议" });
    expect([r.p20, r.p40, r.pNor]).toEqual([null, null, null]);
    expect(r.unverified.join()).toContain("三列未解析");
  });
  it("柜型为 null 的价不入三列，改进备注（塞错列就是错价）", () => {
    const c = cleanQuoteRow(row({
      carrier: "CMA", pol: "天津", podRaw: "SANTOS", container: null, oceanUsd: 9894, validTo: "2099-12-31",
    }));
    expect([c.p20, c.p40, c.pNor]).toEqual([null, null, null]);
    expect(c.note).toContain("未标柜型价 $9,894");
  });
  it("按港定位原文行", () => {
    expect(locatePodLines(TEXT_B, ["ALIAGA"])).toContain("4100/4800");
    expect(locatePodLines(TEXT_B, ["ALEX"])).toContain("4200/5100");
    expect(locatePodLines(TEXT_B, ["NOWHERE"])).toBeNull();
  });
});

describe("目免：按国别/港定位，不按第一个数字", () => {
  it("free_days 有值直接采信；1-30 之外转备注", () => {
    expect(cleanFreeDays({ freeDays: "14", messageText: null, note: null, pods: [] }).days).toBe(14);
    expect(cleanFreeDays({ freeDays: "45", messageText: null, note: null, pods: [] })).toMatchObject({ days: null });
  });
  it("样例B：土耳其港取 14，埃及港取 21（真源 free_days 全为 null）", () => {
    expect(cleanFreeDays({ freeDays: null, messageText: TEXT_B, note: null, pods: ["ALIAGA"] }).days).toBe(14);
    expect(cleanFreeDays({ freeDays: null, messageText: TEXT_B, note: null, pods: ["ALEX"] }).days).toBe(21);
  });
  it("样例A：21 combined 无限定词但全篇唯一 → 采信", () => {
    expect(cleanFreeDays({ freeDays: null, messageText: TEXT_A, note: null, pods: ["ALIAGA"] }).days).toBe(21);
  });
});

describe("ETD：结构化优先，原文兜底且按港定位", () => {
  it("结构化 etd 与 9.6晚开9.10（前截关后开船）", () => {
    expect(cleanEtd({ etd: "2026-09-18", messageText: null, msgTime: null, pods: [] })).toBe("2026-09-18");
    expect(cleanEtd({ etd: null, messageText: "9.6晚开9.10 SANTOS", msgTime: "2026-09-03", pods: ["SANTOS"] }))
      .toMatch(/^\d{4}-09-10$/);
  });
  it("样例A：IZMIT 取 9.21 那行，ISTANBUL 取 9.16 那行", () => {
    expect(cleanEtd({ etd: null, messageText: TEXT_A, msgTime: "2026-09-03", pods: ["IZMIT"] })).toMatch(/-09-21$/);
    expect(cleanEtd({ etd: null, messageText: TEXT_A, msgTime: "2026-09-03", pods: ["ISTANBUL"] })).toMatch(/-09-16$/);
  });
  it("解析不出返回 null，不猜", () => {
    expect(cleanEtd({ etd: null, messageText: "船期待定", msgTime: null, pods: [] })).toBeNull();
  });
});

describe("状态与报价格式", () => {
  it("状态由有效期函数判断（不新增存储列）", () => {
    expect(quoteState("2099-12-31")).toBe("当前有效");
    expect(quoteState(null)).toBe("当前有效");
    expect(quoteState("2000-01-01")).toBe("已过期");
  });
  it("VALIDITY / ETD 报价格式", () => {
    expect(fmtValidity("2026-09-01", "2026-09-15")).toBe("1-15 Sep");
    expect(fmtValidity("2026-08-31", "2026-09-06")).toBe("31 Aug – 6 Sep");
    expect(fmtValidity(null, "2026-09-16")).toBe("16 Sep");
    expect(fmtValidity(null, null)).toBe("/");
    expect(fmtEtdShort("2026-09-16")).toBe("16 Sep");
    expect(fmtEtdShort(null)).toBe("/");
  });
});

describe("清洗成行 / 宽表透视 / 按港分组", () => {
  it("真源样例A的一行 → 规范行（三列价齐、目免 21、ETD 9.21、状态当前有效）", () => {
    const c = cleanQuoteRow(row({
      carrier: "CMA", pol: "盐田/蛇口", podRaw: "ALIAGA", lane: "地东",
      container: "40HQ/HC", oceanUsd: 3900, validityRaw: "9.1~9.30",
      validFrom: "2026-09-01", validTo: "2026-09-30", messageText: TEXT_A,
      note: "CMA土耳其推广；21 combined", sourceGroup: "土耳其价格更新", sender: "杜佳仪 Alby",
      msgTime: "2026-09-07 15:03", syncedAt: "2026-09-07T07:40:31.000Z", status: "当前生效",
    }));
    expect(c.carrier).toBe("CMA");
    expect(c.pols).toEqual(["盐田", "蛇口"]);
    expect(c.pod).toBe("ALIAGA");
    expect(c.lane).toBe("地东");
    expect(c.p40).toBe(3900);
    expect(c.p20).toBe(3300);
    expect(c.freeDays).toBe(21);
    expect(c.state).toBe("当前有效");
    expect(c.unverified).toEqual([]);
  });

  it("同船司同港同效期的多柜型行合并成一行三列", () => {
    const merged = pivotQuotes([
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "20GP", oceanUsd: 1000, validTo: "2099-12-31" })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "40HQ/HC", oceanUsd: 2000, validTo: "2099-12-31" })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "40NOR", oceanUsd: 1200, validTo: "2099-12-31" })),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ p20: 1000, p40: 2000, pNor: 1200 });
  });

  it("按起运港分组：多港行在每个候选港都计一次", () => {
    const g = groupByPol(pivotQuotes([
      cleanQuoteRow(row({ carrier: "MSC", pol: "天津", podRaw: "SANTOS", container: "20GP", oceanUsd: 3200 })),
      cleanQuoteRow(row({ carrier: "MSC", pol: "青岛", podRaw: "SANTOS", container: "20GP", oceanUsd: 3000 })),
      cleanQuoteRow(row({ carrier: "CUL", pol: "南沙", podRaw: "ALIAGA", container: "40HQ/HC", oceanUsd: 4800 })),
    ]));
    expect(g.find(x => x.pol === "青岛")?.cheapest).toBe(3000);
    expect(g.find(x => x.pol === "南沙")?.cheapest).toBe(4800);
    expect(g.find(x => x.pol === "南沙")?.cheapestCol).toBe("40HQ/HC");
  });
});

describe("两张表的形态", () => {
  const rows = pivotQuotes([cleanQuoteRow(row({
    carrier: "中远海特", pol: "宁波", podRaw: "MANZANILLO 曼萨尼略(墨西哥) 墨西哥", lane: "墨西哥",
    container: "40HQ/HC", oceanUsd: 1800, freeDays: "7", etd: "2026-09-16",
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
    expect(body).toContain("| NINGBO |");
    expect(body).toContain("| MANZANILLO |");
    expect(body).toContain("| 16 Sep |");
    expect(body.split("|").length).toBe(13);          // 11 列 + 首尾空段
    expect(body.slice(body.indexOf("| 1-15 Sep |"))).toContain("| / |");   // TT 恒 /
  });

  it("多起运港在客户表里拆行（POL 唯一）", () => {
    const multi = pivotQuotes([cleanQuoteRow(row({
      carrier: "CUL", pol: "深圳", podRaw: "ALIAGA", container: "40HQ/HC", oceanUsd: 4800, validTo: "2099-12-31",
    }))]);
    const lines = customerQuoteMarkdown(multi).split("\n").slice(2);
    expect(lines.length).toBe(3);                     // 蛇口 / 盐田 / 南沙 各一行
    expect(lines.join()).toContain("SHEKOU");
  });
});

describe("尾缀剥离护栏", () => {
  it("正常形态不切碎", () => {
    expect(stripLaneTag("BALBOA, PA 巴尔博亚(巴拿马)", "加勒比").podRaw).toBe("BALBOA, PA 巴尔博亚(巴拿马)");
    expect(stripLaneTag("PANAMA (MANZANILLO PA/BALBOA)", "加勒比").podRaw).toBe("PANAMA (MANZANILLO PA/BALBOA)");
    expect(stripLaneTag("MANZANILLO", "墨西哥").podRaw).toBe("MANZANILLO");
    expect(stripLaneTag("ISTANBUL 伊斯坦布尔(土耳其) 地东", null)).toEqual({ podRaw: "ISTANBUL 伊斯坦布尔(土耳其)", lane: "地东" });
  });
});
```

> 断言与代码不一致时：**以真源实测（本文 §0）与业务规范 §2-§4 为准改代码，不要改断言迁就实现。**

---

## 10. 验收

1. `npx tsc --noEmit` 无输出。
2. `npm test` 全绿：新增 `rates-clean.test.ts`，且 `rates-query-fallback.test.ts`、`rates-normalize.test.ts`、`agent-tools-inbox.test.ts` 仍绿
   （后两者若报 `no column named etd` → 回 §3.4 补沙箱 DDL；`rates-query-fallback.test.ts` 里若断言了旧 notice 文案，按新文案更新断言，**不要**放宽成 `toContain("")`）。
3. `npm run build` 通过。
4. `grep -rn "rates-standard\|queryStandard\|standardToMarkdown\|podRawExpansion" src` 为空（注释除外）。
5. `grep -rn "messageText" src/renderer src/main/transport` 为空（原文不外泄）。
6. 手测（dev，主进程不热更要重启；先在运价页点一次「同步」把镜像从 428 行刷到 3748 行）：
   - 「地东的价格」→ 应命中（真源有 12 条航线含地东），结果按起运港分组、带时效行、价在前舱位在后；
   - 「深圳到Santos的价格」→ 起运港显示蛇口/盐田/南沙，不追问；
   - 「宁波到曼萨尼略 40HQ」→ 命中后问一句要不要客户报价表，回"要"才出十一列表，TT 为 `/`；
   - 「ALIAGA 多少钱」→ 20GP=3300、40HQ/HC=3900（样例A 形态），且目免 21；
   - 故意问一个库里没有的港 → 第一轮给候选让模型换词，第二轮定论"镜像/台账"口径，不出现"暂无该航线报价"。

## 11. 待用户裁决的词表（本轮先按"保留原文 + 标待核实"处理，不要猜）

真源实测到、但不在起运港十值白名单里的口岸：**大铲湾**（暂按深圳港区三候选处理）、福州、钦州、汕头、太仓、
香港、高雄（Kaohsiung）、基隆（Keelung）、新加坡（Singapore）、横滨（YOK）、釜山（BUS）；
三字码 **SGH、NPO、TST、HSK** 含义未确认（YAT 已按盐田处理）。
船司中文名 **合德**（未确认对应缩写）；`未注明` 已按"空船司"处理。
这些确认后只需往 `POL_ALIASES` / `CARRIER_ALIASES` 里加行，不用改算法。

## 12. 下一期（本轮不做）

台账入库层做实宽表与标准名（`docs/rates-query-spec.md` §7）：`freight_rates` 改列、多港拆行、
三列价在入库解析、目免按国别落列、图片复用、记录状态由有效期函数判断、
相同信息源的补充挂回原条目（`supersedes`/`root_key`）、新增「动态与行情」表与每日 AI 总结定时器。
做完这一期，读侧清洗器降级为兜底。
