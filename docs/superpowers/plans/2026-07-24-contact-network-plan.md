# 联系人关系网络 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CRM 详情面板新增第 5 个 tab，以 D3 力导向图展示同公司联系人关系网络

**Architecture:** 分层实现 — 先 service 层（getRelations/saveRelation/deleteRelation + updateExtra 修复），再 IPC 层（contract/preload/handler），最后渲染层（D3 力导向图 + tab + 交互）。每层有独立测试验证。

**Tech Stack:** Node.js, better-sqlite3 (service), Electron IPC (transport), D3 v7 (d3-force/d3-selection/d3-drag/d3-zoom), vanilla SVG

## Global Constraints

- 所有 IPC 通道必须先在 `contract.js` 加常量 → 再改 `preload.js` → 最后写 handler
- 所有 service 函数返回 `{ ok, data? }` 或 `{ ok: false, error }` 格式
- 所有 catch 块必须 `Log.error(ctx, msg, error.stack)`
- 所有魔数声明为渲染常量（0/1/-1 除外）
- 渲染层不直接修改 `S.*` 全局状态
- 新增依赖 d3-force d3-selection d3-drag d3-zoom (~12KB gzipped)，已批准

---

### Task 0: 安装 D3 依赖

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `d3-force`, `d3-selection`, `d3-drag`, `d3-zoom` 可用

- [ ] **Step 1: Install**

```bash
cd "E:\Agents Basement\projects\Prospecting Email"
npm install d3-force d3-selection d3-drag d3-zoom
```

- [ ] **Step 2: Verify**

```bash
node -e "require('d3-force');require('d3-selection');require('d3-drag');require('d3-zoom');console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add d3-force d3-selection d3-drag d3-zoom for contact network graph"
```

---

### Task 1: IPC 契约 + Preload

**Files:**
- Modify: `electron/modules/core/contract.js:401-406` (CRM exports)
- Modify: `electron/preload.js:272` (after existing CRM APIs)

**Interfaces:**
- Produces:
  - `IPC.CRM.GET_RELATIONS = "crm:getRelations"`
  - `IPC.CRM.SAVE_RELATION = "crm:saveRelation"`
  - `IPC.CRM.DELETE_RELATION = "crm:deleteRelation"`
  - `window.electronAPI.crmGetRelations(contactId)`
  - `window.electronAPI.crmSaveRelation(fromId, toId, label)`
  - `window.electronAPI.crmDeleteRelation(fromId, toId, label)`

- [ ] **Step 1: 在 contract.js CRM 导出块中新增三个常量**

Open `electron/modules/core/contract.js`，在 CRM 对象末尾（约 line 420，`TAG` 之后）新增：

```js
  /** 获取联系人关系网络数据 */
  GET_RELATIONS: "crm:getRelations",
  /** 保存自定义关系标签 */
  SAVE_RELATION: "crm:saveRelation",
  /** 删除自定义关系 */
  DELETE_RELATION: "crm:deleteRelation",
```

- [ ] **Step 2: 在 preload.js 新增三个 API**

Open `electron/preload.js`，在 `crmGetEmailBody` 之后新增：

```js
  crmGetRelations: (contactId) => ipcRenderer.invoke("crm:getRelations", contactId),
  crmSaveRelation: (fromId, toId, label) => ipcRenderer.invoke("crm:saveRelation", { fromId, toId, label }),
  crmDeleteRelation: (fromId, toId, label) => ipcRenderer.invoke("crm:deleteRelation", { fromId, toId, label }),
```

- [ ] **Step 3: Verify contract + preload 一致性**

```bash
node scripts/check.js
```

Expected: `✓ IPC 契约: preload.js 双向对齐`

- [ ] **Step 4: Commit**

```bash
git add electron/modules/core/contract.js electron/preload.js
git commit -m "feat(ipc): add crm:getRelations/saveRelation/deleteRelation channels"
```

---

### Task 2: Service 层 — getRelations

**Files:**
- Modify: `electron/modules/services/crm-service.js` (新增函数)
- Test: `tests/crm-relations.test.js` (新建)

**Interfaces:**
- Consumes: `contacts-db.getById()`, `getDb()`, `interactions-db.list()`
- Produces: `getRelations(contactId) → { ok, data: { nodes, edges, truncated } }`

- [ ] **Step 1: 写测试**

Create `tests/crm-relations.test.js`:

