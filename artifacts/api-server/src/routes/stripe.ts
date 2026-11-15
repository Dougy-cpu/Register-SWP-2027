import { Router, type IRouter } from "express";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  bookingsTable,
  attendeesTable,
  promoCodesTable,
  sponsorPromoCodesTable,
} from "@workspace/db";
import { isCodeUsedByEmail } from "./promo-codes";
import { releaseSponsorRedemption, reservePromoUsageForBooking } from "../lib/sponsor-redemptions";
import {
  sendCheckoutExpiredEmail,
  sendRefundConfirmationEmail,
  sendInvoicePaymentFailedEmail,
  sendDisputeAlertEmail,
} from "../lib/email";
import { syncBookingToSheets } from "../lib/google-sheets";
import { logger } from "../lib/logger";
import {
  reissueBookingInvoice,
  applyReissueInvoiceResultTx,
  isInvoiceBeingReplaced,
} from "../lib/invoice";
import { claimBookingConfirmation, runConfirmationSideEffects } from "../lib/booking-confirmation";
import { defaultOrderRef } from "../lib/order-reference";
import { getStripe } from "../lib/stripe-client";
import {
  checkoutSessionBookingId,
  validateCheckoutSessionOwnership,
  STRIPE_REGISTRATION_APP,
} from "../lib/stripe-checkout-validation";
import { buildStripePaymentDetails } from "../lib/stripe-payment-details";
import {
  invoicePaymentFailureReason,
  syncStripeInvoicePaymentDetails,
} from "../lib/stripe-invoice-payments";

import { createOrResumeCheckout, settleCheckoutPayment } from "../lib/stripe-checkout";
import {
  PaymentOperationBusy,
  PaymentOperationError,
  withPaymentOperation,
} from "../lib/payment-operations";

const DECLINE_CODE_LABELS: Record<string, string> = {
  authentication_required: "Strong customer authentication required - please retry your payment",
  card_declined: "Card declined by your bank",
  do_not_honor: "Card declined - please contact your bank",
  expired_card: "Card has expired",
  fraudulent: "Suspected fraudulent activity - please contact your bank",
  generic_decline: "Card declined",
  incorrect_cvc: "Incorrect security code (CVC)",
  insufficient_funds: "Insufficient funds",
  invalid_account: "Invalid account",
  lost_card: "Card reported lost - please contact your bank",
  new_account_information_available: "Card details have changed - please use your updated card",
  no_action_taken: "Card declined - no action taken by bank",
  not_permitted: "This card type is not permitted for this transaction",
  restricted_card: "Card is restricted",
  stolen_card: "Card reported stolen - please contact your bank",
  transaction_not_allowed: "Transaction not allowed on this card",
};

const DISPUTE_REASON_LABELS: Record<string, string> = {
  credit_not_processed: "Credit not processed",
  duplicate: "Duplicate charge",
  fraudulent: "Fraudulent",
  general: "General",
  product_not_received: "Product / service not received",
  product_unacceptable: "Product / service unacceptable",
  subscription_canceled: "Subscription cancelled",
  unrecognized: "Unrecognised transaction",
};

const router: IRouter = Router();

/**
 * Shared handler for Stripe `invoice.paid` and `invoice.payment_succeeded` events.
 *
 * Idempotency:
 *  - The status flip is performed by `claimBookingConfirmation`, a single
 *    conditional UPDATE that only flips a non-paid row paid. Concurrent
 *    webhook deliveries lose the race silently.
 *  - Side-effects are routed through `runConfirmationSideEffects`, which
 *    uses per-flag atomic claims so each side-effect runs at most once
 *    on the happy path AND retries automatically when Stripe replays the
 *    webhook for an already-confirmed booking with stuck flags.
 */
