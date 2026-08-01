import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const contacts = sqliteTable("contacts", {
  id:           integer("id").primaryKey({ autoIncrement: true }),
  email:        text("email").notNull().unique(),
  firstName:    text("first_name"),
  lastName:     text("last_name"),
  title:        text("title"),
  phone:        text("phone"),
  linkedinUrl:  text("linkedin_url"),
  companyId:    integer("company_id"),
  country:      text("country"),           // EN/ES/PT — 沟通语言偏好
  clientType:   text("client_type"),       // agent / direct
  source:       text("source").default("manual"), // manual / import
  sourceDetail: text("source_detail"),
  createdAt:    text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:    text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type ContactRow = typeof contacts.$inferSelect;
export type InsertContactRow = typeof contacts.$inferInsert;
