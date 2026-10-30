import { useState, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  useGetBookingBySession,
  getBookingBySession,
  customFetch,
} from "@workspace/api-client-react";
import type { BookingWithAttendees } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";

// Hooks
// Persist the booking session token to localStorage so accidental tab closes
// or browser restarts can resume the booking. Falls back to (and migrates
// from) sessionStorage for in-flight users on the previous deploy. Both
// stores are kept in sync so legacy code paths (e.g. the x-booking-session
// header in custom-fetch) continue to work.
const BOOKING_SESSION_KEY = "booking_session";

function readBookingSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromLocal = window.localStorage?.getItem(BOOKING_SESSION_KEY);
    if (fromLocal) return fromLocal;
  } catch {
    /* localStorage may be blocked (private mode, quota) */
  }
  try {
    return window.sessionStorage?.getItem(BOOKING_SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeBookingSessionToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(BOOKING_SESSION_KEY, token);
  } catch {
    /* fall through to sessionStorage */
  }
  try {
    window.sessionStorage?.setItem(BOOKING_SESSION_KEY, token);
  } catch {
    /* ignore */
  }
}

function useBookingSession(): [string, () => void] {
  const [sessionToken, setSessionToken] = useState<string>("");

  useEffect(() => {
    let token = readBookingSessionToken();
    if (!token) {
      token = uuidv4();
    }
    writeBookingSessionToken(token);
    setSessionToken(token);
  }, []);

  // Rotate to a brand-new session token. Used when the persisted token
  // resolves to a finalised booking and the user is starting fresh.
  const rotate = () => {
    const fresh = uuidv4();
    writeBookingSessionToken(fresh);
    setSessionToken(fresh);
  };

  return [sessionToken, rotate];
}

// Components
import Step1Lead from "./Step1Lead";
import Step2Passes from "./Step2Passes";
import Step3Attendees from "./Step3Attendees";
import Step4Payment from "./Step4Payment";
import Confirmation from "./Confirmation";
import CheckoutLayout from "@/components/layout/CheckoutLayout";
import { Button } from "@/components/ui/button";

const STRIPE_RETURN_PARAM = "session_id";
const COMPLETION_STEP_PARAM = "step";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

function paymentIsConfirmed(booking?: BookingWithAttendees) {
  return booking?.status === "paid" || booking?.status === "invoiced";
}

function CheckoutStepContent({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    // Run when the incoming step mounts, after AnimatePresence has removed
    // the old step. Focusing earlier would target the outgoing form.
    const heading = contentRef.current?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, []);

  return (
    <motion.div
      ref={contentRef}
      className="[&_h1]:outline-none"
      initial={reduceMotion ? false : { opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, x: -20 }}
      transition={{ duration: reduceMotion ? 0 : 0.3 }}
    >
      {children}
    </motion.div>
  );
}

