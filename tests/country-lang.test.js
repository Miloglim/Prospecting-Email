// 国家→语言映射测试 — 与 shared.js countryToLang 逻辑一致
const ISO_PT = ['br', 'pt', 'ao', 'mz', 'cv', 'gw', 'st', 'tl'];
const ISO_ES = ['mx', 'co', 'cl', 'pe', 'ar', 'ec', 'bo', 'py', 'uy', 'pa', 'cr', 've', 'gt', 'sv', 'hn', 'ni', 'do', 'cu', 'pr', 'es'];
const ISO_EN = ['us', 'gb', 'uk', 'ca', 'au', 'nz', 'de', 'fr', 'it', 'nl', 'be', 'jp', 'kr', 'cn', 'in', 'sg', 'ae'];

function countryToLang(country) {
  const c = (country || '').toLowerCase().trim();
  if (ISO_PT.includes(c)) return 'pt';
  if (ISO_ES.includes(c)) return 'es';
  if (ISO_EN.includes(c)) return 'en';
  const pt = ['brazil','brasil','巴西','portugal','葡萄牙'];
  if (pt.some(k => c.includes(k))) return 'pt';
  const es = ['mexico','méxico','墨西哥','colombia','哥伦比亚','chile','智利','peru','perú','秘鲁','argentina','阿根廷'];
  if (es.some(k => c.includes(k))) return 'es';
  return 'en';
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
function eq(a, b) { if (a !== b) throw new Error(`期望 "${b}", 实际 "${a}"`); }

console.log('\n🌎 国家→语言');
console.log('─'.repeat(40));

// ISO 代码精确匹配（之前最容易漏的）
test('BR → pt', () => eq(countryToLang('BR'), 'pt'));
test('br → pt', () => eq(countryToLang('br'), 'pt'));
test('MX → es', () => eq(countryToLang('MX'), 'es'));
test('CO → es', () => eq(countryToLang('CO'), 'es'));
test('CL → es', () => eq(countryToLang('CL'), 'es'));
test('PE → es', () => eq(countryToLang('PE'), 'es'));
test('AR → es', () => eq(countryToLang('AR'), 'es'));
test('EC → es', () => eq(countryToLang('EC'), 'es'));
test('US → en', () => eq(countryToLang('US'), 'en'));
test('CN → en', () => eq(countryToLang('CN'), 'en'));
test('ES → es', () => eq(countryToLang('ES'), 'es'));
test('PT → pt', () => eq(countryToLang('PT'), 'pt'));

// 完整国名
test('Brazil → pt', () => eq(countryToLang('Brazil'), 'pt'));
test('Brasil → pt', () => eq(countryToLang('Brasil'), 'pt'));
test('México → es', () => eq(countryToLang('México'), 'es'));
test('Perú → es', () => eq(countryToLang('Perú'), 'es'));

// 未知回退
test('未知国家 → en', () => eq(countryToLang('Mars'), 'en'));
test('空字符串 → en', () => eq(countryToLang(''), 'en'));

console.log(`\n${passed + failed} 项: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
