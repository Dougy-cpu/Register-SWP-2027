import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  type UseMutationOptions,
} from "@tanstack/react-query";
import type {
  BookingWithAttendees,
  PricingBreakdown,
  PricingRequest,
  UpdateBookingBody,
} from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPaymentDraft } from "@/lib/checkout-payment-draft";
import Step4Payment from "./Step4Payment";

const api = vi.hoisted(() => ({
  updateBooking: vi.fn(),
  updateOptions: vi.fn(),
  calculatePricing: vi.fn(),
  createCheckout: vi.fn(),
  createInvoice: vi.fn(),
  customFetch: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useUpdateBooking: (options: unknown) => {
    api.updateOptions(options);
    return useMutation({ mutationFn: api.updateBooking });
  },
  calculatePricing: (data: PricingRequest, options?: unknown) =>
    api.calculatePricing({ data }, options),
  useCalculatePricing: (options?: {
    mutation?: UseMutationOptions<PricingBreakdown, Error, { data: PricingRequest }>;
  }) => useMutation({ mutationFn: api.calculatePricing, ...options?.mutation }),
  useCreateStripeCheckoutSession: () => useMutation({ mutationFn: api.createCheckout }),
  useCreateStripeInvoice: () => useMutation({ mutationFn: api.createInvoice }),
  customFetch: api.customFetch,
}));

const quote: PricingBreakdown = {
  passType: "single",
  quantity: 1,
  pricePerHead: 189,
  baseSubtotal: 189,
  groupDiscountPercent: 0,
  groupDiscountAmount: 0,
  promoDiscountAmount: 0,
  subtotalAfterDiscounts: 189,
  vatRate: 0.2,
  vatAmount: 37.8,
  total: 226.8,
  originalPrice: 429,
  savedAmount: 240,
};

const invoiceDetails = {
  billingName: "Jamie Accounts",
  billingCompany: "Example Workforce Ltd",
  billingEmail: "accounts@example.test",
  billingPhone: "02079460000",
  billingAddressLine1: "10 Test Street",
  billingAddressLine2: "Second floor",
  billingTown: "London",
  billingRegion: "Greater London",
  billingPostcode: "EC2V 5DE",
  billingCountry: "United Kingdom",
  billingVatNumber: "GB123456789",
  poNumber: "PO-CHECKOUT-42",
};

const labels: Record<keyof typeof invoiceDetails, RegExp> = {
  billingName: /^Billing contact name/,
  billingCompany: /^Company name/,
  billingEmail: /^Invoice email address/,
  billingPhone: /^Contact number/,
  billingAddressLine1: /^Address line 1/,
  billingAddressLine2: /^Address line 2/,
  billingTown: /^Town \/ City/,
  billingRegion: /^Region \/ County/,
  billingPostcode: /^Postcode/,
  billingCountry: /^Country/,
  billingVatNumber: /^VAT number/,
  poNumber: /^PO number/,
};

function booking(overrides: Partial<BookingWithAttendees> = {}): BookingWithAttendees {
  return {
    id: 42,
    sessionToken: "checkout-test-session",
    status: "partial",
    currentStep: 4,
    paymentMethod: "invoice",
    passType: "single",
    attendeeType: "hr_professional",
    quantity: 1,
    promoCode: null,
    totalAmount: quote.total,
    attendees: [
      {
        id: 7,
        isLead: true,
        isTbc: false,
        firstName: "Taylor",
        lastName: "Reed",
        workEmail: "taylor@example.test",
        company: "Example Ltd",
        phone: "02079460001",
      },
    ],
    ...overrides,
  } as BookingWithAttendees;
}

let serverBooking: BookingWithAttendees;
const clients: QueryClient[] = [];

function PaymentJourney() {
  const { data: currentBooking } = useQuery({
    queryKey: ["booking", "checkout-test-session"],
    queryFn: async () => serverBooking,
    staleTime: Infinity,
  });
  if (!currentBooking) return null;
  return currentBooking.currentStep === 3 ? (
    <>
      <h1>Attendee details</h1>
      <button
        onClick={() => {
          serverBooking = { ...serverBooking, currentStep: 4 };
          clients.at(-1)!.setQueryData(["booking", "checkout-test-session"], serverBooking);
        }}
      >
        Continue to payment
      </button>
    </>
  ) : (
    <Step4Payment key={currentBooking.id} booking={currentBooking} />
  );
}

