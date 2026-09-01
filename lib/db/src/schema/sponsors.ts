import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { promoCodesTable } from "./promo-codes";

export const sponsorStatusEnum = pgEnum("sponsor_status", [
  "draft",
  "confirmed",
  "paused",
  "completed",
  "cancelled",
]);

export const sponsorContactRoleEnum = pgEnum("sponsor_contact_role", [
  "primary",
  "onsite",
  "marketing",
  "other",
]);

export const sponsorPromoKindEnum = pgEnum("sponsor_promo_kind", ["vip", "public"]);

export const sponsorTaskStatusEnum = pgEnum("sponsor_task_status", [
  "todo",
  "submitted",
  "completed",
  "overdue",
  "not_required",
]);

export const sponsorSessionTypeEnum = pgEnum("sponsor_session_type", [
  "quickfire",
  "keynote",
  "other",
]);

export const sponsorSessionStatusEnum = pgEnum("sponsor_session_status", [
  "draft",
  "submitted",
  "changes_requested",
  "approved",
  "exported",
]);

export const sponsorAssetCategoryEnum = pgEnum("sponsor_asset_category", [
  "logo",
  "headshot",
  "slides",
  "session_material",
  "logistics",
  "other",
]);

export const sponsorAssetStatusEnum = pgEnum("sponsor_asset_status", [
  "active",
  "archived",
  "missing",
]);

export const sponsorsTable = pgTable(
  "sponsors",
  {
    id: serial("id").primaryKey(),
    company: text("company").notNull(),
    packageLabel: text("package_label").notNull(),
    status: sponsorStatusEnum("status").notNull().default("draft"),
    confirmationDate: date("confirmation_date"),
    notes: text("notes"),
    vipAllocation: integer("vip_allocation").notNull().default(0),
    vipMaxPerBooking: integer("vip_max_per_booking").notNull().default(1),
    staffAllocation: integer("staff_allocation").notNull().default(0),
    vipCodeDraft: text("vip_code_draft").notNull(),
    publicCodeDraft: text("public_code_draft").notNull(),
    portalAccessVersion: integer("portal_access_version").notNull().default(1),
    requiredDeliverables: jsonb("required_deliverables")
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    welcomeEmailSentAt: timestamp("welcome_email_sent_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    companyLowerIdx: index("sponsors_company_lower_idx").on(sql`lower(${table.company})`),
    statusIdx: index("sponsors_status_idx").on(table.status),
  }),
);

export const sponsorContactsTable = pgTable(
  "sponsor_contacts",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    role: sponsorContactRoleEnum("role").notNull().default("other"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    jobTitle: text("job_title"),
    email: text("email").notNull(),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sponsorIdx: index("sponsor_contacts_sponsor_idx").on(table.sponsorId),
    sponsorEmailUniq: uniqueIndex("sponsor_contacts_sponsor_email_uniq").on(
      table.sponsorId,
      sql`lower(${table.email})`,
    ),
  }),
);

export const sponsorPromoCodesTable = pgTable(
  "sponsor_promo_codes",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    promoCodeId: integer("promo_code_id")
      .notNull()
      .references(() => promoCodesTable.id, { onDelete: "restrict" }),
    kind: sponsorPromoKindEnum("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sponsorKindUniq: uniqueIndex("sponsor_promo_codes_sponsor_kind_uniq").on(
      table.sponsorId,
      table.kind,
    ),
    promoUniq: uniqueIndex("sponsor_promo_codes_promo_uniq").on(table.promoCodeId),
  }),
);

export const sponsorTasksTable = pgTable(
  "sponsor_tasks",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    label: text("label").notNull(),
    required: boolean("required").notNull().default(true),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: sponsorTaskStatusEnum("status").notNull().default("todo"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastDeadlineCheckOn: date("last_deadline_check_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sponsorTaskUniq: uniqueIndex("sponsor_tasks_sponsor_key_uniq").on(
      table.sponsorId,
      table.taskKey,
    ),
    dueIdx: index("sponsor_tasks_due_idx").on(table.dueAt, table.status),
  }),
);

