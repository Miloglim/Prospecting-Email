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

### 客户报价表（单一出口：委托 `rates-clean`）

英文十一列 `CARRIER/POL/POD/20GP/40HQ|HC/40NOR/FT/ETD/VALIDITY/TT/REMARK`。
**表体一律由运价清洗器生成**：`cleanQuoteRow` → `pivotQuotes` → `customerQuoteMarkdown`
（船司标准缩写、多港拆分、三列柜型价透视、目免/船期/有效期格式、缺项 `/`、TT 恒 `/`
都在 `rates-clean.ts` 里锁死并有 32 条单测）。回信侧不写第二套透视/格式化逻辑——
`rates-clean` 转绿（commit 01cb3df）后已完成合并，`quote_search` 与回信共用同一实现。

`reply-rates.customerQuoteTable(rows, pod, inq?)` 只做四件适配：

1. **行形状归一**：台账自查的 `QuoteDto`（字段全：目免/船期/有效期原文/来源群）与会话工作台的
   `RateRow`（精简）都能进；拿不到的字段给 `null`，由清洗器按既定降级处理，不猜。
   `lookupReplyRates` 因此额外透出 `dtos`，出表优先用原始行。
2. **航线级行的 POD 换成查询目标港**：`podRaw=南美东` 这类中文航线名直接进清洗器会让客户表
   出现中文 POD；换成目标港（`SANTOS`）即「航线级报价展开到具体港」。多港粘连行
   （`SANTOS/ITAJAI`）由清洗器 `cleanPod` 拆开取目标港。
3. **备注剔联系方式**：手机号/座机在进清洗器前抹掉——客户报价表是对外交付物，
   同事的号码不能跟着价格发出去。
4. **REMARK 全英文（2026-09-08 用户定案，会话导出实锤）**：清洗器出口
   `rates-clean.customerRemarkEn` 三道闸——内部操作语整条判丢（成本价/批价/刷箱/可以申请…→ `/`）、
   有限词表机械译英（重柜费/吨及以上/含/delay至/拖班到/南美东/十值口岸…）、译完仍含中文置 `/`。
   **宁可空，绝不中英混排给客户**；9 条真备注钉在 `tests/unit/customer-remark-en.test.ts`。

**与 quote_search 两表分离对齐**：`quote_search` 现在回 `userTable`（中文工作表，含报价单截图＝
信息来源）与 `customerTable`（本出口生成的英文表）两张，回信只嵌后者；模型不再自己挑表。

**POL 口径**：用清洗器的口岸英文表（宁波→NINGBO、华南基本港→SOUTH CHINA），
**不再**改成来信的 LOCODE 写法（早前版本曾用 `CNNBG`）。两种都合规，但必须与 `quote_search`
出口那一张表逐字一致，否则客户会收到两张不一样的报价单。

`messageText`（整条群消息原文，几 KB）不为出表回捞：缺了就走结构化字段；等 `quote_search`
那条线接上清洗器后，两侧自然共用同一批带原文的行。

数据支撑：`QuoteDto` 尾部补 `etd`（尾部追加不改表格卡前 7 键的展示序）；
`ReplyRateRow` 在 `RateRow` 上补可选 `ft`/`etd`（向后兼容工作台里早先存的 payload）。

### 验收（增量）

- 单测（`tests/unit/reply-rates.test.ts`）：真实 Three Logistics 询价信 → 抽出 NINGBO/CNNBG、
  SANTOS/BRSSZ、40HQ；LOCODE 只认国家码开头的真代码（`Porto`/`CHINA` 不许冒充）；
  `mirrorPolSet` 对 CNNBG→宁波、CNSZX→含华南基本港、未知港→null；
  台账自查按起运港分区 + 价升序，过期与错柜型不许混进来；抽不到目的港返回 null（不查、不猜）。
- 单测（客户报价表）：表头十一列锁死、TT 恒 `/`；同船司同起运港多柜型合并成一行三列、缺项 `/`；
  POL 走清洗器英文表（宁波→NINGBO）；POD 收敛到标准港名（航线级/多港粘连行同样）；
  `CMA CGM`→CMA、「未注明」→`/`；跨月有效期、自由文本船期（`9.6晚开`→`6 Sep`）、目免取天数；
  备注剔手机号；空行不出表。
- 单测（`tests/unit/agent-draft-reply.test.ts`）：工作台无价时 `generateEmailReply` 收到自查真价
  （`rates` 非空、`ratesSelfQueried` 进审计）；台账也没有时返回 `inquiryNoRates` 的 notice。
