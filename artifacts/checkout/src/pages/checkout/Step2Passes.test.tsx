import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BookingWithAttendees,
  DiscountTier,
  PricingBreakdown,
  PricingRequest,
} from "@workspace/api-client-react";
import Step2Passes from "./Step2Passes";

const api = vi.hoisted(() => ({
  calculate: vi.fn(),
  update: vi.fn(),
  validate: vi.fn(),
  tiers: [] as DiscountTier[],
}));
vi.mock("@workspace/api-client-react", () => ({
  calculatePricing: api.calculate,
  customFetch: api.validate,
  useUpdateBooking: () => ({ mutateAsync: api.update, isPending: false }),
  useListDiscountTiers: () => ({ data: api.tiers }),
}));

const defaultTiers = [
  { id: 1, passType: "single", minQuantity: 3, discountPercent: 15 },
  { id: 2, passType: "single", minQuantity: 5, discountPercent: 20 },
  { id: 3, passType: "single", minQuantity: 10, discountPercent: 25 },
  { id: 4, passType: "business", minQuantity: 2, discountPercent: 10 },
  { id: 5, passType: "business", minQuantity: 5, discountPercent: 15 },
  { id: 6, passType: "business", minQuantity: 10, discountPercent: 20 },
] as DiscountTier[];
let inventoryResponse: unknown;
let inventoryOk: boolean;

function quote({
  quantity = 1,
  passType = "single",
  promoCode,
}: Partial<PricingRequest> = {}): PricingBreakdown {
  const price = passType === "business" ? 399 : 189;
  const percent =
    api.tiers
      .filter((tier) => tier.passType === passType && tier.minQuantity <= quantity)
      .sort((a, b) => a.minQuantity - b.minQuantity)
      .at(-1)?.discountPercent ?? 0;
  const basePence = price * 100 * quantity;
  const groupPence = Math.round((basePence * percent) / 100);
  const afterGroup = basePence - groupPence;
  const promoPence =
    promoCode === "VIP" || promoCode === "ZERO100"
      ? afterGroup
      : promoCode
        ? Math.round(afterGroup * 0.2)
        : 0;
  const subtotalPence = afterGroup - promoPence;
  const vatPence = Math.round(subtotalPence * 0.2);
  return {
    passType,
    quantity,
    pricePerHead: price,
    baseSubtotal: basePence / 100,
    groupDiscountPercent: percent,
    groupDiscountAmount: groupPence / 100,
    promoDiscountAmount: promoPence / 100,
    subtotalAfterDiscounts: subtotalPence / 100,
    vatRate: 0.2,
    vatAmount: vatPence / 100,
    total: (subtotalPence + vatPence) / 100,
    savedAmount: (groupPence + promoPence) / 100,
    originalPrice: (passType === "business" ? 999 : 429) * quantity,
    ...(promoCode
      ? { promoDiscountType: promoCode === "VIP" ? "complimentary" : "percentage" }
      : {}),
  } as PricingBreakdown;
}

function renderPasses(overrides: Partial<BookingWithAttendees> = {}) {
  const booking = {
    id: 42,
    status: "partial",
    attendeeType: "hr_professional",
    passType: "single",
    quantity: 1,
    promoCode: null,
    attendees: [{ isLead: true, workEmail: "alex@example.invalid" }],
    ...overrides,
  } as BookingWithAttendees;
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Step2Passes booking={booking} />
    </QueryClientProvider>,
  );
}