function renderPayment(initial = booking()) {
  serverBooking = initial;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(["booking", "checkout-test-session"], initial);
  const rendered = render(
    <QueryClientProvider client={client}>
      <PaymentJourney />
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

function enterBillingDetails() {
  for (const field of Object.keys(invoiceDetails) as Array<keyof typeof invoiceDetails>) {
    fireEvent.change(screen.getByRole("textbox", { name: labels[field] }), {
      target: { value: invoiceDetails[field] },
    });
  }
}

async function advance(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function expectNoPaymentOrDelivery() {
  expect(api.createCheckout).not.toHaveBeenCalled();
  expect(api.createInvoice).not.toHaveBeenCalled();
  expect(api.customFetch).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === "/api/event-settings/public")).toBe(
    true,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.calculatePricing.mockReset().mockResolvedValue(quote);
  api.updateBooking
    .mockReset()
    .mockImplementation(async ({ id, data }: { id: number; data: UpdateBookingBody }) => {
      expect(id).toBe(serverBooking.id);
      serverBooking = { ...serverBooking, ...data } as BookingWithAttendees;
      return serverBooking;
    });
  api.createCheckout.mockReset().mockResolvedValue({ url: null });
  api.createInvoice.mockReset().mockResolvedValue({ success: true });
  api.customFetch.mockReset().mockResolvedValue(null);
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("booking_session", "checkout-test-session");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      if (url !== "/api/event-settings/public")
        throw new Error(`Unexpected request: ${String(url)}`);
      return new Response(JSON.stringify({ invoiceHelpContent: "" }), { status: 200 });
    }),
  );
});

