# Agent 闭环工作台规范（closed-loop working memory）

> 目标：让 agent 在一个任务里**全程握着真实数据**——读到的邮件、查到的运价、筛出的联系人，跨轮不丢、跨工具可取；起草用真价不编造；冷开发按前置条件精确筛选而非全量扫。一句话：功能完整、逻辑闭合、程序稳定。
>
> 本规范是新增子系统的执行版设计。实现严格按此走；实现与本规范冲突时，先改规范再改代码。

---

## 0. 问题陈述（根因，均有代码证据）

| # | 症状（用户实测） | 根因 | 证据 |
|---|---|---|---|
| P1 | 读过邮件全文，下一轮问柜型答"邮件没写柜型" | 工具结果不进历史；`email_read_full` 的正文**任何持久层都不落**（audit 只记 `{id,len}`） | tools.ts:1063；memory.ts:1-7 明写"工具结果从不进消息历史" |
| P2 | 查到 16 条真运价，起草回复却用 `Will be provided later` 占位/编造 | `generate_draft` 对先前 `quote_search` 结果**零访问**，只有 300 字 `focus`；提示词明令"没有的数字用 {{占位}}、绝不编造" | tools.ts:1661-1783；ai.service.ts:314-343 |
| P3 | "一键冷开发"给了前置条件仍全量扫 8597 | `search_contacts` 无国家/阶段/行业/沉默筛选参数；描述反而教"传个宽泛词或 a 全库扫"；无专用冷开发工具 | tools.ts:338-343 |
| P4 | `quote_search` 返回 `total:0/quotes:[]` 但 `customerTable` 有 CMA 天津 SANTOS 报价行（自相矛盾） | `total/quotes/answer` 来自镜像库（含有效期过滤），`customerTable` 来自静态标准化层 `rates-standard.json`（无有效期/柜型过滤），两源独立计算 | tools.ts:1142-1160 vs 1108-1124 |
| P5 | 跨轮"记忆"只有 ~6 个工具的一行"共 N 条" | `extractFact` 按最终包络写，但 audit 收到的是瘦身替身 → 多数工具存不下事实；且事实仅 120 字、只回注最近 12 条 | memory.ts:66-85；tools.ts:495-498 及各 execute 的 audit 载荷 |
| P6 | 大结果落库即损坏 | `agent_tool_calls.resultJson` 硬切 4000 字，16 条 QuoteDto 会被截成非法 JSON；且从不回注模型 | tools.ts:505 |

P0（`needsApproval` 布尔覆盖导致写工具一调即崩）已在本轮前修复，不在本规范范围。

---

## 1. 设计原则

1. **数据载体与提示分离**：模型上下文里放**紧凑的结构化要点**（够它判断与复述），完整数据放**工作台**由工具**程序化直取**（不靠模型转述）。这条同时治 P1（失明）与 P2（编造）。
2. **结构化抽取，不存原始大块**：工作台存"决策相关字段"（柜型/POL/POD/价/有效期/联系人 id…），不存 12KB 正文、不存整页 JSON。治 P6 与上下文膨胀。
3. **单一事实源**：一个数据只在一处落、一处取。废弃"瘦事实"机制（`extractFact`/`agent_facts` 的 120 字一行），由工作台取代。治 P5。
4. **闭环显式化**：读信→查价→带价起草、筛选→预览→入队，用**工具间的数据传递**闭合，不再依赖"模型在同一轮里记得"。治 P2/P3。
5. **所见即所得**：批量/写操作的预览（条数+名单）= 实际执行对象（沿用既有红线）。
6. **只可加严**：审批闸门、副作用分级不动；工作台是读侧增强，不放宽任何写确认。

---

## 2. 架构：会话工作台（agent_working_memory）

### 2.1 新表

`src/main/db/schema/agent.ts` 增：

