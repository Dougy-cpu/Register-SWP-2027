import type Stripe from "stripe";
import { and, eq, inArray } from "drizzle-orm";
import { bookingsTable, type Booking, type Attendee } from "@workspace/db";
import {
  buildStripePaymentDetails,
  getStripeBillingDetails,
  type StripeBillingDetails,
} from "./stripe-payment-details";
import { getOrCreateStripeCustomer } from "./stripe-customer";
import { defaultOrderRef } from "./order-reference";
import { validateCompletedCheckoutSession } from "./stripe-checkout-validation";
import { claimBookingConfirmation, PromoReservationError } from "./booking-confirmation";
import {
  assertPaymentCanStart,
  paymentFingerprint,
  PaymentOperationError,
  PaymentOperations,
  type PaymentAttempt,
} from "./payment-operations";

export interface CheckoutPlan {
  billing: StripeBillingDetails;
  params: Stripe.Checkout.SessionCreateParams;
  totalAmount: string;
}

const PASS_LABELS: Record<string, string> = {
  single: "Workforce Pass, SWP Summit 2027",
  team: "Team Pass, SWP Summit 2027",
  business: "Business Pass, SWP Summit 2027",
};

export function buildCheckoutPlan(
  booking: Booking,
  lead: Attendee,
  successUrl: string,
  cancelUrl: string,
): CheckoutPlan {
  const details = buildStripePaymentDetails(booking, lead, "card");
  return {
    billing: getStripeBillingDetails(booking, lead),
    totalAmount: String(booking.totalAmount),
    params: {
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: details.metadata.orderRef,
      metadata: details.metadata,
      payment_intent_data: details,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: PASS_LABELS[booking.passType] || booking.passType,
              description: `Wednesday, 3 March 2027, 1 Basinghall Avenue, London, ${booking.quantity} ${booking.quantity === 1 ? "pass" : "passes"}`,
            },
            unit_amount: Math.round(Number(booking.subtotalAmount || 0) * 100),
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: "gbp",
            product_data: { name: "VAT (20%)" },
            unit_amount: Math.round(Number(booking.vatAmount || 0) * 100),
          },
          quantity: 1,
        },
      ],
    },
  };
}

function checkoutParams(
  attempt: PaymentAttempt<CheckoutPlan>,
  customer: string,
): Stripe.Checkout.SessionCreateParams {
  const metadata = { ...attempt.plan.params.metadata, paymentAttemptId: attempt.id };
  return {
    ...attempt.plan.params,
    customer,
    metadata,
    payment_intent_data: { ...attempt.plan.params.payment_intent_data, metadata },
  };
}

async function recoverAttemptSession(
  stripe: Stripe,
  operations: PaymentOperations,
  attempt: PaymentAttempt<CheckoutPlan>,
): Promise<Stripe.Checkout.Session> {
  const customer = await operations.step(attempt, "customer", attempt.plan.billing, () =>
    getOrCreateStripeCustomer(stripe, attempt.plan.billing, attempt.bookingId),
  );
  const params = checkoutParams(attempt, customer);
  const sessionId = await operations.step(attempt, "checkout", params, (options) =>
    stripe.checkout.sessions.create(params, options),
  );
  return stripe.checkout.sessions.retrieve(sessionId);
}

async function expireUnpaidSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<Stripe.Checkout.Session> {
  if (session.status !== "open") return session;
  try {
    return await stripe.checkout.sessions.expire(session.id);
  } catch (err) {
    // A customer can pay while expiration is requested. Always re-read before
    // deciding whether it is safe to create a replacement payment.
    const current = await stripe.checkout.sessions.retrieve(session.id);
    if (current.status === "complete" || current.status === "expired") return current;
    throw err;
  }
}

export async function closePendingCheckoutsForInvoice(
  stripe: Stripe,
  operations: PaymentOperations,
  booking: Booking,
): Promise<void> {
  const attempts = await operations.attempts<CheckoutPlan>("card");
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.status === "superseded" || attempt.status === "expired") continue;
    if (attempt.steps.checkout?.rejected && !attempt.steps.checkout.resultId) {
      attempt.status = "superseded";
      await operations.save(attempt);
      continue;
    }
    if (!attempt.steps.checkout) {
      attempt.status = "superseded";
      await operations.save(attempt);
      continue;
    }
    const recovered = await recoverAttemptSession(stripe, operations, attempt);
    ids.add(recovered.id);
    const session = await expireUnpaidSession(stripe, recovered);
    if (session.payment_status === "paid" || session.status === "complete") {
      await operations.alert("A card payment must be reconciled before an invoice can be created", {
        sessionId: session.id,
      });
      throw new PaymentOperationError(
        "A card payment is already complete. Please open the booking confirmation or contact the organiser.",
      );
    }
    if (session.status !== "expired")
      throw new PaymentOperationError(
        "The existing checkout could not be closed safely. Please retry shortly.",
      );
    attempt.status = "superseded";
    await operations.save(attempt);
  }
  if (booking.stripeSessionId && !ids.has(booking.stripeSessionId)) {
    const session = await expireUnpaidSession(
      stripe,
      await stripe.checkout.sessions.retrieve(booking.stripeSessionId),
    );
    if (session.status !== "expired")
      throw new PaymentOperationError(
        "An existing card payment must be checked before creating an invoice.",
      );
  }
}

