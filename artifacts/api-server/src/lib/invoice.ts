import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookingsTable, attendeesTable } from "@workspace/db";
import { logger } from "./logger";
import type { DbExecutor } from "./pricing";
import { defaultOrderRef } from "./order-reference";

const PASS_LABELS: Record<string, string> = {
  single: "Workforce Pass, SWP Summit 2027",
  team: "Team Pass, SWP Summit 2027",
  business: "Business Pass, SWP Summit 2027",
};

const INVOICE_FOOTER = [
  "Issued by: Dynamic Business Leaders Limited",
  "Company No. 12252258  |  VAT No. 336124621",
  "Registered Address: 45 Lemsford Village, Welwyn Garden City, Hertfordshire AL8 7TR",
  "Contact: douglas@dynamicbusinessleaders.co.uk  |  Tel: 07763618052",
  "Goods: Conference",
  "",
  "Bank: Tide (ClearBank)  |  Sort Code: 04-06-05  |  Account: 16963209",
  "IBAN (GBP): GB65CLRB04060516963209  |  SWIFT: CLRBGB22",
  "IBAN (EUR): GB45TCCL00997990500906  |  BIC: TCCLGB31",
].join("\n");

export type InvoicePaidStatus = "paid" | "uncollectible" | "void";

let cachedVatRateId: string | null = null;
/**
 * Look up - or create on first use - the standard UK VAT 20% tax rate
 * in the connected Stripe account. Both the initial /stripe/create-invoice
 * route and the re-issue path go through here, so a brand-new Stripe
 * environment is auto-bootstrapped on the first invoice.
 */
async function getOrCreateVatRate(stripe: Stripe): Promise<string | null> {
  if (cachedVatRateId) return cachedVatRateId;
  try {
    const list = await stripe.taxRates.list({ active: true, limit: 100 });
    const existing = list.data.find(
      (r) => r.percentage === 20 && r.country === "GB" && !r.inclusive,
    );
    if (existing) {
      cachedVatRateId = existing.id;
      return existing.id;
    }
    const created = await stripe.taxRates.create({
      display_name: "VAT",
      percentage: 20,
      country: "GB",
      inclusive: false,
      description: "UK VAT 20%",
    });
    cachedVatRateId = created.id;
    return created.id;
  } catch (err) {
    logger.error({ err }, "Failed to get/create Stripe VAT tax rate");
    return null;
  }
}

export async function getStripeInvoiceStatus(
  stripe: Stripe,
  invoiceId: string,
): Promise<{ status: Stripe.Invoice.Status | null; paid: boolean }> {
  try {
    const inv = await stripe.invoices.retrieve(invoiceId);
    return { status: inv.status ?? null, paid: inv.status === "paid" };
  } catch (err) {
    logger.warn({ err, invoiceId }, "Failed to retrieve Stripe invoice status");
    return { status: null, paid: false };
  }
}

const STALE_INVOICE_STATUS_MS = 5 * 60 * 1000;

/**
 * If the booking has a Stripe invoice and our cached status hasn't been
 * refreshed in the last 5 minutes (or the booking still looks unpaid), fetch
 * the live status from Stripe and persist it. Caller-safe: errors are
 * swallowed so the parent request never fails because of a stale-poll.
 */
/**
 * Fetch the live Stripe invoice and refresh our cached PDF URL, hosted
 * payment URL, and status. Unlike the staleness-gated status helper, this
 * always pulls fresh data - call it from user-facing download/resend paths
 * where serving a stale PDF URL is unacceptable. Errors are swallowed.
 */
export async function refreshStripeInvoiceUrls(
  stripe: Stripe | null,
  bookingId: number,
): Promise<void> {
  if (!stripe) return;
  try {
    const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
    if (!booking || !booking.stripeInvoiceId) return;
    const inv = await stripe.invoices.retrieve(booking.stripeInvoiceId);
    const updates: Record<string, unknown> = {
      stripeInvoiceStatus: inv.status ?? null,
      stripeInvoiceStatusSyncedAt: new Date(),
    };
    if (inv.invoice_pdf) updates.stripeInvoicePdfUrl = inv.invoice_pdf;
    if (inv.hosted_invoice_url) updates.stripeInvoicePaymentUrl = inv.hosted_invoice_url;
    if (inv.status === "paid" && booking.status !== "paid") {
      updates.status = "paid";
      updates.paidAt = booking.paidAt ?? new Date();
    } else if (inv.status === "void" && booking.status !== "cancelled") {
      updates.status = "cancelled";
    }
    await db.update(bookingsTable).set(updates).where(eq(bookingsTable.id, bookingId));
  } catch (err) {
    logger.warn({ err, bookingId }, "refreshStripeInvoiceUrls failed");
  }
}

