// ── 模板引擎 IPC 处理器 ────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./config');
const { parseTemplateLibrary, applyOverrides, applyStageOverrides } = require('../template-engine');

function register(ipcMain, deps) {
  const overridesPath = path.join(APP_ROOT, 'data', 'template-overrides.json');
  const userTemplatesPath = path.join(APP_ROOT, 'data', 'user-templates.json');

  // ponytail: 用户模板 — 读/写 JSON 数组
  function readUserTemplates() {
    try { return fs.existsSync(userTemplatesPath) ? JSON.parse(fs.readFileSync(userTemplatesPath, 'utf-8')) : []; }
    catch { return []; }
  }
  function writeUserTemplates(data) {
    const dir = path.dirname(userTemplatesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(userTemplatesPath, JSON.stringify(data, null, 2));
  }

  function readOverrides() {
    try { return fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, 'utf-8')) : null; }
    catch { return null; }
  }
  function writeOverrides(data) {
    const dir = path.dirname(overridesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(overridesPath, JSON.stringify(data, null, 2));
  }

  ipcMain.handle('template:getLibrary', async () => {
    if (!deps.templateLib) {
      deps.templateLib = parseTemplateLibrary();
      const overrides = readOverrides();
      if (deps.templateLib && overrides) applyOverrides(deps.templateLib, overrides);
    }
    return deps.templateLib;
  });

  ipcMain.handle('template:getSubjects', async (_e, type) => {
    if (!deps.templateLib) deps.templateLib = parseTemplateLibrary();
    return deps.templateLib?.subjects?.[type] || { es: '', en: '' };
  });

  ipcMain.handle('template:saveOverrides', async (_e, overrides) => {
    writeOverrides(overrides);
    if (deps.templateLib) applyOverrides(deps.templateLib, overrides);
    return { ok: true };
  });

  ipcMain.handle('template:getOverrides', async () => readOverrides());

  ipcMain.handle('template:reload', async () => {
    deps.templateLib = parseTemplateLibrary();
    const overrides = readOverrides();
    if (deps.templateLib && overrides) applyOverrides(deps.templateLib, overrides);
    return { ok: true, totalHooks: deps.templateLib?.hooks?.length || 0 };
  });

  ipcMain.handle('template:applyStageOverrides', async (_e, stages, overridesStages) => {
    return applyStageOverrides(stages, overridesStages);
  });

  // ── 用户模板 CRUD ──────────────────────────────────────────────────
  ipcMain.handle('template:listUser', async () => readUserTemplates());

  ipcMain.handle('template:saveUser', async (_e, tpl) => {
    const list = readUserTemplates();
    const now = new Date().toISOString();
    if (tpl.id) {
      const idx = list.findIndex(t => t.id === tpl.id);
      if (idx >= 0) { list[idx] = { ...list[idx], ...tpl, updatedAt: now }; }
      else { tpl.id = 'ut-' + Date.now().toString(36); tpl.createdAt = now; tpl.updatedAt = now; list.push(tpl); }
    } else {
      tpl.id = 'ut-' + Date.now().toString(36);
      tpl.createdAt = now;
      tpl.updatedAt = now;
      list.push(tpl);
    }
    writeUserTemplates(list);
    return { ok: true, id: tpl.id };
  });

  ipcMain.handle('template:deleteUser', async (_e, id) => {
    const list = readUserTemplates().filter(t => t.id !== id);
    writeUserTemplates(list);
    return { ok: true };
  });
}

module.exports = { register };
