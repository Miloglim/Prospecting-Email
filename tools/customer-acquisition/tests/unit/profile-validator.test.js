// ── 搜索画像校验测试 ────────────────────────────────────────────────────────
const path = require('path');
const { CustomerAcquisitionEngine } = require('../../src/engine');

const PROFILES_DIR = path.join(__dirname, '..', '..', 'profiles');

async function run() {
  let passed = 0, failed = 0;
  function assert(label, condition) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}`); }
  }

  // 1. 加载有效画像
  try {
    const profile = CustomerAcquisitionEngine.loadProfile('freight-forwarder-latam', PROFILES_DIR);
    assert('加载 freight-forwarder-latam 成功', profile.profileId === 'freight-forwarder-latam');
    assert('包含 nameKeywords', profile.companyDiscovery.nameKeywords.length > 0);
    assert('包含 countries', profile.companyDiscovery.countries.includes('Colombia'));
    assert('包含 titleScoring', !!profile.contactFilter.titleScoring.high.length);
    assert('smartMode 开启', profile.emailReveal.smartMode === true);
  } catch (e) {
    failed++;
    console.log(`  ❌ 加载画像失败: ${e.message}`);
  }

  // 2. 加载不存在的画像
  try {
    CustomerAcquisitionEngine.loadProfile('nonexistent', PROFILES_DIR);
    failed++; console.log('  ❌ 加载不存在画像应抛错');
  } catch (e) {
    passed++; console.log('  ✅ 加载不存在画像正确抛错');
  }

  // 3. 列出所有画像
  const list = CustomerAcquisitionEngine.listProfiles(PROFILES_DIR);
  assert('listProfiles 非空', list.length > 0);
  assert('listProfiles 包含 freight-forwarder-latam',
    list.some(p => p.profileId === 'freight-forwarder-latam'));

  // 4. 校验必填字段
  const profile = CustomerAcquisitionEngine.loadProfile('freight-forwarder-latam', PROFILES_DIR);
  assert('discovery.source = apollo', profile.companyDiscovery.source === 'apollo');
  assert('contactFilter.requireEmail = true', profile.contactFilter.requireEmail === true);

  console.log(`\n  profile-validator: ${passed}/${passed+failed} 通过`);
  return { passed, failed };
}

module.exports = { run };
