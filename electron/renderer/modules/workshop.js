const S = window.S;
import { lucide,showAlert,showConfirm,showToast,escapeHtml,populateSelect,initIcons,showModal,formatDate } from './shared.js';
import { assembleEmail } from './templates.js';

// ===== 模板编辑器 =====================================================

const typeIcons = { agent: lucide('globe',14), direct: lucide('building',14), unlabeled: lucide('help-circle',14) };

// ── 共用工具 ───────────────────────────────────────────────────────
export function updatePreview() { /* reserved for future live preview */ }

// 防抖自动保存 + 行内状态指示（仅目标输入框旁显示）
export async function autoSaveTemplate(saveFn, ta) {
  clearTimeout(S.tmplSaveTimer);
  const statusEl = ta?.parentElement?.querySelector('.ts-save-status');
  if (statusEl) { statusEl.textContent = '...'; statusEl.style.color = 'var(--warning)'; }
  S.tmplSaveTimer = setTimeout(async () => {
    try {
      await saveFn();
      if (statusEl) { statusEl.textContent = '✓'; statusEl.style.color = 'var(--success)'; }
    } catch (e) {
      if (statusEl) { statusEl.textContent = '✗'; statusEl.style.color = 'var(--danger)'; }
    }
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
  }, 800);
}


// ── 共用质量检查（stageEditor / arEditor 复用）─────────────────────
export function runQualityCheck(panel, spamWords, limits) {
  const lim = limits || { es: 150, pt: 155, en: 120 };
  const allAreas = panel.querySelectorAll('textarea');

  function wordCount(text) { return text.trim().split(/\s+/).filter(Boolean).length; }
  function hasSpam(text, lang) {
    const words = spamWords[lang] || [];
    const lower = text.toLowerCase();
    return words.filter(w => lower.includes(w.toLowerCase()));
  }

  const issues = [];
  allAreas.forEach(ta => {
    const lang = ta.classList.contains('ts-es') ? 'es' : ta.classList.contains('ts-pt') ? 'pt' : 'en';
    const limit = lim[lang] || 120;
    const text = ta.value;
    const wc = wordCount(text);
    const spam = hasSpam(text, lang);
    const row = ta.closest('.ts-row');
    const check = row?.querySelector('.ts-check');
    let status = '✅', tip = '';
    if (wc > limit) { status = '⚠️'; tip = `超字数 ${wc}/${limit}词`; issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} ${lang.toUpperCase()} 超字数 (${wc}/${limit})`); }
    if (spam.length) { status = status === '⚠️' ? '🚫⚠️' : '🚫'; tip = (tip ? tip + '、' : '') + '含垃圾词: ' + spam.slice(0,3).join(', '); issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} ${lang.toUpperCase()} 含垃圾词: ${spam.slice(0,3).join(', ')}`); }
    if (check) {
      check.textContent = status + ` ${wc}词`;
      if (tip) {
        // 更新已有的 tooltip 文本，或创建新的
        let tt = check.querySelector('.ts-tt');
        if (!tt) {
          tt = document.createElement('span');
          tt.className = 'ts-tt';
          tt.style.cssText = 'position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);padding:5px 10px;border-radius:4px;background:#333;color:#fff;font-size:11px;white-space:nowrap;pointer-events:none;z-index:99;box-shadow:0 2px 8px rgba(0,0,0,.2);display:none';
          check.style.cssText = 'position:relative;cursor:default';
          check.appendChild(tt);
        }
        tt.textContent = tip;
        if (!check._ttBound) {
          check._ttBound = true;
          check.addEventListener('mouseenter', () => { const t = check.querySelector('.ts-tt'); if (t) t.style.display = 'block'; });
          check.addEventListener('mouseleave', () => { const t = check.querySelector('.ts-tt'); if (t) t.style.display = 'none'; });
        }
      }
    }
  });

  // 组内重复检查
  const byGroup = {};
  allAreas.forEach(ta => {
    const langCls = ta.classList.contains('ts-es') ? 'es' : ta.classList.contains('ts-pt') ? 'pt' : 'en';
    const key = ta.closest('.tmpl-sentence')?.dataset.key + '/' + langCls;
    if (!byGroup[key]) byGroup[key] = [];
    byGroup[key].push({ ta, text: ta.value.trim() });
  });
  for (const [, group] of Object.entries(byGroup)) {
    const seen = new Map();
    group.forEach(({ ta, text }) => {
      if (!text) return;
      if (seen.has(text)) issues.push(`${ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent} 与 ${seen.get(text)} 重复`);
      else seen.set(text, ta.closest('.tmpl-sentence')?.querySelector('.ts-id')?.textContent);
    });
  }

  // 汇总报告
  const report = panel.querySelector('#quality-report') || document.getElementById('quality-report');
  if (!report) return issues;
  if (issues.length === 0) {
    report.innerHTML = `<div style="color:var(--success);padding:8px;background:#e8f5e9;border-radius:4px">${lucide('check-circle',14)} 全部通过 — 无字数超标、无垃圾词、无重复</div>
      <div style="margin-top:4px;font-size:10px;color:var(--text-secondary)">${lucide('lightbulb',10)} 句库去重以发送时序列记录为准 — 同一序列内不会重复选用相同编号的句子</div>`;
  } else {
    report.innerHTML = `<div style="color:var(--danger);padding:8px;background:#ffebee;border-radius:4px">${lucide('alert-circle',14)} ${issues.length} 个问题：<br>${issues.map(s => '· ' + s).join('<br>')}</div>
      <div style="margin-top:4px;font-size:10px;color:var(--text-secondary)">${lucide('lightbulb',10)} 句库去重以发送时序列记录为准 — 同一序列内不会重复选用相同编号的句子</div>`;
  }
  return issues;
}

