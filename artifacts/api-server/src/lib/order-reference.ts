/**
 * Single source of truth for the customer-facing order reference format.
 *
 * The reference is `${prefix}-${offset + bookingId}` where prefix and offset
 * live in `event_settings`. These DEFAULTS are the historical values used to
 * seed `event_settings` and are also the fallback whenever the row is
 * missing or partially populated. Every code path that ever needs to
 * synthesise an order reference (Stripe webhooks, invoice generation,
 * email templates) MUST go through this module so the format only has to
 * change in one place.
 */
export const DEFAULT_REF_PREFIX = "SWP27";
export const DEFAULT_REF_OFFSET = 6541;

/**
 * Synthesise the deterministic order reference for a given booking using
 * the default prefix/offset. Used as a fallback when `bookings.orderReference`
 * is null (e.g. a stripe webhook arrives for a booking we haven't yet
 * persisted a reference for).
 */
export function defaultOrderRef(bookingId: number): string {
  return `${DEFAULT_REF_PREFIX}-${DEFAULT_REF_OFFSET + bookingId}`;
}