```js
// 测试 getRelations 基本功能
"use strict";
const assert = require("assert");
const contactsDb = require("../electron/modules/services/contacts-db");
const { getDb } = require("../electron/modules/services/db");
const crm = require("../electron/modules/services/crm-service");

// Setup: 创建测试数据和联系人
function setup() {
  const db = getDb();
  db.exec("DELETE FROM contacts");
  const c1 = contactsDb.upsert({ email: "a@test.com", company: "TestCo", firstName: "Alice" });
  const c2 = contactsDb.upsert({ email: "b@test.com", company: "TestCo", firstName: "Bob" });
  const c3 = contactsDb.upsert({ email: "c@test.com", company: "TestCo", firstName: "Charlie" });
  return { c1, c2, c3 };
}

// Test 1: 正常获取同公司联系人关系
{
  const { c1 } = setup();
  const r = crm.getRelations(c1.id);
  assert.ok(r.ok, "getRelations 应返回 ok");
  assert.ok(Array.isArray(r.data.nodes), "nodes 应是数组");
  assert.ok(Array.isArray(r.data.edges), "edges 应是数组");
  assert.ok(r.data.nodes.length >= 2, "至少应有 2 个同公司联系人");
  assert.ok(r.data.nodes.every(n => n.id && n.name), "每个 node 应有 id 和 name");
  console.log("PASS: getRelations 基本功能");
}

// Test 2: 无公司 → 返回空
{
  const c = contactsDb.upsert({ email: "solo@test.com", firstName: "Solo" });
  const r = crm.getRelations(c.id);
  assert.ok(r.ok);
  assert.strictEqual(r.data.nodes.length, 1, "无公司的联系人应只有自己");
  console.log("PASS: getRelations 无公司");
}

// Test 3: 响应被裁剪 → 不含 _extra
{
  const { c1 } = setup();
  const r = crm.getRelations(c1.id);
  for (const n of r.data.nodes) {
    assert.ok(!n._extra, "node 不应包含 _extra 字段");
    assert.ok(!n.tags, "node 不应包含 tags 字段");
  }
  console.log("PASS: getRelations 字段裁剪");

  // Cleanup
  getDb().exec("DELETE FROM contacts");
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/crm-relations.test.js
```

Expected: FAIL — `crm.getRelations` 未定义。

- [ ] **Step 3: 在 crm-service.js 新增 getRelations**

```js
function getRelations(contactId) {
  try {
    const contact = contactsDb.getById(contactId);
    if (!contact) return { ok: false, error: "联系人不存在" };
    if (!contact.company_id) {
      return { ok: true, data: { nodes: [{ id: contact.id, name: (contact.first_name||'')+' '+(contact.last_name||''), title: contact.title||'', email: contact.email||'', stage: contact.opp_stage||'', interactionCount: 0, isPrimary: true }], edges: [], truncated: false } };
    }

    const db = getDb();
    // 同公司联系人
    const rows = db.prepare(
      `SELECT id, first_name, last_name, title, email, opp_stage
       FROM contacts WHERE company_id = ? AND id != ? LIMIT 80`
    ).all(contact.company_id, contactId);

    const allRows = [contact, ...rows];
    const nodeIds = new Set(allRows.map(r => r.id));
    const MAX_NODES = 80;
    const truncated = allRows.length > MAX_NODES;

    // 统计互动次数
    const interactionCounts = {};
    for (const r of allRows) {
      try { interactionCounts[r.id] = interactionsDb.list({ contact_id: r.id, limit: 1000 }).length; } catch { interactionCounts[r.id] = 0; }
    }

    const nodes = allRows.map(r => ({
      id: r.id,
      name: [(r.first_name||''), (r.last_name||'')].filter(Boolean).join(' ') || r.email,
      title: r.title || '',
      email: r.email || '',
      stage: r.opp_stage || '',
      interactionCount: interactionCounts[r.id] || 0,
      isPrimary: r.id === contactId,
    }));

    // 边：同公司（所有对之间）
    const edges = [];
    for (let i = 0; i < allRows.length; i++) {
      for (let j = i + 1; j < allRows.length; j++) {
        edges.push({ source: allRows[i].id, target: allRows[j].id, type: 'company', label: '' });
      }
    }

    // 边：邮件关联（从 inbox matched_contacts 推导）
    if (contact.email) {
      try {
        const emailRows = db.prepare(
          `SELECT DISTINCT c.id FROM inbox
           JOIN contacts c ON lower(inbox.from_addr) = lower(c.email)
           WHERE c.company_id = ? AND inbox.matched_contacts IS NOT NULL
             AND instr(lower(inbox.matched_contacts), lower(?)) > 0 LIMIT 100`
        ).all(contact.company_id, contact.email.toLowerCase());
        for (const er of emailRows) {
          if (er.id !== contactId && nodeIds.has(er.id)) {
            const exists = edges.some(e => (e.source === contactId && e.target === er.id) || (e.source === er.id && e.target === contactId));
            if (!exists) edges.push({ source: contactId, target: er.id, type: 'email', label: '' });
          }
        }
      } catch (e) { Log.error("CRM关系网络", "邮件关联查询失败", e.stack); }
    }

    // 边：自定义关系
    const allExtras = {};
    for (const r of allRows) {
      try { allExtras[r.id] = typeof r._extra === 'string' ? JSON.parse(r._extra) : (r._extra || {}); } catch { allExtras[r.id] = {}; }
      if (!allExtras[r.id]) allExtras[r.id] = {};
    }
    let extra;
    try { extra = typeof contact._extra === 'string' ? JSON.parse(contact._extra) : (contact._extra || {}); } catch { extra = {}; }
    const relations = extra.relations || [];
    for (const rel of relations) {
      if (nodeIds.has(rel.targetId)) {
        edges.push({ source: contactId, target: rel.targetId, type: 'custom', label: rel.label || '', color: rel.color || '', category: rel.category || '' });
      }
    }
    // 也检查其他联系人指向当前的 custom 关系
    for (const r of allRows) {
      if (r.id === contactId) continue;
      let e;
      try { e = typeof r._extra === 'string' ? JSON.parse(r._extra) : (r._extra || {}); } catch { e = {}; }
      for (const rel of (e.relations || [])) {
        if (rel.targetId === contactId) {
          const exists = edges.some(ed => ed.type === 'custom' && ed.source === r.id && ed.target === contactId);
          if (!exists) edges.push({ source: r.id, target: contactId, type: 'custom', label: rel.label || '', color: rel.color || '', category: rel.category || '' });
        }
      }
    }

    // 过滤悬空 edge
    const validEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

    return { ok: true, data: { nodes, edges: validEdges, truncated } };
  } catch (e) {
    Log.error("CRM关系网络", "获取关系失败", e.stack);
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node tests/crm-relations.test.js
```

