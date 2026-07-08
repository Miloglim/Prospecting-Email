// ── 打分逻辑单元测试 ────────────────────────────────────────────────────────
const { scoreAndRank } = require('../../src/scoring');

async function run() {
  let passed = 0, failed = 0;

  function assert(label, condition) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}`); }
  }

  const titleScoring = {
    high: ['logistics', 'freight', 'cargo', 'shipping', 'procurement'],
    medium: ['sales', 'operations', 'manager', 'director'],
  };

  // 1. 物流匹配 > 高管
  const people1 = [
    { firstName: 'A', lastName: 'B', title: 'Logistics Manager', hasEmail: true, companyName: 'TestCo', seniority: 'manager' },
    { firstName: 'C', lastName: 'D', title: 'CEO', hasEmail: true, companyName: 'TestCo', seniority: 'c_suite' },
  ];
  const r1 = scoreAndRank(people1, titleScoring);
  assert('物流经理排在CEO前面', r1[0].title === 'Logistics Manager' && r1[0].score === 8);
  assert('CEO得分低于物流经理', r1[1].score < r1[0].score);

  // 2. 每公司截断
  const people2 = [
    { firstName: 'a', lastName: '', title: 'Manager', hasEmail: true, companyName: 'A', seniority: 'manager' },
    { firstName: 'b', lastName: '', title: 'Staff', hasEmail: true, companyName: 'A', seniority: 'other' },
    { firstName: 'c', lastName: '', title: 'Manager', hasEmail: true, companyName: 'B', seniority: 'manager' },
  ];
  const r2 = scoreAndRank(people2, titleScoring, 1);
  assert('每公司限1人: A公司只有1人', r2.filter(p => p.companyName === 'A').length === 1);
  assert('每公司限1人: B公司有1人', r2.filter(p => p.companyName === 'B').length === 1);
  assert('每公司限1人: 总共2人', r2.length === 2);

  // 3. 不限每公司人数
  const r3 = scoreAndRank(people2, titleScoring, 0);
  assert('不限: 返回3人', r3.length === 3);

  // 4. 空输入
  assert('空数组', scoreAndRank([], titleScoring).length === 0);
  assert('null', scoreAndRank(null, titleScoring).length === 0);

  // 5. sales关键词匹配
  const people3 = [
    { firstName: 'x', lastName: '', title: 'Sales Executive', hasEmail: true, companyName: 'X', seniority: 'other' },
    { firstName: 'y', lastName: '', title: 'IT Support', hasEmail: true, companyName: 'X', seniority: 'other' },
  ];
  const r5 = scoreAndRank(people3, titleScoring);
  assert('销售排在IT前面', r5[0].title === 'Sales Executive');
  assert('IT Support得分最低', r5[1].score === 1); // no match + other seniority

  console.log(`\n  scoring: ${passed}/${passed+failed} 通过`);
  return { passed, failed };
}

module.exports = { run };
