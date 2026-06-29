// ── 仪表盘编辑器：拖拽 + 缩放 + 辅助线 + 5px 网格吸附 ─────────────────
const GRID = 5;               // px，正方形网格
const GAP = 10;
const SNAP = 5;               // 吸附阈值
const ALIGN = 3;              // 对齐阈值
const MIN_W = 120, MIN_H = 60;
const STORAGE_KEY = 'dashboard-layout';
const RESIZE_HANDLES = ['nw','n','ne','e','se','s','sw','w'];
const LAYOUT_VERSION = 4;

// 预设布局：x, y, w, h 均为像素值（基于 ~1000px 宽容器）
const W = 998;
const DEFAULT_LAYOUT = {
  version: LAYOUT_VERSION, refWidth: W, gap: GAP,
  cards: {
    'stat-sent':       { x:0,   y:0,   w:235, h:135 },
    'stat-remaining':  { x:240, y:0,   w:235, h:135 },
    'stat-queue':      { x:480, y:0,   w:245, h:135 },
    'stat-smtp':       { x:730, y:0,   w:265, h:135 },
    'dash-progress':   { x:0,   y:140, w:995, h:75  },
    'dash-reply-rate': { x:0,   y:220, w:325, h:78  },
    'dash-bounce-rate':{ x:330, y:220, w:325, h:78  },
    'dash-window':     { x:660, y:220, w:335, h:80  },
    'dash-feed':       { x:0,   y:305, w:655, h:135 },
    'stat-new':        { x:660, y:305, w:335, h:135 },
  }
};

let _editing = false;
let _layout = null;
let _saveBtn = null;

// ── 公开 API ────────────────────────────────────────────────────────────────

export function isEditing() { return _editing; }

export function getLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.version === LAYOUT_VERSION) return saved;
  } catch {}
  return null;
}

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(_layout)); }

export function syncCards() {
  if (_editing) return;
  _layout = getLayout() || scaleLayout(DEFAULT_LAYOUT);
  applyLayout(_layout);
}

// ── 布局缩放：参考宽度 960px → 当前容器宽度 ─────────────────────────────

function scaleLayout(layout) {
  const canvas = document.getElementById('dash-canvas');
  const cw = canvas ? canvas.clientWidth : 960;
  const scale = cw / (layout.refWidth || W);
  const cards = {};
  for (const [id, c] of Object.entries(layout.cards)) {
    cards[id] = {
      x:  Math.round(c.x  * scale / GRID) * GRID,
      y:  Math.round(c.y  * scale),
      w:  Math.round(c.w  * scale / GRID) * GRID,
      h:  Math.round(c.h  * scale),
    };
  }
  return { version: LAYOUT_VERSION, refWidth: cw, gap: layout.gap, cards };
}

// ── 应用布局（正常模式）────────────────────────────────────────────────────

function applyLayout(layout) {
  const canvas = document.getElementById('dash-canvas');
  if (!canvas) return;

  // 提取卡片，去掉 wrapper
  const fixedEl = canvas.querySelector('[data-fixed]');
  const allCards = canvas.querySelectorAll('[data-card-id]:not([data-fixed])');
  if (fixedEl) fixedEl.remove();

  const cardMap = {};
  allCards.forEach(el => {
    cardMap[el.dataset.cardId] = el;
    if (el.parentElement !== canvas) canvas.appendChild(el);
  });
  canvas.querySelectorAll('.stats-grid, .dash-row').forEach(w => {
    if (!w.querySelector('[data-card-id]')) w.remove();
  });
  if (fixedEl) canvas.appendChild(fixedEl);

  // 容器设置相对定位
  canvas.style.display = 'block';
  canvas.style.position = 'relative';
  const maxY = Math.max(...Object.values(layout.cards).map(c => c.y + c.h), 0);
  canvas.style.minHeight = (maxY + 60 + layout.gap) + 'px';

  // 放置卡片
  Object.entries(layout.cards).forEach(([id, c]) => {
    const el = cardMap[id];
    if (!el) return;
    el.style.position = 'absolute';
    el.style.left   = c.x + 'px';
    el.style.top    = c.y + 'px';
    el.style.width  = c.w + 'px';
    el.style.height = c.h + 'px';
    el.style.margin = '0';
    el.style.gridColumn = '';
    el.style.gridRow = '';
  });

  // 固定按钮条
  if (fixedEl) {
    fixedEl.style.position = 'absolute';
    fixedEl.style.left = '0';
    fixedEl.style.top = maxY + layout.gap + 'px';
    fixedEl.style.width = '100%';
  }
}

