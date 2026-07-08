// ── 邮箱格式推断单元测试 ────────────────────────────────────────────────────
const { ApolloClient } = require('../../src/providers/apollo/client');

// 用假 key 创建实例，只测纯函数
const dummy = new ApolloClient('test-key-123');

async function run() {
  let passed = 0, failed = 0;
  function assert(label, condition) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}`); }
  }

  // ── pattern detection ──
  const domain = 'danuser.com';

  // fi+last: lhrabovsky, ssmith, gdanuser
  const p1 = dummy._detectPattern([
    { contactName: 'Loren Hrabovsky', email: 'lhrabovsky@danuser.com' },
    { contactName: 'Scott Smith', email: 'ssmith@danuser.com' },
  ], domain);
  assert('格式检测: fi+last', p1 === '{fi}{last}@danuser.com');

  // first.last
  const p2 = dummy._detectPattern([
    { contactName: 'John Doe', email: 'john.doe@company.com' },
    { contactName: 'Jane Smith', email: 'jane.smith@company.com' },
  ], 'company.com');
  assert('格式检测: first.last', p2 === '{first}.{last}@company.com');

  // first@domain
  const p3 = dummy._detectPattern([
    { contactName: 'John', email: 'john@startup.com' },
    { contactName: 'Jane', email: 'jane@startup.com' },
  ], 'startup.com');
  assert('格式检测: first@domain', p3 === '{first}@startup.com');

  // 不统一 → null
  const p4 = dummy._detectPattern([
    { contactName: 'John Doe', email: 'john@a.com' },
    { contactName: 'Jane Smith', email: 'jane.smith@a.com' },
  ], 'a.com');
  assert('格式检测: 不统一 → null', p4 === null);

  // ── email inference ──
  assert('推断 fi+last: Marcia Crawford → mcrawford@danuser.com',
    dummy._inferEmail('Marcia Crawford', '{fi}{last}@danuser.com') === 'mcrawford@danuser.com');

  assert('推断 first.last',
    dummy._inferEmail('John Doe', '{first}.{last}@company.com') === 'john.doe@company.com');

  assert('推断 first@domain',
    dummy._inferEmail('John', '{first}@startup.com') === 'john@startup.com');

  assert('推断: 缺少姓 → null',
    dummy._inferEmail('Marcia', '{fi}{last}@danuser.com') === null);

  assert('推断: 空名 → null',
    dummy._inferEmail('', '{first}@x.com') === null);

  console.log(`\n  email-inferrer: ${passed}/${passed+failed} 通过`);
  return { passed, failed };
}

module.exports = { run };
