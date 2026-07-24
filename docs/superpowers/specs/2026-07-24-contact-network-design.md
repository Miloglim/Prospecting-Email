# 联系人关系网络 — 详细设计规格 v3（QA 修复版）

> 在 CRM 客户跟进右侧详情面板新增第 5 个 tab，以 D3 力导向图展示同一公司内联系人之间的多维关联关系。

---

## 1. 数据模型

### 1.1 关系存储

自定义关系存储在 contact 的 `_extra` JSON 字段中，新增 `relations` 数组：

```json
{
  "_extra": {
    "crmPreferences": { ... },
    "crmReminder": { ... },
    "relations": [
      {
        "targetId": "c_abc123",
        "label": "决策人",
        "category": "",
        "color": "",
        "createdAt": "2026-07-24T10:00:00+08:00"
      }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `targetId` | string | 对方 contact.id |
| `label` | string | 用户自定义关系标签（"决策人""对接窗口"等） |
| `category` | string | 可选分类，留空=未分类。未来填 `org`/`biz`/`personal` |
| `color` | string | 可选颜色 hex，留空=使用默认金色 `#e6a817` |
| `createdAt` | ISO 8601 | 创建时间 |

- 关系是**单向**的（A 标记 B 为决策人 ≠ B 标记 A）
- 删除：`targetId` + `label` 都匹配时移除
- 去重：同一对 (fromId, targetId, label) 不重复创建

### 1.2 竞态保护（P0 #7.1 修复）

`updateExtra` 和 `saveRelation` 操作同一个 `_extra` JSON 字段，存在读-改-写竞态。

**修正方案**：`saveRelation` / `deleteRelation` 使用 `contactsDb.update()` 单次写入（`_extra` 列），与 `updateExtra` 走同一通道。关键保护：

1. 所有 `_extra` 写入统一收敛到 `contactsDb.update(id, { _extra: newExtra })`
2. `saveRelation` 内部读取最新 `_extra` → 修改 → 立即写回（同一事件循环中完成，JS 单线程保护）
3. `updateExtra` 的 300ms debounce 在渲染进程侧，主进程侧不存在并发问题
4. **不依赖 db.transaction()** — 因为 SQLite WAL 模式下事务不解决读-改-写竞态，单线程 JS 事件循环本身即是同步保证

**relations 数组上限**：最多 200 条。超出时拒绝新增并 toast 提示"关系数量已达上限"。

### 1.3 悬空引用清理（P0 #6.1 修复）

联系人删除后，其他联系人的 `_extra.relations` 中指向已删 ID 的记录不会被自动清理。

**修正**：`contacts-db.js` 的 `remove(id)` 函数增加级联逻辑 — 删除联系人时，同步遍历所有同 `company_id` 的联系人，从 `_extra.relations` 中移除 `targetId === id` 的条目。

```sql
-- deleteRelation 伪代码
UPDATE contacts SET _extra = json_remove(_extra, '$.relations[?(@.targetId=="deletedId")]')
WHERE company_id = ? AND json_extract(_extra, '$.relations[*].targetId') LIKE ?
```

### 1.4 NULL company_id 处理（P1 #1.3 修复）

渲染层在调用 `getRelations` 之前，先检查 `contact.company_id` 是否存在。若为 NULL，**不发起 IPC**，直接渲染降级 UI。服务端 query 中 `WHERE company_id = NULL` 永远返回 0 行，服务端无法区分"无公司"和"公司下无人"。

### 1.8 悬空 edge 过滤（P0 #6.1 / P1 #6.2 修复）

`getRelations` 返回 edges 前，必须过滤掉 target 不在 nodes 中的边：

```js
const nodeIds = new Set(nodes.map(n => n.id));
const validEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
```

这同时处理了：
- 联系人已删除（DB 级联清理未覆盖到的 edge case）
- 联系人公司变更（target 已不在当前公司）
- 历史脏数据

### 1.9 同公司联系人查询

```sql
SELECT c.id, c.first_name, c.last_name, c.title, c.email,
       c._status, c.opp_stage, c.tags
FROM contacts c
WHERE c.company_id = ? AND c.id != ?
LIMIT 80
```

`LIMIT 80` 防止超大公司卡顿。注意：**不 SELECT `_extra`** — 渲染层不需要完整 JSON，IPC 响应字段已裁剪。

