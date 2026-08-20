import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { inboxMessages } from "../db/schema/inbox";
import { eq, desc, and, ne, sql as dsql } from "drizzle-orm";
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
  stage: string;            // CRM 管线阶段（tags 推导）
  sendStage: string;        // 发送阶段（contacts.stage: cold/f1..f4）
  tags: string[];
  status: string;
  reminderAt: string | null;
  lastFollowupAt: string | null;
  lastFollowupNote: string | null;
  country: string | null; language: string | null; clientType: string | null;
  assignee: string | null;
  extra: Record<string, unknown>;
  stageChangedAt: string | null;
}

export interface StageData { key: string; label: string; color: string; contacts: PipelineContact[]; }

// ── 管线列表 — 从 contacts 表直接读取 ──

export function listPipeline(): Result<StageData[]> {
  const db = getDb();
  // 进入 CRM 管线的条件：仅 status=reached（已触达）；tags 为分类，联动保证有值
  const rows = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    companyName: companies.name, companyId: contacts.companyId,
    sendStage: contacts.stage,
    tags: contacts.tags, status: contacts.status,
    extra: contacts.extra, country: contacts.country, language: contacts.language, clientType: contacts.clientType,
    assignee: contacts.assignee,
  })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(eq(contacts.status, "reached"))
    .all();

  // 最近一次跟进：一次查询全量 note，按联系人取最新一条（避免 N 次查库）
  const noteRows = db.select({
    contactId: interactions.contactId, bodyPreview: interactions.bodyPreview, createdAt: interactions.createdAt,
  }).from(interactions).where(eq(interactions.type, "note")).orderBy(desc(interactions.createdAt)).all();
  const lastNote = new Map<number, { at: string; note: string }>();
  for (const n of noteRows) {
    if (!lastNote.has(n.contactId)) lastNote.set(n.contactId, { at: n.createdAt, note: n.bodyPreview || "" });
  }

  const grouped = new Map<string, PipelineContact[]>();
  for (const r of rows) {
    const tags = parseStringArray(r.tags || "[]");
    const extra = parseJSON(r.extra || "{}");
    const reminder = extra.crmReminder as Record<string, string> | undefined;
    const stage: string = PIPE_KEYS.find(k => tags.includes(k)) || "reaching";
    const ln = lastNote.get(r.id);

    const c: PipelineContact = {
      ...r, tags, extra,
      stage,
      sendStage: r.sendStage || "cold",
      status: r.status || "",
      companyName: r.companyName || null,
      reminderAt: reminder?.nextFollowupAt || null,
      lastFollowupAt: ln?.at || null,
      lastFollowupNote: ln?.note || null,
      stageChangedAt: extra.stageChangedAt as string || null,
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

  // v4.0: 覆盖式写入 — tags 只存单个分类值（管线仅 reached 进入，反向联动已保证 status=reached）
  const now = new Date().toISOString();
  const extra = JSON.parse(contact.extra || "{}");
  extra.stageChangedAt = now;
  const set: { tags: string; updatedAt: string; extra: string; status?: string } = {
    tags: JSON.stringify([newStage]),
    updatedAt: now,
    extra: JSON.stringify(extra),
  };
  if (contact.status !== "reached") set.status = "reached";

  getDb().update(contacts).set(set as Partial<typeof contacts.$inferInsert>).where(eq(contacts.id, contactId)).run();
  saveDatabase();
  Log.debug("crm.setStage", `${contactId} → ${newStage}`);
  return okResult(undefined);
}

// ── 设置提醒 — 更新 contacts.extra ──

/** 写入跟进记录（interactions type=note），CRM 跟进 Tab 与 Dashboard 可见。 */
export function addNote(contactId: number, text: string): Result<void> {
  if (!Number.isInteger(contactId) || contactId <= 0) return failResult("无效的 ID");
  if (!text?.trim()) return failResult("内容不能为空");
  getDb().insert(interactions).values({
    contactId, type: "note", direction: "internal", channel: "manual",
    bodyPreview: text, createdAt: new Date().toISOString(),
  }).run();
  saveDatabase();
  return okResult(undefined);
}

export async function setReminder(contactId: number, reminderAt: string, note?: string): Promise<Result<void>> {
  const contact = getDb().select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) return failResult("联系人不存在");

  const extra = parseJSON(contact.extra || "{}");
  extra.crmReminder = { nextFollowupAt: reminderAt };

  const now = new Date().toISOString();
  getDb().update(contacts).set({
    extra: JSON.stringify(extra),
    updatedAt: now,
  }).where(eq(contacts.id, contactId)).run();

  // 跟进记录写入 interactions 表，CRM 跟进 Tab 与 Dashboard 最近活动即时可见
  if (note) {
    getDb().insert(interactions).values({
      contactId, type: "note", direction: "internal", channel: "manual",
      bodyPreview: note, createdAt: now,
    }).run();
  }
  saveDatabase();
  return okResult(undefined);
}

