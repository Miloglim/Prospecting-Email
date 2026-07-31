import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts";

export const crmStages = sqliteTable("crm_stages", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  contactId:   integer("contact_id").references(() => contacts.id).notNull().unique(),
  stage:       text("stage").notNull(),
  notes:       text("notes"),
  reminderAt:  text("reminder_at"),
  reminderNote: text("reminder_note"),
  updatedAt:   text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const crmRelations = sqliteTable("crm_relations", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  contactIdA:   integer("contact_id_a").references(() => contacts.id).notNull(),
  contactIdB:   integer("contact_id_b").references(() => contacts.id).notNull(),
  relationType: text("relation_type").notNull(),
  createdAt:    text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type CrmStageRow = typeof crmStages.$inferSelect;
export type CrmRelationRow = typeof crmRelations.$inferSelect;