export async function createOrResumeCheckout(
  stripe: Stripe,
  operations: PaymentOperations,
  booking: Booking,
  lead: Attendee,
  successUrl: string,
  cancelUrl: string,
): Promise<Stripe.Checkout.Session> {
  assertPaymentCanStart(booking);
  if (booking.stripeInvoiceId)
    throw new PaymentOperationError(
      "An invoice already exists for this booking. Please use its payment link.",
    );
  const invoices = await operations.attempts("invoice");
  if (invoices.some((attempt) => !["expired", "superseded"].includes(attempt.status))) {
    throw new PaymentOperationError(
      "An invoice is already being prepared for this booking. Please continue with that invoice.",
    );
  }
  const plan = buildCheckoutPlan(booking, lead, successUrl, cancelUrl);
  const fingerprint = paymentFingerprint(plan);
  const attempts = await operations.attempts<CheckoutPlan>("card");
  let reusable: Stripe.Checkout.Session | undefined;

  for (const attempt of attempts) {
    if (["expired", "superseded"].includes(attempt.status)) continue;
    if (attempt.steps.checkout?.rejected && !attempt.steps.checkout.resultId) {
      attempt.status = "expired";
      await operations.save(attempt);
      continue;
    }
    const session = await recoverAttemptSession(stripe, operations, attempt);
    if (session.payment_status === "paid" || session.status === "complete") {
      await operations.alert("A completed card payment needs booking reconciliation", {
        sessionId: session.id,
      });
      throw new PaymentOperationError(
        "This payment is already complete. Please open the booking confirmation or contact the organiser.",
      );
    }
    if (
      !reusable &&
      attempt.fingerprint === fingerprint &&
      session.status === "open" &&
      session.url
    ) {
      reusable = session;
      continue;
    }
    const closed = await expireUnpaidSession(stripe, session);
    if (closed.status !== "expired") {
      await operations.alert("An older checkout completed while being replaced", {
        sessionId: closed.id,
      });
      throw new PaymentOperationError(
        "An earlier payment is completing. Please wait for its confirmation.",
      );
    }
    attempt.status = "expired";
    await operations.save(attempt);
  }

  // Adopt or safely retire checkouts created before the durable journal existed.
  if (
    booking.stripeSessionId &&
    !attempts.some((attempt) => attempt.steps.checkout?.resultId === booking.stripeSessionId)
  ) {
    const legacy = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    if (legacy.payment_status === "paid" || legacy.status === "complete") {
      await operations.alert("An earlier card payment needs booking reconciliation", {
        sessionId: legacy.id,
      });
      throw new PaymentOperationError(
        "This payment is already complete. Please open the booking confirmation or contact the organiser.",
      );
    }
    const closed = await expireUnpaidSession(stripe, legacy);
    if (closed.status !== "expired")
      throw new PaymentOperationError(
        "The earlier checkout could not be closed safely. Please retry shortly.",
      );
  }

  if (!reusable) {
    const attempt = await operations.start("card", plan);
    reusable = await recoverAttemptSession(stripe, operations, attempt);
    attempt.status = "ready";
    await operations.save(attempt);
  }
  if (reusable.status !== "open" || !reusable.url)
    throw new PaymentOperationError("This checkout is no longer available. Please retry.");
  const [stored] = await operations.db
    .update(bookingsTable)
    .set({
      stripeSessionId: reusable.id,
      status: "pending_payment",
      orderReference: booking.orderReference || defaultOrderRef(booking.id),
    })
    .where(
      and(
        eq(bookingsTable.id, booking.id),
        inArray(bookingsTable.status, ["partial", "pending_payment"]),
      ),
    )
    .returning();
  if (!stored) {
    await expireUnpaidSession(stripe, reusable);
    throw new PaymentOperationError("The booking has already been confirmed or closed.");
  }
  return reusable;
}