export async function initTemplateEditor() {
  try {
    S.templateLib = await window.electronAPI.getTemplateLibrary();  // ponytail: 每次进入都重新加载，确保覆盖层生效
    if (!S.templateLib || !S.templateLib.hooks) {
      document.getElementById('tmpl-tree').innerHTML = '<p style="color:var(--danger);padding:12px">模板加载失败，请重启应用</p>';
      return;
    }
  } catch(e) {
    document.getElementById('tmpl-tree').innerHTML = '<p style="color:var(--danger);padding:12px">模板加载失败: ' + e.message + '</p>';
    return;
  }
  // 句库取值：支持按类型拆分的对象或旧版共享数组
  const pool = (key, type) => {
    const v = S.templateLib[key];
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return v[type] || Object.values(v)[0] || [];
  };

  // 初始化每阶段独立句库（始终从基础库全新深拷贝，然后应用保存的覆盖层）
  S.templateLib._stages = {};
  for (const type of Object.keys(S.TYPES)) {
    S.templateLib._stages[type] = {};
    for (const stage of S.STAGES) {
      S.templateLib._stages[type][stage] = {
        hooks: JSON.parse(JSON.stringify(pool('hooks', type))),
        pains: JSON.parse(JSON.stringify((S.templateLib.painPoints?.[S.PAIN_KEY[type]] || []))),
        proofs: JSON.parse(JSON.stringify((S.templateLib.proofs?.[S.PROOF_KEY[type]] || []))),
        ctas: JSON.parse(JSON.stringify(pool('ctas', type))),
        followups: JSON.parse(JSON.stringify((S.templateLib.followUps?.[stage] || []))),
      };
    }
  }
  // 应用保存的 _stages 覆盖层（用户对各阶段句子的修改）
  try {
    const overrides = await window.electronAPI.getTemplateOverrides();
    if (overrides?._stages) {
      S.templateLib._stages = await window.electronAPI.applyStageOverrides(
        S.templateLib._stages, overrides._stages
      );
    }
  } catch(e) { console.warn('应用模板覆盖层失败:', e); }
  buildTree();
}

// ── 持久化：将 _stages + subjects + AR 变体写入 data/template-overrides.json ──
export async function persistOverrides() {
  if (!S.templateLib) return;
  await window.electronAPI.saveTemplateOverrides({
    _stages: S.templateLib._stages,
    subjects: S.templateLib.subjects,
  });
}

