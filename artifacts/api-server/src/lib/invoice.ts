import type Stripe from "stripe";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bookingsTable, attendeesTable } from "@workspace/db";
import { logger } from "./logger";
import type { DbExecutor } from "./pricing";
import { defaultOrderRef } from "./order-reference";
import { getOrCreateStripeCustomer } from "./stripe-customer";
import { buildStripePaymentDetails, getStripeBillingDetails } from "./stripe-payment-details";
import { syncStripeInvoicePaymentDetails } from "./stripe-invoice-payments";
import {
  paymentFingerprint,
  PaymentOperationError,
  withPaymentOperation,
  type PaymentOperations,
  type PaymentAttempt,
} from "./payment-operations";
import { closePendingCheckoutsForInvoice } from "./stripe-checkout";
import type { StripeBillingDetails } from "./stripe-payment-details";

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
async function refreshInvoiceSnapshot(
  stripe: Stripe | null,
  bookingId: number,
  onlyIfStale: boolean,
): Promise<void> {
  if (!stripe) return;
  try {
    await withPaymentOperation(bookingId, async (ops) => {
      const [booking] = await ops.db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));
      if (!booking?.stripeInvoiceId) return;
      if (
        onlyIfStale &&
        (["paid", "cancelled"].includes(booking.status) ||
          Date.now() - (booking.stripeInvoiceStatusSyncedAt?.getTime() || 0) <
            STALE_INVOICE_STATUS_MS)
      )
        return;
      const invoice = await stripe.invoices.retrieve(booking.stripeInvoiceId);
      const replacing =
        invoice.status === "void" && (await isInvoiceBeingReplaced(ops, invoice.id));
      await ops.db
        .update(bookingsTable)
        .set({
          stripeInvoiceStatus: invoice.status,
          stripeInvoiceStatusSyncedAt: new Date(),
          ...(invoice.invoice_pdf ? { stripeInvoicePdfUrl: invoice.invoice_pdf } : {}),
          ...(invoice.hosted_invoice_url
            ? { stripeInvoicePaymentUrl: invoice.hosted_invoice_url }
            : {}),
          ...(invoice.status === "paid" &&
          !["paid", "refunded", "disputed"].includes(booking.status)
            ? { status: "paid", paidAt: booking.paidAt || new Date() }
            : {}),
          ...(invoice.status === "void" &&
          !replacing &&
          !["paid", "refunded", "disputed", "cancelled"].includes(booking.status)
            ? { status: "cancelled" }
            : {}),
        })
        .where(eq(bookingsTable.id, bookingId));
    });
  } catch (err) {
    logger.warn({ err, bookingId }, "Invoice refresh unavailable; cached booking retained");
  }
}

export async function refreshStripeInvoiceUrls(
  stripe: Stripe | null,
  bookingId: number,
): Promise<void> {
  return refreshInvoiceSnapshot(stripe, bookingId, false);
}

export async function refreshStripeInvoiceStatusIfStale(
  stripe: Stripe | null,
  bookingId: number,
): Promise<void> {
  return refreshInvoiceSnapshot(stripe, bookingId, true);
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
      .set({
        status: "paid",
        paidAt: sql`coalesce(${bookingsTable.paidAt}, now())`,
        ...(extras || {}),
      })
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
      .where(
        and(
          eq(bookingsTable.id, bookingId),
          eq(bookingsTable.stripeInvoiceId, result.invoiceId),
          inArray(bookingsTable.status, ["partial", "pending_payment", "invoiced"]),
        ),
      );
  }
}

/** Immutable request snapshot for a recoverable invoice revision. */
export interface InvoicePlan {
  billing: StripeBillingDetails;
  params: Stripe.InvoiceCreateParams;
  items: Array<{ key: string; params: Stripe.InvoiceItemCreateParams }>;
  previousInvoiceId: string | null;
}

async function invoiceFromAttempt(
  stripe: Stripe,
  ops: PaymentOperations,
  attempt: PaymentAttempt<InvoicePlan>,
): Promise<Stripe.Invoice> {
  const customer = await ops.step(attempt, "customer", attempt.plan.billing, () =>
    getOrCreateStripeCustomer(stripe, attempt.plan.billing, attempt.bookingId),
  );
  const params = {
    ...attempt.plan.params,
    customer,
    metadata: { ...attempt.plan.params.metadata, paymentAttemptId: attempt.id },
  };
  const id = await ops.step(attempt, "invoice", params, (options) =>
    stripe.invoices.create(params, options),
  );
  return stripe.invoices.retrieve(id);
}

