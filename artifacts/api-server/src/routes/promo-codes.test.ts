import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

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

const promos: PromoRow[] = [];

function resetPromos(...rows: PromoRow[]): void {
  promos.length = 0;
  promos.push(...rows);
}

vi.mock("@workspace/db", () => {
  const db = {
    select: () => ({ from: () => ({ where: async () => promos }) }),
  };
  return {
    db,
    promoCodesTable: {
      __name: "promoCodes",
      code: {},
      isActive: {},
      validFrom: {},
      validUntil: {},
    },
    bookingsTable: { __name: "bookings" },
    attendeesTable: { __name: "attendees" },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  lte: () => ({}),
  gte: () => ({}),
  inArray: () => ({}),
  sql: ((..._a: unknown[]) => ({})) as unknown,
}));

import { validatePromoCodeHandler } from "./promo-codes";

interface FakeRes {
  res: Response;
  status?: number;
  body?: unknown;
}

function makeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

function makeRes(): FakeRes {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status: (n: number) => {
      captured.status = n;
      return res;
    },
    json: (b: unknown) => {
      captured.body = b;
      return res;
    },
  } as unknown as Response;
  return new Proxy({} as FakeRes, {
    get(_t, prop) {
      if (prop === "res") return res;
      if (prop === "status") return captured.status;
      if (prop === "body") return captured.body;
      return undefined;
    },
  });
}

function basePromo(over: Partial<PromoRow> = {}): PromoRow {
  return {
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
}

beforeEach(() => {
  resetPromos();
});

describe("POST /api/promo-codes/validate — complimentary code shortfall", () => {
  it("returns valid + remainingSeats when seats remaining > requested quantity", async () => {
    resetPromos(basePromo({ maxUses: 5, usedCount: 0 }));
    const r = makeRes();
    await validatePromoCodeHandler(
      makeReq({ code: "freepass", passType: "single", quantity: 3 }),
      r.res,
    );
    expect(r.status).toBeUndefined();
    const body = r.body as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.code).toBe("FREEPASS");
    expect(body.discountType).toBe("complimentary");
    expect(body.remainingSeats).toBe(5);
    expect(body.discountAmount).toBe(597);
  });

  it("returns valid + true remaining count when requested qty exceeds remaining (shortfall)", async () => {
    resetPromos(basePromo({ maxUses: 5, usedCount: 3 }));
    const r = makeRes();
    await validatePromoCodeHandler(
      makeReq({ code: "FREEPASS", passType: "single", quantity: 4 }),
      r.res,
    );
    expect(r.status).toBeUndefined();
    const body = r.body as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.remainingSeats).toBe(2);
    expect(body.discountAmount).toBe(199 * 4);
  });

  it("rejects with the new shortfall message when comp code is fully redeemed", async () => {
    resetPromos(basePromo({ maxUses: 5, usedCount: 5 }));
    const r = makeRes();
    await validatePromoCodeHandler(
      makeReq({ code: "FREEPASS", passType: "single", quantity: 1 }),
      r.res,
    );
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>).error).toMatch(
      /complimentary code has been fully redeemed/i,
    );
  });

  it("uses the comp-specific copy via the maxUses-reached short-circuit", async () => {
    resetPromos(basePromo({ maxUses: 2, usedCount: 5 }));
    const r = makeRes();
    await validatePromoCodeHandler(
      makeReq({ code: "FREEPASS", passType: "single", quantity: 1 }),
      r.res,
    );
    expect(r.status).toBe(400);
    const error = (r.body as Record<string, unknown>).error as string;
    expect(error).toMatch(/complimentary code has been fully redeemed/i);
    expect(error).not.toMatch(/used up/i);
  });

  it("uses the generic 'used up' copy when a NON-complimentary capped code is exhausted", async () => {
    resetPromos(
      basePromo({ discountType: "percentage", discountValue: "10", maxUses: 1, usedCount: 1 }),
    );
    const r = makeRes();
    await validatePromoCodeHandler(
      makeReq({ code: "FREEPASS", passType: "single", quantity: 1 }),
      r.res,
    );
    expect(r.status).toBe(400);
    const error = (r.body as Record<string, unknown>).error as string;
    expect(error).toMatch(/already been used up/i);
    expect(error).not.toMatch(/complimentary/i);
  });

  it("returns null remainingSeats when the comp code has no cap (maxUses null)", async () => {
    resetPromos(basePromo({ maxUses: null, usedCount: 0 }));
    const r = makeRes();
    await validatePromoCodeHandler(
      makeReq({ code: "FREEPASS", passType: "single", quantity: 99 }),
      r.res,
    );
    expect(r.status).toBeUndefined();
    const body = r.body as Record<string, unknown>;
    expect(body.valid).toBe(true);
    expect(body.remainingSeats).toBeNull();
  });

  it("rejects requests missing required fields with 400", async () => {
    const r = makeRes();
    await validatePromoCodeHandler(makeReq({ code: "FREEPASS" }), r.res);
    expect(r.status).toBe(400);
  });
});
