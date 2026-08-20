import { db } from "@workspace/db";
import { activityLogTable, type ActivityType } from "@workspace/db";
import { logger } from "./logger";

type Diffable = Record<string, unknown> | null | undefined;

// Field names whose values may contain personally-identifiable or otherwise
// sensitive data (names, emails, phone numbers, addresses, payment info).
// We keep the key in the diff so reviewers can see *what* changed without
// exposing the underlying value.
const PII_KEYS = new Set([
  "firstName",
  "lastName",
  "fullName",
  "name",
  "workEmail",
  "personalEmail",
  "email",
  "billingEmail",
  "billingContactEmail",
  "billingContactName",
  "billingName",
  "billingFirstName",
  "billingLastName",
  "leadName",
  "leadEmail",
  "leadPhone",
  "phone",
  "billingPhone",
  "billingAddress",
  "billingCompany",
  "address",
  "address1",
  "address2",
  "city",
  "postcode",
  "postalCode",
  "country",
  "company",
  "jobTitle",
  "notes",
  "vatNumber",
  "poNumber",
  "stripeCustomerId",
  "stripePaymentIntentId",
  "stripeInvoiceId",
  "stripeInvoicePdfUrl",
  "stripeInvoicePaymentUrl",
  "ipAddress",
  "userAgent",
  "password",
  "token",
]);

function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return "***";
  if (typeof value === "string") {
    if (value.length === 0) return "";
    return `***(${value.length})`;
  }
  return "***";
}

function redact(input: Diffable): Record<string, unknown> | null | undefined {
  if (input === null || input === undefined) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = PII_KEYS.has(k) ? maskValue(v) : v;
  }
  return out;
}

function diff(before: Diffable, after: Diffable): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const a = before?.[k];
    const b = after?.[k];
    const aJson = JSON.stringify(a ?? null);
    const bJson = JSON.stringify(b ?? null);
    if (aJson !== bJson) {
      const isPii = PII_KEYS.has(k);
      out[k] = {
        from: isPii ? maskValue(a) : (a ?? null),
        to: isPii ? maskValue(b) : (b ?? null),
      };
    }
  }
  return out;
}

export async function logAdminAction(opts: {
  type: ActivityType;
  actor?: string;
  bookingId?: number | null;
  attendeeId?: number | null;
  summary?: string;
  before?: Diffable;
  after?: Diffable;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const data: Record<string, unknown> = {};
    if (opts.summary) data.summary = opts.summary;
    if (opts.before !== undefined || opts.after !== undefined) {
      const changes = diff(opts.before, opts.after);
      if (Object.keys(changes).length > 0) data.changes = changes;
      const redactedBefore = redact(opts.before);
      const redactedAfter = redact(opts.after);
      if (redactedBefore !== undefined) data.before = redactedBefore;
      if (redactedAfter !== undefined) data.after = redactedAfter;
    }
    if (opts.meta) Object.assign(data, opts.meta);

    await db.insert(activityLogTable).values({
      type: opts.type,
      actor: opts.actor || "admin",
      bookingId: opts.bookingId ?? null,
      attendeeId: opts.attendeeId ?? null,
      data: Object.keys(data).length > 0 ? data : null,
    });
  } catch (err) {
    // Audit logging must never break the underlying admin operation. Log loudly
    // so operators can investigate, but swallow the error.
    logger.error({ err, type: opts.type }, "Failed to write admin audit log entry");
  }
}
