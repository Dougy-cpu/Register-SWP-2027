import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { StripeBillingDetails } from "./stripe-payment-details";

export function buildStripeCustomerDisplayName(
  contactName: string,
  contactCompany?: string | null,
): string {
  const name = contactName.trim();
  const company = contactCompany?.trim();

  if (!company) return name;
  if (!name || name.toLowerCase() === company.toLowerCase()) return company;

  return `${company}, ${name}`;
}

/** Share billing identity across card checkout and invoices without merging different companies. */
export async function getOrCreateStripeCustomer(
  stripe: Stripe,
  billing: StripeBillingDetails,
  bookingId: number,
): Promise<Stripe.Customer> {
  if (!billing.email) throw new Error("No billing or lead attendee email found for booking");

  const params: Stripe.CustomerCreateParams = {
    email: billing.email,
    name: buildStripeCustomerDisplayName(billing.name, billing.company).slice(0, 256),
    metadata: {
      company: billing.company.slice(0, 500),
      billingContactName: billing.name.slice(0, 500),
    },
    ...(billing.phone ? { phone: billing.phone } : {}),
    ...(billing.address ? { address: billing.address } : {}),
  };

  const customers: Stripe.Customer[] = [];
  for (const email of new Set([billing.email, billing.originalEmail])) {
    const result = await stripe.customers.list({ email, limit: 100 });
    customers.push(...result.data);
  }
  const sameCompany = (customer: Stripe.Customer) => {
    const company = customer.metadata?.company?.trim().toLowerCase();
    return !company || !billing.company || company === billing.company.toLowerCase();
  };
  const matches = [
    ...new Map(customers.map((customer) => [customer.id, customer])).values(),
  ].filter(sameCompany);
  const existing =
    matches.find((customer) => customer.name === params.name) ||
    (matches.length === 1 ? matches[0] : undefined);

  if (existing) {
    // Do not erase known company/name details if this booking omitted them.
    const metadata = { ...params.metadata };
    if (!billing.company) delete metadata.company;
    if (!billing.name) delete metadata.billingContactName;
    return await stripe.customers.update(existing.id, {
      ...params,
      ...(!billing.company && existing.metadata?.company
        ? { name: existing.name || undefined }
        : {}),
      metadata,
    });
  }

  // Identical retries for a booking must not create duplicate Stripe customers.
  const fingerprint = createHash("sha256").update(JSON.stringify(params)).digest("hex");
  return await stripe.customers.create(params, {
    idempotencyKey: `swp-customer-${bookingId}-${fingerprint}`,
  });
}