export function buildTree() {
  const tree = document.getElementById('tmpl-tree');
  if (!tree) return;

  let html = '';

  // 主题行（独立项）
  html += `<li class="tn-top-item"><div class="tn-label" data-node="subjects">主题行</div></li>`;

  // 用户模板（独立项，紧跟主题行）
  html += `<li class="tn-top-item"><div class="tn-label" data-node="userTemplates">用户模板</div></li>`;

  // 三个客户类型下拉分组 — 默认收起
  for (const [type, label] of Object.entries(S.TYPES)) {
    html += `<li class="tn-folder">`;
    html += `<div class="tn-label tn-folder-title"><span class="tn-arrow">${lucide('chevron-right',14)}</span>${label}</div>`;
    html += `<ul class="tn-sublist">`;
    for (const stage of S.STAGES) {
      html += `<li class="tn-leaf"><div class="tn-label" data-node="${type}|${stage}">${S.STAGE_LABELS[stage]}</div></li>`;
    }
    html += `</ul></li>`;
  }

  // ── 工具区 ──
  html += `<li class="tn-divider"></li>`;
  html += `<li class="tn-leaf"><div class="tn-label" data-node="spam">${lucide('alert-circle',14)} 垃圾词黑名单</div></li>`;

  tree.innerHTML = html;

  // ponytail: 事件委托 — 绑定在 tree 上，innerHTML 重建后仍然有效
  if (!tree._delegated) {
    tree._delegated = true;
    tree.addEventListener('click', (e) => {
      const el = e.target.closest('.tn-label');
      if (!el) return;

      // 文件夹标题 → 折叠/展开
      const folder = el.closest('.tn-folder');
      if (folder && el === folder.querySelector(':scope > .tn-label')) {
        folder.classList.toggle('open');
        return;
      }

      // 编辑项 → 高亮并显示编辑器
      tree.querySelectorAll('.tn-label.active').forEach(a => a.classList.remove('active'));
      el.classList.add('active');
      const node = el.dataset.node;
      if (node === 'subjects') showSubjectEditor();
      else if (node === 'spam') showSpamEditor();
      else if (node === 'userTemplates') { try { showUserTemplateList(); } catch(err) { console.error('用户模板列表加载失败:', err); } }
      else showStageEditor(node);
    });
  }
}

export function showSubjectEditor() {
  const panel = document.getElementById('tmpl-edit');
  const subs = S.templateLib.subjects;
  panel.innerHTML = `<h3>${lucide('tag',16)} 主题行</h3>` + Object.entries(S.TYPES).map(([type, label]) => `
    <div class="tmpl-section"><h4>${label}</h4>
      <div class="tmpl-sentence">
        <span class="ts-id">ES</span><div class="ts-body"><span class="ts-lang">西语</span>
        <textarea data-type="${type}" data-lang="es">${escapeHtml(subs[type]?.es||'')}</textarea><span class="ts-save-status" style="font-size:11px;min-width:20px"></span></div>
      </div>
      <div class="tmpl-sentence">
        <span class="ts-id">PT</span><div class="ts-body"><span class="ts-lang">葡语</span>
        <textarea data-type="${type}" data-lang="pt">${escapeHtml(subs[type]?.pt||'')}</textarea><span class="ts-save-status" style="font-size:11px;min-width:20px"></span></div>
      </div>
      <div class="tmpl-sentence">
        <span class="ts-id">EN</span><div class="ts-body"><span class="ts-lang">英语</span>
        <textarea data-type="${type}" data-lang="en">${escapeHtml(subs[type]?.en||'')}</textarea><span class="ts-save-status" style="font-size:11px;min-width:20px"></span></div>
      </div>
    </div>
  `).join('');
  panel.querySelectorAll('textarea').forEach(ta => ta.addEventListener('input', function() {
    autoSaveTemplate(async () => {
      document.querySelectorAll('#tmpl-edit textarea').forEach(t => {
        const t2 = t.dataset.type, l2 = t.dataset.lang;
        if (S.templateLib.subjects[t2]) S.templateLib.subjects[t2][l2] = t.value;
      });
      await persistOverrides();
    }, this);
  }));
}

