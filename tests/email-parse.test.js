// 邮箱解析 + 拆分逻辑测试 — 和 table-import-ipc.js 里的正则一致
const EMAIL_RE = /^[^\s@,"<>\[\]\\]+@[^\s@,"<>\[\]\\]+\.[^\s@,"<>\[\]\\]{2,}$/;
const EMAIL_SPLIT_RE = /\s*(?:\/\/+|\/|,|;|\n)\s*/;

function splitEmails(raw) {
  const parts = raw.split(EMAIL_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  return parts.filter(p => {
    if (!EMAIL_RE.test(p) || seen.has(p.toLowerCase())) return false;
    seen.add(p.toLowerCase());
    return true;
  });
}

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('\n📧 邮箱解析');
console.log('─'.repeat(40));

// ── 合法邮箱 ──
test('标准邮箱', () => {
  if (!EMAIL_RE.test('user@example.com')) throw new Error('应该通过');
});
test('巴西邮箱 .com.br', () => {
  if (!EMAIL_RE.test('marilia@waylinecomex.com.br')) throw new Error('应该通过');
});
test('带点用户名', () => {
  if (!EMAIL_RE.test('first.last@company.co.uk')) throw new Error('应该通过');
});

// ── 非法邮箱 ──
test('无@符号', () => {
  if (EMAIL_RE.test('geustaquioavports.com.br')) throw new Error('应该拒绝');
});
test('含空格', () => {
  if (EMAIL_RE.test('user @example.com')) throw new Error('应该拒绝');
});
test('含多个@', () => {
  if (EMAIL_RE.test('a@b@c.com')) throw new Error('应该拒绝');
});
test('空字符串', () => {
  if (EMAIL_RE.test('')) throw new Error('应该拒绝');
});

// ── 多邮箱拆分 ──
test('拆分: / 分隔两个邮箱', () => {
  const r = splitEmails('marilia@waylinecomex.com.br / marilia@wayline.com.br');
  if (r.length !== 2) throw new Error(`期望2个, 实际${r.length}`);
  if (r[0] !== 'marilia@waylinecomex.com.br') throw new Error(`第1个不匹配: ${r[0]}`);
  if (r[1] !== 'marilia@wayline.com.br') throw new Error(`第2个不匹配: ${r[1]}`);
});
test('拆分: // 分隔', () => {
  const r = splitEmails('mariaeduarda@naabsa.com // comercial@naabsa.com');
  if (r.length !== 2) throw new Error(`期望2个, 实际${r.length}`);
});
test('拆分: , 分隔', () => {
  const r = splitEmails('a@x.com, b@x.com');
  if (r.length !== 2) throw new Error(`期望2个, 实际${r.length}`);
});
test('拆分: ; 分隔', () => {
  const r = splitEmails('a@x.com;b@x.com');
  if (r.length !== 2) throw new Error(`期望2个, 实际${r.length}`);
});
test('拆分: 重复邮箱去重', () => {
  const r = splitEmails('a@x.com / a@x.com');
  if (r.length !== 1) throw new Error(`应该去重为1个, 实际${r.length}`);
});
test('拆分: 包含非法片段过滤', () => {
  const r = splitEmails('a@x.com / not-an-email');
  if (r.length !== 1) throw new Error(`应该只保留1个合法邮箱, 实际${r.length}: ${r.join(',')}`);
});
test('拆分: 单合法邮箱不误拆', () => {
  const r = splitEmails('user@example.com');
  if (r.length !== 1) throw new Error(`期望1个, 实际${r.length}`);
});

console.log(`\n${passed + failed} 项: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
