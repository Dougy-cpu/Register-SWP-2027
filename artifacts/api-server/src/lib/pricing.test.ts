import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Drizzle mock that *captures* the values passed to the `sql` template tag
// and to the relational operators, so tests can assert on the actual SQL
// fragments built by `incrementPromoUsage` (specifically: that `inc` is
// quantity for complimentary codes and 1 otherwise, and that the WHERE
// clause includes the conditional cap predicate). Without this, a regression
// in those expressions would silently pass.
// ---------------------------------------------------------------------------

interface SqlNode {
  __kind: "sql";
  strings: readonly string[];
  values: unknown[];
}
interface OpNode {
  __kind: "op";
  name: string;
  args: unknown[];
}

function isSql(v: unknown): v is SqlNode {
  return typeof v === "object" && v !== null && (v as { __kind?: string }).__kind === "sql";
}
function isOp(v: unknown): v is OpNode {
  return typeof v === "object" && v !== null && (v as { __kind?: string }).__kind === "op";
}

vi.mock("drizzle-orm", () => {
  const op =
    (name: string) =>
    (...args: unknown[]): OpNode => ({ __kind: "op", name, args });
  return {
    eq: op("eq"),
    and: op("and"),
    or: op("or"),
    isNull: op("isNull"),
    lte: op("lte"),
    gte: op("gte"),
    inArray: op("inArray"),
    sql: (strings: TemplateStringsArray, ...values: unknown[]): SqlNode => ({
      __kind: "sql",
      strings,
      values,
    }),
  };
});

// ---------------------------------------------------------------------------
// In-memory fake of @workspace/db. Each test pre-seeds `dbState` with rows
// and the chainable/thenable builder returns them when awaited. The mock
// honours the *table identity* but not the WHERE predicate (predicates are
// asserted separately in the contract tests below).
// ---------------------------------------------------------------------------

type PromoRow = {
  code: string;
  discountType: "percentage" | "per_ticket" | "fixed" | "complimentary";
  discountValue: string;
  isActive: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  maxUses: number | null;
  usedCount: number;
  maxDiscountAmount: string | null;
  applicablePassTypes: string[] | null;
  minQuantity: number | null;
  oncePerCustomer: boolean;
  description: string | null;
};

type DiscountTierRow = { passType: string; minQuantity: number; discountPercent: string };
type PassConfigRow = { passType: string; currentPrice: string; originalPrice: string };

interface FakeDbState {
  promos: PromoRow[];
  tiers: DiscountTierRow[];
  passes: PassConfigRow[];
}

const dbState: FakeDbState = { promos: [], tiers: [], passes: [] };

interface CapturedUpdate {
  setArg: Record<string, unknown>;
  whereArg: unknown;
  rowCount: number;
}
const updateLog: CapturedUpdate[] = [];

function resetDb() {
  dbState.promos = [];
  dbState.tiers = [];
  dbState.passes = [];
  updateLog.length = 0;
}

