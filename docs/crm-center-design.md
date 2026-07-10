# CRM Center — 客户数据中心

## 技术栈

| 层 | 选型 | 理由 |
|---|------|------|
| 框架 | Electron v42 | 和 Prospector 一致 |
| 数据库 | better-sqlite3 | 同步 API、零配置、Electron 标配 |
| HTTP 服务 | Express (内嵌) | 轻量，Prospector 调 REST API |
| 实时推送 | ws (WebSocket) | 联系人变更即时通知 Prospector |
| 构建 | electron-vite + electron-builder | 和 Prospector 完全一致 |
| 图标 | Lucide (手写 SVG) | 和 Prospector 一致 |
| UI 风格 | Win11 黑白极简 | 和 Prospector 一致 |

## 项目目录

```
crm-center/
├── package.json
├── electron.vite.config.mjs
├── electron/
│   ├── main.js                    # Electron 入口
│   ├── logger.js                  # 日志（复用 Prospector）
│   ├── modules/
│   │   ├── config.js              # APP_ROOT 等路径
│   │   ├── core/
│   │   │   ├── logger.js          # 分级日志
│   │   │   ├── schema.js          # 建表 SQL + 迁移
│   │   │   └── contract.js        # IPC + API 通道常量
│   │   ├── services/
│   │   │   ├── db.js              # better-sqlite3 单例
│   │   │   ├── companies.js       # 公司 CRUD
│   │   │   ├── contacts.js        # 联系人 CRUD (核心)
│   │   │   ├── interactions.js    # 互动记录
│   │   │   ├── opportunities.js   # 销售机会
│   │   │   └── api-server.js      # Express + WebSocket 服务
│   │   └── ipc/
│   │       └── crm-ipc.js         # 本地 IPC 路由
│   └── preload.js                 # 安全桥接
├── electron/renderer/
│   ├── index.html                 # SPA 壳
│   ├── styles.css
│   ├── icons.js                   # Lucide 图标（复用）
│   ├── app.js                     # 渲染进程入口
│   └── modules/
│       ├── shared.js              # 工具函数
│       ├── dashboard.js           # 仪表盘
│       ├── contacts.js            # 联系人列表
│       ├── contact-detail.js      # 联系人详情/编辑
│       ├── companies.js           # 公司管理
│       ├── opportunities.js       # 机会看板
│       ├── interactions.js        # 互动时间线
│       └── settings.js            # 设置
└── data/
    └── crm.db                     # SQLite 数据库文件
```

## 数据库表结构 (schema.js)

```sql
-- ═══ 元数据表 ═══
CREATE TABLE IF NOT EXISTS _schema (
    version INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ═══ 公司表 ═══
CREATE TABLE IF NOT EXISTS companies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,       -- 规范化名称
    raw_name    TEXT,                       -- 原始名
    country     TEXT,
    industry    TEXT,
    website     TEXT,
    phone       TEXT,
    address     TEXT,
    size        TEXT,                       -- 小型/中型/大型
    main_routes TEXT,                       -- 主营航线 (JSON数组)
    cargo_types TEXT,                       -- 主要货类 (JSON数组)
    ports       TEXT,                       -- 常用港口 (JSON数组)
    source      TEXT,                       -- 来源渠道
    score       INTEGER,                    -- 背调评分 1-5
    backcheck_at TEXT,
    notes       TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
);

-- ═══ 联系人表（核心）═══
CREATE TABLE IF NOT EXISTS contacts (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- 基础信息
    email         TEXT NOT NULL UNIQUE,
    first_name    TEXT,
    last_name     TEXT,
    title         TEXT,                     -- 职位
    phone         TEXT,
    linkedin      TEXT,

    -- 分类
    client_type   TEXT DEFAULT 'unlabeled', -- agent / direct / unlabeled
    category      TEXT,                     -- forwarder / importer / exporter / trader

    -- 开发状态（程序自动维护）
    stage         TEXT DEFAULT 'cold',
    last_sent_at  TEXT,
    last_sent_acct TEXT,

    -- 退信状态（程序自动维护）
    is_bounced    INTEGER DEFAULT 0,
    bounce_type   TEXT,
    bounce_reason TEXT,
    bounced_at    TEXT,

    -- 标签（程序+手动）
    tags          TEXT DEFAULT '[]',        -- JSON数组

    -- 机会
    opp_stage     TEXT DEFAULT '待开发',    -- 机会阶段

    -- 备注
    followup_note TEXT,

    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

-- ═══ 互动记录表 ═══
CREATE TABLE IF NOT EXISTS interactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id    TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,            -- sent / received / bounced / noted / whatsapp
    direction     TEXT,                     -- outbound / inbound
    subject       TEXT,
    snippet       TEXT,
    email_uid     TEXT,
    email_account TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
);

-- ═══ 机会表 ═══
CREATE TABLE IF NOT EXISTS opportunities (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    contact_id    TEXT REFERENCES contacts(id),
    name          TEXT,
    stage         TEXT DEFAULT '触达中',    -- 触达中/报价中/试单/合作中/已流失
    amount        TEXT,
    currency      TEXT DEFAULT 'USD',
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

-- ═══ 索引 ═══
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);
CREATE INDEX IF NOT EXISTS idx_contacts_bounced ON contacts(is_bounced);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(client_type);
CREATE INDEX IF NOT EXISTS idx_contacts_opp ON contacts(opp_stage);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country);
CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_time ON interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_interactions_company ON interactions(company_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);
```

