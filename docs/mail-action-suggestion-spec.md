# 来信行动建议：客户回复 → 建档 / 进跟进列表（一键采纳）

日期：2026-09-08　用户口径：**agent 解析每一封邮件,如果是客户回复,就在首页新对话产生气泡,
问要不要把这个客户加入联系人(如果是新的),并将其更改为已触达、进入客户跟进列表。**

产品方向对齐（用户明示）：销售用户对"打字驱动 agent"接受度低 → 建议要藏进业务对象、**点一下就能采纳**，
不要求用户看懂背后是什么。

## 1. 口径先钉死（调研实测，别照抄直觉）

- **已触达 = `contacts.status='reached'`**，跟进看板 `crm.service.ts listPipeline()` 只用这一个值筛（L88）。
  `stage`（cold/f1-f4）是**发信阶段**、`tags`（reaching/quoting/…）是**分类列**，二者都不是"进跟进列表"的开关。
- 现状相反：`inbox.service.ts:803` 收到客户回复会 `updateContactStatus(id,"replied")` → 联系人**从看板消失**。
  本功能的动作就是把他置回 `reached`。（要不要顺带让看板也显示 replied 属另一个决策，见 §7。）
- 「客户回复」最可靠的判定组合：`classification='replied' AND my_role='to'`。
  - `sent`（我方副本）、`bounce`、`autoreply` 天然被 classification 排除；
  - 仅抄送（cc-only）在分类时已判 `other`，不会误进；
  - **我方内部域名互发会被判 `replied`**（`inbox.service.ts:143`：内部域名 + Re: 前缀），必须显式排除。

## 2. 识别：零模型，复用落库时已做的规则层

分类与联系人匹配在**每封邮件落库那一刻**已经做过（`inbox.ipc.ts:247/262/396/411`，正文到位后还会二次修正
`ipc:783-785` + `backfillMatchFromBody`）。所以"解析每一封邮件"这件事不是再调一次大模型读 1497 封，
而是**查这张已经解析完的表**：

原料查询（`collectCandidates` 内，一次 SQL + 内存去重）：

```
SELECT id, from_email, from_name, subject, received_at, matched_contact_id
FROM inbox_messages
WHERE classification = 'replied' AND my_role = 'to'
ORDER BY received_at DESC LIMIT 40
```

逐封过滤 → 候选：

1. 发件域名 ∈ `internalDomains()` → 跳过（同事之间的转发不是客户回复）；
2. 地址是 `noreply/no-reply/postmaster/noreply-/mailer-daemon/@…` 类公共信箱 → 跳过；
3. **库里没有这个邮箱** → 出「新客」候选（action=`addContact`，带 firstName/lastName 拆自 `from_name`）；
4. **库里有，但 `status ≠ 'reached'`**（replied / autoreply / 空）→ 出「进跟进」候选（action=`markReached`，带 contactId）；
5. 库里已有且 `status='reached'` → 无动作可做，不出；
6. 同一邮箱只出一条（取最新一封），候选 key 稳定：`act:new:<email小写>` / `act:reached:<contactId>`。

名字拆分：`from_name` 先砍掉 `|`、`-`、`(` 之后的公司/签名尾巴，再按空格切成 first/last；
拆不出就只填 email（客户详情页可补）。**不猜公司、不建公司档案**——脏数据比空字段难清。

## 3. 呈现：并入现有建议流，不造第二套

- 新增桶 `bucket="action"`（与 followup/mail/intel/static 并列），走同一套
  「过滤 dismissed → ctx 置顶 → 分数降序 → 同桶 ≤2 → 最多 4 条」；
- 分数：新客回复 100 + 新鲜度加成（客户刚回信 = 黄金窗口，理应优先于行情/运价类提示）；
  已在库待进跟进 80。同邮箱多封不叠加。
- 文案（动词开头、一句话说清点下去会发生什么）：
  - 新客：`把 Isabella Mendes（quotation@threelogintl.com）加入联系人并标为已触达`
  - 已建档：`把 Juan Garcia 放回跟进列表（标为已触达）`
- `FeedItem` 增字段 `action?: { kind: "addContact"|"markReached"; email: string;
  firstName?: string|null; lastName?: string|null; contactId?: number|null }`。
- 气泡右侧「查看」沿用 href：新客 → `#/customers?view=table`；已建档 → 该客户详情。

## 4. 点击即执行（确定性，不经过模型）

现链路点 chip = `dismiss + handleSend(prompt)` 交给 agent —— 对本功能不合适：
弱模型实测会掉链子（今晚同一类"你直接办"的指令它反问用户），而且写操作还要再弹一张审批卡，
点两下才办完一件事。所以 action 类走**直连 IPC**：

```
点击 → window.api.invoke("contacts:upsert", payload) → 成功 → invoke dismiss(key) → message.success
```

- 两种动作同一个出口：`contacts:upsert`。已存在按 email 命中 → 只更新传入字段（`contact.service.ts:277`），
  且走 `status=reached` 时由 v4.0 正向联动补分类 `reaching`；
  新建分支（`contact.service.ts:301-317`）直收 `status`，`tags` 留空——看板列由
  `crm.service.ts:115` 兜底成「触达中」，不必在这里造分类。`stage` 保持 `cold`：
  **发信阶段只能由真实发送推进**（既有约定），一键行动不伪造发送历史。
- 新建还会当场 `linkInboxForContact`（先收信后建档的往来历史立刻挂上）+ `nudgeSuggestions()`
  → 气泡在执行后 ~1s 内自行消失，前端不用手动刷新。
- **点击本身就是显式授权**（用户规则：写盘类副作用须显式点击才触发），不再叠一层确认弹窗；
  幂等：重复点击结果相同；dismiss 让当天不再骚扰。
- 失败：不 dismiss（下一次还能点），提示错误原文。

## 5. 挂点

- 建议原料在 `suggestion.service.ts collectCandidates()` 里新增一段（纯本地，零模型）；
- **热更新**：客户回复落库后 500ms 内气泡就该出现 → 复用 `suggestion-bus.nudge()`，
  已挂在「新邮件」（`inbox.ipc.ts:856`）与「补匹配」（L842）上，无需新增挂点；
- 渲染端 `AssistantPage.tsx` 空态气泡处（L1302-1332）加 action 分支。

## 6. 验收

- 单测（`tests/unit/mail-action-suggestion.test.ts`）：
  1. replied + my_role=to + 库里无邮箱 → `addContact` 候选，key/载荷/拆名正确；
  2. 同邮箱已建但 status=replied → `markReached` 候选带 contactId；
  3. 同邮箱已建且 status=reached → 不出候选；
  4. 我方内部域名（`@yqn.com`）的 Re: 邮件 → 不出（哪怕 classification=replied）；
  5. `noreply@` 类公共信箱 → 不出；sent/bounce/autoreply/cc-only → 不出；
  6. 同邮箱多封只出一条；`action` 桶受同桶 ≤2 与总 4 条约束；
  7. `FeedItem.action` 字段透传（buildFeed → suggestions()）。
- 手动：收一封新客回复 → 500ms 内首页出现该气泡 → 点一下 → 客户表里出现该联系人且状态已触达、
  跟进看板有他；气泡当天不再出现。

## 7. 留给用户拍板的相邻问题（本规范不擅自改）

`updateContactStatus(id,"replied")` 会把回复过的客户从跟进看板上摘掉。本功能用"置回 reached"绕过它，
但根因还在：**要不要让看板同时显示 `replied` 的客户**（回复过的客户往往最该跟进）。
这是业务口径，需要用户点头后单独改 `listPipeline` 的筛选与列分布。
