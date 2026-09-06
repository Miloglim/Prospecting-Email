# 每日晨报推送 + 导航红点接线 设计规范（v1）

> 目标：给现有原料装上缺失的"触发器"，形成日频钩子闭环。改实现先改本规范。
> 钩子模型：推送/红点（触发）→ 点开看"今天干什么"（行动）→ 回件数/运价动态/待跟进清单（多变奖励）→ 跟进与发信沉淀数据（投入）。

## 现状盘点（已核实）

| 环节 | 现状 | 结论 |
|------|------|------|
| 待跟进数据 | `crm.service.checkReminders()` → `{due, overdue}` | ✅ 直接复用 |
| 回件数据 | `inbox_messages`：`classification ∈ (replied, bounce)` + `is_read` | ✅ 未读数可查 |
| 运价数据 | `rate-sync.status()` → `total/active/lastSyncAt/lastImported`，**无涨跌 diff** | ⚠️ 文案降级为"今日更新 N 条报价" |
| 导航红点 | `navItems.dot` 已定义，渲染 `opacity: 0` 从未点亮 | ⚠️ 半成品，本次接真数据 |
| `NEW_MAIL` 事件 | `events.ts` 定义，全项目无发射点 | ❌ 死线，v1 不启用（红点走轮询） |
| 托盘常驻 | `createTray` 已有；`Notification` 未用过 | ✅ 推送有宿主 |

## 1. 晨报推送（主进程）

新增 `src/main/services/brief.service.ts`，三段职责分离：

**采集 `collectBriefCounts()`**（全走现有服务，零新查询逻辑）：
- `dueFollowups` = `checkReminders().due.length + overdue.length`
- `newReplies` = 未读 replied + bounce 数（`is_read=0`，`receivedAt ≥ 上次晨报时刻`，冷启动取近 24h）
- `rateUpdates` = `lastSyncAt` 为今日 → `lastImported`，否则 0（0 则整行不显示）
- `queuePending` = `send_queue` 中 `status='pending'` 数（0 则整行不显示）

**格式化 `formatBrief(counts)`**（纯函数，单测覆盖）：
- 标题：`Prospector 晨报 · 9月2日 周二`
- 正文按序拼接非零项，用 ` · ` 分隔：`今日待跟进 6 · 新回件 3 · 运价更新 12 条 · 待发队列 5 组`
- 全零 → 返回 null，**不推送**（坏消息：没东西可看的那天就不打扰，防"狼来了"贬值）

**调度 `startBriefScheduler()`**（`index.ts` whenReady 挂上）：
- 触发时刻 `config.brief.time`（默认 `"09:00"`，Asia/Shanghai，复用 `todayBeijing` 系工具）
- setTimeout 链对齐下一次整点检查（不做 setInterval 空转）
- 防重：`config.brief.lastBriefAt` 持久化"已推日期"，同一自然日只推一次（重启不重推）
- 跳过条件：仅周一至周五（`workdaysOnly` 默认 true）；窗口可见且聚焦时跳过（人已在线，不打扰）
- 点击通知 → `mainWindow.show() + focus()` + 向渲染端发 `EVENTS.BRIEF_OPENED` → 跳仪表盘（v1 落仪表盘，"今日"视图是后续需求）

**配置扩展**（`config.ts`）：
```ts
brief?: { enabled?: boolean; time?: string; lastBriefAt?: string };  // enabled 默认 true
```

**设置页**（通用组，一个 SettingCard）：开关（默认开）+ 时间 Select（08:00–11:00 整点半小时间隔）。不加"立即测试"按钮（非必需控件；Windows 下 toast 无需授权弹窗，开发验证走控制台）。**联动提示**：用户开启晨报但 `autoLaunch=false` 时，卡片内出现一行引导"晨报需要程序常驻后台，建议在通用设置开启开机自启"——钩子依赖进程活着，这是闭环成立的前提。

## 2. 导航红点接线

**新 IPC `dashboard:navDots`** → `{ inbox: number; customers: number }`：
- `inbox` = 未读 replied+bounce 计数（与晨报同源同语义）
- `customers` = `checkReminders` due+overdue 计数
- 渲染端 `useQuery` 30s refetch + `agent:done`/`CONVS_CHANGED` 时 invalidate（复用现有事件）

