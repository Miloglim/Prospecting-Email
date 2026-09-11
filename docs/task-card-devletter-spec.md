# 任务卡删除 / 开发信推荐口径 / 选人器"已在任务"灰显 / 首页意图输入框

日期：2026-09-10　状态：**已实现**（与原方案的差异见文末 §8，改实现先改本规范）

四条用户实测问题，逐条给出根因（带代码证据）、方案与核心代码。执行顺序按 §1→§4，
§5 的缓存失效清单是 §2/§3 共用的收尾，§6 是验收闸门。

---

## 0. 根因速览

| # | 现象 | 根因（代码证据） |
|---|---|---|
| 1 | 任务卡没有删除按钮 | `CampaignTasks.cardOps()` 只有 启动/编辑/终止/再启动；service 层**根本没有 deleteCampaign**，contract 里也没有 `send:campaignDelete` 通道 |
| 2 | 首页推荐不更新，同一批人被反复推荐、重复建任务 | `dev-letter.service.recommendDevLetterGroup()` 候选判据只有 `coalesce(contacts.status,'')=''`。而发送成功只写 `interactions(type='sent')` 与推进 `contacts.stage`（`send.service.ts:1247,1263`），**`contacts.status` 仍是空**；建了任务但还没发出去的人更是既不空 status 也无 sent 交互 → 判据永远命中同一批 |
| 3 | 选人器看不出"这人已在任务里" | `getPickerStats()`（`send.service.ts:407`）只回 `neverIds`/`lastSent`，没有"归属未完结任务"的口径；`ContactPicker` 因此无从标记 |
| 4 | 首页开发信不能按用户要求出名单 | `devLetter:recommend` 是无参确定性计算（`dev-letter.ipc.ts:12`），弹窗只有一张表 + 确定按钮，没有任何"输入要求"的入口；且全项目模型调用只有一个入口 `runHarnessTurn`（整轮会话 + 工具 + transcript），没有轻量一次性解析通道 |

---

## 1. 任务卡加「删除」

### 语义（拍板）

- 删除 = 删 `send_campaigns` 一行 + 该任务全部 `send_campaign_targets`；**发送队列与历史记录保留**
  （`send_queue.campaign_id` 变悬挂，历史页照旧可查，不删用户数据）。
- `running` / `paused` **拒删**：先点「终止」。理由是引擎在途组的回调
  （`onCampaignSendSent`）要按 campaignId 找任务，边发边删会让账本对不上。
- 卡片上只在 `draft` / `done` / `stopped` 出现删除按钮（不给禁用态按钮，避免"点了没反应"）。

### 代码

`src/main/contract.ts` — SEND 组内加一行（preload 白名单由 `Object.values(IPC)` 自动生成，无需另改）：

```ts
    CAMPAIGN_DELETE:  chan(PREFIX.SEND, "campaignDelete"),
```

`src/main/services/campaign.service.ts` — 顶部 import 补 `saveDatabase`（现在只 import 了 `getDb`）：

```ts
import { getDb, saveDatabase } from "../db";
```

新增导出函数（放在 `restartCampaign` 之后、`getCampaignOverview` 之前）：

```ts
/** 删除任务：任务行 + 触点账本一起删；发送队列/历史记录保留（campaign_id 悬挂，历史仍可查）。
 *  running/paused 拒删——先终止，否则在途组的回调找不到任务，账本对不上。 */
export function deleteCampaign(id: string): Result<{ deletedTargets: number }> {
  const db = getDb();
  const c = db.select().from(sendCampaigns).where(eq(sendCampaigns.id, id)).get();
  if (!c) return failResult(`任务不存在: ${id}`);
  if (c.status === "running" || c.status === "paused") return failResult("任务还在跑，先点「终止」再删除");
  const n = db.select({ n: sql<number>`count(*)` }).from(sendCampaignTargets)
    .where(eq(sendCampaignTargets.campaignId, id)).get()?.n ?? 0;
  db.delete(sendCampaignTargets).where(eq(sendCampaignTargets.campaignId, id)).run();
  db.delete(sendCampaigns).where(eq(sendCampaigns.id, id)).run();
  saveDatabase();
  Log.info("campaign.delete", `任务 ${id}「${c.name}」已删除（触点 ${n} 条；队列与发送历史保留）`);
  return okResult({ deletedTargets: n });
}
```