export function showStageEditor(node) {
  const [type, stage] = node.split('|');
  const stageData = S.templateLib._stages?.[type]?.[stage];
  if (!stageData) return;
  const panel = document.getElementById('tmpl-edit');

  const groups = [['hooks','Hook 破冰句'],['pains','Pain Point 痛点句'],['proofs','Proof 证明句（完整段落）'],['ctas','CTA 行动呼吁'],['followups','衔接句']];

  // 读垃圾词黑名单
  const spamWords = S.templateLib.spamWords || { es: [], en: [] };

  panel.innerHTML = `<h3>${typeIcons[type]} ${S.TYPES[type]} · ${S.STAGE_LABELS[stage]}</h3>` +
    groups.map(([key, title]) => {
      const items = stageData[key] || [];
      if (!items.length) return '';
      return `<div class="tmpl-section"><h4>${title}</h4>` + items.map((item, i) => `
        <div class="tmpl-sentence" data-key="${key}" data-index="${i}">
          <span class="ts-id">${escapeHtml(item.label || item.id)}${item.id.includes('-A') ? ' 🇦🇷' : ''}</span>
          <div class="ts-body">
            <div class="ts-row">
              <span class="ts-lang">ES</span>
              <span class="ts-check" data-lang="es"></span>
              <textarea class="ts-es">${escapeHtml(item.es||'')}</textarea>
              <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
            </div>
            <div class="ts-row">
              <span class="ts-lang">PT</span>
              <span class="ts-check" data-lang="pt"></span>
              <textarea class="ts-pt">${escapeHtml(item.pt||'')}</textarea>
              <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
            </div>
            <div class="ts-row">
              <span class="ts-lang">EN</span>
              <span class="ts-check" data-lang="en"></span>
              <textarea class="ts-en">${escapeHtml(item.en||'')}</textarea>
              <span class="ts-save-status" style="font-size:10px;min-width:20px"></span>
            </div>
          </div>
        </div>
      `).join('') + '</div>';
    }).join('') +
    `<div id="quality-report" style="margin-top:12px;font-size:12px"></div>`;

  // 共用质量检查 + 自动保存
  const allAreas = panel.querySelectorAll('textarea');
  allAreas.forEach(ta => ta.addEventListener('input', function() {
    runQualityCheck(panel, spamWords);
    autoSaveTemplate(async () => {
      panel.querySelectorAll('.tmpl-sentence').forEach(el => {
        const key = el.dataset.key, idx = parseInt(el.dataset.index);
        const es = el.querySelector('.ts-es')?.value || '';
        const pt = el.querySelector('.ts-pt')?.value || '';
        const en = el.querySelector('.ts-en')?.value || '';
        if (stageData[key] && stageData[key][idx]) {
          stageData[key][idx].es = es;
          stageData[key][idx].pt = pt;
          stageData[key][idx].en = en;
        }
      });
      await persistOverrides();
    }, this);
  }));
  runQualityCheck(panel, spamWords);
}

export function showSpamEditor() {
  const panel = document.getElementById('tmpl-edit');
  const words = S.templateLib.spamWords || { es: [], en: [] };

  panel.innerHTML = `<h3>${lucide('alert-circle',16)} 垃圾词黑名单</h3>
    <p style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">质量检查实时校验以下词汇，命中任一即标记 ${lucide('ban',12)}</p>
    <div class="tmpl-section"><h4><span style="color:var(--danger)">${lucide('x-circle',14)}</span> 西语禁止词（${words.es.length} 个）</h4>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${words.es.map(w => `<code style="font-size:11px;padding:2px 6px;border-radius:3px;background:#ffebee;color:var(--danger)">${escapeHtml(w)}</code>`).join('')}</div>
    </div>
    <div class="tmpl-section"><h4><span style="color:var(--danger)">${lucide('x-circle',14)}</span> 英语禁止词（${words.en.length} 个）</h4>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${words.en.map(w => `<code style="font-size:11px;padding:2px 6px;border-radius:3px;background:#ffebee;color:var(--danger)">${escapeHtml(w)}</code>`).join('')}</div>
    </div>
    <div class="tmpl-section"><h4><span style="color:var(--text-secondary)">${lucide('help-circle',14)}</span> 上下文规则</h4>
      <div class="spam-rule context"><span class="sr-word">船东名 + 具体运价数字</span><span class="sr-reason">同一封邮件不能同时出现</span></div>
      <div class="spam-rule context"><span class="sr-word">本地仓库 / 本地团队</span><span class="sr-reason">代理模板禁止提及</span></div>
      <div class="spam-rule context"><span class="sr-word">digital / AI / 平台 / technology</span><span class="sr-reason">对海外客户禁用技术词汇</span></div>
    </div>
    <p style="font-size:11px;color:var(--text-secondary);margin-top:12px">修改词库请编辑 templates/general-templates.md 中的「广告词 & 垃圾词黑名单」章节</p>`;
}

// ── 📁 用户模板管理 ──────────────────────────────────────────────────
const USER_TEMPLATE_TYPES = { agent: '代理', direct: '直客', unlabeled: '未标签', general: '通用' };
const USER_TEMPLATE_STAGES = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', general: '通用' };
const USER_TEMPLATE_LANGS = { es: 'ES', pt: 'PT', general: '通用' };

