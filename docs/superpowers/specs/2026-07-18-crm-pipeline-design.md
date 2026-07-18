# CRM 客户跟进管理 — 设计方案 v2

> 状态：待用户审查 | 2026-07-18 | Zayne Jin
> v1 → v2：经 CRM 标准研究 + 架构差距分析后修正

---

## 1. 需求摘要

- 看板管道视图，按销售阶段分列展示联系人卡片
- 仅展示已进入 CRM 管道的客户（`opp_stage` 非空且非"待开发"）
- 提醒式跟进：设置下次跟进日期，到期界面提醒（本地定时器 + 轮询兜底）
- 客户偏好（结构化字段 + 自由备注混合，存 `_extra` JSON）
- 实时热读写 SQLite，WAL 模式，编辑即保存（300ms 防抖）
- 独立导航页，代码与其他模块完全分离
- 操作日志（复用现有 Log 系统）

---

## 2. 模块架构

```
electron/
├── modules/
│   ├── core/
│   │   ├── contract.js            ← 追加 IPC.CRM 域常量
│   │   └── schema.js              ← 追加 opp_stage 索引
│   ├── services/
│   │   └── crm-service.js         ← NEW 管道查询、阶段切换、提醒检查、偏好校验
│   ├── ipc/
│   │   └── crm-ipc.js             ← NEW IPC handler 注册（6 个通道）
│
├── main.js                        ← 追加 setupCrmIPC() 注册调用
├── preload.js                     ← 追加 CRM IPC 桥接暴露

renderer/
├── modules/
│   ├── crm-pipeline.js            ← NEW 看板渲染 + 筛选 + 阶段切换
│   ├── crm-detail-panel.js        ← NEW 右侧详情面板（4 Tab）
│   ├── contacts.js                ← 追加"加入 CRM"按钮（最小改动）
│
├── index.html                     ← 追加导航项 + 页面容器 DOM
├── styles.css                     ← 追加 CRM 页面样式
```

### 分层约束

| 层 | 文件 | 可以调用 | 禁止 |
|---|---|---|---|
| core | contract.js, schema.js | — | 任何 IO |
| services | crm-service.js | contacts-db, interactions-db, Log | IPC / Electron API |
| ipc | crm-ipc.js | crm-service, ok()/fail() | 业务逻辑 |
| renderer | crm-*.js | window.electronAPI | 直接调 DB / fs |

### 改动范围

| 操作 | 文件 | 改动量 |
|---|---|---|
| 追加 | `core/contract.js` | +1 个 IPC.CRM 域（7 条常量） |
| 追加 | `core/schema.js` | +1 条 `CREATE INDEX idx_contacts_opp_stage` |
| 新建 | `services/crm-service.js` | ~150 行 |
| 新建 | `ipc/crm-ipc.js` | ~60 行（纯路由） |
| 追加 | `main.js` | +1 行 `require("./modules/ipc/crm-ipc").setup(deps)` |
| 追加 | `preload.js` | +6 条 IPC 桥接 |
| 新建 | `renderer/modules/crm-pipeline.js` | ~200 行 |
| 新建 | `renderer/modules/crm-detail-panel.js` | ~200 行 |
| 微调 | `renderer/modules/contacts.js` | +1 个"加入 CRM"按钮 |
| 追加 | `renderer/index.html` | +1 导航项 + 1 页面容器 |
| 追加 | `renderer/styles.css` | +看板 + 面板样式 |

**不动的文件**：`contacts-db.js`、`company-state.js`、`interactions-db.js`、其他渲染模块

---

## 3. 数据模型（v2 修正）

### 3.1 管道阶段 —— 用 `contacts.opp_stage` 列（不用 tags JSON）

**原方案问题**：`contacts.tags` JSON 数组存的是行为标签（replied / bounced_by_contact / autoreply），和管道阶段（触达中 → 报价中 → 试单 → 合作中 → 已流失）是两个维度。混淆会导致查询无法走索引、标签语义混乱。

