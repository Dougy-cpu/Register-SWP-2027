import { db } from "@workspace/db";
import { discountTiersTable, promoCodesTable, passConfigTable } from "@workspace/db";
import { eq, and, lte, gte, or, isNull, sql } from "drizzle-orm";

/**
 * Either the top-level `db` instance or a transactional handle obtained from
 * `db.transaction(async (tx) => ...)`. Both expose the same `select`/`update`
 * surface used by `incrementPromoUsage`, so callers can pass either.
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomically increment a promo code's `usedCount` after a successful booking
 * confirmation, refusing to exceed `maxUses` when set. For "complimentary"
 * codes the counter tracks passes issued (so we add the booking's quantity);
 * for every other discount type the counter tracks bookings (so we add 1).
 *
 * Returns `true` if the counter was incremented, `false` if the increment was
 * rejected because it would exceed the cap. (`false` is also returned if the
 * code does not exist.)
 *
 * The cap check and the increment are performed in a single conditional
 * UPDATE so concurrent confirmations cannot oversubscribe a capped code.
 *
 * Pass an optional `conn` (a transaction handle) to make the increment part of
 * a larger atomic confirmation — the booking status update and this increment
 * then commit (or roll back) together, so a crash mid-confirmation can never
 * leave the booking marked paid while the promo counter is stale, or vice
 * versa.
 */
