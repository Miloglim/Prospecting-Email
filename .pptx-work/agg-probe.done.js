// 验证「沉默最久」聚合在纯 SQL 里做的性能与正确性（不进项目，一次性探针）
const initSqlJs = require("sql.js");
const fs = require("fs");

(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync("data/prospector.db", null));

  const Q = `
    WITH last_act AS (
      SELECT contact_id AS cid, MAX(created_at) AS at FROM interactions GROUP BY contact_id
      UNION ALL
      SELECT matched_contact_id, MAX(received_at) FROM inbox_messages WHERE matched_contact_id IS NOT NULL GROUP BY matched_contact_id
    ),
    merged AS (SELECT cid, MAX(at) AS last_at FROM last_act GROUP BY cid)
  `;

  const t0 = Date.now();
  const r1 = db.exec(Q + "SELECT COUNT(*) FROM contacts c LEFT JOIN merged m ON m.cid=c.id WHERE m.last_at IS NULL");
  console.log("从未被跟进数:", r1[0].values[0][0]);

  const t1 = Date.now();
  const r2 = db.exec(Q + `
    SELECT c.id, c.first_name, c.last_name, c.email, m.last_at
    FROM contacts c LEFT JOIN merged m ON m.cid=c.id
    ORDER BY (m.last_at IS NULL) DESC, m.last_at ASC LIMIT 10
  `);
  console.log("全库沉默排序耗时(ms):", Date.now() - t1);

  // 带 contact_tags 关键词过滤的版本（模拟 search_contacts 的 where 组合）
  const t2 = Date.now();
  const r3 = db.exec(Q + `
    SELECT c.id, c.email, m.last_at
    FROM contacts c LEFT JOIN merged m ON m.cid=c.id
    LEFT JOIN companies cp ON cp.id = c.company_id
    WHERE cp.name LIKE '%logistic%' OR c.email LIKE '%logistic%'
    ORDER BY (m.last_at IS NULL) DESC, m.last_at ASC LIMIT 10
  `);
  console.log("带关键词过滤版耗时(ms):", Date.now() - t2, "命中:", r3[0].values.length);

  console.log("\n沉默 Top10:");
  for (const row of r2[0].values) console.log(" ", row.join(" | "));
})();
