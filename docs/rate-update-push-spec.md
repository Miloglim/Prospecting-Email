# 定向运价更新推送规范（跟进看板客户 × 港口偏好 → 针对性运价邮件）

> 一句话：用户说一句「给跟进的客户更新运价」，程序自己把**看板客户 + 各家的港口偏好**聚合出来，
> 按偏好港分组取**台账当期真价**，生成**全英文对外报价邮件**，分组入队（不自动发送）。
> 发送引擎、运价清洗出口、审批红线一律复用既有链路，本规范只补「聚合 + 分组 + 成文」这一段。

关联规范：`rates-answer-chain-spec.md`（两张表谁生成谁不许改）、`agent-draft-reply-spec.md`（客户报价表十一列）、
`smart-send-spec.md`（AI 不做计划外发送）、`suggestion-feed-spec.md`（建议卡机制）。

## 0.5 已拍板决策（2026-09-08）

1. **港口偏好读时派生，不建新表**：显式偏好（看板「偏好设置」里的 `extra.preferredPorts`）∪ 近 90 天来信解析
   （`parseEmailInquiry` 抽 POD/POL/柜型）。读时算 ⇒ 历史邮件立即生效、无需回填、不改 schema。
2. **一人只进一组**：每位客户只按「分最高那个港 + 该客户语言」收一封运价更新，绝不因为关注两个港就收到两封。
3. **AI 永不触发群发开始**（既有红线，本功能一处不松）：`rate_update_enqueue` 只入队
   （`startQueue(items, false)`），发送必须用户自己在发送中心点「开始」。
4. **宁缺毋滥**：港口推断不出来、或台账当期无有效价 ⇒ 该客户**不进方案**，进「未覆盖」名单如实报数，
   绝不编价、不用别的港的价凑数（对齐运价线「查不到 ≠ 没有，但更不许造」）。
5. **两个入口，一条流水线**：agent 会话（打字驱动）与跟进看板「运价更新」抽屉（点按钮出产物）调**同一个 service**，
   方案结构与入队路径完全一致；预览即执行对象（所见即所发）。
6. **不新增 schema、不给 send_queue 加列**：组内容标签复用既有 `tplName`（`运价更新 · SANTOS`）。

### 0.6 实测后的修订（2026-09-08，用户丢来会话导出复盘）

7. **范围两分，不再混说「客户」**：`scope=board`（默认）=跟进看板（`status IN (reached,replied)` + 按管线阶段筛）；
   `scope=contacts`=联系人库全量（含冷客户，只剔 `bounced/autoreply` 与占位邮箱）。此前两者混在一起，
   用户说「选出所有巴西客户」时工具一个人也圈不到，模型只好绕 `search_contacts` 自己拼名单（实锤翻车点）。
   `country`（中英文都认）负责「按国家收窄」这个最高频诉求。
8. **没偏好不再等于推不出去**：求港顺序=点名港 → 自己的港口偏好 → **所在国家当期代表港兜底**
   （`portForCountry`：国家关键词 LIKE 镜像 → `cleanPod` 抽英文港名 → 形态闸门 → 条数/价优选）。
   三条都落口才记 `no_port`。兜底组 `basis="country"`、展示名带方向（`SANTOS (Brazil)`），界面明标「按国家」。
9. **港口必须先认证**：来信「标签独行、值在下一行」的形态会把整句/邮件标题/签名当成目的港
   （实锤建过组的：`QUICK UPDATE ON SPACE AVAILABLE.`、`UMESH SHARMA INTEX GROUP <SALES6@…>`）——
   假港既污染名单又挤掉真客户的组数名额。现在双闸：`plausiblePortToken`（形态）+ `knownPod`（台账真有该港）；
   人工登记的港只过形态闸（当期有没有价交给方案层判 `no_live_rate`）。`maxGroups` 默认 10 → 24。
