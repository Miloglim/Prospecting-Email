// ── 数据导出服务 ──
// 从 system-ipc.js 抽离：联系人 + 发送记录 + 互动记录 → XLSX

const path = require('path');
const XLSX = require('xlsx');

const STAGE_LABEL = { cold: '冷开发', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4' };
const STATUS_LABEL = { '已触达': '已触达', '有回复': '有回复', '自动回复': '自动回复', '': '未触达' };

function exportAll() {
  const wb = XLSX.utils.book_new();

  // Sheet1: 联系人
  try {
    const contactsDb = require('./contacts-db');
    const contacts = contactsDb.listAll();
    const rows = contacts.map(c => ({
      '公司': c.company_name || c.company || '',
      '国家': c.company_country || c.country || '',
      '分类': c.category || '',
      '邮箱': c.email || '',
      '网站': c.company_website || c.website || '',
      '名': c.first_name || c.firstName || (c.contact_name || c.contactName || '').split(' ')[0] || ((c.email || '').split('@')[0] || ''),
      '姓': c.last_name || c.lastName || (c.contact_name || c.contactName || '').split(' ').slice(1).join(' ') || '',
      '职位': c.title || c.position || '',
      '电话': c.phone || '',
      '领英': c.linkedin || '',
      '客户类型': c.client_type || c.clientType || '',
      '标签': (c.tags || []).join(', '),
      '状态': STATUS_LABEL[c._status] || '',
      '阶段': STAGE_LABEL[c.stage] || c.stage || 'cold',
      '退信': c.is_bounced ? '是' : '',
      '退信原因': c.bounce_reason || c.bounceReason || '',
      '最后发送': (c.last_sent_at || c._sentAt || '').slice(0, 10),
      '发信账号': c.last_sent_acct || c._sentAccount || '',
      '跟进人': c.assignee || '',
      '跟进备注': c.followup_note || '',
      '机会阶段': c.opp_stage || '',
      '添加时间': (c.created_at || '').slice(0, 10),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '联系人');
  } catch { /* 降级 */ }

  // Sheet2: 发送记录
  try {
    const sendLog = require('./send-log-db');
    const { records } = sendLog.list({ limit: 50000 });
    const rows = records.map(r => ({
      '时间': r.time ? new Date(r.time).toISOString().slice(0, 16).replace('T', ' ') : '',
      '公司': r.company || '',
      '收件人': r.to || '',
      '主题': r.subject || '',
      '发信账号': r._accountId || '',
      '状态': r.status === 'sent' ? '已发送' : r.status === 'failed' ? '失败' : r.status,
      '错误信息': r.error || '',
      '阶段': r._stage || '',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '发送记录');
  } catch { /* 降级 */ }

  // Sheet3: 互动记录
  try {
    const interactionsDb = require('./interactions-db');
    const interactions = interactionsDb.list({ limit: 5000 });
    const rows = interactions.map(i => ({
      '时间': (i.created_at || '').slice(0, 16).replace('T', ' '),
      '类型': i.type === 'sent' ? '发信' : i.type === 'received' ? '收信' : i.type === 'bounced' ? '退信' : i.type,
      '方向': i.direction === 'outbound' ? '发出' : '收到',
      '主题': i.subject || '',
      '摘要': (i.snippet || '').slice(0, 200),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '互动记录');
  } catch { /* 降级 */ }

  // 保存到桌面
  const desktop = path.join(require('os').homedir(), 'Desktop');
  const filename = `Milogin数据导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const dest = path.join(desktop, filename);
  XLSX.writeFile(wb, dest);
  return { ok: true, data: { path: dest, filename } };
}

module.exports = { exportAll };
