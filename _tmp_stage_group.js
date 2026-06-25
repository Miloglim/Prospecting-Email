const fs = require('fs');
const p = require('path').join(__dirname, 'electron', 'renderer', 'app.js');
let s = fs.readFileSync(p, 'utf8');

// Find the active view rendering block and replace it
const oldBlock = `  container.innerHTML = visible.map(([name, members]) => {
    const ctype = members[0]?.clientType || 'unlabeled';
    const tagHtml = clientTypeTag(ctype);
    const ctry = escapeHtml(members[0]?.country || '');
    const hist = sendHistory[name];
    const stageLabel = hist?.stage ? \`<span class="sci-stage">\${STAGE_LABELS_SEND[hist.stage]}</span>\` : '';
    const vipClass = members.length >= 5 ? ' ci-vip' : '';
    const startedStr = hist?.startedAt ? \`📅 \${formatDate(hist.startedAt)}\` : '';
    const daysStr = hist?.startedAt ? \`<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">\${daysSince(hist.startedAt)}</span>\` : '';
    const archivedStr = hist?.archivedAt ? \`📦 \${formatDate(hist.archivedAt)}\` : '';

    if (isArchivedView) {
      const subParts = [tagHtml, ctry, startedStr, archivedStr].filter(Boolean);
      return \`<div class="send-company-item archived" data-company="\${escapeHtml(name)}" style="opacity:.7">
        <div class="sci-info">
          <span class="ci-name\${vipClass}">📦 \${escapeHtml(name)}\${daysStr}</span>
          \${subParts.length ? \`<span class="sci-sub">\${subParts.join(' · ')}</span>\` : ''}
        </div>
        <button class="btn-reactivate-send" data-company="\${escapeHtml(name)}" style="font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--success);background:transparent;color:var(--success);cursor:pointer;white-space:nowrap">🔄 重新激活</button>
      </div>\`;
    }

    const subParts = [tagHtml, ctry, stageLabel, startedStr].filter(Boolean);
    const countStyle = members.length >= 20 ? ' style="color:var(--warning);font-weight:600"' : '';
    return \`<div class="send-company-item" data-company="\${escapeHtml(name)}">
      <input type="checkbox" class="sc-check" data-company="\${escapeHtml(name)}"\${selectedCompanySet.has(name) ? ' checked' : ''}>
      <div class="sci-info">
        <span class="ci-name\${vipClass}">\${escapeHtml(name)}\${daysStr}</span>
        \${subParts.length ? \`<span class="sci-sub">\${subParts.join(' · ')}</span>\` : ''}
      </div>
      <span class="ci-count"\${countStyle}>\${members.length}</span>
    </div>\`;
  }).join('');`;

const newBlock = `  // 按开发阶段分组
  if (isArchivedView) {
    container.innerHTML = visible.map(([name, members]) => {
      const ctype = members[0]?.clientType || 'unlabeled';
      const tagHtml = clientTypeTag(ctype);
      const ctry = escapeHtml(members[0]?.country || '');
      const hist = sendHistory[name];
      const vipClass = members.length >= 5 ? ' ci-vip' : '';
      const startedStr = hist?.startedAt ? \`📅 \${formatDate(hist.startedAt)}\` : '';
      const daysStr = hist?.startedAt ? \`<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">\${daysSince(hist.startedAt)}</span>\` : '';
      const archivedStr = hist?.archivedAt ? \`📦 \${formatDate(hist.archivedAt)}\` : '';
      const subParts = [tagHtml, ctry, startedStr, archivedStr].filter(Boolean);
      return \`<div class="send-company-item archived" data-company="\${escapeHtml(name)}" style="opacity:.7">
        <div class="sci-info">
          <span class="ci-name\${vipClass}">📦 \${escapeHtml(name)}\${daysStr}</span>
          \${subParts.length ? \`<span class="sci-sub">\${subParts.join(' · ')}</span>\` : ''}
        </div>
        <button class="btn-reactivate-send" data-company="\${escapeHtml(name)}" style="font-size:10px;padding:2px 8px;border-radius:3px;border:1px solid var(--success);background:transparent;color:var(--success);cursor:pointer;white-space:nowrap">🔄 重新激活</button>
      </div>\`;
    }).join('');
  } else {
    // 活跃视图：按阶段分组 → 公司 → 联系人
    const stageGroups = {};
    const stageOrder = ['cold','f1','f2','f3','f4'];
    visible.forEach(([name, members]) => {
      const stage = sendHistory[name]?.stage || 'cold';
      if (!stageGroups[stage]) stageGroups[stage] = [];
      stageGroups[stage].push([name, members]);
    });
    let html = '';
    for (const stage of stageOrder) {
      const items = stageGroups[stage];
      if (!items || !items.length) continue;
      const totalContacts = items.reduce((s, [,m]) => s + m.length, 0);
      const gid = 'sg-' + stage;
      html += \`<div class="send-stage-group">
        <div class="send-stage-head" data-group="\${gid}" style="cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f0f2f5;border-bottom:1px solid #e0e0e0;font-size:11px;font-weight:600">
          <span class="sg-arrow" style="display:inline-block;width:10px;font-size:9px;transition:transform .2s">▸</span>
          <span class="stage-badge stage-\${stage}">\${STAGE_LABELS_SEND[stage]}</span>
          <span>\${items.length} 家 · \${totalContacts} 人</span>
        </div>
        <div class="send-stage-cards" data-group="\${gid}" style="display:none">
          \${items.map(([name, members]) => {
            const ctype = members[0]?.clientType || 'unlabeled';
            const tagHtml = clientTypeTag(ctype);
            const ctry = escapeHtml(members[0]?.country || '');
            const hist = sendHistory[name];
            const vipClass = members.length >= 5 ? ' ci-vip' : '';
            const startedStr = hist?.startedAt ? \`📅 \${formatDate(hist.startedAt)}\` : '';
            const daysStr = hist?.startedAt ? \`<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:2px">\${daysSince(hist.startedAt)}</span>\` : '';
            const subParts = [tagHtml, ctry, startedStr].filter(Boolean);
            const countStyle = members.length >= 20 ? ' style="color:var(--warning);font-weight:600"' : '';
            return \`<div class="send-company-item" data-company="\${escapeHtml(name)}">
              <input type="checkbox" class="sc-check" data-company="\${escapeHtml(name)}"\${selectedCompanySet.has(name) ? ' checked' : ''}>
              <div class="sci-info">
                <span class="ci-name\${vipClass}">\${escapeHtml(name)}\${daysStr}</span>
                \${subParts.length ? \`<span class="sci-sub">\${subParts.join(' · ')}</span>\` : ''}
              </div>
              <span class="ci-count"\${countStyle}>\${members.length}</span>
            </div>\`;
          }).join('')}
        </div>
      </div>\`;
    }
    container.innerHTML = html;

    // 阶段折叠
    container.querySelectorAll('.send-stage-head').forEach(head => {
      head.addEventListener('click', () => {
        const gid = head.dataset.group;
        const cards = container.querySelector(\`.send-stage-cards[data-group="\${gid}"]\`);
        const arrow = head.querySelector('.sg-arrow');
        if (!cards) return;
        const hidden = cards.style.display === 'none';
        cards.style.display = hidden ? 'block' : 'none';
        if (arrow) arrow.style.transform = hidden ? 'rotate(90deg)' : '';
      });
    });
    // 默认展开冷开发
    container.querySelector('.send-stage-head[data-group="sg-cold"]')?.click();
  }`;

if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
  console.log('OK');
} else { console.log('FAIL'); process.exit(1); }

fs.writeFileSync(p, s);
console.log('Done');