10. **航线级价如实标注 + 可引用事实白名单**：命中「南美东/墨西哥」这类区域基本港价时 `laneLevel=true`，
    界面出「航线级价」徽章、邮件正文写进 laneNote（中文航线名绝不进客户邮件），转述必须说清不是本港专属价。
    每组另带 `facts`（与对外表同一批单元格文本），notice 钉死「只许引用 totals/facts/preview 里有过的字符串」——
    实测模型曾凭空编出「HMM 延迟到 9/21、ZIM 走 feeder、CMA 有 EFS 附加费」这类工具根本没返回的细节，这是本功能最高优先级的禁令。

### 0.7 第二轮实测加固（2026-09-08 14:05 会话导出）

11. **参数误用纠偏**：模型把用户口中的国家塞进了 `port`（`port=巴西`）→ `looksLikeCountry` 认得就纠回 `country`，
    并在返回里写 `corrected` 说明纠正了什么；另加 `statuses` 参数，接住「status=已触达的那批」这类说法。
12. **圈不到人不是故障**：范围里 0 人时返回**空方案**（`emptyReason` + `suggestScope`），工具据此给一键「改用联系人库重试」
    的续问动作，界面同样显示原因 + 切换按钮。错误与空结果的 `notice` 钉死话术边界：
    **绝不许把「没圈到人」解释成权限不足/账号未启用/去找管理员**——实测模型就是这么对用户说的，用户当真了。

---

## 0. 现状与缺口（代码证据）

已有：
- 运价镜像 + 查价出口：`rate-sync.service.ts`（`listQuotes/listQuoteRaws/countQuotes/QuoteFilters`、
  `ratesDiff()` 降价/新增港/将过期原料）、`rates-clean.ts`（`cleanQuoteRow → pivotQuotes →
  customerQuoteMarkdown` 英文十一列 + `customerRemarkEn` 三闸）、`agent/reply-rates.ts`
  （`lookupReplyRates` 台账自查 + `customerQuoteTable`）。
- 看板与偏好：`crm.service.ts listPipeline()`（`status='reached'`，管线阶段由 `tags` 推导）；
  看板详情「偏好设置」写 `contacts.extra.preferredPorts`（**JSON 字符串**，元素 `{pol,pod}`，
  `CrmPipeline.tsx:663`）。
- 来信要素解析：`agent/email-parse.ts parseEmailInquiry`（含「标签独行值在下一行」形态 + LOCODE 国家码校验）、
  `inbox.service.ts readLocalBodyHtml(id)`（本地全文，纯 fs）。
- 发送引擎：`send.service.ts buildDynamicQueue(contactIds, subject, body, cc)`（按公司分组、`{{变量}}` 发送时渲染、
  HTML 正文走 `send.ipc.ts sendBcc` 的 html 分支）+ `startQueue(items, autoStart)`。

缺口（本规范要补）：
1. **没有「客户 → 感兴趣港口」的聚合**：全库零处把 `preferredPorts` 与来信 POD 合并查询（只有单封邮件级解析）。
2. **没有运价更新邮件正文**：模板表 `templates` 与内置句库都是开发信语料，不注入运价；`assembleEmail` 也不带价。
3. **`buildDynamicQueue` 一份正文全员同文**：定向按港投递需要「分组各自成文 → 合并成一个批次入队」。
4. **对外邮件表没有 HTML 形态**：只有 `customerQuoteMarkdown`；邮件里贴 Markdown 会成一坨竖线。
5. **agent 无此能力**：`TOOL_MANIFEST` 里没有「看板客户 + 偏好 + 当期价」的方案工具，模型只能一家家 quote_search
   + generate_draft + send_queue_add 手搓，既慢又必然漏人。

## 1. 设计原则

1. **引擎不动**：入队一律走 `buildDynamicQueue → startQueue(autoStart=false)`，账号轮换/公司交错/时窗/日配额/
   熔断/两步式队列全部继承（`smart-send-spec §1-1` 同构）。