> 计数用 `select count(*)` 而不是 `.run().changes`：sql.js 沙箱与 better-sqlite3 的 run 返回形状不一致，
> 用 changes 会让单测和生产读出两个数。

`src/main/transport/send.ipc.ts` — 紧跟 `CAMPAIGN_UPDATE_DRAFT` 之后：

```ts
  ipcMain.handle(IPC.SEND.CAMPAIGN_DELETE, (_e, id: string) => {
    if (!id?.trim()) return failResult("缺少任务 id");
    return CampaignService.deleteCampaign(id.trim());
  });
```

`src/renderer/pages/campaigns/CampaignTasks.tsx` — 加删除动作（复用现有 `message`/`qc`）：

```tsx
  const remove = async (id: string, name: string) => {
    try {
      const r = await window.api.invoke("send:campaignDelete", id) as { success: boolean; error?: string };
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["dev-letter"] });        // §5：名单口径随任务变化
      qc.invalidateQueries({ queryKey: ["send", "pickerStats"] });
      if (!r?.success) { message.warning(r?.error || "删除失败"); return; }
      if (drawerId === id) setDrawerId(null);
      message.success(`已删除任务「${name}」（发送历史保留）`);
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
```

`cardOps()` 里三处挂按钮（`draft` 分支放在「终止」之后；`done` / `stopped` 分支各加一个；
`running`/`paused` **不加**）。删除是不可逆动作，一律套 `Popconfirm`：

```tsx
          <Popconfirm title={`删除任务「${r.name}」？触点名单一并删除，发送历史保留`}
            okText="删除" okType="danger" cancelText="取消"
            onConfirm={() => { void remove(r.id, r.name); }}>
            <Button size="small" danger style={{ fontSize: 12 }} icon={<DeleteOutlined />}
              onClick={e => e.stopPropagation()}>删除</Button>
          </Popconfirm>
```

`stopped` 现在 `cardOps` 直接 `return null` —— 要改成返回删除按钮（否则终止过的任务永远删不掉）。
import 补 `Popconfirm`（antd）与 `DeleteOutlined`（@ant-design/icons）。

---

## 2. 推荐口径修正：不再重复推荐同一批

### 判据（与既有 `neverIds` 对齐，另加"不在未完结任务里"）

真·从未触达 = `status` 空 **且** 无 `type='sent'` 交互 **且** `stage` 仍是 cold
（`getPickerStats()` 的 never 桶就是前两条，`send.service.ts:410`）；
再排除已归属 `draft/running/paused` 任务且触点非终态（`pending/queued`）的联系人。
`done`/`stopped` 任务里的人**不排除**（可以再开发）。

### 代码

`src/main/services/dev-letter.service.ts` — 候选查询整段替换（`①` 那段）：

```ts
  // ① 候选：真·从未触达。口径与 getPickerStats().neverIds 对齐（status 空 + 无 sent 交互），
  //    再加 stage 仍为 cold —— 旧口径只看 status，而发送成功只推进 stage、status 仍是空
  //    （send.service.ts:1247/1263），于是同一批人被反复推荐、用户重复建任务。
  //    已归属未完结任务（draft/running/paused 且触点 pending/queued）的人一并排除。
  const rows = db.select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    companyId: contacts.companyId, country: contacts.country, language: contacts.language,
    title: contacts.title, createdAt: contacts.createdAt,
    companyName: dsql<string | null>`(select name from companies where companies.id = ${contacts.companyId})`,
  }).from(contacts)
    .where(dsql`coalesce(${contacts.status}, '') = ''
      AND coalesce(${contacts.stage}, 'cold') = 'cold'
      AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.contact_id = ${contacts.id} AND i.type = 'sent')
      AND NOT EXISTS (
        SELECT 1 FROM send_campaign_targets t JOIN send_campaigns c ON c.id = t.campaign_id
        WHERE t.contact_id = ${contacts.id} AND t.status IN ('pending','queued')
          AND c.status IN ('draft','running','paused'))`)
    .all();
```

