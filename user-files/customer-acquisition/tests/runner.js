// ── 测试运行器 ───────────────────────────────────────────────────────────────
const path = require('path');

const TEST_DIR = __dirname;
const TESTS = {
  unit: ['scoring.test.js', 'email-inferrer.test.js', 'profile-validator.test.js'],
  integration: ['apollo-company-search.test.js', 'apollo-people-fetch.test.js'],
  e2e: ['pipeline-closed-loop.test.js'],
};

async function runTests(category) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  测试类别: ${category}`);
  console.log(`${'='.repeat(60)}\n`);

  const files = TESTS[category] || [];
  if (!files.length) {
    console.log('  无可执行测试');
    return { passed: 0, failed: 0 };
  }

  let passed = 0, failed = 0;
  for (const file of files) {
    const filePath = path.join(TEST_DIR, category === 'unit' ? 'unit' : category === 'integration' ? 'integration' : 'e2e', file);
    try {
      if (!require('fs').existsSync(filePath)) {
        console.log(`  ⏭ 跳过（文件不存在）: ${file}`);
        continue;
      }
      const mod = require(filePath);
      if (typeof mod.run === 'function') {
        const result = await mod.run();
        passed += result.passed || 0;
        failed += result.failed || 0;
      } else {
        console.log(`  ⚠ ${file}: 未导出 run() 方法`);
      }
    } catch (e) {
      failed++;
      console.error(`  ❌ ${file}: ${e.message}`);
      console.error(e.stack);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${category}: ${passed} 通过, ${failed} 失败`);
  return { passed, failed };
}

(async () => {
  const arg = process.argv[2];
  if (arg) {
    await runTests(arg);
  } else {
    let tp = 0, tf = 0;
    for (const cat of ['unit', 'integration']) {
      const r = await runTests(cat);
      tp += r.passed;
      tf += r.failed;
    }
    console.log(`\n总计: ${tp} 通过, ${tf} 失败`);
    if (tf > 0) process.exit(1);
  }
})();