2. **确定性成文**：邮件正文由 service 机械拼装（固定文案 + 真价表 + 变量占位），模型**不参与生成价格与表格**，
   只负责把方案讲给人听。表格唯一出口仍是 `rates-clean`（十一列、缺项 `/`、REMARK 三闸）。
3. **偏好有出处**：每个港口偏好都带 `sources`（manual/inbound）与 `lastSeenAt`，界面上点得开、agent 说得出——
   标注必须=实给（既有铁律）。
4. **失败降级不炸链**：来信正文读不到就退到 `bodyPreview`；镜像无价就进「未覆盖」；伴随查询异常按无数据处理。
5. **规模可控**：单次方案默认最多 300 位客户、每组最多 12 条报价、每人最多回溯 5 封来信；超限在返回里说明被截断。

## 2. 数据模型（无新表，全部读时派生）

```ts
// src/main/services/customer-ports.ts —— 只回答「这人关心哪些港」，不查价
export type PortSource = "manual" | "inbound";
export interface PortPref {
  pod: string;              // 标准英文港名（cleanPortSegment 收紧 → podQueryWord/resolveQueryPod 归一；归一不了取大写原文）
  pol: string | null;       // 该港常用起运港（manual 录的优先，其次来信 POL 的同段收紧结果）
  container: string | null; // 该港来信里出现最多的柜型（识别不了为 null，不猜）
  score: number;            // manual=4（人工登记压过一封信）；inbound 每封 2，近 30 天再 +1；同港累加
  sources: PortSource[];
  lastSeenAt: string | null; // 纯 manual 为 null
  hits: number;              // 来信命中次数（界面与回执标依据用）
}
export interface CustomerPorts { contactId: number; email: string; name: string; companyName: string | null;
  language: string | null; country: string | null; prefs: PortPref[] }   // prefs 按 score 降序，最多 6 个
export function parsePreferredPorts(raw: unknown): Array<{ pol: string; pod: string }>  // 双形态：JSON 字符串（看板写法）/ 数组
export function cleanPortSegment(raw: string | null | undefined): string | null        // 逗号前 + 柜型数量词前截断
export function normalizePodName(inq: { pod: string | null; podCode: string | null }): string | null
export function prefsFromManual(list: Array<{ pol: string; pod: string }>): PortPref[]
export function deriveCustomerPorts(contactIds?: number[], opts?: DeriveOpts): CustomerPorts[]
export function derivedPortsFor(contactId: number, opts?: DeriveOpts): PortPref[]      // 详情面板单客户
// DeriveOpts: { days=90, maxEmailsPerContact=5, maxContacts=300, maxBodyReads=2000, now? }

// src/main/services/rate-update.service.ts —— 聚合 → 选价 → 成文 → 入队
export interface RateUpdateGroup {
  key: string;                    // `${pod}|${language}` —— 选组标识
  pod: string; lane: string | null; language: Lang;   // Lang = EN | ES | PT（normalizeLang 收敛）
  customers: Array<{ id: number; name: string; email: string; company: string | null; sources: PortSource[]; evidence: string }>;
  quotes: CleanQuote[];           // rates-clean 清洗 + 透视后的行（界面表、邮件表同一批行）
  minUsd: number | null;
  earliestValidTo: string | null; // 组内最早到期（催单口径；表里逐行仍带各自有效期）
  carriers: string[];
  drop: { oldUsd: number; newUsd: number; pct: number } | null;   // 只来自 ratesDiff().priceDrops，匹配不上为 null
  subject: string; bodyHtml: string;
}
export interface RateUpdatePlan {
  id: string;                     // crypto.randomUUID 截短；pending store 键（TTL 30min，最多存 20 份）
  createdAt: string;
  scope: { stages: string[]; includeReplied: boolean; port: string | null; days: number; quotesPerGroup: number };
  groups: RateUpdateGroup[];
  uncovered: Array<{ contactId: number; name: string;
    reason: "no_port" | "no_live_rate" | "over_cap"; detail: string }>;
  totals: { customers: number; covered: number; groups: number; quotes: number; truncated: number; uncoveredTotal: number };
}
export function buildRateUpdatePlan(opts?: RateUpdateOpts): Result<RateUpdatePlan>
export function planView(plan: RateUpdatePlan): Record<string, unknown>       // 跨 IPC / 给模型的投影（组表不带正文，防大包）
export function composeRateUpdateEmail(copy: Copy, pod: string, tableHtml: string, drop): string
export function pendingPlanRateUpdate(planId: string): RateUpdatePlan | null   // 过期/不存在 null；入队成功后即作废（一次性）
export function clearPendingPlans(): void
export function pendingQueueGroups(): number      // 既有待发组数；-1 = 引擎正在发送（绝对不让插队）
export function enqueueRateUpdatePlan(planId: string, groupKeys?: string[], overwrite?: boolean):
  Promise<Result<{ occupied: true; pendingGroups: number } | { occupied: false; enqueue: EnqueueResult & { groups: number; pods: string[] } }>>
```