// ── 编辑模式 ────────────────────────────────────────────────────────────────

export function toggleEdit() { _editing ? exitEdit() : enterEdit(); }

function enterEdit() {
  if (_editing) return;
  _editing = true;
  const dash = document.getElementById('page-dashboard');
  const canvas = document.getElementById('dash-canvas');
  if (!dash || !canvas) return;
  dash.classList.add('dash-editing');

  _layout = getLayout() || scaleLayout(DEFAULT_LAYOUT);

  const cards = canvas.querySelectorAll('[data-card-id]:not([data-fixed])');
  cards.forEach(card => {
    // 已经是 absolute，直接加手柄 + 事件
    card._origLeft = card.offsetLeft;
    card._origTop  = card.offsetTop;
    card._origW    = card.offsetWidth;
    card._origH    = card.offsetHeight;

    RESIZE_HANDLES.forEach(dir => {
      const h = document.createElement('div');
      h.className = 'dash-resize-handle ' + dir;
      h.dataset.handle = dir;
      card.appendChild(h);
    });
    card.addEventListener('pointerdown', onDragStart);
  });

  _saveBtn = document.getElementById('dash-edit-toggle');
  if (_saveBtn) { _saveBtn.textContent = '完成编辑'; _saveBtn.classList.add('active'); }
}

function exitEdit(saveFlag = true) {
  if (!_editing) return;
  _editing = false;
  const dash = document.getElementById('page-dashboard');
  const canvas = document.getElementById('dash-canvas');
  if (!dash || !canvas) return;
  dash.classList.remove('dash-editing');

  const cards = canvas.querySelectorAll('[data-card-id]:not([data-fixed])');

  if (saveFlag) {
    const newCards = {};
    cards.forEach(card => {
      newCards[card.dataset.cardId] = {
        x: card.offsetLeft, y: card.offsetTop,
        w: card.offsetWidth, h: card.offsetHeight,
      };
    });
    _layout = { version: LAYOUT_VERSION, refWidth: canvas.clientWidth, gap: GAP, cards: resolveOverlaps(newCards) };
    save();
  }

  cards.forEach(card => {
    card.removeEventListener('pointerdown', onDragStart);
    card.querySelectorAll('.dash-resize-handle').forEach(h => h.remove());
  });

  applyLayout(_layout);
  removeGuides();

  if (_saveBtn) { _saveBtn.textContent = '编辑布局'; _saveBtn.classList.remove('active'); }
  if (window.__pageHandlers?.dashboard) window.__pageHandlers.dashboard();
}

export function resetLayout() {
  _layout = scaleLayout(DEFAULT_LAYOUT);
  save();
  applyLayout(_layout);
  if (!_editing && window.__pageHandlers?.dashboard) window.__pageHandlers.dashboard();
}

// ── 拖拽 ────────────────────────────────────────────────────────────────────

let _dragCard = null, _dragSX = 0, _dragSY = 0, _dragOX = 0, _dragOY = 0;
let _ghost = null;

