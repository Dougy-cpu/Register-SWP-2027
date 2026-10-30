import type { HTMLAttributes, ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { BookingWithAttendees } from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckoutFlow from "./index";

const api = vi.hoisted(() => ({
  loadBooking: vi.fn(),
  readBooking: vi.fn(),
  confirmPayment: vi.fn(),
  reducedMotion: false,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetBookingBySession: (
    _token: string,
    options: { query: { queryKey: string[]; enabled: boolean } },
  ) =>
    useQuery<BookingWithAttendees>({
      ...options.query,
      queryFn: api.loadBooking,
      staleTime: Infinity,
      retry: false,
    }),
  getBookingBySession: api.readBooking,
  customFetch: api.confirmPayment,
}));

vi.mock("framer-motion", async () => {
  const { forwardRef } = await import("react");
  type MotionProps = HTMLAttributes<HTMLDivElement> & {
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
  };
  return {
    useReducedMotion: () => api.reducedMotion,
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: {
      div: forwardRef<HTMLDivElement, MotionProps>(function MotionDiv(
        { children, initial, animate: _animate, exit, transition, ...props },
        ref,
      ) {
        return (
          <div
            {...props}
            ref={ref}
            data-motion-initial={JSON.stringify(initial)}
            data-motion-exit={JSON.stringify(exit)}
            data-motion-transition={JSON.stringify(transition)}
          >
            {children}
          </div>
        );
      }),
    },
  };
});

vi.mock("./Step1Lead", () => ({
  default: ({ onAdvance }: { onAdvance: (step: number) => void }) => (
    <>
      <h1>Your details</h1>
      <button onClick={() => onAdvance(2)}>Continue to passes</button>
    </>
  ),
}));
vi.mock("./Step2Passes", () => ({
  default: ({ onAdvance }: { onAdvance: (step: number) => void }) => (
    <>
      <h1>Select your pass</h1>
      <button onClick={() => onAdvance(3)}>Continue to attendees</button>
    </>
  ),
}));
vi.mock("./Step3Attendees", () => ({ default: () => <h1>Attendee details</h1> }));
vi.mock("./Step4Payment", () => ({ default: () => <h1>Final checkout</h1> }));
vi.mock("./Confirmation", () => ({ default: () => <h1>You are registered!</h1> }));

const sessionToken = "test-booking-session";
const pendingBooking = {
  id: 42,
  sessionToken,
  status: "pending_payment",
  currentStep: 4,
  orderReference: "SWP27-0042",
  attendees: [],
} as unknown as BookingWithAttendees;
const clients: QueryClient[] = [];

function renderFlow(
  booking: BookingWithAttendees | null = pendingBooking,
  stripeReturn = true,
  preserveHistory = false,
) {
  if (!preserveHistory) {
    window.history.replaceState(
      null,
      "",
      stripeReturn ? "/?session_id=cs_test_return&step=5" : "/",
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  if (booking) client.setQueryData(["booking", sessionToken], booking);
  render(
    <QueryClientProvider client={client}>
      <CheckoutFlow />
    </QueryClientProvider>,
  );
  return client;
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.reducedMotion = false;
  api.loadBooking.mockReset().mockResolvedValue(pendingBooking);
  api.readBooking.mockReset().mockResolvedValue(pendingBooking);
  api.confirmPayment.mockReset().mockResolvedValue({ success: true });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("booking_session", sessionToken);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Live requests forbidden"))),
  );
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("delayed payment confirmation", () => {
  it("offers recovery even when the booking itself cannot load", async () => {
    api.loadBooking.mockRejectedValue(new Error("Offline"));
    api.readBooking.mockRejectedValue(new Error("Offline"));
    renderFlow(null);
    await advanceTime(60_000);

    expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
    expect(screen.getByText(/include the email address used for your booking/)).toBeTruthy();
    expect(api.confirmPayment).not.toHaveBeenCalled();
  });

  it("ends failed checks with truthful wording, a retry and an existing support route", async () => {
    api.confirmPayment.mockRejectedValue(new Error("Connection interrupted"));
    api.readBooking.mockRejectedValue(new Error("Connection interrupted"));
    renderFlow();
    await advanceTime(60_000);

    expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
    expect(screen.getByText(/We have not been able to confirm the result yet/)).toBeTruthy();
    expect(screen.queryByText(/will be confirmed shortly/)).toBeNull();
    expect(screen.getByText("Reference: SWP27-0042")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Contact the event team" }).getAttribute("href")).toBe(
      "mailto:douglas@peoplestrategyhub.com?subject=SWP%20Summit%202027%20payment%20query%20-%20SWP27-0042",
    );
    expect(api.confirmPayment).toHaveBeenCalledTimes(1);
    expect(api.confirmPayment).toHaveBeenCalledWith(
      "/api/stripe/confirm-card-payment",
      expect.objectContaining({
        method: "POST",
        headers: { "x-booking-session": sessionToken },
        body: JSON.stringify({ bookingId: 42, sessionId: "cs_test_return" }),
      }),
    );
  });

  it("rechecks the existing payment once and opens confirmation when it is paid", async () => {
    renderFlow();
    await advanceTime(60_000);
    api.readBooking.mockResolvedValue({ ...pendingBooking, status: "paid" });

    const retry = screen.getByRole("button", { name: "Check payment status" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await advanceTime(0);

    // The saved step deliberately remains 4: confirmed payment takes priority.
    expect(screen.getByRole("heading", { name: "You are registered!" })).toBeTruthy();
    expect(api.confirmPayment).toHaveBeenCalledTimes(2);
    expect(
      api.confirmPayment.mock.calls.every(([url]) => url === "/api/stripe/confirm-card-payment"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
  });

  it.each(["confirmation", "status"] as const)(
    "aborts a stalled %s request before a bounded retry, without overlapping requests",
    async (request) => {
      let outstanding = 0;
      let maximumOutstanding = 0;
      const signals: AbortSignal[] = [];
      const requestMock = request === "confirmation" ? api.confirmPayment : api.readBooking;
      requestMock.mockImplementation(
        (_token: string, { signal }: { signal: AbortSignal }) =>
          new Promise<BookingWithAttendees>((_resolve, reject) => {
            signals.push(signal);
            outstanding += 1;
            maximumOutstanding = Math.max(maximumOutstanding, outstanding);
            signal.addEventListener("abort", () => {
              outstanding -= 1;
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );
      renderFlow();
      await advanceTime(60_000);

      expect(signals[0].aborted).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
      await advanceTime(60_000);

      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(maximumOutstanding).toBe(1);
      expect(outstanding).toBe(0);
      expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
    },
  );

  it("waits for a slow status request before scheduling the next one", async () => {
    let completeRead: ((booking: BookingWithAttendees) => void) | undefined;
    api.readBooking.mockImplementation(
      () => new Promise<BookingWithAttendees>((resolve) => (completeRead = resolve)),
    );
    renderFlow();
    await advanceTime(10_000);
    expect(api.readBooking).toHaveBeenCalledTimes(1);

    await act(async () => completeRead?.(pendingBooking));
    await advanceTime(1_999);
    expect(api.readBooking).toHaveBeenCalledTimes(1);
    await advanceTime(1);
    expect(api.readBooking).toHaveBeenCalledTimes(2);
  });

  it("accepts a later confirmed booking after timeout without another payment attempt", async () => {
    const client = renderFlow();
    await advanceTime(60_000);

    act(() =>
      client.setQueryData(["booking", sessionToken], { ...pendingBooking, status: "paid" }),
    );
    await advanceTime(0);

    expect(screen.getByRole("heading", { name: "You are registered!" })).toBeTruthy();
    expect(api.confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a confirmed booking with an older pending response", async () => {
    let completeRead: ((booking: BookingWithAttendees) => void) | undefined;
    api.readBooking.mockImplementation(
      () => new Promise<BookingWithAttendees>((resolve) => (completeRead = resolve)),
    );
    const client = renderFlow();
    await advanceTime(0);

    await act(async () => {
      client.setQueryData(["booking", sessionToken], { ...pendingBooking, status: "paid" });
      completeRead?.(pendingBooking);
    });
    await advanceTime(0);

    expect(client.getQueryData<BookingWithAttendees>(["booking", sessionToken])?.status).toBe(
      "paid",
    );
    expect(screen.getByRole("heading", { name: "You are registered!" })).toBeTruthy();
  });
});

describe("checkout step navigation", () => {
  it("preserves refreshed payment history while the booking loads and returns Back to attendees", async () => {
    window.history.replaceState({ checkoutStep: 3 }, "", "/");
    window.history.pushState({ checkoutStep: 4 }, "", "/");
    const originalHistoryLength = window.history.length;
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    let resolveBooking: ((booking: BookingWithAttendees) => void) | undefined;
    api.loadBooking.mockImplementation(
      () =>
        new Promise<BookingWithAttendees>((resolve) => {
          resolveBooking = resolve;
        }),
    );
    renderFlow(null, false, true);
    await advanceTime(1_000);

    expect(window.history.state.checkoutStep).toBe(4);
    expect(window.history.length).toBe(originalHistoryLength);
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Your details" })).toBeNull();

    await act(async () => resolveBooking?.({ ...pendingBooking, status: "partial" }));
    await advanceTime(0);
    expect(screen.getByRole("heading", { name: "Final checkout" })).toBeTruthy();
    expect(window.history.state.checkoutStep).toBe(4);
    expect(window.history.length).toBe(originalHistoryLength);
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();

    act(() => window.history.back());
    await advanceTime(10);
    expect(screen.getByRole("heading", { name: "Attendee details" })).toBeTruthy();
    expect(window.history.state.checkoutStep).toBe(3);
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });

  it("focuses the new heading and scrolls to the top on forward and browser-back navigation", async () => {
    renderFlow({ ...pendingBooking, currentStep: 1, status: "partial" }, false);
    await advanceTime(0);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your details" }));
    vi.mocked(window.scrollTo).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Continue to passes" }));
    const passHeading = screen.getByRole("heading", { name: "Select your pass" });
    expect(document.activeElement).toBe(passHeading);
    expect(passHeading.getAttribute("tabindex")).toBe("-1");
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "instant" });

    act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { checkoutStep: 1 } })));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your details" }));
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
  });

  it("removes sliding and fading transitions for reduced-motion users", async () => {
    api.reducedMotion = true;
    renderFlow({ ...pendingBooking, currentStep: 1, status: "partial" }, false);
    await advanceTime(0);
    const step = screen.getByRole("heading", { name: "Your details" }).parentElement!;

    expect(step.getAttribute("data-motion-initial")).toBe("false");
    expect(step.getAttribute("data-motion-exit")).toBeNull();
    expect(step.getAttribute("data-motion-transition")).toBe('{"duration":0}');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "instant" });
  });
});
