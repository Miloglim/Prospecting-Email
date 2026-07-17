// 签名存取纯函数测试 — 不依赖 Electron
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assert'}: 期望 "${expected}", 实际 "${actual}"`);
}

console.log('\n📦 signature-store');
console.log('─'.repeat(40));

// ── 准备测试环境 ──
const tmpDir = path.join(os.tmpdir(), 'sig-test-' + Date.now());
const sendDir = path.join(tmpDir, 'send');
fs.mkdirSync(sendDir, { recursive: true });

// 注入 APP_ROOT
const sigStore = require('../electron/modules/services/signature-store');
sigStore.init(tmpDir);

const TEST_ACCT = 'acc_test_001';
const DEFAULT_HTML = '<div style="font-family:Arial"><p><strong>Zayne Jin</strong></p></div>';

// ── 用例 1：无全局文件时返回默认 HTML ──
test('全局签名：文件不存在返回默认HTML', () => {
  const html = sigStore.readSignature(null);
  ok(html.includes('Zayne Jin'), '应包含默认签名内容');
  ok(html.includes('font-family:Arial'), '应包含默认样式');
});

// ── 用例 2：全局签名读写 ──
test('全局签名：写入后读回一致', () => {
  const html = '<div><p><strong>Test Global</strong></p><p>+86 123456</p></div>';
  const r = sigStore.writeSignature(html, null);
  ok(r.ok, '写入应成功: ' + (r.error || ''));
  const read = sigStore.readSignature(null);
  eq(read, html, '读回应与写入一致');
});

// ── 用例 3：账号专属签名读写 + 隔离性 ──
test('专属签名：写入后只有该账号能读到', () => {
  const custom = '<div><p><strong>TRI Account</strong></p></div>';
  const r = sigStore.writeSignature(custom, TEST_ACCT);
  ok(r.ok, '写入应成功: ' + (r.error || ''));

  const acctRead = sigStore.readSignature(TEST_ACCT);
  eq(acctRead, custom, '账号专属签名应返回自定义内容');

  const globalRead = sigStore.readSignature(null);
  ok(globalRead.includes('Test Global'), '全局签名不应被专属签名覆盖');
});

// ── 用例 4：回退逻辑 ──
test('回退：不存在的账号返回全局签名', () => {
  const html = sigStore.readSignature('non-existent-id');
  ok(html.includes('Test Global'), '不存在账号应回退全局签名');
});

// ── 用例 5：保存校验 —— 写后读回比对失败 ──
test('保存校验：写入后验证一致性', () => {
  const html = '<div>Verify Test</div>';
  const r = sigStore.writeSignature(html, TEST_ACCT);
  ok(r.ok, '正常写入应成功');

  const read = sigStore.readSignature(TEST_ACCT);
  eq(read, html, '验证读回一致');
});

// ── 用例 6：删除联动 ──
test('删除：专属签名文件被清除', () => {
  const sigPath = path.join(sendDir, `signature-${TEST_ACCT}.html`);
  ok(fs.existsSync(sigPath), '删除前文件应存在');

  sigStore.deleteSignature(TEST_ACCT);
  ok(!fs.existsSync(sigPath), '删除后文件应不存在');

  // 删除后读取应回退全局
  const after = sigStore.readSignature(TEST_ACCT);
  ok(after.includes('Test Global'), '删除后应回退全局签名');
});

// ── 用例 7：空签名合法 ──
test('空签名：允许写入空字符串', () => {
  const r = sigStore.writeSignature('', 'acc_empty_test');
  ok(r.ok, '空签名写入应成功: ' + (r.error || ''));
  const read = sigStore.readSignature('acc_empty_test');
  eq(read, '', '空签名读回应为空字符串');
  // 清理
  sigStore.deleteSignature('acc_empty_test');
});

// ── 清理 ──
try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* 测试清理失败不影响结果 */ }

console.log('─'.repeat(40));
console.log(`  通过: ${passed}, 失败: ${failed}`);
if (failed) process.exit(1);
