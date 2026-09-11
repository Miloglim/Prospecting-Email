// ── 自动开发信：推荐群组（确定性规则，无模型参与）──────────────────────
// 用户口径：群组是"agent 提前设置好的"——规则固定、可解释、零延迟；人只做两个动作：看推荐、点确定。
// 推荐逻辑（docs/home-cards-spec.md §2 + docs/task-card-devletter-spec.md §2）：
//   真·从未触达（status 空 + 无 sent 交互 + stage 仍 cold）+ 邮箱有效 + 剔占位邮箱
//   + 不在未完结任务（draft/running/paused）名单里 → 每公司取 1 位（资料齐全度优先，同分取最早录入）
//   → 按齐全度降序取前 N：用户点名了数量就以它为准（只受日限额剩余与候选池夹），没点名时 N = min(候选数, 日限额剩余, 50)。
//   旧口径只看 status 空——发过信的人 status 也是空（只推进 stage），于是同一批人被反复推荐、重复建任务。
// 红线：只产生"推荐 + 名单"，绝不入队、绝不发送——入队/发送决策在发送界面由人完成。
import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { emailAccounts } from "../db/schema/accounts";
import { sendCampaigns, sendCampaignTargets } from "../db/schema";
import { sql as dsql } from "drizzle-orm";
import { loadConfig } from "../config";
import { okResult, type Result } from "../errors";
import { countryMatchWords } from "./country-alias";
import { describeCriteria, type DevLetterCriteria } from "./dev-letter-intent";

export interface DevLetterContact {
  id: number; email: string; name: string;
  company: string | null; country: string | null; language: string | null;
}

export interface DevLetterRecommendation {
  contacts: DevLetterContact[];
  groupSize: number;
  totalCandidates: number;
  companyCount: number;
  /** 已归属未完结任务（draft/running/paused）的人数——不默默少人，界面要报出来 */
  excludedInCampaign: number;
  /** 这次实际生效的用户要求（解析来源一并带上，界面要如实说"AI 理解"还是"关键词理解"） */
  applied: DevLetterCriteria;
  quota: { dailyLimit: number; sentToday: number; remaining: number | null; accountCount: number };
  languages: Array<{ lang: string; n: number }>;
  reasons: string[];
}

/** 默认一批推荐上限：用户没在要求里点名数量时用它兜底（广撒也要有边界）。
 *  用户点了数量就不受此值限制，只受日限额剩余与候选池约束（见下方 want/cap 计算）。 */
export const DEV_LETTER_CAP = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 占位/无效邮箱不发（一个坏地址会让整组 BCC 被拒收） */
const PLACEHOLDER_EMAIL = /no\.email|noreply|no-reply|example\.com|test@|@test|null@/i;

interface CandidateRow extends DevLetterContact {
  companyId: number | null;
  companyKey: string;
  title: string | null;
  createdAt: string;
  stage: string;          // 冷/跟进阶段（§4 的确定性过滤要用）
  clientType: string;     // 直客/代理/同行/通用（同上）
  score: number;          // 资料齐全度 0..4
}

/**
 * 推荐开发群组。纯读，不写库、不入队。
 * @param capOverride 测试/未来 UI 用的上限覆盖；默认 DEV_LETTER_CAP 与限额取小
 * @param criteria 用户那句要求解析出的结构化筛选（规范 §4）：只收窄候选，选人与排序规则一字不改
 */
