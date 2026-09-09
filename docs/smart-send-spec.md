# 智能发信系统规范（发信任务 Campaign + 自动跟进闭环）

> 一句话：把"圈人 → 首信 → 跟进 → 止损 → 复盘"做成一个**被批准后自动执行的任务生命周期**，人只做两个动作——批准计划、看结果。发送引擎（账号轮换/时窗/配额/熔断/串行队列）原样复用，本规范只加"任务层"。

## 0.5 已拍板决策（2026-09-07，用户定）

1. **入口不是自由对话**：新对话首页的**建议气泡卡**是触发器——用户点某张建议卡，agent 才据此编排任务（复用既有「点击发 GROUP_PROMPT 前缀+检索目标」机制）。没有气泡就没有任务，agent 不主动揽活。
2. **已回复 / 已触达（reached）的客户不得进入分批队列**：~~圈人时排除 + 扫描入队时引擎侧硬闸，双重生效~~（**已被 §0.6-1 取代：资格闸解除，照常入队+计数提示**）。这些客户的后续由用户引导决策——**AI 不做计划外发送**。
3. **无人值守保留，但内容只来自用户模板或程序预设**（机械变量替换，零不确定性）。任何 AI 生成内容必须整批预览确认，且该轮强制 autoSend=关（入队待人点开始）。

## 0.6 已拍板决策（2026-09-09，发信逻辑改版，用户定）

1. **资格闸解除**：已回复/已触达（reached）客户**照常入队**——选人、创建预览、扫描入队三处都不再拦截；界面只在人数计数处括号提示「含 N 位已触达/已回复」（选中提醒，发不发由用户圈名单决定，不替用户做主）。止损不变：回复/退信/退订信号照旧触发 target 终态（§3.3 原样生效）。
2. **固定内容轮任务完结即清空**：campaign 转 done 时清掉 touch_plan 里 fixed 轮的内容快照；done 任务可再启动新周期（restart），但 fixed 轮快照缺失时**拒绝启动并自动转回草稿**，必须补好新内容——杜绝「下一周期还发同样的内容」。
3. **发信账号智能轮换 = 联系人亲和优先（不换人发）**：谁发过的客户还由谁发（interactions 里该联系人最近一封 type='sent' 的账号）。历史账号熔断中 → 整组缓发顺延次日，**绝不静默换号**；已停用账号视同无历史交由轮换；只有从未发过的新联系人才进轮换池。同公司联系人历史账号不同 → 亲和分桶拆组（一组 BCC 只能一个发件人）。指定账号池（fixed 策略）内不缓发：池外亲和账号视同无历史。

---

## 0. 现状与缺口（代码证据）

已有（send.service.ts / send_queue）：全局串行引擎、账号健康轮换、时窗（未到发送时段）、全局日配额、熔断、两步式队列（入队→发送中心手动开始）、阶段推进（真实发送成功后 cold→f1→…→f4 封顶）、阶段模板映射（cold→initial、f1→followup1…）、SMTP 连接池、bounce/autoreply 识别（inbox 分类）。

缺口：
1. **没有任务（campaign）概念**：batchId 只标识一次入队，发完即止；followup2/followup3 模板存在但**无人自动调用**——跟进要人工去客户跟进界面逐个发。
2. **回复不联动**：客户回了信（inbox 已能分类 reply 并关联联系人），但发送侧无感知——已回复的人还可能收到下一封跟进（打扰+丢面子）。
3. **无效果回路**：一个批次发出去，回复了多少、哪些该止损，没有聚合视图，agent 也答不了"这个任务怎么样了"。

## 1. 设计原则

1. **引擎不动**：任务层只是队列的"策源"，入队走既有 startQueue（账号轮换/时窗/配额/熔断/串行全部继承）；AI 永不绕过它直接触达 SMTP。
2. **授权一次，计划内自动**：用户批准的是**整个计划**（名单+序列+节奏+内容来源），批准之后计划内的机械执行不再逐封打断人——这是"智能"与既有红线（AI 永不触发群发）的调和：红线改为「**AI 不做计划外发送**」，计划=用户显式批准的边界。
3. **确定性优先**：自动跟进的内容用批准过的模板+变量（机械替换，零不确定性）；AI 逐人生成只出现在有人工预览的环节。要"更智能"的跟进内容，走批量预览确认，不做无人值守的生成后直发。
4. **止损优先于触达**：回复/退订/bounce 是最高优先级信号，任何在途/待发 touch 立即让路。
5. **所见即所发**：创建预览的名单计数=实际执行对象（沿既有红线）。

