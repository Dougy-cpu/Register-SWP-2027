import { pgTable, text, serial, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const emailTemplateTypeEnum = pgEnum("email_template_type", [
  "welcome",
  "confirmation",
  "receipt",
  "invoice_reminder",
  "community_social",
]);

export const emailTemplatesTable = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  type: emailTemplateTypeEnum("type").notNull().unique(),
  subject: text("subject").notNull(),
  htmlBody: text("html_body").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertEmailTemplateSchema = createInsertSchema(emailTemplatesTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertEmailTemplate = z.infer<typeof insertEmailTemplateSchema>;
export type EmailTemplate = typeof emailTemplatesTable.$inferSelect;