import 补：`import { sendCampaigns, sendCampaignTargets, interactions } from "../db/schema";`
（`interactions` 只在 SQL 字符串里用到表名，用 drizzle 列引用更安全；若嫌绕，`NOT EXISTS` 里直接写
`interactions`/`send_campaign_targets`/`send_campaigns` 字面表名也可以，与本文件既有
`(select name from companies …)` 写法一致）。

被排除的人数要**报出来**（可解释，不能默默少人）。同函数内加一条计数：

```ts
  const inCampaignCount = db.select({ n: dsql<number>`count(distinct t.contact_id)` })
    .from(sendCampaignTargets)
    .innerJoin(sendCampaigns, dsql`${sendCampaigns.id} = ${sendCampaignTargets.campaignId}`)
    .where(dsql`${sendCampaignTargets.status} IN ('pending','queued')
      AND ${sendCampaigns.status} IN ('draft','running','paused')
      AND coalesce((select c2.status from contacts c2 where c2.id = ${sendCampaignTargets.contactId}), '') = ''`)
    .get()?.n ?? 0;
```

返回体加字段（`DevLetterRecommendation` 同步声明），并往 `reasons` 追加一条：

```ts
  excludedInCampaign: inCampaignCount,
  // reasons 里：
  ...(inCampaignCount > 0
    ? [`另有 ${inCampaignCount} 位已在进行中的任务里，本次不重复推荐（防重复建任务）`] : []),
```

前端 `HomeCards.tsx` 的 `DevLetterRec` 接口补 `excludedInCampaign: number`，在限额那一行后面带上这句提示。

---

## 3. 选人器：已在任务里的人灰显

### 语义（延续 §0.6-1 拍板：只提示不拦截）

- 灰显 + 「已在任务」标签（Tooltip 显示任务名），**仍然可以勾选**；
- 汇总条如实报数「其中 K 位已在其他任务」；
- 给一个「排除已在任务」的一键动作（沿用现有 `deselectAllFiltered` 心智）；
- 若之后要改成硬禁选，只需给 `rowSelection` 加
  `getCheckboxProps: r => ({ disabled: campaignMap.has(r.id) })`，其余不动。

### 代码

`src/main/services/send.service.ts` — `PickerStats` 加字段 + `getPickerStats()` 加一条查询：

```ts
export interface PickerStats {
  neverIds: number[];
  lastSent: Array<{ id: number; label: string }>;
  /** 已归属未完结任务（draft/running/paused 且触点 pending/queued）的联系人：id → 任务名 */
  inCampaign: Array<{ id: number; campaignName: string }>;
}
```

```ts
  // 已在任务里的人（选人器灰显用）：done/stopped 任务不算——那批人可以再开发
  const campaignRows = db.select({
    id: sendCampaignTargets.contactId,
    name: sendCampaigns.name,
    createdAt: sendCampaigns.createdAt,
  }).from(sendCampaignTargets)
    .innerJoin(sendCampaigns, dsql`${sendCampaigns.id} = ${sendCampaignTargets.campaignId}`)
    .where(dsql`${sendCampaignTargets.status} IN ('pending','queued')
      AND ${sendCampaigns.status} IN ('draft','running','paused')`)
    .all();
  const inCampaignMap = new Map<number, string>();
  for (const r of campaignRows) if (!inCampaignMap.has(r.id)) inCampaignMap.set(r.id, r.name);
```

返回值加 `inCampaign: [...inCampaignMap].map(([id, campaignName]) => ({ id, campaignName }))`。
import 补 `import { sendCampaigns, sendCampaignTargets } from "../db/schema";`
（只 import schema，不 import campaign.service —— 后者已经 import 本文件，反向引用会成环）。

`src/renderer/pages/campaigns/ContactPicker.tsx`：

```ts
interface PickerStats {
  neverIds: number[];
  lastSent: Array<{ id: number; label: string }>;
  inCampaign: Array<{ id: number; campaignName: string }>;
}
```

