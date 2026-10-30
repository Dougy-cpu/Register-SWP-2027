import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BookingWithAttendees, PricingBreakdown } from "@workspace/api-client-react";
import Step2Passes from "./Step2Passes";

const api = vi.hoisted(() => ({ calculate: vi.fn(), update: vi.fn(), validate: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  calculatePricing: api.calculate,
  customFetch: api.validate,
  useUpdateBooking: () => ({ mutateAsync: api.update, isPending: false }),
  useListDiscountTiers: () => ({
    data: [
      { id: 1, passType: "single", minQuantity: 3, discountPercent: 15 },
      { id: 2, passType: "business", minQuantity: 2, discountPercent: 10 },
    ],
  }),
}));

function quote(quantity = 1, price = 189): PricingBreakdown {
  return {
    passType: "single",
    quantity,
    pricePerHead: price,
    baseSubtotal: price * quantity,
    groupDiscountPercent: 0,
    groupDiscountAmount: 0,
    promoDiscountAmount: 0,
    subtotalAfterDiscounts: price * quantity,
    vatRate: 20,
    vatAmount: price * quantity * 0.2,
    total: price * quantity * 1.2,
    savedAmount: 0,
    originalPrice: 429 * quantity,
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

beforeEach(() => {
  api.calculate
    .mockReset()
    .mockImplementation(async ({ quantity, passType }) =>
      quote(quantity, passType === "business" ? 399 : 189),
    );
  api.update.mockReset().mockResolvedValue({});
  api.validate.mockReset().mockResolvedValue({ valid: true, code: "AUDIT20" });
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
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
            ? { single: null, business: null }
            : [],
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("checkout pass reliability", () => {
  it.each([
    ["hr_professional", "single", "£85.05"],
    ["consultant_vendor", "business", "£79.80"],
  ])("uses the current price for %s group savings", async (attendeeType, passType, saving) => {
    renderPasses({ attendeeType, passType } as Partial<BookingWithAttendees>);
    await waitFor(() => expect(screen.getByText(saving)).toBeTruthy());
    expect(screen.queryByText("£112.05")).toBeNull();
    expect(screen.queryByText(/more passs/)).toBeNull();
  });

  it("clears a previously saved promo explicitly and removes its deep link", async () => {
    window.history.replaceState(null, "", "/?promo=AUDIT20&pass=single");
    renderPasses({ promoCode: "AUDIT20" });
    fireEvent.click(screen.getByRole("button", { name: "Remove promo code" }));
    expect(new URL(window.location.href).searchParams.get("promo")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("pass")).toBe("single");
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Continue to Attendees" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue to Attendees" }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ promoCode: null, quantity: 2, currentStep: 3 }),
        }),
      ),
    );
    expect(api.validate).not.toHaveBeenCalled();
  });

  it("does not allow a stale total after a failed refresh and offers a working retry", async () => {
    renderPasses();
    const next = screen.getByRole("button", { name: "Continue to Attendees" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await waitFor(() => expect(next.disabled).toBe(false));
    api.calculate.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    expect(next.disabled).toBe(true);
    await screen.findByRole("button", { name: "Retry total" });
    expect(next.disabled).toBe(true);
    expect(screen.queryByText("£226.80")).toBeNull();
    fireEvent.click(next);
    expect(api.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry total" }));
    await waitFor(() => expect(next.disabled).toBe(false));
    expect(screen.getAllByText("£453.60").length).toBeGreaterThan(0);
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
    await waitFor(() => expect(api.calculate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Continue to Attendees" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    finishOld(quote(1));
    await waitFor(() => expect(screen.getAllByText("£453.60").length).toBeGreaterThan(0));
    expect(screen.queryByText("£226.80")).toBeNull();
  });

  it("preserves the selected quantity when going Back", async () => {
    renderPasses();
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ quantity: 2, currentStep: 1 }) }),
      ),
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
    await screen.findAllByText("£226.80");
    const next = screen.getByRole("button", { name: "Continue to Attendees" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Save progress and return to the SWP Summit website",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => finish({ valid: true, code: "VIP" }));
    await waitFor(() => expect(next.disabled).toBe(false));
    fireEvent.click(next);
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ promoCode: "VIP" }) }),
      ),
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
    await screen.findByText("AUDIT20");
    await act(async () => finishLink({ valid: true, code: "VIP" }));
    expect(screen.queryByText("VIP")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove promo code" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase pass quantity" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Continue to Attendees" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole("button", { name: "Remove promo code" })).toBeNull();
    expect(new URL(window.location.href).searchParams.get("promo")).toBeNull();
  });
});