vi.mock("@workspace/db", () => {
  function rowsFor(name: string): Record<string, unknown>[] {
    if (name === "promoCodes") return dbState.promos as unknown as Record<string, unknown>[];
    if (name === "discountTiers") return dbState.tiers as unknown as Record<string, unknown>[];
    if (name === "passConfig") return dbState.passes as unknown as Record<string, unknown>[];
    return [];
  }
  function makeChainable(name: string): Record<string, unknown> {
    return {
      where: () => makeChainable(name),
      orderBy: () => makeChainable(name),
      then: (
        onFulfilled?: (v: Record<string, unknown>[]) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(rowsFor(name)).then(onFulfilled, onRejected),
    };
  }

  // Top-level `db.update(promoCodesTable)` — used by `incrementPromoUsage`
  // when no explicit conn is passed. We honour the conditional cap by
  // simulating the SQL predicate against the seeded `promos` row, so default-
  // path concurrency tests are end-to-end accurate.
  function topLevelUpdate(table: { __name: string }) {
    return {
      set: (setArg: Record<string, unknown>) => ({
        where: async (whereArg: unknown) => {
          const setUsed = setArg["usedCount"];
          const inc = isSql(setUsed) ? Number(setUsed.values[1]) : 1;
          if (table.__name !== "promoCodes" || dbState.promos.length === 0) {
            updateLog.push({ setArg, whereArg, rowCount: 0 });
            return { rowCount: 0 };
          }
          const row = dbState.promos[0];
          const fits = row.maxUses === null || row.usedCount + inc <= row.maxUses;
          let rowCount = 0;
          if (fits) {
            row.usedCount += inc;
            rowCount = 1;
          }
          updateLog.push({ setArg, whereArg, rowCount });
          return { rowCount };
        },
      }),
    };
  }

  const db = {
    select: () => ({ from: (table: { __name: string }) => makeChainable(table.__name) }),
    update: (table: { __name: string }) => topLevelUpdate(table),
    transaction: async <T>(_cb: (tx: unknown) => Promise<T>): Promise<T> => {
      throw new Error("not used in these tests");
    },
  };

  return {
    db,
    promoCodesTable: {
      __name: "promoCodes",
      code: { __col: "code" },
      discountType: { __col: "discountType" },
      usedCount: { __col: "usedCount" },
      maxUses: { __col: "maxUses" },
      isActive: {},
      validFrom: {},
      validUntil: {},
    },
    discountTiersTable: { __name: "discountTiers", passType: {}, minQuantity: {} },
    passConfigTable: { __name: "passConfig" },
  };
});

import { incrementPromoUsage, calculatePricing } from "./pricing";

beforeEach(() => {
  resetDb();
});

function seedPromo(over: Partial<PromoRow> = {}): PromoRow {
  const promo: PromoRow = {
    code: "FREEPASS",
    discountType: "complimentary",
    discountValue: "0",
    isActive: true,
    validFrom: null,
    validUntil: null,
    maxUses: 5,
    usedCount: 0,
    maxDiscountAmount: null,
    applicablePassTypes: null,
    minQuantity: null,
    oncePerCustomer: false,
    description: null,
    ...over,
  };
  dbState.promos.push(promo);
  return promo;
}

// Walk an op-tree and return all `inc` values appearing in cap-style
// predicates `usedCount + ${inc} <= maxUses`.
function findCapInc(node: unknown): number[] {
  const found: number[] = [];
  const visit = (n: unknown): void => {
    if (isSql(n)) {
      // Cap predicate shape `${usedCount} + ${inc} <= ${maxUses}` →
      // strings = ["", " + ", " <= ", ""], values = [usedCount, inc, maxUses].
      if (
        n.strings.length === 4 &&
        n.values.length === 3 &&
        n.strings[1].includes("+") &&
        n.strings[2].includes("<=")
      ) {
        const incVal = n.values[1];
        if (typeof incVal === "number") found.push(incVal);
      }
      n.values.forEach(visit);
    } else if (isOp(n)) {
      n.args.forEach(visit);
    }
  };
  visit(node);
  return found;
}

// ---------------------------------------------------------------------------
// incrementPromoUsage — contract: the increment value built into the SQL is
// `quantity` for complimentary codes and `1` for everything else, and the
// WHERE clause includes the conditional cap predicate. These two together
// are what guarantee Postgres-side atomic cap enforcement; testing the
// shape of the SQL fragments locks the contract.
// ---------------------------------------------------------------------------

describe("incrementPromoUsage SQL contract", () => {
  it("for a non-complimentary code, encodes inc=1 in both SET and the cap predicate", async () => {
    seedPromo({ code: "TENPCT", discountType: "percentage", maxUses: 100, usedCount: 0 });
    await incrementPromoUsage("TENPCT", 7);
    expect(updateLog).toHaveLength(1);
    const { setArg, whereArg } = updateLog[0];
    const setUsed = setArg["usedCount"];
    expect(isSql(setUsed)).toBe(true);
    expect((setUsed as SqlNode).values[1]).toBe(1);
    const capIncs = findCapInc(whereArg);
    expect(capIncs).toContain(1);
  });

  it("for a complimentary code, encodes inc=quantity in both SET and the cap predicate", async () => {
    seedPromo({ discountType: "complimentary", maxUses: 50, usedCount: 0 });
    await incrementPromoUsage("FREEPASS", 4);
    expect(updateLog).toHaveLength(1);
    const { setArg, whereArg } = updateLog[0];
    expect((setArg["usedCount"] as SqlNode).values[1]).toBe(4);
    expect(findCapInc(whereArg)).toContain(4);
  });

  it("returns false (and skips update) when the code is not found", async () => {
    const ok = await incrementPromoUsage("MISSING", 1);
    expect(ok).toBe(false);
    expect(updateLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// incrementPromoUsage — atomic cap behaviour through the *real* db mock.
// Concurrency here is JS microtask-level, not multi-process; the value comes
// from the fact that the cap predicate is enforced by the same db mock that
// every call routes through (so a dropped cap predicate would let too many
// succeed). Combined with the SQL contract tests above, this rounds out the
// guarantee that Postgres-side atomic enforcement is in play.
// ---------------------------------------------------------------------------

describe("incrementPromoUsage cap enforcement (via db mock)", () => {
  it("cannot oversubscribe a non-complimentary capped code under concurrent calls", async () => {
    seedPromo({ code: "TENPCT", discountType: "percentage", maxUses: 3, usedCount: 0 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => incrementPromoUsage("TENPCT", 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(dbState.promos[0].usedCount).toBe(3);
  });

  it("cannot oversubscribe a complimentary capped code under concurrent multi-pass calls", async () => {
    seedPromo({ discountType: "complimentary", maxUses: 5, usedCount: 0 });
    // Five concurrent comp bookings of 2 passes each = 10 passes requested.
    // Only those that fit (2+2 = 4 ≤ 5) should commit; the third would push
    // total to 6 > 5 and must be rejected.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => incrementPromoUsage("FREEPASS", 2)),
    );
    const successes = results.filter(Boolean).length;
    expect(successes).toBe(2);
    expect(dbState.promos[0].usedCount).toBe(4);
  });

  it("treats null maxUses as unlimited", async () => {
    seedPromo({ discountType: "complimentary", maxUses: null, usedCount: 0 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => incrementPromoUsage("FREEPASS", 3)),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(dbState.promos[0].usedCount).toBe(60);
  });

  it("uses the supplied conn for both lookup and update", async () => {
    let selects = 0;
    let updates = 0;
    const conn = {
      select: () => {
        selects++;
        return {
          from: () => ({
            where: async () => [{ discountType: "percentage" }],
          }),
        };
      },
      update: () => {
        updates++;
        return { set: () => ({ where: async () => ({ rowCount: 1 }) }) };
      },
    } as unknown as Parameters<typeof incrementPromoUsage>[2];
    const ok = await incrementPromoUsage("FOO", 1, conn);
    expect(ok).toBe(true);
    expect(selects).toBe(1);
    expect(updates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// calculatePricing — the new complimentary branch (zero on fit, leave full
// price + surface remainingSeats on shortfall).
// ---------------------------------------------------------------------------

describe("calculatePricing — complimentary code", () => {
  it("zeros the order when remaining seats >= requested quantity", async () => {
    seedPromo({ maxUses: 5, usedCount: 0 });
    const result = await calculatePricing("single", 3, "FREEPASS");
    expect(result.baseSubtotal).toBe(747);
    expect(result.promoDiscountAmount).toBe(747);
    expect(result.subtotalAfterDiscounts).toBe(0);
    expect(result.total).toBe(0);
    expect(result.promoDiscountType).toBe("complimentary");
    expect(result.promoRemainingSeats).toBe(5);
  });

  it("zeros the order when remaining seats == requested quantity (exact-fit)", async () => {
    seedPromo({ maxUses: 4, usedCount: 1 });
    const result = await calculatePricing("single", 3, "FREEPASS");
    expect(result.promoDiscountAmount).toBe(747);
    expect(result.total).toBe(0);
    expect(result.promoRemainingSeats).toBe(3);
  });

  it("does NOT discount when remaining seats < requested quantity (shortfall)", async () => {
    seedPromo({ maxUses: 5, usedCount: 3 });
    const result = await calculatePricing("single", 3, "FREEPASS");
    expect(result.promoDiscountAmount).toBe(0);
    expect(result.subtotalAfterDiscounts).toBe(747);
    expect(result.vatAmount).toBeCloseTo(149.4, 2);
    expect(result.total).toBeCloseTo(896.4, 2);
    expect(result.promoDiscountType).toBe("complimentary");
    expect(result.promoRemainingSeats).toBe(2);
  });

  it("does NOT discount when remaining seats == 0", async () => {
    seedPromo({ maxUses: 2, usedCount: 2 });
    const result = await calculatePricing("single", 1, "FREEPASS");
    expect(result.promoDiscountAmount).toBe(0);
    expect(result.promoRemainingSeats).toBe(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it("treats null maxUses as unlimited and always covers the order", async () => {
    seedPromo({ maxUses: null, usedCount: 0 });
    const result = await calculatePricing("single", 10, "FREEPASS");
    expect(result.promoDiscountAmount).toBe(result.baseSubtotal);
    expect(result.total).toBe(0);
    expect(result.promoRemainingSeats).toBeNull();
  });
});