## 2. 数据模型

```ts
// src/main/db/schema/send-campaign.ts
export const sendCampaigns = sqliteTable("send_campaigns", {
  id: text("id").primaryKey(),                       // nanoid
  name: text("name").notNull(),                      // 「巴西冷客户·4 触点」
  status: text("status").notNull().default("running"),
  // running | paused | done | stopped（stopped=人工或止损条件终止）
  autoSend: integer("auto_send").notNull().default(1),      // 计划内 touch 自动开始发送
  targetFilterJson: text("target_filter_json").notNull(),   // 创建时的筛选条件（回显/审计用）
  touchPlanJson: text("touch_plan_json").notNull(),
  // [{ round:1, templateId:"tpl_initial"|"ai", delayDays:0 },
  //  { round:2, templateId:"tpl_f1", delayDays:5 }, …]  —— delayDays=上一封发出后隔几天
  createdAt/updatedAt: …,
});

export const sendCampaignTargets = sqliteTable("send_campaign_targets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  campaignId: text("campaign_id").notNull(),
  contactId: integer("contact_id").notNull(),
  status: text("status").notNull().default("pending"),
  // pending | queued | sent | replied | bounced | unsubscribed | skipped(止损/排除)
  round: integer("round").notNull().default(0),       // 已完成的触点轮次
  nextTouchAt: text("next_touch_at"),                 // 下一触点到期时间（ISO）；空=无待发
  lastSentAt: text("last_sent_at"),
  updatedAt: …,
});
// 索引：(campaign_id, status)、(status, next_touch_at) —— 扫描器按后者捞到期任务
```

名单在**创建时定格**（所见即所发），事后新入库的人不自动混入（要扩量重新建任务或出「追加名单」动作）。

## 3. 触点引擎（复用队列的策源）

### 3.1 推进
SMTP 确认发送成功（现有钩子，stage 推进处）→ 若该封属于某 campaign target：`round++`、`lastSentAt=now`、`nextTouchAt = now + plan[round+1].delayDays`。计划走完（round=计划轮数）→ target.status=sent（终态）；全部 target 终态 → campaign.status=done，**同时清空 fixed 轮内容快照**（§0.6-2）。done 任务可再启动新周期（restart）：sent/replied/skipped 触点重置为 pending 立即到期，退信/退订保持终态；fixed 轮快照已清空 → 拒绝启动并转回草稿。

### 3.2 调度扫描
主进程常驻低频扫描（对齐 inbox.auto 的既有模式，每 10 分钟）：
```
捞 status=pending 且 nextTouchAt<=now 的 target（按 campaign 分组）
→ 每组组装 SendItem（stage 对应模板 + 联系人变量，机械替换）
→ startQueue(items, autoStart=campaign.autoSend)
```
- `autoSend=1`：入队后自动开始（计划已批准）；`autoSend=0`：照旧落在队列页等人点开始。
- 全局日配额/时窗不满足 → 引擎已有的窗口等待与裁剪逻辑原样生效（delayReason=window/group 照旧显示），扫描器不重复入队（target.status=queued 后等引擎回调）。
- 引擎忙（state.isRunning）→ 本轮扫描跳过，下轮再试。

### 3.3 止损（最高优先级，挂 inbox 分类钩子）
inbox 邮件分类完成处（reply/bounce/unsubscribe 已能识别且有关联联系人）：
- **reply** → 该联系人名下所有 campaign target：status=replied，nextTouchAt 清空；已在队列里未发的组照常被引擎发出（不追回），但扫描器不再为其排新 touch。
- **unsubscribe（退订语义词，首版从 reply 里词表识别）** → 同上，status=unsubscribed，并写入联系人偏好，永不再入任何 campaign。
- **bounce** → status=bounced，停该联系人后续 touch（地址已死，再发伤账号）。
- **autoreply（OOO）** → 不止损，nextTouchAt 顺延 3 天（现有"暂缓"语义落进调度）。

