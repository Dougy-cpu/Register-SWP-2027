import type Stripe from "stripe";
import type { Attendee, Booking } from "@workspace/db";
import { defaultOrderRef } from "./order-reference";
import { STRIPE_REGISTRATION_APP } from "./stripe-checkout-validation";

const EVENT_NAME = "SWP Summit 2027";
const PASS_LABELS: Record<string, string> = {
  single: "Workforce Pass",
  team: "Team Pass",
  business: "Business Pass",
};

// These values can appear on invoices and receipts as well as in accounting exports.
export function cleanStripeText(value?: string | null): string {
  return (value || "")
    .replace(/\u2014|\x26(?:mdash|#8212|#x2014);/gi, ", ")
    .replace(/[|\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface StripeBillingDetails {
  email: string;
  originalEmail: string;
  name: string;
  company: string;
  phone?: string;
  address?: Stripe.AddressParam;
}

let countryCodes: Map<string, string> | undefined;

function stripeCountry(value?: string | null): string | undefined {
  const country = cleanStripeText(value);
  if (!country) return undefined;
  if (/^(united kingdom|uk|great britain|england|scotland|wales|northern ireland)$/i.test(country))
    return "GB";
  if (/^(usa|u\.s\.a\.)$/i.test(country)) return "US";
  if (/^[a-z]{2}$/i.test(country)) return country.toUpperCase();
  if (!countryCodes) {
    countryCodes = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let first = 65; first <= 90; first++) {
      for (let second = 65; second <= 90; second++) {
        const code = String.fromCharCode(first, second);
        const name = names.of(code);
        if (name && name !== code) countryCodes.set(name.toLowerCase(), code);
      }
    }
  }
  return countryCodes.get(country.toLowerCase()) || country;
}

export function getStripeBillingDetails(booking: Booking, lead: Attendee): StripeBillingDetails {
  const originalEmail = cleanStripeText(booking.billingEmail) || cleanStripeText(lead.workEmail);
  const name =
    cleanStripeText(booking.billingName) ||
    cleanStripeText(`${lead.firstName || ""} ${lead.lastName || ""}`);
  const company = cleanStripeText(booking.billingCompany) || cleanStripeText(lead.company);
  const line1 = cleanStripeText(booking.billingAddressLine1);

  return {
    email: originalEmail.toLowerCase(),
    originalEmail,
    name,
    company,
    phone: cleanStripeText(booking.billingPhone) || undefined,
    ...(line1
      ? {
          address: {
            line1,
            line2: cleanStripeText(booking.billingAddressLine2) || undefined,
            city: cleanStripeText(booking.billingTown) || undefined,
            state: cleanStripeText(booking.billingRegion) || undefined,
            postal_code: cleanStripeText(booking.billingPostcode) || undefined,
            country: stripeCountry(booking.billingCountry),
          },
        }
      : {}),
  };
}

export interface StripePaymentDetails {
  description: string;
  metadata: Record<string, string>;
}

export function buildStripePaymentDetails(
  booking: Booking,
  lead: Attendee,
  route: "card" | "invoice",
  invoice?: { id: string; number?: string | null },
): StripePaymentDetails {
  const billing = getStripeBillingDetails(booking, lead);
  const orderRef = cleanStripeText(booking.orderReference) || defaultOrderRef(booking.id);
  const passLabel = PASS_LABELS[booking.passType] || cleanStripeText(booking.passType);
  const invoiceNumber = cleanStripeText(invoice?.number);
  const metadata: Record<string, string> = {
    source: "swp-summit-checkout",
    registrationApp: STRIPE_REGISTRATION_APP,
    bookingId: String(booking.id),
    orderRef,
    eventName: EVENT_NAME,
    paymentRoute: route,
    company: billing.company,
    billingContactName: billing.name,
    billingEmail: billing.email,
    passType: booking.passType,
    quantity: String(booking.quantity),
    leadAttendeeName: cleanStripeText(`${lead.firstName || ""} ${lead.lastName || ""}`),
    leadAttendeeEmail: cleanStripeText(lead.workEmail).toLowerCase(),
    ...(booking.poNumber ? { poNumber: cleanStripeText(booking.poNumber) } : {}),
    ...(invoice ? { invoiceId: invoice.id } : {}),
    ...(invoiceNumber ? { invoiceNumber } : {}),
  };

  for (const key of Object.keys(metadata)) metadata[key] = metadata[key].slice(0, 500);

  return {
    description: [
      orderRef,
      EVENT_NAME,
      billing.company.slice(0, 150),
      billing.name.slice(0, 150),
      billing.email,
      `${booking.quantity} x ${passLabel}`,
      invoiceNumber ? `Invoice ${invoiceNumber}` : "",
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 1000),
    metadata,
  };
}
