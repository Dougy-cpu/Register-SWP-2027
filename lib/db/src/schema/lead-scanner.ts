import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { attendeesTable } from "./attendees";
import { sponsorsTable } from "./sponsors";

export const sponsorLeadScanSourceEnum = pgEnum("sponsor_lead_scan_source", [
  "camera",
  "image",
  "manual",
]);

export const attendeeBadgesTable = pgTable(
  "attendee_badges",
  {
    id: serial("id").primaryKey(),
    attendeeId: integer("attendee_id")
      .notNull()
      .references(() => attendeesTable.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    attendeeUniq: uniqueIndex("attendee_badges_attendee_uniq").on(table.attendeeId),
    codeUniq: uniqueIndex("attendee_badges_code_uniq").on(table.code),
    activeIdx: index("attendee_badges_active_idx").on(table.active, table.updatedAt),
    codeShape: check("attendee_badges_code_shape", sql`${table.code} ~ '^[0-9A-F]{12}$'`),
    versionPositive: check("attendee_badges_version_positive", sql`${table.version} >= 1`),
  }),
);

export const sponsorScannerDevicesTable = pgTable(
  "sponsor_scanner_devices",
  {
    id: text("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    accessVersion: integer("access_version").notNull(),
    tokenHash: text("token_hash").notNull(),
    operatorName: text("operator_name").notNull(),
    userAgent: text("user_agent"),
    packVersion: text("pack_version"),
    cameraTested: boolean("camera_tested").notNull().default(false),
    qrTested: boolean("qr_tested").notNull().default(false),
    storageTested: boolean("storage_tested").notNull().default(false),
    offlineTested: boolean("offline_tested").notNull().default(false),
    syncTested: boolean("sync_tested").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    tokenHashUniq: uniqueIndex("sponsor_scanner_devices_token_hash_uniq").on(table.tokenHash),
    sponsorIdx: index("sponsor_scanner_devices_sponsor_idx").on(
      table.sponsorId,
      table.revokedAt,
      table.lastSeenAt,
    ),
    accessVersionPositive: check(
      "sponsor_scanner_devices_access_version_positive",
      sql`${table.accessVersion} >= 1`,
    ),
  }),
);

export const sponsorLeadsTable = pgTable(
  "sponsor_leads",
  {
    id: text("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id")
      .notNull()
      .references(() => attendeesTable.id, { onDelete: "restrict" }),
    rating: integer("rating"),
    scanCount: integer("scan_count").notNull().default(0),
    firstScannedAt: timestamp("first_scanned_at", { withTimezone: true }),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sponsorAttendeeUniq: uniqueIndex("sponsor_leads_sponsor_attendee_uniq").on(
      table.sponsorId,
      table.attendeeId,
    ),
    sponsorRecentIdx: index("sponsor_leads_sponsor_recent_idx").on(
      table.sponsorId,
      table.lastScannedAt,
    ),
    ratingRange: check(
      "sponsor_leads_rating_range",
      sql`${table.rating} IS NULL OR (${table.rating} >= 1 AND ${table.rating} <= 5)`,
    ),
    scanCountNonNegative: check(
      "sponsor_leads_scan_count_non_negative",
      sql`${table.scanCount} >= 0`,
    ),
  }),
);

export const sponsorLeadScanEventsTable = pgTable(
  "sponsor_lead_scan_events",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => sponsorLeadsTable.id, { onDelete: "cascade" }),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    attendeeId: integer("attendee_id")
      .notNull()
      .references(() => attendeesTable.id, { onDelete: "restrict" }),
    scannerDeviceId: text("scanner_device_id")
      .notNull()
      .references(() => sponsorScannerDevicesTable.id, { onDelete: "restrict" }),
    operatorName: text("operator_name").notNull(),
    badgeVersion: integer("badge_version").notNull(),
    source: sponsorLeadScanSourceEnum("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    leadCapturedIdx: index("sponsor_lead_scan_events_lead_captured_idx").on(
      table.leadId,
      table.capturedAt,
    ),
    deviceCapturedIdx: index("sponsor_lead_scan_events_device_captured_idx").on(
      table.scannerDeviceId,
      table.capturedAt,
    ),
    badgeVersionPositive: check(
      "sponsor_lead_scan_events_badge_version_positive",
      sql`${table.badgeVersion} >= 1`,
    ),
  }),
);

export const sponsorLeadNotesTable = pgTable(
  "sponsor_lead_notes",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => sponsorLeadsTable.id, { onDelete: "cascade" }),
    scannerDeviceId: text("scanner_device_id").references(() => sponsorScannerDevicesTable.id, {
      onDelete: "set null",
    }),
    operatorName: text("operator_name").notNull(),
    note: text("note"),
    rating: integer("rating"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    leadCreatedIdx: index("sponsor_lead_notes_lead_created_idx").on(table.leadId, table.createdAt),
    ratingRange: check(
      "sponsor_lead_notes_rating_range",
      sql`${table.rating} IS NULL OR (${table.rating} >= 1 AND ${table.rating} <= 5)`,
    ),
    hasChange: check(
      "sponsor_lead_notes_has_change",
      sql`${table.note} IS NOT NULL OR ${table.rating} IS NOT NULL`,
    ),
  }),
);

export type AttendeeBadge = typeof attendeeBadgesTable.$inferSelect;
export type SponsorScannerDevice = typeof sponsorScannerDevicesTable.$inferSelect;
export type SponsorLead = typeof sponsorLeadsTable.$inferSelect;
export type SponsorLeadScanEvent = typeof sponsorLeadScanEventsTable.$inferSelect;
export type SponsorLeadNote = typeof sponsorLeadNotesTable.$inferSelect;