**修正**：管道阶段使用已有的 `contacts.opp_stage` 列（TEXT，默认值 `'待开发'`），加一条索引：

```sql
CREATE INDEX IF NOT EXISTS idx_contacts_opp_stage ON contacts(opp_stage);
```

| opp_stage 值 | 显示名 | 颜色 | 含义 |
|---|---|---|---|
| `触达中` | 触达中 | #ff9800 | 已联系待回复 |
| `报价中` | 报价中 | #2196f3 | 已发报价 |
| `试单` | 试单 | #8e24aa | 小批量试单 |
| `合作中` | 合作中 | #4caf50 | 稳定合作 |
| `已流失` | 已流失 | #d93025 | 不再回复 |

- `tags` 保持不变，继续存行为标签（replied / bounced_by_contact 等）
- 管道筛选 `WHERE opp_stage IN (...)` 走索引，性能 O(log n)
- 查询比 `json_extract` + `LIKE` 快一个数量级

### 3.2 已有 `opportunities` 表 —— v1 不使用

`schema.js` 第 138-149 行已创建 `opportunities` 表（id, company_id, contact_id, stage, amount, notes）。v1 管道阶段跟联系人走，一个联系人在一个时间点只处于一个阶段，`opportunities` 表留待 v2 多商机场景（同一客户多条航线产品同时报价）。

### 3.3 偏好字段（存 contacts._extra JSON，service 层校验白名单）

```json
// _extra.crmPreferences
{
  "preferredRoutes": "南美西",
  "cargoTypes": ["普货", "危险品"],
  "decisionRole": "决策者",
  "priceSensitivity": "中",
  "preferredPorts": "上海/宁波",
  "annualVolume": "100-500TEU",
  "memo": "客户对价格敏感，偏好 MSC 船司"
}
```

- 6 个结构化字段 + 1 个自由备注
- 以 `crmPreferences` 为根 key 存在 `_extra` JSON 中，与其他模块的 `_extra` 数据隔离
- `crm-service.js` 写入时校验 key 白名单，防止拼写错误（`preferedRoute` vs `preferredRoutes`）
- v2 如有高频查询需求，再迁独立列

### 3.4 跟进提醒（存 contacts._extra，混合检查策略）

```json
// _extra.crmReminder
{
  "nextFollowupAt": "2026-07-25T10:00:00+08:00",
  "followupNote": "确认 MSC 南美西报价"
}
```

**提醒检查**（混合策略）：
1. **本地定时器**：编辑保存后，渲染进程立刻 `setTimeout` 到提醒时间，到期即时高亮，不等待轮询
2. **轮询兜底**：应用重启后，每 5 分钟调 `crm:listPipeline`，从返回数据的 `nextFollowupAt` 重新计算高亮状态
3. **导航红点**：CRM 导航项显示今日待跟进数量（参考现有 `inbox-nav-dot` 实现）

### 3.5 跟进记录 + 互动时间线

- `contact_notes` 表：手动添加的跟进备注
- `interactions` 表：自动记录的邮件往来（已有）、**阶段变更**（新增：`type: 'stage_changed'`, `snippet: '触达中→报价中'`）
- 详情面板合并两张表按时间倒序展示

### 3.6 操作日志

所有写操作通过 `crm-service.js` 统一调用 `Log.info("CRM", ...)`，纳入现有日志体系。不新建日志表。

---

## 4. IPC 契约（v2 修正）

### 4.1 通道常量（追加到 contract.js IPC.CRM）

```js
const CRM = {
  /** 获取管道数据（仅返回 opp_stage 非空且非"待开发"的联系人） */
  LIST_PIPELINE: "crm:listPipeline",
  /** 设置联系人销售阶段（驱动管道列切换，同时写 interactions 审计记录） */
  SET_STAGE: "crm:setStage",
  /** 更新联系人扩展字段（偏好/提醒日期，白名单校验） */
  UPDATE_EXTRA: "crm:updateExtra",
  /** 获取联系人详情（基本信息 + 偏好 + 备注时间线） */
  GET_DETAIL: "crm:getDetail",
  /** 保存跟进备注（写入 contact_notes） */
  SAVE_NOTE: "crm:saveNote",
  /** 检查到期提醒（供轮询和桌面通知共用） */
  CHECK_REMINDERS: "crm:checkReminders",
  /** 联系人变更事件（主进程写后 push → 渲染进程刷新） */
  CHANGED: "crm:changed",
};
```