### 1.4 邮件关联查询

```sql
SELECT DISTINCT c.id, inbox.subject
FROM inbox
JOIN contacts c ON lower(inbox.from_addr) = lower(c.email)
WHERE c.company_id = ? AND inbox.matched_contacts IS NOT NULL
  AND instr(inbox.matched_contacts, ?) > 0
LIMIT 100
```

### 1.5 IPC 参数校验（P1 #2.1 修复）

所有 handler 入口处做三阶段校验：

```js
ipcMain.handle('crm:saveRelation', async (_e, { fromId, toId, label }) => {
  if (!fromId || typeof fromId !== 'string') return fail("缺少 fromId");
  if (!toId || typeof toId !== 'string') return fail("缺少 toId");
  if (fromId === toId) return fail("不能添加与自己的关系");
  // 进入 service 层...
});
```

### 1.6 IPC 响应字段裁剪（P1 #2.2 修复）

`getRelations` 返回的 node 对象**只包含渲染所需字段**（id, name, title, email, stage, interactionCount, isPrimary），不携带完整 `_extra`。在 service 层手动构造精简对象，避免 IPC 序列化大 JSON。

### 1.7 IPC 契约

**`crm:getRelations`** — 统一响应 `{ ok, data }` 格式：

```
请求: { contactId: string }
响应 (成功): {
  ok: true,
  data: {
    nodes: Array<{ id, name, title, email, stage, interactionCount, isPrimary }>,
    edges: Array<{ source, target, type, label }>,
    truncated: boolean     // 节点超过 LIMIT 时为 true
  }
}
响应 (失败): { ok: false, error: string }
```

**`crm:saveRelation`**：

```
请求: { fromId: string, toId: string, label: string }
响应: { ok: true } | { ok: false, error: string }
// label 为空 → 删除关系
// label 非空 → 创建/更新关系
```

**`crm:deleteRelation`**：

```
请求: { fromId: string, toId: string, label: string }
响应: { ok: true } | { ok: false, error: string }
```

**新建 IPC 常量**（`contract.js`）：
```js
const CRM = {
  // ...existing...
  GET_RELATIONS: "crm:getRelations",
  SAVE_RELATION: "crm:saveRelation",
  DELETE_RELATION: "crm:deleteRelation",
};
```

### 1.6 日志规范

所有 `catch` 块必须包含 `Log.error(ctx, msg, error.stack)`：

| 错误场景 | Log 调用 |
|---------|---------|
| `getRelations` 查询失败 | `Log.error("CRM关系网络", "获取关系失败", e.stack)` |
| `saveRelation` 失败 | `Log.error("CRM关系网络", "保存关系失败", e.stack)` |
| `deleteRelation` 失败 | `Log.error("CRM关系网络", "删除关系失败", e.stack)` |
| D3 simulation 异常 | `Log.error("CRM关系网络", "力导向布局异常", e.stack)` |
| `require('d3-force')` 失败 | `Log.error("CRM关系网络", "D3 模块加载失败", e.stack)` |

---

## 2. 渲染常量（消除魔数）

```js
// ── 节点 ──
const NODE_RADIUS_MIN = 8;
const NODE_RADIUS_MAX = 20;
const NODE_LABEL_FONT_SIZE = 10;
const NODE_LABEL_OFFSET_Y = 4;
const NODE_LABEL_MAX_CHARS = 8;
const NODE_HOVER_SCALE = 1.2;
const NODE_HOVER_TRANSITION_MS = 150;
const ACTIVE_NODE_STROKE_WIDTH = 3;

// ── 连线 ──
const EDGE_LABEL_FONT_SIZE = 9;
const EDGE_COMPANY_STROKE = '#d0d0d0';
const EDGE_COMPANY_WIDTH = 2;
const EDGE_EMAIL_STROKE = '#5c6bc0';
const EDGE_EMAIL_WIDTH = 1;
const EDGE_EMAIL_DASH = '4,3';
const EDGE_CUSTOM_STROKE = '#e6a817';
const EDGE_CUSTOM_WIDTH = 1.5;
const EDGE_CUSTOM_DASH = '6,3';

// ── 力导向 ──
const SIMULATION_FORCE_STRENGTH = -300;
const SIMULATION_COLLIDE_RADIUS = 30;
const SIMULATION_STOP_AFTER_MS = 5000;
const SIMULATION_ALPHA_MIN = 0.05;
const SIMULATION_NODE_LIMIT = 80;

// ── 容器 ──
const PANEL_MIN_HEIGHT_PX = 400;

// ── 缩放 ──
const ZOOM_EXTENT_MIN = 0.3;
const ZOOM_EXTENT_MAX = 3;

// ── 悬停 ──
const TOOLTIP_SHOW_DELAY_MS = 240;
const TOOLTIP_HIDE_DELAY_MS = 150;
const TOOLTIP_MAX_WIDTH_PX = 200;

// ── 阶段颜色 ──
const STAGE_COLORS = {
  reaching: '#ff9800',
  quoting: '#2196f3',
  trial: '#8e24aa',
  cooperating: '#4caf50',
  lost: '#b0b0b0',
  __default: '#999',
};
```

