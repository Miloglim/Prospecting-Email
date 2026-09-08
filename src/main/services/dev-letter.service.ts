// ── 自动开发信：推荐群组（确定性规则，无模型参与）──────────────────────
// 用户口径：群组是"agent 提前设置好的"——规则固定、可解释、零延迟；人只做两个动作：看推荐、点确定。
// 推荐逻辑（docs/home-cards-spec.md §2）：
//   从未触达（status 空）+ 邮箱有效 + 剔占位邮箱 → 每公司取 1 位（资料齐全度优先，同分取最早录入）
//   → 按齐全度降序取前 N，N = min(候选数, 日限额剩余, 50)。
// 红线：只产生"推荐 + 名单"，绝不入队、绝不发送——入队/发送决策在发送界面由人完成。
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { emailAccounts } from "../db/schema/accounts";
import { sql as dsql } from "drizzle-orm";
import { loadConfig } from "../config";
import { okResult, type Result } from "../errors";

export interface DevLetterContact {
  id: number; email: string; name: string;
  company: string | null; country: string | null; language: string | null;
}

export interface DevLetterRecommendation {
  contacts: DevLetterContact[];
  groupSize: number;
  totalCandidates: number;
  companyCount: number;
  quota: { dailyLimit: number; sentToday: number; remaining: number | null; accountCount: number };
  languages: Array<{ lang: string; n: number }>;
  reasons: string[];
}

/** 首批推荐上限：广撒也要有边界，50 位是一轮开发信的合理批量 */
export const DEV_LETTER_CAP = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 占位/无效邮箱不发（一个坏地址会让整组 BCC 被拒收） */
const PLACEHOLDER_EMAIL = /no\.email|noreply|no-reply|example\.com|test@|@test|null@/i;

interface CandidateRow extends DevLetterContact {
  companyId: number | null;
  companyKey: string;
  title: string | null;
  createdAt: string;
  score: number;          // 资料齐全度 0..4
}

/**
 * 推荐开发群组。纯读，不写库、不入队。
 * @param capOverride 测试/未来 UI 用的上限覆盖；默认 DEV_LETTER_CAP 与限额取小
 */
export function recommendDevLetterGroup(capOverride?: number, now: Date = new Date()): Result<DevLetterRecommendation> {
  const db = getDb();
  const cfg = loadConfig();
  const q = cfg.sendQuota || { dailyLimit: 0, sentToday: 0 };
  const remaining = q.dailyLimit > 0 ? Math.max(0, q.dailyLimit - q.sentToday) : null;
  const accountCount = db.select({ n: dsql<number>`count(*)` }).from(emailAccounts)
    .where(dsql`coalesce(${emailAccounts.isActive}, 0) = 1`).get()?.n ?? 0;

  // ① 候选：从未触达（status 空）的联系人；占位/无效邮箱剔除
  const rows = db.select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    companyId: contacts.companyId, country: contacts.country, language: contacts.language,
    title: contacts.title, createdAt: contacts.createdAt,
    companyName: dsql<string | null>`(select name from companies where companies.id = ${contacts.companyId})`,
  }).from(contacts)
    .where(dsql`coalesce(${contacts.status}, '') = ''`)
    .all();

  const candidates: CandidateRow[] = [];
  for (const r of rows) {
    const email = (r.email || "").trim();
    if (!EMAIL_RE.test(email) || PLACEHOLDER_EMAIL.test(email)) continue;
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || email;
    const score = (r.language ? 1 : 0) + (r.country ? 1 : 0) + (r.companyId ? 1 : 0) + (r.title ? 1 : 0);
    candidates.push({
      id: r.id, email, name,
      company: r.companyName ?? null, country: r.country ?? null, language: r.language ?? null,
      companyId: r.companyId ?? null,
      companyKey: r.companyId ? `c${r.companyId}` : `d${email.split("@")[1]?.toLowerCase() ?? email}`,   // 没公司归到邮箱域
      title: r.title ?? null, createdAt: r.createdAt ?? "", score,
    });
  }
  if (!candidates.length) {
    return okResult({
      contacts: [], groupSize: 0, totalCandidates: 0, companyCount: 0,
      quota: { dailyLimit: q.dailyLimit ?? 0, sentToday: q.sentToday ?? 0, remaining, accountCount },
      languages: [],
      reasons: ["联系人库里没有从未触达的有效邮箱客户——先导入名单，或到联系人页检查"],
    });
  }

  // ② 每公司（无公司则每邮箱域）取 1 位：资料齐全度优先，同分取最早录入
  const byCompany = new Map<string, CandidateRow>();
  for (const c of candidates) {
    const cur = byCompany.get(c.companyKey);
    if (!cur || c.score > cur.score || (c.score === cur.score && c.createdAt < cur.createdAt)) byCompany.set(c.companyKey, c);
  }

  // ③ 排序：齐全度降序 → 最早录入升序（先录入的先开发），取前 N
  const ordered = [...byCompany.values()].sort((a, b) =>
    b.score - a.score || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const cap = Math.max(0, Math.min(DEV_LETTER_CAP, capOverride ?? remaining ?? DEV_LETTER_CAP));
  const picked = ordered.slice(0, cap);

  // 语言分布（展示模板匹配预期；EN/ES/PT 之外记「未标注」）
  const langCount = new Map<string, number>();
  for (const c of picked) {
    const lang = c.language && ["EN", "ES", "PT"].includes(c.language.toUpperCase()) ? c.language.toUpperCase() : "未标注";
    langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }

  const reasons = [
    `从未触达的冷客户 ${candidates.length} 位（剔除了退信/自动回复/占位邮箱）`,
    `每家公司只取 1 位（共 ${byCompany.size} 家），避免同一公司收到多封`,
    "资料齐全的优先：有语言/公司/国家的客户排前面，模板变量能填满",
    q.dailyLimit > 0
      ? `本轮上限 ${picked.length} 位（今日已发 ${q.sentToday}/${q.dailyLimit}，剩余额度内）`
      : `本轮上限 ${picked.length} 位（未设日限额，按单轮 ${DEV_LETTER_CAP} 位封顶）`,
  ];

  return okResult({
    contacts: picked.map(({ id, email, name, company, country, language }) => ({ id, email, name, company, country, language })),
    groupSize: picked.length,
    totalCandidates: candidates.length,
    companyCount: byCompany.size,
    quota: { dailyLimit: q.dailyLimit ?? 0, sentToday: q.sentToday ?? 0, remaining, accountCount },
    languages: [...langCount.entries()].map(([lang, n]) => ({ lang, n })).sort((a, b) => b.n - a.n),
    reasons,
  });
}