async function handleInvoicePaidEvent(stripe: Stripe, event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.id) return;
  const [candidate] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.stripeInvoiceId, invoice.id));
  if (!candidate) {
    logger.info({ invoiceId: invoice.id }, "Invoice payment has no matching booking");
    return;
  }
  let detailsError: unknown;
  const applied = await withPaymentOperation(candidate.id, async (ops) => {
    const [booking] = await ops.db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, candidate.id));
    if (!booking || booking.stripeInvoiceId !== invoice.id) return false;
    if (!["partial", "pending_payment", "invoiced", "paid"].includes(booking.status)) {
      await ops.alert("An invoice payment was received for a closed booking", {
        invoiceId: invoice.id,
      });
      return false;
    }
    const attendees = await ops.db
      .select()
      .from(attendeesTable)
      .where(eq(attendeesTable.bookingId, booking.id));
    const lead = attendees.find((attendee) => attendee.isLead) || attendees[0];
    let paymentIntentId: string | null = null;
    try {
      if (!lead) throw new Error("No attendee found for invoice payment details");
      paymentIntentId = await syncStripeInvoicePaymentDetails(
        stripe,
        invoice,
        buildStripePaymentDetails(booking, lead, "invoice", invoice),
        (id) => {
          paymentIntentId = id;
        },
      );
    } catch (err) {
      detailsError = err;
      logger.error(
        { err, invoiceId: invoice.id, bookingId: booking.id },
        "Invoice payment labels need retry",
      );
    }
    await ops.db
      .update(bookingsTable)
      .set({
        stripeInvoiceStatus: "paid",
        stripeInvoiceStatusSyncedAt: new Date(),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      })
      .where(eq(bookingsTable.id, booking.id));
    await claimBookingConfirmation(
      booking.id,
      "paid",
      {
        paidConfirmationEmailSentAt: new Date(),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      },
      ["partial", "pending_payment", "invoiced"],
      ops.db,
    );
    return true;
  });
  if (applied) await runConfirmationSideEffects(candidate.id);
  // Keep confirmation independent of optional labels. Stripe replays any
  // failed label update without issuing a second confirmation.
  if (detailsError) throw detailsError;
}

async function isPromoOncePerCustomerViolation(
  bookingId: number,
  promoCode: string | null,
): Promise<boolean> {
  if (!promoCode) return false;
  const [promo] = await db
    .select()
    .from(promoCodesTable)
    .where(eq(promoCodesTable.code, promoCode));
  if (!promo?.oncePerCustomer) return false;
  const allAttendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const leadAttendee = allAttendees.find((a) => a.isLead) || allAttendees[0];
  const email = (leadAttendee?.workEmail || "").trim().toLowerCase();
  if (!email) return false;
  return await isCodeUsedByEmail(promoCode, email, bookingId);
}

router.post("/stripe/create-checkout-session", async (req, res): Promise<void> => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(500).json({ error: "Stripe is not configured. Set STRIPE_SECRET_KEY." });
    return;
  }

  const { bookingId, successUrl, cancelUrl } = req.body;

  if (!bookingId || !successUrl || !cancelUrl) {
    res.status(400).json({ error: "bookingId, successUrl, and cancelUrl are required" });
    return;
  }

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, parseInt(bookingId, 10)));

  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const sessionHeader = req.headers["x-booking-session"] as string | undefined;
  const ownsBooking =
    sessionHeader && booking.sessionToken && sessionHeader === booking.sessionToken;
  if (!ownsBooking) {
    res.status(403).json({ error: "Forbidden - invalid booking session" });
    return;
  }

  if (await isPromoOncePerCustomerViolation(booking.id, booking.promoCode)) {
    res.status(400).json({
      error: "This promo code has already been used on a previous booking with this email",
    });
    return;
  }

  try {
    const session = await withPaymentOperation(booking.id, async (ops) => {
      const [fresh] = await ops.db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, booking.id));
      if (!fresh || fresh.sessionToken !== sessionHeader)
        throw new PaymentOperationError("Forbidden - invalid booking session", 403);
      const attendees = await ops.db
        .select()
        .from(attendeesTable)
        .where(eq(attendeesTable.bookingId, booking.id));
      const lead = attendees.find((attendee) => attendee.isLead) || attendees[0];
      if (!lead) throw new PaymentOperationError("No attendee found for booking", 400);
      return createOrResumeCheckout(stripe, ops, fresh, lead, successUrl, cancelUrl);
    });
    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    if (err instanceof PaymentOperationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err, bookingId }, "Stripe checkout setup failed; saved attempt can be retried");
    res.status(502).json({
      error: "Payment setup could not finish. Please retry to resume the same payment safely.",
    });
  }
});

