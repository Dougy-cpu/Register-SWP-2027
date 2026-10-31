import type { DbExecutor } from "../lib/pricing";
import { Router, type IRouter } from "express";
import type Stripe from "stripe";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  bookingsTable,
  attendeesTable,
  promoCodesTable,
  sponsorPromoCodesTable,
  activityLogTable,
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
import { reissueBookingInvoice, applyReissueInvoiceResultTx } from "../lib/invoice";
import { claimBookingConfirmation, runConfirmationSideEffects } from "../lib/booking-confirmation";
import { defaultOrderRef } from "../lib/order-reference";
import {
  runCheckoutAttempt,
  CheckoutPaymentError,
  replacingInvoice,
} from "../lib/checkout-payment";
import { getStripe } from "../lib/stripe-client";
import {
  STRIPE_REGISTRATION_APP,
  PaymentSettlementConflict,
  checkoutQuoteHash,
  checkoutSessionBookingId,
  validateCheckoutSessionOwnership,
  validateCompletedCheckoutSession,
} from "../lib/stripe-checkout-validation";

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

  const rawPaymentIntent = (invoice as unknown as Record<string, unknown>).payment_intent;
  const paymentIntentId: string | null =
    typeof rawPaymentIntent === "string"
      ? rawPaymentIntent
      : rawPaymentIntent && typeof rawPaymentIntent === "object" && "id" in rawPaymentIntent
        ? (rawPaymentIntent as { id: string }).id
        : null;

  // Atomic claim. We allow the flip from "invoiced" "paid" (the typical
  // happy path: invoice issued, then customer pays the hosted Stripe link)
  // as well as from partial/pending_payment in case the invoice flow skipped
  // those intermediates. paymentMethod stays "invoice" so invoice-specific
  // UI keeps rendering after settlement.
  let claimed;
  try {
    claimed = await claimBookingConfirmation(
      booking.id,
      "paid",
      {
        paidConfirmationEmailSentAt: new Date(),
        stripeInvoiceStatus: "paid",
        stripeInvoiceStatusSyncedAt: new Date(),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      },
      ["partial", "pending_payment", "invoiced"],
      { invoice },
    );
  } catch (error) {
    if (!(error instanceof PaymentSettlementConflict)) throw error;
    await recordPaymentReview(booking.id, invoice.id, error.message);
    return;
  }

  if (claimed) {
    logger.info(
      {
        bookingId: booking.id,
        invoiceId,
        orderRef: booking.orderReference,
        paymentIntentId,
        eventType: event.type,
      },
      "invoice paid: booking claimed paid, running side-effects",
    );
  } else {
    // Already paid - fall through to side-effect retry so a stuck flag from
    // a previous webhook delivery (e.g. SMTP blip) gets a fresh chance.
    logger.info(
      { bookingId: booking.id, invoiceId, eventType: event.type },
      "invoice paid: already confirmed - retrying any unfinished side-effects",
    );
  }

  await runConfirmationSideEffects(booking.id);
}

async function isPromoOncePerCustomerViolation(
  bookingId: number,
  promoCode: string | null,
  conn: DbExecutor,
): Promise<boolean> {
  if (!promoCode) return false;
  const [promo] = await conn
    .select()
    .from(promoCodesTable)
    .where(eq(promoCodesTable.code, promoCode));
  if (!promo?.oncePerCustomer) return false;
  const allAttendees = await conn
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const leadAttendee = allAttendees.find((a) => a.isLead) || allAttendees[0];
  const email = (leadAttendee?.workEmail || "").trim().toLowerCase();
  if (!email) return false;
  return await isCodeUsedByEmail(promoCode, email, bookingId, conn);
}

