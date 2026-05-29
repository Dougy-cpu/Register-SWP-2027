import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, lte, gte, or, isNull, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { promoCodesTable, bookingsTable, attendeesTable } from "@workspace/db";
import { PASS_PRICES } from "../lib/pricing";

const router: IRouter = Router();

/**
 * Express handler for `POST /api/promo-codes/validate`.
 *
 * Exported so unit/integration tests can invoke it directly with fake
 * `req`/`res` objects (matching the pattern used by other route tests in
 * this package), without needing a full HTTP listener.
 */
export async function validatePromoCodeHandler(req: Request, res: Response): Promise<void> {
  const { code, passType, quantity, leadEmail } = req.body;

  if (!code || !passType || !quantity) {
    res.status(400).json({ error: "code, passType, and quantity are required" });
    return;
  }

  const qty = parseInt(quantity, 10);

  const now = new Date();
  const [promo] = await db
    .select()
    .from(promoCodesTable)
    .where(
      and(
        eq(promoCodesTable.code, (code as string).toUpperCase()),
        eq(promoCodesTable.isActive, true),
        or(isNull(promoCodesTable.validFrom), lte(promoCodesTable.validFrom, now)),
        or(isNull(promoCodesTable.validUntil), gte(promoCodesTable.validUntil, now)),
      ),
    );

  if (!promo) {
    res.status(400).json({ error: "Invalid or expired promo code" });
    return;
  }

  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    if (promo.discountType === "complimentary") {
      res
        .status(400)
        .json({ error: "This complimentary code has been fully redeemed - no tickets remain" });
    } else {
      res.status(400).json({ error: "This promo code has already been used up" });
    }
    return;
  }

  if (promo.applicablePassTypes && !promo.applicablePassTypes.includes(passType as string)) {
    const allowed = promo.applicablePassTypes
      .map((t: string) => (t === "single" ? "HR Professional Pass" : "Business Pass"))
      .join(" and ");
    res.status(400).json({ error: `This promo code is only valid for ${allowed}` });
    return;
  }

  if (promo.minQuantity !== null && qty < promo.minQuantity) {
    res.status(400).json({
      error: `This promo code requires a minimum of ${promo.minQuantity} ${promo.minQuantity === 1 ? "ticket" : "tickets"}`,
    });
    return;
  }

  if (promo.oncePerCustomer) {
    const email = typeof leadEmail === "string" ? leadEmail.trim().toLowerCase() : "";
    if (email) {
      const used = await isCodeUsedByEmail(promo.code, email);
      if (used) {
        res.status(400).json({
          error: "This promo code has already been used on a previous booking with this email",
        });
        return;
      }
    }
  }

  const passInfo = PASS_PRICES[passType as string];
  if (!passInfo) {
    res.status(400).json({ error: "Invalid pass type" });
    return;
  }

  const baseSubtotal = passInfo.price * qty;
  let discountAmount: number;
  let remainingSeats: number | null = null;

  if (promo.discountType === "percentage") {
    discountAmount = parseFloat(
      ((baseSubtotal * parseFloat(promo.discountValue.toString())) / 100).toFixed(2),
    );
    if (promo.maxDiscountAmount !== null) {
      const cap = parseFloat(promo.maxDiscountAmount.toString());
      if (discountAmount > cap) discountAmount = cap;
    }
  } else if (promo.discountType === "per_ticket") {
    discountAmount = Math.min(
      parseFloat((parseFloat(promo.discountValue.toString()) * qty).toFixed(2)),
      baseSubtotal,
    );
  } else if (promo.discountType === "complimentary") {
    // For comp codes we surface remainingSeats but allow apply-with-shortfall
    // so the UI can prompt the user to reduce or remove the code. Pricing
    // refuses to zero the order until quantity <= remainingSeats.
    if (promo.maxUses !== null) {
      remainingSeats = Math.max(0, promo.maxUses - promo.usedCount);
      if (remainingSeats === 0) {
        res
          .status(400)
          .json({ error: "This complimentary code has been fully redeemed - no tickets remain" });
        return;
      }
    }
    discountAmount = baseSubtotal;
  } else {
    discountAmount = Math.min(parseFloat(promo.discountValue.toString()), baseSubtotal);
  }

  res.json({
    valid: true,
    code: promo.code,
    discountType: promo.discountType,
    discountValue: parseFloat(promo.discountValue.toString()),
    discountAmount,
    message: promo.description || null,
    remainingSeats,
  });
}

router.post("/promo-codes/validate", validatePromoCodeHandler);

// Returns true if the given normalised email is the lead attendee on any
// paid/invoiced booking that already used this promo code.
export async function isCodeUsedByEmail(
  code: string,
  normalisedEmail: string,
  excludeBookingId?: number,
): Promise<boolean> {
  if (!normalisedEmail) return false;
  const matchingBookings = await db
    .select({ id: bookingsTable.id })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.promoCode, code.toUpperCase()),
        inArray(bookingsTable.status, ["paid", "invoiced"]),
      ),
    );
  const bookingIds = matchingBookings.map((b) => b.id).filter((id) => id !== excludeBookingId);
  if (bookingIds.length === 0) return false;
  const leads = await db
    .select({ workEmail: attendeesTable.workEmail, bookingId: attendeesTable.bookingId })
    .from(attendeesTable)
    .where(and(eq(attendeesTable.isLead, true), inArray(attendeesTable.bookingId, bookingIds)));
  return leads.some((l) => (l.workEmail || "").trim().toLowerCase() === normalisedEmail);
}

export default router;
