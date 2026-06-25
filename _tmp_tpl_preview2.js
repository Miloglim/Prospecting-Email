const fs = require('fs');
const p = require('path').join(__dirname, 'electron', 'renderer', 'app.js');
let s = fs.readFileSync(p, 'utf8');

const previewCode = `
// ── 模板预览 ──────────────────────────────────────────────────────
function initTemplatePreview() {
  const head = document.querySelector('.tpl-preview-head');
  const body = document.getElementById('tpl-preview-body');
  const arrow = document.getElementById('tpl-preview-arrow');
  if (head && body && arrow) {
    head.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? 'block' : 'none';
      arrow.style.transform = hidden ? 'rotate(90deg)' : '';
    });
  }

  let selType = 'agent', selLang = 'es', selStage = 'cold';

  const render = () => {
    if (!templateLib) return;
    const picked = randomPick(selType, selStage, [], false);
    const email = assembleEmail(selLang, picked.hook, picked.pain, picked.proof, picked.cta, picked.followup, selStage, selType, false);
    const lines = email.split('\\n');
    const html = lines.map(line => {
      let src = '';
      if (picked.hook && line === picked.hook[selLang]) src = ' — Hook ' + picked.hook.id;
      else if (picked.pain && line === picked.pain[selLang]) src = ' — Pain ' + picked.pain.id;
      else if (picked.proof && line === picked.proof[selLang] && line) src = ' — Proof ' + picked.proof.id;
      else if (picked.cta && line === picked.cta[selLang]) src = ' — CTA ' + picked.cta.id;
      else if (picked.followup && line === picked.followup[selLang]) src = ' — FollowUp ' + picked.followup.id;
      return '<div>' + escapeHtml(line) + (src ? '<span style="color:var(--text-secondary);font-size:10px">' + src + '</span>' : '') + '</div>';
    }).join('');
    document.getElementById('tpl-preview-content').innerHTML = html || '<span style="color:var(--text-secondary)">（无内容）</span>';
  };

  document.querySelectorAll('.tpl-type').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tpl-type').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); selType = b.dataset.val; render();
  }));
  document.querySelectorAll('.tpl-lang').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tpl-lang').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); selLang = b.dataset.val; render();
  }));
  document.querySelectorAll('.tpl-stage').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tpl-stage').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); selStage = b.dataset.val; render();
  }));
  document.getElementById('tpl-regenerate')?.addEventListener('click', render);
  render();
}`;

// Insert before: function updateMonthlyReportSection()
const marker = '\n\nfunction updateMonthlyReportSection() {';
const idx = s.indexOf(marker);
if (idx < 0) { console.log('FAIL marker'); process.exit(1); }

s = s.slice(0, idx) + previewCode + '\n' + s.slice(idx);

// Add initTemplatePreview() call after loadSendContacts in initEmailSend
const call = 'await loadSendContacts();';
const callIdx = s.indexOf(call);
s = s.slice(0, callIdx + call.length) + '\n  initTemplatePreview();' + s.slice(callIdx + call.length);
console.log('OK');

fs.writeFileSync(p, s);
console.log('Done');