export async function incrementPromoUsage(
  code: string,
  quantity: number,
  conn: DbExecutor = db,
): Promise<boolean> {
  const normalised = code.toUpperCase();
  const [promo] = await conn
    .select({ discountType: promoCodesTable.discountType })
    .from(promoCodesTable)
    .where(eq(promoCodesTable.code, normalised));
  if (!promo) return false;
  const inc = promo.discountType === "complimentary" ? Math.max(1, quantity) : 1;
  const result = await conn
    .update(promoCodesTable)
    .set({ usedCount: sql`${promoCodesTable.usedCount} + ${inc}` })
    .where(
      and(
        eq(promoCodesTable.code, normalised),
        or(
          isNull(promoCodesTable.maxUses),
          sql`${promoCodesTable.usedCount} + ${inc} <= ${promoCodesTable.maxUses}`,
        ),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

export const PASS_PRICES: Record<string, { price: number; originalPrice: number; seats: number }> =
  {
    single: { price: 249, originalPrice: 429, seats: 1 },
    team: { price: 499, originalPrice: 1200, seats: 3 },
    business: { price: 499, originalPrice: 999, seats: 1 },
  };

const PASS_PRICE_DEFAULTS = PASS_PRICES;

async function getPassPrices(): Promise<
  Record<string, { price: number; originalPrice: number; seats: number }>
> {
  const configs = await db.select().from(passConfigTable);
  const result = { ...PASS_PRICE_DEFAULTS };
  for (const config of configs) {
    if (result[config.passType]) {
      result[config.passType] = {
        ...result[config.passType],
        price: parseFloat(config.currentPrice.toString()),
        originalPrice: parseFloat(config.originalPrice.toString()),
      };
    }
  }
  return result;
}

export const VAT_RATE = 0.2;
// VAT in basis points (× 10000) so vat math stays in integer pence.
const VAT_BASIS_POINTS = 2000;

export interface PricingResult {
  passType: string;
  quantity: number;
  pricePerHead: number;
  baseSubtotal: number;
  groupDiscountPercent: number;
  groupDiscountAmount: number;
  promoDiscountAmount: number;
  subtotalAfterDiscounts: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  originalPrice: number;
  savedAmount: number;
  promoDiscountType?: string | null;
  promoRemainingSeats?: number | null;
}

// ---------------------------------------------------------------------------
// Pence helpers. Internally every monetary intermediate is an integer number
// of pence — pounds only appear at the API boundary. This eliminates the
// 1p drift caused by repeated parseFloat → toFixed(2) → parseFloat round
// trips in the previous implementation.
// ---------------------------------------------------------------------------

function poundsToPence(pounds: number | string): number {
  // Use string-based rounding to avoid 0.1 + 0.2 → 0.30000000000000004
  // contaminating the pence value.
  const n = typeof pounds === "string" ? parseFloat(pounds) : pounds;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function penceToPounds(pence: number): number {
  return Math.round(pence) / 100;
}

export async function calculatePricing(
  passType: string,
  quantity: number,
  promoCode?: string | null,
): Promise<PricingResult> {
  // ---- Input guards --------------------------------------------------------
  // Reject non-positive / non-integer quantities at the boundary so downstream
  // code (and the receipt!) never has to deal with NaN or negative seats.
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive integer");
  }

  const PASS_PRICES = await getPassPrices();
  const passInfo = PASS_PRICES[passType];
  if (!passInfo) throw new Error(`Unknown pass type: ${passType}`);

  // ---- Convert all unit prices to integer pence -----------------------------
  const pricePerHeadP = poundsToPence(passInfo.price);
  const originalUnitP = poundsToPence(passInfo.originalPrice);

  // Team pass is a fixed-price bundle: 1 bundle = £499 for 3 seats.
  // Other passes are per-unit: quantity drives the base price.
  const billingUnits = passInfo.seats > 1 ? Math.ceil(quantity / passInfo.seats) : quantity;

  const baseSubtotalP = pricePerHeadP * billingUnits;
  const originalPriceP = originalUnitP * billingUnits;

  const tiers = await db
    .select()
    .from(discountTiersTable)
    .where(eq(discountTiersTable.passType, passType as "single" | "team" | "business"))
    .orderBy(discountTiersTable.minQuantity);

  let groupDiscountPercent = 0;
  for (const tier of tiers) {
    if (quantity >= tier.minQuantity) {
      groupDiscountPercent = parseFloat(tier.discountPercent.toString());
    }
  }

  // Group discount in pence: (subtotal × percent × 100) / 10000 — done in a
  // single integer division so we get banker's-style rounding consistent with
  // a single Math.round call rather than repeated toFixed().
  const groupDiscountP = Math.round((baseSubtotalP * groupDiscountPercent) / 100);

  let promoDiscountP = 0;
  let promoDiscountType: string | null = null;
  let promoRemainingSeats: number | null = null;
  if (promoCode) {
    const now = new Date();
    const [promo] = await db
      .select()
      .from(promoCodesTable)
      .where(
        and(
          eq(promoCodesTable.code, promoCode.toUpperCase()),
          eq(promoCodesTable.isActive, true),
          or(isNull(promoCodesTable.validFrom), lte(promoCodesTable.validFrom, now)),
          or(isNull(promoCodesTable.validUntil), gte(promoCodesTable.validUntil, now)),
        ),
      );

    if (promo) {
      if (promo.applicablePassTypes && !promo.applicablePassTypes.includes(passType)) {
        throw new Error("Promo code is not valid for this pass type");
      }
      if (promo.minQuantity !== null && quantity < promo.minQuantity) {
        throw new Error(`Promo code requires at least ${promo.minQuantity} passes`);
      }
      if (promo.maxQuantityPerBooking !== null && quantity > promo.maxQuantityPerBooking) {
        throw new Error(
          `Promo code allows no more than ${promo.maxQuantityPerBooking} passes per booking`,
        );
      }
      promoDiscountType = promo.discountType;
      const afterGroupP = baseSubtotalP - groupDiscountP;
      if (promo.discountType === "percentage") {
        const pct = parseFloat(promo.discountValue.toString());
        promoDiscountP = Math.round((afterGroupP * pct) / 100);
        if (promo.maxDiscountAmount !== null) {
          const capP = poundsToPence(promo.maxDiscountAmount.toString());
          if (promoDiscountP > capP) promoDiscountP = capP;
        }
      } else if (promo.discountType === "per_ticket") {
        const perTicketP = poundsToPence(promo.discountValue.toString());
        promoDiscountP = Math.min(perTicketP * quantity, afterGroupP);
      } else if (promo.discountType === "complimentary") {
        if (promo.maxUses !== null) {
          promoRemainingSeats = Math.max(0, promo.maxUses - promo.usedCount);
        }
        // Comp = 100% off, but only if every requested pass is covered by
        // the remaining cap. If the request exceeds remaining passes, the
        // discount does not apply — the caller (UI) will surface a prompt
        // asking the user to reduce the quantity or remove the code.
        if (promoRemainingSeats === null || promoRemainingSeats >= quantity) {
          promoDiscountP = afterGroupP;
        }
      } else {
        const fixedP = poundsToPence(promo.discountValue.toString());
        promoDiscountP = Math.min(fixedP, afterGroupP);
      }
    }
  }

  // ---- Final totals --------------------------------------------------------
  // Clamp the post-discount subtotal at zero. Without this, a fixed-amount
  // promo larger than the basket could produce a negative receipt — see
  // task #70 acceptance ("never a negative receipt").
  const subtotalAfterDiscountsP = Math.max(0, baseSubtotalP - groupDiscountP - promoDiscountP);
  const vatAmountP = Math.round((subtotalAfterDiscountsP * VAT_BASIS_POINTS) / 10000);
  const totalP = subtotalAfterDiscountsP + vatAmountP;
  const savedAmountP =
    originalPriceP - baseSubtotalP + groupDiscountP + Math.min(promoDiscountP, baseSubtotalP);

  return {
    passType,
    quantity,
    pricePerHead: penceToPounds(pricePerHeadP),
    baseSubtotal: penceToPounds(baseSubtotalP),
    groupDiscountPercent,
    groupDiscountAmount: penceToPounds(groupDiscountP),
    promoDiscountAmount: penceToPounds(promoDiscountP),
    subtotalAfterDiscounts: penceToPounds(subtotalAfterDiscountsP),
    vatRate: VAT_RATE,
    vatAmount: penceToPounds(vatAmountP),
    total: penceToPounds(totalP),
    originalPrice: penceToPounds(originalPriceP),
    savedAmount: penceToPounds(savedAmountP),
    promoDiscountType,
    promoRemainingSeats,
  };
}