export async function showUserTemplateList() {
  const panel = document.getElementById('tmpl-edit');
  if (!panel) return;
  // ponytail: 立即渲染骨架，避免异步期间面板无反应
  panel.innerHTML = '<h3>用户模板</h3><p style="color:var(--text-secondary);font-size:12px;padding:12px">加载中...</p>';
  try {
  const templates = await window.electronAPI.listUserTemplates().catch(() => []);

  let html = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
    <h3 style="margin:0">用户模板 (${templates.length})</h3>
    <button id="btn-user-tpl-new" style="font-size:12px;padding:4px 12px">+ 新建模板</button>
  </div>`;

  if (!templates.length) {
    html += '<p style="color:var(--text-secondary);font-size:12px;padding:12px">暂无用户模板，点击「新建模板」创建你的第一封邮件模板。</p>';
  } else {
    for (const t of templates) {
      const typeLabel = USER_TEMPLATE_TYPES[t.type] || t.type;
      const stageLabel = USER_TEMPLATE_STAGES[t.stage] || t.stage;
      const langLabel = USER_TEMPLATE_LANGS[t.lang] || t.lang;
      html += `<div class="user-tpl-card" style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.name || '未命名')}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px">
            <span style="margin-right:8px">${typeLabel}</span>
            <span style="margin-right:8px">${stageLabel}</span>
            <span>${langLabel}</span>
            <span style="margin-left:8px;color:var(--text-secondary)">${t.updatedAt ? formatDate(t.updatedAt) : ''}</span>
          </div>
        </div>
        <button class="btn-user-tpl-edit secondary" data-id="${t.id}" style="font-size:10px;padding:2px 8px">✏️</button>
        <button class="btn-user-tpl-del secondary" data-id="${t.id}" style="font-size:10px;padding:2px 8px;color:var(--danger)">${lucide('trash-2',12)}</button>
      </div>`;
    }
  }

  panel.innerHTML = html;

  // 绑定事件
  document.getElementById('btn-user-tpl-new')?.addEventListener('click', () => showUserTemplateEditor(null));
  panel.querySelectorAll('.btn-user-tpl-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = templates.find(x => x.id === btn.dataset.id);
      if (t) showUserTemplateEditor(t);
    });
  });
  panel.querySelectorAll('.btn-user-tpl-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirm('确定删除此模板？')) return;
      await window.electronAPI.deleteUserTemplate(btn.dataset.id);
      showUserTemplateList(); // 刷新列表
    });
  });
  } catch(e) { console.error('showUserTemplateList 异常:', e); }
}

export function showUserTemplateEditor(tpl) {
  const panel = document.getElementById('tmpl-edit');
  const isNew = !tpl;
  const isEdit = !!tpl;
  tpl = tpl || { name: '', type: '', stage: '', lang: '', subject: '', body: '' };

  panel.innerHTML = `
    <h3 style="margin-bottom:12px">${isEdit ? '编辑：' + escapeHtml(tpl.name) : '新建用户模板'}</h3>
    <div class="form-group"><label>模板名称 <span style="color:var(--danger)">*</span></label><input type="text" id="ut-name" value="${escapeHtml(tpl.name)}" placeholder="如：阿根廷直客冷开发"></div>
    <div style="display:flex;gap:12px">
      <div class="form-group" style="flex:1"><label>客户类型 <span style="color:var(--danger)">*</span></label>
        <select id="ut-type"><option value="">— 请选择 —</option>${Object.entries(USER_TEMPLATE_TYPES).map(([k,v]) => `<option value="${k}"${tpl.type===k?' selected':''}>${v}</option>`).join('')}</select>
      </div>
      <div class="form-group" style="flex:1"><label>开发阶段 <span style="color:var(--danger)">*</span></label>
        <select id="ut-stage"><option value="">— 请选择 —</option>${Object.entries(USER_TEMPLATE_STAGES).map(([k,v]) => `<option value="${k}"${tpl.stage===k?' selected':''}>${v}</option>`).join('')}</select>
      </div>
      <div class="form-group" style="flex:1"><label>语言 <span style="color:var(--danger)">*</span></label>
        <select id="ut-lang"><option value="">— 请选择 —</option>${Object.entries(USER_TEMPLATE_LANGS).map(([k,v]) => `<option value="${k}"${tpl.lang===k?' selected':''}>${v}</option>`).join('')}</select>
      </div>
    </div>
    <div class="form-group"><label>主题 <span style="color:var(--danger)">*</span></label><input type="text" id="ut-subject" value="${escapeHtml(tpl.subject)}" placeholder="邮件主题，可选用 {{company}}"></div>
    <div class="form-group"><label>正文 <span style="color:var(--danger)">*</span></label><textarea id="ut-body" rows="14" style="width:100%;font-size:13px;padding:8px;border:1px solid var(--border);border-radius:4px;resize:vertical;font-family:Arial,sans-serif;line-height:1.6" placeholder="在此粘贴或输入邮件正文...">${escapeHtml(tpl.body)}</textarea></div>
    <p style="font-size:10px;color:var(--text-secondary);margin:4px 0">${lucide('lightbulb',10)} 在正文中写 <code>{{company}}</code>，发信时自动替换为客户公司名。支持粘贴富文本但仅保留纯文字格式。</p>

    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="btn-ut-save" style="font-size:13px;padding:6px 20px">💾 保存</button>
      ${isEdit ? '<button id="btn-ut-delete" class="danger" style="font-size:13px;padding:6px 20px">' + lucide('trash-2',12) + ' 删除</button>' : ''}
      <button id="btn-ut-cancel" class="secondary" style="font-size:13px;padding:6px 20px">取消</button>
    </div>`;

  // 保存
  document.getElementById('btn-ut-save')?.addEventListener('click', async () => {
    const data = {
      id: tpl.id || null,
      name: document.getElementById('ut-name')?.value.trim() || '',
      type: document.getElementById('ut-type')?.value || '',
      stage: document.getElementById('ut-stage')?.value || '',
      lang: document.getElementById('ut-lang')?.value || '',
      subject: document.getElementById('ut-subject')?.value.trim() || '',
      body: document.getElementById('ut-body')?.value || '',
    };
    // 逐项检查空值
    const emptyFields = [];
    if (!data.name) emptyFields.push('模板名称');
    if (!data.type) emptyFields.push('客户类型');
    if (!data.stage) emptyFields.push('开发阶段');
    if (!data.lang) emptyFields.push('语言');
    if (!data.subject) emptyFields.push('主题');
    if (!data.body.trim()) emptyFields.push('正文');
    if (emptyFields.length) { await showAlert('请填写：' + emptyFields.join('、')); return; }
    try {
      const result = await window.electronAPI.saveUserTemplate(data);
      if (result.ok) showToast('模板已保存', 'ok');
      else showToast('保存失败', 'err');
    } catch (e) { showToast('保存异常: ' + (e.message || '未知'), 'err'); }
    showUserTemplateList();
  });

  // 删除
  document.getElementById('btn-ut-delete')?.addEventListener('click', async () => {
    if (!await showConfirm('确定删除此模板？此操作不可撤销。')) return;
    await window.electronAPI.deleteUserTemplate(tpl.id);
    showToast('已删除', 'ok');
    showUserTemplateList();
  });

  // 取消
  document.getElementById('btn-ut-cancel')?.addEventListener('click', () => showUserTemplateList());
}

export async function initSignature() {
  // 从 send/signature.html 加载
  const result = await window.electronAPI.loadSignature();
  const editor = document.getElementById('sig-content');
  const preview = document.getElementById('sig-preview');
  if (editor && result.ok) editor.innerHTML = result.html;
  if (preview && result.ok) preview.innerHTML = result.html;

  // 实时预览
  if (editor) {
    editor.addEventListener('input', () => {
      if (preview) preview.innerHTML = editor.innerHTML;
    });
  }
}

document.getElementById('sig-open-folder')?.addEventListener('click', () => {
  window.electronAPI.openSendFolder();
});

document.getElementById('sig-save')?.addEventListener('click', async () => {
  const html = document.getElementById('sig-content')?.innerHTML || '';
  const result = await window.electronAPI.saveSignature(html);
  if (result.ok) showToast('签名已保存', 'ok'); else showToast('签名保存失败', 'err');
});


export function populateCTA() {
  const sel = document.getElementById('ws-cta');
  if (!sel || !S.templateLib) return;
  const ctas = S.templateLib.ctas;
  const list = Array.isArray(ctas) ? ctas : Object.values(ctas).flat();
  sel.innerHTML = list.map(c => `<option value="${c.id}">${c.id}: ${truncate(c.es, 50)}</option>`).join('');
}

export function updatePainProofOptions() {
  // 旧版 Workshop 函数，已废弃 — 保留空壳防止引用报错
}

window.__pageHandlers['template-editor'] = initTemplateEditor;
window.__pageHandlers['signature'] = initSignature;