export const sponsorSessionsTable = pgTable(
  "sponsor_sessions",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    type: sponsorSessionTypeEnum("type").notNull(),
    entitlementLabel: text("entitlement_label").notNull(),
    title: text("title"),
    description: text("description"),
    takeaways: text("takeaways")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    status: sponsorSessionStatusEnum("status").notNull().default("draft"),
    headshotRequired: boolean("headshot_required").notNull().default(true),
    takeawaysRequired: boolean("takeaways_required").notNull().default(true),
    slidesRequired: boolean("slides_required").notNull().default(false),
    feedback: text("feedback"),
    currentRevision: integer("current_revision").notNull().default(0),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportedRevision: integer("exported_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sponsorIdx: index("sponsor_sessions_sponsor_idx").on(table.sponsorId),
    statusIdx: index("sponsor_sessions_status_idx").on(table.status),
  }),
);

export const sponsorSessionRevisionsTable = pgTable(
  "sponsor_session_revisions",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sponsorSessionsTable.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionUniq: uniqueIndex("sponsor_session_revisions_session_revision_uniq").on(
      table.sessionId,
      table.revision,
    ),
  }),
);

export const sponsorPresentersTable = pgTable(
  "sponsor_presenters",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sponsorSessionsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    jobTitle: text("job_title").notNull(),
    company: text("company").notNull(),
    biography: text("biography"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sessionIdx: index("sponsor_presenters_session_idx").on(table.sessionId),
  }),
);

export const sponsorAssetsTable = pgTable(
  "sponsor_assets",
  {
    id: text("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => sponsorSessionsTable.id, {
      onDelete: "set null",
    }),
    presenterId: integer("presenter_id").references(() => sponsorPresentersTable.id, {
      onDelete: "set null",
    }),
    category: sponsorAssetCategoryEnum("category").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    version: integer("version").notNull().default(1),
    status: sponsorAssetStatusEnum("status").notNull().default("active"),
    replacesAssetId: text("replaces_asset_id"),
    uploaderType: text("uploader_type").notNull(),
    uploaderLabel: text("uploader_label"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sponsorIdx: index("sponsor_assets_sponsor_idx").on(table.sponsorId),
    libraryIdx: index("sponsor_assets_library_idx").on(
      table.status,
      table.category,
      table.createdAt,
    ),
  }),
);

export const sponsorDocumentsTable = pgTable(
  "sponsor_documents",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => sponsorAssetsTable.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    required: boolean("required").notNull().default(true),
    acknowledgementVersion: integer("acknowledgement_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    sponsorIdx: index("sponsor_documents_sponsor_idx").on(table.sponsorId),
  }),
);

export const sponsorDocumentAcknowledgementsTable = pgTable(
  "sponsor_document_acknowledgements",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => sponsorDocumentsTable.id, { onDelete: "cascade" }),
    sponsorContactId: integer("sponsor_contact_id").references(() => sponsorContactsTable.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    acknowledgedBy: text("acknowledged_by").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    acknowledgementUniq: uniqueIndex("sponsor_document_ack_version_uniq").on(
      table.documentId,
      table.version,
    ),
  }),
);

export const sponsorPassRequestsTable = pgTable(
  "sponsor_pass_requests",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    requestedVip: integer("requested_vip").notNull().default(0),
    requestedStaff: integer("requested_staff").notNull().default(0),
    message: text("message"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    sponsorIdx: index("sponsor_pass_requests_sponsor_idx").on(table.sponsorId, table.status),
  }),
);

export const sponsorActivityTable = pgTable(
  "sponsor_activity",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorType: text("actor_type").notNull(),
    actorLabel: text("actor_label"),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sponsorCreatedIdx: index("sponsor_activity_sponsor_created_idx").on(
      table.sponsorId,
      table.createdAt,
    ),
  }),
);

export const insertSponsorSchema = createInsertSchema(sponsorsTable).omit({
  id: true,
  confirmedAt: true,
  welcomeEmailSentAt: true,
  pausedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSponsor = z.infer<typeof insertSponsorSchema>;
export type Sponsor = typeof sponsorsTable.$inferSelect;
export type SponsorContact = typeof sponsorContactsTable.$inferSelect;
export type SponsorSession = typeof sponsorSessionsTable.$inferSelect;
export type SponsorAsset = typeof sponsorAssetsTable.$inferSelect;
