// ── 自动开发信：用户要求 → 结构化筛选条件 ──────────────────────────────
// 分工（docs/task-card-devletter-spec.md §4）：模型只负责"把话翻成参数"，
// 选谁、排第几、取几位全部由 dev-letter.service 的确定性规则决定。
// 端点没配好 / 模型没听懂 → 关键词兜底，并在界面上如实标注解析来源，绝不静默丢掉用户要求。
import { askJsonOnce } from "./agent/oneshot";
import { matchCountryInText } from "./country-alias";

export interface DevLetterCriteria {
  /** 规范中文名（与 contacts.country 比对时再用 countryMatchWords 展开中英别名） */
  country?: string;
  /** EN / ES / PT */
  language?: string;
  /** direct / agent / peer / general */
  clientType?: string;
  /** 这次要几位（1..50） */
  limit?: number;
  /** 规则表达不了的剩余要求，原样带给人看（不进筛选） */
  note?: string;
  /** 谁解析出来的：model=AI 理解 / keyword=关键词理解 / none=没说要求 */
  parsedBy: "model" | "keyword" | "none";
}

const LANGS = new Set(["EN", "ES", "PT"]);
const CLIENT_TYPES = new Set(["direct", "agent", "peer", "general"]);
/** 本卡片的池子天生是"从未触达的冷客户"，所以不受理"跟进过的客户"这类要求（否则永远空集） */
const FOLLOWED_UP_RE = /跟进过|已跟进|发过信|老客户|已触达|f[1-4]\b/i;

const SYSTEM = [
  "把用户对「给谁发开发信」的自然语言要求翻成严格 JSON，只输出 JSON，不要任何解释或代码围栏。",
  '字段：country(国家名，用户怎么说就怎么写，或 null)、language("EN"|"ES"|"PT"|null)、',
  'clientType("direct"直客|"agent"货代代理|"peer"同行|null)、limit(正整数=这次要几位，或 null)。',
  '规则：没提到的字段一律 null，不要猜、不要补默认值；country 保留用户原词不要翻译；',
  '本卡片只会开发"从未联系过的新客户"，用户若要发给跟进过的老客户，就把该要求原样写进 note(或 null)。',
].join("\n");

/** 一句要求 → 结构化筛选（模型优先，关键词兜底） */
export async function parseDevLetterIntent(text: string): Promise<DevLetterCriteria> {
  const t = (text || "").trim();
  if (!t) return { parsedBy: "none" };
  const fromModel = await askJsonOnce<Record<string, unknown>>(SYSTEM, t);
  const picked = sanitize(fromModel);
  if (Object.keys(picked).length) return { ...picked, parsedBy: "model" };
  return { ...keywordParse(t), parsedBy: "keyword" };
}

/** 白名单 + 钳制：模型爱编字段，只认我们有的（编出来的一律丢，不带进筛选） */
export function sanitize(raw: unknown): Partial<DevLetterCriteria> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<DevLetterCriteria> = {};
  const country = typeof o.country === "string" ? matchCountryInText(o.country) ?? o.country.trim() : null;
  const language = typeof o.language === "string" ? o.language.trim().toUpperCase() : "";
  const clientType = typeof o.clientType === "string" ? o.clientType.trim().toLowerCase() : "";
  const limit = Number(o.limit);
  const note = typeof o.note === "string" ? o.note.trim() : "";
  if (country) out.country = country;
  if (LANGS.has(language)) out.language = language;
  if (CLIENT_TYPES.has(clientType)) out.clientType = clientType;
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.min(50, Math.floor(limit));
  if (note) out.note = note.slice(0, 200);
  return out;
}

const LANG_WORDS: Array<[RegExp, string]> = [
  [/英语|英文|english/i, "EN"], [/西语|西班牙语|spanish/i, "ES"], [/葡语|葡萄牙语|portuguese/i, "PT"],
];
const TYPE_WORDS: Array<[RegExp, string]> = [
  [/直客|直接客户|\bdirect\b/i, "direct"], [/货代|代理|\bagent\b|forwarder/i, "agent"], [/同行|\bpeer\b/i, "peer"],
];
const LIMIT_RE = /(?:前|最多|来|取|要)\s*(\d{1,3})\s*(?:位|个|家|封)|(\d{1,3})\s*(?:位|个|家|封)/;

/** 生效条件拼成一句人话（主进程写推荐理由用；界面提示与之同源，别两处各写一套） */
export function describeCriteria(c?: DevLetterCriteria | null): string {
  if (!c) return "默认规则";
  const parts: string[] = [];
  const LANG_CN: Record<string, string> = { EN: "英语", ES: "西语", PT: "葡语" };
  const TYPE_CN: Record<string, string> = { direct: "直客", agent: "货代/代理", peer: "同行", general: "通用" };
  if (c.country) parts.push(c.country);
  if (c.language) parts.push(LANG_CN[c.language] ?? c.language);
  if (c.clientType) parts.push(TYPE_CN[c.clientType] ?? c.clientType);
  if (c.limit) parts.push(`前 ${c.limit} 位`);
  return parts.length ? parts.join(" · ") : "默认规则";
}

/** 没模型时的关键词兜底解析（纯函数，单独可测） */
export function keywordParse(t: string): Partial<DevLetterCriteria> {
  const out: Partial<DevLetterCriteria> = {};
  const cn = matchCountryInText(t);
  if (cn) out.country = cn;
  const lang = LANG_WORDS.find(([re]) => re.test(t));
  if (lang) out.language = lang[1];
  const type = TYPE_WORDS.find(([re]) => re.test(t));
  if (type) out.clientType = type[1];
  const m = t.match(LIMIT_RE);
  const n = Number(m?.[1] ?? m?.[2]);
  if (Number.isFinite(n) && n > 0) out.limit = Math.min(50, Math.floor(n));
  if (FOLLOWED_UP_RE.test(t)) out.note = "本卡片只开发从未联系过的新客户：老客户请去跟进看板或任务里发";
  return out;
}
