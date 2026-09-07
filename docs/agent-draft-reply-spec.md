# 回信模式：generate_draft 支持「针对收到的邮件起草回复」

日期：2026-09-07
背景：用户让 agent「第一封，以运去哪的身份回复他」，agent 读完邮件后只能输出一段回复策略建议——
`generate_draft` 底层的 `generateEmailDraft` 只按公司档案/背调写开发信，看不到对方来信内容，
逐条回应无从谈起。本规范补上这个缺口。

## 原则

- **仍然只出文本不发送**：`generate_draft` 维持 `sideEffect: "read"`、免审批；外发仍走「入队」动作卡
  （写操作、需确认、入队 ≠ 发送），红线不变：AI 永不触发发送。
- **草稿必须逐条回应来信**：回信模式的 prompt 里要有对方邮件全文（纯文本），明确要求逐条应答；
  缺的信息（报价、资质文件等）坦诚说明会后续补，不许编造。

## 契约变更

### ai.service 新增 `generateEmailReply`

输入：`{ language?, companyName, contactName, fromEmail, subject, bodyText, focus?, sender? }`。
- `bodyText` = 来信纯文本（调用方负责清洗，截到 4000 字）；
- prompt 要求：用对方来信的语言回复（language 传了则强制）、先简短回应来信要点再逐条应答、
  沿用 `generateEmailDraft` 的身份块与报价纪律（真实落款、未经确认的价不承诺）；
- 输出与 `generateEmailDraft` 同格式（`SUBJECT:` 行 + 正文），复用 `parseDraft`。

### tools.ts `generate_draft` 扩展

- schema 加 `messageId: optInt()`（来自 inbox_search）。传了 = 回信模式。
- 回信模式执行流：
  1. 按 messageId 取 `inboxMessages` 行；不存在报 `not_found`（与 email_read_full 同口径）；
  2. `getBody` + `htmlToText` 清洗正文，截 4000 字；
  3. 收件人定位：优先 `matchedContactId`，否则按 `fromEmail` 精确等值匹配 contacts
     （邮箱是唯一键，禁模糊匹配——跨国错配教训见 search_contacts 历史）；
  4. 主题 = 原主题（无 `Re:` 前缀则加）；companyName/contactName 取联系人档案，缺省用 fromName/fromEmail；
  5. 结果卡动作与开发信模式一致：存素材库 + 命中联系人时的「入队发给这位联系人」。
- 工具描述同步改：写「回复某封邮件」时传 messageId 走回信模式。

### manifest.ts

`generate_draft` 的 label/route 补回信语义（撰写开发信/回信草稿）。

## 验收

- 单测（agent-tools-inbox 风格，mock ai.service）：
  回信模式取信→清洗→prompt 含来信正文；邮件不存在报错；fromEmail 精确匹配收件人；
  未命中联系人不阻塞出稿（actions 只有存素材库）。
- live eval（tests/eval）：给一封真实来信 id，产出草稿逐条回应。

## 询价信回信：先查台账价，再成稿（2026-09-07 用户拍板，走 B 方案）

用户口径：**解析询价邮件时，「直接起草回复」基本就等于「直接报价」**——程序必须先查台账价，
再出客户报价表，然后把表嵌进回信。本节定这条链路；表格出口按 B 方案留接缝。

### 分工（两条工作流合流，抽取层不重写第二套）

| 环节 | 归属 | 实现 |
|---|---|---|
| 来信询价要素抽取 | 闭环工作流（已有） | `agent/email-parse.ts` `parseEmailInquiry` → 柜型归一 + pol/polCode/pod/podCode + 条款/货值/询价号 |
| 真价来源①：会话工作台 | 闭环工作流（已有） | `pickRatesForEmail(inq, listWork(convId,"rates",8))`——本轮/本会话已查过的价优先复用 |
| 真价来源②：台账自查 | **本节新增** | `agent/reply-rates.ts` `lookupReplyRates(inq)`——工作台没匹配价时工具自己查一次 |
| 真价进 prompt | 闭环工作流（已有） | `ai.service.buildRateContext(rates, facts)`：硬口径「必须据此报价、禁编造/占位、每条注明有效期、整体加以船司实时报价为准」 |
| 客户报价表（英文十一列） | **本节新增** | `agent/reply-rates.ts` `customerQuoteTable(rows, pod, inq)` → 经 `EmailReplyInput.quoteTable` 进 prompt，模型只许原样嵌入 |

### 判定与查价（代码做，不靠模型猜）

1. **判定询价**：来信 intent 为 `price_inquiry`，或正文能抽出目的港。**抽不出目的港就不查价**
   （宁可不报，不可报错价），回信按普通往来处理。
2. **两级取价**：工作台命中就用工作台的（省一次查询、且是用户刚看过的那批）；没命中才自查台账。
   自查复用 `quote_search` 同一套出口（`resolveQueryPod` + `podRawExpansion` + `listQuotes`），
   `includeExpired=false`，**不另写一套匹配逻辑**。