### 4.2 请求/响应格式

全部遵循 `{ ok, data?, error? }` 格式。

```
→ crm:listPipeline ({ search, country })
  SQL: SELECT ... WHERE opp_stage IN ('触达中','报价中','试单','合作中','已流失') [AND ...]
← { ok: true, data: { columns: [{ stage, label, color, contacts: [...] }] } }

→ crm:setStage (contactId, newStage)
  同时写 interactions: { type: 'stage_changed', snippet: '旧→新', contact_id }
  主进程 push crm:changed 事件
← { ok: true, data: { id, opp_stage } }

→ crm:updateExtra (contactId, { crmPreferences: {...}, crmReminder: {...} })
  service 层校验 key 白名单后 merge 进 _extra
← { ok: true, data: { id, _extra } }

→ crm:getDetail (contactId)
← { ok: true, data: { contact, notes: [...], interactions: [...] } }

→ crm:saveNote (contactId, content)
← { ok: true, data: { id, content, created_at } }

→ crm:checkReminders ()
← { ok: true, data: { due: [...], overdue: [...] } }
```

---

## 5. 渲染层设计

### 5.1 页面布局

```
┌──────────────────────────────────────────────────────────┐
│  [导航栏] 客户列表 | 🔔 客户跟进 (3) | 邮件发送 | ...    │
├──────────────────────────────────────────────────────────┤
│  [筛选栏] 🔍 搜索公司/姓名 | 🌍 国家 | 📋 标签过滤       │
├──────────────────────────────────────────────────────────┤
│  触达中(3)  │ 报价中(2)  │ 试单(1)  │ 合作中(5) │ 已流失│
│ ┌─────────┐ │ ┌────────┐ │ ┌──────┐ │ ┌────────┐ │       │
│ │ 张三     │ │ │ 李四   │ │ │ 王五 │ │ │ ...     │ │       │
│ │ ABC Co   │ │ │ DEF Co │ │ │GHI Co│ │ │        │ │       │
│ │ 🇧🇷 巴西 │ │ │ 🇲🇽 墨西│ │ │🇨🇱 智利│ │ │        │ │       │
│ │ ⏰ 07/25 │ │ │        │ │ │      │ │ │        │ │       │
│ │ 🔵 触达中│ │ │ 🟣 试单│ │ │ 🟠 报价│ │ │        │ │       │
│ └─────────┘ │ └────────┘ │ └──────┘ │ └────────┘ │       │
├──────────────────────────────────────────────────────────┤
│              [详情面板 — 点击卡片后右侧展开]              │
│  Tab: 基本信息 | 偏好设置 | 跟进提醒 | 时间线             │
└──────────────────────────────────────────────────────────┘
```

### 5.2 看板列（crm-pipeline.js）

- 水平滚动容器，5 列固定宽度（每列 ~220px）
- 列头：阶段名 + 数量 badge + 阶段颜色圆点
- 卡片字段（遵循 CRM 最佳实践——≤5 个关键字段）：
  1. 联系人姓名（加粗）
  2. 公司名
  3. 国家（emoji 国旗 + 文字）
  4. 下次跟进日期（⏰ 图标 + 日期）
  5. 当前阶段（颜色圆点 + 阶段名）
- 卡片颜色状态：
  - 正常：白色背景
  - 24h 内到期：橙色左边框（`border-left: 3px solid #ff9800`）
  - 已逾期：红色左边框 + 浅红背景（`border-left: 3px solid #d93025; background: #fff5f5`）
- 阶段切换：点击卡片上的阶段标签 → 弹出阶段选择下拉 → 选择新阶段 → `crm:setStage`（300ms 防抖）
- v2 做拖拽

