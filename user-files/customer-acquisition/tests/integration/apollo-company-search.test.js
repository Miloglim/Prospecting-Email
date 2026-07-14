// ── Apollo 公司搜索集成测试 ──────────────────────────────────────────────────
const { ApolloClient } = require('../../src/providers/apollo/client');
const { CustomerAcquisitionEngine } = require('../../src/engine');
const { reviewCompany } = require('../../src/providers/interface');

async function run() {
  let passed = 0, failed = 0;
  function assert(label, condition) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}`); }
  }

  const apiKey = process.env.APOLLO_API_KEY || '';
  if (!apiKey) {
    console.log('  ⏭ 跳过：未设置 APOLLO_API_KEY 环境变量');
    return { passed, failed };
  }

  const client = new ApolloClient(apiKey);

  console.log('\n  ── 测试1: 公司搜索 ──');
  const companies = await client.searchCompanies({
    nameKeywords: ['freight forwarder'],
    countries: ['Colombia'],
    sizeRanges: ['11,50', '51,200'],
    maxPagesPerKeyword: 1,
    perPage: 5,
  });

  assert('返回公司数 > 0', companies.length > 0);
  assert('每家公司有 name', companies.every(c => c.name));
  assert('每家公司有 domain', companies.every(c => c.domain && c.domain.includes('.')));
  assert('公司名包含货代关键词', companies.some(c => 
    ['freight','cargo','logistics'].some(kw => c.name.toLowerCase().includes(kw))
  ));

  // 契约审查
  try {
    companies.forEach((c, i) => reviewCompany(c, i));
    passed++; console.log('  ✅ 契约审查通过（所有Company对象合法）');
  } catch (e) {
    failed++; console.log(`  ❌ 契约审查失败: ${e.message}`);
  }

  console.log(`\n  ── 测试2: Provider 契约审查 ──`);
  const { reviewProviderContract } = require('../../src/providers/interface');
  const review = reviewProviderContract(client);
  assert('Provider 契约通过', review.valid);
  assert('Provider name = apollo', client.name === 'apollo');

  console.log(`\n  ── 测试3: 引擎初始化审查 ──`);
  try {
    new CustomerAcquisitionEngine(client);
    passed++; console.log('  ✅ 引擎接受 ApolloClient');
  } catch (e) {
    failed++; console.log(`  ❌ 引擎拒绝 ApolloClient: ${e.message}`);
  }

  console.log(`\n  apollo-company-search: ${passed}/${passed+failed} 通过`);
  return { passed, failed };
}

module.exports = { run };