```ts
  const campaignMap = useMemo(
    () => new Map((statsData?.data?.inCampaign ?? []).map(x => [x.id, x.campaignName])),
    [statsData]);
```

- 表格加 `rowClassName={r => (campaignMap.has(r.id) ? "row-in-campaign" : "")}`；
- 「状态」列 render 前置一个标签（有任务时优先显示，Tooltip 带任务名）：

```tsx
    { title: "状态", key: "status", width: 92,
      render: (_: unknown, r: PickRow) => {
        const cn = campaignMap.get(r.id);
        if (cn) return <Tooltip title={`已在任务「${cn}」`}>
          <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color="purple">已在任务</Tag></Tooltip>;
        const m = statusLabel(r);
        return <Tag className="text-[9px] leading-none px-1 py-0.5 m-0" color={m.color}>{m.label}</Tag>;
      } },
```

- 快捷区加 chip 与一键排除：

```tsx
          <Tag color="purple" className="cursor-pointer text-[10px] m-0" onClick={() => applyPreset("incampaign")}>已在任务</Tag>
          <Button size="small" onClick={dropInCampaign}>排除已在任务</Button>
```

```ts
  const dropInCampaign = () => onChange(value.filter(id => !campaignMap.has(id)));
```

`applyPreset` 的 key 联合类型加 `"incampaign"`，`filtered` 的筛选链里加一条
（`fStatus === "incampaign"` 时只留 `campaignMap.has(r.id)` 的行；其余分桶逻辑不变）。

- 汇总条计数（现有"已选 N 人 · M 家公司"那一行）追加：

```tsx
            {selectedInCampaign > 0 && <span className="text-purple-600">其中 {selectedInCampaign} 位已在其他任务</span>}
```

```ts
  const selectedInCampaign = useMemo(() => selectedRows.filter(r => campaignMap.has(r.id)).length, [selectedRows, campaignMap]);
```

- `columns` 的 useMemo 依赖数组补 `campaignMap`（漏了会渲染旧值）；
- `pickerStats` 查询的 `staleTime` 保持 10min，但**建任务/删任务后必须 invalidate**（§5）。

`src/renderer/global.css`（放在既有 `.picker-compact` 附近）：

```css
/* 已在未完结任务里的联系人：整行压灰，一眼看出"这人已经有人在跟" */
.row-in-campaign td { background: #fafafa !important; }
.row-in-campaign td span, .row-in-campaign td .ant-typography { color: #b0b4bb !important; }
.row-in-campaign:hover td { background: #f5f5f5 !important; }
```

> 注意虚拟表（`virtual` + `scroll.y`）下 `rowClassName` 生效，但**不要**用 `onRow.style` 覆盖，
> 会跟 antd 的悬停/选中样式打架。

---

## 4. 首页「自动开发信」加要求输入框

### 设计（红线：模型只解析意图，不决定名单）

- 输入框留空 → 走**原确定性推荐**（零模型调用，`docs/home-cards-spec.md §5-3` 原样成立）。
- 输入要求 → 一次性 JSON 解析（不进会话、不落 transcript、不带工具）把自然语言翻成结构化筛选
  `{country, language, stage, clientType, limit}`，再交给**同一个确定性规则引擎**过滤排序。
  名单仍按"每公司 1 位 → 齐全度降序 → 最早录入优先"产出，理由行照旧可解释。
- 模型端点没配好 / 调用失败 / JSON 解析不出 → **关键词兜底**（复用运价线已有的
  `looksLikeCountry` / `countryMatchWords`，语言与阶段走词表），界面如实标注
  「按关键词理解」，绝不静默降级成" ignores 用户要求"。

### 代码

新增 `src/main/services/agent/oneshot.ts`（全项目此前只有 `runHarnessTurn` 一个模型入口，
整轮会话太重；这里补一个轻量一次性调用）：