export async function refreshStripeInvoiceStatusIfStale(
  stripe: Stripe | null,
  bookingId: number,
): Promise<void> {
  if (!stripe) return;
  try {
    const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
    if (!booking || !booking.stripeInvoiceId) return;
    if (booking.status === "paid" || booking.status === "cancelled") return;

    const last = booking.stripeInvoiceStatusSyncedAt
      ? booking.stripeInvoiceStatusSyncedAt.getTime()
      : 0;
    if (Date.now() - last < STALE_INVOICE_STATUS_MS) return;

    const { status, paid } = await getStripeInvoiceStatus(stripe, booking.stripeInvoiceId);
    if (status === null) return;

    // Note: the `if (booking.status === "paid" || "cancelled") return;` guard
    // above means we know `booking.status` is one of the non-terminal states here.
    const updates: Record<string, unknown> = {
      stripeInvoiceStatus: status,
      stripeInvoiceStatusSyncedAt: new Date(),
    };

    if (paid) {
      updates.status = "paid";
      updates.paidAt = booking.paidAt ?? new Date();
    } else if (status === "void") {
      // Invoice voided in Stripe - reflect by cancelling the booking.
      updates.status = "cancelled";
    }

    await db.update(bookingsTable).set(updates).where(eq(bookingsTable.id, bookingId));
  } catch (err) {
    logger.warn({ err, bookingId }, "refreshStripeInvoiceStatusIfStale failed");
  }
}

export type ReissueInvoiceResult =
  | { alreadyPaid: true }
  | {
      alreadyPaid: false;
      invoiceId: string;
      pdfUrl: string | null;
      paymentUrl: string | null;
      dueDate: Date;
    };

/**
 * Persist the outcome of `reissueBookingInvoice` to the bookings row.
 *
 * Always run this through a `db.transaction` so the booking-status flip
 * commits atomically with the promo-counter increment (when applicable).
 * Callers that need to bundle additional booking-row updates (currentStep,
 * orderReference, paymentMethod, etc.) can pass them via `extras`.
 */
export async function applyReissueInvoiceResultTx(
  tx: DbExecutor,
  bookingId: number,
  result: ReissueInvoiceResult,
  extras?: Record<string, unknown>,
): Promise<void> {
  if (result.alreadyPaid) {
    await tx
      .update(bookingsTable)
      .set({ status: "paid", ...(extras || {}) })
      .where(eq(bookingsTable.id, bookingId));
  } else {
    await tx
      .update(bookingsTable)
      .set({
        status: "invoiced",
        stripeInvoiceId: result.invoiceId,
        stripeInvoicePdfUrl: result.pdfUrl,
        stripeInvoicePaymentUrl: result.paymentUrl,
        invoiceDueDate: result.dueDate,
        ...(extras || {}),
      })
      .where(eq(bookingsTable.id, bookingId));
  }
}

/**
 * Re-issue (or first issue) the Stripe invoice for a booking.
 *
 * Performs the external Stripe operations only (customer sync, invoice
 * create/finalize/send, optional voiding of the previous open invoice). The
 * resulting booking-row writes are NOT applied here - instead the result is
 * returned so the caller can persist it via `applyReissueInvoiceResultTx`
 * inside the same transaction as any related promo-counter increment. This
 * is what guarantees that `bookings.status` and `promoCodes.usedCount` can
 * never drift apart due to a crash mid-confirmation.
 */
