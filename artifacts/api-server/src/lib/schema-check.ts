import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// Safe because tableNames values are compile-time constants in this file
function buildTableArrayLiteral(tableNames: string[]): string {
  return tableNames.map((t) => `'${t}'`).join(", ");
}

const EXPECTED_COLUMNS: Record<string, string[]> = {
  bookings: [
    "id",
    "session_token",
    "status",
    "pass_type",
    "attendee_type",
    "quantity",
    "promo_code",
    "promo_discount_amount",
    "group_discount_amount",
    "subtotal_amount",
    "vat_amount",
    "total_amount",
    "payment_method",
    "stripe_session_id",
    "stripe_payment_intent_id",
    "stripe_invoice_id",
    "stripe_invoice_pdf_url",
    "stripe_invoice_payment_url",
    "order_reference",
    "current_step",
    "billing_name",
    "billing_company",
    "billing_email",
    "billing_address",
    "billing_address_line1",
    "billing_address_line2",
    "billing_town",
    "billing_region",
    "billing_postcode",
    "billing_country",
    "billing_phone",
    "billing_vat_number",
    "invoice_due_date",
    "hear_about_us",
    "management_token",
    "partial_notification_sent",
    "created_at",
    "updated_at",
  ],
  attendees: [
    "id",
    "booking_id",
    "is_lead",
    "seat_index",
    "first_name",
    "last_name",
    "job_title",
    "company",
    "work_email",
    "phone",
    "dietary_accessibility",
    "is_tbc",
    "gdpr_consent",
    "gdpr_consent_at",
    "created_at",
    "updated_at",
  ],
  event_settings: [
    "id",
    "event_name",
    "event_date",
    "event_venue",
    "event_venue_postcode",
    "org_name",
    "org_address",
    "org_website",
    "logo_data_url",
    "from_name",
    "from_email",
    "freeagent_refresh_token",
    "freeagent_access_token",
    "freeagent_token_expires_at",
    "attendee_changes_locked",
    "attendee_changes_locked_message",
    "ref_prefix",
    "ref_offset",
    "notify_complete_subject",
    "notify_incomplete_subject",
    "notify_attendee_subject",
    "event_start_at",
    "event_end_at",
    "event_timezone",
    "event_description",
    "social_enabled",
    "social_name",
    "social_start_at",
    "social_end_at",
    "social_venue",
    "social_description",
    "updated_at",
  ],
  notification_emails: [
    "id",
    "email",
    "label",
    "notify_complete",
    "notify_incomplete",
    "created_at",
  ],
  pass_config: [
    "pass_type",
    "current_price",
    "original_price",
    "pricing_period_name",
    "benefits",
    "extra_benefits",
    "updated_at",
  ],
  promo_codes: [
    "id",
    "code",
    "discount_type",
    "discount_value",
    "max_uses",
    "used_count",
    "valid_from",
    "valid_until",
    "is_active",
    "applicable_pass_types",
    "description",
    "once_per_customer",
    "min_quantity",
    "max_discount_amount",
    "internal_note",
    "created_at",
    "updated_at",
  ],
  activity_log: ["id", "type", "booking_id", "attendee_id", "data", "created_at"],
  email_templates: ["id", "type", "subject", "html_body", "updated_at"],
  discount_tiers: ["id", "pass_type", "min_quantity", "discount_percent", "label"],
  email_logs: ["id", "booking_id", "recipient", "type", "status", "error_message", "sent_at"],
  pass_inventory: ["id", "pass_type", "remaining", "updated_at"],
};

export async function checkSchemaConsistency(): Promise<boolean> {
  const tableNames = Object.keys(EXPECTED_COLUMNS);

  const arrayLiteral = buildTableArrayLiteral(tableNames);
  const result = await db.execute(
    sql.raw(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = ANY(ARRAY[${arrayLiteral}])
    `),
  );

  const existing: Record<string, Set<string>> = {};
  for (const row of result.rows as { table_name: string; column_name: string }[]) {
    if (!existing[row.table_name]) {
      existing[row.table_name] = new Set();
    }
    existing[row.table_name].add(row.column_name);
  }

  const issues: string[] = [];

  for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    if (!existing[table]) {
      issues.push(`table "${table}" is missing entirely`);
      continue;
    }
    for (const col of expectedCols) {
      if (!existing[table].has(col)) {
        issues.push(`column "${table}.${col}" is missing`);
      }
    }
  }

  if (issues.length > 0) {
    logger.error(
      { issues },
      `Schema check FAILED: ${issues.length} issue(s) — database is out of date. Run "pnpm --filter @workspace/db run push" to update the schema.`,
    );
    return false;
  }

  logger.info("Schema check passed — all expected columns are present");
  return true;
}