async function invoiceSponsorReservation(
  booking: typeof bookingsTable.$inferSelect,
  conn: DbExecutor,
) {
  if (!booking.promoCode) return false;
  const [mapping] = await conn
    .select({ sponsorId: sponsorPromoCodesTable.sponsorId })
    .from(promoCodesTable)
    .innerJoin(sponsorPromoCodesTable, eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id))
    .where(eq(promoCodesTable.code, booking.promoCode));
  if (!mapping) return false;
  if (!(await reservePromoUsageForBooking(booking.promoCode, booking.quantity, booking.id, conn)))
    throw new CheckoutPaymentError(409, "The sponsor allocation is no longer available.");
  return true;
}

async function validateCheckoutPromo(booking: typeof bookingsTable.$inferSelect, conn: DbExecutor) {
  if (Number(booking.totalAmount) <= 0)
    throw new CheckoutPaymentError(
      400,
      "This booking is complimentary. Confirm it without a payment.",
    );
  if (await isPromoOncePerCustomerViolation(booking.id, booking.promoCode, conn))
    throw new CheckoutPaymentError(
      400,
      "This promo code has already been used on a previous booking with this email",
    );
}

function paymentError(res: import("express").Response, err: unknown, id: unknown) {
  const status = err instanceof CheckoutPaymentError ? err.status : 502;
  if (status >= 500) logger.error({ err, bookingId: id }, "Checkout provider request failed");
  res
    .status(status)
    .json({
      error:
        err instanceof CheckoutPaymentError
          ? err.message
          : "Payment could not be completed. Please retry the same booking or contact the event team.",
    });
}

async function recordCardMismatch(id: number, session: Stripe.Checkout.Session, reason: string) {
  // Other registration apps can share this Stripe account. Only flag our own paid attempts.
  if (
    session.payment_status !== "paid" ||
    session.metadata?.registrationApp !== STRIPE_REGISTRATION_APP
  )
    return;
  await recordPaymentReview(id, session.id, reason);
}

