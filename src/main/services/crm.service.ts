import { getDb } from "../db";
import { contacts, type ContactRow } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { inboxMessages } from "../db/schema/inbox";
import { eq, desc, or, sql as dsql } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

// ── 阶段定义 ──
export const STAGES = [
  { key: "reaching", label: "触达中", color: "#ff9800" },
  { key: "quoting", label: "报价中", color: "#2196f3" },
  { key: "trial", label: "试单", color: "#8e24aa" },
  { key: "cooperating", label: "合作中", color: "#4caf50" },
  { key: "lost", label: "已流失", color: "#b0b0b0" },
  { key: "other", label: "其他", color: "#333333" },
] as const;
const PIPE_KEYS = STAGES.map(s => s.key);

export interface PipelineContact {
  id: number; email: string; firstName: string | null; lastName: string | null;
  title: string | null; phone: string | null; linkedinUrl: string | null;
  companyName: string | null; companyId: number | null;
  stage: string; tags: string[];
  status: string; isBounced: number;
  reminderAt: string | null; followupNote: string | null;
  country: string | null; clientType: string | null;
  extra: Record<string, unknown>;
}

export interface StageData { key: string; label: string; color: string; contacts: PipelineContact[]; }

// ── 管线列表 — 从 contacts 表直接读取 ──

export function listPipeline(): Result<StageData[]> {
  const db = getDb();
  // 进入 CRM 管线的条件：status 是 replied 或 reached
  const rows = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    companyName: companies.name, companyId: contacts.companyId,
    tags: contacts.tags, status: contacts.status, isBounced: contacts.isBounced,
    extra: contacts.extra, country: contacts.country, clientType: contacts.clientType,
    followupNote: contacts.followupNote,
  })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(or(eq(contacts.status, "replied"), eq(contacts.status, "reached")))
    .all();

  const grouped = new Map<string, PipelineContact[]>();
  for (const r of rows) {
    const tags = parseStringArray(r.tags || "[]");
    const extra = parseJSON(r.extra || "{}");
    const reminder = extra.crmReminder as Record<string, string> | undefined;
    const stage: string = PIPE_KEYS.find(k => tags.includes(k)) || "reaching";

    const c: PipelineContact = {
      ...r, tags, extra,
      stage, status: r.status || "", isBounced: r.isBounced || 0,
      companyName: r.companyName || null,
      reminderAt: reminder?.nextFollowupAt || null,
      followupNote: r.followupNote || null,
    };

    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage)!.push(c);
  }

  return okResult(STAGES.map(s => ({
    ...s,
    contacts: grouped.get(s.key) || [],
  })));
}

// ── 切换 CRM 阶段 — 更新 contacts.tags ──

export async function setStage(contactId: number, newStage: string): Promise<Result<void>> {
  if (!(PIPE_KEYS as readonly string[]).includes(newStage)) return failResult("无效阶段");
  const contact = getDb().select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) return failResult("联系人不存在");

  const oldTags = parseStringArray(contact.tags || "[]");
  const newTags = [...oldTags.filter(t => !(PIPE_KEYS as readonly string[]).includes(t)), newStage];
  const now = new Date().toISOString();

  getDb().update(contacts).set({
    tags: JSON.stringify(newTags),
    updatedAt: now,
  }).where(eq(contacts.id, contactId)).run();
  saveDatabase();
  Log.debug("crm.setStage", `${contactId} → ${newStage}`);
  return okResult(undefined);
}

// ── 设置提醒 — 更新 contacts.extra ──

export async function setReminder(contactId: number, reminderAt: string, note?: string): Promise<Result<void>> {
  const contact = getDb().select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) return failResult("联系人不存在");

  const extra = parseJSON(contact.extra || "{}");
  extra.crmReminder = { nextFollowupAt: reminderAt };

  const now = new Date().toISOString();
  getDb().update(contacts).set({
    extra: JSON.stringify(extra),
    followupNote: note || contact.followupNote,
    updatedAt: now,
  }).where(eq(contacts.id, contactId)).run();
  saveDatabase();
  return okResult(undefined);
}

