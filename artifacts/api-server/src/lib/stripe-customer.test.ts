import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { buildStripeCustomerDisplayName, getOrCreateStripeCustomer } from "./stripe-customer";

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

describe("shared Stripe billing customers", () => {
  const billing = {
    email: "alex@example.com",
    originalEmail: "Alex@Example.COM",
    name: "Alex Smith",
    company: "Example Ltd",
    address: { line1: "1 High Street", country: "GB" },
  };

  function mockStripe() {
    const customers = {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ id: "cus_new" }),
      update: vi.fn().mockResolvedValue({ id: "cus_existing" }),
    };
    return { customers, stripe: { customers } as unknown as Stripe };
  }

  it("reuses a legacy mixed-case email and synchronises company, name and address", async () => {
    const { stripe, customers } = mockStripe();
    customers.list.mockImplementation(async ({ email }) => ({
      data:
        email === billing.originalEmail
          ? [{ id: "cus_existing", name: "Alex Smith", metadata: {} }]
          : [],
    }));
    await getOrCreateStripeCustomer(stripe, billing, 1);
    expect(customers.update).toHaveBeenCalledWith("cus_existing", {
      email: "alex@example.com",
      name: "Example Ltd, Alex Smith",
      metadata: { company: "Example Ltd", billingContactName: "Alex Smith" },
      address: billing.address,
    });
    expect(customers.create).not.toHaveBeenCalled();
  });

  it("does not create a duplicate if both email filters return the same customer", async () => {
    const { stripe, customers } = mockStripe();
    customers.list.mockResolvedValue({
      data: [{ id: "cus_existing", name: "Alex Smith", metadata: {} }],
    });
    await getOrCreateStripeCustomer(stripe, billing, 1);
    expect(customers.update).toHaveBeenCalledOnce();
    expect(customers.create).not.toHaveBeenCalled();
  });

  it("does not overwrite a different company's record with the same email", async () => {
    const { stripe, customers } = mockStripe();
    customers.list.mockResolvedValue({
      data: [
        { id: "cus_other", name: "Other Ltd, Alex Smith", metadata: { company: "Other Ltd" } },
      ],
    });
    await getOrCreateStripeCustomer(stripe, billing, 1);
    expect(customers.update).not.toHaveBeenCalled();
    expect(customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: billing.email, name: "Example Ltd, Alex Smith" }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^swp-customer-1-[a-f0-9]{64}$/),
      }),
    );
  });

  it("does not create replacement customers when Stripe has a temporary update failure", async () => {
    const { stripe, customers } = mockStripe();
    customers.list.mockResolvedValue({
      data: [{ id: "cus_existing", metadata: { company: "Example Ltd" } }],
    });
    customers.update.mockRejectedValue(new Error("temporary connection failure"));
    await expect(getOrCreateStripeCustomer(stripe, billing, 1)).rejects.toThrow(
      "temporary connection failure",
    );
    expect(customers.create).not.toHaveBeenCalled();
  });
});
