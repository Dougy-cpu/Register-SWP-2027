import type Stripe from "stripe";

export const STRIPE_REGISTRATION_APP = "swp-2027";

type CheckoutBooking = {
  id: number;
  stripeSessionId: string | null;
  totalAmount: string | number;
};

type ValidationFailure = {
  ok: false;
  reason: string;
};

type OwnershipSuccess = {
  ok: true;
  legacyMetadata: boolean;
};

type CompletedSessionSuccess = OwnershipSuccess & {
  paymentIntentId: string;
};

export function checkoutSessionBookingId(
  session: Pick<Stripe.Checkout.Session, "metadata">,
): number | null {
  const value = session.metadata?.bookingId?.trim();
  if (!value || !/^[1-9]\d*$/.test(value)) return null;

  const bookingId = Number(value);
  return Number.isSafeInteger(bookingId) ? bookingId : null;
}

export function validateCheckoutSessionOwnership(
  session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "mode">,
  booking: Pick<CheckoutBooking, "id" | "stripeSessionId">,
): OwnershipSuccess | ValidationFailure {
  const registrationApp = session.metadata?.registrationApp?.trim();
  if (registrationApp && registrationApp !== STRIPE_REGISTRATION_APP) {
    return { ok: false, reason: "registration app does not match" };
  }

  if (checkoutSessionBookingId(session) !== booking.id) {
    return { ok: false, reason: "booking ID does not match" };
  }

  if (session.mode !== "payment") {
    return { ok: false, reason: "checkout mode is not payment" };
  }

  if (!booking.stripeSessionId) {
    return { ok: false, reason: "booking has no stored Stripe Session ID" };
  }

  if (booking.stripeSessionId !== session.id) {
    return { ok: false, reason: "Stripe Session ID does not match booking" };
  }

  // Sessions created before this patch have no app marker. The exact stored
  // Session ID remains authoritative, so those in-flight payments stay safe.
  return { ok: true, legacyMetadata: !registrationApp };
}

export function validateCompletedCheckoutSession(
  session: Pick<
    Stripe.Checkout.Session,
    "id" | "metadata" | "mode" | "payment_status" | "payment_intent" | "amount_total" | "currency"
  >,
  booking: CheckoutBooking,
): CompletedSessionSuccess | ValidationFailure {
  const ownership = validateCheckoutSessionOwnership(session, booking);
  if (!ownership.ok) return ownership;

  if (session.payment_status !== "paid") {
    return { ok: false, reason: "checkout payment status is not paid" };
  }

  if (session.currency !== "gbp") {
    return { ok: false, reason: "checkout currency is not GBP" };
  }

  const bookingTotal = Number(booking.totalAmount);
  if (!Number.isFinite(bookingTotal) || bookingTotal < 0) {
    return { ok: false, reason: "booking total is invalid" };
  }

  const expectedAmount = Math.round(bookingTotal * 100);
  if (session.amount_total !== expectedAmount) {
    return { ok: false, reason: "checkout amount does not match booking" };
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    return { ok: false, reason: "checkout has no Payment Intent ID" };
  }

  return { ...ownership, paymentIntentId };
}
