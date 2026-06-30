# Prospecting Email v2 — CRM 管线 + 序列引擎 PRD

> 版本: 1.0 / 日期: 2026-06-30 / 状态: 设计中

## 一、目标

将当前「一张联系人表 + 手动群发」升级为：

**线索 → 背调 → 公司建档 → 联系人 → 序列自动化 → 商机转化**

四个数据层级解耦，序列引擎做自动化跟进，发送调度层做容量管控。

---

## 二、数据模型 — 四层架构

### 2.1 总览

```
Lead (线索)
  │  验证通过
  ▼
Account (公司) ─── Contact (联系人)
                       │  有意向
                       ▼
                   Opportunity (商机)
```

- **Lead**：低门槛入口，验证前的疑似目标
- **Account**：确认过的公司档案，1 对多 Contact
- **Contact**：公司内的决策人，承担发信/退信/退订状态
- **Opportunity**：联系人产生的商机，追踪转化阶段

### 2.2 Lead（线索）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `company_name` | string | 公司名（可能不准） |
| `website` | string | 官网 |
| `country` | string | 国家 |
| `source` | enum | `google` / `linkedin` / `feishu` / `discover` / `manual` |
| `email` | string? | 猜测的邮箱，可选 |
| `status` | enum | `new` → `researching` → `qualified` → `converted` → `dead` |
| `quality_score` | int | 自动评分 0-5 |
| `notes` | string | 备注 |
| `created_at` | datetime | |
| `updated_at` | datetime | |

**转换规则：** Lead 标记 `converted` 时，系统创建 Account + Contact 记录，Lead 保留引用。

### 2.3 Account（公司）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `name` | string | 规范公司名 |
| `website` | string | 官网 |
| `country` | string | 国家 |
| `industry` | enum | `manufacturing` / `retail` / `tech` / `logistics` / `food` / `construction` / `other` |
| `size` | enum | `small` / `medium` / `large` |
| `backcheck_report` | object? | 背调报告 JSON |
| `backcheck_rating` | int | 匹配度 1-5 |
| `status` | enum | `active` / `inactive` / `competitor` / `partner` |
| `notes` | string | |
| `created_at` | datetime | |
| `updated_at` | datetime | |

**关键约束：** 一家公司一条记录，同 `website` 去重。

### 2.4 Contact（联系人）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `account_id` | string | 归属 Account |
| `name` | string | 姓名 |
| `title` | string | 职位 |
| `email` | string | 邮箱 |
| `phone` | string? | |
| `role` | enum | `procurement` / `owner` / `manager` / `engineer` / `unknown` |
| `linkedin_url` | string? | |
| `status` | enum | `active` / `bounced` / `unsubscribed` / `left_company` |
| `tags` | string[] | 自定义标签 |
| `lead_id` | string? | 来源 Lead 引用 |
| `created_at` | datetime | |
| `updated_at` | datetime | |

**关键约束：** 退信/退订挂在 Contact 级，不影响同 Account 其他人。

### 2.5 Opportunity（商机）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `contact_id` | string | 关联 Contact |
| `account_id` | string | 关联 Account（冗余） |
| `stage` | enum | `prospecting` → `contacted` → `replied` → `negotiating` → `won` → `lost` |
| `value` | number? | 预估金额（可选） |
| `probability` | int | 成交概率 %（随阶段自动更新） |
| `last_activity_at` | datetime | |
| `next_action` | enum | `send_followup` / `call` / `wait` / `none` |
| `next_action_date` | date? | |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### 2.6 数据关系图

```
Lead ──1:1──→ Account (converted 时创建)
Account ──1:N──→ Contact
Lead ──1:1──→ Contact (converted 时创建)
Contact ──1:N──→ Opportunity
```

### 2.7 现有数据迁移

现有 `Contact` 表 = Lead + Contact 的混合体。迁移策略：

1. 所有现有记录 → Lead（`status: 'converted'`，因为已经验证过）
2. 按 `company` 字段 group → 创建 Account
3. 每条记录拆分出 Contact，关联 Account
4. 现有 `stage` 字段映射到 Contact 的初始状态 + Opportunity 的 stage

---

## 三、序列引擎 (Sequence Engine)

### 3.1 概念定义

**序列 (Sequence)**：一套预设的多步触达规则，绑定到 Contact 后自动按节奏推进。

### 3.2 数据模型

#### SequenceTemplate（序列模板 — 可复用）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `name` | string | 如「拉美制造业 5 步」 |
| `description` | string | |
| `country` | string? | 适配国家（`mx`/`br`/`cl`/`pe`/`co`），null 为通用 |
| `language` | enum? | `es`/`pt`/null |
| `steps` | SeqStep[] | 步骤列表 |
| `is_active` | bool | |
| `created_at` | datetime | |

#### SeqStep（步骤定义）

