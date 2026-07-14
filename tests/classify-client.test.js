// 客户分类纯函数测试 — 不依赖 Electron
const { classifyClient } = require('../electron/modules/classify-client');
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assert'}: 期望 "${expected}", 实际 "${actual}"`);
}

console.log('\n📦 classify-client');
console.log('─'.repeat(40));

test('货代强信号: freight forwarder', () => {
  eq(classifyClient('ABC Freight Forwarder Ltd', ''), 'agent');
});
test('货代强信号: agencia de carga', () => {
  eq(classifyClient('Agencia de Carga SA', ''), 'agent');
});
test('货代强信号: customs broker', () => {
  eq(classifyClient('XYZ Customs Broker', ''), 'agent');
});
test('货代强信号: NVOCC', () => {
  eq(classifyClient('Pacific NVOCC', ''), 'agent');
});
test('货代中文: 货代', () => {
  eq(classifyClient('深圳货代有限公司', ''), 'agent');
});

test('直客强信号: manufacturer', () => {
  eq(classifyClient('Steel Manufacturer Co', ''), 'direct');
});
test('直客强信号: fabricante', () => {
  eq(classifyClient('Fabricante de Móveis', ''), 'direct');
});
test('直客强信号: food', () => {
  eq(classifyClient('Brazil Food Export', ''), 'direct');
});
test('直客强信号: pharmaceutical', () => {
  eq(classifyClient('Pharmaceutical Labs', ''), 'direct');
});
test('直客中文: 直客', () => {
  eq(classifyClient('直客贸易公司', ''), 'direct');
});

test('弱信号需品类列: logistics 无品类 → unlabeled', () => {
  eq(classifyClient('ABC Logistics', ''), 'unlabeled');
});
test('弱信号有品类列: logistics + 品类 → agent', () => {
  eq(classifyClient('ABC Logistics', 'Freight'), 'agent');
});
test('弱信号需品类列: import 无品类 → unlabeled', () => {
  eq(classifyClient('Global Import Co', ''), 'unlabeled');
});
test('弱信号有品类列: import + 品类 → direct', () => {
  eq(classifyClient('Global Import Co', 'Retail'), 'direct');
});

test('无关键词 → unlabeled', () => {
  eq(classifyClient('Random Company Name', ''), 'unlabeled');
});

console.log(`\n${passed + failed} 项: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