```ts
/** 会话工作台：数据型工具把「决策相关的结构化结果」落这里，跨轮/跨工具可取。
 *  取代 agent_facts 的瘦一行事实。按 conversationId 隔离，随会话归档。 */
export const agentWorkingMemory = sqliteTable("agent_working_memory", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull(),
  kind:           text("kind").notNull(),      // email | rates | contacts | inbox | backcheck | draft
  refId:          text("ref_id"),              // 去重键：email=messageId，rates=查询指纹，contacts=查询指纹…
  toolName:       text("tool_name").notNull(),
  /** 回放进上下文的紧凑要点（1-3 行，已含单位/口径），上限 ~400 字 */
  contextLine:    text("context_line").notNull(),
  /** 供工具程序化直取的完整结构化数据（JSON），上限 ~8KB，超限裁字段不裁条数优先 */
  payloadJson:    text("payload_json").notNull(),
  createdAt:      text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:      text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

迁移：`db/index.ts` 加 `CREATE TABLE IF NOT EXISTS`（对齐 schema-sql.ts），并补 `idx_awm_conv (conversation_id, kind)`。**同步改测试沙箱建表**（agent-tools-inbox / send-pipeline / crm-due 等所有 exec BASE_SCHEMA_SQL 处），否则 drizzle 全列 INSERT 报 no column（历史坑）。

`agent_facts` 保留表但**停止写入**（读侧过渡期兼容，见 §7 分期），最终由工作台完全取代。

### 2.2 写入模块

新增 `src/main/services/agent/working-memory.ts`（读写唯一入口，对齐 memory.ts 的收口风格）：

```ts
export type WmKind = "email" | "rates" | "contacts" | "inbox" | "backcheck" | "draft";
export interface WmItem { kind: WmKind; refId: string; toolName: string; contextLine: string; payload: unknown; }

/** upsert：同 (conversationId, kind, refId) 覆盖更新（重读同一封邮件/同条件重查 = 刷新而非堆叠） */
export function rememberWork(conversationId: string, item: WmItem): void;
/** 回放：取本会话最近若干条 contextLine，拼成注入块（总量封顶，见 2.3） */
export function recallWorkBlock(conversationId: string): ChatMsg[];
/** 程序化直取：工具按 kind/refId 或 kind 拿完整 payload（generate_draft 取 rates/email 用） */
export function getWork(conversationId: string, kind: WmKind, refId?: string): unknown | null;
export function listWork(conversationId: string, kind: WmKind, limit?: number): Array<{ refId: string; payload: unknown; updatedAt: string }>;
```

- `contextLine` 由**各工具自己产出**（它最懂自己的数据口径），不走通用 extract。
- `payloadJson` 写前 `JSON.stringify` 超 8KB 时**按字段优先级裁剪**（保条数、砍每条的长文本字段），绝不产出非法 JSON（治 P6）。
- 写入失败 try/catch 吞掉，不阻塞主流程（对齐 rememberToolFact）。

### 2.3 回放（治 P1 失明）

改 `memory.ts:loadConversation`：把原 `recallFactBlock` 换成 `recallWorkBlock`，注入块形如：

```
【系统注入·本会话工作台（此前已取到的真实数据，可直接引用，勿重复查、勿编造）】
· 邮件#16703 Three Logistics「QUOTE-1297-0926」询价：柜型 1×40'HC，起运 宁波(CNNBG)，目的 桑托斯(BRSSZ)，FOB，货值 USD17,300，FAK/非危/可堆叠
· 运价 宁波→桑托斯 40HQ：16 条，最低 CMA 天津 $8,000（成本价/FT14）；EMC 宁波 $9,200（9/8-9/14）…（top5）
· 联系人 检索"..."：命中 42，含 …（top5 姓名/公司/国家/阶段）
```

约束：
- 只回注 `contextLine`，总字符封顶 **~1800**（超出按 `updatedAt` 新→旧保留，旧的丢尾）。
- 条数封顶 **~12**（对齐原 FACT_RECALL_LIMIT 口径）。
- 注入位置与原来一致（历史消息之前、以"系统注入"user 消息承载）。
- 明确告诉模型"这是已取到的真实数据，可直接引用；相同条件不要重复查；不在这里的不要编"。

### 2.4 各工具写什么（结构化抽取契约）

| 工具 | kind | refId | contextLine（要点） | payload（程序化直取） |
|---|---|---|---|---|
| email_read_full | email | messageId | 发件人/公司+主题+**柜型/POL/POD/incoterm/货值/货描/quote编号**（从正文解析，见 §3.1） | 全字段 + bodyExcerpt（关键行，≤1500 字） |
| email_summarize | email | messageId | 摘要一行 + intent | {summary, intent, from, subject} |
| inbox_search | inbox | 查询指纹 | 命中 N，top5 发件人/主题/时间/意图 | hits[]（id/from/subject/receivedAt/intent/classification） |
| quote_search | rates | 查询指纹(q+pod+lane+container+carrier) | 航线/港/柜型 + 命中数 + **top5 船司/价/有效期/起运港** + 镜像同步时间 | rows[]（carrier/container/pol/pod/price/validFrom/validTo/note）+ cheapest + mirrorSyncedAt |
| search_contacts | contacts | 查询指纹 | 命中 N（+筛选条件回显）+ top5 姓名/公司/国家/阶段/最近跟进 | hits[]（id/name/email/company/country/stage/lastFollowupAt）+ total + filters |
| company_backcheck | backcheck | 公司名 | 一行结论 | 报告结构 |
| generate_draft | draft | messageId 或 target | 主题+字数+所用数据源标记 | {subject, body, usedRatesRef, usedEmailRef} |

写入点：各 `execute` 成功返回前调 `rememberWork(...)`（与现有 `audit(...)` 并列）。**audit 载荷错配（P5）就此绕过**：不再依赖 audit→extractFact 这条断链，工作台由工具显式写。

---

## 3. 闭环一：读信 → 查价 → 带真价起草（治 P1/P2）

### 3.1 email_read_full 解析结构化字段

新增 `src/main/services/agent/email-parse.ts`：从纯文本正文抽取询价要素（正则+关键词，纯本地、不调模型）：
- `container`（柜型：`1×40'HC`/`40HQ`/`20GP`… 归一）、`pol`/`pod`（含 UN/LOCODE 如 CNNBG/BRSSZ）、`incoterm`（FOB/CIF…）、`cargo`（货描/危险品/堆叠）、`cargoValue`、`quoteRef`（QUOTE-xxxx）、`volume`/`weight`、`etd`/`cutoff` 线索。
- 抽不到的字段留 null，**不猜**（对齐运价"定位不到不猜"的既有原则）。
- 这些字段进 email 工作台的 contextLine + payload。