---

## 3. UI 规格

### 3.1 Tab 位置

在 `crm-detail-tabs` 中，紧跟"邮件往来"之后：

```
基本信息 | 偏好设置 | 跟进记录 | 邮件往来 | 关系网络
```

### 3.2 面板布局

```
┌──────────────────────────────────────────────────┐
│ 图例  ━ 同公司   ┅ 邮件关联   ┅ 自定义标签       │  ← 固定顶部，font-size 10px
├──────────────────────────────────────────────────┤
│                                                  │
│              SVG 力导向图                          │  ← flex:1，min-height: 400px
│                                                  │
│                                                  │
└──────────────────────────────────────────────────┘
│ 右键节点可添加/删除关系   ⚠ 仅展示前 80 个联系人   │  ← 底部提示
└──────────────────────────────────────────────────┘
```

### 3.3 节点规格

| 属性 | 值 |
|------|-----|
| 形状 | `<circle>` |
| 半径 | `d3.scaleLinear().domain([0, maxInteractions]).range([NODE_RADIUS_MIN, NODE_RADIUS_MAX])` |
| 填充色 | `STAGE_COLORS[stage]` 映射 |
| 描边 | 当前联系人 `#fff 3px`，其他 `none` |
| 悬停 | `transform: scale(1.2)` + `transition: 150ms` |
| 标签 | `<text>` 在节点下方 `4px`，font-size `10px`，最多 `8` 字符 |

### 3.4 连线规格

| 类型 | stroke | width | dasharray | 始终显示 |
|------|--------|-------|-----------|---------|
| company | `#d0d0d0` | 2 | none | 是 |
| email | `#5c6bc0` | 1 | `4,3` | 否 |
| custom | `#e6a817` | 1.5 | `6,3` | 是 |

custom 连线中点上方显示 `<text>` 标签（font-size 9px, fill = 自定义颜色或默认金色）。

### 3.5 图例

固定在面板顶部，水平排列，gap 12px。

---

## 4. 交互规格

### 4.1 缩放/平移

- `d3.zoom().scaleExtent([ZOOM_EXTENT_MIN, ZOOM_EXTENT_MAX])`
- 滚轮缩放，按住拖拽平移

### 4.2 节点拖拽（P1 #4.1 修复 — 防止 drag 与 zoom 冲突）

```js
const drag = D3_DRAG.drag()
  .filter(event => !event.ctrlKey && event.button === 0) // 仅左键无修饰键时触发
  .on('start', (event, d) => {
    if (!event.active) _simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  })
  .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
  .on('end', (event, d) => {
    if (!event.active) _simulation.alphaTarget(0);
    d.fx = null; d.fy = null; // 释放后回到力导向
  });
```

### 4.3 标签缩放隐藏（P1 #4.4 修复）

```js
const zoom = D3_ZOOM.zoom()
  .scaleExtent([ZOOM_EXTENT_MIN, ZOOM_EXTENT_MAX])
  .on('zoom', (event) => {
    g.attr('transform', event.transform);
    const scale = event.transform.k;
    labelGroup.style('display', scale < 0.5 ? 'none' : ''); // scale<0.5 隐藏标签
  });
```

### 4.4 节点点击短路（P2 #4.5 修复）