3. **起运港对齐**：镜像 `pol` 是中文群名（宁波/天津/蛇口/华南基本港…），来信是 `CNNBG`/`NINGBO`。
   `mirrorPolSet()` 把来信港映射成**可接受的 pol 集合**（华南基本港覆盖深圳/蛇口/盐田/南沙，
   所以是集合不是单值）。起运港**不做硬过滤**——硬过滤会把「华南基本港」这类群名行整批漏掉；
   改为分区排序：对得上的排前、对不上的排后，`polAligned=false` 时结论须逐条写明起运港。
4. **两级都没有**：`inquiryNoRates` → 草稿走「报价稍后补」话术、不编数字，返回 notice 让模型
   如实交代「台账暂无该航线当期报价」并给两条出口（运价页手动同步 / `market_research` 联网调研）。
   **不再要求模型「先 quote_search 再重调本工具」**——弱模型实测不照做，等于把活推回给用户。
5. **审计**：`generate_draft` 的 result 带 `ratesAttached` 与 `ratesSelfQueried`（区分价从哪来）。

### 客户报价表（已落地：`reply-rates.customerQuoteTable`）

英文十一列 `CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK`，机械生成、模型只许原样嵌入：

- **CARRIER**：群内简称/长名 → 国际标准缩写（`CMA CGM`→CMA、`MAERSK`→MSK、`EVERGREEN`→EMC…）；
  「未注明/未知/N/A/-」不是船司名 → `/`。
- **POL**：镜像是中文群名 → 英文大写港名（宁波→NINGBO、华南基本港→CHINA BASE PORTS）；
  该行起运港与**来信要求的起运港**对得上时，用来信的写法（如 `CNNBG`）——客户看的就是自己问的那个港。
  认不出的中文群名 → `/`（不音译、不猜）。
- **POD**：一律用查询归一后的标准港名（`SANTOS`）。航线级行（podRaw=南美东）与多港粘连行
  （`SANTOS/ITAJAI`）都收敛到目标港，满足「不得粘连港口、有多个港口要分离并提取目标港口」。
- **透视**：同船司 + 同起运港的多柜型行合并成一行三列价；缺的柜型 `/`。多起运港天然拆行（POL 唯一）。
- **FT**：目免只取天数（`21天`/`21 combined` → `21`）；**ETD**：`2026-09-12`/`9.6晚开` → `12 Sep`/`6 Sep`，
  认不出 → `/`；**VALIDITY**：同月 `8-14 Sep`、跨月 `28 Aug-3 Sep`、单端给单个日期、都没有 `/`。
- **TT**：恒 `/`（台账没有航程数据，不猜）。
- **REMARK**：只留客户看得懂的（附加费/免费期/直转航），剔手机号与座机；内部溯源
  （来源群/发送人/入库时间）**不进客户表**，它们只在工作表里。
- 数据支撑：`QuoteDto` 尾部补 `etd`（尾部追加不改表格卡前 7 键的展示序）；
  `ReplyRateRow` 在 `RateRow` 上补可选 `ft`/`etd`（向后兼容工作台里早先存的 payload）。

**与运价清洗工作流的关系**：`rates-clean.customerQuoteMarkdown` 是同一张表的另一个实现（服务
`quote_search` 的「做成客户报价表」出口）。两处口径已按同一份规范写死，等它单测转绿后
**二者合并为一个出口**（谁调用谁），不许长期并存两套透视逻辑——列名/占位/日期格式一旦漂移，
客户拿到的就是两张不一样的报价单。

### 验收（增量）

- 单测（`tests/unit/reply-rates.test.ts`）：真实 Three Logistics 询价信 → 抽出 NINGBO/CNNBG、
  SANTOS/BRSSZ、40HQ；LOCODE 只认国家码开头的真代码（`Porto`/`CHINA` 不许冒充）；
  `mirrorPolSet` 对 CNNBG→宁波、CNSZX→含华南基本港、未知港→null；
  台账自查按起运港分区 + 价升序，过期与错柜型不许混进来；抽不到目的港返回 null（不查、不猜）。
- 单测（客户报价表）：表头十一列锁死、TT 恒 `/`；同船司同起运港多柜型合并成一行三列、缺项 `/`；
  POL 中文群名→英文大写、与来信对齐时用来信写法；POD 收敛到标准港名（航线级/多港粘连行同样）；
  `CMA CGM`→CMA、「未注明」→`/`；VALIDITY 同月/跨月/单端、ETD 自由文本取日、FT 只取天数；
  备注剔手机号；空行不出表。
- 单测（`tests/unit/agent-draft-reply.test.ts`）：工作台无价时 `generateEmailReply` 收到自查真价
  （`rates` 非空、`ratesSelfQueried` 进审计）；台账也没有时返回 `inquiryNoRates` 的 notice。