```ts
// ── 一次性 JSON 解析调用 ────────────────────────────────────────────────
// 与 runHarnessTurn 的区别：不进会话、不落 transcript、不带工具、不推事件。
// 用途仅限"把自然语言翻成结构化参数"——决策与选人仍由确定性规则完成
// （docs/home-cards-spec.md §5 红线：模型不决定名单）。
import OpenAI from "openai";
import { readActiveEndpoint } from "../endpoint.service";
import { netFetch } from "../../net-proxy";
import { Log } from "../../logger";

/** 返回 null = 没配端点/调用失败/解析不出（调用方必须有关键词兜底） */
export async function askJsonOnce<T>(system: string, user: string, timeoutMs = 20_000): Promise<T | null> {
  const e = readActiveEndpoint();
  if (!e.baseUrl || !e.apiKey) return null;
  // fetch 注入形状照 harness.ts:279-309：走 netFetch（设置里配了代理就经它出去，海外端点必须经代理）。
  // 直接写 `fetch: netFetch` 类型对不上，必须包一层。
  const fetchImpl: typeof fetch = (url, init) => netFetch(url as string, init as RequestInit) as Promise<Response>;
  const client = new OpenAI({ baseURL: e.baseUrl, apiKey: e.apiKey, timeout: timeoutMs, maxRetries: 1, fetch: fetchImpl });
  const messages = [{ role: "system" as const, content: system }, { role: "user" as const, content: user }];
  try {
    const r = await client.chat.completions.create({
      model: e.model, temperature: 0, max_tokens: 400, messages,
      response_format: { type: "json_object" },
    });
    return looseJson<T>(r.choices[0]?.message?.content ?? "");
  } catch (err) {
    // 部分网关不认 response_format：去掉它再来一次，仍失败就交回调用方兜底
    try {
      const r = await client.chat.completions.create({ model: e.model, temperature: 0, max_tokens: 400, messages });
      return looseJson<T>(r.choices[0]?.message?.content ?? "");
    } catch (e2) {
      Log.warn("llm.once", `一次性解析失败: ${(e2 as Error).message}`);
      return null;
    }
  }
}

/** 容忍 ```json 围栏与前后废话：只取第一个 { 到最后一个 } */
function looseJson<T>(s: string): T | null {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
}
```

新增 `src/main/services/dev-letter-intent.ts`：

```ts
// ── 自动开发信：用户要求 → 结构化筛选（模型解析 + 关键词兜底）──────────────
import { askJsonOnce } from "./agent/oneshot";
import { looksLikeCountry, countryMatchWords } from "./rate-update.service";
import { Log } from "../logger";

export interface DevLetterCriteria {
  country?: string; language?: string; stage?: string; clientType?: string;
  limit?: number; note?: string;
  /** 谁解析出来的：界面要如实说，不能假装听懂了 */
  parsedBy: "model" | "keyword" | "none";
}

const SYSTEM = [
  "把用户对'给谁发开发信'的自然语言要求翻成严格 JSON，只输出 JSON，不要解释。",
  '字段：country(字符串或null) / language("EN"|"ES"|"PT"|null) / stage("cold"|"f1"|"f2"|"f3"|"f4"|null) /',
  'clientType("direct"|"agent"|"peer"|"general"|null) / limit(正整数或null) / note(其余要求原话，或null)。',
  "规则：没提到的字段一律 null，不要猜；国家写用户原词（如「巴西」），不要自行翻译。",
].join("\n");

const LANG_WORDS: Array<[RegExp, string]> = [
  [/英语|英文|\ben\b|english/i, "EN"], [/西语|西班牙|\bes\b|spanish/i, "ES"], [/葡语|葡萄牙|\bpt\b|portuguese/i, "PT"],
];
const STAGE_WORDS: Array<[RegExp, string]> = [
  [/冷客户|没发过|从未|新客户|cold/i, "cold"], [/跟进\s*1|f1/i, "f1"], [/跟进\s*2|f2/i, "f2"],
  [/跟进\s*3|f3/i, "f3"], [/促单|成交|closing|f4/i, "f4"],
];
const TYPE_WORDS: Array<[RegExp, string]> = [
  [/直客|直接客户|direct/i, "direct"], [/代理|agent/i, "agent"], [/同行|peer/i, "peer"],
];

