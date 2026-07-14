// ── 联系人打分 ──────────────────────────────────────────────────────────────
// 纯函数，无副作用，输入 Person[] → 输出 Person[] with score
// 打分优先级: 业务匹配 > 职级

const SENIORITY_WEIGHT = {
  c_suite: 2, director: 2, manager: 2,
  specialist: 1, other: 1,
};

/**
 * @param {Object[]} people — 有 hasEmail=true 的人
 * @param {Object} titleScoring — { high: string[], medium: string[] }
 * @param {number} [perCompanyLimit] — 每公司最多取几人，0=不限
 * @returns {Object[]} 带 score 字段的排序后数组
 */
function scoreAndRank(people, titleScoring, perCompanyLimit = 0) {
  if (!people || !people.length) return [];

  const { high = [], medium = [] } = titleScoring || {};

  function matchScore(title) {
    if (!title) return 0;
    const t = title.toLowerCase();
    for (const kw of high) {
      if (t.includes(kw.toLowerCase())) return 6;
    }
    for (const kw of medium) {
      if (t.includes(kw.toLowerCase())) return 3;
    }
    return 0;
  }

  function seniorityOf(person) {
    return SENIORITY_WEIGHT[person.seniority] || 1;
  }

  // 打分
  for (const p of people) {
    p._titleScore = matchScore(p.title);
    p._seniorityScore = seniorityOf(p);
    p.score = p._titleScore + p._seniorityScore;
  }

  // 按公司分组，组内排序，截断
  const groups = new Map();
  for (const p of people) {
    const key = p.companyName || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const result = [];
  for (const [, members] of groups) {
    members.sort((a, b) => b.score - a.score);
    const selected = perCompanyLimit > 0 ? members.slice(0, perCompanyLimit) : members;
    result.push(...selected);
  }

  result.sort((a, b) => b.score - a.score);
  return result;
}

module.exports = { scoreAndRank };
