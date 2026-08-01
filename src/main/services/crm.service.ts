import { getDb } from "../db";
import { crmStages } from "../db/schema/crm";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { interactions } from "../db/schema/interactions";
import { inboxMessages } from "../db/schema/inbox";
import { eq, desc, sql as dsql, inArray } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

// ── 阶段定义（沿用旧 PE）──

export const STAGES = [
  { key: "reaching", label: "触达中", color: "#ff9800" },
  { key: "quoting", label: "报价中", color: "#2196f3" },
  { key: "trial", label: "试单", color: "#8e24aa" },
  { key: "cooperating", label: "合作中", color: "#4caf50" },
  { key: "lost", label: "已流失", color: "#b0b0b0" },
  { key: "other", label: "其他", color: "#333333" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export interface PipelineContact {
  id: number; email: string; firstName: string | null; lastName: string | null;
  title: string | null; phone: string | null; linkedinUrl: string | null;
  companyName: string | null; companyId: number | null;
  stage: string; notes: string | null;
  reminderAt: string | null; reminderNote: string | null;
  country: string | null; clientType: string | null;
}

export interface StageWithContacts {
  key: string; label: string; color: string; contacts: PipelineContact[];
}

export async function listPipeline(): Promise<Result<StageWithContacts[]>> {
  const db = getDb();
  const rows = db.select({
    contactId: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    companyName: companies.name, companyId: contacts.companyId,
    stage: crmStages.stage, notes: crmStages.notes,
    reminderAt: crmStages.reminderAt, reminderNote: crmStages.reminderNote,
    country: contacts.country, clientType: contacts.clientType,
  }).from(crmStages)
    .innerJoin(contacts, eq(crmStages.contactId, contacts.id))
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .all();

  const grouped = new Map<string, PipelineContact[]>();
  for (const r of rows) {
    const stage = r.stage || "reaching";
    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage)!.push({ ...r, id: r.contactId });
  }

  const result = STAGES.map(s => ({
    ...s,
    contacts: grouped.get(s.key) || [],
  }));

  return okResult(result);
}

export async function setStage(contactId: number, stage: string): Promise<Result<void>> {
  if (!STAGES.find(s => s.key === stage)) return failResult(`无效阶段: ${stage}`);
  const existing = getDb().select().from(crmStages).where(eq(crmStages.contactId, contactId)).get();
  const now = new Date().toISOString();
  if (existing) {
    getDb().update(crmStages).set({ stage, updatedAt: now }).where(eq(crmStages.id, existing.id)).run();
  } else {
    getDb().insert(crmStages).values({ contactId, stage, updatedAt: now }).run();
  }
  saveDatabase();
  return okResult(undefined);
}

export async function addReminder(contactId: number, reminderAt: string, note?: string): Promise<Result<void>> {
  const existing = getDb().select().from(crmStages).where(eq(crmStages.contactId, contactId)).get();
  const now = new Date().toISOString();
  if (existing) {
    getDb().update(crmStages).set({ reminderAt, reminderNote: note }).where(eq(crmStages.id, existing.id)).run();
  } else {
    getDb().insert(crmStages).values({ contactId, stage: "reaching", reminderAt, reminderNote: note, updatedAt: now }).run();
  }
  saveDatabase();
  return okResult(undefined);
}

// 获取联系人详情（含互动历史）
export async function getDetail(contactId: number): Promise<Result<{
  contact: PipelineContact | null;
  interactions: Array<{ type: string; direction: string; subject: string | null; bodyPreview: string | null; createdAt: string }>;
  emails: Array<{ fromEmail: string; subject: string | null; classification: string | null; receivedAt: string }>;
}>> {
  const contact = getDb().select({
    contactId: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, linkedinUrl: contacts.linkedinUrl,
    companyName: companies.name, companyId: contacts.companyId,
    stage: crmStages.stage, notes: crmStages.notes,
    reminderAt: crmStages.reminderAt, reminderNote: crmStages.reminderNote,
    country: contacts.country, clientType: contacts.clientType,
  }).from(contacts)
    .leftJoin(crmStages, eq(contacts.id, crmStages.contactId))
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(eq(contacts.id, contactId)).get();

  const interactionRows = getDb().select().from(interactions)
    .where(eq(interactions.contactId, contactId))
    .orderBy(desc(interactions.createdAt)).limit(50).all();

  const emailRows = getDb().select().from(inboxMessages)
    .where(eq(inboxMessages.matchedContactId, contactId))
    .orderBy(desc(inboxMessages.receivedAt)).limit(30).all();

  return okResult({
    contact: contact && contact.contactId != null ? {
      id: contact.contactId, email: contact.email,
      firstName: contact.firstName, lastName: contact.lastName,
      title: contact.title, phone: contact.phone, linkedinUrl: contact.linkedinUrl,
      companyName: contact.companyName, companyId: contact.companyId,
      stage: contact.stage || "reaching", notes: contact.notes,
      reminderAt: contact.reminderAt, reminderNote: contact.reminderNote,
      country: contact.country, clientType: contact.clientType,
    } : null,
    interactions: interactionRows,
    emails: emailRows,
  });
}

// 检查提醒
export function checkReminders(): Result<{ due: PipelineContact[]; overdue: PipelineContact[] }> {
  const db = getDb();
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 86400000).toISOString();

  const rows = db.select({
    contactId: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    companyName: companies.name,
    stage: crmStages.stage, notes: crmStages.notes,
    reminderAt: crmStages.reminderAt, reminderNote: crmStages.reminderNote,
  }).from(crmStages)
    .innerJoin(contacts, eq(crmStages.contactId, contacts.id))
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .all();

  const due: PipelineContact[] = [];
  const overdue: PipelineContact[] = [];

  for (const r of rows) {
    if (!r.reminderAt) continue;
    const c: PipelineContact = {
      id: r.contactId, email: r.email, firstName: r.firstName, lastName: r.lastName,
      title: null, phone: null, linkedinUrl: null,
      companyName: r.companyName, companyId: null,
      stage: r.stage || "reaching", notes: r.notes,
      reminderAt: r.reminderAt, reminderNote: r.reminderNote,
      country: null, clientType: null,
    };

    if (r.reminderAt <= now) overdue.push(c);
    else if (r.reminderAt <= tomorrow) due.push(c);
  }

  return okResult({ due, overdue });
}

// ponytail: 关系图暂不实现完整 D3，保留接口
export async function listRelations(contactId: number): Promise<Result<unknown[]>> {
  const db = getDb();
  const rows = db.select().from(contacts)
    .where(eq(contacts.companyId, contactId)).limit(20).all();
  return okResult(rows);
}