export function recommendDevLetterGroup(
  capOverride?: number, now: Date = new Date(), criteria?: DevLetterCriteria,
): Result<DevLetterRecommendation> {
  const db = getDb();
  const cfg = loadConfig();
  const q = cfg.sendQuota || { dailyLimit: 0, sentToday: 0 };
  const remaining = q.dailyLimit > 0 ? Math.max(0, q.dailyLimit - q.sentToday) : null;
  const accountCount = db.select({ n: dsql<number>`count(*)` }).from(emailAccounts)
    .where(dsql`coalesce(${emailAccounts.isActive}, 0) = 1`).get()?.n ?? 0;

  // ① 候选：真·从未触达。口径与 getPickerStats().neverIds 对齐（status 空 + 无 sent 交互），再加
  //    stage 仍是 cold —— 旧口径只看 status，而发送成功只写 sent 交互并推进 stage（send.service.ts:1247/1263），
  //    status 一直是空，于是同一批人被反复推荐、用户重复建任务（规范 §2 根因）。
  //    已归属未完结任务（draft/running/paused 且触点 pending/queued）的人一并剔除；
  //    done/stopped 任务里的人照常可再开发。
  const rows = db.select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    companyId: contacts.companyId, country: contacts.country, language: contacts.language,
    title: contacts.title, createdAt: contacts.createdAt,
    stage: contacts.stage, clientType: contacts.clientType,
    companyName: dsql<string | null>`(select name from companies where companies.id = ${contacts.companyId})`,
  }).from(contacts)
    .where(dsql`coalesce(${contacts.status}, '') = ''
      AND coalesce(${contacts.stage}, 'cold') = 'cold'
      AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.contact_id = contacts.id AND i.type = 'sent')
      AND NOT EXISTS (
        SELECT 1 FROM send_campaign_targets t JOIN send_campaigns c ON c.id = t.campaign_id
        WHERE t.contact_id = contacts.id AND t.status IN ('pending','queued')
          AND c.status IN ('draft','running','paused'))`)
    .all();

  // 被"已在任务里"剔掉的人数（不默默少人：界面要能回答"我库里还有人在跑"）
  const excludedInCampaign = db.select({ n: dsql<number>`count(distinct ${sendCampaignTargets.contactId})` })
    .from(sendCampaignTargets)
    .innerJoin(sendCampaigns, dsql`${sendCampaigns.id} = ${sendCampaignTargets.campaignId}`)
    .where(dsql`${sendCampaignTargets.status} IN ('pending','queued')
      AND ${sendCampaigns.status} IN ('draft','running','paused')`)
    .get()?.n ?? 0;

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
      title: r.title ?? null, createdAt: r.createdAt ?? "",
      stage: r.stage || "cold", clientType: r.clientType || "general", score,
    });
  }
  const applied: DevLetterCriteria = criteria ?? { parsedBy: "none" };
  const noCandidates = (reason: string): Result<DevLetterRecommendation> => okResult({
    contacts: [], groupSize: 0, totalCandidates: 0, companyCount: 0,
    excludedInCampaign, applied,
    quota: { dailyLimit: q.dailyLimit ?? 0, sentToday: q.sentToday ?? 0, remaining, accountCount },
    languages: [], reasons: [reason],
  });
  if (!candidates.length) {
    return noCandidates(excludedInCampaign > 0
      ? `库里没有可新开发的冷客户了——另有 ${excludedInCampaign} 位正在未完结的任务里跟进，完成或终止后可以再开发`
      : "联系人库里没有从未触达的有效邮箱客户——先导入名单，或到联系人页检查");
  }

  // ② 用户要求（规范 §4）：确定性收窄——只从冷客户池里筛掉不符合的，选人与排序规则一字不改
  const words = criteria?.country ? countryMatchWords(criteria.country) : [];
  const pool = candidates.filter(c => {
    if (words.length) {
      const hay = (c.country ?? "").toLowerCase();
      if (!hay || !words.some(w => hay.includes(w) || w.includes(hay))) return false;
    }
    if (criteria?.language && (c.language ?? "").toUpperCase() !== criteria.language.toUpperCase()) return false;
    if (criteria?.clientType && (c.clientType ?? "general") !== criteria.clientType) return false;
    return true;
  });
  if (!pool.length) {
    return okResult({
      contacts: [], groupSize: 0, totalCandidates: candidates.length, companyCount: 0,
      excludedInCampaign, applied,
      quota: { dailyLimit: q.dailyLimit ?? 0, sentToday: q.sentToday ?? 0, remaining, accountCount },
      languages: [],
      // 两种空集要做的事完全不同，必须分开说：这是"按这个要求没人"，不是"库里没冷客户"
      reasons: [`按「${describeCriteria(criteria)}」没筛到人——库里另有 ${candidates.length} 位从未触达的冷客户不满足这个条件，放宽一条再来`],
    });
  }

  // ③ 每公司（无公司则每邮箱域）取 1 位：资料齐全度优先，同分取最早录入
  const byCompany = new Map<string, CandidateRow>();
  for (const c of pool) {
    const cur = byCompany.get(c.companyKey);
    if (!cur || c.score > cur.score || (c.score === cur.score && c.createdAt < cur.createdAt)) byCompany.set(c.companyKey, c);
  }

  // ④ 排序：齐全度降序 → 最早录入升序（先录入的先开发），取前 N
  //    人数口径：用户在那句话里点名了数量（criteria.limit）就以它为准，只再受「日限额剩余」与
  //    「符合条件的候选池」两道天然上限夹一次，不再写死 50；没点名时才走默认一批 DEV_LETTER_CAP。
  const want = criteria?.limit ?? capOverride;
  const cap = Math.max(0, want != null
    ? Math.min(want, remaining ?? want)
    : Math.min(DEV_LETTER_CAP, remaining ?? DEV_LETTER_CAP));
  const ordered = [...byCompany.values()].sort((a, b) =>
    b.score - a.score || a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const picked = ordered.slice(0, cap);

  // 语言分布（展示模板匹配预期；EN/ES/PT 之外记「未标注」）
  const langCount = new Map<string, number>();
  for (const c of picked) {
    const lang = c.language && ["EN", "ES", "PT"].includes(c.language.toUpperCase()) ? c.language.toUpperCase() : "未标注";
    langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }

  const quotaReason = want != null
    ? (picked.length >= want
      ? `本轮按你说的取 ${picked.length} 位`
      : `你要 ${want} 位，但${remaining != null && remaining < want ? `今日剩余额度只有 ${remaining} 位` : "符合条件的冷客户不足"}，本轮取 ${picked.length} 位`)
    : q.dailyLimit > 0
      ? `默认先给 ${picked.length} 位（今日已发 ${q.sentToday}/${q.dailyLimit}，在剩余额度内；想多要，在那句要求里写人数即可）`
      : `默认先给 ${picked.length} 位（未设日限额，默认一批 ${DEV_LETTER_CAP} 位封顶；想多要，在那句要求里写人数即可）`;

  const reasons = [
    ...(criteria
      ? [`按「${describeCriteria(criteria)}」从 ${pool.length} 位从未触达的冷客户里筛出（发过信的、退信/自动回复与占位邮箱都已剔除）`]
      : [`从未触达的冷客户 ${pool.length} 位（剔除了发过信的、退信/自动回复与占位邮箱）`]),
    `每家公司只取 1 位（共 ${byCompany.size} 家），避免同一公司收到多封`,
    "资料齐全的优先：有语言/公司/国家的客户排前面，模板变量能填满",
    quotaReason,
    ...(criteria?.note ? [`另记：${criteria.note}`] : []),
    ...(excludedInCampaign > 0
      ? [`另有 ${excludedInCampaign} 位已在进行中的任务里，本次不重复推荐（防重复建任务）`] : []),
  ];

  return okResult({
    contacts: picked.map(({ id, email, name, company, country, language }) => ({ id, email, name, company, country, language })),
    groupSize: picked.length,
    totalCandidates: pool.length,
    companyCount: byCompany.size,
    excludedInCampaign,
    applied,
    quota: { dailyLimit: q.dailyLimit ?? 0, sentToday: q.sentToday ?? 0, remaining, accountCount },
    languages: [...langCount.entries()].map(([lang, n]) => ({ lang, n })).sort((a, b) => b.n - a.n),
    reasons,
  });
}
