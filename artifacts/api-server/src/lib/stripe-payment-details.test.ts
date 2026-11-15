import { describe, expect, it } from "vitest";
import type { Attendee, Booking } from "@workspace/db";
import {
  buildStripePaymentDetails,
  cleanStripeText,
  getStripeBillingDetails,
} from "./stripe-payment-details";

const booking = {
  id: 1,
  quantity: 2,
  passType: "single",
  orderReference: null,
  billingName: " Alex Smith ",
  billingCompany: "Example Ltd",
  billingEmail: " Alex@Example.COM ",
  billingAddressLine1: "1 High Street",
  billingCountry: "United Kingdom",
  poNumber: "PO-123",
} as Booking;
const lead = {
  firstName: "Jamie",
  lastName: "Lee",
  workEmail: "jamie@example.com",
  company: "Attendee Company",
} as Attendee;

describe("Stripe reconciliation details", () => {
  it("uses the purchaser and keeps attendee details separate", () => {
    const result = buildStripePaymentDetails(booking, lead, "card");
    expect(result.description).toBe(
      "SWP27-6542 | SWP Summit 2027 | Example Ltd | Alex Smith | alex@example.com | 2 x Workforce Pass",
    );
    expect(result.metadata).toMatchObject({
      bookingId: "1",
      orderRef: "SWP27-6542",
      paymentRoute: "card",
      billingContactName: "Alex Smith",
      billingEmail: "alex@example.com",
      company: "Example Ltd",
      leadAttendeeName: "Jamie Lee",
      leadAttendeeEmail: "jamie@example.com",
      poNumber: "PO-123",
    });
    expect(result.description).not.toContain("Jamie");
  });

  it("keeps the reference and customer information identical across payment routes", () => {
    const card = buildStripePaymentDetails(booking, lead, "card");
    const invoice = buildStripePaymentDetails(booking, lead, "invoice", {
      id: "in_123",
      number: "INV-1234",
    });
    expect(invoice.description).toBe(`${card.description} | Invoice INV-1234`);
    expect(invoice.metadata).toMatchObject({
      ...card.metadata,
      paymentRoute: "invoice",
      invoiceId: "in_123",
      invoiceNumber: "INV-1234",
    });
  });

  it("preserves an existing booking reference and falls back from blank billing fields", () => {
    const result = buildStripePaymentDetails(
      {
        ...booking,
        orderReference: "SWP27-EXISTING",
        billingName: " ",
        billingEmail: "",
        billingCompany: null,
      },
      lead,
      "card",
    );
    expect(result.description).toBe(
      "SWP27-EXISTING | SWP Summit 2027 | Attendee Company | Jamie Lee | jamie@example.com | 2 x Workforce Pass",
    );
  });

  it("normalises country names and billing emails for Stripe customers", () => {
    expect(getStripeBillingDetails(booking, lead)).toMatchObject({
      email: "alex@example.com",
      originalEmail: "Alex@Example.COM",
      address: { line1: "1 High Street", country: "GB" },
    });
    expect(
      getStripeBillingDetails({ ...booking, billingCountry: "United States" }, lead).address
        ?.country,
    ).toBe("US");
  });

  it("keeps user supplied separators, line breaks and long values within field limits", () => {
    const result = buildStripePaymentDetails(
      { ...booking, billingCompany: "Example | Ltd\n" + "a".repeat(1500) },
      lead,
      "invoice",
    );
    expect(result.description.startsWith("SWP27-6542 | SWP Summit 2027 | Example Ltd ")).toBe(true);
    expect(result.description.length).toBeLessThanOrEqual(1000);
    expect(Object.values(result.metadata).every((value) => value.length <= 500)).toBe(true);
    const dash = String.fromCharCode(0x2014);
    const encodedDash = String.fromCharCode(38) + "mdash;";
    expect(cleanStripeText(`Example${dash}Ltd ${encodedDash} Alex`)).toBe("Example, Ltd , Alex");
  });
});