效果：即便正文本身不回注，柜型/港/货描作为**结构化要点**常驻工作台 → 下一轮问柜型直接命中（治 P1）。

### 3.2 quote_search 结果进工作台

`total>0` 时把 rows（top N，按价升序）写入 rates 工作台（§2.4）。`customerTable` 与 `total` 的矛盾按 §5.1 归一后再写，保证写进去的与界面显示的一致。

### 3.3 generate_draft 程序化取真价（治 P2 核心）

- **新增入参**（schema）：`useRates?: boolean`（回信/报价模式默认 true）、`rateRef?: string`（可选，指定用哪次查价；不传则取本会话最近一次与"该邮件 POL/POD/柜型"匹配的 rates 工作台项）。
- **reply 模式数据装配**（tools.ts generate_draft execute）：
  1. 由 messageId 取 email 工作台项（含解析出的 pol/pod/container）；若无则现场 `getBody` 解析（复用 email-parse）。
  2. 按 email 的 pod/lane + container 在 rates 工作台 `getWork/listWork` 里找匹配项；命中则取其 rows。
  3. 若工作台无匹配运价 → **不编造**：草稿如实走"暂无报价"话术，并在返回里给 `notice` 提示模型"先 quote_search 查该航线再起草"（把闭环缺口显式暴露，而不是静默占位）。
- **ai.service 扩展**：`EmailReplyInput` 增 `rates?: RateLine[]`、`emailFacts?: EmailParseResult`；`generateEmailReply` 的 system/user 提示注入这些**真实数据**，并改口径为"下列运价/要素是系统已查到的真实数据，必须据此作答；没有的才用 {{占位}} 并说明"。
- 效果：草稿带真价真船期，占位符只在真没数据时出现（治 P2）。