**范围（"跟进的客户"口径）**：`contacts.status IN ('reached','replied')`（看板 `reached` 为基线，
`includeReplied` 默认真——已回复客户正是运价更新的头号对象），排除 `bounced/autoreply/未触达`；
CRM 管线阶段由 `tags` 推导（与 `listPipeline` 同函数口径），默认排除 `lost`，可用 `stages` 收窄。

**港口偏好聚合规则**（`deriveCustomerPorts`）：
1. `manual`：`extra.preferredPorts` 逐条（双形态都认）→ 剔空 pod → `normalizePodName` → score 4。
   **人工登记压过一封信**：打平时用户自己录的偏好赢，界面改了立刻生效。
2. `inbound`：来信查询=「`matched_contact_id IN 这批人` OR `related_contact_ids` 非空」一次捞回窗口期内的信，
   再在内存里按 idSet 精判归属（不给每个 id 拼一条 `instr`——上千客户会撞 SQLite 变量上限）；
   剔 `classification='sent'`（NULL 也算来信），每人按时间倒序最多 5 封 →
   正文 `readLocalBodyHtml(id)` 经 `htmlToText` ?? `bodyPreview` → `parseEmailInquiry` →
   **POD 段先 `cleanPortSegment` 收紧**（"POD: Santos - BRSSZ, 2 x 40HQ" 这种标签行会把柜型/国家尾巴一起吃进来，
   取第一个逗号前 + 柜型数量词前那一段）→ `normalizePodName` 归一；有港才计分：score 2（近 30 天 +1），
   POL 同样收紧后记为该港起运港，柜型按该港计数取众数。
3. 同名港合并（score 相加、sources 并集、lastSeenAt 取新、hits 累加），按 score desc → lastSeenAt desc 排序，最多留 6 个港。
4. `lane` 不额外查库：方案成组后从该组清洗行里取第一条非空 `lane`，只为界面显示，不作过滤条件。

**定价**（复用，不另写匹配）：把偏好伪造成询价要素喂给
`lookupReplyRates({ pod, podCode: null, pol, polCode: null, container, … })` → `dtos`（起运港对齐优先 + 价升序 +
当期有效）→ `cleanQuoteRow/pivotQuotes` → 组内 top N；`customerQuoteTable`/新增 `customerQuoteHtml` 出表。
`polAligned=false` 时表里必须逐条带 POL（十一列本来就带，无需额外处理）。

## 3. 方案与投递流程