```js
node.on('click', (event, d) => {
  if (d.id === _currentDetailId) return; // 已选中，忽略
  openDetailPanel(d.id);
});
```

### 4.3 节点点击

- 单击 → 调用 `openDetailPanel(contactId)` 切换联系人
- 双击 → 同单击

### 4.5 右键菜单（P1 #4.2 / #4.3 修复）

**右键节点** → 弹出菜单：
- 添加关联 → 子菜单列出同公司其他联系人，**最多显示 15 个**，超出顶部加搜索输入框过滤
- 编辑标签 → 修改已有自定义标签
- 查看详情 → 同单击

**菜单定位翻转**：
```js
const x = event.clientX;
const y = event.clientY;
const menuH = 200; // 预估菜单高度
const flippedY = y + menuH > window.innerHeight ? y - menuH : y;
menu.style.left = x + 'px';
menu.style.top = flippedY + 'px';
```

**右键自定义连线** → 删除关系 → 确认后 `crm:deleteRelation`

### 4.5 悬停行为

- 悬停 240ms 后显示 tooltip
- Tooltip 内容：姓名、职位、阶段、互动次数
- 移开 150ms 后淡出

### 4.6 空状态

- 同公司只有自己 → "该公司暂无其他联系人"
- 节点数 > 80 → 截断，底部提示"仅展示前 80 个联系人"

---

## 5. 生命周期管理

### 5.1 初始化（P0 #3.1 / P1 #5.2 / P2 #5.5 修复）

切到"关系网络"tab 时触发。由于 `crm-pipeline.js` 是 ESM 模块，使用动态 `import()` 加载 D3：

```js
let D3_FORCE, D3_SELECTION, D3_DRAG, D3_ZOOM;
try {
  const [force, selection, drag, zoom] = await Promise.all([
    import('d3-force'), import('d3-selection'), import('d3-drag'), import('d3-zoom')
  ]);
  D3_FORCE = force; D3_SELECTION = selection; D3_DRAG = drag; D3_ZOOM = zoom;
} catch (e) {
  Log.error("CRM关系网络", "D3 模块加载失败", e.stack);
  panel.innerHTML = renderDegradedUI(); // 降级 UI
  return;
}
```

每个子包独立 try-catch，避免部分加载成功部分失败导致的后续 undefined 引用。

### 5.2 销毁（P0 #5.1 修复）

`closeDetailPanel` 中必须显式清理：

```js
// 销毁 D3 simulation
if (_simulation) {
  _simulation.stop();
  _simulation = null;
}
// 清理 D3 事件绑定 + DOM
const svg = document.querySelector('.crm-relations-svg');
if (svg) {
  D3_SELECTION?.select(svg).on('.', null); // 移除所有 D3 事件监听器
  svg.innerHTML = '';
}
// 清理 resize 监听
if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
```

### 5.3 Tab 切走保护（P0 #3.1 修复）

simulation tick 回调中检查 tab 是否仍然激活：

```js
simulation.on('tick', () => {
  if (_currentTab !== 'relations') return; // tab 已切走，停止更新 DOM
  // ... update positions ...
});
```

### 5.4 domain [0,0] 保护（P1 #3.2 修复）

```js
const maxInteractions = Math.max(1, ...nodes.map(n => n.interactionCount));
const radiusScale = d3.scaleLinear().domain([0, maxInteractions]).range([NODE_RADIUS_MIN, NODE_RADIUS_MAX]);
```

### 5.5 ResizeObserver 去抖（P1 #3.3 修复）

```js
let _resizeDebounce;
_resizeObserver = new ResizeObserver(() => {
  clearTimeout(_resizeDebounce);
  _resizeDebounce = setTimeout(() => {
    if (_simulation && _currentTab === 'relations') {
      _simulation.alpha(Math.min(_simulation.alpha(), 0.3)).restart();
    }
  }, 300); // 300ms 去抖，防连续触发
});
```

### 5.6 超级计时 + 缓能（P1 #5.3 修复）

- 首次加载从 IPC 获取数据后缓存 `_relationsCache = { contactId, nodes, edges }`
- 切回关系网络 tab 时：若 `_relationsCache.contactId === _currentDetailId`，复用缓存不重新 IPC
- `crm:changed` 事件处理中过滤 `contactId`：`if (changedContactId !== _currentDetailId) return;` 防止无关联系人的阶段变更触发无意义刷新
- 添加/删除关系操作后直接更新 local cache，不触发 IPC

