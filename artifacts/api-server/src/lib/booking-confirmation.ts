import { and, eq, inArray, not, or, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { attendeesTable, bookingsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  sendConfirmationAndReceiptEmail,
  sendAttendeeWelcomeEmails,
  sendOrganiserNotification,
} from "./email";
import { syncBookingToSheets } from "./google-sheets";
import {
  notifySponsorRedemptionForBooking,
  reservePromoUsageForBooking,
} from "./sponsor-redemptions";
import { sendSponsorInternalNotification, sendSponsorStaffWelcome } from "./sponsor-email";

export class PromoReservationError extends Error {
  constructor() {
    super("The promo allocation is no longer available");
    this.name = "PromoReservationError";
  }
}

/**
 * Atomically claim the status flip from a not-yet-confirmed status to
 * `paid` (or `invoiced`). Returns the updated row only if THIS caller
 * actually flipped the status — concurrent webhook/browser calls that
 * lose the race get back `null` and must skip the side-effects.
 *
 * The caller can pass extra fields to apply in the same UPDATE
 * (orderReference, paymentMethod, payment intent IDs, etc.).
 *
 * `currentStatuses` is the WHITELIST of statuses we'll flip from. The
 * default ["partial", "pending_payment"] covers the common
 * "user finished step 4 but never confirmed" case. The invoice paths
 * additionally allow "invoiced" → "paid".
 */
export async function claimBookingConfirmation(
  bookingId: number,
  newStatus: "paid" | "invoiced",
  extra: Partial<typeof bookingsTable.$inferInsert> = {},
  currentStatuses: Array<"partial" | "pending_payment" | "invoiced"> = [
    "partial",
    "pending_payment",
  ],
): Promise<typeof bookingsTable.$inferSelect | null> {
  const now = new Date();
  const setFields: Partial<typeof bookingsTable.$inferInsert> = {
    status: newStatus,
    updatedAt: now,
    ...extra,
  };
  if (newStatus === "paid" && !("paidAt" in extra)) {
    setFields.paidAt = now;
  }

  return db.transaction(async (tx) => {
    // The row lock makes the status check, sponsor redemption ledger entry
    // and final status change one indivisible operation. This is especially
    // important when the Stripe webhook and browser confirmation race.
    await tx.execute(sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`);
    const [current] = await tx.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
    if (!current || !currentStatuses.includes(current.status as (typeof currentStatuses)[number])) {
      return null;
    }

    // Invoice creation already reserves/increments the promo in its own
    // transaction. All other confirmation paths reserve here before the
    // booking can become paid, preventing concurrent VIP oversubscription.
    if (current.promoCode && current.status !== "invoiced") {
      const reserved = await reservePromoUsageForBooking(
        current.promoCode,
        current.quantity,
        current.id,
        tx,
      );
      if (!reserved) throw new PromoReservationError();
    }

    const claimed = await tx
      .update(bookingsTable)
      .set(setFields)
      .where(eq(bookingsTable.id, bookingId))
      .returning();
    return claimed[0] ?? null;
  });
}

type SideEffectKey =
  | "confirmationEmailSent"
  | "welcomeEmailsSent"
  | "organiserNotified"
  | "sheetsSynced";

interface SideEffectSpec {
  key: SideEffectKey;
  // Returns true if the side-effect succeeded (flag will be flipped to true).
  // Returns false on a known failure (flag stays false → eligible for retry).
  // Throws → flag stays false AND the error is logged; the next replay/admin
  // redeliver will try again.
  run: (bookingId: number) => Promise<boolean>;
}

const SIDE_EFFECTS: SideEffectSpec[] = [
  { key: "confirmationEmailSent", run: sendConfirmationAndReceiptEmail },
  { key: "welcomeEmailsSent", run: sendAttendeeWelcomeEmails },
  {
    key: "organiserNotified",
    // Returns false on partial/total recipient failure so the flag stays
    // false and the next webhook replay / admin redeliver can retry.
    run: sendOrganiserNotification,
  },
  {
    key: "sheetsSynced",
    run: async (bookingId) => {
      await syncBookingToSheets(bookingId);
      return true;
    },
  },
];

async function runSponsorStaffSideEffects(
  bookingId: number,
  sponsorId: number,
): Promise<{ ran: SideEffectKey[]; skipped: SideEffectKey[]; failed: SideEffectKey[] }> {
  const ran: SideEffectKey[] = [];
  const skipped: SideEffectKey[] = [];
  const failed: SideEffectKey[] = [];
  const [attendee] = await db
    .select()
    .from(attendeesTable)
    .where(and(eq(attendeesTable.bookingId, bookingId), eq(attendeesTable.isLead, true)));

  const mailClaim = await db
    .update(bookingsTable)
    .set({ confirmationEmailSent: true, welcomeEmailsSent: true })
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        or(
          eq(bookingsTable.confirmationEmailSent, false),
          eq(bookingsTable.welcomeEmailsSent, false),
        ),
      ),
    )
    .returning({ id: bookingsTable.id });
  if (!mailClaim.length) {
    skipped.push("confirmationEmailSent", "welcomeEmailsSent");
  } else {
    const sent = attendee
      ? await sendSponsorStaffWelcome(sponsorId, bookingId, attendee.id).catch(() => false)
      : false;
    if (sent) {
      ran.push("confirmationEmailSent", "welcomeEmailsSent");
    } else {
      failed.push("confirmationEmailSent", "welcomeEmailsSent");
      await db
        .update(bookingsTable)
        .set({ confirmationEmailSent: false, welcomeEmailsSent: false })
        .where(eq(bookingsTable.id, bookingId));
    }
  }

  const organiserClaim = await db
    .update(bookingsTable)
    .set({ organiserNotified: true })
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.organiserNotified, false)))
    .returning({ id: bookingsTable.id });
  if (!organiserClaim.length) {
    skipped.push("organiserNotified");
  } else {
    const notified = await sendSponsorInternalNotification({
      sponsorId,
      category: "passes",
      event: "Sponsor staff delivery retried",
      summary: attendee
        ? `${attendee.firstName} ${attendee.lastName}'s sponsor staff registration was redelivered.`
        : `Sponsor staff booking #${bookingId} was redelivered.`,
    }).catch(() => false);
    if (notified) ran.push("organiserNotified");
    else {
      failed.push("organiserNotified");
      await db
        .update(bookingsTable)
        .set({ organiserNotified: false })
        .where(eq(bookingsTable.id, bookingId));
    }
  }

  const sheetsClaim = await db
    .update(bookingsTable)
    .set({ sheetsSynced: true })
    .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.sheetsSynced, false)))
    .returning({ id: bookingsTable.id });
  if (!sheetsClaim.length) {
    skipped.push("sheetsSynced");
  } else {
    try {
      await syncBookingToSheets(bookingId);
      ran.push("sheetsSynced");
    } catch {
      failed.push("sheetsSynced");
      await db
        .update(bookingsTable)
        .set({ sheetsSynced: false })
        .where(eq(bookingsTable.id, bookingId));
    }
  }

  return { ran, skipped, failed };
}

