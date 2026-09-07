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