| 字段 | 类型 | 说明 |
|------|------|------|
| `order` | int | 步骤序号 1-N |
| `delay_days` | int | 上一步完成后等几天 |
| `template_id` | string | 引用模板引擎中的邮件模板 |
| `send_time` | string | 发送时间窗 HH:MM |
| `condition` | enum | `always` / `no_reply` / `manual_approve` |
| `exit_on_reply` | bool | 收到回复后是否退出序列（默认 true） |

#### SequenceEnrollment（序列实例 — Contact 的具体执行状态）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `contact_id` | string | 绑定的 Contact |
| `template_id` | string | 使用的 SequenceTemplate |
| `current_step` | int | 当前执行到第几步 |
| `status` | enum | `active` / `paused` / `completed` / `exited` |
| `exit_reason` | enum? | `reply` / `bounce` / `unsubscribed` / `manual` |
| `step_progress` | json | 每步的发送状态 `[{step, sent_at, status}]` |
| `next_send_at` | datetime | 下一步计划发送时间 |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### 3.3 执行流程

```
1. 用户将 Contact 加入序列模板
   → 创建 SequenceEnrollment
   → current_step = 1
   → 计算 next_send_at = now + step1.delay_days

2. 调度层每 N 分钟轮询
   → 找到所有 next_send_at <= now 的 Enrollment
   → 按优先级排序后提交发送

3. 发送完成
   → step_progress 写入 sent_at + status
   → 如果 exit_on_reply: 标记等待回复监听
   → current_step += 1
   → 计算下一个 next_send_at

4. 收到回复（来自退信/回复检测）
   → exit_on_reply=true: status = 'exited', exit_reason = 'reply'
   → Contact 标记为「待回复」，移出序列

5. 退信/退订
   → status = 'exited', exit_reason = 'bounce'
   → 不继续后续步骤
```

### 3.4 手动干预能力

| 操作 | 效果 |
|------|------|
| **暂停序列** | 暂停 Contact 的序列计时，next_send_at 冻结 |
| **恢复序列** | 继续从 current_step 执行 |
| **跳过当前步** | 直接进入下一步 |
| **提前发送** | 忽略 delay_days，立即排入今日队列 |
| **退出序列** | 手动终止，exit_reason = `manual` |
| **换序列** | 退出当前，加入新序列模板 |
| **单步预览** | 每个 Step 发之前可预览正文 |

---

## 四、发送调度层 (Send Scheduler)

### 4.1 核心职责

**不与序列引擎耦合。** 调度层只管：今天能发多少、谁先发、什么时候发。

### 4.2 容量预算

```js
MailboxCapacity {
  mailbox_id: "primary",
  daily_limit: 50,        // 今日总上限
  sent_today: 0,          // 今日已发
  remaining: 50,          // 剩余
  warmup_enabled: false,  // 预热模式（递增加速）
  warmup_day: null,       // 预热第几天
}
```

- 每日 00:00 重置 `sent_today` 为 0
- 发信前检查 `sent_today < daily_limit`，否则拒绝并入等待队列
- 预热模式：`daily_limit` = `min(5 + warmup_day * 2, max_limit)`，每日自动调整

### 4.3 优先级队列

| 优先级 | 触发条件 | 说明 |
|--------|----------|------|
| **P0** | 用户手动点击「立即发送」 | 不受容量限制，穿墙 |
| **P1** | 序列中间步骤 (current_step > 1) | 已经在跟进中的，保持节奏 |
| **P2** | 序列首步 (current_step = 1) | 新进入序列的联系人 |
| **P3** | 非序列批量发送 | 节日问候、通发 |

同一优先级内按 `next_send_at` 升序（等得最久的先发）。

当日容量不足时，未发出的任务 `next_send_at` 顺延至次日，优先级保持不变。

### 4.4 时间窗口分散

```js
SendWindows {
  mailbox_id: "primary",
  timezone: "America/Mexico_City",
  windows: [
    { start: "08:30", end: "09:30", max: 15 },
    { start: "11:00", end: "12:00", max: 10 },
    { start: "14:30", end: "15:30", max: 15 },
    { start: "17:00", end: "18:00", max: 10 },
  ]
}
```

- 窗口内每封邮件间隔 2-5 分钟（随机），避免被识别为群发
- 窗口配置可自定义
- 时区可选：固定时区 / 收件人本地时区

### 4.5 容量日历（UI 需求）

```
┌───────────────────────────────────────────┐
│  发送容量日历                              │
│                                            │
│  6/30 周一  ████████████░░░░  56/50 ⚠ 超载│
│  7/01 周二  ████████░░░░░░░░  39/50        │
│  7/02 周三  ██████░░░░░░░░░░  28/50        │
│  7/03 周四  ████░░░░░░░░░░░░  18/50        │
│  7/04 周五  ██░░░░░░░░░░░░░░   8/50        │
└───────────────────────────────────────────┘
```