export async function parseDevLetterIntent(text: string): Promise<DevLetterCriteria> {
  const t = (text || "").trim();
  if (!t) return { parsedBy: "none" };
  const fromModel = await askJsonOnce<Partial<DevLetterCriteria>>(SYSTEM, t);
  if (fromModel && Object.values(fromModel).some(v => v != null)) {
    return { ...pick(fromModel), parsedBy: "model" };
  }
  Log.info("devLetter.intent", `模型解析不可用，走关键词兜底：${t.slice(0, 60)}`);
  return { ...keywordParse(t), parsedBy: "keyword" };
}
```

`sanitize()` 只做白名单取值（`limit` 只取正整数、**不设天花板**——用户点名多少就交给引擎按日限额/候选池夹，`language` 只认 EN/ES/PT，其余丢弃）；
`keywordParse()`：国家用 `matchCountryInText(t)` / 逐个 `countryMatchWords` 命中，语言/类型走上面词表，
数量抓 `(?:前|最多|来|取|要|改成|改到|换成|…)\s*(\d{1,4})\s*(?:位|个|家|封)?|(\d{1,4})\s*(?:位|个|家|封)`（含无单位说法，最多 4 位，同样不夹 50）。两个函数都是纯函数，方便单测。

`src/main/services/dev-letter.service.ts` — 签名向后兼容（既有测试是 `recommendDevLetterGroup()` 无参调用）：

```ts
export function recommendDevLetterGroup(
  capOverride?: number, now: Date = new Date(), criteria?: DevLetterCriteria,
): Result<DevLetterRecommendation>
```

在候选数组构造完之后、"每公司取 1 位"之前插入确定性过滤（顺序重要：先按用户要求收窄，再每公司 1 位）：

```ts
  // 用户要求（§4）：确定性过滤，模型只负责把话翻成参数，选人与排序规则一字不改
  const wanted = criteria?.country?.trim();
  const words = wanted ? countryMatchWords(wanted) : [];
  let pool = candidates;
  if (words.length) pool = pool.filter(c => (c.country || "").toLowerCase() === wanted!.toLowerCase()
    || words.some(w => (c.country || "").toLowerCase().includes(w)));
  if (criteria?.language) pool = pool.filter(c => (c.language || "").toUpperCase() === criteria.language!.toUpperCase());
  if (criteria?.stage) pool = pool.filter(c => (c.stage ?? "cold") === criteria.stage);        // 候选行需带上 stage
  if (criteria?.clientType) pool = pool.filter(c => (c.clientType || "general") === criteria.clientType);
```

`CandidateRow` 与候选 `select` 需要补 `stage: contacts.stage, clientType: contacts.clientType` 两列。
`cap` 计算：用户点名了数量就以它为准（只受日限额剩余与候选池夹，不写死 50），没点名才走默认一批：

```ts
  const want = criteria?.limit ?? capOverride;
  const cap = Math.max(0, want != null
    ? Math.min(want, remaining ?? want)                         // 点名：只受日限额剩余夹，上限交给池子/额度
    : Math.min(DEV_LETTER_CAP, remaining ?? DEV_LETTER_CAP));   // 未点名：默认一批 ≤50
```
`DEV_LETTER_CAP` 因此只是"默认批量"，不再是硬上限；理由行按是否被 `remaining`/候选池夹到如实说明。

`reasons` 头部插入一条"已按你的要求筛：…"（把命中的条件逐项写出来，`parsedBy` 也写进去），
返回体加 `applied: criteria ?? { parsedBy: "none" }`。空结果时 `reasons[0]` 要说清是
"按这个要求没人"还是"库里本来就没冷客户"——两种情况用户要做的事完全不同。

`src/main/transport/dev-letter.ipc.ts` — handler 改 async，参数容错（老调用方无参也要能跑）：

```ts
  ipcMain.handle(IPC.DEV_LETTER.RECOMMEND, async (_e, input?: { cap?: number; criteriaText?: string }) => {
    const cap = Number(input?.cap);
    const text = (input?.criteriaText ?? "").trim();
    const criteria = text ? await parseDevLetterIntent(text) : undefined;
    return recommendDevLetterGroup(Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : undefined, new Date(), criteria);
  });