**Sidebar 改造**：
- `NavItem.dot: boolean` → `dotKey?: "inbox" | "customers"`（消灭死字段）
- 展开态：行尾数字徽章（红底白字，99+ 封顶，0 隐藏）
- rail 折叠态：图标右上角 6px 小红点（不显数字）
- 消失机制 = 数据本身：读完回件 `is_read=1` 灭、处理提醒后灭。**不引入额外已读状态**

## 3. 验收标准

1. `formatBrief` 单测：全零→null、部分零→省略该段、99+ 封顶、标题含星期
2. 种子数据集成测：1 条未读 replied → navDots.inbox=1；标已读 → 0
3. 手动把 `brief.time` 调到 1 分钟后：到点弹系统通知、点击聚焦并跳仪表盘；当日重启不再弹
4. 红点：无数据时导航行尾零残留（对比现在 opacity:0 的死渲染）

## 4. 明确不做（v1 砍掉）

- LLM 生成晨报文案/行动建议（v2 候选，届时走 agent 工具而非旁路）
- 启用 `NEW_MAIL` 事件推送（轮询已够，事件留给实时性需求出现时）
- 周末推送、邮件/企微外发提醒、角标数字（Windows 无 Dock）
- "今日视图"独立页面（晨报先落仪表盘，看点击率再决定要不要专页）

## 5. 改动面与工作量

| 文件 | 动作 |
|------|------|
| `src/main/services/brief.service.ts` | 新增（采集+格式化+调度+Notification） |
| `src/main/index.ts` | 挂调度器启动 |
| `src/main/config.ts` | `brief` 字段 |
| `src/main/contract.ts` + `dashboard.ipc.ts` | `navDots` 通道 |
| `src/main/events.ts` | `BRIEF_OPENED` |
| `src/renderer/components/layout/Sidebar.tsx` | 徽章渲染 + navDots 查询 |
| `src/renderer/pages/settings/SettingsPage.tsx` | 晨报开关卡 + 自启引导行 |
| `tests/unit/brief-format.test.ts` | formatBrief 纯函数用例 |

估算 0.5–1 天。风险点：Windows toast 对未打包 Electron 的 appUserModelId 依赖（已 setAppUserModelId，需实测一次；不弹则回退为托盘气泡 `balloon`）。

---

## 6. v2 候选：运价涨跌数据层（已立项未排期，先立设计后实现）

**现状根因**：`rate_quotes` 是**镜像表**——每次 sync 按 `recordId` 全量刷新覆盖旧值，旧价格无处可查，所以永远算不出涨跌。要涨跌，必须有"历史层"。

**方案：追加 `rate_history` 追加表**（不动物镜像表，读路径零风险）：

```
rate_history: id, record_id, carrier, lane, container, pod_raw,
              ocean_usd, valid_from, valid_to, batch_id
-- batch_id = sync 时间戳；每次 sync 后整批追加；轮转保留 90 天
```

- **写入**：`rate-sync.sync()` 尾部追加——本批全部报价 insert 进 history（带 batch_id）。不做 diff 表，涨跌在读取时用相邻 batch 对比得出（存储换简单；90 天 ≈ 数百行/批 × 每日一两批，量级可忽略）
- **业务键对比规则**（防误报的关键）：
  - 对比键 = `carrier + lane + container + pod 归一化`（`pod_raw` 多港串先归一）
  - `ocean_usd` 为 null（解析失败）不参与对比
  - 同键同价 = 无变化（源群重发同报价很常见）；同键不同价 = 涨/跌；键消失 = 下架；键新增 = 新报价
  - 组合价（"40GP+40HQ"）整条参与，不拆算
- **消费侧**：
  1. 晨报 v2：`运价更新 12 条（↑3 涨 · ↓2 降）`，进一步点名高频航线：`南美东 40HQ +200 USD`
  2. RateBoard：价格旁 ▲红/▼绿 角标（对比上一 batch），hover 显示前值与日期
  3. 远期：航线价格走势折线、"常查航线涨幅 >5%" 定向预警（与晨报/红点触发器合流）

**落地顺序**：先建表+写入（纯追加、无 UI 改动，一次 sync 可验证）→ 接晨报文案 → RateBoard 角标。每步独立可回退。