- 超载天飘红，可点击展开查看当日排队清单
- 支持拖拽将任务移到其他天
- 支持「暂停当日所有非 P0 发送」

---

## 五、架构集成

### 5.1 模块分层

```
electron/modules/
├── core/                    # 不变
│   ├── contract.js          # IPC 通道（新增 LEAD/ACCOUNT/OPPORTUNITY/SEQUENCE 域）
│   ├── logger.js
│   ├── config.js
│   └── utils.js
│
├── services/                # 业务层
│   ├── lead-store.js        # [新] Lead 持久化
│   ├── account-store.js     # [新] Account 持久化
│   ├── company-store.js     # [改] → account-store 替代
│   ├── contact-store.js     # [新] Contact 持久化
│   ├── opportunity-store.js # [新] Opportunity 持久化
│   ├── sequence-engine.js   # [新] 序列执行引擎
│   ├── send-scheduler.js    # [新] 发送调度层
│   ├── send-engine.js       # [改] 接入调度层
│   └── history-store.js     # [改] 关联 Contact/Opportunity
│
├── ipc/                     # IPC 注册层
│   ├── lead-ipc.js          # [新]
│   ├── account-ipc.js       # [新]
│   ├── contact-ipc.js       # [新]
│   ├── opportunity-ipc.js   # [新]
│   ├── sequence-ipc.js      # [新]
│   ├── scheduler-ipc.js     # [新]
│   ├── backcheck-ipc.js     # [改] 产出写入 Account
│   ├── contacts-ipc.js      # [迁移] 逐步废弃
│   └── ...
│
renderer/modules/
│   ├── leads.js             # [新] 线索池页面
│   ├── accounts.js          # [新] 公司库页面
│   ├── pipeline.js          # [新] 商机管道（看板视图）
│   ├── sequence-builder.js  # [新] 序列模板编辑器
│   ├── calendar.js          # [新] 容量日历
│   ├── contacts.js          # [改] 关联 Account 视图
│   └── ...
```

### 5.2 数据流

```
用户操作: 将 Lead 标记为 qualified
  │
  ▼
lead-ipc: LEAD_CONVERT
  → lead-store 读 Lead
  → account-store 查重/创建 Account
  → contact-store 创建 Contact
  → lead-store 更新 Lead.status = 'converted'
  ← 返回 { account, contact }

用户操作: 将 Contact 加入序列
  │
  ▼
sequence-ipc: SEQUENCE_ENROLL
  → sequence-engine 创建 Enrollment
  → send-scheduler 注册首步任务
  ← 返回 { enrollment, next_send_at }

发送定时器 (每 5 分钟)
  │
  ▼
send-scheduler.poll()
  → 捞出到期任务
  → 按优先级排序
  → 检查容量预算
  → 按时间窗口逐个调用 send-engine.sendOne()
  → 写入 History
  → 通知 sequence-engine 更新步骤
```

### 5.3 不重写现有模块

- `template-engine.js` — 不变，序列引擎通过 template_id 引用
- `send-engine.js` — 小改，新增 `sendOne()` 被调度层调用
- `backcheck-ipc.js` — 小改，产出写入 Account 而非 Contact
- `bounce-checker.js` — 小改，退信通知序列引擎
- `contract.js` — 扩展，新增 4 个 IPC 域

---

## 六、分阶段落地计划

### Phase 1 — 数据分层 (v2.0)
- Lead / Account / Contact 模型 + 持久化
- 现有数据迁移脚本
- 线索池页面 + 公司库页面
- 旧 contacts 页保持，标记 deprecated

### Phase 2 — 序列引擎 (v2.1)
- SequenceTemplate / SequenceEnrollment 模型
- 序列模板编辑器 (UI)
- 序列执行循环 (主进程定时器)
- Contact 卡片上的「加入序列」入口

### Phase 3 — 发送调度 (v2.2)
- MailboxCapacity 模型 + 每日重置
- 优先级队列
- 时间窗口分散
- 容量日历 (UI)

### Phase 4 — 商机管道 (v2.3)
- Opportunity 模型
- 看板视图 (拖拽换阶段)
- 成交概率自动计算
- 基础漏斗分析

---

## 七、开放决策（待定）

| 议题 | 选项 | 建议 |
|------|------|------|
| 存储方案 | SQLite / 现有 JSON | **SQLite**，四层模型关联查询 JSON 太痛苦 |
| 发送模式 | 全自动 / 每步需确认 / 混合 | **混合**，默认自动但可标记「此步需确认」 |
| 回复检测 | IMAP 轮询 / 仅手动标记 | **先手动标记**，IMAP 自动检测放 Phase 2 后期 |
| 多邮箱 | 单邮箱 / 多邮箱轮换 | **先单邮箱**，多邮箱在调度层支持 `mailbox_id` 字段预留 |