### 5.3 详情面板（crm-detail-panel.js）

侧边覆盖面板（保持管道上下文），不跳整页。

**Tab 1：基本信息** — 联系人可编辑字段（名、姓、邮箱、职位、电话、LinkedIn），blur 即保存

**Tab 2：偏好设置** — 6 个结构化下拉 + 1 个自由备注，change 即保存（300ms 防抖）

**Tab 3：跟进提醒** — 日期选择器 + 提醒备注，change 即保存 + 本地 setTimeout

**Tab 4：时间线** — contact_notes + interactions 合并倒序，支持手动添加备注

### 5.4 筛选栏

- 搜索框：公司名 / 联系人姓名（SQL LIKE 过滤）
- 国家下拉（复用 companies.country）
- 业务标签过滤（行为标签，非管道阶段）
- 全部筛选在 SQL 层完成，不拉全量到前端

---

## 6. 关键交互流程

### 6.1 联系人 → CRM（入口）

现有联系人列表，对 `opp_stage === '待开发'` 的联系人显示"加入 CRM"按钮。
点击 → `contacts-db.update(id, { opp_stage: '触达中' })` → 该联系人出现在 CRM 看板"触达中"列。

### 6.2 阶段切换 + 审计

```
用户点击阶段标签 → 下拉选新阶段
  → crm:setStage(contactId, '报价中')
  → crm-ipc 校验 opp_stage 值域
  → crm-service.setStage()
    → contacts-db.update(id, { opp_stage: '报价中' })
    → interactions-db.add({ type: 'stage_changed', snippet: '触达中→报价中' })
    → Log.info("CRM", "阶段变更", { contactId, from, to })
  → 主进程 push crm:changed
  → 渲染层收到后重新排列卡片到对应列（带动画）
```

### 6.3 提醒高亮

```
用户设 nextFollowupAt = "2026-07-25T10:00"
  → crm:updateExtra 写 DB
  → 渲染层 clearTimeout 旧定时器，setTimeout 新定时器
  → 到期时本地更新卡片样式（橙色/红色），不依赖轮询
  → 应用重启后，轮询取 nextFollowupAt 重新计算
```

---

## 7. 实时性策略（v2 修正）

| 场景 | 策略 |
|---|---|
| 页面初始加载 | `crm:listPipeline` 全量拉管道数据 |
| 阶段切换 | → `crm:setStage` 写 DB → 主进程 `crm:changed` push → 渲染层局部重排 |
| 偏好编辑 | 300ms 防抖 → `crm:updateExtra` 写 DB |
| 提醒到点 | 本地 `setTimeout` 即时高亮 + 5 分钟轮询兜底 |
| 多窗口同步 | 主进程 `crm:changed` 广播所有窗口 |
| SQLite 并发 | WAL 模式已开启，读写不互锁 |

---

## 8. v1 不做（明确边界）

- 拖拽换列（点击阶段标签切换即可）
- 自动跟进邮件序列（独立功能）
- 桌面通知提醒（已预留 `crm:checkReminders` 接口）
- 管道健康度图表（漏斗图 / 转化率 / 平均停留时长）
- 多用户权限
- 批量操作（批量改阶段、批量加备注）

---

## 9. 设计参考基准

### 行业最佳实践（来自 HubSpot / Pipedrive / Salesforce 分析）

1. **卡片信息极简** — ≤5 个字段，扫一眼能判断阶段
2. **活动紧迫度可视化** — 红/黄/绿颜色编码是行业标准
3. **详情用侧边栏而非整页跳转** — 保持管道上下文
4. **阶段变更带审计记录** — 每次变更写 interactions 表
5. **货代特需** — 卡片必须显示"最近互动日期"和"国家/时区"

### Subagent 验证结论

- 🔴 6 项必须修正（已在 v2 全部修正）
- 🟡 7 项建议优化（已在 v2 全部采纳）
- 🟢 3 项可选优化（标注 v2 做或预留接口）
- ✅ 总体评价：三层分离架构正确，v1 范围合理，可扩展性良好
