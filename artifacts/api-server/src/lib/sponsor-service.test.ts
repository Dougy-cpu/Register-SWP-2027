import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => {
  const expression = (...args: unknown[]) => ({ args });
  return {
    and: expression,
    asc: expression,
    desc: expression,
    eq: expression,
    inArray: expression,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  };
});

vi.mock("@workspace/db", () => {
  const column = {};
  const table = new Proxy({}, { get: () => column });
  return {
    db: {},
    attendeesTable: table,
    bookingsTable: table,
    emailLogsTable: table,
    promoCodesTable: table,
    sponsorActivityTable: table,
    sponsorAssetsTable: table,
    sponsorContactsTable: table,
    sponsorDocumentAcknowledgementsTable: table,
    sponsorDocumentsTable: table,
    sponsorPresentersTable: table,
    sponsorPromoCodesTable: table,
    sponsorRedemptionsTable: table,
    sponsorSessionRevisionsTable: table,
    sponsorSessionsTable: table,
    sponsorsTable: table,
    sponsorTasksTable: table,
  };
});

vi.mock("./sponsor-assets", () => ({ formatSponsorAsset: (asset: unknown) => asset }));
vi.mock("../middleware/sponsor-auth", () => ({ issueSponsorAccessToken: () => "signed-token" }));

import {
  assertCodeAvailability,
  normalizeSponsorCode,
  SponsorConflictError,
  suggestedSponsorCodes,
} from "./sponsor-service";

function transactionWithCollisions(rows: Array<{ code: string; sponsorId: number | null }>) {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: async () => rows }),
      }),
    }),
  } as never;
}

describe("sponsor promo codes", () => {
  it("normalises company codes without silently adding suffixes", () => {
    expect(normalizeSponsorCode("  Acme & Co. ")).toBe("ACMECO");
    expect(suggestedSponsorCodes("Acme & Co.")).toEqual({
      vip: "ACMECOVIP",
      public: "ACMECO",
    });
  });

  it("rejects a collision belonging to a different sponsor", async () => {
    const tx = transactionWithCollisions([{ code: "ACME", sponsorId: 92 }]);
    await expect(assertCodeAvailability(tx, ["ACME"], 12)).rejects.toEqual(
      expect.objectContaining<SponsorConflictError>({
        name: "SponsorConflictError",
        message: "Promo code already exists: ACME. Choose a different code.",
      }),
    );
  });

  it("allows a confirmed sponsor to retain its own codes", async () => {
    const tx = transactionWithCollisions([
      { code: "ACME", sponsorId: 12 },
      { code: "ACMEVIP", sponsorId: 12 },
    ]);
    await expect(assertCodeAvailability(tx, ["ACME", "ACMEVIP"], 12)).resolves.toBeUndefined();
  });
});