async function retireInvoice(
  stripe: Stripe,
  ops: PaymentOperations,
  attempt: PaymentAttempt<InvoicePlan>,
  invoiceId: string,
): Promise<boolean> {
  const name = `retire-${invoiceId}`;
  if (attempt.steps[name]?.resultId) return true;
  let invoice: Stripe.Invoice;
  try {
    invoice = await stripe.invoices.retrieve(invoiceId);
  } catch (err) {
    // A draft deletion can succeed while its response (or our saved result) is lost.
    const previous = (await ops.attempts<InvoicePlan>("invoice")).find((item) => item.steps[name]);
    if ((err as { code?: string }).code !== "resource_missing" || !previous) throw err;
    await ops.record(attempt, name, { invoiceId, action: "delete" }, invoiceId);
    return true;
  }
  if (invoice.status === "paid") return false;
  if (invoice.status === "void") {
    await ops.record(attempt, name, { invoiceId, action: "void" }, invoiceId);
    return true;
  }
  if (!["draft", "open", "uncollectible"].includes(invoice.status || "")) {
    throw new PaymentOperationError(
      "The previous invoice status could not be verified. No replacement was created.",
    );
  }
  const action = invoice.status === "draft" ? "delete" : "void";
  try {
    await ops.step(attempt, name, { invoiceId, action }, (options) =>
      action === "delete"
        ? stripe.invoices.del(invoiceId, options)
        : stripe.invoices.voidInvoice(invoiceId, {}, options),
    );
  } catch (err) {
    const stripeError = err as { code?: string };
    if (action === "delete" && stripeError.code === "resource_missing") {
      await ops.record(attempt, name, { invoiceId, action }, invoiceId);
      return true;
    }
    invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status === "paid") return false;
    if (invoice.status !== "void") throw err;
    await ops.record(attempt, name, { invoiceId, action }, invoiceId);
  }
  return true;
}

export async function isInvoiceBeingReplaced(
  ops: PaymentOperations,
  invoiceId: string,
): Promise<boolean> {
  return (await ops.attempts<InvoicePlan>("invoice")).some((attempt) =>
    Boolean(attempt.steps[`retire-${invoiceId}`]),
  );
}

async function rememberInvoice(ops: PaymentOperations, invoice: Stripe.Invoice): Promise<void> {
  await ops.db
    .update(bookingsTable)
    .set({
      stripeInvoiceId: invoice.id,
      stripeInvoiceStatus: invoice.status,
      stripeInvoiceStatusSyncedAt: new Date(),
      stripeInvoicePdfUrl: invoice.invoice_pdf || null,
      stripeInvoicePaymentUrl: invoice.hosted_invoice_url || null,
      invoiceDueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    })
    .where(eq(bookingsTable.id, ops.bookingId));
}

