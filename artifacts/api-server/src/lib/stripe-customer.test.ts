import { describe, expect, it } from "vitest";
import { buildStripeCustomerDisplayName } from "./stripe-customer";

describe("buildStripeCustomerDisplayName", () => {
  it("puts the company first so it appears on Stripe invoices", () => {
    expect(buildStripeCustomerDisplayName("Jane Smith", "Acme Ltd")).toBe("Acme Ltd, Jane Smith");
  });

  it("falls back to the billing contact name when no company is available", () => {
    expect(buildStripeCustomerDisplayName("Jane Smith", null)).toBe("Jane Smith");
  });

  it("does not duplicate the company when the contact name already matches", () => {
    expect(buildStripeCustomerDisplayName("Acme Ltd", " acme ltd ")).toBe("acme ltd");
  });
});
