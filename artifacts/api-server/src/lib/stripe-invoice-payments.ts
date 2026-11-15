import type Stripe from "stripe";
import { logger } from "./logger";
import type { StripePaymentDetails } from "./stripe-payment-details";

type InvoiceWithLegacyPayment = Stripe.Invoice & {
  payment_intent?: string | Stripe.PaymentIntent | null;
  charge?: string | Stripe.Charge | null;
};

function objectId(value?: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id || null;
}

interface InvoicePaymentReference {
  intent?: string | Stripe.PaymentIntent | null;
  charge?: string | Stripe.Charge | null;
  isDefault: boolean;
}

async function invoicePaymentReferences(
  stripe: Stripe,
  invoice: Stripe.Invoice,
): Promise<InvoicePaymentReference[]> {
  // Webhook endpoints can still deliver the older API shape after an SDK upgrade.
  const legacy = invoice as InvoiceWithLegacyPayment;
  if (legacy.payment_intent || legacy.charge) {
    return [{ intent: legacy.payment_intent, charge: legacy.charge, isDefault: true }];
  }

  let payments = invoice.payments?.data;
  if (!payments || invoice.payments?.has_more) {
    payments = [];
    let startingAfter: string | undefined;
    while (true) {
      const page = await stripe.invoicePayments.list({
        invoice: invoice.id,
        limit: 100,
        expand: ["data.payment.payment_intent"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      payments.push(...page.data);
      if (!page.has_more || !page.data.length) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  return payments
    .filter((payment) => payment.status !== "canceled")
    .map((payment) => ({
      intent: payment.payment.payment_intent,
      charge: payment.payment.charge,
      isDefault: payment.is_default,
    }));
}

function isInvoiceManagedIntentError(error: unknown): boolean {
  const err = error as { type?: string; message?: string };
  return (
    err.type === "StripeInvalidRequestError" &&
    /invoice/i.test(err.message || "") &&
    /(?:cannot|can.t|not allowed|not supported|must.*invoice)/i.test(err.message || "")
  );
}

/** Only labels and references are written here. Never change or confirm the payment. */
export async function syncStripeInvoicePaymentDetails(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  details: StripePaymentDetails,
  onPaymentResolved?: (paymentIntentId: string) => void,
): Promise<string | null> {
  const references = await invoicePaymentReferences(stripe, invoice);
  let paymentIntentId = objectId(references.find((reference) => reference.isDefault)?.intent);
  // Retain the canonical invoice/payment link even if a later label update fails.
  if (paymentIntentId) onPaymentResolved?.(paymentIntentId);

  if (
    invoice.description !== details.description ||
    Object.entries(details.metadata).some(([key, value]) => invoice.metadata?.[key] !== value)
  ) {
    await stripe.invoices.update(invoice.id, details);
  }

  for (const reference of references) {
    const intentId = objectId(reference.intent);
    const intent = intentId
      ? typeof reference.intent === "object" && reference.intent
        ? reference.intent
        : await stripe.paymentIntents.retrieve(intentId)
      : null;

    // An externally attached payment can settle several invoices. Do not relabel
    // someone else's payment with this booking's details.
    if (!reference.isDefault && intent?.metadata?.bookingId !== details.metadata.bookingId)
      continue;
    if (intent && objectId(intent.customer) !== objectId(invoice.customer)) {
      throw new Error(`Stripe invoice ${invoice.id} payment customer does not match`);
    }

    const chargeId = objectId(reference.charge) || objectId(intent?.latest_charge);
    if (chargeId) await stripe.charges.update(chargeId, details);
    if (!intentId) continue; // Bank/out-of-band payments may have no refundable Stripe charge.

    paymentIntentId ||= intentId;
    onPaymentResolved?.(paymentIntentId);
    try {
      await stripe.paymentIntents.update(intentId, details);
    } catch (err) {
      // Some Stripe API versions restrict edits to invoice-managed intents.
      // The successful charge remains the writable record used for reconciliation.
      if (!isInvoiceManagedIntentError(err)) throw err;
      logger.warn(
        { invoiceId: invoice.id, paymentIntentId: intentId, chargeId },
        "Stripe controls invoice payment labels; invoice and available charge were enriched",
      );
    }
  }
  return paymentIntentId;
}