/** Retry the same invoice operation; a changed billing/pricing snapshot starts a new revision. */
export async function reissueBookingInvoice(
  stripe: Stripe,
  bookingId: number,
  operations?: PaymentOperations,
): Promise<ReissueInvoiceResult> {
  if (!operations)
    return withPaymentOperation(bookingId, (ops) => reissueBookingInvoice(stripe, bookingId, ops));
  const ops = operations;
  const [booking] = await ops.db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) throw new Error("Booking not found");
  if (booking.status === "paid") return { alreadyPaid: true };
  if (!["partial", "pending_payment", "invoiced"].includes(booking.status)) {
    throw new PaymentOperationError("This booking is closed. An invoice cannot be created.");
  }
  await closePendingCheckoutsForInvoice(stripe, ops, booking);
  const attendees = await ops.db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((attendee) => attendee.isLead) || attendees[0];
  if (!lead) throw new Error("No attendee found for booking");
  const orderRef = booking.orderReference || defaultOrderRef(bookingId);
  const billing = getStripeBillingDetails(booking, lead);
  const details = buildStripePaymentDetails(booking, lead, "invoice");
  const subtotal = Number(booking.subtotalAmount || 0);
  const groupDiscount = Number(booking.groupDiscountAmount || 0);
  const promoDiscount = Number(booking.promoDiscountAmount || 0);
  const vatRateId = await getOrCreateVatRate(stripe);
  if (!vatRateId)
    throw new Error("Could not establish UK VAT 20% tax rate in Stripe - invoice not issued");
  const customFields = [
    { name: "Booking reference", value: orderRef },
    { name: "Company Number", value: "12252258" },
    { name: "VAT Number", value: "336124621" },
    booking.poNumber
      ? { name: "PO Number", value: booking.poNumber.slice(0, 30) }
      : { name: "Contact", value: "douglas@dynamicbusinessleaders.co.uk" },
  ];
  const items: InvoicePlan["items"] = [
    {
      key: "passes",
      params: {
        description: `${PASS_LABELS[booking.passType] || booking.passType}, quantity ${booking.quantity}`,
        amount: Math.round((subtotal + groupDiscount + promoDiscount) * 100),
        currency: "gbp",
        tax_rates: [vatRateId],
      },
    },
  ];
  if (groupDiscount > 0)
    items.push({
      key: "group",
      params: {
        description: "Group Discount",
        amount: -Math.round(groupDiscount * 100),
        currency: "gbp",
        tax_rates: [vatRateId],
      },
    });
  if (promoDiscount > 0)
    items.push({
      key: "promo",
      params: {
        description: `Promo Code: ${booking.promoCode}`,
        amount: -Math.round(promoDiscount * 100),
        currency: "gbp",
        tax_rates: [vatRateId],
      },
    });
  const params: Stripe.InvoiceCreateParams = {
    collection_method: "send_invoice",
    days_until_due: 14,
    description: details.description,
    footer: INVOICE_FOOTER,
    custom_fields: customFields,
    metadata: details.metadata,
    auto_advance: false,
  };
  const fingerprint = paymentFingerprint({ billing, params, items });
  const attempts = await ops.attempts<InvoicePlan>("invoice");
  let attempt = attempts.find(
    (item) => !["expired", "superseded"].includes(item.status) && item.fingerprint === fingerprint,
  );

  // Finish resolving an uncertain earlier creation before starting a replacement.
  // Never finalize/send an outdated revision just to recover its reference.
  for (const old of attempts) {
    if (old === attempt || ["expired", "superseded"].includes(old.status)) continue;
    if (old.steps.invoice?.rejected && !old.steps.invoice.resultId) {
      old.status = "superseded";
      await ops.save(old);
      continue;
    }
    if (!old.steps.invoice) {
      old.status = "superseded";
      await ops.save(old);
      continue;
    }
    const oldInvoiceId =
      old.steps.invoice.resultId || (await invoiceFromAttempt(stripe, ops, old)).id;
    if (!(await retireInvoice(stripe, ops, old, oldInvoiceId))) {
      await rememberInvoice(ops, await stripe.invoices.retrieve(oldInvoiceId));
      return { alreadyPaid: true };
    }
    old.status = "superseded";
    await ops.save(old);
  }

  if (!attempt) {
    attempt = await ops.start(
      "invoice",
      { billing, params, items, previousInvoiceId: booking.stripeInvoiceId },
      fingerprint,
    );
  }
  // Preserve legacy invoices and explicit billing revisions. An inability to
  // verify/cancel the old invoice stops creation instead of leaving two payable invoices.
  if (attempt.plan.previousInvoiceId && !attempt.steps.invoice?.resultId) {
    if (!(await retireInvoice(stripe, ops, attempt, attempt.plan.previousInvoiceId))) {
      await rememberInvoice(ops, await stripe.invoices.retrieve(attempt.plan.previousInvoiceId));
      return { alreadyPaid: true };
    }
  }
  let invoice = await invoiceFromAttempt(stripe, ops, attempt);
  await rememberInvoice(ops, invoice);
  if (invoice.status === "paid") return { alreadyPaid: true };
  if (!["draft", "open"].includes(invoice.status || "")) {
    return ops.review(attempt, "The saved invoice is no longer payable; its status needs review");
  }
  // Persist the external reference before finalization or email delivery.
  const customer = attempt.steps.customer.resultId!;
  if (invoice.status === "draft") {
    for (const item of attempt.plan.items) {
      const itemParams = { ...item.params, customer, invoice: invoice.id };
      await ops.step(attempt, `item-${item.key}`, itemParams, (options) =>
        stripe.invoiceItems.create(itemParams, options),
      );
    }
    await ops.step(attempt, "finalize", { invoiceId: invoice.id }, (options) =>
      stripe.invoices.finalizeInvoice(invoice.id, {}, options),
    );
    invoice = await stripe.invoices.retrieve(invoice.id);
  }
  await rememberInvoice(ops, invoice);
  if (invoice.status === "paid") return { alreadyPaid: true };
  if (invoice.status !== "open")
    return ops.review(attempt, "Invoice finalization did not produce an open invoice");
  await ops.record(attempt, "finalize", { invoiceId: invoice.id }, invoice.id);
  try {
    await syncStripeInvoicePaymentDetails(
      stripe,
      invoice,
      buildStripePaymentDetails(booking, lead, "invoice", invoice),
    );
  } catch (err) {
    logger.warn({ err, bookingId, invoiceId: invoice.id }, "Invoice payment labels pending sync");
  }
  await ops.step(attempt, "send", { invoiceId: invoice.id }, (options) =>
    stripe.invoices.sendInvoice(invoice.id, {}, options),
  );
  invoice = await stripe.invoices.retrieve(invoice.id);
  await rememberInvoice(ops, invoice);
  attempt.status = "ready";
  await ops.save(attempt);
  if (invoice.status === "paid") return { alreadyPaid: true };
  return {
    alreadyPaid: false,
    invoiceId: invoice.id,
    pdfUrl: invoice.invoice_pdf || null,
    paymentUrl: invoice.hosted_invoice_url || null,
    dueDate: invoice.due_date
      ? new Date(invoice.due_date * 1000)
      : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  };
}