```

`src/renderer/pages/assistant/HomeCards.tsx` — `DevLetterModal` 顶部加输入框，query key 带上要求：

```tsx
  const [ask, setAsk] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, isFetching } = useQuery({
    queryKey: ["dev-letter", "recommend", submitted],
    queryFn: () => window.api.invoke("devLetter:recommend", { criteriaText: submitted || undefined }) as
      Promise<{ success: boolean; data?: DevLetterRec; error?: string }>,
    enabled: open,
  });
  const run = () => setSubmitted(ask.trim());
```

```tsx
          <div className="flex items-center gap-2">
            <Input allowClear value={ask} onChange={e => setAsk(e.target.value)} onPressEnter={run}
              placeholder="说要求，如：只要巴西的冷客户，英语，先来 20 位" />
            <Button type="primary" loading={isFetching} onClick={run}>按我的要求重算</Button>
            {submitted && <Button onClick={() => { setAsk(""); setSubmitted(""); }}>回到默认推荐</Button>}
          </div>
```

表格上方加一行"这次是怎么筛的"（可解释性，别让用户猜）：

```tsx
          {rec.applied?.parsedBy && rec.applied.parsedBy !== "none" && (
            <div className="text-[11px] text-gray-500">
              已按你的要求筛：{appliedSummary(rec.applied)}
              <span className="text-gray-300"> · {rec.applied.parsedBy === "model" ? "AI 理解" : "关键词理解（未配置模型端点）"}</span>
            </div>
          )}
```

确定按钮的逻辑不变（`stashDevLetterPreset` + 跳 `#/campaigns?create=1`）——**红线不破**：
卡片只产生推荐与预选，入队/发送仍在发送界面由人确认。

### 规范同步

`docs/home-cards-spec.md`：§2 补"要求输入框"一段，§3 的接口签名换成新签名并加
`DevLetterCriteria` / `excludedInCampaign` / `applied`，§5 红线 3 改成：

> 3. 推荐规则确定性、可解释：**选人与排序不引入模型、不引入随机**；用户要求经一次性解析
>    （模型或关键词兜底）翻成结构化筛选后，仍由同一套确定性规则出名单，界面如实标注解析来源。

---

## 5. 缓存失效清单（§2/§3 的收尾，漏一条就会"看着没更新"）

任务名单一变，这三个 key 全部作废。落点：

| 触发处 | 需要 invalidate |
|---|---|
| `CampaignWizard.submit()` 成功后 | `["campaigns"]`、`["dev-letter"]`、`["send","pickerStats"]` |
| `CampaignTasks.remove()` / `control()` 成功后 | 同上（`control` 现在只刷 `["campaigns"]`） |
| `send:progress` 事件（已在做） | 追加 `["send","pickerStats"]`（发送成功会推进 stage，灰显与推荐口径都跟着变） |

`DevLetterModal` 的 query 不要加 `staleTime`（默认 0 = 每次打开都重算），
但 `queryKey` 必须带上 `submitted`，否则输入了要求也读回旧缓存。

---

## 6. 测试与验收

新增/扩展单测（沙箱建库口径见 `tests/unit/campaign.test.ts` 顶部 DDL 与
`tests/unit/picker-stats.test.ts`；**注意 sql.js 用 `Math.random` 生成内存库名，
任何对 `Math.random` 的打桩必须在 `afterEach` 里 `vi.restoreAllMocks()`**）：

1. `tests/unit/campaign.test.ts`：`deleteCampaign` —— running 拒删；draft/done 删净任务与触点；
   `send_queue` 里的历史行仍在。
2. `tests/unit/campaign-ipc.test.ts`：`send:campaignDelete` 通道注册 + 空 id 报错（沿用 handlers Map 断言）。
3. `tests/unit/dev-letter.test.ts`：
   - 有 `sent` 交互或 stage 已推进的人不再被推荐（钉死 §2 根因）；
   - 已在 draft/running/paused 任务里的人被排除，且 `excludedInCampaign` 计数正确；
   - done/stopped 任务里的人**照常**可推荐；
   - `criteria` 过滤：country（含 `countryMatchWords` 语义命中）/ language / limit；
   - 空结果时 `reasons[0]` 能区分"按这个要求没人"与"库里没冷客户"；
   - 点名数量可超过默认 50：候选够就照取，被候选池或日限额剩余夹到时少给且理由行如实说明。