---

## 4. 闭环二：一键冷开发（治 P3）

### 4.1 search_contacts 增结构化筛选

schema 增（全部可选，向后兼容）：
- `country`（多国 OR）、`stage`（cold/f1..f4 等库内真实阶段值，非法值当面纠错不静默降级——对齐 inbox_search 过滤词表原则）、`industry`/`tags`、`silenceDays`（最近跟进早于 N 天，复用既有 stale CTE）、`validEmail`（排除 no.email/占位符）、`excludeRecentDays`（近 N 天已联系过的排除）。
- 描述改写：**删除"传个 a 全库扫"的教唆**，改为"按条件精确筛选；条件越具体命中越准；要全量也须显式说明理由"。
- 返回 `total` 为真命中数，`filtersApplied` 回显实际生效的筛选（让模型和用户都看见"确实用了前置条件"）。

### 4.2 冷开发编排：复用既有批量确认卡（不新造 cold_outreach）

勘查后修订：`search_contacts` 多命中路径**已经**返回一张批量审批动作卡「给这 N 位各生成一封跟进信」，其 `run` 就是 select→逐人生成草稿→`startDynamicSend` 入队（写动作、审批门、入队≠发送）。再造一个 `cold_outreach` 写工具是重复造轮子，还要多碰一次发送引擎、徒增风险。**决定：不新增工具，复用这张卡。**

于是冷开发闭环的真实缺口只有两处：
1. **没有筛选** → 卡片作用于"全量扫回来的前 N 个"而非按前置条件圈定的人。由 §4.1 的结构化筛选补齐（筛选后的命中集直接喂给这张卡）。
2. **批量上限** → 勘查后此岔路不存在：`send_queue_add` 的 contactIds 单次上限就是 **2000**（与工具描述一致），且其描述已完整教了「① 筛选圈人 → ② 内容（模板变量个性化）→ ③ 入队」的批量流程。于是两条路径各司其职、均无需改引擎：
   - **>10 人的冷开发** = search_contacts 结构化筛选圈人 → send_queue_add 模板入队（一次 ≤2000，`{{company}}/{{firstName}}` 变量个性化，人工确认卡，入队≠发送）；
   - **≤10 人的小批定制** = 既有「给这 N 位各生成跟进信」动作卡（逐人 LLM 定制草稿）。

红线不变：**AI 永不触发"开始群发"**，只入队；开始仍在发送中心手动点。
效果：用户"给前置条件 → 一键冷开发"= 一次带筛选、带预览确认、可覆盖数十上百人的精确入队，不再全量 8597。

---

## 5. 稳定性修复

### 5.1 quote_search 三源归一（治 P4）

问题：`total/quotes/answer`（镜像库，含有效期过滤）与 `customerTable`（静态标准化层，无有效期/柜型过滤）各算各的 → 自相矛盾。

修法（择一，规范取 A）：
- **A. 以镜像为准，标准化层降级为"补充候选"**：`total===0` 且标准化层有行时，不把它塞进 `customerTable` 冒充结果，而是放进 `candidates`/`notice`，措辞明确"镜像未命中（可能滞后，最近同步 X）；标准化参考层有 Y 条，供换词重试或去运价页同步"。保证 `total/quotes/customerTable` 同源一致，界面与回注不再打架。
- 工作台写入（§3.2）只写"与界面一致"的那份，杜绝"存的是 0 条、界面显示有价"。
- 注：本条与运价线（rates-clean/quote_search 正在另一工作流改）有交集，落地前与该线对齐，避免双改冲突。

### 5.2 大结果不再截断损坏（治 P6）

工作台 payload 按 §2.2 裁剪（保条数、砍长文本），产出合法 JSON；`agent_tool_calls.resultJson` 维持 4000 字仅作 UI 留痕，不再承担"数据源"职责（数据源是工作台）。

### 5.3 废弃瘦事实链（治 P5）

`extractFact`/`rememberToolFact`/`recallFactBlock` 停止用于跨轮记忆（过渡期可保留读兼容），由工作台取代。audit 仍留痕（审计职责不变），但不再兼作记忆写入点 → 消除"audit 载荷 vs 包络错配"这条隐性断链。

