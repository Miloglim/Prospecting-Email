// ── 国家名中英别名（单一事实源）──────────────────────────────────────
// 运价线（rate-update.service）与首页开发信的意图解析（dev-letter-intent / dev-letter.service）
// 都要"用户说的国家 → 库里 country 字段的比对词"。原先这张表长在 rate-update.service 里，
// 复用方就得连带把整条运价/发送链拖进来，故下沉为独立模块；rate-update.service 原样转出口，
// 老调用点（agent/tools.ts 等）不受影响。
// 口径：只用于查库时加宽 LIKE，认不出就原样用，绝不猜。

/** 常见目的国中英对照 */
export const COUNTRY_ALIAS: Record<string, string[]> = {
  巴西: ["brazil"], 墨西哥: ["mexico"], 哥伦比亚: ["colombia"], 智利: ["chile"], 秘鲁: ["peru"],
  阿根廷: ["argentina"], 委内瑞拉: ["venezuela"], 厄瓜多尔: ["ecuador"], 巴拿马: ["panama"],
  哥斯达黎加: ["costa rica"], 多米尼加: ["dominican"], 古巴: ["cuba"], 乌拉圭: ["uruguay"],
  土耳其: ["turkey", "türkiye"], 埃及: ["egypt"], 阿尔及利亚: ["algeria"], 摩洛哥: ["morocco"],
  尼日利亚: ["nigeria"], 加纳: ["ghana"], 南非: ["south africa"], 肯尼亚: ["kenya"],
  美国: ["united states", "usa", "u.s.a", "美国"], 德国: ["germany"], 荷兰: ["netherlands"],
  西班牙: ["spain"], 意大利: ["italy"], 葡萄牙: ["portugal"], 英国: ["united kingdom", "uk", "england"],
  波兰: ["poland"], 希腊: ["greece"], 俄罗斯: ["russia"], 乌克兰: ["ukraine"], 罗马尼亚: ["romania"],
  阿联酋: ["united arab emirates", "uae"], 沙特: ["saudi"], 卡塔尔: ["qatar"], 科威特: ["kuwait"],
  伊拉克: ["iraq"], 约旦: ["jordan"], 以色列: ["israel"], 印度: ["india"], 巴基斯坦: ["pakistan"],
  孟加拉: ["bangladesh"], 斯里兰卡: ["sri lanka"], 越南: ["vietnam"], 泰国: ["thailand"],
  马来西亚: ["malaysia"], 新加坡: ["singapore"], 印尼: ["indonesia"], 菲律宾: ["philippines"],
  韩国: ["korea"], 日本: ["japan"], 澳大利亚: ["australia"], 新西兰: ["new zealand"],
};

/** 这个词是不是我们认识的国家名（中英双向）；是就返回规范中文名。用于纠正误塞进 port 的国家名 */
export function looksLikeCountry(word: string | null | undefined): string | null {
  const w = (word ?? "").trim().toLowerCase();
  if (!w) return null;
  if (COUNTRY_ALIAS[w]) return w;
  const byEn = Object.entries(COUNTRY_ALIAS).find(([, ens]) => ens.some(e => e === w));
  if (byEn) return byEn[0];
  return Object.keys(COUNTRY_ALIAS).find(cn => cn.toLowerCase() === w) ?? null;
}

/** 查询词 → 该国的比对词集合（中文原词 + 英文别名；给的是英文就反查中文，两边都能匹配 country 字段） */
export function countryMatchWords(word: string): string[] {
  const w = word.trim().toLowerCase();
  if (!w) return [];
  const cn = Object.entries(COUNTRY_ALIAS).find(([, ens]) => ens.some(e => e === w || e.includes(w) || w.includes(e)))?.[0];
  if (cn) return [w, cn];
  const ens = COUNTRY_ALIAS[w];
  return ens ? [w, ...ens] : [w];
}

/** 一段自由文本里有没有我们认识的国家名（中英别名按子串命中）；有就返回规范中文名。
 *  给「无模型端点时的关键词兜底解析」用（首页开发信输入框，docs/task-card-devletter-spec.md §4）——
 *  looksLikeCountry 只认单词，整句话得靠这个扫。 */
export function matchCountryInText(text: string | null | undefined): string | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  for (const [cn, ens] of Object.entries(COUNTRY_ALIAS)) {
    if (t.includes(cn.toLowerCase()) || ens.some(e => t.includes(e))) return cn;
  }
  return null;
}
