import { getDb } from "../db";
import { crmStages, crmRelations, type CrmStageRow, type CrmRelationRow } from "../db/schema/crm";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { eq } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

export const STAGES = ["new", "contacted", "replied", "interested", "negotiating", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageWithContacts {
  stage: Stage;
  contacts: Array<{
    id: number;
    email: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    notes: string | null;
    reminderAt: string | null;
  }>;
}

export async function listPipeline(): Promise<Result<StageWithContacts[]>> {
  Log.debug("crm.listPipeline", "");

  const db = getDb();

  // JOIN crm_stages + contacts + companies
  const rows = db.select({
    stageId: crmStages.id,
    contactId: contacts.id,
    email: contacts.email,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    companyName: companies.name,
    stage: crmStages.stage,
    notes: crmStages.notes,
    reminderAt: crmStages.reminderAt,
  })
    .from(crmStages)
    .innerJoin(contacts, eq(crmStages.contactId, contacts.id))
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .all();

  // 按阶段分组
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const stage = row.stage || "new";
    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage)!.push(row);
  }

  const result: StageWithContacts[] = STAGES.map(stage => ({
    stage,
    contacts: (grouped.get(stage) || []).map(r => ({
      id: r.contactId,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      companyName: r.companyName,
      notes: r.notes,
      reminderAt: r.reminderAt,
    })),
  }));

  return okResult(result);
}

export async function setStage(contactId: number, stage: string): Promise<Result<void>> {
  Log.debug("crm.setStage", `contactId=${contactId} stage=${stage}`);

  if (!STAGES.includes(stage as Stage)) {
    return failResult(`无效的阶段: ${stage}，有效值: ${STAGES.join(", ")}`);
  }

  const existing = getDb().select().from(crmStages)
    .where(eq(crmStages.contactId, contactId)).get();

  const now = new Date().toISOString();

  if (existing) {
    getDb().update(crmStages).set({ stage, updatedAt: now })
      .where(eq(crmStages.id, existing.id)).run();
  } else {
    getDb().insert(crmStages).values({ contactId, stage, updatedAt: now }).run();
  }

  saveDatabase();
  return okResult(undefined);
}

export async function addReminder(contactId: number, reminderAt: string, note?: string): Promise<Result<void>> {
  Log.debug("crm.addReminder", `contactId=${contactId} at=${reminderAt}`);

  const existing = getDb().select().from(crmStages)
    .where(eq(crmStages.contactId, contactId)).get();

  if (!existing) {
    // 没有 stage 记录，创建一个
    const now = new Date().toISOString();
    getDb().insert(crmStages).values({
      contactId, stage: "contacted", reminderAt, reminderNote: note, updatedAt: now,
    }).run();
  } else {
    getDb().update(crmStages).set({ reminderAt, reminderNote: note })
      .where(eq(crmStages.id, existing.id)).run();
  }

  saveDatabase();
  return okResult(undefined);
}

export async function listRelations(contactId: number): Promise<Result<CrmRelationRow[]>> {
  Log.debug("crm.listRelations", `contactId=${contactId}`);

  const db = getDb();
  const relations = db.select().from(crmRelations)
    .where(eq(crmRelations.contactIdA, contactId))
    .all();

  // 也查反向关系
  const reverse = db.select().from(crmRelations)
    .where(eq(crmRelations.contactIdB, contactId))
    .all();

  return okResult([...relations, ...reverse]);
}
