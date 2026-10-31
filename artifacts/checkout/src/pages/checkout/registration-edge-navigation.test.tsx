import type { HTMLAttributes, ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  useGetCurrentBooking: (options: { query: { queryKey: string[]; enabled: boolean } }) =>
    useQuery<BookingWithAttendees>({
      ...options.query,
      queryFn: api.loadBooking,
      staleTime: Infinity,
      retry: false,
    }),
  getCurrentBooking: api.readBooking,
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

describe("completion on a refreshed Payment screen", () => {
  for (const status of ["invoiced", "paid"] as const) {
    it("shows confirmation after a refreshed " + status + " completion", async () => {
      window.history.replaceState({ checkoutStep: 4 }, "", "/");
      const client = renderFlow(pendingBooking, false, true);
      await advanceTime(0);
      expect(screen.getByRole("heading", { name: "Final checkout" })).toBeTruthy();
      // Mirror the production markCompletionReturn call after the API succeeds.
      window.history.replaceState({ checkoutStep: 5 }, "", "/?step=5");
      act(() => {
        client.setQueryData(["booking", sessionToken], {
          ...pendingBooking,
          status,
          currentStep: 5,
        });
      });
      await advanceTime(10);
      console.log(
        "OBSERVED refreshed completion",
        status,
        screen.queryByRole("heading")?.textContent,
      );
      expect(screen.queryByRole("heading", { name: "You are registered!" })).toBeTruthy();
    });
  }
  it("control: a fresh completion URL at step five renders the invoice confirmation", async () => {
    window.history.replaceState({ checkoutStep: 5 }, "", "/?step=5");
    renderFlow({ ...pendingBooking, status: "invoiced", currentStep: 5 }, false, true);
    await advanceTime(10);
    expect(screen.getByRole("heading", { name: "You are registered!" })).toBeTruthy();
  });
});
