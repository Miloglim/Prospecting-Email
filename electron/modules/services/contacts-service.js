// ── 联系人业务逻辑（从 contacts-ipc.js 抽取）─────────────────────────────────
"use strict";

/** 智能拆分全名为 firstName + lastName */
function splitName(fullName) {
  if (!fullName || !fullName.trim()) return { firstName: "", lastName: "" };
  const cleaned = fullName.replace(/\(.*?\)/g, "").replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return { firstName: "", lastName: "" };
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/** 国家名标准化映射（中文/西语 → 英文） */
function normalizeCountry(raw) {
  if (!raw || !raw.trim()) return "";
  const m = {
    "巴西": "Brazil", "brasil": "Brazil", "葡萄牙": "Portugal",
    "安哥拉": "Angola", "莫桑比克": "Mozambique", "moçambique": "Mozambique",
    "佛得角": "Cape Verde", "cabo verde": "Cape Verde",
    "几内亚比绍": "Guinea-Bissau", "guiné-bissau": "Guinea-Bissau",
    "圣多美": "São Tomé", "são tomé": "São Tomé", "东帝汶": "East Timor", "timor-leste": "East Timor",
    "墨西哥": "Mexico", "méxico": "Mexico", "哥伦比亚": "Colombia",
    "智利": "Chile", "秘鲁": "Peru", "perú": "Peru", "阿根廷": "Argentina",
    "厄瓜多尔": "Ecuador", "玻利维亚": "Bolivia", "巴拉圭": "Paraguay",
    "乌拉圭": "Uruguay", "巴拿马": "Panama", "panamá": "Panama",
    "哥斯达黎加": "Costa Rica", "委内瑞拉": "Venezuela", "危地马拉": "Guatemala",
    "洪都拉斯": "Honduras", "萨尔瓦多": "El Salvador", "尼加拉瓜": "Nicaragua",
    "多米尼加": "Dominican Republic", "古巴": "Cuba", "波多黎各": "Puerto Rico",
    "美国": "United States", "usa": "United States", "英国": "United Kingdom", "uk": "United Kingdom",
    "加拿大": "Canada", "澳大利亚": "Australia", "新西兰": "New Zealand",
    "德国": "Germany", "法国": "France", "意大利": "Italy", "西班牙": "Spain",
    "荷兰": "Netherlands", "比利时": "Belgium", "日本": "Japan", "韩国": "South Korea",
    "中国": "China", "印度": "India", "新加坡": "Singapore", "阿联酋": "UAE",
  };
  const key = raw.trim();
  if (m[key] !== undefined) return m[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(m)) { if (k.toLowerCase() === lower) return v; }
  return raw.trim();
}

// ── AI 分类 ──────────────────────────────────────────────────────────────────

/**
 * 用 AI 对未标签联系人进行客户类型分类。
 * @param {string} [apiKey] — DeepSeek API Key，不传则跳过
 * @returns {{ ok: boolean, updated: number, total: number, error?: string }}
 */
async function classifyUnlabeled(apiKey) {
  const { Log } = require("../core/logger");
  if (!apiKey) return { ok: false, error: "未配置 DeepSeek API Key" };

  const contactsDb = require("./contacts-db");
  const { classifyClientAI } = require("../classify-client");
  const contacts = contactsDb.listAll();
  const unlabeled = contacts.filter((c) => (c.client_type || c.clientType || "unlabeled") === "unlabeled");
  if (!unlabeled.length) return { ok: true, updated: 0, total: 0, message: "所有联系人已分类" };

  // 按公司去重
  const companyMap = {};
  for (const c of unlabeled) {
    const name = c.company_name || c.company || "";
    if (!companyMap[name]) companyMap[name] = [];
    companyMap[name].push(c);
  }
  const companies = Object.entries(companyMap).slice(0, 20); // 上限 20 家
  let updated = 0;

  Log.info("[AI分类]", `开始 AI 分类，未标签 ${unlabeled.length} 人 × ${companies.length} 家公司`);

  for (const [company, members] of companies) {
    try {
      const newType = await classifyClientAI(company, members[0]?.category || "", apiKey);
      if (!newType || newType === "unlabeled") continue;
      for (const m of members) {
        contactsDb.update(m.id, { client_type: newType });
        updated++;
      }
      Log.info("[AI分类]", `${company} → ${newType}（${members.length}人）`);
    } catch (e) {
      if (e.message === "DeepSeek_API_Key_Invalid") return { ok: false, error: "API Key 无效" };
    }
  }
  Log.info("[AI分类]", `完成: ${updated} 人 / ${companies.length} 家公司`);
  return { ok: true, updated, total: companies.length };
}

module.exports = { splitName, normalizeCountry, classifyUnlabeled };
