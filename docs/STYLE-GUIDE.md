# Milogin's Prospector — 产品风格基准确认书

> 本文档是 Prospector 系列产品的设计/架构/代码风格唯一真相源。
> 新产品必须严格对齐本文档的所有约定，偏差需在项目 CLAUDE.md 中显式声明并说明理由。

---

## 1. 架构风格

### 1.1 三层分离（不可逾越）

```
electron/modules/
  core/        ← 纯净基础层：零 Electron/Node 依赖，纯逻辑+类型
  services/    ← 核心业务层：不碰 IPC，依赖通过参数(deps)注入
  ipc/         ← 路由转发层：只做参数校验+路由，业务调 services
```

**红线：**
- `core/` 禁止 `require('electron')`
- `services/` 禁止调用 `ipcMain.handle()` / `ipcRenderer.invoke()`
- `ipc/` 禁止包含业务逻辑，所有逻辑下沉到 `services/`

### 1.2 契约先行

新增任何 IPC 通道的强制顺序：
1. `core/contract.js` → 增加常量
2. `preload.js` → 增加桥接方法
3. `ipc/xxx-ipc.js` → 编写 handler

三者必须双向验证，`scripts/check.js` 自动检查对齐。

### 1.3 统一返回格式

```js
// 成功
{ ok: true, data: payload }   // 或 { ok: true }（无数据时）
// 失败
{ ok: false, error: "描述信息" }
```

禁止裸返数组、字符串、`null`。

### 1.4 目录职责

| 目录 | 职责 | 可修改 |
|------|------|--------|
| `electron/modules/core/` | 纯逻辑、契约常量、类型定义 | 谨慎 |
| `electron/modules/services/` | 业务逻辑、数据库 CRUD | 是 |
| `electron/modules/ipc/` | IPC handler 路由 | 是 |
| `electron/renderer/modules/` | 渲染进程 UI 逻辑 | 是 |
| `data/` | 运行时数据库和状态文件 | 否（程序管理） |
| `templates/` | 邮件模板 Markdown | 用户可编辑 |
| `scripts/` | 构建/检查/发布脚本 | 谨慎 |
| `tests/` | 自动化测试 | 是 |

---

## 2. 代码风格

### 2.1 命名约定

| 层 | 命名风格 | 示例 |
|----|----------|------|
| JS 变量/函数 | camelCase | `getContacts`, `clientType` |
| JS 常量 | UPPER_SNAKE | `VALID_STAGES`, `FIELD_ALIAS` |
| IPC 通道 | `domain:action` | `contacts:list`, `send:start` |
| SQLite 列 | snake_case | `client_type`, `first_name` |
| CSS 类 | kebab-case BEM 轻量 | `inbox-item`, `modal-header` |
| 配置键(时间) | `_seconds` 后缀 | `min_delay_seconds` |
| 文件模块 | kebab-case | `contacts-db.js`, `inbox-ipc.js` |

### 2.2 日志规范

```js
// ✅ 正确：统一用 Log 对象
const { Log } = require("../core/logger");
Log.info("发送引擎", "发信完成", { count: 5 });
Log.error("启动", "模板加载失败", error);  // error 必须有 .stack

// ❌ 禁止
console.log("xxx");
Log.error("ctx", "msg", error.message);  // 必须传完整 error 对象
```

日志格式：`[时间] [级别] [上下文] 消息`

四级：`DEBUG`(仅开发) → `INFO`(操作记录) → `WARN`(非致命) → `ERROR`(致命+stack)

### 2.3 错误捕获铁律

```js
try {
  // ...
} catch (error) {
  Log.error("上下文", "描述操作失败的原因", error);  // 必须传 error 本身（含 stack）
  // 空 catch 必须注释原因
}
```

### 2.4 类型防线

- 所有 JSDoc 必须准确，禁止 `@type {any}` / `@type {Object}`
- 关键入口加运行时 type guard：`if (typeof data !== 'string') throw ...`
- `ponytail:` 注释标记有意简化，格式：`// ponytail: 简化原因，升级路径`

### 2.5 魔数规则

除 `0` / `1` / `-1` 外，所有数字字面量声明为命名常量：

```js
const MAX_RETRY = 3;
const TIMEOUT_MS = 15_000;
```

### 2.6 异步安全

- 非 async 回调中禁止 `await`
- 网络请求必须显式 `timeout`（默认 ≤15s）
- 重试必须指数退避（2s → 4s → 8s），禁止固定间隔

---

## 3. 设计风格

### 3.1 总体定位

**黑白极简 + Win11 轻量 + 材质光影**

