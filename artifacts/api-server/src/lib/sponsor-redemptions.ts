import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  attendeesTable,
  bookingsTable,
  db,
  promoCodesTable,
  sponsorPromoCodesTable,
  sponsorRedemptionsTable,
} from "@workspace/db";
import { incrementPromoUsage, type DbExecutor } from "./pricing";
import { sendSponsorInternalNotification } from "./sponsor-email";

async function reserveWithExecutor(
  code: string,
  quantity: number,
  bookingId: number,
  conn: DbExecutor,
): Promise<boolean> {
  const normalised = code.toUpperCase();
  const [mapped] = await conn
    .select({
      promoId: promoCodesTable.id,
      sponsorId: sponsorPromoCodesTable.sponsorId,
      discountType: promoCodesTable.discountType,
    })
    .from(promoCodesTable)
    .leftJoin(sponsorPromoCodesTable, eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id))
    .where(eq(promoCodesTable.code, normalised));
  if (!mapped) return false;
  if (!mapped.sponsorId) return incrementPromoUsage(normalised, quantity, conn);

  await conn
    .update(bookingsTable)
    .set({ sponsorId: mapped.sponsorId, updatedAt: new Date() })
    .where(eq(bookingsTable.id, bookingId));

  const units = mapped.discountType === "complimentary" ? Math.max(1, quantity) : 1;
  const reservationKey = `${bookingId}:${mapped.promoId}`;
  const inserted = await conn
    .insert(sponsorRedemptionsTable)
    .values({
      sponsorId: mapped.sponsorId,
      promoCodeId: mapped.promoId,
      bookingId,
      units,
      reservationKey,
    })
    .onConflictDoNothing({ target: sponsorRedemptionsTable.reservationKey })
    .returning({ id: sponsorRedemptionsTable.id });

  if (!inserted.length) {
    const [existing] = await conn
      .select({ status: sponsorRedemptionsTable.status })
      .from(sponsorRedemptionsTable)
      .where(eq(sponsorRedemptionsTable.reservationKey, reservationKey));
    return existing?.status === "reserved";
  }

  const updated = await conn
    .update(promoCodesTable)
    .set({ usedCount: sql`${promoCodesTable.usedCount} + ${units}` })
    .where(
      and(
        eq(promoCodesTable.id, mapped.promoId),
        eq(promoCodesTable.isActive, true),
        or(
          isNull(promoCodesTable.maxUses),
          sql`${promoCodesTable.usedCount} + ${units} <= ${promoCodesTable.maxUses}`,
        ),
      ),
    );
  if ((updated.rowCount ?? 0) < 1) {
    await conn
      .delete(sponsorRedemptionsTable)
      .where(eq(sponsorRedemptionsTable.id, inserted[0].id));
    return false;
  }
  return true;
}

export async function reservePromoUsageForBooking(
  code: string,
  quantity: number,
  bookingId: number,
  conn?: DbExecutor,
): Promise<boolean> {
  if (conn) return reserveWithExecutor(code, quantity, bookingId, conn);
  return db.transaction((tx) => reserveWithExecutor(code, quantity, bookingId, tx));
}

export async function releaseSponsorRedemption(
  bookingId: number,
  reason: string,
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const released = await tx
      .update(sponsorRedemptionsTable)
      .set({ status: "released", releasedAt: new Date(), releaseReason: reason })
      .where(
        and(
          eq(sponsorRedemptionsTable.bookingId, bookingId),
          eq(sponsorRedemptionsTable.status, "reserved"),
        ),
      )
      .returning({
        promoCodeId: sponsorRedemptionsTable.promoCodeId,
        units: sponsorRedemptionsTable.units,
      });
    if (!released.length) return null;
    await tx
      .update(promoCodesTable)
      .set({
        usedCount: sql`greatest(0, ${promoCodesTable.usedCount} - ${released[0].units})`,
      })
      .where(eq(promoCodesTable.id, released[0].promoCodeId));
    const [row] = await tx
      .select({ sponsorId: sponsorRedemptionsTable.sponsorId })
      .from(sponsorRedemptionsTable)
      .where(eq(sponsorRedemptionsTable.bookingId, bookingId));
    return row?.sponsorId ?? null;
  });
  if (result) {
    await sendSponsorInternalNotification({
      sponsorId: result,
      category: "passes",
      event: "Sponsor pass released",
      summary: `Booking #${bookingId} released its sponsor allocation (${reason}).`,
    });
  }
  return true;
}

export async function restoreSponsorRedemption(bookingId: number): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM sponsor_redemptions WHERE booking_id = ${bookingId} FOR UPDATE`,
    );
    const [redemption] = await tx
      .select()
      .from(sponsorRedemptionsTable)
      .where(eq(sponsorRedemptionsTable.bookingId, bookingId));
    if (!redemption) return { success: true, sponsorId: null as number | null, units: 0 };
    if (redemption.status === "reserved") {
      return { success: true, sponsorId: null as number | null, units: redemption.units };
    }
    const updated = await tx
      .update(promoCodesTable)
      .set({ usedCount: sql`${promoCodesTable.usedCount} + ${redemption.units}` })
      .where(
        and(
          eq(promoCodesTable.id, redemption.promoCodeId),
          eq(promoCodesTable.isActive, true),
          or(
            isNull(promoCodesTable.maxUses),
            sql`${promoCodesTable.usedCount} + ${redemption.units} <= ${promoCodesTable.maxUses}`,
          ),
        ),
      );
    if ((updated.rowCount ?? 0) < 1) {
      return { success: false, sponsorId: redemption.sponsorId, units: redemption.units };
    }
    await tx
      .update(sponsorRedemptionsTable)
      .set({ status: "reserved", reservedAt: new Date(), releasedAt: null, releaseReason: null })
      .where(eq(sponsorRedemptionsTable.id, redemption.id));
    return { success: true, sponsorId: redemption.sponsorId, units: redemption.units };
  });
  if (result.success && result.sponsorId) {
    await sendSponsorInternalNotification({
      sponsorId: result.sponsorId,
      category: "passes",
      event: "Sponsor pass restored",
      summary: `Booking #${bookingId} was deliberately restored and ${result.units} ${result.units === 1 ? "pass was" : "passes were"} re-reserved.`,
    });
  }
  return result.success;
}

export async function notifySponsorRedemptionForBooking(bookingId: number): Promise<boolean> {
  const [redemption] = await db
    .select()
    .from(sponsorRedemptionsTable)
    .where(eq(sponsorRedemptionsTable.bookingId, bookingId));
  if (!redemption || redemption.status !== "reserved" || redemption.notificationSentAt) return true;
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  const [lead] = await db
    .select()
    .from(attendeesTable)
    .where(and(eq(attendeesTable.bookingId, bookingId), eq(attendeesTable.isLead, true)));
  const sent = await sendSponsorInternalNotification({
    sponsorId: redemption.sponsorId,
    category: "passes",
    event: "Sponsor code redeemed",
    summary: `${lead ? `${lead.firstName} ${lead.lastName}` : `Booking #${bookingId}`} registered ${redemption.units} ${redemption.units === 1 ? "pass" : "passes"} using ${booking?.promoCode ?? "a sponsor code"}.`,
  });
  await db
    .update(sponsorRedemptionsTable)
    .set(
      sent
        ? { notificationSentAt: new Date(), notificationFailedAt: null }
        : { notificationFailedAt: new Date() },
    )
    .where(eq(sponsorRedemptionsTable.id, redemption.id));
  return sent;
}