Expected: 3/3 PASS

- [ ] **Step 5: Commit**

```bash
git add electron/modules/services/crm-service.js tests/crm-relations.test.js
git commit -m "feat(crm): add getRelations service with company/email/custom edges"
```

---

### Task 3: Service 层 — saveRelation + deleteRelation

**Files:**
- Modify: `electron/modules/services/crm-service.js` (新增函数)
- Modify: `tests/crm-relations.test.js` (追加测试)

**Interfaces:**
- Produces:
  - `saveRelation(fromId, toId, label) → { ok, data }`
  - `deleteRelation(fromId, toId, label) → { ok, data }`

- [ ] **Step 1: 追加测试**

在 `tests/crm-relations.test.js` 末尾添加：

```js
// Test 4: saveRelation 创建关系
{
  const { c1, c2 } = setup();
  const r = crm.saveRelation(c1.id, c2.id, "决策人");
  assert.ok(r.ok, "saveRelation 应返回 ok");

  const rel = crm.getRelations(c1.id);
  const customEdges = rel.data.edges.filter(e => e.type === 'custom');
  assert.ok(customEdges.length >= 1, "应有至少 1 条自定义边");
  assert.strictEqual(customEdges[0].label, "决策人");
  console.log("PASS: saveRelation 创建");
}

// Test 5: saveRelation 去重
{
  const { c1, c2 } = setup();
  crm.saveRelation(c1.id, c2.id, "决策人");
  const r = crm.saveRelation(c1.id, c2.id, "决策人");
  assert.ok(r.ok, "不应报错");
  const rel = crm.getRelations(c1.id);
  const customEdges = rel.data.edges.filter(e => e.type === 'custom' && e.label === '决策人');
  assert.strictEqual(customEdges.length, 1, "去重：同标签不应重复");
  console.log("PASS: saveRelation 去重");
}

// Test 6: saveRelation 不能添加自己的关系
{
  const { c1 } = setup();
  const r = crm.saveRelation(c1.id, c1.id, "自己");
  assert.ok(!r.ok, "应返回 false");
  console.log("PASS: saveRelation 自己拒绝");
}

// Test 7: deleteRelation
{
  const { c1, c2 } = setup();
  crm.saveRelation(c1.id, c2.id, "测试删除");
  const r = crm.deleteRelation(c1.id, c2.id, "测试删除");
  assert.ok(r.ok);
  const rel = crm.getRelations(c1.id);
  const deleted = rel.data.edges.filter(e => e.type === 'custom' && e.label === '测试删除');
  assert.strictEqual(deleted.length, 0, "关系应被删除");
  console.log("PASS: deleteRelation");

  getDb().exec("DELETE FROM contacts");
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/crm-relations.test.js
```

Expected: PASS 1-3, FAIL 4-7 (saveRelation 未定义)

- [ ] **Step 3: 实现 saveRelation**

