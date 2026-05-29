import { Router, type IRouter } from "express";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookingsTable, attendeesTable, promoCodesTable } from "@workspace/db";
import { isCodeUsedByEmail } from "./promo-codes";
import { incrementPromoUsage } from "../lib/pricing";
import {
  sendCheckoutExpiredEmail,
  sendRefundConfirmationEmail,
  sendInvoicePaymentFailedEmail,
  sendDisputeAlertEmail,
} from "../lib/email";
import { syncBookingToSheets } from "../lib/google-sheets";
import { logger } from "../lib/logger";
import { reissueBookingInvoice, applyReissueInvoiceResultTx } from "../lib/invoice";
import { claimBookingConfirmation, runConfirmationSideEffects } from "../lib/booking-confirmation";
import { defaultOrderRef } from "../lib/order-reference";
import { getStripe } from "../lib/stripe-client";

const DECLINE_CODE_LABELS: Record<string, string> = {
  authentication_required: "Strong customer authentication required â€” please retry your payment",
  card_declined: "Card declined by your bank",
  do_not_honor: "Card declined â€” please contact your bank",
  expired_card: "Card has expired",
  fraudulent: "Suspected fraudulent activity â€” please contact your bank",
  generic_decline: "Card declined",
  incorrect_cvc: "Incorrect security code (CVC)",
  insufficient_funds: "Insufficient funds",
  invalid_account: "Invalid account",
  lost_card: "Card reported lost â€” please contact your bank",
  new_account_information_available: "Card details have changed â€” please use your updated card",
  no_action_taken: "Card declined â€” no action taken by bank",
  not_permitted: "This card type is not permitted for this transaction",
  restricted_card: "Card is restricted",
  stolen_card: "Card reported stolen â€” please contact your bank",
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
 *    conditional UPDATE that only flips a non-paid row â†’ paid. Concurrent
 *    webhook deliveries lose the race silently.
 *  - Side-effects are routed through `runConfirmationSideEffects`, which
 *    uses per-flag atomic claims so each side-effect runs at most once
 *    on the happy path AND retries automatically when Stripe replays the
 *    webhook for an already-confirmed booking with stuck flags.
 */
async function handleInvoicePaidEvent(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const invoiceId = invoice.id;
  if (!invoiceId) {
    logger.warn({ eventType: event.type }, "invoice paid event without invoice id, skipping");
    return;
  }

  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.stripeInvoiceId, invoiceId));

  if (!booking) {
    logger.info(
      { invoiceId, eventType: event.type },
      "invoice paid: no matching booking, skipping",
    );
    return;
  }

  // Cache the latest Stripe status no matter what â€” even if we already processed,
  // a fresh sync is cheap and keeps the badge accurate.
  await db
    .update(bookingsTable)
    .set({
      stripeInvoiceStatus: "paid",
      stripeInvoiceStatusSyncedAt: new Date(),
    })
    .where(eq(bookingsTable.id, booking.id));

  const rawPaymentIntent = (invoice as unknown as Record<string, unknown>).payment_intent;
  const paymentIntentId: string | null =
    typeof rawPaymentIntent === "string"
      ? rawPaymentIntent
      : rawPaymentIntent && typeof rawPaymentIntent === "object" && "id" in rawPaymentIntent
        ? (rawPaymentIntent as { id: string }).id
        : null;

  // Atomic claim. We allow the flip from "invoiced" â†’ "paid" (the typical
  // happy path: invoice issued, then customer pays the hosted Stripe link)
  // as well as from partial/pending_payment in case the invoice flow skipped
  // those intermediates. paymentMethod stays "invoice" so invoice-specific
  // UI keeps rendering after settlement.
  const claimed = await claimBookingConfirmation(
    booking.id,
    "paid",
    {
      paidConfirmationEmailSentAt: new Date(),
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
    ["partial", "pending_payment", "invoiced"],
  );

  if (claimed) {
    logger.info(
      {
        bookingId: booking.id,
        invoiceId,
        orderRef: booking.orderReference,
        paymentIntentId,
        eventType: event.type,
      },
      "invoice paid: booking claimed â†’ paid, running side-effects",
    );
  } else {
    // Already paid â€” fall through to side-effect retry so a stuck flag from
    // a previous webhook delivery (e.g. SMTP blip) gets a fresh chance.
    logger.info(
      { bookingId: booking.id, invoiceId, eventType: event.type },
      "invoice paid: already confirmed â€” retrying any unfinished side-effects",
    );
  }

  await runConfirmationSideEffects(booking.id);
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
    res.status(403).json({ error: "Forbidden â€” invalid booking session" });
    return;
  }

  if (await isPromoOncePerCustomerViolation(booking.id, booking.promoCode)) {
    res.status(400).json({
      error: "This promo code has already been used on a previous booking with this email",
    });
    return;
  }

  const passLabels: Record<string, string> = {
    single: "HR Professional Pass â€” SWP Summit 2027",
    team: "Team Pass (3 Seats) â€” SWP Summit 2027",
    business: "Business Pass â€” SWP Summit 2027",
  };

  const subtotalAfterDiscounts = parseFloat(booking.subtotalAmount?.toString() || "0");
  const vatAmount = parseFloat(booking.vatAmount?.toString() || "0");

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency: "gbp",
        product_data: {
          name: passLabels[booking.passType] || booking.passType,
          description: `Wednesday, 3 March 2027 Â· 1 Basinghall Avenue, London Â· ${booking.quantity} ${booking.quantity === 1 ? "pass" : "passes"}`,
        },
        unit_amount: Math.round(subtotalAfterDiscounts * 100),
      },
      quantity: 1,
    },
    {
      price_data: {
        currency: "gbp",
        product_data: {
          name: "VAT (20%)",
        },
        unit_amount: Math.round(vatAmount * 100),
      },
      quantity: 1,
    },
  ];

  let session: import("stripe").Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        bookingId: String(bookingId),
      },
      customer_email: booking.billingEmail || undefined,
    });
  } catch (err) {
    const e = err as { raw?: { message?: string }; message?: string };
    const stripeMessage = e?.raw?.message || e?.message || "Stripe error";
    logger.error({ err, bookingId }, "Stripe checkout session creation failed");
    res.status(502).json({ error: `Payment provider error: ${stripeMessage}` });
    return;
  }

  await db
    .update(bookingsTable)
    .set({ stripeSessionId: session.id, status: "pending_payment" })
    .where(eq(bookingsTable.id, booking.id));

  res.json({ sessionId: session.id, url: session.url });
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
      logger.error("STRIPE_WEBHOOK_SECRET is not set in production â€” rejecting webhook");
      res.status(400).json({ error: "Webhook not configured â€” set STRIPE_WEBHOOK_SECRET" });
      return;
    } else {
      logger.warn("STRIPE_WEBHOOK_SECRET not set â€” accepting without verification (dev only)");
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
    const bookingId = parseInt(session.metadata?.bookingId || "0", 10);

    if (bookingId) {
      const [existing] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));

      if (!existing) {
        logger.warn({ bookingId }, "Stripe webhook: booking not found, skipping");
        res.json({ received: true });
        return;
      }

      const orderRef = existing.orderReference || defaultOrderRef(bookingId);

      // Atomic claim: only the first webhook delivery (or the racing
      // /confirm-card-payment caller) actually flips status â†’ paid; concurrent
      // duplicate events get back null and skip straight to side-effect retry.
      const claimed = await claimBookingConfirmation(bookingId, "paid", {
        currentStep: 5,
        stripePaymentIntentId: session.payment_intent as string,
        orderReference: orderRef,
        paymentMethod: "card",
      });

      if (claimed) {
        // Bump the promo counter ONCE, only on the path that actually flipped
        // the status â€” preserves the previous "atomic with the status flip"
        // intent (Task #59) and prevents double-increment on webhook replays.
        if (existing.promoCode) {
          try {
            const reserved = await incrementPromoUsage(existing.promoCode, existing.quantity);
            if (!reserved) {
              logger.warn(
                { bookingId, promoCode: existing.promoCode, quantity: existing.quantity },
                "Promo cap exceeded after successful card payment â€” booking confirmed but usage not incremented",
              );
            }
          } catch (err) {
            logger.error({ err, bookingId }, "Failed to increment promo usage after card payment");
          }
        }
      } else {
        logger.info(
          { bookingId, status: existing.status },
          "checkout.session.completed: already confirmed â€” retrying any unfinished side-effects",
        );
      }

      await runConfirmationSideEffects(bookingId);
    }
  }

  // When someone pays a Stripe invoice (e.g. via the hosted payment link), automatically
  // flip the booking status to "paid" and send the same confirmation + welcome emails the
  // card flow does. Both `invoice.paid` and `invoice.payment_succeeded` are wired here for
  // resilience â€” Stripe sends both in quick succession and webhooks can be retried, so the
  // handler must be fully idempotent (gated by paidConfirmationEmailSentAt).
  if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
    await handleInvoicePaidEvent(event);
  }

  // Invoice cancelled in Stripe (manually voided or via API). Cache the status so the
  // UI badge reflects "voided", and cancel the booking if it isn't already in a terminal
  // state. We deliberately don't refund anything here (voiding only applies to unpaid
  // invoices in Stripe).
  if (event.type === "invoice.voided") {
    const invoice = event.data.object as Stripe.Invoice;
    const invoiceId = invoice.id;
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripeInvoiceId, invoiceId));
    if (booking) {
      const updates: Partial<typeof bookingsTable.$inferInsert> = {
        stripeInvoiceStatus: "void",
        stripeInvoiceStatusSyncedAt: new Date(),
        updatedAt: new Date(),
      };
      if (booking.status !== "cancelled" && booking.status !== "refunded") {
        updates.status = "cancelled";
      }
      await db.update(bookingsTable).set(updates).where(eq(bookingsTable.id, booking.id));
      logger.info(
        { bookingId: booking.id, invoiceId, prevStatus: booking.status },
        "invoice.voided: booking updated",
      );
      try {
        await syncBookingToSheets(booking.id);
      } catch (err) {
        logger.error({ err, bookingId: booking.id }, "invoice.voided: sheets sync failed");
      }
    } else {
      logger.info({ invoiceId }, "invoice.voided: no matching booking, skipping");
    }
  }

  // Stripe gives up trying to collect â€” cache the status so the UI badge reflects it.
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

  // Stripe Checkout session expired without payment â€” reset booking to "partial" so
  // the customer can retry, and email them to let them know.
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = parseInt(session.metadata?.bookingId || "0", 10);

    if (bookingId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));

      if (booking && booking.status === "pending_payment") {
        await db
          .update(bookingsTable)
          .set({ status: "partial", stripeSessionId: null, updatedAt: new Date() })
          .where(eq(bookingsTable.id, bookingId));

        logger.info({ bookingId }, "checkout.session.expired: booking reset to partial");

        try {
          await sendCheckoutExpiredEmail(bookingId);
        } catch (err) {
          logger.error(
            { err, bookingId },
            "checkout.session.expired: failed to send expired email",
          );
        }
      }
    }
  }

  // A charge was refunded â€” mark the booking as refunded and email the customer, but only for full refunds.
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
          "charge.refunded: partial refund â€” booking status unchanged",
        );
      } else if (booking && isFullRefund && booking.status !== "refunded") {
        await db
          .update(bookingsTable)
          .set({ status: "refunded", updatedAt: new Date() })
          .where(eq(bookingsTable.id, booking.id));

        logger.info(
          { bookingId: booking.id, paymentIntentId, amountRefunded: charge.amount_refunded },
          "charge.refunded: full refund â€” booking marked refunded",
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

  // Stripe invoice payment attempt failed â€” email the customer with the specific decline reason.
  if (event.type === "invoice.payment_failed") {
    const stripe = getStripe();
    const invoice = event.data.object as Stripe.Invoice;
    const invoiceId = invoice.id;

    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripeInvoiceId, invoiceId));

    if (booking) {
      // Attempt to retrieve the payment intent to get the specific decline reason
      let declineReason: string | undefined;
      const piId =
        typeof (invoice as unknown as Record<string, unknown>).payment_intent === "string"
          ? ((invoice as unknown as Record<string, unknown>).payment_intent as string)
          : null;
      if (piId && stripe) {
        try {
          const pi = await stripe.paymentIntents.retrieve(piId);
          const err = pi.last_payment_error;
          if (err) {
            const code = err.decline_code || err.code || "";
            declineReason = DECLINE_CODE_LABELS[code] || err.message || undefined;
          }
        } catch (piErr) {
          logger.warn(
            { piErr, piId },
            "invoice.payment_failed: could not retrieve payment intent for decline reason",
          );
        }
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

  // A payment dispute (chargeback) has been filed â€” mark booking disputed and alert organisers urgently.
  if (event.type === "charge.dispute.created") {
    const stripe = getStripe();
    const dispute = event.data.object as Stripe.Dispute;

    // Resolve the payment intent ID â€” try the dispute object first, fall back to retrieving the charge
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

  // A card payment attempt failed during Stripe Checkout â€” log the decline code for admin visibility.
  // No status change; Stripe Checkout handles retries inline so no customer email is sent here.
  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object as Stripe.PaymentIntent;
    const piId = pi.id;
    const err = pi.last_payment_error;
    const declineCode = err?.decline_code || err?.code || "unknown";
    const declineMessage = DECLINE_CODE_LABELS[declineCode] || err?.message || "Unknown reason";

    // Try to identify the booking for richer log context
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.stripePaymentIntentId, piId));

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
    res.status(403).json({ error: "Forbidden â€” invalid booking session" });
    return;
  }

  if (existing.status === "paid" || existing.status === "invoiced") {
    logger.info(
      { bookingId: id, status: existing.status },
      "confirm-card-payment: already processed â€” retrying any unfinished side-effects",
    );
    // Replay safety: if a previous confirm/webhook left a side-effect stuck
    // (e.g. SMTP blip), running it again is the customer's only way to
    // trigger a retry without admin intervention.
    await runConfirmationSideEffects(id);
    res.json({ alreadyProcessed: true, orderReference: existing.orderReference || "" });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      res.status(400).json({ error: "Payment not yet completed" });
      return;
    }

    // Verify this Stripe session was created for this booking (prevents cross-session abuse)
    const sessionBookingId = session.metadata?.bookingId;
    if (!sessionBookingId || String(sessionBookingId) !== String(id)) {
      logger.warn(
        { bookingId: id, sessionBookingId, sessionId },
        "confirm-card-payment: session/booking mismatch",
      );
      res.status(403).json({ error: "Stripe session does not belong to this booking" });
      return;
    }

    // Verify the stored stripeSessionId matches (if we have one)
    if (existing.stripeSessionId && existing.stripeSessionId !== sessionId) {
      logger.warn(
        { bookingId: id, storedSessionId: existing.stripeSessionId, sessionId },
        "confirm-card-payment: sessionId mismatch",
      );
      res.status(403).json({ error: "Stripe session ID does not match booking record" });
      return;
    }

    const orderRef = existing.orderReference || defaultOrderRef(id);

    // Atomic claim of the status flip â€” same primitive as the webhook path so
    // a race between the browser and the webhook can never double-confirm.
    const claimed = await claimBookingConfirmation(id, "paid", {
      currentStep: 5,
      stripePaymentIntentId: session.payment_intent as string | null,
      orderReference: orderRef,
      paymentMethod: "card",
    });

    if (claimed) {
      if (existing.promoCode) {
        try {
          const reserved = await incrementPromoUsage(existing.promoCode, existing.quantity);
          if (!reserved) {
            logger.warn(
              { bookingId: id, promoCode: existing.promoCode, quantity: existing.quantity },
              "Promo cap exceeded after successful card payment â€” booking confirmed but usage not incremented",
            );
          }
        } catch (err) {
          logger.error(
            { err, bookingId: id },
            "Failed to increment promo usage after card payment",
          );
        }
      }
      logger.info(
        { bookingId: id, orderRef },
        "confirm-card-payment: booking confirmed â€” running side-effects",
      );
    } else {
      logger.info(
        { bookingId: id, orderRef },
        "confirm-card-payment: webhook beat us â€” retrying any unfinished side-effects",
      );
    }

    await runConfirmationSideEffects(id);
    res.json({ alreadyProcessed: !claimed, orderReference: orderRef });
  } catch (err) {
    const e = err as { raw?: { message?: string }; message?: string };
    const msg = e?.raw?.message || e?.message || "Stripe error";
    logger.error({ err, bookingId: id }, "confirm-card-payment: failed to retrieve session");
    res.status(502).json({ error: `Failed to verify payment: ${msg}` });
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
    res.status(403).json({ error: "Forbidden â€” invalid booking session" });
    return;
  }

  if (booking.status === "paid" || (booking.status === "invoiced" && booking.stripeInvoiceId)) {
    res.json({
      invoiceId: booking.stripeInvoiceId || `manual-${booking.orderReference}`,
      invoiceUrl: booking.stripeInvoicePdfUrl || null,
      paymentUrl: booking.stripeInvoicePaymentUrl || null,
      invoiceReference: booking.orderReference || "",
      alreadyProcessed: true,
    });
    return;
  }

  if (await isPromoOncePerCustomerViolation(booking.id, booking.promoCode)) {
    res.status(400).json({
      error: "This promo code has already been used on a previous booking with this email",
    });
    return;
  }

  const attendees = await db.select().from(attendeesTable).where(eq(attendeesTable.bookingId, id));
  const lead = attendees.find((a) => a.isLead) || attendees[0];

  if (!lead) {
    res.status(400).json({ error: "No attendee found for booking" });
    return;
  }

  const orderRef = booking.orderReference || defaultOrderRef(id);

  try {
    // Delegate the customer-sync + invoice-create + finalize + send to the
    // shared helper so the create and re-issue flows can never drift apart.
    // The helper performs ONLY external Stripe ops â€” the resulting booking-row
    // writes are applied below inside a transaction so they commit atomically
    // with the promo counter increment.
    const result = await reissueBookingInvoice(stripe, id);
    if (result.alreadyPaid) {
      // Persist status="paid" (if not already) atomically in case our DB row
      // was still showing partial/invoiced.
      await db.transaction(async (tx) => {
        await applyReissueInvoiceResultTx(tx, id, result);
      });
      const [refreshed] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, id));
      res.json({
        invoiceId: refreshed.stripeInvoiceId || `manual-${refreshed.orderReference}`,
        invoiceUrl: refreshed.stripeInvoicePdfUrl || null,
        paymentUrl: refreshed.stripeInvoicePaymentUrl || null,
        invoiceReference: refreshed.orderReference || "",
        alreadyProcessed: true,
      });
      return;
    }

    // Atomic: status="invoiced" + invoice metadata + currentStep/orderRef/
    // paymentMethod + promo counter increment all commit (or roll back)
    // together. Eliminates the previous window where a crash between the
    // helper's status write and the promo increment could leave them in
    // inconsistent states.
    await db.transaction(async (tx) => {
      await applyReissueInvoiceResultTx(tx, id, result, {
        currentStep: 5,
        orderReference: orderRef,
        paymentMethod: "invoice",
      });

      if (booking.promoCode) {
        const reserved = await incrementPromoUsage(booking.promoCode, booking.quantity, tx);
        if (!reserved) {
          // The Stripe invoice has already been issued â€” log but do not throw.
          logger.warn(
            { bookingId: id, promoCode: booking.promoCode, quantity: booking.quantity },
            "Promo cap exceeded after Stripe invoice issued â€” booking confirmed but usage not incremented",
          );
        }
      }
    });

    // Run the same per-flag retry pipeline as the card paths so a failed
    // confirmation email here is automatically retried on the next webhook
    // (or admin redeliver) instead of being silently lost.
    await runConfirmationSideEffects(id);

    res.json({
      invoiceId: result.invoiceId,
      invoiceUrl: result.pdfUrl,
      paymentUrl: result.paymentUrl,
      invoiceReference: orderRef,
    });
    return;
  } catch (err) {
    const e = err as { raw?: { message?: string }; message?: string };
    const msg = e?.raw?.message || e?.message || "Stripe error";
    logger.error({ err, bookingId: id }, "Failed to create Stripe invoice");
    res.status(502).json({ error: `Failed to create invoice: ${msg}` });
    return;
  }
});

export default router;