function onDragStart(e) {
  if (e.target.dataset.handle) return;
  const card = e.currentTarget;
  e.preventDefault();
  card.setPointerCapture(e.pointerId);
  _dragCard = card;
  _dragSX = e.clientX; _dragSY = e.clientY;
  _dragOX = card.offsetLeft; _dragOY = card.offsetTop;

  const canvas = document.getElementById('dash-canvas');
  _ghost = document.createElement('div');
  _ghost.className = 'dash-card-ghost';
  _ghost.style.cssText = `left:${_dragOX}px;top:${_dragOY}px;width:${card.offsetWidth}px;height:${card.offsetHeight}px`;
  canvas.appendChild(_ghost);
  card.classList.add('dash-card-dragging');
  card.addEventListener('pointermove', onDragMove);
  card.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e) {
  if (!_dragCard) return;
  let nx = _dragOX + e.clientX - _dragSX;
  let ny = _dragOY + e.clientY - _dragSY;

  const canvas = document.getElementById('dash-canvas');
  nx = Math.max(0, Math.min(nx, canvas.clientWidth - _dragCard.offsetWidth));
  ny = Math.max(0, ny);
  nx = Math.round(nx / GRID) * GRID;
  ny = Math.round(ny / GRID) * GRID;

  _dragCard.style.transform = `translate(${nx - _dragOX}px, ${ny - _dragOY}px)`;

  const moving = getEdges(_dragCard, nx, ny);
  renderGuides(detectAlignments(moving, _dragCard.dataset.cardId));
}

function onDragEnd(e) {
  if (!_dragCard) return;
  _dragCard.removeEventListener('pointermove', onDragMove);
  _dragCard.removeEventListener('pointerup', onDragEnd);
  _dragCard.classList.remove('dash-card-dragging');

  let nx = _dragOX + e.clientX - _dragSX;
  let ny = _dragOY + e.clientY - _dragSY;

  const moving = getEdges(_dragCard, nx, ny);
  for (const a of detectAlignments(moving, _dragCard.dataset.cardId)) {
    if (a.movingEdge === 'left')   nx = a.stationaryPos;
    if (a.movingEdge === 'right')  nx = a.stationaryPos - _dragCard.offsetWidth;
    if (a.movingEdge === 'top')    ny = a.stationaryPos;
    if (a.movingEdge === 'bottom') ny = a.stationaryPos - _dragCard.offsetHeight;
  }
  const canvas = document.getElementById('dash-canvas');
  const cw = canvas.clientWidth;
  nx = Math.max(0, Math.min(nx, cw - _dragCard.offsetWidth));
  ny = Math.max(0, ny);
  nx = Math.round(nx / GRID) * GRID;
  ny = Math.round(ny / GRID) * GRID;

  _dragCard.style.transform = '';
  _dragCard.style.left = nx + 'px';
  _dragCard.style.top  = ny + 'px';
  removeGuides();
  if (_ghost) { _ghost.remove(); _ghost = null; }
  _dragCard = null;
}

// ── 缩放 ────────────────────────────────────────────────────────────────────

let _rs = null;

document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('.dash-resize-handle');
  if (!h || !_editing) return;
  e.preventDefault(); e.stopPropagation();
  const card = h.parentElement;
  _rs = {
    card, dir: h.dataset.handle,
    sx: e.clientX, sy: e.clientY,
    ol: card.offsetLeft, ot: card.offsetTop,
    ow: card.offsetWidth, oh: card.offsetHeight,
  };
  card.setPointerCapture(e.pointerId);
  card.addEventListener('pointermove', onResizeMove);
  card.addEventListener('pointerup', onResizeEnd);
});

function onResizeMove(e) {
  if (!_rs) return;
  const dx = e.clientX - _rs.sx, dy = e.clientY - _rs.sy;
  let L = _rs.ol, T = _rs.ot, W = _rs.ow, H = _rs.oh;
  const d = _rs.dir;

  if (d.includes('e')) W = Math.max(MIN_W, _rs.ow + dx);
  if (d.includes('w')) { W = Math.max(MIN_W, _rs.ow - dx); L = _rs.ol + _rs.ow - W; }
  if (d.includes('s')) H = Math.max(MIN_H, _rs.oh + dy);
  if (d.includes('n')) { H = Math.max(MIN_H, _rs.oh - dy); T = _rs.ot + _rs.oh - H; }

  const cw = document.getElementById('dash-canvas').clientWidth;
  W = Math.max(MIN_W, Math.min(W, cw - L));
  W = Math.round(W / GRID) * GRID; L = Math.max(0, Math.round(L / GRID) * GRID);
  H = Math.round(H / GRID) * GRID; T = Math.max(0, Math.round(T / GRID) * GRID);

  _rs.card.style.left   = L + 'px';
  _rs.card.style.top    = T + 'px';
  _rs.card.style.width  = W + 'px';
  _rs.card.style.height = H + 'px';

  renderGuides(detectAlignments(getEdges(_rs.card), _rs.card.dataset.cardId));
}