export default function CheckoutFlow() {
  const [sessionToken, rotateSessionToken] = useBookingSession();
  const queryClient = useQueryClient();
  const [optimisticStep, setOptimisticStep] = useState<number | null>(null);
  const [optimisticBooking, setOptimisticBooking] = useState<BookingWithAttendees | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  // viewBackStep lets the user view an earlier step via the browser back
  // button without mutating the server-side currentStep. It overrides the
  // server step ONLY when set by popstate (or restored from history.state on
  // refresh). Any forward navigation (optimisticStep being set, server
  // advancing beyond viewBackStep, or the user clicking Continue) clears it.
  const [viewBackStep, setViewBackStep] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const s = (window.history.state as { checkoutStep?: number } | null)?.checkoutStep;
    return typeof s === "number" && s >= 1 && s <= 5 ? s : null;
  });

  const isStripeReturn =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has(STRIPE_RETURN_PARAM);
  const isCompletionReturn =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get(COMPLETION_STEP_PARAM) === "5";

  const [pollingForPayment, setPollingForPayment] = useState(isStripeReturn);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const paymentCheckActiveRef = useRef(isStripeReturn);

  const { data: booking, isLoading } = useGetBookingBySession(sessionToken, {
    query: {
      queryKey: ["booking", sessionToken],
      enabled: !!sessionToken,
    },
  });

  useEffect(() => {
    if (!pollingForPayment || !sessionToken) return;

    const stripeSessionId = new URLSearchParams(window.location.search).get(STRIPE_RETURN_PARAM);
    const queryKey = ["booking", sessionToken];
    const controller = new AbortController();
    let active = true;
    let confirmationAttempted = false;
    let nextPoll: ReturnType<typeof setTimeout> | undefined;

    const finish = (timedOut: boolean) => {
      if (!active) return;
      active = false;
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(nextPoll);
      paymentCheckActiveRef.current = false;
      setPollingForPayment(false);
      setPollTimedOut(timedOut);
    };

    // An independent deadline also ends a check whose network request stalls.
    const deadline = setTimeout(() => finish(true), POLL_TIMEOUT_MS);

    const checkPayment = async () => {
      try {
        const current = queryClient.getQueryData<BookingWithAttendees>(queryKey);
        if (paymentIsConfirmed(current)) {
          finish(false);
          return;
        }
        if (!confirmationAttempted && stripeSessionId && current?.id) {
          confirmationAttempted = true;
          try {
            await customFetch("/api/stripe/confirm-card-payment", {
              method: "POST",
              headers: { "x-booking-session": sessionToken },
              body: JSON.stringify({ bookingId: current.id, sessionId: stripeSessionId }),
              signal: controller.signal,
            });
          } catch {
            // A failed check does not tell us whether payment succeeded.
            // The webhook may still update the booking, so read its status.
          }
        }
        if (!active) return;
        const latest = await getBookingBySession(sessionToken, { signal: controller.signal });
        if (!active) return;
        // A background refresh may have confirmed payment while this older
        // response was in flight. Never replace that result with pending data.
        if (paymentIsConfirmed(queryClient.getQueryData<BookingWithAttendees>(queryKey))) {
          finish(false);
          return;
        }
        queryClient.setQueryData(queryKey, latest);
        if (paymentIsConfirmed(latest)) {
          finish(false);
          return;
        }
      } catch {
        // Keep retrying within this bounded check, including after a short
        // connection failure. Never create another checkout or payment.
      }
      if (active) nextPoll = setTimeout(checkPayment, POLL_INTERVAL_MS);
    };

    void checkPayment();

    return () => {
      active = false;
      controller.abort();
      clearTimeout(deadline);
      clearTimeout(nextPoll);
    };
  }, [pollingForPayment, sessionToken, queryClient]);

  useEffect(() => {
    if (paymentIsConfirmed(booking)) {
      paymentCheckActiveRef.current = false;
      setPollingForPayment(false);
      setPollTimedOut(false);
    }
  }, [booking]);

  const retryPaymentCheck = () => {
    // Lock synchronously so repeated clicks cannot start overlapping checks.
    if (paymentCheckActiveRef.current) return;
    paymentCheckActiveRef.current = true;
    setPollTimedOut(false);
    setPollingForPayment(true);
  };

  // Restoration is gated on the resolved booking still being non-final.
  // If the persisted token resolves to a paid/invoiced booking AND the user
  // is NOT mid-Stripe-return, they're opening a fresh checkout intent — so
  // rotate the local token to start a new session. Without this, a returning
  // buyer would keep landing on a stale confirmation page weeks after their
  // last purchase. Stripe-return traffic is left alone so the post-payment
  // confirmation still renders the booking the buyer just paid for.
  const sessionRotatedRef = useRef(false);
  useEffect(() => {
    if (sessionRotatedRef.current) return;
    if (!booking || isStripeReturn || isCompletionReturn || pollingForPayment) return;
    if (booking.status === "paid" || booking.status === "invoiced") {
      sessionRotatedRef.current = true;
      queryClient.removeQueries({ queryKey: ["booking", sessionToken] });
      rotateSessionToken();
    }
  }, [
    booking,
    isStripeReturn,
    isCompletionReturn,
    pollingForPayment,
    queryClient,
    rotateSessionToken,
    sessionToken,
  ]);

  useEffect(() => {
    if (optimisticStep !== null && booking?.currentStep && booking.currentStep >= optimisticStep) {
      setOptimisticStep(null);
      setOptimisticBooking(null);
      // Any successful advance also discards a back-view override.
      setViewBackStep(null);
    }
  }, [booking?.currentStep, optimisticStep]);

  const serverStep = booking?.currentStep ?? 1;

  // If the server step ever advances past viewBackStep, the user has clearly
  // moved forward (e.g. a Continue handler succeeded) — drop the back view
  // so we render the latest server step. Also clamp stale history entries
  // that point past the booking's actual progress.
  useEffect(() => {
    // During refresh, the fallback server step is not the saved progress.
    // The first render also precedes session initialization, when the query
    // is disabled rather than loading. Keep its existing history entry intact.
    if (!sessionToken || isLoading) return;
    if (viewBackStep !== null && viewBackStep > serverStep) {
      setViewBackStep(null);
    }
  }, [serverStep, viewBackStep, sessionToken, isLoading]);

  const currentStep =
    isStripeReturn && paymentIsConfirmed(booking)
      ? 5
      : (optimisticStep ?? viewBackStep ?? serverStep);

  // Mirror currentStep into the browser history stack so the back button
  // walks the user through the checkout instead of leaving the site.
  // The first render uses replaceState (so we don't add a phantom entry);
  // subsequent changes use pushState. We also avoid pushing when the
  // current state already matches (e.g. immediately after popstate).
  // Note: this runs even before the booking has loaded so that fresh
  // visitors get a Step 1 history entry — without it, pressing back from
  // Step 2 after Continue on Step 1 would exit the site instead of
  // returning to Step 1.
  const historyInitRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stateStep = (window.history.state as { checkoutStep?: number } | null)?.checkoutStep;
    if (stateStep === currentStep) {
      historyInitRef.current = true;
      return;
    }
    const nextState = { ...(window.history.state ?? {}), checkoutStep: currentStep };
    if (!historyInitRef.current || stateStep == null) {
      window.history.replaceState(nextState, "");
      historyInitRef.current = true;
    } else {
      window.history.pushState(nextState, "");
    }
  }, [currentStep]);

  // popstate listener: when the user presses back, jump to whatever step the
  // popped history entry refers to. When they run out of in-checkout entries,
  // the browser falls through to the previous site (default behaviour).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: PopStateEvent) => {
      const popped = (e.state as { checkoutStep?: number } | null)?.checkoutStep;
      if (typeof popped === "number" && popped >= 1 && popped <= 5) {
        setOptimisticStep(null);
        setOptimisticBooking(null);
        setViewBackStep(popped);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Wrapper passed to all step components so any forward Continue click also
  // clears a back-view override (otherwise the no-op PATCH after going back
  // wouldn't update the server step and the UI would remain stuck on the
  // back-viewed step).
  const advanceTo = (step: number) => {
    setViewBackStep(null);
    setOptimisticStep(step);
  };

  const onAdvance = (
    step: number | null,
    formData?: { attendeeType: string; sessionToken: string },
  ) => {
    setOptimisticStep(step);
    if (step !== null && formData) {
      setStep1Error(null);
      setOptimisticBooking({
        id: 0,
        sessionToken: formData.sessionToken,
        status: "partial",
        passType: "single",
        attendeeType: formData.attendeeType as BookingWithAttendees["attendeeType"],
        quantity: 1,
        promoCode: null,
        promoDiscountAmount: null,
        groupDiscountAmount: null,
        subtotalAmount: 0,
        vatAmount: 0,
        totalAmount: 0,
        paymentMethod: null,
        manualEntry: false,
        currentStep: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attendees: [],
      } as BookingWithAttendees);
    } else if (step === null) {
      setOptimisticBooking(null);
    }
  };

  if (isLoading && !booking && !pollingForPayment && !pollTimedOut) {
    return (
      <CheckoutLayout>
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </CheckoutLayout>
    );
  }

  if (pollingForPayment) {
    return (
      <CheckoutLayout currentStep={5}>
        <CheckoutStepContent key="payment-checking">
          <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
            <div
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none rounded-full h-12 w-12 border-b-2 border-primary"
            ></div>
            <div>
              <h1 className="text-2xl font-bold mb-2">Checking your payment&hellip;</h1>
              <p className="text-muted-foreground">
                Please wait while we check your booking. This will not take another payment.
              </p>
            </div>
          </div>
        </CheckoutStepContent>
      </CheckoutLayout>
    );
  }

  if (pollTimedOut && !paymentIsConfirmed(booking)) {
    const reference = booking?.orderReference || (booking?.id ? `Booking ${booking.id}` : null);
    const supportSubject = `SWP Summit 2027 payment query${reference ? ` - ${reference}` : ""}`;
    return (
      <CheckoutLayout currentStep={4}>
        <CheckoutStepContent key="payment-delayed">
          <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
            <h1 className="text-2xl font-bold mb-2">
              Payment confirmation is taking longer than expected.
            </h1>
            <p className="max-w-2xl text-muted-foreground">
              We have not been able to confirm the result yet. You can check again below or contact
              us for help. If your card has been charged, please do not make another payment.
            </p>
            <Button onClick={retryPaymentCheck} className="swp-primary-btn" size="lg">
              Check payment status
            </Button>
            <div className="space-y-2 text-sm text-muted-foreground">
              {reference && <p className="font-semibold text-foreground">Reference: {reference}</p>}
              <p>
                Need help?{" "}
                <a
                  href={`mailto:douglas@peoplestrategyhub.com?subject=${encodeURIComponent(supportSubject)}`}
                  className="font-semibold text-primary underline underline-offset-2"
                >
                  Contact the event team
                </a>
                {!reference && " and include the email address used for your booking"}.
              </p>
            </div>
          </div>
        </CheckoutStepContent>
      </CheckoutLayout>
    );
  }

  const effectiveBooking = booking ?? optimisticBooking ?? undefined;

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <Step1Lead
            sessionToken={sessionToken}
            booking={booking}
            onAdvance={onAdvance}
            submitError={step1Error}
            onSubmitError={setStep1Error}
          />
        );
      case 2:
        return effectiveBooking ? (
          <Step2Passes booking={effectiveBooking} onAdvance={advanceTo} />
        ) : null;
      case 3:
        return effectiveBooking ? (
          <Step3Attendees booking={effectiveBooking} onAdvance={advanceTo} />
        ) : null;
      case 4:
        return effectiveBooking ? (
          <Step4Payment key={effectiveBooking.id} booking={effectiveBooking} />
        ) : null;
      case 5:
        return effectiveBooking ? <Confirmation booking={effectiveBooking} /> : null;
      default:
        return (
          <Step1Lead
            sessionToken={sessionToken}
            booking={booking}
            onAdvance={onAdvance}
            submitError={step1Error}
            onSubmitError={setStep1Error}
          />
        );
    }
  };

  return (
    <CheckoutLayout currentStep={currentStep}>
      <AnimatePresence mode="wait">
        <CheckoutStepContent key={currentStep}>{renderStep()}</CheckoutStepContent>
      </AnimatePresence>
    </CheckoutLayout>
  );
}