router.post("/stripe/webhook", async (req, res): Promise<void> => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(200).json({ received: true });
    return;
  }

  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event: Stripe.Event;

  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else if (process.env.NODE_ENV === "production") {
      logger.error("STRIPE_WEBHOOK_SECRET is not set in production - rejecting webhook");
      res.status(400).json({ error: "Webhook not configured - set STRIPE_WEBHOOK_SECRET" });
      return;
    } else {
      logger.warn("STRIPE_WEBHOOK_SECRET not set - accepting without verification (dev only)");
      const raw = Buffer.isBuffer(req.body) ? req.body.toString() : req.body;
      event = (typeof raw === "string" ? JSON.parse(raw) : raw) as Stripe.Event;
    }
  } catch (err) {
    logger.error({ err }, "Webhook signature verification failed");
    res.status(400).json({ error: "Webhook error" });
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = checkoutSessionBookingId(session);
    if (bookingId) {
      try {
        await withPaymentOperation(bookingId, (ops) => settleCheckoutPayment(stripe, ops, session));
      } catch (err) {
        if (!(err instanceof PaymentOperationError) || err instanceof PaymentOperationBusy)
          throw err;
        logger.warn(
          { err, bookingId, sessionId: session.id },
          "Checkout payment could not be applied automatically",
        );
        res.json({ received: true });
        return;
      }
      await runConfirmationSideEffects(bookingId);
    } else {
      logger.warn({ sessionId: session.id }, "Stripe checkout event has an invalid booking ID");
    }
  }

  // When someone pays a Stripe invoice (e.g. via the hosted payment link), automatically
  // flip the booking status to "paid" and send the same confirmation + welcome emails the
  // card flow does. Both `invoice.paid` and `invoice.payment_succeeded` are wired here for
  // resilience - Stripe sends both in quick succession and webhooks can be retried, so the
  // handler must be fully idempotent (gated by paidConfirmationEmailSentAt).
  if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
    await handleInvoicePaidEvent(stripe, event);
  }

  // Replacement invoices deliberately void their predecessors. A delayed
  // callback must not cancel the replacement booking or release its allocation.
  if (event.type === "invoice.voided") {
    const invoice = event.data.object as Stripe.Invoice;
    const [candidate] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripeInvoiceId, invoice.id));
    let cancelled = false;
    if (candidate) {
      await withPaymentOperation(candidate.id, async (ops) => {
        const [booking] = await ops.db
          .select()
          .from(bookingsTable)
          .where(eq(bookingsTable.id, candidate.id));
        if (
          !booking ||
          booking.stripeInvoiceId !== invoice.id ||
          (await isInvoiceBeingReplaced(ops, invoice.id))
        )
          return;
        cancelled = !["paid", "cancelled", "refunded", "disputed"].includes(booking.status);
        await ops.db
          .update(bookingsTable)
          .set({
            stripeInvoiceStatus: "void",
            stripeInvoiceStatusSyncedAt: new Date(),
            updatedAt: new Date(),
            ...(cancelled ? { status: "cancelled" } : {}),
          })
          .where(eq(bookingsTable.id, booking.id));
      });
      if (cancelled) await releaseSponsorRedemption(candidate.id, "stripe_invoice_voided");
      await syncBookingToSheets(candidate.id);
    }
  }

  // Stripe gives up trying to collect - cache the status so the UI badge reflects it.
  // We leave the booking in `invoiced` so the organiser can decide whether to chase or
  // cancel manually.
  if (event.type === "invoice.marked_uncollectible") {
    const invoice = event.data.object as Stripe.Invoice;
    const invoiceId = invoice.id;
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripeInvoiceId, invoiceId));
    if (booking) {
      await db
        .update(bookingsTable)
        .set({
          stripeInvoiceStatus: "uncollectible",
          stripeInvoiceStatusSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(bookingsTable.id, booking.id));
      logger.info(
        { bookingId: booking.id, invoiceId },
        "invoice.marked_uncollectible: cached status",
      );
    }
  }

  // Only the current, naturally expired checkout can reset an unpaid booking.
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = checkoutSessionBookingId(session);
    let reset = false;
    if (bookingId) {
      await withPaymentOperation(bookingId, async (ops) => {
        const [booking] = await ops.db
          .select()
          .from(bookingsTable)
          .where(eq(bookingsTable.id, bookingId));
        if (
          !booking ||
          booking.status !== "pending_payment" ||
          !validateCheckoutSessionOwnership(session, booking).ok
        )
          return;
        const attempts = await ops.attempts("card");
        if (
          attempts.some(
            (attempt) =>
              attempt.steps.checkout?.resultId === session.id &&
              ["expired", "superseded"].includes(attempt.status),
          )
        )
          return;
        if (
          attempts.some(
            (attempt) =>
              !["expired", "superseded"].includes(attempt.status) &&
              attempt.steps.checkout?.resultId !== session.id,
          )
        )
          return;
        if (
          (await ops.attempts("invoice")).some(
            (attempt) => !["expired", "superseded"].includes(attempt.status),
          )
        )
          return;
        await ops.db
          .update(bookingsTable)
          .set({ status: "partial", stripeSessionId: null, updatedAt: new Date() })
          .where(eq(bookingsTable.id, bookingId));
        reset = true;
      });
      if (reset) await sendCheckoutExpiredEmail(bookingId);
    }
  }

  // A charge was refunded - mark the booking as refunded and email the customer, but only for full refunds.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    const isFullRefund = charge.refunded === true || charge.amount_refunded >= charge.amount;

    if (paymentIntentId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.stripePaymentIntentId, paymentIntentId));

      if (booking && !isFullRefund) {
        logger.info(
          {
            bookingId: booking.id,
            paymentIntentId,
            amountRefunded: charge.amount_refunded,
            total: charge.amount,
          },
          "charge.refunded: partial refund - booking status unchanged",
        );
      } else if (booking && isFullRefund && booking.status !== "refunded") {
        await db
          .update(bookingsTable)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(eq(bookingsTable.id, booking.id));
        await releaseSponsorRedemption(booking.id, "stripe_charge_refunded");

        logger.info(
          { bookingId: booking.id, paymentIntentId, amountRefunded: charge.amount_refunded },
          "charge.refunded: full refund - booking marked refunded",
        );

        try {
          await sendRefundConfirmationEmail(booking.id, charge.amount_refunded);
        } catch (err) {
          logger.error(
            { err, bookingId: booking.id },
            "charge.refunded: failed to send refund confirmation email",
          );
        }

        try {
          await syncBookingToSheets(booking.id);
        } catch (err) {
          logger.error(
            { err, bookingId: booking.id },
            "charge.refunded: failed to re-sync to Google Sheets",
          );
        }
      }
    }
  }

  // Stripe invoice payment attempt failed - email the customer with the specific decline reason.
  if (event.type === "invoice.payment_failed") {
    const stripe = getStripe();
    const invoice = event.data.object as Stripe.Invoice;
    const invoiceId = invoice.id;

    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripeInvoiceId, invoiceId));

    if (booking && !["paid", "cancelled", "refunded", "disputed"].includes(booking.status)) {
      let declineReason: string | undefined;
      if (stripe) {
        // Both legacy payment_intent and modern InvoicePayment relationships
        // resolve through the same read-only lookup used for reconciliation.
        declineReason = await invoicePaymentFailureReason(stripe, invoice, DECLINE_CODE_LABELS);
      }

      const attemptCount = invoice.attempt_count ?? undefined;
      logger.info(
        { bookingId: booking.id, invoiceId, declineReason, attemptCount },
        "invoice.payment_failed: notifying customer",
      );

      try {
        await sendInvoicePaymentFailedEmail(booking.id, declineReason, attemptCount);
      } catch (err) {
        logger.error(
          { err, bookingId: booking.id },
          "invoice.payment_failed: failed to send notification email",
        );
      }
    }
  }

  // A payment dispute (chargeback) has been filed - mark booking disputed and alert organisers urgently.
  if (event.type === "charge.dispute.created") {
    const stripe = getStripe();
    const dispute = event.data.object as Stripe.Dispute;

    // Resolve the payment intent ID - try the dispute object first, fall back to retrieving the charge
    let piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : null;
    if (!piId && stripe) {
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : null;
      if (chargeId) {
        try {
          const charge = await stripe.charges.retrieve(chargeId);
          piId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
        } catch (chargeErr) {
          logger.warn(
            { chargeErr, chargeId },
            "charge.dispute.created: could not retrieve charge to resolve payment intent",
          );
        }
      }
    }

    if (piId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.stripePaymentIntentId, piId));

      if (booking) {
        await db
          .update(bookingsTable)
          .set({ status: "disputed", updatedAt: new Date() })
          .where(eq(bookingsTable.id, booking.id));

        const reasonLabel = DISPUTE_REASON_LABELS[dispute.reason] || dispute.reason || "Unknown";
        const dueBy = dispute.evidence_details?.due_by
          ? new Date(dispute.evidence_details.due_by * 1000)
          : null;

        logger.info(
          { bookingId: booking.id, disputeId: dispute.id, reason: dispute.reason, dueBy },
          "dispute.created: booking marked as disputed",
        );

        try {
          await sendDisputeAlertEmail(booking.id, dispute.id, dispute.amount, reasonLabel, dueBy);
        } catch (err) {
          logger.error(
            { err, bookingId: booking.id, disputeId: dispute.id },
            "dispute.created: failed to send alert email",
          );
        }

        try {
          await syncBookingToSheets(booking.id);
        } catch (err) {
          logger.error(
            { err, bookingId: booking.id },
            "dispute.created: failed to re-sync to Google Sheets",
          );
        }
      } else {
        logger.info(
          { piId, disputeId: dispute.id },
          "dispute.created: no matching booking found, skipping",
        );
      }
    }
  }

  // A card payment attempt failed during Stripe Checkout - log the decline code for admin visibility.
  // No status change; Stripe Checkout handles retries inline so no customer email is sent here.
  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object as Stripe.PaymentIntent;
    const piId = pi.id;
    const err = pi.last_payment_error;
    const declineCode = err?.decline_code || err?.code || "unknown";
    const declineMessage = DECLINE_CODE_LABELS[declineCode] || err?.message || "Unknown reason";

    // Try to identify the booking for richer log context
    const [storedBooking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripePaymentIntentId, piId));
    let booking: typeof storedBooking | undefined = storedBooking;

    const candidateId = checkoutSessionBookingId(pi);
    if (!booking && candidateId && pi.metadata?.registrationApp === STRIPE_REGISTRATION_APP) {
      booking = await withPaymentOperation(candidateId, async (ops) => {
        const attempt = (await ops.attempts("card")).find(
          (item) => item.id === pi.metadata.paymentAttemptId && item.steps.checkout,
        );
        const customer = typeof pi.customer === "string" ? pi.customer : pi.customer?.id;
        if (!attempt || !customer || customer !== attempt.steps.customer?.resultId)
          return undefined;
        return (
          await ops.db.select().from(bookingsTable).where(eq(bookingsTable.id, candidateId))
        )[0];
      });
    }

    logger.info(
      { piId, declineCode, declineMessage, bookingId: booking?.id ?? null },
      "payment_intent.payment_failed: card decline logged",
    );
  }

  res.json({ received: true });
});

