"""Update crm-pipeline.js email rendering for sent emails."""
path = 'electron/renderer/modules/crm-pipeline.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Date label: add [sent] tag for sent emails
old = '<span class="crm-email-date">${escapeHtml(fmtDT(m.date))}</span>'
new = '<span class="crm-email-date">${escapeHtml(fmtDT(m.date))}${m._isSent?\' [sent]\':\'\'}</span>'
if old in content:
    content = content.replace(old, new)
    print('1. OK - date')
else:
    print('1. FAIL')

# 2. From line: show To: for sent
old = "<div class=\"crm-email-from\">${escapeHtml(m.from_name||m.from_addr||'')}</div>"
new = "<div class=\"crm-email-from\">${escapeHtml(m._isSent?'To: '+(m.from_addr||''):m.from_name||m.from_addr||'')}</div>"
if old in content:
    content = content.replace(old, new)
    print('2. OK - from')
else:
    print('2. FAIL')

# 3. Icon/color: sent type
old = "<span style=\"font-size:11px;color:${m.type==='reply'?'#22a644':m.type==='bounce'?'#d93025':m._indirect?'#ff9800':'var(--text-secondary)'};flex-shrink:0\"${m._indirect?' title=\"关联匹配\"':''}>${lucide(m.type==='reply'?'mail':m.type==='bounce'?'alert-circle':'send',12)}</span>"
new = "<span style=\"font-size:11px;color:${m.type==='sent'?'var(--primary)':m.type==='reply'?'#22a644':m.type==='bounce'?'#d93025':m._indirect?'#ff9800':'var(--text-secondary)'};flex-shrink:0\"${m._indirect?' title=\"关联匹配\"':''}>${lucide(m.type==='sent'?'send':m.type==='reply'?'mail':m.type==='bounce'?'alert-circle':'send',12)}</span>"
if old in content:
    content = content.replace(old, new)
    print('3. OK - icon')
else:
    print('3. FAIL')

# 4. Empty state
old = "tgt.innerHTML = '<div style=\"color:var(--text-secondary);padding:12px;font-size:12px\">' + (r.ok ? '暂无邮件往来' : '加载失败: ' + escapeHtml(r.error||'')) + '</div>';"
new = "tgt.innerHTML = '<div style=\"color:var(--text-secondary);padding:12px;font-size:12px\">No email history</div>';"
if old in content:
    content = content.replace(old, new)
    print('4. OK - empty')
else:
    print('4. FAIL')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
