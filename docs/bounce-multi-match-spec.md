# 退信 ↔ 被退联系人：一对多匹配，删除与显示同源

## 根因（用户实测钉出来的）

一封群发退信的详情显示「已匹配 20+ 人」，一键删除计数却是 1——两边根本不是一个口径：

- 详情「已匹配」：前端当场扫正文，**任何**出现在联系人库的邮箱都算（签名、抄送、被引用邮件的收件人都会混进来），回答的是"这封邮件提到了谁"；
- 一键删除：读库列 `inbox_messages.matched_contact_id`——按 DSN 标准头精确挑出的**被退人**，但一列只能存一个。一封退信通知 20 人被退时，19 个真实被退人删除够不着。

附带问题：弹窗数字前端算、删除后端按全库执行（预览与执行不符）；删除前无备份；删空的联系人名下孤儿公司不清理；关联到已消失旧 ID 的会被多计；事后查不到删了谁。

## 设计

### 1. 数据层：专属关联表

`inbox_bounce_matches (id PK AUTOINCREMENT, message_id NOT NULL, contact_id NOT NULL, created_at, UNIQUE(message_id, contact_id))`

- drizzle schema（schema/inbox.ts）+ BASE_SCHEMA_SQL（schema-sql.ts，评测沙箱共用）+ schema/index 导出；
- 迁移回填（runMigrations 幂等 SQL）：把存量 `matched_contact_id` 非空的退信补进关联表各一行；
- `matched_contact_id` 单列保留（= 第一个被退人），旧读取方不动。

### 2. 提取升级：全员被退

新函数 `extractBouncedContacts(text): number[]`，去重、上限 50：

- ① DSN 层收**全部**：X-Failed-Recipients（可逗号多址/多行）+ 所有 Final-Recipient/Original-Recipient；该层有任一命中即返回；
- ② 正文自然语言模式全部 matchAll；
- ③ 全文兜底：排除系统地址与我方域名后全部能匹配联系人的。

`extractBouncedContact` = 取第一个，兼容旧调用。

### 3. 写链统一：recordBounceMatches

`recordBounceMatches(msgId, cids)` 一处干齐：幂等写关联表 → 单列空则补第一个 → 每个**新**cid markAsBounced + 补一条 bounced interaction（同 contact+message 已存在则跳过）。

applyBounceSource（原文到手）、backfillMatchFromBody（点开正文）、backfillBounceMatches（周期补扫：条件从"单列为空"改为"关联表为空"）、classifyMessage（手动标退信）四条路全走它。

### 4. 计数与删除：唯一数据源

`bounceMatchedContactIds()`：关联表 ∪ 单列，DISTINCT，INNER JOIN contacts（挂到已消失 ID 的天然不计）。

- 新 IPC `inbox:bounceMatchCount` → {count, emails(前 20)}：按钮显示与确认弹窗都用它，所见=所删；
- 新 IPC `inbox:bounceMatches(messageId)` → 该封的被退联系人摘要（id/email/company），供详情栏；
- `deleteAllBounce()` 改造：同源取 ids → **删除前**把每人（联系人整行 + interactions + crmStages + 关系边 + 关联退信 id）追加归档 `data/bounce-delete-archive.jsonl` → 级联删除 + 无联系人公司随手清（contact.service 抽公共 helper，deleteContact 同用它）→ 返回 {deleted, archive}；Log 记归档路径。

### 5. 前端（InboxList）

- 按钮：计数改后端现拉（react-query，随 ["inbox"] 失效），为 0 不显示；弹窗标题用后端 count + 邮箱预览；按钮文案「一键删除被退联系人 (N)」；
- 详情匹配栏改三段：**被退联系人（N 人）**（来自 bounceMatches，逐行可单人删）→ **正文提到的其他联系人**（原松口径、排除已入上栏者，标注"仅参考，非被退"）→ 未匹配地址照旧。

### 6. 顺手一处

agent.service 邮件上下文注入行的「已匹配联系人 #id」改为带全部被退 id 列表，别让助手也只见一个。

## 验证

- 单测：extractBouncedContacts 三层全收/多址/排除/去重/钳制（纯函数，新建 bounce-match.test.ts）；
- typecheck + 全量 npm test；
- 实测：多收件人退信 → 详情「被退联系人」列 N 人、按钮计数 N、删除后归档文件有内容、退信邮件保留且解除关联。

## 不做的事

- 不删邮件本身；CRM 时间线读时合并规则不动；关联表不做外键级联（删除逻辑自己管，与现有表风格一致）。
