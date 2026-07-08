// ── 端到端闭环测试 ──────────────────────────────────────────────────────────
const path = require('path');
const { ApolloClient, CustomerAcquisitionEngine } = require('../../src');
const { reviewContact } = require('../../src/providers/interface');

const PROFILES_DIR = path.join(__dirname, '..', '..', 'profiles');

async function run() {
  let passed = 0, failed = 0;
  function assert(label, condition) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}`); }
  }

  const apiKey = process.env.APOLLO_API_KEY || '';
  if (!apiKey) {
    console.log('  ⏭ 跳过：未设置 APOLLO_API_KEY');
    return { passed, failed };
  }

  console.log('\n── 步骤1: 初始化引擎 ──');
  const client = new ApolloClient(apiKey);
  const engine = new CustomerAcquisitionEngine(client);
  assert('引擎初始化 + Provider契约审查', !!engine);

  console.log('\n── 步骤2: 加载搜索画像 ──');
  const profile = CustomerAcquisitionEngine.loadProfile('freight-forwarder-latam', PROFILES_DIR);
  assert('画像加载', !!profile);

  console.log('\n── 步骤3: 搜索阶段（免费）──');
  const { companies, people, report } = await engine.searchPhase(profile);
  assert('搜到公司', companies.length > 0);
  assert('报告完整', report.totalPeople > 0 && report.topCompanies.length > 0);

  console.log('\n── 步骤4: 揭示邮箱（2 credits）──');
  const contacts = await engine.revealPhase(people, profile, 2);
  assert('返回联系人', contacts.length > 0);
  try {
    contacts.forEach((c, i) => reviewContact(c, i));
    passed++; console.log('  ✅ Contact 契约审查通过');
  } catch (e) { failed++; console.log(`  ❌ ${e.message}`); }

  console.log('\n── 步骤5: 闭环验证 ──');
  assert('credits 正确追踪', client.creditsUsed > 0);
  console.log(`  公司 ${report.totalCompanies}家 → 联系人 ${report.totalPeople}人 → 揭示 ${contacts.length}条`);

  console.log(`\n  E2E: ${passed}/${passed+failed} 通过 (💰${client.creditsUsed}c)`);
  return { passed, failed };
}

module.exports = { run };