### 3.4 防重复/冷却
- 同一联系人同时只允许一个 `queued/待发` touch（扫描器入队前检查）。
- 全局冷却：任一 campaign 之外，`send_queue` 里该联系人已有未发条目 → 跳过本轮并顺延。

## 4. 内容策略（确定性优先）

- **首信（round 1）**：二选一——
  a) 模板：选定模板+变量，零 AI、零预览成本；
  b) AI 逐人定制：用闭环工作台已具备的能力（背调/邮件要素/运价场景）逐人生成，**整批预览**（首 3 封全文+其余变量摘要）确认后入库——预览的是"生成规则"，入库后机械执行。
- **跟进（round 2+）**：默认用批准的 stage 模板+变量（followup1/2/closing 已有映射）。可选「AI 个性化跟进」：每轮生成后**整批入预览**，人点一次确认一批——不做生成后直发。
- 跟进语气/内容约束进模板本身；AI 生成的禁编数字口径沿用 buildRateContext 那套（无真价不编造）。

## 5. Agent 编排工具（对接闭环工作台）

| 工具 | sideEffect | 说明 |
|---|---|---|
| campaign_create | write（确认卡） | 入参=筛选条件（复用 §4.1 search_contacts 同款）+ touch 计划（轮数/间隔/内容来源）+ autoSend + 首信策略。execute 先算**预览**（命中数、含已触达/已回复计数、前 N 名单、每轮内容来源、预计完成时间），确认后建档。名单定格落库。 |
| campaign_status | read | 无参=全部任务概览（运行/暂停/各状态计数）；带 id=单任务明细（各轮已发数、回复数、样本名单）。回答"任务怎么样了"。 |
| campaign_control | write（确认卡） | pause=扫描器不再排新 touch（在途批次照常）；resume=恢复；stop=终态，清空全部 nextTouchAt；restart=done 任务再启动新周期（§0.6-2）。 |

manifest 登记与审批闸门自动继承（write→确认卡）；预算：create/stop 各 2/轮，status 4/轮。

## 6. UI（最小够用）

- **发送中心**加「发信任务」区：任务卡（名称/状态/进度条 已发/名单/回复数）+ 暂停/停止按钮。复用现有页面，不新开页。
- 对话里 campaign_create 确认卡沿用动作卡形态（diff 列名单摘要与计划）。
- 不做独立仪表盘页；统计先以 status 工具 + 任务卡数字呈现。

## 7. 分期

- **A（后端闭环）**：schema+迁移+测试沙箱 → 触点推进/调度扫描/止损钩子 → 冷却防重。单测：推进算 nextTouchAt、回复止损清 pending、autoreply 顺延、冷却不重复入队、done/stopped 终态。
- **B（agent 工具）**：campaign_create/status/pause/resume/stop + 预览确认卡。单测：预览=执行对象、确认后名单定格、暂停不排新队。
- **C（UI）**：发送中心任务区。手工验收。
- **D（效果深化，另议）**：打开率（需追踪像素，涉合规，默认不做）、回复率分轮统计图。

## 8. 红线与边界

- 发送引擎、熔断、串行语义**零改动**；账号分配升级为「联系人亲和优先（不换人发）+ 新客户轮换」（§0.6-3），任务层只往 startQueue 喂料 + 订阅结果回调。
- **AI 不做计划外发送**：所有自动行为都在创建时批准的计划内；计划外诉求一律出确认卡。
- 退订是绝对止损，任何任务不可覆盖。
- 不做打开率追踪（合规风险，默认排除）。
- 与运价线无交集；与既有手动队列完全共存（同一发送中心）。

## 9. 待拍板（默认值已按傻瓜式给足，不改就按默认实现）

1. **autoSend 默认值**：建议默认 **开**（创建计划=授权自动跟进；想每轮手点的人创建时关掉）。保守选"关"也行，但每轮都要人点，「智能」名不副实。
2. **首信默认策略**：建议默认 **AI 逐人定制+整批预览**（首轮最值钱）；纯模板作为省档选项。
3. **默认节奏**：4 触点、间隔 5 天（可每任务改）。
