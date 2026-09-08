import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  STRIPE_REGISTRATION_APP,
  checkoutSessionBookingId,
  validateCheckoutSessionOwnership,
  validateCompletedCheckoutSession,
} from "./stripe-checkout-validation";

const booking = {
  id: 12,
  stripeSessionId: "cs_swp_12",
  totalAmount: "578.34",
};

function checkoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: "cs_swp_12",
    metadata: {
      bookingId: "12",
      registrationApp: STRIPE_REGISTRATION_APP,
    },
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_swp_12",
    amount_total: 57_834,
    currency: "gbp",
    ...overrides,
  } as Stripe.Checkout.Session;
}

describe("checkoutSessionBookingId", () => {
  it("accepts a positive integer booking ID", () => {
    expect(checkoutSessionBookingId(checkoutSession())).toBe(12);
  });

  it.each([undefined, "", "0", "-1", "12abc", "1.5"])(
    "rejects an invalid booking ID (%s)",
    (bookingId) => {
      expect(
        checkoutSessionBookingId(
          checkoutSession({ metadata: bookingId === undefined ? null : { bookingId } }),
        ),
      ).toBeNull();
    },
  );
});

describe("validateCompletedCheckoutSession", () => {
  it("accepts a paid session created by this app", () => {
    expect(validateCompletedCheckoutSession(checkoutSession(), booking)).toEqual({
      ok: true,
      legacyMetadata: false,
      paymentIntentId: "pi_swp_12",
    });
  });

  it("accepts an in-flight legacy session only when its stored Session ID matches", () => {
    const session = checkoutSession({ metadata: { bookingId: "12" } });

    expect(validateCompletedCheckoutSession(session, booking)).toEqual({
      ok: true,
      legacyMetadata: true,
      paymentIntentId: "pi_swp_12",
    });
  });

  it("rejects a foreign app session with the same numeric booking ID", () => {
    const session = checkoutSession({
      id: "cs_hras_12",
      metadata: { bookingId: "12", registrationApp: "hras-2026" },
      amount_total: 23_880,
      payment_intent: "pi_hras_12",
    });

    expect(validateCompletedCheckoutSession(session, booking)).toEqual({
      ok: false,
      reason: "registration app does not match",
    });
  });

  it("rejects a marker-less foreign session when no Session ID is stored", () => {
    const session = checkoutSession({
      id: "cs_hras_12",
      metadata: { bookingId: "12" },
      amount_total: 23_880,
      payment_intent: "pi_hras_12",
    });

    expect(
      validateCompletedCheckoutSession(session, { ...booking, stripeSessionId: null }),
    ).toEqual({
      ok: false,
      reason: "booking has no stored Stripe Session ID",
    });
  });

  const invalidSessions: Array<
    [label: string, overrides: Partial<Stripe.Checkout.Session>, reason: string]
  > = [
    ["a different Session ID", { id: "cs_other" }, "Stripe Session ID does not match booking"],
    ["an unpaid session", { payment_status: "unpaid" }, "checkout payment status is not paid"],
    ["another currency", { currency: "usd" }, "checkout currency is not GBP"],
    ["another amount", { amount_total: 57_833 }, "checkout amount does not match booking"],
    ["no Payment Intent", { payment_intent: null }, "checkout has no Payment Intent ID"],
  ];

  it.each(invalidSessions)("rejects %s", (_label, overrides, reason) => {
    expect(validateCompletedCheckoutSession(checkoutSession(overrides), booking)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe("validateCheckoutSessionOwnership", () => {
  it("rejects a foreign expired session before it can reset the booking", () => {
    expect(
      validateCheckoutSessionOwnership(
        checkoutSession({ id: "cs_hras_12", metadata: { bookingId: "12" } }),
        booking,
      ),
    ).toEqual({
      ok: false,
      reason: "Stripe Session ID does not match booking",
    });
  });
});
