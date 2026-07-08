// ── 自动发送 — 邮件组装器 ──────────────────────────────────────────────────
// 从模板库选句 + 拼装邮件正文。主进程运行，纯数据操作。
// ponytail: 简化版 randomPick + assembleEmail，不复制渲染进程完整逻辑。

"use strict";

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 从数组中随机取一项，排除 usedSentences 中的 id。
 * @param {object[]} arr
 * @param {Set<string>} usedSet
 * @param {(item: object) => boolean} [filterFn]
 * @returns {object|null}
 */
function pickOne(arr, usedSet, filterFn) {
  if (!arr || !arr.length) return null;
  let pool = arr.filter((item) => !usedSet.has(item.id));
  if (pool.length === 0) pool = [...arr];
  if (filterFn && pool.some(filterFn)) pool = pool.filter(filterFn);
  if (pool.length === 0) pool = arr.filter((item) => !usedSet.has(item.id));
  if (pool.length === 0) pool = [...arr];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 从按类型拆分的对象 {agent:[], direct:[], unlabeled:[]} 或数组中取值。
 * @param {object|object[]} src
 * @param {string} type
 * @returns {object[]}
 */
function getPool(src, type) {
  if (!src) return [];
  if (Array.isArray(src)) return src;
  return src[type] || Object.values(src)[0] || [];
}

// ── 选句 ─────────────────────────────────────────────────────────────────────

/**
 * 从模板库随机选取句子。逻辑对齐渲染进程 randomPick。
 *
 * @param {object} tplLib - parseTemplateLibrary() 返回的模板库对象
 * @param {string} type - 'agent' | 'direct' | 'unlabeled'
 * @param {string} stage - 'cold' | 'f1' | 'f2' | 'f3' | 'f4'
 * @param {string[]} [usedIds] - 已用句子 id 列表（避免重复）
 * @returns {{ hook: object|null, pain: object|null, proof: object|null, cta: object|null, followup: object|null }}
 */
function randomPick(tplLib, type, stage, usedIds) {
  if (!tplLib)
    return { hook: null, pain: null, proof: null, cta: null, followup: null };

  const usedSet = new Set(usedIds || []);
  const skipHook = stage === "f3" || stage === "f4";
  const skipPain = stage === "f3" || stage === "f4";
  const skipProof = stage === "f4";

  const pickCTA = () => {
    const src = getPool(tplLib.ctas, type);
    if (stage === "f3" || stage === "f4")
      return (
        pickOne(src, usedSet, (item) => item.id && item.id.endsWith("4")) ||
        pickOne(src, usedSet)
      );
    if (stage === "f2")
      return (
        pickOne(src, usedSet, (item) => item.id && item.id.endsWith("3")) ||
        pickOne(src, usedSet)
      );
    return pickOne(src, usedSet);
  };

  const pickProof = () => {
    if (stage === "f3")
      return pickOne(
        tplLib.proofs?.[type],
        usedSet,
        (item) => item.id && item.id.endsWith("4"),
      );
    return pickOne(tplLib.proofs?.[type], usedSet);
  };

  return {
    hook: skipHook ? null : pickOne(getPool(tplLib.hooks, type), usedSet),
    pain: skipPain ? null : pickOne(tplLib.painPoints?.[type], usedSet),
    proof: skipProof ? null : pickProof(),
    cta: pickCTA(),
    followup:
      stage !== "cold" ? pickOne(tplLib.followUps?.[stage], usedSet) : null,
  };
}

// ── 拼装 ─────────────────────────────────────────────────────────────────────

/**
 * 将选取的句子拼装为完整邮件。
 *
 * @param {string} lang - 'es' | 'pt' | 'en'
 * @param {object} picked - randomPick 返回的对象
 * @param {string} stage
 * @param {string} type
 * @param {string} [senderName] - 发件人署名（如 "Zayne"）
 * @param {string} [firstName] - 收件人名字（个性化问候）
 * @param {string} [companyName] - 收件人公司名（用于主题行）
 * @returns {{ subject: string, body: string }}
 */
function assembleEmail(
  lang,
  picked,
  stage,
  type,
  senderName,
  firstName,
  companyName,
) {
  if (!lang || !picked) return { subject: "", body: "" };

  const t = (item) => (item ? item[lang] || "" : "");

  // 问候语
  let greeting;
  if (firstName) {
    if (lang === "es") greeting = `Buen día, ${firstName},`;
    else if (lang === "pt") greeting = `Bom dia, ${firstName},`;
    else greeting = `Hello, ${firstName},`;
  } else {
    if (lang === "es") greeting = "Buen día,";
    else if (lang === "pt") greeting = "Bom dia,";
    else greeting = "Hello,";
  }

  // 落款
  const closing =
    lang === "es" ? "Saludos," : lang === "pt" ? "Atenciosamente," : "Best,";
  const senderDisplay = senderName || "YQN";

  // 介绍句
  const intros = [
    lang === "es"
      ? `Soy ${senderDisplay}, de YQN.`
      : lang === "pt"
        ? `Sou ${senderDisplay}, da YQN.`
        : `I'm ${senderDisplay} from YQN.`,
    lang === "es"
      ? `Me presento: ${senderDisplay}, de YQN.`
      : lang === "pt"
        ? `Me apresento: ${senderDisplay}, da YQN.`
        : `Let me introduce myself: ${senderDisplay} from YQN.`,
    lang === "es"
      ? `Mi nombre es ${senderDisplay} y formo parte de YQN.`
      : lang === "pt"
        ? `Meu nome é ${senderDisplay} e faço parte da YQN.`
        : `My name is ${senderDisplay} and I'm part of YQN.`,
  ];
  const intro = intros[Math.floor(Math.random() * intros.length)];

  // 拼装正文段落
  const parts = [greeting, "", intro];
  if (picked.hook) parts.push(t(picked.hook));
  if (picked.pain) parts.push(t(picked.pain));
  if (picked.proof) parts.push(t(picked.proof));
  if (picked.cta) parts.push(t(picked.cta));
  if (picked.followup) parts.push(t(picked.followup));
  parts.push("", closing, senderDisplay);

  const body = parts.filter((p) => p !== null && p !== undefined).join("\n\n");

  // 构建主题（从模板库取，缺省用通用主题）
  let subject = "";
  if (companyName) {
    const companyShort = companyName.split(/[,，]/)[0].trim();
    subject =
      lang === "es"
        ? `${companyShort} — YQN`
        : lang === "pt"
          ? `${companyShort} — YQN`
          : `${companyShort} — YQN`;
  } else {
    subject =
      lang === "es"
        ? "Saludos — YQN"
        : lang === "pt"
          ? "Saudações — YQN"
          : "Greetings — YQN";
  }

  return { subject, body };
}

// ── 国家 → 语言 ─────────────────────────────────────────────────────────────

/**
 * 根据国家名推导邮件语言。
 * @param {string} country - 国家名（英文）
 * @returns {'es'|'pt'|'en'}
 */
function countryToLang(country) {
  if (!country) return "en";
  const c = country.toLowerCase().trim();
  if (
    [
      "brazil",
      "brasil",
      "portugal",
      "angola",
      "mozambique",
      "moçambique",
      "cape verde",
      "cabo verde",
      "guinea-bissau",
      "guiné-bissau",
      "são tomé",
      "sao tome",
      "east timor",
      "timor-leste",
    ].includes(c)
  )
    return "pt";
  if (
    [
      "mexico",
      "méxico",
      "colombia",
      "chile",
      "peru",
      "perú",
      "argentina",
      "ecuador",
      "bolivia",
      "paraguay",
      "uruguay",
      "panama",
      "panamá",
      "costa rica",
      "venezuela",
      "guatemala",
      "honduras",
      "el salvador",
      "nicaragua",
      "dominican republic",
      "cuba",
      "puerto rico",
      "spain",
      "españa",
    ].includes(c)
  )
    return "es";
  return "en";
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

module.exports = { randomPick, assembleEmail, countryToLang, getPool, pickOne };
