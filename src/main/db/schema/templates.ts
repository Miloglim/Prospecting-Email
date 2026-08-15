import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const templates = sqliteTable("templates", {
  id:        integer("id").primaryKey({ autoIncrement: true }),
  name:      text("name").notNull(),
  language:  text("language").notNull(),
  subject:   text("subject").notNull(),
  body:      text("body").notNull(),
  category:  text("category"),
  stage:     text("stage"),
  version:   integer("version").notNull().default(1),
  isActive:  integer("is_active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type TemplateRow = typeof templates.$inferSelect;
export type InsertTemplateRow = typeof templates.$inferInsert;
