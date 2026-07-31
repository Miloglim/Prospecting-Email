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
  // 自定义字段
  customStr1:   text("custom_str1"),
  customStr2:   text("custom_str2"),
  customStr3:   text("custom_str3"),
  customStr4:   text("custom_str4"),
  customStr5:   text("custom_str5"),
  customNum1:   integer("custom_num1"),
  customNum2:   integer("custom_num2"),
  customNum3:   integer("custom_num3"),
  customNum4:   integer("custom_num4"),
  customNum5:   integer("custom_num5"),
  customDate1:  text("custom_date1"),
  customDate2:  text("custom_date2"),
  customDate3:  text("custom_date3"),
  customDate4:  text("custom_date4"),
  customDate5:  text("custom_date5"),
  source:       text("source").default("manual"),
  sourceDetail: text("source_detail"),
  createdAt:    text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:    text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type ContactRow = typeof contacts.$inferSelect;
export type InsertContactRow = typeof contacts.$inferInsert;
