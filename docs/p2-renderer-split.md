# P2: 渲染进程拆分方案 v3（审查修正）

## 目标

`electron/renderer/app.js` (4800+ 行) → 按功能域拆分为 8 个文件。

## 文件结构

```
electron/renderer/
├── index.html
├── styles.css
├── icons.js
├── shared.js               # 工具 + 弹窗 + 导航 + 仪表盘 + 共享数据（~250行）
├── shared-data.js          # templateLib, contactsData, clientsData, queue 等共享状态（~50行）
├── workshop.js             # 模板编辑 + 质量检查（~350行）
├── templates.js            # 邮件拼装引擎: assembleEmail, randomPick, matchUserTemplates（~850行）
├── send-compose.js         # 邮件发送页面: 公司列表 + 已选卡片 + 加入队列（~600行）
├── send-queue.js           # 发送队列 + 进度 + 引擎交互 + 退信扫描（~700行）
├── send-history.js         # 发送总览（~500行）
├── contacts.js             # 联系人 + 客户导入 + 客户开发（~750行）
├── backcheck.js            # 背调详情（~550行）
├── settings.js             # 设置 + 退信检测（~350行）
```

合计 **8 个新文件**（不含 icons.js 和 shared.js）。

## 依赖图

```
shared.js  ← 所有文件
shared-data.js ← 需要跨文件共享的状态（templateLib, contactsData, queue）

settings.js ← shared
workshop.js ← shared + shared-data
templates.js ← shared + shared-data
contacts.js ← shared + shared-data
backcheck.js ← shared + shared-data + contacts
send-compose.js ← shared + shared-data + templates + contacts
send-queue.js ← shared + shared-data + send-compose
send-history.js ← shared + shared-data + send-queue
```

无循环依赖。DAG，最底层 shared → 最上层 send-*。

## 共享状态（shared-data.js）

```js
// 从 app.js 迁移的全局变量
export let templateLib = null;
export let contactsData = [];
export let clientsData = [];
export let queue = [];
export let sendInProgress = false;
export let selectedCompanySet = new Set();
export let discoverPreselectCompany = null;
```

`templateLib` 被 workshop.js 赋值、templates.js 和 send-compose.js 消费。`queue` 被 send-queue.js 管理、backcheck.js 的 addReportToQueue 写入。`contactsData` 被 contacts.js 赋值、send-compose.js 和 backcheck.js 消费。ES modules 的 live binding 天然保证所有 import 方看到同一份引用，不需要手写 getter/setter。

## HTML 加载

```html
<script type="module" src="icons.js"></script>
<script type="module" src="shared.js"></script>
<script type="module" src="shared-data.js"></script>
<script type="module" src="workshop.js"></script>
<script type="module" src="templates.js"></script>
<script type="module" src="contacts.js"></script>
<script type="module" src="backcheck.js"></script>
<script type="module" src="send-compose.js"></script>
<script type="module" src="send-queue.js"></script>
<script type="module" src="send-history.js"></script>
<script type="module" src="settings.js"></script>
```

## 实施步骤（按依赖顺序）

| 步 | 文件 | 依赖 | 验证 |
|----|------|------|------|
| 1 | `shared.js` | icons.js | 导航切换、弹窗、仪表盘 |
| 2 | `shared-data.js` | shared.js | 变量可 import |
| 3 | `settings.js` | shared + shared-data | 加载配置、修改保存、退信页 |
| 4 | `workshop.js` | shared + shared-data | 模板编辑、质量检查 |
| 5 | `templates.js` | shared + shared-data | 模板预览、assembleEmail 输出 |
| 6 | `contacts.js` | shared + shared-data | 导入客户、联系人、客户开发 |
| 7 | `backcheck.js` | shared + shared-data + contacts | 背调列表、启动背调、查看报告 |
| 8 | `send-compose.js` | shared + shared-data + templates + contacts | 选公司、拼邮件、加入队列 |
| 9 | `send-queue.js` | shared + shared-data + send-compose | 队列列表、开始/暂停/取消、进度 |
| 10 | `send-history.js` | shared + shared-data + send-queue | 发送总览、搜索、筛选、预览 |
| 11 | 删 `app.js` | — | 全功能回归 |

## 退化防护

- 每个文件超过 **800 行** → 触发进一步拆分
- `shared-data.js` 只放变量声明，不加逻辑

## 变更记录

- v1: 15 文件 + state.js + api.js → 放弃（太多文件、api.js 多余）
- v2: 6 文件 → 放弃（send.js 2000行、workshop.js 1200行、实施顺序错误）
- v3: 8 文件 + shared-data.js → 当前方案