```
用户："给跟进的客户更新运价"
  └─ agent: rate_update_plan（读）─┐
     或 看板「运价更新」按钮 → 抽屉 ─┴─→ buildRateUpdatePlan()
        ① 圈人（看板口径 + stages/port 收窄）
        ② deriveCustomerPorts → 每人 top1 港 + 语言
        ③ 每港 lookupReplyRates → 无当期价 ⇒ 该组客户进 uncovered
        ④ ratesDiff() 贴降价标签（按 podToken 匹配，匹配不上不提降价）
        ⑤ 机械成文：subject/bodyHtml（EN/ES/PT 三套固定文案 + 真价 HTML 表）
        ⑥ 存 pending plan（planId）→ 返回方案
  └─ 人看方案（会话表格卡 / 抽屉预览）
  └─ agent: rate_update_enqueue（写，弹人工确认）─ 或抽屉「入队」按钮
        ⑦ 队列占用守卫：既有待发组 > 0 且引擎未运行 → 拒绝（须显式 overwrite，见 §8）
        ⑧ 每组 buildDynamicQueue(ids, subject, bodyHtml) → items.tplName = `运价更新 · {POD}`
        ⑨ 合并 items → startQueue(items, false) → 账号轮换/交错/配额裁剪全部继承
  └─ 人自己到「发送中心」点开始（红线：程序永不自动开始群发）
```

**幂等与防重**：`planId` 一次性（入队成功后从 pending store 删除）；`enqueue` 的 `groupKeys` 只接受该 plan 内存在的
key，未知 key 当面报错并列有效值（对齐「参数钳制不硬拒、但值必须真存在」的既有工具准则）。

**队列占用守卫存在的原因**：`startQueue` 落库前 `delete(send_queue)` 全表清空（`send.service.ts:734`）——
既有未发送批次会被本功能静默冲掉。这是真实现状，所以入队前必须查 `getQueueItems()` 的 pending 组数，
非 0 就停下让人决定（覆盖 or 先去发送中心处理）。

## 4. 邮件内容与语言

- **subject**（三语固定，命中降价时加前缀）：EN `Freight rates update · {POD}` / ES `Actualización de fletes · {POD}` /
  PT `Atualização de fretes · {POD}`；有 `drop` 时改为 `Price drop · {POD} freight rates`（ES/PT 同构）。
  **主题里不写有效期日期**：一组多行各有 VALIDITY，写单一日期会误导（逐行有效期在表里）。
- **bodyHtml** 固定骨架（`composeRateUpdateEmail` 本地拼装，不经模型）：
  1. 称呼 `Dear {{firstName}},`（ES `Estimado/a`、PT `Prezado(a)`）
  2. 一句：为您关注的 **{POD}** 更新当期可操作运价；有 `drop` 时补一句「较上轮下降 X%（USD A → B）」，X 由真 diff 算
  3. `<table>` = 新增 `rates-clean.customerQuoteHtml(rows, max)`：**与 `customerQuoteMarkdown` 同一批 CleanQuote、
     同一套列**（CARRIER/POL/POD/20GP/40HQ-HC/40NOR/FT/ETD/VALIDITY/TT/REMARK），缺项 `/`、TT 恒 `/`、
     REMARK 过 `customerRemarkEn` 三闸 —— **全表零中文**（单测钉死）。内联样式（邮件客户端不吃外部 CSS）。
  4. 尾注三条 `<li>`：只含海运费、本地杂费另议；参考价为台账镜像，以订舱时船司确认为准；请回复柜型与预计货期以便锁价。
  5. 一句 CTA（有货请回细节，我们确认最优船期）+ 结语 `Best regards`（ES/PT 对应）。签名不写入正文
     （`sendBcc` 按发信账号 `signature` 自动追加）。
- **变量**：正文只允许 `{{firstName}}/{{company}}` 这类既有占位（发送时 `renderTemplate` 渲染），
  价格与表格内容全部是定值，保证「预览所见 = 发出所得」。

## 5. Agent 工具（注册进 `agent/manifest.ts` 唯一事实源）

| 工具 | sideEffect | 预算 | 作用 |
|---|---|---|---|
| `rate_update_plan` | read | 2/轮 | 出方案：`groups`（组行，渲染端 `asRows` 认这个键 → 直接上数据表格卡）+ `planId` + `totals` + `uncovered` + `preview` + `queueOccupied` |
| `rate_update_enqueue` | write | 1/轮 | 按 `planId`(+`groupKeys`/`overwrite`) 入队，`requiresApproval` 派生=人工确认，只入队不发送 |

