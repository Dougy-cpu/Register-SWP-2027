/**
 * Derive the user-facing invoice/payment badge from a booking's stored state.
 *
 * Possible values:
 *  - `paid`     — payment received (card charge succeeded OR invoice settled)
 *  - `voided`   — invoice was cancelled / voided in Stripe (or booking cancelled)
 *  - `overdue`  — invoice has been issued but the due date has passed
 *  - `sent`     — invoice has been issued and is awaiting payment within terms
 *  - `pending`  — booking is in progress / payment not yet attempted
 */
export type InvoiceBadgeStatus = "paid" | "voided" | "overdue" | "sent" | "pending";

export interface InvoiceBadgeInput {
  status: string;
  paymentMethod: string | null;
  stripeInvoiceId: string | null;
  stripeInvoiceStatus: string | null;
  invoiceDueDate: Date | string | null;
  paidAt: Date | string | null;
}

export function deriveInvoiceBadge(
  b: InvoiceBadgeInput,
  now: Date = new Date(),
): InvoiceBadgeStatus {
  // Paid trumps everything else
  if (b.status === "paid" || b.stripeInvoiceStatus === "paid" || b.paidAt) {
    return "paid";
  }

  // Voided / cancelled / uncollectible
  if (
    b.status === "cancelled" ||
    b.stripeInvoiceStatus === "void" ||
    b.stripeInvoiceStatus === "uncollectible"
  ) {
    return "voided";
  }

  // Invoice issued — check overdue vs sent
  if (b.status === "invoiced" || b.stripeInvoiceId) {
    const due = b.invoiceDueDate ? new Date(b.invoiceDueDate) : null;
    if (due && due.getTime() < now.getTime()) {
      return "overdue";
    }
    return "sent";
  }

  return "pending";
}

export const INVOICE_BADGE_LABELS: Record<InvoiceBadgeStatus, string> = {
  paid: "Paid",
  voided: "Voided",
  overdue: "Overdue",
  sent: "Sent",
  pending: "Pending",
};