```js
function saveRelation(fromId, toId, label) {
  try {
    if (!fromId || !toId) return { ok: false, error: "缺少联系人 ID" };
    if (fromId === toId) return { ok: false, error: "不能添加与自己的关系" };
    if (!label || !label.trim()) return { ok: false, error: "关系标签不能为空" };

    const contact = contactsDb.getById(fromId);
    if (!contact) return { ok: false, error: "联系人不存在" };

    let extra = {};
    try { extra = typeof contact._extra === 'string' ? JSON.parse(contact._extra) : (contact._extra || {}); } catch { extra = {}; }
    if (!extra.relations) extra.relations = [];

    // 上限检查
    if (extra.relations.length >= 200) return { ok: false, error: "关系数量已达上限（200条）" };

    // 去重
    const exists = extra.relations.find(r => r.targetId === toId && r.label === label);
    if (exists) return { ok: true, data: { id: contact.id } };

    extra.relations.push({
      targetId: toId,
      label: label.trim(),
      category: "",
      color: "",
      createdAt: new Date().toISOString(),
    });

    contactsDb.update(fromId, { _extra: extra });
    Log.info("CRM关系网络", `添加关系: ${fromId} → ${toId} [${label}]`);
    return { ok: true, data: { id: contact.id } };
  } catch (e) {
    Log.error("CRM关系网络", "保存关系失败", e.stack);
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 4: 实现 deleteRelation**

```js
function deleteRelation(fromId, toId, label) {
  try {
    const contact = contactsDb.getById(fromId);
    if (!contact) return { ok: false, error: "联系人不存在" };

    let extra = {};
    try { extra = typeof contact._extra === 'string' ? JSON.parse(contact._extra) : (contact._extra || {}); } catch { extra = {}; }
    if (!extra.relations) return { ok: true, data: { id: contact.id } };

    const before = extra.relations.length;
    extra.relations = extra.relations.filter(r => !(r.targetId === toId && r.label === label));
    if (extra.relations.length === before) return { ok: true, data: { id: contact.id } }; // 没找到，静默

    contactsDb.update(fromId, { _extra: extra });
    Log.info("CRM关系网络", `删除关系: ${fromId} → ${toId} [${label}]`);
    return { ok: true, data: { id: contact.id } };
  } catch (e) {
    Log.error("CRM关系网络", "删除关系失败", e.stack);
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 5: 在 crm-service.js 导出**

```js
module.exports = { ..., getRelations, saveRelation, deleteRelation, ... };
```

- [ ] **Step 6: 跑测试确认全部通过**

```bash
node tests/crm-relations.test.js
```

Expected: 7/7 PASS

- [ ] **Step 7: Commit**

```bash
git add electron/modules/services/crm-service.js tests/crm-relations.test.js
git commit -m "feat(crm): add saveRelation and deleteRelation with dedup and validation"
```

---

### Task 4: 级联清理 — contacts-db remove()

**Files:**
- Modify: `electron/modules/services/contacts-db.js:230-240` (remove 函数)

- [ ] **Step 1: 在 remove 函数末尾添加级联清理**

Open `contacts-db.js`，在 `remove(id)` 函数的 `db.prepare("DELETE FROM contacts WHERE id = ?").run(id);` 之后，`Log.info` 之前添加：

```js
  // 级联清理：从同公司其他联系人的 _extra.relations 中移除指向该 ID 的条目
  try {
    const contact = getById(id);
    if (contact && contact.company_id) {
      const companyContacts = db.prepare("SELECT id, _extra FROM contacts WHERE company_id = ? AND id != ?").all(contact.company_id, id);
      for (const cc of companyContacts) {
        if (!cc._extra) continue;
        let extra;
        try { extra = typeof cc._extra === 'string' ? JSON.parse(cc._extra) : cc._extra; } catch { continue; }
        if (!extra.relations) continue;
        const before = extra.relations.length;
        extra.relations = extra.relations.filter(r => r.targetId !== id);
        if (extra.relations.length !== before) {
          db.prepare("UPDATE contacts SET _extra = ? WHERE id = ?").run(JSON.stringify(extra), cc.id);
        }
      }
    }
  } catch (e) { Log.error("DB", "级联清理关系失败", e.stack); }
```

- [ ] **Step 2: 验证**

```bash
node -e "
const db = require('./electron/modules/services/contacts-db');
const c1 = db.upsert({email:'x@t.com',company:'TCo'});
const c2 = db.upsert({email:'y@t.com',company:'TCo'});
db.update(c1.id, {_extra: {relations: [{targetId:c2.id,label:'test'}]}});
db.remove(c2.id);
const c1After = db.getById(c1.id);
const extra = JSON.parse(c1After._extra||'{}');
console.log(extra.relations?.length===0?'PASS':'FAIL', extra.relations?.length||0);
"
```

Expected: `PASS 0`

- [ ] **Step 3: Commit**

```bash
git add electron/modules/services/contacts-db.js
git commit -m "fix(db): cascade-clean relations when contact is deleted"
```

---

### Task 5: IPC Handler 注册

**Files:**
- Modify: `electron/modules/ipc/crm-ipc.js` (新增 3 个 handler)

- [ ] **Step 1: 在 crm-ipc.js 注册 handler**

在 `register` 函数内（现有 handler 之后）添加：

```js
  // ── 关系网络 ──
  ipcMain.handle('crm:getRelations', async (_e, contactId) => {
    if (!contactId || typeof contactId !== 'string') return { ok: false, error: "缺少 contactId" };
    return crmService.getRelations(contactId);
  });
  ipcMain.handle('crm:saveRelation', async (_e, { fromId, toId, label }) => {
    if (!fromId || typeof fromId !== 'string') return { ok: false, error: "缺少 fromId" };
    if (!toId || typeof toId !== 'string') return { ok: false, error: "缺少 toId" };
    return crmService.saveRelation(fromId, toId, label);
  });
  ipcMain.handle('crm:deleteRelation', async (_e, { fromId, toId, label }) => {
    if (!fromId || typeof fromId !== 'string') return { ok: false, error: "缺少 fromId" };
    if (!toId || typeof toId !== 'string') return { ok: false, error: "缺少 toId" };
    return crmService.deleteRelation(fromId, toId, label);
  });
```

- [ ] **Step 2: Verify**

```bash
node scripts/check.js
```

Expected: `✓ IPC 契约: preload.js 双向对齐`

- [ ] **Step 3: Commit**

```bash
git add electron/modules/ipc/crm-ipc.js
git commit -m "feat(ipc): register crm:getRelations/saveRelation/deleteRelation handlers"
```

---

### Task 6: 渲染层 — relationsTab + Tab 注册

**Files:**
- Modify: `electron/renderer/modules/crm-pipeline.js` (新增 tab + 渲染逻辑)
- Modify: `electron/renderer/styles.css` (新增样式)

- [ ] **Step 1: 在 openDetailPanel 中新增第 5 个 tab**

在 tab 按钮区域（约 line 330）,"邮件往来"之后添加：

```js
<button class="crm-tab${_currentTab==='relations'?' active':''}" data-tab="relations">关系网络</button>
```

在 tab content 区域（约 line 337），`data-content="emails"` 之后添加：

```js
<div class="crm-tab-content${_currentTab==='relations'?' active':''}" data-content="relations">${relationsTab(contactId)}</div>
```

- [ ] **Step 2: 添加 relationsTab 函数 + D3 渲染**

在 `closeDetailPanel` 之前添加完整实现（约 340 行）:

```js
// ── 关系网络渲染常量 ──
const NODE_RADIUS_MIN = 8, NODE_RADIUS_MAX = 20;
const NODE_LABEL_MAX_CHARS = 8;
const ACTIVE_NODE_STROKE_WIDTH = 3;
const EDGE_COMPANY_STROKE = '#d0d0d0', EDGE_COMPANY_WIDTH = 2;
const EDGE_EMAIL_STROKE = '#5c6bc0', EDGE_EMAIL_WIDTH = 1, EDGE_EMAIL_DASH = '4,3';
const EDGE_CUSTOM_STROKE = '#e6a817', EDGE_CUSTOM_WIDTH = 1.5, EDGE_CUSTOM_DASH = '6,3';
const SIMULATION_FORCE_STRENGTH = -300, SIMULATION_COLLIDE_RADIUS = 30;
const SIMULATION_STOP_AFTER_MS = 5000;
const ZOOM_EXTENT_MIN = 0.3, ZOOM_EXTENT_MAX = 3;
const TOOLTIP_SHOW_DELAY_MS = 240, TOOLTIP_HIDE_DELAY_MS = 150;
const STAGE_COLORS = { reaching:'#ff9800', quoting:'#2196f3', trial:'#8e24aa', cooperating:'#4caf50', lost:'#b0b0b0' };

let _simulation = null, _resizeObserver = null, _relationsCache = null;

function relationsTab(contactId) {
  if (!contactId) return '<div style="padding:20px;color:var(--text-secondary);text-align:center">请先选择联系人</div>';
  return `<div class="crm-relations-wrap" id="crm-relations-wrap">
    <div class="crm-relations-legend">
      <span><span style="display:inline-block;width:16px;border-top:2px solid ${EDGE_COMPANY_STROKE}"></span> 同公司</span>
      <span><span style="display:inline-block;width:16px;border-top:1px dashed ${EDGE_EMAIL_STROKE}"></span> 邮件关联</span>
      <span><span style="display:inline-block;width:16px;border-top:1.5px dashed ${EDGE_CUSTOM_STROKE}"></span> 自定义</span>
    </div>
    <svg class="crm-relations-svg" id="crm-relations-svg"></svg>
    <div class="crm-relations-hint" id="crm-relations-hint">右键节点可添加/删除关系</div>
  </div>`;
}

async function initRelationsGraph(contactId) {
  const wrap = document.getElementById('crm-relations-wrap');
  const svg = document.getElementById('crm-relations-svg');
  if (!wrap || !svg) return;

  // 检查缓存
  if (_relationsCache && _relationsCache.contactId === contactId) {
    const r = _relationsCache;
    renderSimulation(svg, wrap, r.nodes, r.edges);
    return;
  }

  const r = await window.electronAPI.crmGetRelations(contactId);
  if (!r.ok) {
    wrap.innerHTML = `<div style="padding:20px;color:var(--danger);text-align:center">加载失败: ${escapeHtml(r.error)}</div>`;
    return;
  }
  _relationsCache = { contactId, nodes: r.data.nodes, edges: r.data.edges };

  if (r.data.nodes.length <= 1) {
    wrap.innerHTML = '<div style="padding:20px;color:var(--text-secondary);text-align:center">该公司暂无其他联系人</div>';
    return;
  }

  renderSimulation(svg, wrap, r.data.nodes, r.data.edges);
  if (r.data.truncated) {
    const hint = document.getElementById('crm-relations-hint');
    if (hint) hint.textContent = '右键节点可添加/删除关系 · ⚠ 仅展示前 80 个联系人';
  }
}

function renderSimulation(svgEl, wrapEl, nodes, edges) {
  // 清理旧 simulation
  if (_simulation) { _simulation.stop(); _simulation = null; }
  if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }

  const box = wrapEl.getBoundingClientRect();
  const w = box.width || 400, h = box.height || 400;
  const cx = w / 2, cy = h / 2;

  // 动态 import D3
  if (!window._D3_FORCE || !window._D3_SELECTION || !window._D3_DRAG || !window._D3_ZOOM) {
    try {
      const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } = require('d3-force');
      const { select } = require('d3-selection');
      const { drag } = require('d3-drag');
      const { zoom } = require('d3-zoom');
      window._D3_FORCE = { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide };
      window._D3_SELECTION = { select };
      window._D3_DRAG = { drag };
      window._D3_ZOOM = { zoom };
    } catch (e) {
      Log.error("CRM关系网络", "D3 模块加载失败", e.stack);
      wrapEl.innerHTML = '<div style="padding:20px;color:var(--danger);text-align:center">图表组件加载失败，请重启应用</div>';
      return;
    }
  }
  const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } = window._D3_FORCE;
  const { select } = window._D3_SELECTION;
  const { drag: d3Drag } = window._D3_DRAG;
  const { zoom: d3Zoom } = window._D3_ZOOM;

  svgEl.innerHTML = '';
  const g = select(svgEl).append('g');

  // 缩放
  const zoomBehavior = d3Zoom().scaleExtent([ZOOM_EXTENT_MIN, ZOOM_EXTENT_MAX])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
      const scale = event.transform.k;
      g.selectAll('.node-label').style('display', scale < 0.5 ? 'none' : '');
    });
  select(svgEl).call(zoomBehavior);

  // 力导向
  const simEdges = edges.map(e => ({ ...e }));
  const simNodes = nodes.map(n => ({ ...n }));
  const maxInteractions = Math.max(1, ...nodes.map(n => n.interactionCount || 0));
  const rScale = d3.scaleLinear().domain([0, maxInteractions]).range([NODE_RADIUS_MIN, NODE_RADIUS_MAX]);

  const simulation = forceSimulation(simNodes)
    .force('link', forceLink(simEdges).id(d => d.id).distance(d => d.type === 'custom' ? 120 : d.type === 'email' ? 100 : 80))
    .force('charge', forceManyBody().strength(SIMULATION_FORCE_STRENGTH))
    .force('center', forceCenter(cx, cy))
    .force('collide', forceCollide(SIMULATION_COLLIDE_RADIUS));

  // 边
  const link = g.append('g').selectAll('line').data(simEdges).join('line')
    .attr('stroke', d => d.type === 'custom' ? (d.color || EDGE_CUSTOM_STROKE) : d.type === 'email' ? EDGE_EMAIL_STROKE : EDGE_COMPANY_STROKE)
    .attr('stroke-width', d => d.type === 'custom' ? EDGE_CUSTOM_WIDTH : d.type === 'email' ? EDGE_EMAIL_WIDTH : EDGE_COMPANY_WIDTH)
    .attr('stroke-dasharray', d => d.type === 'custom' ? EDGE_CUSTOM_DASH : d.type === 'email' ? EDGE_EMAIL_DASH : '')
    .attr('opacity', d => d.type === 'email' ? 0.3 : 1);

  // 边标签 (custom only)
  g.append('g').selectAll('text').data(simEdges.filter(e => e.type === 'custom')).join('text')
    .text(d => d.label).attr('font-size', '9px').attr('fill', d => d.color || EDGE_CUSTOM_STROKE)
    .attr('text-anchor', 'middle').attr('dy', '-4');

  // 节点
  const node = g.append('g').selectAll('g').data(simNodes).join('g')
    .call(d3Drag().filter(event => !event.ctrlKey && event.button === 0)
      .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append('circle')
    .attr('r', d => rScale(d.interactionCount || 0))
    .attr('fill', d => STAGE_COLORS[d.stage] || '#999')
    .attr('stroke', d => d.isPrimary ? '#fff' : 'none')
    .attr('stroke-width', d => d.isPrimary ? ACTIVE_NODE_STROKE_WIDTH : 0);

  node.append('text').text(d => (d.name || '').slice(0, NODE_LABEL_MAX_CHARS))
    .attr('font-size', '10px').attr('text-anchor', 'middle').attr('dy', d => rScale(d.interactionCount || 0) + 14)
    .attr('fill', 'var(--text)').attr('class', 'node-label');

  // 点击
  node.on('click', (_event, d) => {
    if (d.id === _currentDetailId) return;
    openDetailPanel(d.id);
  });

  // 右键
  node.on('contextmenu', (event, d) => showRelationsContextMenu(event, d, simNodes));

  // 悬停
  let _tooltipTimer;
  node.on('mouseenter', (event, d) => {
    clearTimeout(_tooltipTimer);
    _tooltipTimer = setTimeout(() => {
      let tip = document.getElementById('crm-node-tooltip');
      if (!tip) { tip = document.createElement('div'); tip.id = 'crm-node-tooltip'; tip.className = 'crm-node-tooltip'; document.body.appendChild(tip); }
      tip.innerHTML = `<div class="tt-name">${escapeHtml(d.name)}</div><div class="tt-meta">${escapeHtml(d.title||'')} · ${STAGE_LABELS[d.stage]||d.stage||'未分类'}</div>`;
      tip.style.display = 'block';
      const tr = document.querySelector('.crm-relations-svg').getBoundingClientRect();
      tip.style.left = (tr.left + event.offsetX + 12) + 'px';
      tip.style.top = (tr.top + event.offsetY - 40) + 'px';
      link.attr('opacity', e => (e.source.id === d.id || e.target.id === d.id) ? 1 : 0.1);
    }, TOOLTIP_SHOW_DELAY_MS);
  });
  node.on('mouseleave', () => {
    clearTimeout(_tooltipTimer);
    const tip = document.getElementById('crm-node-tooltip');
    if (tip) setTimeout(() => { if (tip) tip.style.display = 'none'; }, TOOLTIP_HIDE_DELAY_MS);
    link.attr('opacity', d => d.type === 'email' ? 0.3 : 1);
  });

  simulation.on('tick', () => {
    if (_currentTab !== 'relations') return;
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  _simulation = simulation;

  // 超时保护
  setTimeout(() => {
    if (_simulation === simulation && simulation.alpha() > 0.05) {
      simulation.stop();
      Log.warn("CRM关系网络", "力导向布局超时未收敛");
    }
  }, SIMULATION_STOP_AFTER_MS);

  // ResizeObserver
  _resizeObserver = new ResizeObserver(() => {
    clearTimeout(wrapEl._resizeDebounce);
    wrapEl._resizeDebounce = setTimeout(() => {
      if (_simulation && _currentTab === 'relations') {
        const b = wrapEl.getBoundingClientRect();
        simulation.force('center', forceCenter(b.width/2, b.height/2));
        simulation.alpha(Math.min(simulation.alpha(), 0.3)).restart();
      }
    }, 300);
  });
  _resizeObserver.observe(wrapEl);
}

function showRelationsContextMenu(event, nodeData, allNodes) {
  document.getElementById('ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.style.cssText = 'position:fixed;z-index:9999;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:140px;font-size:12px';

  const targetOptions = allNodes.filter(n => n.id !== nodeData.id).slice(0, 15)
    .map(n => `<div style="padding:4px 14px;cursor:pointer" data-action="add-rel" data-to="${escapeHtml(n.id)}">${escapeHtml(n.name)}</div>`).join('');

  menu.innerHTML = `
    <div style="padding:4px 14px;color:var(--text-secondary);font-size:10px">添加关联 →</div>
    <div style="max-height:200px;overflow-y:auto">${targetOptions}</div>
    <div style="border-top:1px solid var(--border);margin:4px 0"></div>
    <div style="padding:4px 14px;cursor:pointer" data-action="view-detail">查看详情</div>
  `;
  menu.style.left = event.clientX + 'px';
  menu.style.top = (event.clientY + 200 > window.innerHeight ? event.clientY - 200 : event.clientY) + 'px';

  menu.querySelectorAll('[data-action="add-rel"]').forEach(el => {
    el.addEventListener('click', async () => {
      const toId = el.dataset.to;
      const label = prompt('关系标签（如"决策人""对接窗口"）', '');
      if (!label) { menu.remove(); return; }
      const r = await window.electronAPI.crmSaveRelation(nodeData.id, toId, label);
      if (r.ok) {
        showToast('关系已添加', 'ok');
        _relationsCache = null;
        initRelationsGraph(_currentDetailId);
      } else {
        showToast(r.error || '保存失败', 'err');
      }
      menu.remove();
    });
  });
  menu.querySelector('[data-action="view-detail"]').addEventListener('click', () => {
    openDetailPanel(nodeData.id);
    menu.remove();
  });

  document.body.appendChild(menu);
  const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}
```

- [ ] **Step 2: 在 openDetailPanel 中调用 initRelationsGraph**

在 tab 切换逻辑中（约 line 342），新 relations tab 的点击处理：

```js
if (tab.dataset.tab === 'relations') {
  initRelationsGraph(contactId);
}
```

- [ ] **Step 3: 在 closeDetailPanel 中添加清理逻辑**

```js
if (_simulation) { _simulation.stop(); _simulation = null; }
if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
const svg = document.getElementById('crm-relations-svg');
if (svg) svg.innerHTML = '';
_relationsCache = null;
```

- [ ] **Step 4: 在 _currentTab 跟踪中添加 relations tab 切换保护**

在 `renderSimulation` 的 tick 中已有 `if (_currentTab !== 'relations') return;`

- [ ] **Step 5: 添加 CSS 样式**

在 `styles.css` 末尾添加：

```css
.crm-relations-wrap { display:flex; flex-direction:column; min-height:400px; }
.crm-relations-legend { display:flex; gap:12px; padding:4px 10px; font-size:10px; color:var(--text-secondary); border-bottom:1px solid var(--border); flex-shrink:0; }
.crm-relations-svg { flex:1; min-height:0; width:100%; }
.crm-relations-hint { padding:4px 10px; font-size:10px; color:var(--text-secondary); border-top:1px solid var(--border); flex-shrink:0; }
.crm-node-tooltip { position:fixed; pointer-events:none; z-index:9999; background:var(--card-bg); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:11px; box-shadow:0 2px 8px rgba(0,0,0,.1); max-width:200px; display:none; }
.crm-node-tooltip .tt-name { font-weight:600; }
.crm-node-tooltip .tt-meta { color:var(--text-secondary); font-size:10px; }
```

- [ ] **Step 6: Verify**

```bash
node scripts/check.js
```

Expected: `60 文件: 60 通过`

- [ ] **Step 7: Manual test**

启动应用，打开 CRM → 选择一个有同公司联系人的联系人 → 点击"关系网络"tab → 确认图渲染正常、节点可拖拽、可缩放

- [ ] **Step 8: Commit**

```bash
git add electron/renderer/modules/crm-pipeline.js electron/renderer/styles.css
git commit -m "feat(crm): add relations network tab with D3 force-directed graph"
```

---

### Task 7: Bump version + final check

- [ ] **Step 1: Bump version**

```bash
cd "E:\Agents Basement\projects\Prospecting Email"
# 修改 package.json version 从 3.1.6 → 3.2.0
```

- [ ] **Step 2: 最终验证**

```bash
node scripts/check.js && node tests/crm-relations.test.js
```

Expected: check 60 文件通过 + test 7/7 PASS

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 3.2.0 — contact relations network feature"
```

---

## Task Summary

| Task | 内容 | 预估耗时 |
|------|------|---------|
| 0 | npm install d3-* | 2 min |
| 1 | IPC 契约 + preload | 10 min |
| 2 | Service getRelations + test | 20 min |
| 3 | Service save/deleteRelation + test | 15 min |
| 4 | contacts-db 级联清理 | 10 min |
| 5 | IPC handler 注册 | 5 min |
| 6 | 渲染层 relationsTab + D3 + CSS | 30 min |
| 7 | Bump version + final check | 5 min |
| **Total** | | **~100 min** |