- 参数一律扁平 + 可选字段 `.nullable().optional()`（SDK 转换铁律）；`stages`/`contactIds`/`groupKeys` 用
  `z.preprocess`（`toWords`/`toIds`）容错成数组（弱模型会传逗号串）；`toWords` 刻意保留大小写——分组键 `SANTOS|EN` 要原样比对。
- **参数面按实测收缩**：`scope`（board/contacts）与 `country` 是这次新增的主维度；`stages` 描述改成
  「一般不用传，只有用户点名某一列时才传」——弱模型多传一个数组就多一次把 JSON 写坏的机会（实测两轮里 2/9 次调用废在解析上）。
- 工具返回除 `groups/totals/uncovered/planId/queueOccupied` 外，还带 `laneLevelGroups`（哪些组是航线级价，转述必须说清）
  和每组 `facts`（=对外表前几行的真实文本）。**模型只许引用 totals/facts/preview 里出现过的字符串**，
  船期延迟、中转、附加费、免箱期这类没在里面就不许提。
- `preview` = 人数最多那组邮件正文的纯文本形态（`htmlToText(bodyHtml)`，由 service 生成）：用户问「信长什么样」时模型原样贴，
  不自己重写。表格卡与正文都出自同一份方案对象，**预览即执行对象**。
- `rate_update_plan` 返回 `notice`：表格卡已渲染、不许在正文手抄第二份表；数字照抄 `totals`；
  必须问一句要不要入队，用户点头才调 `rate_update_enqueue`；`nextStep` 直接写清入队参数（planId）。
- 未覆盖名单必须说（`no_port` → 建议去看板「偏好设置」补录；`no_live_rate` → 说明台账该港当前无有效价，
  按 `rates-query-fallback-spec` 口径，不与「没有报价」混说；`over_cap` → 本轮组数上限没排上）。
  投影里 `uncovered` 明细只带前 30 条，**真实总数在 `totals.uncoveredTotal`**——报数以总数为准，列明细标「仅列前 30」。
- `rate_update_enqueue` 返回 `say`（入队组数/封数/被限额裁剪数）+ `actions`（navigate「去发送中心」）
  + `notice`（队列已建立未启动，发送须人工点开始）；成功即 `invalidateCache("rate_update_plan")`——
  方案是一次性的，缓存里再放出旧 planId 只会让模型撞「已过期」。
- 失败码：`plan_expired`（叫模型重新出方案）、`queue_occupied`（带既有待发组数，绝不替用户决定覆盖）、`enqueue_failed`。

## 6. UI

1. **两个入口，同一个面板**（`RateUpdatePanel.tsx`，antd Drawer 960px）：
   跟进看板筛选栏右侧「运价更新」= 按当前范围全量出方案；多选条里的「运价更新」= 只给已选这几位推（传 `contactIds`）。
   深链 `#/customers?view=board&ratepush=1` 直接开面板（建议卡、agent 回执都用它）。
2. **面板结构**：左 380px 组列表（复选框 + 港/语言 + 降价徽章，下面一行 客户数 · 报价条数 · 最低价 · 船司 · 最早到期），
   右为该组邮件 **iframe srcDoc 预览**（真 HTML，含表格；`sandbox=""`，不用外层 dangerouslySetInnerHTML 防样式互染），
   预览上方显示主题与「这组为什么收到」（每个客户的偏好出处）；顶部一行范围摘要 +「重新生成」；
   底部「入队 N 位客户」+ 常驻说明「入队 ≠ 发送」。语言不同的同港客户天然是两行两组（两封不同语正文）。
3. **未覆盖区**：可折叠列表，`no_port`（去补偏好）/ `no_live_rate`（台账无当期价）/ `over_cap`（组数上限没排上），
   客户名深链到详情。