## REST API 设计

基础地址 `http://localhost:9527/api`

### 联系人

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /contacts | 列表，支持 `?stage=cold&client_type=agent&limit=200&offset=0` |
| GET | /contacts/:id | 单个 |
| GET | /contacts/search?q=email | 搜索 |
| POST | /contacts | 新增 |
| PATCH | /contacts/:id | 部分更新（阶段、标签、退信） |
| POST | /contacts/batch | 批量导入（upsert by email） |
| DELETE | /contacts/:id | 删除 |

### 公司

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /companies | 列表 |
| GET | /companies/:id | 单个 + 旗下联系人 |
| POST | /companies | 新增 |
| PATCH | /companies/:id | 更新 |
| DELETE | /companies/:id | 级联删除联系人 |

### 互动记录

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /interactions?contact_id=xxx | 按联系人查时间线 |
| POST | /interactions | 新增（Prospector 自动写） |

### 统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /stats/summary | 总览：各阶段人数、退信率、回复率 |
| GET | /stats/pipeline | 机会漏斗 |

### 同步

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /sync/changes?since=ISO时间 | 增量拉取变更 |
| POST | /sync/push | Prospector 推送本地变更 |

## WebSocket 协议

```
ws://localhost:9527/ws

服务端 → 客户端：
{
  "type": "contact:updated",
  "id": "abc123",
  "changes": { "stage": "f1", "last_sent_at": "..." },
  "ts": "2026-07-10T..."
}

{
  "type": "contact:deleted",
  "id": "abc123"
}

{
  "type": "interaction:new",
  "data": { ... }
}
```

Prospector 收到 `contact:updated` 后立即更新本地缓存，界面热刷新。

## 模块关系图

```
┌──────────────────────────────────────────────────────┐
│  CRM Center                                          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ contacts │  │ companies│  │interact. │           │
│  │  .js     │  │  .js     │  │  .js     │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │             │             │                  │
│       └─────────────┼─────────────┘                  │
│                     ▼                                │
│              ┌──────────┐                            │
│              │  db.js   │  better-sqlite3            │
│              └────┬─────┘                            │
│                   │                                  │
│  ┌────────────────┼──────────────────┐               │
│  │                ▼                  │               │
│  │  ┌──────────┐     ┌──────────┐   │               │
│  │  │ Express  │     │    ws    │   │               │
│  │  │ REST API │     │WebSocket │   │               │
│  │  └────┬─────┘     └────┬─────┘   │               │
│  └───────┼────────────────┼─────────┘               │
│          │                │                          │
└──────────┼────────────────┼──────────────────────────┘
           │                │
     localhost:9527    localhost:9527/ws
           │                │
┌──────────┼────────────────┼──────────────────────────┐
│          ▼                ▼                          │
│  ┌──────────┐     ┌──────────────┐                   │
│  │ api.js   │     │ ws-client.js │                   │
│  │ HTTP客户端│     │ WebSocket    │                   │
│  └──────────┘     └──────────────┘                   │
│                                                      │
│  Prospector                                          │
└──────────────────────────────────────────────────────┘
```

## 界面布局

和 Prospector 一样：左侧导航 + 右侧内容区

```
┌─── 导航 ───┬─── 内容区 ──────────────────────────────┐
│ 仪表盘     │                                          │
│ 联系人     │  ┌─────────┬─────────┬─────────┐         │
│ 公司       │  │ cold    │ f1      │ f2      │  ...    │
│ 机会       │  │ 23 人   │ 15 人   │ 8 人    │         │
│ 互动记录   │  └─────────┴─────────┴─────────┘         │
│            │  ┌─── 联系人列表 ──────────────────┐     │
│ 设置       │  │ 公司 │ 名 │ 邮箱 │ 阶段 │ 操作  │     │
│            │  │ ...  │... │ ...  │ ...  │ ...   │     │
│            │  └────────────────────────────────┘     │
│            │  ┌─── 详情/编辑面板 ──────────────┐     │
│            │  │ 点击联系人后右侧展开              │     │
│            │  └────────────────────────────────┘     │
└────────────┴──────────────────────────────────────────┘
```

## 和 Prospector 的同步策略

```
Prospector 启动
    │
    ├─ 尝试 GET /api/health → 通？
    │   ├─ 是 → API 模式
    │   │   ├─ GET /sync/changes?since=上次同步时间
    │   │   ├─ 应用变更到本地缓存
    │   │   ├─ 连接 WebSocket
    │   │   └─ 后续操作走 API
    │   │
    │   └─ 否 → 离线模式
    │       ├─ 使用本地 SQLite 缓存
    │       └─ CRM 启动后 PATCH /contacts/:id 推送离线变更
    │
    └─ Prospector 本地缓存: SQLite 文件 (crm-cache.db)
       包含 contacts + companies 的只读副本
       自动从 CRM Center 增量同步
```

## 实施步骤

| 阶段 | 内容 | 预估 |
|------|------|------|
| **1. 骨架** | Electron 项目搭建、config、logger、schema、db.js | 1 天 |
| **2. API** | Express + WebSocket + 全部 REST 端点 | 1 天 |
| **3. 界面** | 联系人列表、公司管理、详情编辑、仪表盘 | 2 天 |
| **4. 对接** | Prospector 加 API 客户端 + WS 客户端 + 离线缓存 | 1 天 |
| **5. 迁移** | Prospector 逐步切到 API，删 send-history.json | 1 天 |