- 少即多：不装饰、不渐变、不阴影堆叠
- 桌面级体验：`user-select: none` 全局，仅输入区可选
- 动画克制：150-250ms `cubic-bezier`，不超 600ms
- 毛玻璃仅用于关键过渡（启动加载层、新手向导）

### 3.2 字体系统

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, sans-serif;
```

| 用途 | 字号 | 字重 |
|------|------|------|
| 页面标题 h2 | 20px | 700 |
| 卡片标题/模块名 | 13-15px | 600 |
| 正文/表格内容 | 13px | 400 |
| 辅助文字/标签 | 11-12px | 400-500 |
| 小字/角标 | 10px | 400 |
| 导航项 | 14px | 400(默认)/600(激活) |

### 3.3 圆角系统

| 元素 | 圆角 |
|------|------|
| 卡片 | `var(--radius)` = 8px |
| 按钮 | 6px |
| 输入框 | 4-6px |
| 模态框 | 16px |
| 标签/徽章 | 8-12px (pill) |
| 进度条 | 2-3px |

### 3.4 阴影系统

极简阴影，只用一层：
```css
/* 卡片 */
box-shadow: 0 1px 4px rgba(0,0,0,0.06);
/* 模态框 */
box-shadow: 0 20px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05);
```

### 3.5 滚动条

Apple 极简风格：4px 宽，透明轨道，半透明滑块。

### 3.6 间距节奏

以 4px 为基准：
- 紧凑间距：4px, 8px
- 标准间距：12px, 16px
- 宽松间距：20px, 24px, 28px, 36px

---

## 4. 配色体系

### 4.1 CSS 变量（真理源）

```css
:root {
  /* ═══ 核心色 ═══ */
  --primary:        #1a1a1a;   /* 主色—近黑色，用于文字、按钮、强调 */
  --primary-light:  #424242;   /* 主色浅—hover 态 */
  --accent:         #00bfa5;   /* 强调色—青绿，导航激活条、进度条 */

  /* ═══ 表面色 ═══ */
  --bg:             #f5f5f5;   /* 页面底色—浅灰 */
  --card-bg:        #ffffff;   /* 卡片底色—纯白 */
  --input-bg:       #ffffff;   /* 输入框底色 */
  --nav-bg:         #fafafa;   /* 导航底色 */

  /* ═══ 侧边栏 ═══ */
  --sidebar-bg:     #1a1a1a;   /* 左侧导航底色—黑色 */
  --sidebar-text:   #ffffff;   /* 左侧导航文字—白色 */

  /* ═══ 文字 ═══ */
  --text:           #1a1a1a;   /* 主文字 */
  --text-secondary: #6b6b6b;   /* 辅助文字 */

  /* ═══ 边框 ═══ */
  --border:         #e0e0e0;   /* 通用边框 */

  /* ═══ 功能色 ═══ */
  --success:        #2e7d32;   /* 成功—深绿 */
  --warning:        #e65100;   /* 警告—深橙 */
  --danger:         #c62828;   /* 危险—深红 */

  /* ═══ 布局 ═══ */
  --nav-width:      210px;
  --radius:         8px;
}
```

### 4.2 功能色语义

| 颜色 | 变量 | 使用场景 |
|------|------|----------|
| `#2e7d32` | `--success` | 发送成功、连接正常 |
| `#e65100` | `--warning` | 退信警告、异常标记、发送中 |
| `#c62828` | `--danger` | 删除按钮、发送失败、关闭按钮 hover |
| `#00bfa5` | `--accent` | 导航选中条、进度条、保存状态 |

### 4.3 阶段标签色

| 阶段 | 背景 | 文字 |
|------|------|------|
| 冷开发 (cold) | `#e3f2fd` | `#1565c0` |
| F1 | `#e8f5e9` | `#2e7d32` |
| F2 | `#fff3e0` | `#e65100` |
| F3 | `#f3e5f5` | `#7b1fa2` |
| F4 | `#eceff1` | `#546e7a` |

### 4.4 客户类型标签

| 类型 | 背景 | 文字 |
|------|------|------|
| 代理 (agent) | `#e3f2fd` | `#1565c0` |
| 直客 (direct) | `#e8f5e9` | `#2e7d32` |

### 4.5 亮暗模式

当前仅支持亮色模式（`<html data-theme="light">`），暗色模式预留在 CSS 变量层，通过切换变量值实现。

---

## 5. 组件规范

### 5.1 模态框 (Modal)

