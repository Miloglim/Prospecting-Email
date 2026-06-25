const fs = require('fs');
const p = require('path').join(__dirname, 'electron', 'renderer', 'app.js');
let s = fs.readFileSync(p, 'utf8');

// Add template preview function + binding
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
      if (line === (picked.hook?.[selLang] || '')) src = \` <span style="color:var(--text-secondary);font-size:10px">— Hook \${picked.hook?.id}</span>\`;
      else if (line === (picked.pain?.[selLang] || '')) src = \` <span style="color:var(--text-secondary);font-size:10px">— Pain \${picked.pain?.id}</span>\`;
      else if (line === (picked.proof?.[selLang] || '') && line) src = \` <span style="color:var(--text-secondary);font-size:10px">— Proof \${picked.proof?.id}</span>\`;
      else if (picked.cta && line === (picked.cta[selLang] || '')) src = \` <span style="color:var(--text-secondary);font-size:10px">— CTA \${picked.cta?.id}</span>\`;
      else if (picked.followup && line === (picked.followup[selLang] || '')) src = \` <span style="color:var(--text-secondary);font-size:10px">— FollowUp \${picked.followup?.id}</span>\`;
      return \`<div>\${escapeHtml(line)}\${src}</div>\`;
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

// Insert after initEmailSend
const marker = 'async function initEmailSend() {';
const idx = s.indexOf(marker);
if (idx < 0) { console.log('FAIL'); process.exit(1); }

// Find the end of initEmailSend and add initTemplatePreview call
const initEnd = '  await loadSendContacts();\n}';
const ieIdx = s.indexOf(initEnd, idx);
if (ieIdx < 0) { console.log('FAIL initEmailSend end'); process.exit(1); }

s = s.slice(0, ieIdx + initEnd.length) + '\n' + previewCode + '\n' + s.slice(ieIdx + initEnd.length);

// Add call to initTemplatePreview at the end of initEmailSend
// Find "await loadSendContacts();" in the function and add initTemplatePreview() after it
const contactsCall = 'await loadSendContacts();';
const ccIdx = s.indexOf(contactsCall, idx);
if (ccIdx >= 0) {
  s = s.slice(0, ccIdx + contactsCall.length) + '\n  initTemplatePreview();' + s.slice(ccIdx + contactsCall.length);
  console.log('OK');
} else { console.log('FAIL loadSendContacts'); }

fs.writeFileSync(p, s);
console.log('Done');