/**
 * Run any post-confirmation side-effects that haven't yet succeeded for this
 * booking. Safe to call repeatedly — each side-effect uses an atomic
 * "claim flag" pattern so two concurrent invocations can't double-fire.
 *
 * Used by:
 *  - The four confirmation paths immediately after `claimBookingConfirmation`
 *  - Stripe webhook replays for already-confirmed bookings
 *  - Admin "Redeliver" button on the Registrations panel
 */
export async function runConfirmationSideEffects(
  bookingId: number,
): Promise<{ ran: SideEffectKey[]; skipped: SideEffectKey[]; failed: SideEffectKey[] }> {
  const ran: SideEffectKey[] = [];
  const skipped: SideEffectKey[] = [];
  const failed: SideEffectKey[] = [];

  // Hard gate: only fire confirmation side-effects for bookings whose
  // status is currently `paid` or `invoiced`. This protects against a
  // caller invoking us after `claimBookingConfirmation` returned null
  // because the booking is in a non-confirmable state (cancelled,
  // refunded, disputed, abandoned-draft, etc.) — we must NOT send
  // welcome emails / organiser notifications / sheet syncs in that case.
  const [current] = await db
    .select({
      status: bookingsTable.status,
      manualEntry: bookingsTable.manualEntry,
      registrationSource: bookingsTable.registrationSource,
      sponsorId: bookingsTable.sponsorId,
    })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (
    !current ||
    current.manualEntry ||
    (current.status !== "paid" && current.status !== "invoiced")
  ) {
    logger.info(
      { bookingId, status: current?.status ?? null },
      "runConfirmationSideEffects: booking is manual or not in paid/invoiced state — skipping all side-effects",
    );
    return { ran, skipped: SIDE_EFFECTS.map((s) => s.key), failed };
  }

  if (current.registrationSource === "sponsor_staff" && current.sponsorId) {
    return runSponsorStaffSideEffects(bookingId, current.sponsorId);
  }

  for (const effect of SIDE_EFFECTS) {
    // Atomic per-flag claim: only the caller who flips false→true gets to
    // execute. A second concurrent invocation observes `claimed.length === 0`
    // and skips. On failure we reset the flag to false so the next replay
    // (Stripe webhook retry, admin redeliver) picks it up.
    const claimed = await db
      .update(bookingsTable)
      .set({ [effect.key]: true } as Partial<typeof bookingsTable.$inferInsert>)
      .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable[effect.key], false)))
      .returning({ id: bookingsTable.id });

    if (claimed.length === 0) {
      skipped.push(effect.key);
      continue;
    }

    let ok: boolean;
    try {
      ok = await effect.run(bookingId);
    } catch (err) {
      logger.error(
        { err, bookingId, sideEffect: effect.key },
        "runConfirmationSideEffects: side-effect threw",
      );
      ok = false;
    }

    if (ok) {
      ran.push(effect.key);
    } else {
      failed.push(effect.key);
      // Release the claim so the next replay can retry.
      await db
        .update(bookingsTable)
        .set({ [effect.key]: false } as Partial<typeof bookingsTable.$inferInsert>)
        .where(eq(bookingsTable.id, bookingId));
    }
  }

  if (failed.length > 0) {
    logger.warn(
      { bookingId, failed, ran, skipped },
      "runConfirmationSideEffects: one or more side-effects failed — booking flagged for retry",
    );
  } else {
    logger.info(
      { bookingId, ran, skipped },
      "runConfirmationSideEffects: all eligible side-effects completed",
    );
  }

  try {
    const sponsorNotified = await notifySponsorRedemptionForBooking(bookingId);
    if (!sponsorNotified) failed.push("organiserNotified");
  } catch (err) {
    logger.error({ err, bookingId }, "Sponsor redemption notification failed");
  }

  return { ran, skipped, failed };
}