```css
.modal-overlay {
  /* 全屏半透明遮罩 + 毛玻璃 */
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(2px);
}
.modal-card {
  /* 16px 圆角 + 弹性入场动画 */
  border-radius: 16px;
  width: 420px; max-width: 90vw;
  animation: modal-enter .25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.modal-header {
  /* 透明背景 + 底部边框（默认） */
  background: transparent;
  border-bottom: 1px solid var(--border);
}
.modal-header.m-warn {
  /* 警告态：黑色背景 + 白色文字 */
  background: var(--primary);  /* #1a1a1a */
  color: #fff;
  border-bottom: none;
}
.modal-footer {
  /* 顶部边框 + 浅色背景 + 底部圆角收口 */
  border-top: 1px solid var(--border);
  background: var(--bg);
  border-radius: 0 0 16px 16px;
}
```

### 5.2 按钮

```css
button {
  background: var(--primary);   /* 黑底白字 */
  color: #fff;
  padding: 9px 18px;
  border-radius: 6px;
  font-size: 13px;
}
button:hover { background: var(--primary-light); }
button:disabled { opacity: 0.5; }

button.secondary {
  /* 白底黑字 + 边框 */
  background: var(--card-bg);
  color: var(--text);
  border: 1px solid var(--border);
}
button.danger { background: var(--danger); }
```

### 5.3 输入框

```css
input, select, textarea {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--card-bg);
}
input:focus, select:focus, textarea:focus {
  border-color: var(--primary-light);
  box-shadow: 0 0 0 3px rgba(26,26,26,0.1);
}
```

### 5.4 表格

```css
table {
  width: 100%; border-collapse: collapse;
  background: var(--card-bg);
  border-radius: var(--radius);
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
th {
  background: #f8f9fb;           /* 浅灰表头 */
  font-weight: 600; font-size: 11px;
  text-transform: uppercase;     /* 大写英文 */
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}
td { font-size: 13px; border-bottom: 1px solid var(--border); }
tr:hover td { background: #fafbfc; }
```

### 5.5 复选框（极简圆点）

```css
input[type="checkbox"] {
  -webkit-appearance: none;
  width: 14px; height: 14px;
}
input[type="checkbox"]::before {
  /* 4px 灰圆点 → 选中变 6px 黑圆点 */
  content: ''; width: 4px; height: 4px;
  border-radius: 50%; background: #cdd0d5;
}
input[type="checkbox"]:checked::before {
  width: 6px; height: 6px;
  background: var(--primary);
}
```

### 5.6 筛选标签 (Chip/Tab)

```css
.cf-tab {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 12px;           /* pill 形状 */
  background: #fff;
  font-size: 11px;
  cursor: pointer;
}
.cf-tab.active {
  background: var(--primary);    /* 选中：黑底白字 */
  color: #fff;
  border-color: var(--primary);
}
```

### 5.7 进度条

```css
.progress-bar {
  height: 4px;
  background: var(--border);
  border-radius: 2px;
}
.progress-fill {
  height: 100%;
  background: var(--text);       /* 静态：纯黑 */
}
.progress-fill.active {
  /* 发送中：渐变扫光动画 */
  background: linear-gradient(90deg, ...);
  animation: progress-shimmer 2s linear infinite;
}
```

### 5.8 上下文菜单 (Context Menu)

```css
.send-ctx-menu {
  position: fixed; z-index: 1000;
  min-width: 200px; max-width: 320px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.14);
  padding: 4px 0;
  font-size: 12px;
}
```

---

## 6. 图标体系

### 6.1 统一导入规则

所有图标从 `shared.js` 统一导出，渲染层各模块通过 `window._icon('name')` 使用。

**绝对禁止**各模块自行定义 `lucide` 图标引用。

### 6.2 图标尺寸

| 场景 | 尺寸 |
|------|------|
| 导航图标 | 20×20px |
| 按钮内图标 | 12×12px |
| 内联图标 | 与文字等高 (1em) |
| 大图标（空状态） | 32-36px |

### 6.3 图标使用

```html
<!-- HTML data 属性 -->
<span data-icon="send"></span>
<span data-icon="trash"></span>

<!-- JS 动态创建 -->
const icon = window._icon('chevron-down');
```

---

## 7. IPC 设计模式

### 7.1 通道命名

`domain:action` 格式，全部小写：

```
contacts:list      contacts:import     contacts:delete
send:start         send:pause          send:status
inbox:fetch        inbox:list          inbox:delete
template:getLibrary  template:saveOverrides
```

### 7.2 三端对齐

```
contract.js          preload.js             ipc/xxx-ipc.js
─────────────────    ───────────────────    ──────────────────
CONTACTS.LIST    →   getContacts: () =>  →  ipcMain.handle(
                       ipcRenderer            "contacts:list",
                       .invoke(               async () => { ... })
                       "contacts:list")
```

### 7.3 事件推送（main → renderer）

