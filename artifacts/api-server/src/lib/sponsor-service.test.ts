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
  validateSponsorSessionEntitlements,
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

describe("sponsor session entitlements", () => {
  it("preserves repeated and mixed session types in their entered order", () => {
    expect(
      validateSponsorSessionEntitlements([
        { type: "quickfire", entitlementLabel: " Morning Quickfire " },
        {
          type: "quickfire",
          entitlementLabel: "Afternoon Quickfire",
          slidesRequired: true,
        },
        {
          type: "keynote",
          entitlementLabel: "Main-stage speaking slot",
          headshotRequired: false,
        },
        { type: "other", entitlementLabel: "Panel discussion" },
      ]),
    ).toEqual([
      {
        type: "quickfire",
        entitlementLabel: "Morning Quickfire",
        headshotRequired: true,
        takeawaysRequired: true,
        slidesRequired: false,
      },
      {
        type: "quickfire",
        entitlementLabel: "Afternoon Quickfire",
        headshotRequired: true,
        takeawaysRequired: true,
        slidesRequired: true,
      },
      {
        type: "keynote",
        entitlementLabel: "Main-stage speaking slot",
        headshotRequired: false,
        takeawaysRequired: true,
        slidesRequired: false,
      },
      {
        type: "other",
        entitlementLabel: "Panel discussion",
        headshotRequired: true,
        takeawaysRequired: true,
        slidesRequired: false,
      },
    ]);
  });

  it("rejects an invalid row before sponsor creation can enter its transaction", () => {
    expect(() =>
      validateSponsorSessionEntitlements([
        { type: "quickfire", entitlementLabel: "Valid Quickfire" },
        { type: "other", entitlementLabel: "  " },
      ]),
    ).toThrow("Enter an entitlement label for session 2");
    expect(() =>
      validateSponsorSessionEntitlements([
        { type: "speaking-slot", entitlementLabel: "Unsupported type" },
      ]),
    ).toThrow("Choose a valid type for session 1");
    expect(() =>
      validateSponsorSessionEntitlements([{ type: "keynote", entitlementLabel: "x".repeat(251) }]),
    ).toThrow("Keep the entitlement label for session 1 to 250 characters or fewer");
  });

  it("rejects malformed boolean settings instead of silently coercing them", () => {
    expect(() =>
      validateSponsorSessionEntitlements([
        {
          type: "quickfire",
          entitlementLabel: "Quickfire",
          slidesRequired: "yes",
        },
      ]),
    ).toThrow("Session 1 has an invalid slidesRequired setting");
  });
});
