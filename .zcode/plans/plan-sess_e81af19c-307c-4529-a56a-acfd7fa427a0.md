## Prospector v3.0 — 产品级重建方案

### 一句话定位
同一个产品，同一个 Electron 窗口，同一套功能，但从第一天就用干净架构 + 产品规范写。

---

### 一、项目结构（严格三层）

```
prospector-v3/
├── package.json
├── electron.vite.config.mjs
├── electron/
│   ├── main.js                         # ~150行：启动流程 + 窗口 + 托盘 + IPC 注册
│   ├── preload.js                      # contextBridge（按功能域分组，标注 @invoke/@event/@send）
│   ├── modules/
│   │   ├── core/                       # 基础层：零业务依赖
│   │   │   ├── config.js               # 路径常量 + 运行时目录
│   │   │   ├── logger.js               # 分级日志
│   │   │   └── schema.js               # 建表 SQL + 迁移
│   │   ├── services/                   # 业务层：不碰 IPC、不碰 DOM
│   │   │   ├── db.js                   # better-sqlite3 单例 + WAL
│   │   │   ├── contacts-service.js     # 联系人 CRUD + 阶段/标签门控
│   │   │   ├── companies-service.js    # 公司 CRUD + 名称规范化
│   │   │   ├── interactions-service.js # 互动记录
│   │   │   ├── accounts-service.js     # 多账号管理 + 熔断
│   │   │   ├── send-service.js         # SMTP 批量发送引擎
│   │   │   ├── inbox-service.js        # IMAP 拉取 + 邮件分类
│   │   │   ├── bounce-service.js       # 退信检测
│   │   │   ├── reply-service.js        # 回复检测
│   │   │   ├── backcheck-service.js    # 背调研究
│   │   │   ├── template-service.js     # 模板库 + 句库
│   │   │   ├── auto-send-service.js    # 自动发送调度
│   │   │   ├── discover-service.js     # 客户发现
│   │   │   ├── stats-service.js        # 仪表盘统计
│   │   │   ├── export-service.js       # 数据导出
│   │   │   └── config-service.js       # 配置读写（唯一入口！）
│   │   └── ipc/                        # IPC 路由层：只做参数校验 + 调用 service
│   │       ├── contacts-ipc.js         # 最多 50 行，全部是 ipcMain.handle → service
│   │       ├── send-ipc.js
│   │       ├── inbox-ipc.js
│   │       ├── ...                     # 每个 service 对应一个 ipc 文件
│   │       └── index.js                # 汇总 registerAll(ipcMain, deps)
│   └── renderer/
│       ├── index.html                  # SPA 壳
│       ├── styles/
│       │   ├── variables.css           # CSS 变量（颜色/间距/阴影/动画）
│       │   ├── base.css                # 全局重置 + 排版
│       │   ├── shell.css               # 窗口壳：标题栏 + 导航 + 内容区
│       │   └── components.css          # 通用组件：按钮/输入框/表格/弹窗/toast
│       ├── app.js                      # 应用入口：初始化 + 导航 + 生命周期
│       ├── modules/
│       │   ├── shared.js               # 工具函数 + lucide 图标
│       │   ├── navigation.js           # 左侧导航注册
│       │   ├── dashboard.js            # 仪表盘页面
│       │   ├── contacts.js             # 联系人列表 + 编辑面板
│       │   ├── send-compose.js         # 发送编辑 + 预览
│       │   ├── send-queue.js           # 发送队列 + 进度
│       │   ├── inbox.js                # 收件箱
│       │   ├── backcheck.js            # 背调管理
│       │   ├── templates.js            # 模板管理
│       │   ├── discover.js             # 客户发现
│       │   ├── auto-send.js            # 自动发送控制
│       │   ├── settings.js             # 设置页
│       │   └── bounces.js              # 退信日志
│       └── assets/
│           └── icons.js                # 所有 lucide SVG 引用
└── data/                               # 运行时自动创建
```

---

### 二、产品级 APP 规范

#### 2.1 应用生命周期
```
启动 → 闪屏(1s) → 加载配置 → 初始化 DB → 注册 IPC → 创建窗口
    → 检查首次运行 → 是→新手向导 / 否→恢复上次状态 → 显示窗口
    → 连接 CRM（将来）→ 就绪
退出 → 保存窗口状态 → 停止所有定时器 → 关闭 DB → app.quit()
```

#### 2.2 窗口管理
- 无边框窗口 + 自定义标题栏（应用名 + 窗口控制）
- 记住上次窗口位置和大小（`window-state.json`）
- 最小化到托盘 / 直接退出（用户可选）
- 双击托盘恢复窗口
- 单实例锁：第二个实例激活已有窗口

#### 2.3 导航系统
```
┌─ 导航栏 ────┬── 内容区 ────────────────────────────┐
│ 📊 仪表盘   │                                        │
│ 👤 联系人   │   每个页面 = 一个 Page 对象:            │
│ ✉️ 发送     │   { id, icon, label,                   │
│ 📥 收件箱   │     onEnter(), onLeave(),              │
│ 🔍 背调     │     onSearch(query) }                  │
│ 📋 模板     │                                        │
│ 🌐 发现     │   切换页面 = 隐藏当前 + 显示目标        │
│ 🤖 自动发送 │   保留滚动位置和表单状态                │
│ ⚙️ 设置     │                                        │
└─────────────┴────────────────────────────────────────┘
```

