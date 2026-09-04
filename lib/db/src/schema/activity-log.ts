import { pgTable, serial, timestamp, integer, jsonb, varchar } from "drizzle-orm/pg-core";
import { bookingsTable } from "./bookings";
import { attendeesTable } from "./attendees";

export const activityTypeEnum = [
  "attendee_change",
  "tbc_filled",
  "admin_login_success",
  "admin_login_failure",
  "admin_booking_status_changed",
  "admin_booking_updated",
  "admin_booking_deleted",
  "admin_attendee_added",
  "admin_attendee_updated",
  "admin_promo_created",
  "admin_promo_updated",
  "admin_promo_deleted",
  "admin_discount_tiers_updated",
  "admin_pass_inventory_updated",
  "admin_pass_config_updated",
  "admin_notification_email_added",
  "admin_notification_email_updated",
  "admin_notification_email_deleted",
  "admin_event_settings_updated",
  "admin_email_template_updated",
  "admin_email_template_test_sent",
  "admin_email_resent",
  "admin_invoice_reminder_sent",
  "admin_hear_about_us_added",
  "admin_hear_about_us_deleted",
  "admin_hear_about_us_moved",
  "admin_booking_redelivered",
  "admin_community_social_email_sent",
  "admin_scanner_device_revoked",
  "admin_attendee_lead_sharing_updated",
  "admin_badge_rotated",
  "sponsor_created",
  "sponsor_updated",
  "sponsor_status_changed",
  "sponsor_access_rotated",
  "sponsor_welcome_sent",
  "sponsor_staff_registered",
  "sponsor_staff_updated",
  "sponsor_staff_cancelled",
  "sponsor_pass_requested",
  "sponsor_session_submitted",
  "sponsor_session_reviewed",
  "sponsor_session_exported",
  "sponsor_asset_uploaded",
  "sponsor_asset_downloaded",
  "sponsor_asset_archived",
  "sponsor_asset_restored",
  "sponsor_document_acknowledged",
] as const;

export type ActivityType = (typeof activityTypeEnum)[number];

export const activityLogTable = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 60 }).notNull(),
  actor: varchar("actor", { length: 60 }),
  bookingId: integer("booking_id").references(() => bookingsTable.id),
  attendeeId: integer("attendee_id").references(() => attendeesTable.id),
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ActivityLog = typeof activityLogTable.$inferSelect;
export type InsertActivityLog = typeof activityLogTable.$inferInsert;