async function advance(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function settlePricing() {
  await advance(300);
  await advance();
}

function nextButton() {
  return screen.getByRole("button", { name: "Continue to Attendees" }) as HTMLButtonElement;
}

function summary() {
  return within(screen.getByRole("complementary", { name: "Your booking" }));
}

function groupOffer() {
  return screen.queryByLabelText("Group savings offer");
}

beforeEach(() => {
  vi.useFakeTimers();
  api.tiers = defaultTiers.map((tier) => ({ ...tier }));
  inventoryResponse = { single: null, business: null };
  inventoryOk = true;
  api.calculate.mockReset().mockImplementation(async (request: PricingRequest) => quote(request));
  api.update.mockReset().mockResolvedValue({});
  api.validate.mockReset().mockImplementation(async (_url, options) => ({
    valid: true,
    code: JSON.parse(options.body).code,
  }));
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: url.includes("inventory") ? inventoryOk : true,
      json: async () =>
        url.endsWith("/config")
          ? {
              single: {
                currentPrice: "189",
                originalPrice: "429",
                benefits: [],
                extraBenefits: [],
              },
              business: {
                currentPrice: "399",
                originalPrice: "999",
                benefits: [],
                extraBenefits: [],
              },
            }
          : url.includes("inventory")
            ? inventoryResponse
            : [],
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("checkout pass reliability", () => {
  it.each([
    ["hr_professional", "single", "£578.34", "Add 2 passes"],
    ["consultant_vendor", "business", "£861.84", "Add 1 pass"],
  ])(
    "uses the server total for the %s group offer",
    async (attendeeType, passType, total, action) => {
      renderPasses({ attendeeType, passType } as Partial<BookingWithAttendees>);
      await settlePricing();

      expect(within(groupOffer()!).getByText(total)).toBeTruthy();
      expect(screen.getByRole("button", { name: action })).toBeTruthy();
      expect(summary().getByText("VAT (20%)")).toBeTruthy();
      expect(screen.queryByText(/more passs/)).toBeNull();
    },
  );

  it("keeps optional promo entry collapsed until requested", async () => {
    renderPasses();
    await settlePricing();
    const heading = screen.getByText("Have a promo or VIP code?");
    expect((heading.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(heading);
    expect((heading.closest("details") as HTMLDetailsElement).open).toBe(true);
    const input = screen.getByRole("textbox", { name: "Promo code" });
    fireEvent.change(input, { target: { value: "AUDIT20" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await advance();
    await settlePricing();
    expect(screen.getByText("AUDIT20")).toBeTruthy();
    expect(nextButton().disabled).toBe(false);
  });

  it("clears a previously saved promo explicitly and removes its deep link", async () => {
    window.history.replaceState(null, "", "/?promo=AUDIT20&pass=single");
    renderPasses({ promoCode: "AUDIT20" });
    fireEvent.click(screen.getByRole("button", { name: "Remove promo code" }));
    expect(new URL(window.location.href).searchParams.get("promo")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("pass")).toBe("single");
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await settlePricing();
    expect(nextButton().disabled).toBe(false);
    fireEvent.click(nextButton());
    await advance();
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ promoCode: null, quantity: 2, currentStep: 3 }),
      }),
    );
    expect(api.validate).not.toHaveBeenCalled();
  });

  it("does not allow a stale total after a failed refresh and offers a working retry", async () => {
    renderPasses();
    expect(nextButton().disabled).toBe(true);
    await settlePricing();
    expect(nextButton().disabled).toBe(false);
    api.calculate.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    expect(nextButton().disabled).toBe(true);
    await settlePricing();
    expect(screen.getByRole("button", { name: "Retry total" })).toBeTruthy();
    expect(nextButton().disabled).toBe(true);
    expect(summary().queryByText("£226.80")).toBeNull();
    fireEvent.click(nextButton());
    expect(api.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry total" }));
    await settlePricing();
    expect(nextButton().disabled).toBe(false);
    expect(summary().getByText("£453.60")).toBeTruthy();
  });

  it("keeps the latest quantity total if an older request arrives late", async () => {
    let finishOld!: (value: PricingBreakdown) => void;
    api.calculate.mockImplementationOnce(
      () =>
        new Promise<PricingBreakdown>((resolve) => {
          finishOld = resolve;
        }),
    );
    renderPasses();
    await advance(300);
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await settlePricing();
    expect(nextButton().disabled).toBe(false);
    await act(async () => finishOld(quote()));
    expect(summary().getByText("£453.60")).toBeTruthy();
    expect(summary().queryByText("£226.80")).toBeNull();
  });

  it("preserves the selected quantity when going Back", async () => {
    renderPasses();
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await advance();
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantity: 2, currentStep: 1 }) }),
    );
  });

  it("waits for a linked promo before allowing the customer to continue", async () => {
    window.history.replaceState(null, "", "/?promo=VIP");
    let finish!: (value: { valid: boolean; code: string }) => void;
    api.validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderPasses();
    await settlePricing();
    expect(summary().getByText("£226.80")).toBeTruthy();
    expect(nextButton().disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Save progress and return to the SWP Summit website",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(groupOffer()).toBeNull();
    await act(async () => finish({ valid: true, code: "VIP" }));
    await settlePricing();
    expect(nextButton().disabled).toBe(false);
    fireEvent.click(nextButton());
    await advance();
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ promoCode: "VIP" }) }),
    );
  });

  it("ignores an earlier linked-code check after a newer manual choice", async () => {
    window.history.replaceState(null, "", "/?promo=VIP");
    let finishLink!: (value: { valid: boolean; code: string }) => void;
    api.validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLink = resolve;
        }),
    );
    renderPasses();
    const input = screen.getByRole("textbox", { name: "Promo code" });
    fireEvent.change(input, { target: { value: "AUDIT20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await advance();
    expect(screen.getByText("AUDIT20")).toBeTruthy();
    await act(async () => finishLink({ valid: true, code: "VIP" }));
    expect(screen.queryByText("VIP")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove promo code" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await settlePricing();
    expect(nextButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove promo code" })).toBeNull();
    expect(new URL(window.location.href).searchParams.get("promo")).toBeNull();
  });
});

describe("truthful group savings offer", () => {
  it("quotes the complete next-tier total with stacked public discount and VAT, then adds the offered passes", async () => {
    renderPasses({ quantity: 3, promoCode: "PUBLIC20" });
    await settlePricing();

    const offer = within(groupOffer()!);
    expect(offer.getByText("Add 2 more passes for 20% off all 5")).toBeTruthy();
    expect(offer.getByText("£725.76")).toBeTruthy();
    expect(offer.getByText(/including VAT, with your promo code/)).toBeTruthy();
    expect(api.calculate).toHaveBeenCalledWith(
      { passType: "single", quantity: 5, promoCode: "PUBLIC20" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(summary().getByText("£462.67")).toBeTruthy();
    fireEvent.click(offer.getByRole("button", { name: "Add 2 passes" }));
    expect(nextButton().disabled).toBe(true);
    expect(summary().queryByText("£462.67")).toBeNull();
    await settlePricing();

    expect(summary().getByText("5 × Workforce Pass")).toBeTruthy();
    expect(summary().getByText("£725.76")).toBeTruthy();
    fireEvent.click(nextButton());
    await advance();
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantity: 5, promoCode: "PUBLIC20", currentStep: 3 }),
      }),
    );
  });

  it("uses the returned group percentage when tier configuration and the server quote differ", async () => {
    api.calculate.mockImplementation(async (request: PricingRequest) =>
      request.quantity === 5
        ? {
            ...quote(request),
            groupDiscountPercent: 25,
            groupDiscountAmount: 236.25,
            subtotalAfterDiscounts: 708.75,
            vatAmount: 141.75,
            total: 850.5,
          }
        : quote(request),
    );
    renderPasses({ quantity: 3 });
    await settlePricing();
    expect(within(groupOffer()!).getByText("Add 2 more passes for 25% off all 5")).toBeTruthy();
    expect(within(groupOffer()!).getByText("£850.50")).toBeTruthy();
  });

  it.each(["VIP", "ZERO100"])("does not upsell a zero-value %s booking", async (promoCode) => {
    renderPasses({ quantity: 3, promoCode });
    await settlePricing();
    expect(groupOffer()).toBeNull();
    expect(nextButton().disabled).toBe(false);
    expect(api.calculate.mock.calls.every(([request]) => request.quantity === 3)).toBe(true);
  });

  it("does not upsell a complimentary code whose allowance is too small for the current selection", async () => {
    api.calculate.mockResolvedValue({
      ...quote({ quantity: 3 }),
      promoDiscountType: "complimentary",
      promoRemainingSeats: 2,
    });
    renderPasses({ quantity: 3, promoCode: "VIP" });
    await settlePricing();
    expect(groupOffer()).toBeNull();
    expect(nextButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Reduce to 2 passes/ })).toBeTruthy();
  });

  it.each(["zero", "complimentary", "no higher discount"])(
    "suppresses a next-tier quote with %s benefit",
    async (reason) => {
      api.calculate.mockImplementation(async (request: PricingRequest) =>
        request.quantity === 5
          ? {
              ...quote(request),
              ...(reason === "zero" ? { total: 0 } : {}),
              ...(reason === "complimentary" ? { promoDiscountType: "complimentary" } : {}),
              ...(reason === "no higher discount" ? { groupDiscountPercent: 15 } : {}),
            }
          : quote(request),
      );
      renderPasses({ quantity: 3 });
      await settlePricing();
      expect(groupOffer()).toBeNull();
      expect(nextButton().disabled).toBe(false);
    },
  );

  it.each([
    ["hr_professional", "single", 20, 21],
    ["consultant_vendor", "business", 10, 11],
  ])(
    "does not offer a tier above the %s booking limit",
    async (attendeeType, passType, quantity, nextQuantity) => {
      api.tiers.push({
        id: 99,
        passType,
        minQuantity: nextQuantity,
        discountPercent: 30,
      } as DiscountTier);
      renderPasses({ attendeeType, passType, quantity } as Partial<BookingWithAttendees>);
      await settlePricing();
      expect(groupOffer()).toBeNull();
      expect(api.calculate.mock.calls.every(([request]) => request.quantity === quantity)).toBe(
        true,
      );
      expect(
        (screen.getByRole("button", { name: "Increase pass quantity" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    },
  );

  it("does not invent a further offer after the highest configured tier", async () => {
    renderPasses({ quantity: 10 });
    await settlePricing();
    expect(groupOffer()).toBeNull();
    expect(api.calculate.mock.calls.every(([request]) => request.quantity === 10)).toBe(true);
  });

  it.each([4, 5])(
    "respects availability of %i places for the five-pass tier",
    async (remaining) => {
      inventoryResponse = { single: remaining, business: null };
      renderPasses({ quantity: 3 });
      await settlePricing();
      if (remaining < 5) {
        expect(groupOffer()).toBeNull();
        expect(api.calculate.mock.calls.every(([request]) => request.quantity === 3)).toBe(true);
      } else {
        expect(within(groupOffer()!).getByRole("button", { name: "Add 2 passes" })).toBeTruthy();
      }
      expect(nextButton().disabled).toBe(false);
    },
  );

  it("omits the offer when availability is unavailable without blocking the current booking", async () => {
    inventoryOk = false;
    renderPasses({ quantity: 3 });
    await settlePricing();
    expect(groupOffer()).toBeNull();
    expect(nextButton().disabled).toBe(false);
    expect(api.calculate.mock.calls.every(([request]) => request.quantity === 3)).toBe(true);
  });

  it("does not block the current booking if the optional next-tier quote fails", async () => {
    api.calculate.mockImplementation(async (request: PricingRequest) => {
      if (request.quantity === 5) throw new Error("Optional quote unavailable");
      return quote(request);
    });
    renderPasses({ quantity: 3 });
    await settlePricing();
    expect(groupOffer()).toBeNull();
    expect(nextButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry total" })).toBeNull();
    expect(summary().getByText("£578.34")).toBeTruthy();
  });

  it("ignores a stale optional quote after the selected quantity changes", async () => {
    let finishOld!: (value: PricingBreakdown) => void;
    let offered = 0;
    api.calculate.mockImplementation((request: PricingRequest) => {
      if (request.quantity === 5) {
        offered++;
        if (offered === 1)
          return new Promise<PricingBreakdown>((resolve) => {
            finishOld = resolve;
          });
        return Promise.resolve({
          ...quote(request),
          groupDiscountPercent: 25,
          total: 850.5,
        });
      }
      return Promise.resolve(quote(request));
    });
    renderPasses({ quantity: 3 });
    await settlePricing();
    expect(groupOffer()).toBeNull();
    expect(nextButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await settlePricing();
    expect(within(groupOffer()!).getByText("Add 1 more pass for 25% off all 5")).toBeTruthy();
    await act(async () => finishOld(quote({ quantity: 5 })));
    expect(within(groupOffer()!).getByText("£850.50")).toBeTruthy();
    expect(within(groupOffer()!).queryByText("£907.20")).toBeNull();
  });

  it("does not show the old undiscounted offer after applying a public promo", async () => {
    let finishOld!: (value: PricingBreakdown) => void;
    api.calculate.mockImplementation((request: PricingRequest) =>
      request.quantity === 5 && !request.promoCode
        ? new Promise<PricingBreakdown>((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve(quote(request)),
    );
    renderPasses({ quantity: 3 });
    await settlePricing();
    fireEvent.click(screen.getByText("Have a promo or VIP code?"));
    fireEvent.change(screen.getByRole("textbox", { name: "Promo code" }), {
      target: { value: "PUBLIC20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(groupOffer()).toBeNull();
    await advance();
    await settlePricing();
    expect(within(groupOffer()!).getByText("£725.76")).toBeTruthy();
    await act(async () => finishOld(quote({ quantity: 5 })));
    expect(within(groupOffer()!).getByText("£725.76")).toBeTruthy();
    expect(within(groupOffer()!).queryByText("£907.20")).toBeNull();
  });
});
