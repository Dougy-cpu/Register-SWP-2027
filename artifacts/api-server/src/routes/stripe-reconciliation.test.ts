import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Stripe from "stripe";

const state = vi.hoisted(() => ({
  booking: {} as Record<string, unknown>,
  lead: {} as Record<string, unknown>,
  customer: null as Record<string, unknown> | null,
  invoice: {} as Record<string, unknown>,
  intent: {} as Record<string, unknown>,
  stripe: {
    customers: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    invoices: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
      finalizeInvoice: vi.fn(),
      sendInvoice: vi.fn(),
    },
    invoiceItems: { create: vi.fn() },
    invoicePayments: { list: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), update: vi.fn() },
    charges: { update: vi.fn() },
    taxRates: { list: vi.fn() },
  },
  claim: vi.fn(),
  confirmation: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const bookingsTable = { name: "bookings", id: "id", stripeInvoiceId: "stripeInvoiceId" };
  const attendeesTable = { name: "attendees", bookingId: "bookingId" };
  const db = {
    select: () => ({
      from: (table: { name: string }) => ({
        where: async () =>
          table.name === "bookings"
            ? [state.booking]
            : table.name === "attendees"
              ? [state.lead]
              : [],
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          Object.assign(state.booking, values);
        },
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<void>) => callback(db),
  };
  return { db, bookingsTable, attendeesTable, promoCodesTable: {}, sponsorPromoCodesTable: {} };
});
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("./promo-codes", () => ({ isCodeUsedByEmail: vi.fn() }));
vi.mock("../lib/pricing", () => ({ incrementPromoUsage: vi.fn() }));
vi.mock("../lib/sponsor-redemptions", () => ({
  releaseSponsorRedemption: vi.fn(),
  reservePromoUsageForBooking: vi.fn(),
}));
vi.mock("../lib/stripe-client", () => ({ getStripe: () => state.stripe }));
vi.mock("../lib/booking-confirmation", () => ({
  claimBookingConfirmation: state.claim,
  runConfirmationSideEffects: state.confirmation,
}));
vi.mock("../lib/email", () => ({
  sendCheckoutExpiredEmail: vi.fn(),
  sendRefundConfirmationEmail: vi.fn(),
  sendInvoicePaymentFailedEmail: vi.fn(),
  sendDisputeAlertEmail: vi.fn(),
}));
vi.mock("../lib/google-sheets", () => ({ syncBookingToSheets: vi.fn() }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import stripeRouter from "./stripe";
import { reissueBookingInvoice } from "../lib/invoice";
import { buildStripePaymentDetails } from "../lib/stripe-payment-details";
import { syncStripeInvoicePaymentDetails } from "../lib/stripe-invoice-payments";
import type { Attendee, Booking } from "@workspace/db";

let server: Server;
let baseUrl: string;
let savedWebhookSecret: string | undefined;

beforeAll(async () => {
  savedWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const app = express();
  app.use(express.json());
  app.use("/api", stripeRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (savedWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = savedWebhookSecret;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.resetAllMocks();
  state.booking = {
    id: 1,
    sessionToken: "booking-secret",
    status: "partial",
    passType: "single",
    quantity: 2,
    subtotalAmount: "498.00",
    vatAmount: "99.60",
    totalAmount: "597.60",
    groupDiscountAmount: "0",
    promoDiscountAmount: "0",
    promoCode: null,
    billingName: "Alex Smith",
    billingCompany: "Example Ltd",
    billingEmail: "Alex@Example.com",
    billingAddressLine1: "1 High Street",
    billingCountry: "United Kingdom",
    orderReference: null,
  };
  state.lead = {
    isLead: true,
    firstName: "Jamie",
    lastName: "Lee",
    workEmail: "jamie@example.com",
    company: "Example Ltd",
  };
  state.customer = null;
  state.intent = {
    id: "pi_invoice",
    customer: "cus_payer",
    latest_charge: null,
    metadata: {},
    status: "requires_payment_method",
  };
  state.invoice = {};
  state.stripe.customers.list.mockImplementation(async ({ email }) => ({
    data: state.customer?.email === email ? [state.customer] : [],
  }));
  state.stripe.customers.create.mockImplementation(
    async (params) => (state.customer = { id: "cus_payer", ...params }),
  );
  state.stripe.customers.update.mockImplementation(
    async (_id, params) => (state.customer = { ...state.customer, ...params }),
  );
  state.stripe.checkout.sessions.create.mockResolvedValue({
    id: "cs_card",
    url: "https://checkout.stripe.com/test",
  });
  state.stripe.taxRates.list.mockResolvedValue({
    data: [{ id: "txr_vat", percentage: 20, country: "GB", inclusive: false }],
  });
  state.stripe.invoices.create.mockImplementation(
    async (params) =>
      (state.invoice = { id: "in_invoice", number: null, status: "draft", ...params }),
  );
  state.stripe.invoices.update.mockImplementation(async (_id, params) =>
    Object.assign(state.invoice, params),
  );
  state.stripe.invoices.finalizeInvoice.mockImplementation(async () =>
    Object.assign(state.invoice, { number: "INV-1234", status: "open" }),
  );
  state.stripe.invoices.sendInvoice.mockImplementation(async () => ({
    ...state.invoice,
    due_date: 1800000000,
    invoice_pdf: "https://example.com/invoice.pdf",
    hosted_invoice_url: "https://example.com/pay",
  }));
  state.stripe.invoices.retrieve.mockImplementation(async () => state.invoice);
  state.stripe.invoiceItems.create.mockResolvedValue({ id: "ii_test" });
  state.stripe.invoicePayments.list.mockImplementation(async () => ({
    data: [
      {
        id: "inpay_default",
        is_default: true,
        status: state.intent.status === "succeeded" ? "paid" : "open",
        payment: { type: "payment_intent", payment_intent: { ...state.intent } },
      },
    ],
    has_more: false,
  }));
  state.stripe.paymentIntents.retrieve.mockImplementation(async () => ({ ...state.intent }));
  state.stripe.paymentIntents.update.mockImplementation(async (_id, params) =>
    Object.assign(state.intent, params),
  );
  state.stripe.charges.update.mockResolvedValue({ id: "ch_invoice" });
  state.claim.mockImplementation(async (_id, status, extra) => {
    if (state.booking.status === "paid") return null;
    Object.assign(state.booking, extra, { status });
    return state.booking;
  });
  state.confirmation.mockResolvedValue({ ran: [], failed: [], skipped: [] });
});

async function post(path: string, body: unknown, session = "booking-secret") {
  return fetch(`${baseUrl}/api/stripe/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-booking-session": session },
    body: JSON.stringify(body),
  });
}

const expectedDescription =
  "SWP27-6542 | SWP Summit 2027 | Example Ltd | Alex Smith | alex@example.com | 2 x Workforce Pass";

describe("card and invoice reconciliation integration", () => {
  it("creates a named billing customer and labels the underlying card payment without changing amounts", async () => {
    const response = await post("create-checkout-session", {
      bookingId: 1,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(response.status).toBe(200);
    const params = state.stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params).toMatchObject({
      customer: "cus_payer",
      client_reference_id: "SWP27-6542",
      mode: "payment",
      payment_method_types: ["card"],
      payment_intent_data: {
        description: expectedDescription,
        metadata: { bookingId: "1", orderRef: "SWP27-6542", paymentRoute: "card" },
      },
    });
    expect(params.metadata).toEqual(params.payment_intent_data.metadata);
    expect(params.metadata.registrationApp).toBe("swp-2027");
    expect(params).not.toHaveProperty("customer_email");
    expect(
      params.line_items.map(
        (item: { price_data: { unit_amount: number } }) => item.price_data.unit_amount,
      ),
    ).toEqual([49800, 9960]);
    expect(state.customer).toMatchObject({
      email: "alex@example.com",
      name: "Example Ltd, Alex Smith",
      address: { country: "GB" },
    });
    expect(state.booking).toMatchObject({
      orderReference: "SWP27-6542",
      stripeSessionId: "cs_card",
      status: "pending_payment",
      totalAmount: "597.60",
    });
  });

  it("rejects an unauthorised checkout before touching Stripe customer data", async () => {
    const response = await post(
      "create-checkout-session",
      { bookingId: 1, successUrl: "https://example.com", cancelUrl: "https://example.com" },
      "wrong-session",
    );
    expect(response.status).toBe(403);
    expect(state.stripe.customers.list).not.toHaveBeenCalled();
    expect(state.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("reuses the same customer for card and invoice and labels the invoice and its payment", async () => {
    await post("create-checkout-session", {
      bookingId: 1,
      successUrl: "https://example.com",
      cancelUrl: "https://example.com",
    });
    const result = await reissueBookingInvoice(state.stripe as unknown as Stripe, 1);
    expect(result).toMatchObject({ alreadyPaid: false, invoiceId: "in_invoice" });
    expect(state.stripe.customers.create).toHaveBeenCalledOnce();
    expect(state.stripe.customers.update).toHaveBeenCalledWith(
      "cus_payer",
      expect.objectContaining({ name: "Example Ltd, Alex Smith", email: "alex@example.com" }),
    );
    expect(state.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expectedDescription,
        customer: "cus_payer",
        collection_method: "send_invoice",
        days_until_due: 14,
      }),
    );
    expect(state.stripe.invoices.update).toHaveBeenCalledWith(
      "in_invoice",
      expect.objectContaining({ description: `${expectedDescription} | Invoice INV-1234` }),
    );
    expect(state.stripe.paymentIntents.update).toHaveBeenCalledWith(
      "pi_invoice",
      expect.objectContaining({
        description: `${expectedDescription} | Invoice INV-1234`,
        metadata: expect.objectContaining({
          invoiceId: "in_invoice",
          invoiceNumber: "INV-1234",
          paymentRoute: "invoice",
        }),
      }),
    );
    expect(state.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 49800, tax_rates: ["txr_vat"] }),
    );
    expect(state.stripe.invoices.sendInvoice).toHaveBeenCalledOnce();
  });

  it("enriches the successful invoice charge using the modern InvoicePayment link and saves its refund reference", async () => {
    state.booking.stripeInvoiceId = "in_invoice";
    state.booking.paymentMethod = "invoice";
    state.booking.status = "invoiced";
    state.intent.latest_charge = "ch_invoice";
    state.intent.status = "succeeded";
    const response = await post("webhook", {
      type: "invoice.paid",
      data: {
        object: { id: "in_invoice", number: "INV-1234", customer: "cus_payer", status: "paid" },
      },
    });
    expect(response.status).toBe(200);
    expect(state.stripe.charges.update).toHaveBeenCalledWith(
      "ch_invoice",
      expect.objectContaining({ description: `${expectedDescription} | Invoice INV-1234` }),
    );
    expect(state.stripe.charges.update.mock.calls[0][1]).not.toHaveProperty("receipt_email");
    expect(state.booking).toMatchObject({
      stripePaymentIntentId: "pi_invoice",
      status: "paid",
      paymentMethod: "invoice",
    });
  });

  it("handles legacy invoice webhook payment references without using the new list endpoint", async () => {
    state.booking.stripeInvoiceId = "in_invoice";
    state.intent.latest_charge = "ch_invoice";
    const response = await post("webhook", {
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_invoice",
          customer: "cus_payer",
          payment_intent: "pi_invoice",
          status: "paid",
        },
      },
    });
    expect(response.status).toBe(200);
    expect(state.stripe.invoicePayments.list).not.toHaveBeenCalled();
    expect(state.booking.stripePaymentIntentId).toBe("pi_invoice");
    expect(state.stripe.charges.update).toHaveBeenCalledOnce();
  });

  it("confirms payment while requesting a webhook retry if reconciliation labels fail", async () => {
    state.booking.stripeInvoiceId = "in_invoice";
    state.intent.latest_charge = "ch_invoice";
    state.stripe.charges.update.mockRejectedValueOnce(new Error("temporary Stripe error"));
    const event = {
      type: "invoice.paid",
      data: { object: { id: "in_invoice", customer: "cus_payer", status: "paid" } },
    };
    expect((await post("webhook", event)).status).toBe(500);
    expect(state.booking.status).toBe("paid");
    expect(state.booking.stripePaymentIntentId).toBe("pi_invoice");
    expect(state.confirmation).toHaveBeenCalledOnce();
    expect((await post("webhook", event)).status).toBe(200);
    expect(state.booking.stripePaymentIntentId).toBe("pi_invoice");
    expect(state.stripe.charges.update).toHaveBeenCalledTimes(2);
  });

  it("still labels the charge when Stripe restricts invoice-managed intent edits", async () => {
    const invoice = { id: "in_invoice", customer: "cus_payer" } as Stripe.Invoice;
    state.intent.latest_charge = "ch_invoice";
    state.stripe.paymentIntents.update.mockRejectedValue({
      type: "StripeInvalidRequestError",
      message: "You cannot update a PaymentIntent managed by an invoice",
    });
    const details = buildStripePaymentDetails(
      state.booking as Booking,
      state.lead as Attendee,
      "invoice",
      invoice,
    );
    expect(
      await syncStripeInvoicePaymentDetails(state.stripe as unknown as Stripe, invoice, details),
    ).toBe("pi_invoice");
    expect(state.stripe.charges.update).toHaveBeenCalledWith("ch_invoice", details);
  });

  it("does not invent a Stripe refund reference for an out-of-band invoice payment", async () => {
    state.booking.stripeInvoiceId = "in_invoice";
    state.stripe.invoicePayments.list.mockResolvedValue({ data: [], has_more: false });
    const response = await post("webhook", {
      type: "invoice.paid",
      data: { object: { id: "in_invoice", customer: "cus_payer", status: "paid" } },
    });
    expect(response.status).toBe(200);
    expect(state.booking).not.toHaveProperty("stripePaymentIntentId");
    expect(state.stripe.charges.update).not.toHaveBeenCalled();
    expect(state.stripe.paymentIntents.update).not.toHaveBeenCalled();
  });
});
