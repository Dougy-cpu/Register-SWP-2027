import { describe, expect, it } from "vitest";
import {
  createSponsorSessionEntitlement,
  removeSponsorSessionEntitlement,
  sponsorSessionEntitlementError,
  sponsorSessionPayload,
  sponsorSessionTaskRequirements,
  updateSponsorSessionEntitlement,
  type SponsorSessionEntitlementDraft,
} from "./sponsor-session-entitlements";

function entitlement(
  clientId: string,
  patch: Partial<SponsorSessionEntitlementDraft> = {},
): SponsorSessionEntitlementDraft {
  return { ...createSponsorSessionEntitlement(clientId), ...patch };
}

describe("sponsor creation session entitlements", () => {
  it("keeps repeated and mixed session types as separate ordered entries", () => {
    const sessions = [
      entitlement("one", { entitlementLabel: "Morning Quickfire" }),
      entitlement("two", { entitlementLabel: "Afternoon Quickfire", slidesRequired: true }),
      entitlement("three", {
        type: "keynote",
        entitlementLabel: "Main-stage speaking slot",
        headshotRequired: false,
      }),
      entitlement("four", { type: "other", entitlementLabel: "Panel discussion" }),
    ];

    expect(sponsorSessionPayload(sessions)).toEqual([
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

  it("edits and removes one row without changing adjacent entitlements", () => {
    const original = [
      entitlement("one", { entitlementLabel: "Quickfire one" }),
      entitlement("two", { entitlementLabel: "Quickfire two" }),
      entitlement("three", { type: "keynote", entitlementLabel: "Keynote" }),
    ];

    const edited = updateSponsorSessionEntitlement(original, "two", {
      type: "other",
      entitlementLabel: "Panel slot",
    });
    const removed = removeSponsorSessionEntitlement(edited, "one");

    expect(
      removed.map(({ clientId, type, entitlementLabel }) => ({
        clientId,
        type,
        entitlementLabel,
      })),
    ).toEqual([
      { clientId: "two", type: "other", entitlementLabel: "Panel slot" },
      { clientId: "three", type: "keynote", entitlementLabel: "Keynote" },
    ]);
    expect(original[1]?.entitlementLabel).toBe("Quickfire two");
  });

  it("validates every row and derives checklist requirements across all sessions", () => {
    const sessions = [
      entitlement("one", { entitlementLabel: "Quickfire" }),
      entitlement("two", { type: "keynote", entitlementLabel: "  ", slidesRequired: true }),
    ];

    expect(sponsorSessionEntitlementError(sessions)).toBe(
      "Enter an entitlement label for session 2.",
    );
    expect(
      sponsorSessionEntitlementError([entitlement("one", { entitlementLabel: "x".repeat(251) })]),
    ).toBe("Keep the entitlement label for session 1 to 250 characters or fewer.");
    expect(sponsorSessionTaskRequirements(sessions)).toEqual({
      sessionsRequired: true,
      slidesRequired: true,
    });
    expect(sponsorSessionTaskRequirements([])).toEqual({
      sessionsRequired: false,
      slidesRequired: false,
    });
  });
});
