import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const notificationEmailsTable = pgTable("notification_emails", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  label: text("label"),
  notifyComplete: boolean("notify_complete").notNull().default(true),
  notifyIncomplete: boolean("notify_incomplete").notNull().default(true),
  notifyCheckoutExpired: boolean("notify_checkout_expired").notNull().default(false),
  notifyBillingEdit: boolean("notify_billing_edit").notNull().default(true),
  notifySponsorAdmin: boolean("notify_sponsor_admin").notNull().default(true),
  notifySponsorPasses: boolean("notify_sponsor_passes").notNull().default(true),
  notifySponsorContent: boolean("notify_sponsor_content").notNull().default(true),
  notifySponsorDeadlines: boolean("notify_sponsor_deadlines").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationEmail = typeof notificationEmailsTable.$inferSelect;
export type InsertNotificationEmail = typeof notificationEmailsTable.$inferInsert;
