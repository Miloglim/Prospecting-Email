import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const companies = sqliteTable("companies", {
  id:            integer("id").primaryKey({ autoIncrement: true }),
  name:          text("name").notNull(),
  domain:        text("domain"),
  industry:      text("industry"),
  country:       text("country"),
  size:          text("size"),
  backcheckData: text("backcheck_data"),
  createdAt:     text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:     text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type CompanyRow = typeof companies.$inferSelect;
export type InsertCompanyRow = typeof companies.$inferInsert;