function onResizeEnd(e) {
  if (!_rs) return;
  _rs.card.removeEventListener('pointermove', onResizeMove);
  _rs.card.removeEventListener('pointerup', onResizeEnd);
  removeGuides();
  _rs = null;
}

// ── 对齐 ────────────────────────────────────────────────────────────────────

function getEdges(card, ox, oy) {
  const l = ox ?? card.offsetLeft, t = oy ?? card.offsetTop;
  return { left: l, centerX: l + card.offsetWidth/2, right: l + card.offsetWidth,
           top: t,  centerY: t + card.offsetHeight/2, bottom: t + card.offsetHeight };
}

function detectAlignments(moving, movingId) {
  const canvas = document.getElementById('dash-canvas');
  const others = canvas.querySelectorAll('[data-card-id]:not([data-fixed])');
  const r = [];
  others.forEach(o => {
    if (o.dataset.cardId === movingId) return;
    const se = getEdges(o);
    for (const me of ['left','centerX','right','top','centerY','bottom']) {
      for (const oe of ['left','centerX','right','top','centerY','bottom']) {
        if ((me[0]==='l'||me[0]==='c'||me[0]==='r') !== (oe[0]==='l'||oe[0]==='c'||oe[0]==='r')) continue;
        if (Math.abs(moving[me] - se[oe]) <= ALIGN) r.push({ movingEdge:me, stationaryEdge:oe, movingPos:moving[me], stationaryPos:se[oe] });
      }
    }
  });
  return r;
}

// ── 辅助线 ──────────────────────────────────────────────────────────────────

let _guides = [];

function renderGuides(alignments) {
  removeGuides();
  const canvas = document.getElementById('dash-canvas');
  const rect = canvas.getBoundingClientRect();
  const seen = new Set();
  for (const a of alignments) {
    const key = (a.movingEdge[0]==='l'||a.movingEdge[0]==='r'||a.movingEdge[0]==='c'?'v':'h') + a.stationaryPos;
    if (seen.has(key)) continue; seen.add(key);
    const g = document.createElement('div'); g.className = 'dash-guide-line';
    if (a.movingEdge[0]==='l'||a.movingEdge[0]==='r'||a.movingEdge[0]==='c') {
      g.style.cssText = `left:${a.stationaryPos}px;top:0;width:1px;height:${rect.height}px`;
    } else {
      g.style.cssText = `top:${a.stationaryPos}px;left:0;height:1px;width:${rect.width}px`;
    }
    canvas.appendChild(g); _guides.push(g);
  }
}

function removeGuides() { _guides.forEach(g => g.remove()); _guides = []; }

// ── 重叠消解 ────────────────────────────────────────────────────────────────

function resolveOverlaps(cards) {
  const entries = Object.entries(cards).sort((a,b) => a[1].y - b[1].y || a[1].x - b[1].x);
  const result = {};
  for (const [id, c] of entries) {
    let { x, y, w, h } = c;
    let again = true;
    while (again) {
      again = false;
      for (const [, p] of Object.entries(result)) {
        if (x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y) {
          y = p.y + p.h; again = true; break;
        }
      }
    }
    result[id] = { x, y, w, h };
  }
  return result;
}

// ── 初始化 ──────────────────────────────────────────────────────────────────

export function init() {
  const btn = document.getElementById('dash-edit-toggle');
  if (btn) btn.addEventListener('click', toggleEdit);
  _layout = getLayout() || scaleLayout(DEFAULT_LAYOUT);
  applyLayout(_layout);
}