/**
 * SQL predicate: a `paid` or `invoiced` booking with at least one
 * delivery flag still false → "needs attention" in the admin panel.
 */
export const needsAttentionPredicate = and(
  inArray(bookingsTable.status, ["paid", "invoiced"]),
  eq(bookingsTable.manualEntry, false),
  or(
    eq(bookingsTable.confirmationEmailSent, false),
    eq(bookingsTable.welcomeEmailsSent, false),
    eq(bookingsTable.organiserNotified, false),
    eq(bookingsTable.sheetsSynced, false),
  ),
);

/**
 * Surface the per-side-effect delivery state to the admin UI.
 */
export function deliveryStatusForBooking(b: typeof bookingsTable.$inferSelect): {
  confirmationEmailSent: boolean;
  welcomeEmailsSent: boolean;
  communitySocialEmailSent: boolean;
  organiserNotified: boolean;
  sheetsSynced: boolean;
  needsAttention: boolean;
} {
  const isConfirmed = (b.status === "paid" || b.status === "invoiced") && !b.manualEntry;
  const anyMissing =
    !b.confirmationEmailSent || !b.welcomeEmailsSent || !b.organiserNotified || !b.sheetsSynced;
  return {
    confirmationEmailSent: b.confirmationEmailSent,
    welcomeEmailsSent: b.welcomeEmailsSent,
    communitySocialEmailSent: b.communitySocialEmailSent,
    organiserNotified: b.organiserNotified,
    sheetsSynced: b.sheetsSynced,
    needsAttention: isConfirmed && anyMissing,
  };
}

// Suppress unused-import lints in case someone re-imports — these are kept
// available for callers that need to compose extra predicates.
void isNull;
void not;