afterEach(async () => {
  cleanup();
  await advance();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("invoice payment drafts", () => {
  it("validates the current invoice form and focuses its first missing field from the summary action", async () => {
    renderPayment();
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Confirm booking & email invoice" }));
    await advance();

    expect(screen.getByText("Address line 1 is required")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /^Address line 1/ }));
    expect(api.updateBooking).not.toHaveBeenCalled();
    expectNoPaymentOrDelivery();
  });

  it("shows the edited invoice recipient immediately and keeps the lead details reusable", async () => {
    renderPayment();
    await advance();
    const email = screen.getByRole("textbox", { name: /^Invoice email address/ });
    fireEvent.change(email, { target: { value: "finance@example.test" } });

    expect(
      screen.getByText(/This confirms your place and emails the invoice to/).textContent,
    ).toContain("finance@example.test");
    expect(
      screen.getByText(/This confirms your place and emails the invoice to/).textContent,
    ).not.toContain("taylor@example.test");
    fireEvent.click(screen.getByTestId("relink-billingEmail"));
    expect((email as HTMLInputElement).value).toBe("taylor@example.test");
    expect(screen.getByTestId("linked-billingEmail")).toBeTruthy();
    expect(
      screen.getByText(/This confirms your place and emails the invoice to/).textContent,
    ).toContain("taylor@example.test");
    expectNoPaymentOrDelivery();
  });

  it("keeps admin invoice guidance collapsed and shows the complete payment deadline", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          invoiceHelpContent: "Supplier onboarding\nContact the event team for your supplier form.",
        }),
        { status: 200 },
      ),
    );
    renderPayment();
    await advance();

    const help = screen.getByRole("button", { name: "How invoice payment works" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Supplier onboarding")).toBeNull();
    expect(
      screen.getByText("Payment due within 14 days, or before the event if sooner."),
    ).toBeTruthy();
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Supplier onboarding")).toBeTruthy();
    expect(screen.getByText("Contact the event team for your supplier form.")).toBeTruthy();
    expectNoPaymentOrDelivery();
  });

  it("retains a saved non-UK billing country without converting it to a default", async () => {
    renderPayment(booking({ ...invoiceDetails, billingCountry: "New Zealand" }));
    await advance();

    expect((screen.getByRole("textbox", { name: /^Country/ }) as HTMLInputElement).value).toBe(
      "New Zealand",
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^PO number/ }), {
      target: { value: "NZ-PO-42" },
    });
    await advance(600);
    expect(serverBooking.billingCountry).toBe("New Zealand");
    expectNoPaymentOrDelivery();
  });

  it("restores the saved invoice choice and exposes named payment radios", async () => {
    renderPayment(booking({ paymentMethod: "invoice", ...invoiceDetails }));
    await advance();

    expect(screen.getByRole("radiogroup", { name: "Payment method" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Pay by invoice" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Pay by card" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      (screen.getByRole("textbox", { name: /^Address line 1/ }) as HTMLInputElement).value,
    ).toBe(invoiceDetails.billingAddressLine1);
    expect(api.updateOptions).toHaveBeenCalledWith({
      request: { headers: { "x-admin-token": "" } },
    });
    expectNoPaymentOrDelivery();
  });

  it("persists the complete visible invoice draft before Back and restores it when returning", async () => {
    renderPayment();
    await advance();
    enterBillingDetails();
    // Back is deliberately clicked before the 600ms autosave debounce.
    fireEvent.click(screen.getByRole("button", { name: "Back to attendees" }));
    await advance();

    expect(api.updateBooking.mock.calls[0][0]).toEqual({
      id: 42,
      data: { paymentMethod: "invoice", ...invoiceDetails },
    });
    expect(api.updateBooking.mock.calls[1][0]).toEqual({ id: 42, data: { currentStep: 3 } });
    expect(screen.getByRole("heading", { name: "Attendee details" })).toBeTruthy();
    expect(readPaymentDraft(42)).toBeNull();
    expectNoPaymentOrDelivery();

    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await advance();
    expect(screen.getByRole("radio", { name: "Pay by invoice" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    for (const field of Object.keys(invoiceDetails) as Array<keyof typeof invoiceDetails>) {
      expect((screen.getByRole("textbox", { name: labels[field] }) as HTMLInputElement).value).toBe(
        invoiceDetails[field],
      );
    }
    expectNoPaymentOrDelivery();
  });

  it("automatically saves a changed payment choice and billing details without creating an invoice", async () => {
    renderPayment(booking({ paymentMethod: "card" }));
    await advance();
    fireEvent.click(screen.getByRole("radio", { name: "Pay by invoice" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Address line 1/ }), {
      target: { value: "Saved automatically" },
    });
    expect(screen.getByRole("status").textContent).toBe("Saving billing details…");
    await advance(600);

    expect(api.updateBooking.mock.calls[0][0]).toEqual({
      id: 42,
      data: expect.objectContaining({
        paymentMethod: "invoice",
        billingAddressLine1: "Saved automatically",
      }),
    });
    expect(screen.getByRole("status").textContent).toBe("Billing details saved");
    expectNoPaymentOrDelivery();
  });

  it("keeps successful autosaves in the booking query for a browser-Back remount before any refetch", async () => {
    const initial = booking({ paymentMethod: "invoice", billingAddressLine1: "Old address" });
    const { client, unmount } = renderPayment(initial);
    const anotherBooking = booking({ id: 99, sessionToken: "another-session", poNumber: "KEEP" });
    client.setQueryData(["booking", "another-session"], anotherBooking);
    await advance();
    enterBillingDetails();
    await advance(600);

    const cached = client.getQueryData<BookingWithAttendees>(["booking", "checkout-test-session"]);
    expect(cached).toMatchObject({
      paymentMethod: "invoice",
      ...invoiceDetails,
      currentStep: 4,
      status: "partial",
      attendees: initial.attendees,
    });
    expect(client.getQueryData(["booking", "another-session"])).toEqual(anotherBooking);
    expect(readPaymentDraft(42)).toBeNull();
    expect(api.updateBooking).toHaveBeenCalledTimes(1);

    // Browser Back unmounts payment locally without fetching the booking. Returning
    // can mount payment immediately from this cache, ahead of a fresh response.
    unmount();
    render(
      <QueryClientProvider client={client}>
        <Step4Payment
          booking={client.getQueryData<BookingWithAttendees>(["booking", "checkout-test-session"])!}
        />
      </QueryClientProvider>,
    );
    await advance();

    for (const field of Object.keys(invoiceDetails) as Array<keyof typeof invoiceDetails>) {
      expect((screen.getByRole("textbox", { name: labels[field] }) as HTMLInputElement).value).toBe(
        invoiceDetails[field],
      );
    }
    expect(api.updateBooking).toHaveBeenCalledTimes(1);
    expectNoPaymentOrDelivery();
  });

  it("shows a failed save, keeps the draft and supports an explicit successful retry", async () => {
    api.updateBooking.mockRejectedValueOnce(new Error("Offline"));
    renderPayment();
    await advance();
    fireEvent.change(screen.getByRole("textbox", { name: /^Town \/ City/ }), {
      target: { value: "Manchester" },
    });
    await advance(600);

    expect(
      screen.getByText("We couldn't save your billing details. Keep this page open and retry."),
    ).toBeTruthy();
    expect(readPaymentDraft(42)?.billing.billingTown).toBe("Manchester");
    fireEvent.click(screen.getByRole("button", { name: "Retry saving details" }));
    await advance();

    expect(api.updateBooking).toHaveBeenCalledTimes(2);
    expect(serverBooking.billingTown).toBe("Manchester");
    expect(screen.getByRole("status").textContent).toBe("Billing details saved");
    expect(readPaymentDraft(42)).toBeNull();
    expectNoPaymentOrDelivery();
  });

  it("stays on payment when saving before Back fails and returns only after a successful retry", async () => {
    api.updateBooking.mockRejectedValueOnce(new Error("Connection interrupted"));
    renderPayment();
    await advance();
    fireEvent.change(screen.getByRole("textbox", { name: /^Postcode/ }), {
      target: { value: "M1 1AA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to attendees" }));
    await advance();

    expect(screen.getByRole("heading", { name: "Complete your booking" })).toBeTruthy();
    expect(screen.getByText("Connection interrupted")).toBeTruthy();
    expect(api.updateBooking.mock.calls.some(([request]) => request.data.currentStep === 3)).toBe(
      false,
    );
    expect(readPaymentDraft(42)?.billing.billingPostcode).toBe("M1 1AA");

    fireEvent.click(screen.getByRole("button", { name: "Back to attendees" }));
    await advance();
    expect(screen.getByRole("heading", { name: "Attendee details" })).toBeTruthy();
    expect(serverBooking.billingPostcode).toBe("M1 1AA");
    expectNoPaymentOrDelivery();
  });
});

describe("payment quote safeguards", () => {
  it("shows the supplied group and promo savings, discounted subtotal and VAT in one summary", async () => {
    api.calculatePricing.mockResolvedValue({
      ...quote,
      quantity: 3,
      baseSubtotal: 567,
      groupDiscountPercent: 15,
      groupDiscountAmount: 85.05,
      promoDiscountAmount: 96.39,
      subtotalAfterDiscounts: 385.56,
      vatAmount: 77.11,
      total: 462.67,
    });
    renderPayment(booking({ quantity: 3, promoCode: "EXAMPLE20" }));
    await advance();

    const summary = within(screen.getByRole("complementary", { name: "Your booking" }));
    expect(summary.getByText("3 × Workforce Pass").parentElement?.textContent).toContain("£567.00");
    expect(summary.getByText("Group saving (15%)").parentElement?.textContent).toContain("−£85.05");
    expect(summary.getByText("Promo code (EXAMPLE20)").parentElement?.textContent).toContain(
      "−£96.39",
    );
    expect(summary.getByText("Subtotal").parentElement?.textContent).toContain("£385.56");
    expect(summary.getByText("VAT (20%)").parentElement?.textContent).toContain("£77.11");
    expect(summary.getByText("Total including VAT").parentElement?.textContent).toContain(
      "£462.67",
    );
    expectNoPaymentOrDelivery();
  });

  it("offers a retry for a stalled quote and ignores its late response after recovery", async () => {
    let resolveLate!: (value: PricingBreakdown) => void;
    api.calculatePricing.mockImplementationOnce(
      () =>
        new Promise<PricingBreakdown>((resolve) => {
          resolveLate = resolve;
        }),
    );
    renderPayment(booking({ paymentMethod: "card" }));
    await advance();
    await advance(9999);
    const label = "Continue to secure payment";
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry total" })).toBeNull();
    await advance(1);
    expect((api.calculatePricing.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    // React Query delivers the rejected mutation to observers on the next tick.
    await advance(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry total" }));
    await advance();
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolveLate({ ...quote, total: 0 }));
    await advance();

    expect(screen.getByRole("heading", { name: "Complete your booking" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Confirm Registration" })).toBeNull();
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
    expectNoPaymentOrDelivery();
  });

  it.each(["card", "invoice"] as const)(
    "blocks %s submission after a failed quote and offers a retry",
    async (paymentMethod) => {
      api.calculatePricing.mockRejectedValueOnce(new Error("Pricing unavailable"));
      renderPayment(booking({ paymentMethod, ...invoiceDetails }));
      await advance();
      const label =
        paymentMethod === "card" ? "Continue to secure payment" : "Confirm booking & email invoice";
      const submit = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.click(submit);
      expect(api.updateBooking).not.toHaveBeenCalled();
      expectNoPaymentOrDelivery();

      fireEvent.click(screen.getByRole("button", { name: "Retry total" }));
      await advance();
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expectNoPaymentOrDelivery();
    },
  );

  it("blocks payment while a changed booking is waiting for its own quote", async () => {
    const { client } = renderPayment(booking({ paymentMethod: "card" }));
    await advance();
    const label = "Continue to secure payment";
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
    let resolveQuote: ((value: PricingBreakdown) => void) | undefined;
    api.calculatePricing.mockImplementationOnce(
      () =>
        new Promise<PricingBreakdown>((resolve) => {
          resolveQuote = resolve;
        }),
    );
    act(() => {
      serverBooking = { ...serverBooking, quantity: 2 };
      client.setQueryData(["booking", "checkout-test-session"], serverBooking);
    });
    await advance();

    const submit = screen.getByRole("button", { name: label }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expectNoPaymentOrDelivery();
    await act(async () =>
      resolveQuote?.({ ...quote, quantity: 2, baseSubtotal: 378, total: 453.6 }),
    );
    await advance();
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("locks invoice fields and payment choice while an explicit submission is in progress", async () => {
    api.createInvoice.mockImplementation(() => new Promise(() => {}));
    renderPayment(booking({ paymentMethod: "invoice", ...invoiceDetails }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Confirm booking & email invoice" }));
    await advance();

    expect(api.createInvoice).toHaveBeenCalledTimes(1);
    const address = screen.getByRole("textbox", { name: /^Address line 1/ });
    expect(address.closest("fieldset")?.disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Pay by card" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(api.createCheckout).not.toHaveBeenCalled();
  });
});

describe("complimentary booking navigation", () => {
  it("shows a failed Back save and lets the user retry without confirming registration", async () => {
    api.calculatePricing.mockResolvedValue({ ...quote, total: 0 });
    api.updateBooking.mockRejectedValueOnce(new Error("Offline"));
    renderPayment(booking({ paymentMethod: "card" }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await advance();

    expect(screen.getByRole("heading", { name: "Confirm Registration" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "We couldn't save your progress. Please try again.",
    );
    expectNoPaymentOrDelivery();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await advance();
    expect(screen.getByRole("heading", { name: "Attendee details" })).toBeTruthy();
    expectNoPaymentOrDelivery();
  });

  it("locks Back and Save while complimentary confirmation is pending", async () => {
    api.calculatePricing.mockResolvedValue({ ...quote, total: 0 });
    api.customFetch.mockImplementationOnce(() => new Promise(() => {}));
    renderPayment(booking({ paymentMethod: "card" }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Registration" }));
    await advance();

    expect(api.customFetch).toHaveBeenCalledWith("/api/bookings/42/confirm-free", {
      method: "POST",
    });
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Confirming…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Save progress and return to the SWP Summit website",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(back);
    expect(api.updateBooking).not.toHaveBeenCalled();
    expect(api.createCheckout).not.toHaveBeenCalled();
    expect(api.createInvoice).not.toHaveBeenCalled();
  });
});