4. `tests/unit/dev-letter-intent.test.ts`（新）：`keywordParse` 纯函数——「巴西的冷客户，英语，前 20 位」
   → `{country:"巴西", language:"EN", limit:20}`；含无单位「改成30」也能认；`askJsonOnce` 返回 null 时不抛、落到 keyword；
   `limit` 不设天花板（解析层照收，取数时才按日限额/候选池夹）。
5. `tests/unit/picker-stats.test.ts`：`inCampaign` 只含未完结任务的 pending/queued 触点，
   同一人在两个任务里只出现一次。

闸门（三条全绿才算完）：

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run build
```

界面自查：① 任务卡（草稿/已完成/已终止）出现「删除」，运行中不出现；② 首页推荐弹窗建完任务再打开，
上一批人不再出现且提示"另有 N 位已在进行中的任务里"；③ 选人器里已在任务的人整行灰 + 紫色「已在任务」标签，
「排除已在任务」一键生效；④ 输入"只要巴西的冷客户，先来 20 位"→ 表格换成巴西名单并标注解析来源，
清空输入回到默认推荐。

## 7. 红线

1. 卡片只产生"推荐 + 预选 + 跳转"，入队/发送决策全部在发送界面由人完成（`home-cards-spec §5-1`）。
2. 选人与排序规则确定性、可解释；模型只做自然语言→结构化参数，且不进会话、不落 transcript。
3. 删除任务不删发送历史与队列行；`running/paused` 一律拒删。
4. 灰显只是提示，不替用户做主（延续 `smart-send-spec §0.6-1` 资格闸解除的拍板）。

---

## 8. 实现记录（2026-09-10，与原方案的差异）

1. **`criteria` 去掉了 `stage`**。本卡片的池子按定义就是"从未触达的冷客户"（§2 判据里 `stage=cold` 是硬条件），
   再给一个 stage 筛选只会永远空集。改为：要求里出现"发给跟进过的老客户"这类说法时，不编筛子漏人，
   而是把一句可执行的说明写进 `note` 并进 `reasons`（"本卡片只开发从未联系过的新客户…"）。
   条件维度因此是 `country / language / clientType / limit`。
2. **国家别名表下沉为 `src/main/services/country-alias.ts`**（新增 `matchCountryInText`）。
   原方案让 `dev-letter.*` 直接 import `rate-update.service` 取 `countryMatchWords`——那会把整条
   运价/发送/CRM 依赖链拖进首页卡片这条轻路径（单测也得跟着拉起一堆模块）。现在 `rate-update.service`
   原样转出口，`agent/tools.ts` 等老调用点零改动。
3. **`totalCandidates` 语义微调**：= 经用户要求**收窄后**的池子大小（"按你的要求筛出多少位冷客户"），
   零候选分支仍为 0；"按这个要求没人"的分支里它是"库里满足冷口径但没满足条件"的人数，用于把两种空集分开说。
4. **`applied` 的人话版由主进程产出**（`describeCriteria`）：推荐理由与界面标注同源，避免两处各写一套措辞。
   渲染端只留 `PARSED_BY_LABEL` 一个映射（AI 理解 / 关键词理解 / 默认规则）。
5. **单测沙箱补表**：`dev-letter.test.ts` 原来只建 contacts/companies/email_accounts 三张表，
   新口径要查 `interactions` 与 `send_campaign_targets/send_campaigns` → 补齐并把库句柄提到模块级
   （`markSent` / `addCampaign` 走 raw INSERT）。任务侧删除用例顺带钉住一条事实：
   `send_campaign_targets` 是**一人一行**（轮次靠 `round` 推进），不是"一人一轮一行"。
6. 验收：`npx tsc --noEmit -p tsconfig.json` 干净；`npx vitest run` 全绿；`npm run build` 三段产物成功。
