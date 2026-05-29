import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const notificationEmailsTable = pgTable("notification_emails", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  label: text("label"),
  notifyComplete: boolean("notify_complete").notNull().default(true),
  notifyIncomplete: boolean("notify_incomplete").notNull().default(true),
  notifyBillingEdit: boolean("notify_billing_edit").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationEmail = typeof notificationEmailsTable.$inferSelect;
export type InsertNotificationEmail = typeof notificationEmailsTable.$inferInsert;