async function recordPaymentReview(id: number, providerId: string, reason: string) {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .where(eq(bookingsTable.id, id))
      .for("update");
    const type = "checkout_payment_review";
    const existing = await tx
      .select({ data: activityLogTable.data })
      .from(activityLogTable)
      .where(and(eq(activityLogTable.bookingId, id), eq(activityLogTable.type, type)));
    if (
      existing.some(
        (row) => (row.data as { providerId?: string } | null)?.providerId === providerId,
      )
    )
      return;
    await tx
      .insert(activityLogTable)
      .values({
        bookingId: id,
        actor: "stripe",
        type,
        data: { providerId, summary: "Payment needs reconciliation: " + reason },
      });
  });
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

  try {
    const result = await runCheckoutAttempt(
      stripe,
      Number(bookingId),
      req.get("x-booking-session"),
      "card",
      async (tx, booking, key) => {
        const passLabels: Record<string, string> = {
          single: "Workforce Pass, SWP Summit 2027",
          team: "Team Pass, SWP Summit 2027",
          business: "Business Pass, SWP Summit 2027",
        };

        const subtotalAfterDiscounts = parseFloat(booking.subtotalAmount?.toString() || "0");
        const vatAmount = parseFloat(booking.vatAmount?.toString() || "0");

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
          {
            price_data: {
              currency: "gbp",
              product_data: {
                name: passLabels[booking.passType] || booking.passType,
                description: `Wednesday, 3 March 2027, 1 Basinghall Avenue, London, ${booking.quantity} ${booking.quantity === 1 ? "pass" : "passes"}`,
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

        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            payment_method_types: ["card"],
            line_items: lineItems,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
              bookingId: String(booking.id),
              registrationApp: STRIPE_REGISTRATION_APP,
              checkoutQuote: checkoutQuoteHash(booking),
            },
            customer_email: booking.billingEmail || undefined,
          },
          { idempotencyKey: key + "-session" },
        );
        if (!session.url) throw new Error("Payment provider did not return a checkout URL");
        await tx
          .update(bookingsTable)
          .set({ stripeSessionId: session.id, status: "pending_payment" })
          .where(eq(bookingsTable.id, booking.id));
        return { sessionId: session.id, url: session.url };
      },
      validateCheckoutPromo,
    );
    res.json(result);
  } catch (err) {
    paymentError(res, err, bookingId);
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

    if (!bookingId) {
      logger.warn({ sessionId: session.id }, "Stripe checkout event has an invalid booking ID");
    } else {
      const [existing] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));

      if (!existing) {
        logger.warn({ bookingId }, "Stripe webhook: booking not found, skipping");
        res.json({ received: true });
        return;
      }

      const validation = validateCompletedCheckoutSession(session, existing);
      if (!validation.ok) {
        logger.warn(
          { bookingId, sessionId: session.id, reason: validation.reason },
          "Ignoring Stripe checkout event that does not match this booking",
        );
        await recordCardMismatch(bookingId, session, validation.reason);
        res.json({ received: true });
        return;
      }

      if (validation.legacyMetadata) {
        logger.info(
          { bookingId, sessionId: session.id },
          "Accepting legacy checkout session after exact Session ID validation",
        );
      }

      const orderRef = existing.orderReference || defaultOrderRef(bookingId);

      // Atomic claim: only the first webhook delivery (or the racing
      // /confirm-card-payment caller) actually flips status paid; concurrent
      // duplicate events get back null and skip straight to side-effect retry.
      let claimed;
      try {
        claimed = await claimBookingConfirmation(
          bookingId,
          "paid",
          {
            currentStep: 5,
            stripePaymentIntentId: validation.paymentIntentId,
            orderReference: orderRef,
            paymentMethod: "card",
          },
          undefined,
          { card: session },
        );
      } catch (error) {
        if (!(error instanceof PaymentSettlementConflict)) throw error;
        await recordCardMismatch(bookingId, session, error.message);
        res.json({ received: true });
        return;
      }

      if (!claimed) {
        logger.info(
          { bookingId, status: existing.status },
          "checkout.session.completed: already confirmed - retrying any unfinished side-effects",
        );
      }

      await runConfirmationSideEffects(bookingId);
    }
  }

  // When someone pays a Stripe invoice (e.g. via the hosted payment link), automatically
  // flip the booking status to "paid" and send the same confirmation + welcome emails the
  // card flow does. Both `invoice.paid` and `invoice.payment_succeeded` are wired here for
  // resilience - Stripe sends both in quick succession and webhooks can be retried, so the
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
      const cancelled = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(bookingsTable)
          .where(eq(bookingsTable.id, booking.id))
          .for("update");
        if (
          current?.stripeInvoiceId !== invoiceId ||
          (await replacingInvoice(tx, booking.id, invoiceId))
        )
          return [];
        return tx
          .update(bookingsTable)
          .set({
            status: "cancelled",
            stripeInvoiceStatus: "void",
            stripeInvoiceStatusSyncedAt: new Date(),
          })
          .where(
            and(
              eq(bookingsTable.id, booking.id),
              eq(bookingsTable.stripeInvoiceId, invoiceId),
              inArray(bookingsTable.status, ["partial", "pending_payment", "invoiced"]),
            ),
          )
          .returning({ id: bookingsTable.id });
      });
      if (!cancelled.length) {
        res.json({ received: true });
        return;
      }
      await releaseSponsorRedemption(booking.id, "stripe_invoice_voided");
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

  // Stripe Checkout session expired without payment - reset booking to "partial" so
  // the customer can retry, and email them to let them know.
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = checkoutSessionBookingId(session);

    if (bookingId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));

      if (booking) {
        const validation = validateCheckoutSessionOwnership(session, booking);
        if (!validation.ok) {
          logger.warn(
            { bookingId, sessionId: session.id, reason: validation.reason },
            "Ignoring expired Stripe checkout event that does not match this booking",
          );
          res.json({ received: true });
          return;
        }
      }

      if (booking && booking.status === "pending_payment") {
        const changed = await db
          .update(bookingsTable)
          .set({ status: "partial", stripeSessionId: null, updatedAt: new Date() })
          .where(
            and(
              eq(bookingsTable.id, bookingId),
              eq(bookingsTable.status, "pending_payment"),
              eq(bookingsTable.stripeSessionId, session.id),
            ),
          )
          .returning({ id: bookingsTable.id });

        if (!changed.length) {
          res.json({ received: true });
          return;
        }
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
    res.status(403).json({ error: "Forbidden - invalid booking session" });
    return;
  }

  let cardSession: Stripe.Checkout.Session | undefined;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    cardSession = session;
    const validation = validateCompletedCheckoutSession(session, existing);
    if (!validation.ok) {
      await recordCardMismatch(id, session, validation.reason);
      res
        .status(409)
        .json({
          error:
            "This payment does not match the booking. Check your confirmation or contact the event team.",
        });
      return;
    }

    const orderRef = existing.orderReference || defaultOrderRef(id);

    // Atomic claim of the status flip - same primitive as the webhook path so
    // a race between the browser and the webhook can never double-confirm.
    const claimed = await claimBookingConfirmation(
      id,
      "paid",
      {
        currentStep: 5,
        stripePaymentIntentId: validation.paymentIntentId,
        orderReference: orderRef,
        paymentMethod: "card",
      },
      undefined,
      { card: session },
    );

    if (claimed) {
      logger.info(
        { bookingId: id, orderRef },
        "confirm-card-payment: booking confirmed - running side-effects",
      );
    } else {
      logger.info(
        { bookingId: id, orderRef },
        "confirm-card-payment: webhook beat us - retrying any unfinished side-effects",
      );
    }

    await runConfirmationSideEffects(id);
    res.json({ alreadyProcessed: !claimed, orderReference: orderRef });
  } catch (err) {
    if (err instanceof PaymentSettlementConflict) {
      if (cardSession) await recordCardMismatch(id, cardSession, err.message);
      res.status(409).json({ error: err.message });
      return;
    }
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
  try {
    const result = await runCheckoutAttempt(
      stripe,
      id,
      req.get("x-booking-session"),
      "invoice",
      async (tx, booking, key) => {
        const orderRef = booking.orderReference || defaultOrderRef(id);
        if (booking.promoCode) {
          const reserved = await reservePromoUsageForBooking(
            booking.promoCode,
            booking.quantity,
            id,
            tx,
          );
          if (!reserved)
            throw new CheckoutPaymentError(409, "The promo allocation is no longer available.");
        }
        const issued = await reissueBookingInvoice(stripe, id, tx, key);
        await applyReissueInvoiceResultTx(tx, id, issued, {
          currentStep: 5,
          orderReference: orderRef,
          paymentMethod: "invoice",
        });
        if (issued.alreadyPaid)
          return {
            invoiceId: booking.stripeInvoiceId || "manual-" + orderRef,
            invoiceUrl: booking.stripeInvoicePdfUrl,
            paymentUrl: booking.stripeInvoicePaymentUrl,
            invoiceReference: orderRef,
            alreadyProcessed: true,
          };
        return {
          invoiceId: issued.invoiceId,
          invoiceUrl: issued.pdfUrl,
          paymentUrl: issued.paymentUrl,
          invoiceReference: orderRef,
        };
      },
      async (booking, tx) => {
        await validateCheckoutPromo(booking, tx);
        const [lead] = await tx
          .select({ id: attendeesTable.id })
          .from(attendeesTable)
          .where(eq(attendeesTable.bookingId, booking.id))
          .limit(1);
        if (!lead) throw new CheckoutPaymentError(400, "No attendee found for booking");
        await invoiceSponsorReservation(booking, tx);
      },
    );
    await runConfirmationSideEffects(id);
    res.json(result);
  } catch (err) {
    paymentError(res, err, id);
  }
});

export default router;
