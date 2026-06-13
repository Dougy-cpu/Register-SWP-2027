import { pgTable, text, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const eventSettingsTable = pgTable("event_settings", {
  id: serial("id").primaryKey(),
  eventName: text("event_name").notNull().default("SWP Summit"),
  eventDate: text("event_date").notNull().default("Wednesday, 3 March 2027"),
  eventVenue: text("event_venue").notNull().default("1 Basinghall Avenue, London"),
  eventVenuePostcode: text("event_venue_postcode").notNull().default("EC2V 5DD"),
  orgName: text("org_name").notNull().default("Dynamic Business Leaders Limited"),
  orgAddress: text("org_address").notNull().default("London, UK"),
  orgWebsite: text("org_website").notNull().default("https://swpsummit.com"),
  logoDataUrl: text("logo_data_url"),
  fromName: text("from_name").notNull().default("SWP Summit"),
  fromEmail: text("from_email").notNull().default("douglas@peoplestrategyhub.com"),
  freeagentRefreshToken: text("freeagent_refresh_token"),
  freeagentAccessToken: text("freeagent_access_token"),
  freeagentTokenExpiresAt: timestamp("freeagent_token_expires_at", { withTimezone: true }),
  attendeeChangesLocked: boolean("attendee_changes_locked").notNull().default(false),
  attendeeChangesLockedMessage: text("attendee_changes_locked_message"),
  // Booking reference format. The literal defaults below MUST be kept in
  // sync with `DEFAULT_REF_PREFIX`/`DEFAULT_REF_OFFSET` in
  // `artifacts/api-server/src/lib/order-reference.ts`. We can't share a TS
  // constant here because Drizzle column `.default()` requires a literal at
  // schema-evaluation time and the @workspace/db package must not depend on
  // the api-server. These values are the SQL-level seed only — every code
  // path that synthesises a fallback reference goes through the constants.
  refPrefix: text("ref_prefix").notNull().default("SWP27"),
  refOffset: integer("ref_offset").notNull().default(6541),
  // Notification email subject templates (support {{variables}})
  notifyCompleteSubject: text("notify_complete_subject"),
  notifyIncompleteSubject: text("notify_incomplete_subject"),
  notifyAttendeeSubject: text("notify_attendee_subject"),
  // Calendar / scheduling — used to generate Google/Outlook/ICS calendar links
  eventStartAt: timestamp("event_start_at", { withTimezone: true }),
  eventEndAt: timestamp("event_end_at", { withTimezone: true }),
  eventTimezone: text("event_timezone").notNull().default("Europe/London"),
  eventDescription: text("event_description"),
  // Optional additional networking social / community gathering
  socialEnabled: boolean("social_enabled").notNull().default(false),
  socialName: text("social_name"),
  socialStartAt: timestamp("social_start_at", { withTimezone: true }),
  socialEndAt: timestamp("social_end_at", { withTimezone: true }),
  socialVenue: text("social_venue"),
  socialDescription: text("social_description"),
  // Admin-editable "How invoicing works" help copy. Surfaced on Step 4 of the
  // checkout (Pay by Invoice) and linked from the invoice confirmation email.
  // Plain text — paragraphs separated by blank lines, lines starting with "- "
  // render as a bullet list. Null falls back to a built-in default copy.
  invoiceHelpContent: text("invoice_help_content"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type EventSettings = typeof eventSettingsTable.$inferSelect;
