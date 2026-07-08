// ── Apollo 联系人获取集成测试 ────────────────────────────────────────────────
const { ApolloClient } = require('../../src/providers/apollo/client');
const { scoreAndRank } = require('../../src/scoring');
const { reviewPerson, reviewContact } = require('../../src/providers/interface');

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

  const client = new ApolloClient(apiKey);

  // 搜一家公司拿 contacts
  console.log('\n  ── 测试1: fetchPeople ──');
  const people = await client.fetchPeople(['kensalogistics.com']);
  assert('返回联系人 > 0', people.length > 0);
  assert('每人有 personId', people.every(p => p.personId));
  assert('每人有 hasEmail 标记', people.every(p => typeof p.hasEmail === 'boolean'));
  assert('有 hasEmail=true 的人', people.some(p => p.hasEmail));

  // 契约审查
  try {
    people.slice(0, 5).forEach((p, i) => reviewPerson(p, i));
    passed++; console.log('  ✅ Person 契约审查通过');
  } catch (e) {
    failed++; console.log(`  ❌ Person 契约审查失败: ${e.message}`);
  }

  const withEmail = people.filter(p => p.hasEmail);
  console.log(`  has_email: ${withEmail.length}/${people.length}`);

  // ── 打分 ──
  console.log('\n  ── 测试2: 打分 + 揭示 ──');
  const titleScoring = {
    high: ['logistics', 'freight', 'cargo', 'shipping', 'procurement'],
    medium: ['sales', 'operations', 'manager', 'director'],
  };
  const ranked = scoreAndRank(withEmail, titleScoring, 3);
  assert('打分排序: 返回 <=3 人', ranked.length <= 3);
  assert('打分排序: 每人有 score > 0', ranked.every(p => p.score > 0));

  if (ranked.length >= 2) {
    const contacts = await client.revealEmails(ranked, { smartMode: false });
    assert('揭示邮箱: 返回联系人', contacts.length >= 2);
    try {
      contacts.forEach((c, i) => reviewContact(c, i));
      passed++; console.log('  ✅ Contact 契约审查通过');
    } catch (e) {
      failed++; console.log(`  ❌ Contact 契约审查失败: ${e.message}`);
    }
    assert('每人有真实邮箱', contacts.every(c => c.email.includes('@')));
    assert('emailSource = revealed', contacts.every(c => c.emailSource === 'revealed'));
    console.log(`  揭示了 ${contacts.length} 条邮箱`);
  }

  console.log(`\n  apollo-people-fetch: ${passed}/${passed+failed} 通过`);
  return { passed, failed };
}

module.exports = { run };