### 5.7 超时保护

simulation 启动 5 秒后若 alpha > 0.05，强制 `stop()` 并 Log.warn。

---

## 6. 错误处理与降级

| 场景 | 处理 |
|------|------|
| `getRelations` 查询失败 | `Log.error` + 面板显示错误信息 |
| `saveRelation` / `deleteRelation` 失败 | `Log.error` + showToast('保存失败', 'err') |
| `require('d3-*')` 失败 | `Log.error` + 面板显示"图表组件加载失败，请重启应用" |
| 联系人无 company_id | 面板显示"该联系人未关联公司，无法生成关系图" |
| 节点数超过 SIMULATION_NODE_LIMIT | 截断 + 底部提示 |
| simulation 5 秒未稳定 | `stop()` + `Log.warn` |
| SVG 容器不存在 | 静默跳过 |
| 面板 resize | `ResizeObserver` 触发 simulation.reheat() |

---

## 7. 实现清单

### 7.1 新增依赖

```bash
npm install d3-force d3-selection d3-drag d3-zoom
```

~12KB gzipped，仅引入 4 个子包，不拉完整 D3。

### 7.2 文件变更

| 文件 | 变更 |
|------|------|
| `electron/modules/services/crm-service.js` | `getRelations()` / `saveRelation()` / `deleteRelation()` + 修复 `updateExtra` 深合并 |
| `electron/modules/ipc/crm-ipc.js` | 注册 3 个 handler |
| `electron/modules/core/contract.js` | 新增 `GET_RELATIONS` / `SAVE_RELATION` / `DELETE_RELATION` |
| `electron/preload.js` | 新增 `crmGetRelations` / `crmSaveRelation` / `crmDeleteRelation` |
| `electron/renderer/modules/crm-pipeline.js` | `relationsTab()` + tab 注册 + D3 渲染 + 生命周期管理 |
| `electron/renderer/styles.css` | ~40 行新增样式 |
| `package.json` | d3-* 依赖 |

### 7.3 测试

| 层 | 覆盖 |
|----|------|
| `crm-service.getRelations` | 单元测试：返回正确 `{ ok, data: { nodes, edges } }` |
| `crm-service.saveRelation` | 单元测试：写入/去重/删除 |
| `crm-service.deleteRelation` | 单元测试：删除成功 + 不存在时静默 |
| `crm-ipc` handler | 手动测试：IPC 通信正常 |
| 渲染层 | 手动验收：D3 图渲染、交互、边界情况 |

### 7.4 前置条件

**必须在编码前修复**：
- [ ] `crm-service.js` 的 `updateExtra` 改为深合并，不吞掉 `relations`
- [ ] 用户审批 d3-* 依赖

---

## 8. SemVer

新增 feature（CRM tab + 关系网络），不含 breaking change。Bump **minor** → `3.2.0`。

---

## 9. 验收标准

- [ ] 新增"关系网络"tab，点击后显示同公司联系人关系图
- [ ] 节点颜色按 CRM 阶段区分
- [ ] 节点大小按互动频率映射
- [ ] 当前联系人节点高亮
- [ ] 三种连线类型正确显示（company / email / custom）
- [ ] 图例固定显示
- [ ] 滚轮缩放、拖拽节点、拖拽平移
- [ ] 点击节点切换到该联系人
- [ ] 右键添加/编辑/删除自定义关系
- [ ] 关闭面板时 simulation 销毁，无内存泄露
- [ ] `updateExtra` 深合并，不吞掉 `relations`
- [ ] 自定义关系持久化，刷新后仍在
- [ ] 同公司只有 1 人时显示空状态
- [ ] 节点 > 80 时截断 + 提示
- [ ] D3 require 失败时显示降级 UI
- [ ] 所有 catch 包含 `Log.error(ctx, msg, e.stack)`
- [ ] IPC 响应统一 `{ ok, data }` 格式
- [ ] 所有魔数声明为常量
- [ ] 新增 IPC 同步更新 contract.js + preload.js
- [ ] `node scripts/check.js` 零报错