export async function reissueBookingInvoice(
  stripe: Stripe,
  bookingId: number,
): Promise<ReissueInvoiceResult> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) throw new Error("Booking not found");

  // Short-circuit if booking is already marked paid in our DB
  if (booking.status === "paid") {
    return { alreadyPaid: true };
  }

  // If we have an existing invoice, check its remote status
  if (booking.stripeInvoiceId) {
    const { paid, status } = await getStripeInvoiceStatus(stripe, booking.stripeInvoiceId);
    if (paid) {
      return { alreadyPaid: true };
    }
    // Void the existing invoice if it's still open/finalized/uncollectible.
    // (Already-void invoices are skipped; paid is handled above.)
    if (status === "open" || status === "draft" || status === "uncollectible") {
      try {
        if (status === "draft") {
          await stripe.invoices.del(booking.stripeInvoiceId);
        } else {
          await stripe.invoices.voidInvoice(booking.stripeInvoiceId);
        }
      } catch (err) {
        logger.warn(
          { err, invoiceId: booking.stripeInvoiceId, bookingId },
          "Failed to void/delete previous Stripe invoice while re-issuing - continuing",
        );
      }
    }
  }

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) throw new Error("No attendee found for booking");

  const orderRef = booking.orderReference || defaultOrderRef(bookingId);

  const subtotalAfterDiscounts = parseFloat(booking.subtotalAmount?.toString() || "0");
  const groupDiscount = parseFloat(booking.groupDiscountAmount?.toString() || "0");
  const promoDiscount = parseFloat(booking.promoDiscountAmount?.toString() || "0");
  const baseAmount = subtotalAfterDiscounts + groupDiscount + promoDiscount;

  const contactEmail = booking.billingEmail || lead.workEmail;
  const contactName = booking.billingName || `${lead.firstName} ${lead.lastName}`;
  const contactCompany = booking.billingCompany || lead.company;

  const addressInput = booking.billingAddressLine1
    ? {
        line1: booking.billingAddressLine1,
        line2: booking.billingAddressLine2 || undefined,
        city: booking.billingTown || undefined,
        state: booking.billingRegion || undefined,
        postal_code: booking.billingPostcode || undefined,
        country:
          booking.billingCountry === "United Kingdom" ? "GB" : booking.billingCountry || "GB",
      }
    : undefined;

  // Find or create Stripe customer; always sync name + address to current values
  const customerList = await stripe.customers.list({ email: contactEmail, limit: 1 });
  let customer: Stripe.Customer;
  if (customerList.data.length > 0) {
    customer = customerList.data[0];
    try {
      await stripe.customers.update(customer.id, {
        name: contactName,
        metadata: { company: contactCompany || "" },
        ...(addressInput ? { address: addressInput } : {}),
      });
    } catch (err) {
      logger.warn(
        { err, customerId: customer.id },
        "Failed to sync Stripe customer billing details",
      );
    }
  } else {
    customer = await stripe.customers.create({
      email: contactEmail,
      name: contactName,
      metadata: { company: contactCompany || "" },
      ...(addressInput ? { address: addressInput } : {}),
    });
  }

  // Look up - or bootstrap - the UK VAT 20% Stripe tax rate
  const vatRateId = await getOrCreateVatRate(stripe);
  if (!vatRateId) {
    throw new Error("Could not establish UK VAT 20% tax rate in Stripe - invoice not issued");
  }
  const vatParams = { tax_rates: [vatRateId] };

  // Build custom_fields (max 4). When PO is set, replace the "Contact" field.
  const baseCustomFields: Array<{ name: string; value: string }> = [
    { name: "Booking reference", value: orderRef },
    { name: "Company Number", value: "12252258" },
    { name: "VAT Number", value: "336124621" },
  ];
  if (booking.poNumber) {
    baseCustomFields.push({ name: "PO Number", value: booking.poNumber.slice(0, 30) });
  } else {
    baseCustomFields.push({ name: "Contact", value: "douglas@dynamicbusinessleaders.co.uk" });
  }

  const invoiceObj = await stripe.invoices.create({
    customer: customer.id,
    collection_method: "send_invoice",
    days_until_due: 14,
    description: `SWP Summit 2027, ${orderRef}`,
    footer: INVOICE_FOOTER,
    custom_fields: baseCustomFields,
    metadata: {
      bookingId: String(bookingId),
      orderRef,
      ...(booking.poNumber ? { poNumber: booking.poNumber } : {}),
    },
    auto_advance: false,
  });

  await stripe.invoiceItems.create({
    customer: customer.id,
    invoice: invoiceObj.id,
    description: `${PASS_LABELS[booking.passType] || booking.passType}, quantity ${booking.quantity}`,
    amount: Math.round(baseAmount * 100),
    currency: "gbp",
    ...vatParams,
  });

  if (groupDiscount > 0) {
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoiceObj.id,
      description: "Group Discount",
      amount: -Math.round(groupDiscount * 100),
      currency: "gbp",
      ...vatParams,
    });
  }
  if (promoDiscount > 0) {
    await stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoiceObj.id,
      description: `Promo Code: ${booking.promoCode}`,
      amount: -Math.round(promoDiscount * 100),
      currency: "gbp",
      ...vatParams,
    });
  }

  const finalized = await stripe.invoices.finalizeInvoice(invoiceObj.id);
  const sent = await stripe.invoices.sendInvoice(finalized.id);

  const dueDate = sent.due_date
    ? new Date(sent.due_date * 1000)
    : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  return {
    alreadyPaid: false,
    invoiceId: sent.id,
    pdfUrl: sent.invoice_pdf || null,
    paymentUrl: sent.hosted_invoice_url || null,
    dueDate,
  };
}
