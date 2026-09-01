import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  pgEnum,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sponsorsTable } from "./sponsors";

export const bookingStatusEnum = pgEnum("booking_status", [
  "partial",
  "pending_payment",
  "paid",
  "invoiced",
  "transferred",
  "cancelled",
  "refunded",
  "disputed",
]);

export const passTypeEnum = pgEnum("pass_type", ["single", "business"]);

export const attendeeTypeEnum = pgEnum("attendee_type", ["hr_professional", "consultant_vendor"]);

export const paymentMethodEnum = pgEnum("payment_method", ["card", "invoice"]);

export const registrationSourceEnum = pgEnum("registration_source", [
  "checkout",
  "manual",
  "sponsor_staff",
]);

export const bookingsTable = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    sessionToken: text("session_token").notNull().unique(),
    status: bookingStatusEnum("status").notNull().default("partial"),
    passType: passTypeEnum("pass_type").notNull(),
    attendeeType: attendeeTypeEnum("attendee_type").notNull(),
    quantity: integer("quantity").notNull().default(1),
    promoCode: text("promo_code"),
    promoDiscountAmount: numeric("promo_discount_amount", { precision: 10, scale: 2 }),
    groupDiscountAmount: numeric("group_discount_amount", { precision: 10, scale: 2 }),
    subtotalAmount: numeric("subtotal_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull().default("0"),
    paymentMethod: paymentMethodEnum("payment_method"),
    manualEntry: boolean("manual_entry").notNull().default(false),
    registrationSource: registrationSourceEnum("registration_source").notNull().default("checkout"),
    sponsorId: integer("sponsor_id").references(() => sponsorsTable.id, {
      onDelete: "set null",
    }),
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeInvoicePdfUrl: text("stripe_invoice_pdf_url"),
    stripeInvoicePaymentUrl: text("stripe_invoice_payment_url"),
    orderReference: text("order_reference"),
    currentStep: integer("current_step").notNull().default(1),
    billingName: text("billing_name"),
    billingCompany: text("billing_company"),
    billingEmail: text("billing_email"),
    billingAddress: text("billing_address"),
    billingAddressLine1: text("billing_address_line1"),
    billingAddressLine2: text("billing_address_line2"),
    billingTown: text("billing_town"),
    billingRegion: text("billing_region"),
    billingPostcode: text("billing_postcode"),
    billingCountry: text("billing_country"),
    billingPhone: text("billing_phone"),
    billingVatNumber: text("billing_vat_number"),
    poNumber: text("po_number"),
    invoiceDueDate: timestamp("invoice_due_date", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    stripeInvoiceStatus: text("stripe_invoice_status"),
    stripeInvoiceStatusSyncedAt: timestamp("stripe_invoice_status_synced_at", {
      withTimezone: true,
    }),
    paidConfirmationEmailSentAt: timestamp("paid_confirmation_email_sent_at", {
      withTimezone: true,
    }),
    lastInvoiceReminderSentAt: timestamp("last_invoice_reminder_sent_at", {
      withTimezone: true,
    }),
    hearAboutUs: text("hear_about_us"),
    managementToken: text("management_token").unique(),
    partialNotificationSent: boolean("partial_notification_sent").notNull().default(false),
    // Per-side-effect delivery flags. Flipped to true ONLY when the matching
    // post-confirmation side-effect actually succeeded. Used by the
    // booking-confirmation helper to retry only the missing pieces on webhook
    // replay or admin "redeliver" — and surfaced in the admin Registrations
    // panel as a "needs attention" badge so a stuck delivery is visible.
    confirmationEmailSent: boolean("confirmation_email_sent").notNull().default(false),
    welcomeEmailsSent: boolean("welcome_emails_sent").notNull().default(false),
    // Manual campaign flag. This is deliberately not part of automatic
    // confirmation delivery or the "needs attention" calculation.
    communitySocialEmailSent: boolean("community_social_email_sent").notNull().default(false),
    organiserNotified: boolean("organiser_notified").notNull().default(false),
    sheetsSynced: boolean("sheets_synced").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Stripe webhook lookups: a checkout.session.completed / payment_intent.*
    // payload arrives with one of these IDs and we must find the matching
    // booking in O(1). Uniques where appropriate so the new atomic-confirmation
    // path can't accidentally claim the wrong row.
    stripeSessionIdUniq: uniqueIndex("bookings_stripe_session_id_uniq").on(table.stripeSessionId),
    stripePaymentIntentIdIdx: index("bookings_stripe_payment_intent_id_idx").on(
      table.stripePaymentIntentId,
    ),
    stripeInvoiceIdIdx: index("bookings_stripe_invoice_id_idx").on(table.stripeInvoiceId),
    // Customer + admin lookups by order reference; unique because we generate
    // it deterministically from the booking id and a refOffset.
    orderReferenceUniq: uniqueIndex("bookings_order_reference_uniq").on(table.orderReference),
    // Admin filter on promo codes ("show me everyone who used FREEPASS").
    promoCodeIdx: index("bookings_promo_code_idx").on(table.promoCode),
    sponsorSourceIdx: index("bookings_sponsor_source_idx").on(
      table.sponsorId,
      table.registrationSource,
      table.status,
    ),
  }),
);

export const insertBookingSchema = createInsertSchema(bookingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;