4. **队列占用**：入队返回 `{ occupied: true, pendingGroups }` 时弹二次确认 Modal（明说「会清空当前 N 组待发」），
   确认后才带 `overwrite=true` 重试（对齐「破坏性操作先给范围与兜底」）；引擎正在发送时直接报错，不给覆盖选项。
5. **发送队列页**：`tplName` 已是 `运价更新 · {POD}`，既有列直接可见，无需改队列页；组卡片点开仍是完整 HTML 正文。
6. **详情「偏好设置」Tab**：偏好港口编辑下面新增「近 90 天来信提到」只读 chips（`rateUpdate:ports`，
   带 POL/柜型/封数/最近时间做依据）+「采用为偏好」一键写进 `extra.preferredPorts`——让偏好自己长出来，不用销售手打。
7. **建议流**：`GROUP_PROMPT` 新增 `同步运价` 前缀（写清"先出方案、入队不等于发送"）；intel 降价卡改指这个前缀
   并深链到运价更新面板，一句话就能驱动 `rate_update_plan`。
8. **审批人话化**：`describeApproval` 认得 `rate_update_enqueue`，确认框说「把运价更新方案（全部分组/仅 X）加入发送队列——
   只入队」，不裸露 `planId=xxx`。

## 7. 分期

- **P1（本次已实施）**：`customer-ports.ts` + `rate-update.service.ts`（含 pending plan 一次性消费与队列占用守卫）
  + `customerQuoteHtml`（与 markdown 表共用 `customerQuoteRows`）+ 两个 agent 工具 + `RATE_UPDATE` IPC 组
  + 看板面板 + 详情来信推断 chips + 建议卡改前缀 + 单测（`customer-ports`、`rate-update-push`）。
- **P2（不在本次）**：发送成功后自动记一条跟进（`runBatchLoop` 成功钩子，与 campaign 的
  `onCampaignSendSent` 同层）；`send_campaigns` 里把「运价更新」做成可复发的任务（触点=每轮新价）；
  运价更新效果回路（送达后 7 天回率）；AI 推断偏好的置信管理与回写。

## 8. 红线与边界

1. AI 永不触发群发开始：本功能所有路径都到 `startQueue(autoStart=false)` 为止，UI 里没有「开始发送」按钮。
2. 不编造价格：无当期有效价 ⇒ 整组不发；降价数字只能来自 `ratesDiff()`。
3. 对外内容全英文：表格唯一出口 `rates-clean`（`customerQuoteRows` 一份定义，markdown/HTML 两种渲染），
   REMARK 三闸不许绕过；正文文案只有 §4 的固定三语常量。
4. 预览即执行对象：抽屉/会话里报的客户数=入队客户数；`planId` 一次性；`overwrite` 必须显式点击。
5. 内部信息不外流：`sourceGroup/sender/syncedAt/imageUrl/备注联系方式` 一律不进正文（`customerQuoteHtml` 不接这些列）。
6. 不动 schema、不动发送引擎、不给 `send_queue` 加列。

## 9. 待拍板与已知限制

1. `includeReplied` 默认真（已回复客户进运价更新）是否需要改成默认关。
2. 一港多起运港时是否只推「与客户国家最匹配」的 POL（现按镜像 polAligned + 价升序，可能同表出现两个 POL）。
3. 运价更新是否要带台账截图（`imageUrl` 是局域网地址，客户侧打不开 → 现阶段不带；若要做需公网图源）。
4. **中文港名仍认不出**：`knownPod` 要求「台账 pod_raw 真含该词」，而港口词表只有英文别名 + LOCODE，
   所以「桑托斯」这种中文译名当 `port` 参数会当面报错（不再静默建假组），与 `quote_search` 同口径。要支持得先补词表。
5. **散文式提到港口不解析**：来信没写「POD: xxx」这类标签（例如 "our POD is Santos again"）时 `parseEmailInquiry`
   抽不到港 → 该客户没偏好。修法不是改这个共享解析器（回信链路也用它），而是 §0.6-8 的国家代表港兜底 +
   详情面板「采用为偏好」一键补录，两条路都通。