---

## 6. 模型档策略（智力，治"智力低下"）

- **agent 多轮**：恒关思考（已定，为规避 DeepSeek RC 回传 400）。工作台把真数据喂到脚边后，弱模型的"记忆/编造"压力大幅下降——**用架构补模型**，这是本规范的主线。
- **一次性能力调用**（generate_draft / company_backcheck / email_summarize / 会话压缩，走 ai.service，**单发无多轮历史**）：可安全开思考——RC 回传问题只发生在"带 assistant 历史的多轮"，单发请求没有上一条 assistant，不会触发。对这些高价值合成任务，按端点族注入思考（DeepSeek `thinking:{type:"enabled"}`），提升起草/背调质量。此开关只作用于 ai.service 单发路径，与 agent 多轮恒关互不影响。
- 可选：为 draft/backcheck 配置更强模型档（复用 LIGHT/独立端点路由），但非本规范必须项。

---

## 7. 分期实施与测试

**Phase 1（数据连续性核心，治 P1/P5/P6）**
- 建表 + 迁移 + 测试沙箱建表同步。
- `working-memory.ts`（rememberWork/recallWorkBlock/getWork/listWork）。
- `loadConversation` 换用 recallWorkBlock。
- email_read_full / quote_search / search_contacts / inbox_search 写工作台 + 产出 contextLine。
- 测试：新增 `agent-working-memory.test.ts`（写入/去重 upsert/回放封顶/程序化直取/8KB 裁剪合法性）；扩 `agent-memory-load.test.ts` 验证回放块。

**Phase 2（闭环一，治 P2）**
- `email-parse.ts` 结构化抽取 + 单测（用真源样例：1×40'HC/CNNBG/BRSSZ/FOB/QUOTE-1297）。
- generate_draft 取工作台运价 + ai.service `rates`/`emailFacts` 入参与提示改口径 + 单测（有价→草稿含真价；无价→不编造、给 notice）。

**Phase 3（闭环二，治 P3）**
- search_contacts 结构化筛选 + 描述去教唆 + 单测（国家/阶段/沉默/占位邮箱过滤；非法阶段值当面纠错）。
- cold_outreach 编排 + 预览确认 + 审批 + 入队（复用既有引擎）+ 单测（预览=执行对象；AI 不触发开始）。

**Phase 4（稳定性，治 P4 + 智力）**
- quote_search 三源归一（与运价线对齐后落地）。
- ai.service 单发路径按族开思考 + 单测。

**全局验证**：每期 `npm run typecheck`（忽略 rates-clean.ts 既有错，属另一工作流）+ `npx vitest run tests/unit`；涉及真模型行为的用 `tests/eval` live 抽验。

---

## 8. 边界（本规范不做）

- 不动发送引擎（串行/轮换/熔断/interleave）、不动审批闸门与副作用分级（只可加严）。
- 不引入向量检索/嵌入（工作台是结构化 KV，够用且可解释）。
- 不把原始邮件正文/整页 JSON 塞回上下文（只回注紧凑要点）。
- 不改前端渲染契约（工具结果卡/动作卡沿用），仅可能新增"工作台"只读视图（另议）。
- 运价线正在另一工作流改的文件（rates-clean.ts 等），Phase 4 落地前先对齐，避免双改冲突。

## 附（2026-09-09）：邮箱问答的时间与概览口径

- `inbox_search` 新增 `since`（今天/昨天/本周/最近3天/2026-09-09，服务端按**北京时间**算日界）与
  `includeSent`；**默认排除我方发出副本**——否则「今天的邮件有询盘吗」会被自己发的开发信挤满，
  实测第一轮就答错过。解析不了的 since 当面报 `bad_filter`，不静默降级成全量查。
- 新增只读工具 `mail_brief`（今日邮箱概览：来信/未读/回复/询价/退信/自动回复/我方发出 + 「等你回复」清单），
  数字与时间由服务端算好；agent 不再拉一页自己数分类、换算时区。