```js
// contract.js
CHANGED: "contacts:changed"

// preload.js
onContactsChanged: (cb) => {
  ipcRenderer.on("contacts:changed", cb);
  return () => ipcRenderer.removeListener("contacts:changed", cb);
}

// renderer
const unsub = window.electronAPI.onContactsChanged(() => refreshUI());
// 组件卸载时 unsub();
```

---

## 8. 数据库设计

### 8.1 引擎

SQLite via `better-sqlite3`（同步 API，无回调）。

### 8.2 命名约定

| 层级 | 命名 | 示例 |
|------|------|------|
| 表名 | 小写复数 | `contacts`, `companies` |
| 主键 | `id` (UUID v4) | `c.id` |
| 外键 | `表名单数_id` | `company_id` |
| 时间戳 | `created_at`, `updated_at` | ISO 8601 |
| 布尔 | `is_` 前缀, INTEGER 0/1 | `is_bounced` |
| 列名 | snake_case | `client_type`, `first_name` |

### 8.3 查询模板

```sql
SELECT c.id, c.company_id, c.email, c.first_name, ...
       co.name as company_name, co.country as company_country
FROM contacts c
LEFT JOIN companies co ON co.id = c.company_id
ORDER BY c.created_at DESC
```

### 8.4 写入模式

- `upsert()`: email 为唯一键，存在则 update，否则 insert
- `update()`: 通过 `VALID_COLS` 白名单校验 + `FIELD_ALIAS` camelCase→snake_case 映射
- 公司创建走 `ensureCompany()`：先查后插，返回 ID

### 8.5 迁移

- `_schema` 表标记迁移版本
- 从旧 JSON 文件一次性迁移到 SQLite
- 迁移完成后写标记，防止重复执行

### 8.6 备份

- 自动备份：`contacts.bak1`, `contacts.bak2`, `contacts.bak3`
- 清理时一并删除

---

## 9. 日志系统

### 9.1 格式

```
[2026-07-14 16:30:00.123] [INFO] [上下文] 消息 {"key":"value"}
[2026-07-14 16:30:05.456] [ERROR] [上下文] 错误描述
Error: ...
    at xxx.js:12:3
```

### 9.2 API

```js
const { Log } = require("../core/logger");

Log.debug("ctx", "msg", data);   // 仅开发模式 console
Log.info("ctx", "msg", data);    // 写文件 + console.log
Log.warn("ctx", "msg", data);    // 写文件 + console.warn
Log.error("ctx", "msg", error);  // 写文件 + console.error（需 .stack）
```

### 9.3 文件管理

- 路径：`logs/app-YYYY-MM-DD.log`
- 时区：Asia/Shanghai
- 清理：保留最近 7 天

---

## 10. 测试策略

### 10.1 测试层级

| 层级 | 目录 | 内容 | 依赖 |
|------|------|------|------|
| 纯逻辑单测 | `tests/` | 函数输入输出 | Node.js 原生 |
| 语法+契约检查 | `scripts/check.js` | 语法+IPC 对齐 | 无 |
| 冒烟测试 | `SMOKE-CHECKLIST.md` | 手动操作清单 | 完整应用 |

### 10.2 测试要求

- 纯逻辑函数必须有测试（解析、分类、验证）
- 每次发布前跑 `npm test` + `npm run check`
- 冒烟清单保持更新

---

## 11. 发布流程

```
npm test              # 纯逻辑测试
npm run check         # 语法 + IPC 契约检查
npm version patch     # 版本号（SemVer）
git push --tags       # 推送标签
npm run ship          # 构建分发包
gh release create vX.Y.Z dist-release/*.exe
```

---

## 12. 安全红线

- API Key / SMTP 密码**严禁硬编码**，必须从 `.env` 或加密配置读取
- 用户粘贴密钥到对话时立即提醒删除
- `webUtils.getPathForFile()` 用于文件路径获取
- `contextBridge.exposeInMainWorld()` 只暴露白名单方法

---

## 13. 设计决策记录

| 决策 | 理由 | 日期 |
|------|------|------|
| SQLite 替代 JSON 文件 | 并发安全 + 查询能力 | 2025 |
| better-sqlite3 同步 API | 简单可靠，无回调地狱 | 2025 |
| 三层分离架构 | 可测试性 + 边界清晰 | 2025 |
| Lucide 图标统一从 shared.js 导入 | 避免重复定义，便于替换 | 2025 |
| ES 模块 (renderer) vs CommonJS (main) | Electron 双进程限制 | 2025 |
| `user-select: none` 全局 | 桌面应用体验 | 2026 |
| 事件委托代替逐个绑定 | 防止监听器累积 | 2026 |
| `ponytail:` 注释标记简化 | 可追溯的技术债 | 2026 |

---

> 本文档随项目演进持续更新。重大架构变更必须同步更新本文档。