#### 2.4 设计系统（CSS 变量）
```css
:root {
  /* Win11 极简黑白 */
  --bg-primary: #fafafa;       --bg-secondary: #f3f3f3;
  --bg-tertiary: #ffffff;      --bg-hover: #e8e8e8;
  --text-primary: #1a1a1a;     --text-secondary: #666;
  --border: #e0e0e0;           --border-focus: #0078d4;
  --accent: #0078d4;           --danger: #c42b1c;
  --success: #107c10;          --warning: #ff8c00;
  --radius-sm: 4px;            --radius-md: 8px;     --radius-lg: 12px;
  --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
  --shadow-md: 0 4px 12px rgba(0,0,0,.12);
  --transition: 150ms ease;
  --font-sans: 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'Cascadia Code', 'Fira Code', monospace;
}

[data-theme="dark"] {
  --bg-primary: #1e1e1e;       --bg-secondary: #252525;
  --bg-tertiary: #2d2d2d;      --bg-hover: #333;
  --text-primary: #e0e0e0;     --text-secondary: #999;
  --border: #404040;
}
```

#### 2.5 交互规范
| 场景 | 规范 |
|------|------|
| **列表加载** | 骨架屏 → 数据，不用全屏 spinner |
| **空状态** | 图标 + 标题 + 描述 + 行动按钮（如「导入第一批客户」） |
| **错误状态** | 内联错误卡片，不弹 alert，带重试按钮 |
| **发送进度** | 顶部进度条 + 当前公司名 + 已发/总数 |
| **批量操作** | 选中行高亮 → 工具栏出现 → 批量删除/改标签/改阶段 |
| **危险操作** | 确认弹窗（红色按钮），显示影响范围 |
| **表单校验** | 即时 inline 校验，不等到提交才报错 |
| **Toast** | 右下角 3 秒自动消失，类型 ok/warn/err |
| **键盘** | Ctrl+F 搜索、Ctrl+N 新建、Delete 删除、Escape 关闭面板 |

#### 2.6 数据流
```
渲染进程                    主进程
─────────                  ────────
Page.render(data)
    ↓
window.electronAPI
    ↓ invoke(channel)
    ↓                   ipc/contacts-ipc.js
    ↓                       ↓ 参数校验
    ↓                   services/contacts-service.js
    ↓                       ↓ db.upsert()
    ↓                   core/db.js → SQLite
    ↓                       ↓
    ↓                   webContents.send('contacts:changed')
    ↓                       ↓
Page.onChanged(data)  ←──  所有页面热刷新
```

---

### 三、与现有 Prospector 的复用策略

| 可直接复用 | 需重写 |
|-----------|--------|
| `core/logger.js` | `core/config.js`（简化，去代理逻辑） |
| `core/schema.js`（对齐后） | 所有 services（拆分业务逻辑） |
| `services/*-service.js`（拆分后） | 所有 ipc 文件（只做路由） |
| `renderer/modules/*.js`（改 Page 模式） | `main.js`（精简到 150 行内） |
| Lucide 图标 | `preload.js`（按域分组标注） |
| 模板引擎 | CSS 体系（变量化） |
| 分类引擎 | 导航系统 |

---

### 四、分 4 阶段实施

**阶段 1：骨架（2h）**
- 项目初始化 + electron-vite
- `main.js` 精简版（窗口/托盘/单实例/IPC 注册入口）
- CSS 变量体系 + 窗口壳（标题栏 + 导航 + 内容区）
- 闪屏 + 暗色模式切换

**阶段 2：核心数据层（3h）**
- `core/schema.js` + `services/db.js`
- `services/contacts-service.js` + `services/companies-service.js`
- `ipc/contacts-ipc.js`（纯路由）
- `preload.js` contacts 部分
- 联系人列表页面（表格 + 搜索 + 阶段筛选 + 详情面板）

**阶段 3：业务功能（4h）**
- accounts-service + ipc（多账号 + 熔断）
- send-service + ipc（SMTP 引擎 + 进度事件）
- inbox-service + ipc（IMAP + 分类 + 标签同步）
- backcheck-service + ipc（DeepSeek 背调）
- template-service + ipc（模板库 + 句库）
- 对应渲染页面

**阶段 4：产品收尾（2h）**
- 新手向导（复用现有逻辑）
- 设置页（账号/签名/配置/通用）
- 自动发送（auto-send-service + ipc + 页面）
- 数据导出 + 导入
- 窗口状态持久化
- 暗色模式完善
- 快捷键绑定

**总计：约 11 小时**

---

### 五、与 shared-contracts 的关系

v3.0 从第一天就 `require("shared-contracts")`：
- `ipc/` 文件全部用 `const { CONTACTS } = require("shared-contracts")` 注册通道
- `preload.js` 用 `const { CONTACTS } = require("shared-contracts")` 暴露 API
- 渲染层也用同一套常量，消除字符串硬编码
- 跑 `contracts-validate` 得分应该从 32 涨到 90+