// ── 详情 ──

export function getDetail(contactId: number): Result<{
  contact: PipelineContact | null;
  interactions: Array<{ type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string }>;
  emails: Array<{ fromEmail: string; subject: string | null; classification: string | null; receivedAt: string; bodyPreview: string | null }>;
}> {
  const db = getDb();
  const row = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    companyName: companies.name, companyId: contacts.companyId,
    tags: contacts.tags, status: contacts.status, isBounced: contacts.isBounced,
    extra: contacts.extra, country: contacts.country, clientType: contacts.clientType,
    followupNote: contacts.followupNote,
  })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(eq(contacts.id, contactId)).get();

  const tags = parseStringArray(row?.tags || "[]");
  const extra = parseJSON(row?.extra || "{}");
  const reminder = extra.crmReminder as Record<string, string> | undefined;

  const contact: PipelineContact | null = row ? {
    ...row, tags, extra, companyName: row.companyName || null,
    stage: PIPE_KEYS.find(k => tags.includes(k)) || "reaching",
    status: row.status || "", isBounced: row.isBounced || 0,
    reminderAt: reminder?.nextFollowupAt || null,
    followupNote: row.followupNote || null,
  } : null;

  const interactionRows = db.select().from(interactions)
    .where(eq(interactions.contactId, contactId))
    .orderBy(desc(interactions.createdAt)).limit(50).all();

  const emailRows = db.select().from(inboxMessages)
    .where(eq(inboxMessages.matchedContactId, contactId))
    .orderBy(desc(inboxMessages.receivedAt)).limit(30).all()
    .map(e => ({
      fromEmail: e.fromEmail, subject: e.subject,
      classification: e.classification, receivedAt: e.receivedAt,
      bodyPreview: e.bodyPreview,
    }));

  return okResult({ contact, interactions: interactionRows, emails: emailRows });
}

// ── 提醒检查 ──

export function checkReminders(): Result<{ due: PipelineContact[]; overdue: PipelineContact[] }> {
  const db = getDb();
  const rows = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    companyName: companies.name,
    extra: contacts.extra, status: contacts.status, isBounced: contacts.isBounced,
    tags: contacts.tags, country: contacts.country, clientType: contacts.clientType,
    followupNote: contacts.followupNote,
  }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id)).all();

  const now = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const due: PipelineContact[] = [];
  const overdue: PipelineContact[] = [];

  for (const r of rows) {
    const extra = parseJSON(r.extra || "{}");
    const reminder = extra.crmReminder as Record<string, string> | undefined;
    if (!reminder?.nextFollowupAt) continue;

    const c: PipelineContact = {
      ...r, companyName: r.companyName || null, companyId: null,
      extra, stage: "reaching", tags: [],
      status: r.status || "", isBounced: r.isBounced || 0,
      reminderAt: reminder.nextFollowupAt, followupNote: r.followupNote || null,
      title: null, phone: null, linkedinUrl: null,
    };

    if (reminder.nextFollowupAt <= now) overdue.push(c);
    else if (reminder.nextFollowupAt <= tomorrow) due.push(c);
  }

  return okResult({ due, overdue });
}

// ponytail: 关系 — 查同公司联系人
export function listRelations(contactId: number): Result<ContactRow[]> {
  const contact = getDb().select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact?.companyId) return okResult([]);
  const rows = getDb().select().from(contacts).where(eq(contacts.companyId, contact.companyId)).limit(20).all();
  return okResult(rows);
}

// ── 工具 ──

function parseStringArray(v: string): string[] {
  try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
}
function parseJSON(v: string): Record<string, unknown> {
  try { const r = JSON.parse(v); return typeof r === "object" && r !== null ? r : {}; } catch { return {}; }
}