/** Known earlier attempts remain valid evidence without relaxing ownership checks. */
export async function validateKnownCheckoutPayment(
  operations: PaymentOperations,
  session: Stripe.Checkout.Session,
  booking: Booking,
) {
  const current = validateCompletedCheckoutSession(session, booking);
  const attempts = await operations.attempts<CheckoutPlan>("card");
  const attempt = attempts.find(
    (item) =>
      item.steps.checkout?.resultId === session.id ||
      (item.steps.checkout &&
        !item.steps.checkout.resultId &&
        session.metadata?.paymentAttemptId === item.id),
  );
  if (!attempt) return current;
  const historical = validateCompletedCheckoutSession(session, {
    ...booking,
    stripeSessionId: session.id,
    totalAmount: attempt.plan.totalAmount,
  });
  if (!historical.ok) return historical;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (attempt.steps.customer?.resultId && customerId !== attempt.steps.customer.resultId) {
    return {
      ok: false as const,
      reason: "Historical checkout customer does not match the saved payment attempt",
    };
  }
  if (Number(attempt.plan.totalAmount) !== Number(booking.totalAmount)) {
    await operations.alert("A successful earlier payment has a different booking amount", {
      sessionId: session.id,
      paymentIntentId: historical.paymentIntentId,
    });
    return {
      ok: false as const,
      reason: "Historical payment amount differs from the current booking",
    };
  }
  if (!attempt.steps.checkout.resultId && attempt.steps.customer?.resultId) {
    await operations.record(
      attempt,
      "checkout",
      checkoutParams(attempt, attempt.steps.customer.resultId),
      session.id,
    );
  }
  return historical;
}

/** Called under the same per-booking lock used by payment creation. */
export async function settleCheckoutPayment(
  stripe: Stripe,
  operations: PaymentOperations,
  session: Stripe.Checkout.Session,
) {
  const [booking] = await operations.db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, operations.bookingId));
  if (!booking) throw new PaymentOperationError("Booking not found", 404);
  const validation = await validateKnownCheckoutPayment(operations, session, booking);
  if (!validation.ok) throw new PaymentOperationError(validation.reason, 403);
  const alreadyPaid =
    booking.status === "paid" && booking.stripePaymentIntentId === validation.paymentIntentId;
  if (booking.status === "paid" && !alreadyPaid) {
    await operations.alert(
      "Another successful card payment was received for an already paid booking",
      {
        sessionId: session.id,
        paymentIntentId: validation.paymentIntentId,
      },
    );
    throw new PaymentOperationError(
      "An additional payment needs organiser review. Your existing booking remains confirmed.",
    );
  }
  if (!alreadyPaid && !["partial", "pending_payment"].includes(booking.status)) {
    await operations.alert(
      "A successful card payment was received for a closed or invoiced booking",
      {
        sessionId: session.id,
        paymentIntentId: validation.paymentIntentId,
      },
    );
    throw new PaymentOperationError(
      "This payment needs organiser review against the existing booking.",
    );
  }
  const orderReference = booking.orderReference || defaultOrderRef(booking.id);
  let claimed = null;
  let allocationConflict = false;
  try {
    claimed = alreadyPaid
      ? null
      : await claimBookingConfirmation(
          booking.id,
          "paid",
          {
            currentStep: 5,
            stripeSessionId: session.id,
            stripePaymentIntentId: validation.paymentIntentId,
            orderReference,
            paymentMethod: "card",
          },
          ["partial", "pending_payment"],
          operations.db,
        );
  } catch (err) {
    if (!(err instanceof PromoReservationError)) throw err;
    allocationConflict = true;
    // Keep the verified paid reference available for an organiser refund or
    // deliberate resolution. Do not bypass a sponsor/promo capacity limit.
    await operations.db
      .update(bookingsTable)
      .set({
        stripeSessionId: session.id,
        stripePaymentIntentId: validation.paymentIntentId,
        paymentMethod: "card",
        orderReference,
      })
      .where(
        and(
          eq(bookingsTable.id, booking.id),
          inArray(bookingsTable.status, ["partial", "pending_payment"]),
        ),
      );
    await operations.alert(
      "A successful card payment needs promo allocation review before confirmation",
      {
        sessionId: session.id,
        paymentIntentId: validation.paymentIntentId,
      },
    );
  }
  if (!alreadyPaid && !claimed && !allocationConflict) {
    await operations.alert("A successful card payment raced with a booking status change", {
      sessionId: session.id,
    });
    throw new PaymentOperationError(
      "This payment needs organiser review against the latest booking status.",
    );
  }
  // Keep other known links from accepting a second payment. Never manufacture
  // a missing checkout just to clean up after a successful payment.
  const attempts = await operations.attempts<CheckoutPlan>("card");
  const otherIds = new Set(
    attempts.map((item) => item.steps.checkout?.resultId).filter((id): id is string => Boolean(id)),
  );
  if (booking.stripeSessionId) otherIds.add(booking.stripeSessionId);
  otherIds.delete(session.id);
  for (const id of otherIds) {
    const other = await expireUnpaidSession(stripe, await stripe.checkout.sessions.retrieve(id));
    if (other.payment_status === "paid" || other.status === "complete") {
      await operations.alert("An additional checkout completed for this booking", {
        sessionId: id,
      });
    }
  }
  if (allocationConflict)
    throw new PaymentOperationError(
      "Your payment was received. The organiser needs to review the pass allocation before confirming this booking. Please do not pay again.",
    );
  return { alreadyProcessed: !claimed, orderReference };
}
