import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { and, desc, eq, sql } from "drizzle-orm";
import { activityLogTable, bookingsTable, db, type Booking } from "@workspace/db";
import {
  checkoutQuoteHash,
  validateCompletedCheckoutSession,
  validateCheckoutSessionOwnership,
} from "./stripe-checkout-validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Method = "card" | "invoice" | "reissue";
type PaymentReply =
  | { sessionId: string; url: string }
  | {
      invoiceId: string;
      invoiceUrl: string | null;
      paymentUrl: string | null;
      invoiceReference: string;
      alreadyProcessed?: boolean;
    };
type Attempt = {
  method: Method;
  fingerprint: string;
  issued: boolean;
  previousInvoiceId?: string;
  summary?: string;
};
const ATTEMPT = "checkout_payment_attempt";
const RETRY_WINDOW = 23 * 60 * 60 * 1000;

export class CheckoutPaymentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function fingerprint(booking: Booking, method: Method) {
  const billing =
    method !== "card"
      ? [
          booking.billingName,
          booking.billingCompany,
          booking.billingEmail,
          booking.billingAddressLine1,
          booking.billingAddressLine2,
          booking.billingTown,
          booking.billingRegion,
          booking.billingPostcode,
          booking.billingCountry,
          booking.poNumber,
          booking.billingVatNumber,
          method === "reissue" ? booking.stripeInvoiceId : null,
        ]
      : [booking.billingEmail];
  return createHash("sha256")
    .update(JSON.stringify([checkoutQuoteHash(booking), method, billing]))
    .digest("hex");
}

async function latestAttempt(tx: Tx, bookingId: number) {
  const [row] = await tx
    .select()
    .from(activityLogTable)
    .where(and(eq(activityLogTable.bookingId, bookingId), eq(activityLogTable.type, ATTEMPT)))
    .orderBy(desc(activityLogTable.id))
    .limit(1);
  return row ? { id: row.id, createdAt: row.createdAt, data: row.data as Attempt } : undefined;
}