// ── 清除提醒 ──

export function clearReminder(contactId: number): Result<void> {
  const contact = getDb().select().from(contacts).where(eq(contacts.id, contactId)).get();
  if (!contact) return failResult("联系人不存在");
  const raw = contact.extra || "{}";
  const extraObj = JSON.parse(raw);
  delete extraObj.crmReminder;
  const newExtra = JSON.stringify(extraObj);
  const now = new Date().toISOString();
  // 用 raw SQL 避免 Drizzle 类型问题
  getDb().update(contacts).set({
    extra: newExtra,
    updatedAt: now,
  } as Partial<typeof contacts.$inferInsert>).where(eq(contacts.id, contactId)).run();
  saveDatabase();
  Log.debug("crm.clearReminder", `contactId=${contactId} extra=${newExtra}`);
  return okResult(undefined);
}

// ── 删除跟进记录 ──

export function deleteNote(interactionId: number): Result<void> {
  if (!Number.isInteger(interactionId) || interactionId <= 0) return failResult("无效的 ID");
  const existing = getDb().select().from(interactions).where(eq(interactions.id, interactionId)).get();
  if (!existing) return failResult("记录不存在");
  if (existing.type !== "note") return failResult("只能删除手动添加的跟进记录");
  getDb().delete(interactions).where(eq(interactions.id, interactionId)).run();
  saveDatabase();
  Log.debug("crm.deleteNote", `interactionId=${interactionId}`);
  return okResult(undefined);
}

// ── 编辑跟进记录（interactions.bodyPreview）──

export async function updateNote(interactionId: number, text: string): Promise<Result<void>> {
  if (!Number.isInteger(interactionId) || interactionId <= 0) return failResult("无效的 ID");
  const existing = getDb().select().from(interactions).where(eq(interactions.id, interactionId)).get();
  if (!existing) return failResult("记录不存在");
  if (!text?.trim()) return failResult("内容不能为空");

  getDb().update(interactions).set({ bodyPreview: text.trim() })
    .where(eq(interactions.id, interactionId)).run();
  saveDatabase();
  return okResult(undefined);
}

// ── 详情 ──