router.post("/stripe/confirm-card-payment", async (req, res): Promise<void> => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(500).json({ error: "Stripe is not configured." });
    return;
  }

  const { bookingId, sessionId } = req.body;
  if (!bookingId || !sessionId) {
    res.status(400).json({ error: "bookingId and sessionId are required" });
    return;
  }

  const id = parseInt(bookingId, 10);
  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const sessionHeader = req.headers["x-booking-session"] as string | undefined;
  const ownsBooking =
    sessionHeader && existing.sessionToken && sessionHeader === existing.sessionToken;
  if (!ownsBooking) {
    res.status(403).json({ error: "Forbidden - invalid booking session" });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const result = await withPaymentOperation(id, async (ops) => {
      const [fresh] = await ops.db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
      if (!fresh || fresh.sessionToken !== sessionHeader)
        throw new PaymentOperationError("Forbidden - invalid booking session", 403);
      return settleCheckoutPayment(stripe, ops, session);
    });
    await runConfirmationSideEffects(id);
    res.json(result);
  } catch (err) {
    if (err instanceof PaymentOperationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err, bookingId: id }, "confirm-card-payment: verification needs retry");
    res.status(502).json({ error: "Payment verification could not finish. Please retry shortly." });
  }
});

router.post("/stripe/create-invoice", async (req, res): Promise<void> => {
  const stripe = getStripe();
  if (!stripe) {
    res.status(500).json({ error: "Stripe is not configured. Set STRIPE_SECRET_KEY." });
    return;
  }

  const { bookingId } = req.body;
  if (!bookingId) {
    res.status(400).json({ error: "bookingId is required" });
    return;
  }

  const id = parseInt(bookingId, 10);
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));

  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  const sessionHeader = req.headers["x-booking-session"] as string | undefined;
  const ownsBooking =
    sessionHeader && booking.sessionToken && sessionHeader === booking.sessionToken;
  if (!ownsBooking) {
    res.status(403).json({ error: "Forbidden - invalid booking session" });
    return;
  }

  if (await isPromoOncePerCustomerViolation(booking.id, booking.promoCode)) {
    res.status(400).json({
      error: "This promo code has already been used on a previous booking with this email",
    });
    return;
  }
  try {
    const response = await withPaymentOperation(id, async (ops) => {
      const [fresh] = await ops.db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
      if (!fresh || fresh.sessionToken !== sessionHeader)
        throw new PaymentOperationError("Forbidden - invalid booking session", 403);
      const unfinished = (await ops.attempts("invoice")).some((attempt) =>
        ["pending", "review"].includes(attempt.status),
      );
      if (
        fresh.status === "paid" ||
        (fresh.status === "invoiced" && fresh.stripeInvoiceId && !unfinished)
      ) {
        return {
          invoiceId: fresh.stripeInvoiceId || `manual-${fresh.orderReference}`,
          invoiceUrl: fresh.stripeInvoicePdfUrl || null,
          paymentUrl: fresh.stripeInvoicePaymentUrl || null,
          invoiceReference: fresh.orderReference || "",
          alreadyProcessed: true,
        };
      }
      if (!["partial", "pending_payment", "invoiced"].includes(fresh.status))
        throw new PaymentOperationError("This booking is closed. An invoice cannot be created.");
      const attendees = await ops.db
        .select()
        .from(attendeesTable)
        .where(eq(attendeesTable.bookingId, id));
      if (!attendees.length) throw new PaymentOperationError("No attendee found for booking", 400);
      // Reserve sponsor capacity before making an invoice payable. Keep the
      // reservation on failure: a timed-out Stripe call may already have succeeded.
      // A retry resumes it; deliberate cancellation releases it through the normal flow.
      if (fresh.promoCode) {
        const [mapping] = await ops.db
          .select({ sponsorId: sponsorPromoCodesTable.sponsorId })
          .from(promoCodesTable)
          .innerJoin(
            sponsorPromoCodesTable,
            eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id),
          )
          .where(eq(promoCodesTable.code, fresh.promoCode));
        if (mapping?.sponsorId) {
          const reserved = await ops.db.transaction((tx) =>
            reservePromoUsageForBooking(fresh.promoCode!, fresh.quantity, id, tx),
          );
          if (!reserved)
            throw new PaymentOperationError(
              "This sponsor pass allocation no longer has enough availability",
            );
        }
      }
      const result = await reissueBookingInvoice(stripe, id, ops);
      const orderRef = fresh.orderReference || defaultOrderRef(id);
      await ops.db.transaction(async (tx) => {
        await applyReissueInvoiceResultTx(tx, id, result, {
          currentStep: 5,
          orderReference: orderRef,
          paymentMethod: "invoice",
        });
        if (fresh.promoCode && !result.alreadyPaid && fresh.status !== "invoiced") {
          const reserved = await reservePromoUsageForBooking(
            fresh.promoCode,
            fresh.quantity,
            id,
            tx,
          );
          if (!reserved)
            logger.warn({ bookingId: id }, "Issued invoice requires promo allocation review");
        }
      });
      const [saved] = await ops.db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
      return {
        invoiceId: saved.stripeInvoiceId || `manual-${orderRef}`,
        invoiceUrl: saved.stripeInvoicePdfUrl || null,
        paymentUrl: saved.stripeInvoicePaymentUrl || null,
        invoiceReference: orderRef,
        ...(result.alreadyPaid ? { alreadyProcessed: true } : {}),
      };
    });
    await runConfirmationSideEffects(id);
    res.json(response);
  } catch (err) {
    if (err instanceof PaymentOperationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error(
      { err, bookingId: id },
      "Invoice setup failed; saved attempt and allocation remain available for retry",
    );
    res.status(502).json({
      error: "Invoice setup could not finish. Please retry to resume the same invoice safely.",
    });
  }
});

export default router;