async function underBookingLock<T>(
  id: number,
  owner: string | undefined,
  run: (tx: Tx, booking: Booking) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647)
    throw new CheckoutPaymentError(400, "Invalid booking reference");
  return db.transaction(async (tx) => {
    // The second tab must return promptly while the first is waiting for Stripe.
    const lock = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(20270303, ${id}) AS acquired`,
    );
    if (!lock.rows[0]?.acquired)
      throw new CheckoutPaymentError(
        409,
        "Payment is already being processed. Please wait and check your booking.",
      );
    const [booking] = await tx
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, id))
      .for("update");
    if (!booking) throw new CheckoutPaymentError(404, "Booking not found");
    if (!owner || booking.sessionToken !== owner)
      throw new CheckoutPaymentError(403, "Invalid booking session");
    return run(tx, booking);
  });
}

function existingOutcome(booking: Booking, method: Method): PaymentReply | undefined {
  if (
    (method === "invoice" || (method === "reissue" && booking.status === "paid")) &&
    (booking.status === "invoiced" || booking.status === "paid")
  ) {
    return {
      invoiceId: booking.stripeInvoiceId || `manual-${booking.orderReference}`,
      invoiceUrl: booking.stripeInvoicePdfUrl,
      paymentUrl: booking.stripeInvoicePaymentUrl,
      invoiceReference: booking.orderReference || "",
      alreadyProcessed: true,
    };
  }
  if (method === "reissue" && booking.status === "invoiced" && booking.stripeInvoiceId)
    return undefined;
  if (
    method === "reissue" ||
    (booking.status !== "partial" && booking.status !== "pending_payment")
  )
    throw new CheckoutPaymentError(
      409,
      "This booking is closed. Open its confirmation or contact the event team.",
    );
  return undefined;
}

async function resolvePreviousCard(
  stripe: Stripe,
  tx: Tx,
  booking: Booking,
  method: Method | "free",
): Promise<PaymentReply | undefined> {
  if (!booking.stripeSessionId) return undefined;
  const session = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
  if (!session || !validateCheckoutSessionOwnership(session, booking).ok)
    throw new CheckoutPaymentError(
      409,
      "We could not verify the previous payment. Please retry before starting another.",
    );
  if (session.payment_status === "paid" || session.status === "complete") {
    const match = validateCompletedCheckoutSession(session, booking);
    if (
      method === "card" &&
      match.ok &&
      (!session.metadata?.checkoutQuote ||
        session.metadata.checkoutQuote === checkoutQuoteHash(booking))
    ) {
      const url = new URL("/", process.env.APP_BASE_URL || "https://register.swpsummit.com");
      url.searchParams.set("session_id", session.id);
      url.searchParams.set("step", "5");
      return { sessionId: session.id, url: url.toString() };
    }
    throw new CheckoutPaymentError(
      409,
      "Your previous payment has completed. Please check its confirmation before trying again.",
    );
  }
  if (session.status === "open") {
    const sameQuote = session.metadata?.checkoutQuote
      ? session.metadata.checkoutQuote === checkoutQuoteHash(booking)
      : session.currency === "gbp" &&
        session.amount_total === Math.round(Number(booking.totalAmount) * 100);
    if (method === "card" && sameQuote && session.url)
      return { sessionId: session.id, url: session.url };
    // Across methods or revised terms, never leave both payment links payable.
    const expired = await stripe.checkout.sessions.expire(session.id);
    if (expired.status !== "expired")
      throw new CheckoutPaymentError(
        409,
        "Your earlier payment is still being checked. Please retry shortly.",
      );
  } else if (session.status !== "expired") {
    throw new CheckoutPaymentError(409, "Please wait while your earlier card payment is checked.");
  }
  await tx
    .update(bookingsTable)
    .set({ stripeSessionId: null })
    .where(eq(bookingsTable.id, booking.id));
  return undefined;
}

export async function protectComplimentaryConfirmation(
  tx: Tx,
  booking: Booking,
  stripe: Stripe | null,
) {
  const prior = await latestAttempt(tx, booking.id);
  if (prior && !prior.data.issued)
    throw new CheckoutPaymentError(
      409,
      "An earlier payment is still being checked. Contact the event team before confirming.",
    );
  if (booking.stripeSessionId) {
    if (!stripe)
      throw new CheckoutPaymentError(
        409,
        "The previous card payment cannot be verified. Please retry later.",
      );
    await resolvePreviousCard(stripe, tx, booking, "free");
  }
}

type Prepared = { reply: PaymentReply } | { id: number; fingerprint: string };
// Commit the attempt identity before any chargeable operation. The existing private
// booking activity journal survives restarts without storing contact details or payment URLs.
export async function runCheckoutAttempt(
  stripe: Stripe,
  id: number,
  owner: string | undefined,
  method: Method,
  issue: (tx: Tx, booking: Booking, key: string) => Promise<PaymentReply>,
  validate: (booking: Booking, tx: Tx) => Promise<void>,
): Promise<PaymentReply> {
  const prepared = await underBookingLock<Prepared>(id, owner, async (tx, booking) => {
    const finished = existingOutcome(booking, method);
    if (finished) return { reply: finished };
    await validate(booking, tx);
    const previousCard = await resolvePreviousCard(stripe, tx, booking, method);
    if (previousCard) return { reply: previousCard };
    const terms = fingerprint(booking, method);
    const prior = await latestAttempt(tx, id);
    if (prior && !prior.data.issued) {
      if (
        prior.data.method !== method ||
        prior.data.fingerprint !== terms ||
        Date.now() - prior.createdAt.getTime() >= RETRY_WINDOW
      )
        throw new CheckoutPaymentError(
          409,
          "An earlier payment needs checking. Contact the event team before starting another payment.",
        );
      return { id: prior.id, fingerprint: terms };
    }
    const [row] = await tx
      .insert(activityLogTable)
      .values({
        bookingId: id,
        type: ATTEMPT,
        actor: "checkout",
        data: {
          method,
          fingerprint: terms,
          issued: false,
          ...(method === "reissue" && booking.stripeInvoiceId
            ? { previousInvoiceId: booking.stripeInvoiceId }
            : {}),
          summary: `Started ${method} checkout. Reuse this attempt if the provider response is interrupted.`,
        } satisfies Attempt,
      })
      .returning({ id: activityLogTable.id });
    return { id: row.id, fingerprint: terms };
  });
  if ("reply" in prepared) return prepared.reply;
  return underBookingLock(id, owner, async (tx, booking) => {
    const finished = existingOutcome(booking, method);
    if (finished) return finished;
    const prior = await latestAttempt(tx, id);
    if (!prior || prior.id !== prepared.id || fingerprint(booking, method) !== prepared.fingerprint)
      throw new CheckoutPaymentError(
        409,
        "Your booking changed. Review the current total before continuing.",
      );
    if (prior.data.issued) {
      const reply = await resolvePreviousCard(stripe, tx, booking, method);
      if (reply) return reply;
      throw new CheckoutPaymentError(409, "Please retry to open the current payment.");
    }
    const reply = await issue(tx, booking, `swp-2027-${id}-${prior.id}`);
    await tx
      .update(activityLogTable)
      .set({ data: { ...prior.data, issued: true, summary: `Issued ${method} checkout.` } })
      .where(eq(activityLogTable.id, prior.id));
    return reply;
  });
}

export async function replacingInvoice(tx: Tx, bookingId: number, invoiceId: string) {
  const attempt = await latestAttempt(tx, bookingId);
  return (
    !!attempt &&
    attempt.data.method === "reissue" &&
    !attempt.data.issued &&
    attempt.data.previousInvoiceId === invoiceId
  );
}