export function getDetail(contactId: number): Result<{
  contact: PipelineContact | null;
  interactions: Array<{ type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string }>;
  emails: Array<{ id: number | null; fromEmail: string; direction: "inbound" | "outbound"; subject: string | null; classification: string | null; receivedAt: string; bodyPreview: string | null }>;
}> {
  const db = getDb();
  const row = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    companyName: companies.name, companyId: contacts.companyId,
    sendStage: contacts.stage,
    tags: contacts.tags, status: contacts.status,
    extra: contacts.extra, country: contacts.country, language: contacts.language, clientType: contacts.clientType,
    assignee: contacts.assignee,
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
    sendStage: row.sendStage || "cold",
    status: row.status || "",
    reminderAt: reminder?.nextFollowupAt || null,
    lastFollowupAt: null,
    lastFollowupNote: null,
    stageChangedAt: extra.stageChangedAt as string || null,
  } : null;

  const interactionRows = db.select().from(interactions)
    .where(eq(interactions.contactId, contactId))
    .orderBy(desc(interactions.createdAt)).limit(50).all();

  // 最近一次跟进（interactionRows 已按时间倒序，取第一条 note）
  const lastNoteRow = interactionRows.find(i => i.type === "note");
  if (contact && lastNoteRow) {
    contact.lastFollowupAt = lastNoteRow.createdAt;
    contact.lastFollowupNote = lastNoteRow.bodyPreview || null;
  }

  // 收件（IMAP/POP3）— 排除 sent（发件单独从 inbox_messages 取，方向 outbound）
  const inboxRows = db.select().from(inboxMessages)
    .where(and(eq(inboxMessages.matchedContactId, contactId), ne(inboxMessages.classification, "sent")))
    .orderBy(desc(inboxMessages.receivedAt)).limit(30).all()
    .map(e => ({
      id: e.id, fromEmail: e.fromEmail, direction: "inbound" as const, subject: e.subject,
      classification: e.classification, receivedAt: e.receivedAt,
      bodyPreview: e.bodyPreview,
    }));

  // 发件 — 从 inbox_messages（classification=sent）取，带 id 供前端懒加载完整正文
  const sentRows = db.select().from(inboxMessages)
    .where(and(eq(inboxMessages.matchedContactId, contactId), eq(inboxMessages.classification, "sent")))
    .orderBy(desc(inboxMessages.receivedAt)).limit(30).all()
    .map(e => ({
      id: e.id, fromEmail: e.fromEmail, direction: "outbound" as const,
      subject: e.subject, classification: "sent" as const,
      receivedAt: e.receivedAt, bodyPreview: e.bodyPreview,
    }));

  // 合并：收件 + 发件，按时间倒序
  const emailRows = [...inboxRows, ...sentRows]
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    .slice(0, 50);

  return okResult({ contact, interactions: interactionRows, emails: emailRows });
}

// ── 提醒检查 ──

export interface ReminderContact extends PipelineContact { followupNote: string | null; }

export function checkReminders(): Result<{ due: ReminderContact[]; overdue: ReminderContact[] }> {
  const db = getDb();
  const rows = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    companyName: companies.name,
    extra: contacts.extra, status: contacts.status,
    tags: contacts.tags, country: contacts.country, language: contacts.language, clientType: contacts.clientType,
    assignee: contacts.assignee,
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
      extra, stage: "reaching", sendStage: "cold", tags: [],
      status: r.status || "",
      reminderAt: reminder.nextFollowupAt,
      lastFollowupAt: null, lastFollowupNote: null,
      stageChangedAt: extra.stageChangedAt as string || null,
      title: null, phone: null, linkedinUrl: null,
    };

    if (reminder.nextFollowupAt <= now) overdue.push(c);
    else if (reminder.nextFollowupAt <= tomorrow) due.push(c);
  }

  // 补充每个待跟进联系人的最近一条跟进记录
  const withNotes = (list: PipelineContact[]): ReminderContact[] => list.map(c => {
    const note = db.select({ bodyPreview: interactions.bodyPreview })
      .from(interactions)
      .where(and(eq(interactions.contactId, c.id), eq(interactions.type, "note")))
      .orderBy(desc(interactions.createdAt)).limit(1).get();
    return { ...c, followupNote: note?.bodyPreview || null };
  });

  return okResult({ due: withNotes(due), overdue: withNotes(overdue) });
}

// ── 工具 ──

function parseStringArray(v: string): string[] {
  try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
}
function parseJSON(v: string): Record<string, unknown> {
  try { const r = JSON.parse(v); return typeof r === "object" && r !== null ? r : {}; } catch { return {}; }
}
