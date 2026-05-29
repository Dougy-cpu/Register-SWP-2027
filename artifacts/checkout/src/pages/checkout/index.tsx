import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useGetBookingBySession, customFetch } from "@workspace/api-client-react";
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

const STRIPE_RETURN_PARAM = "session_id";
const COMPLETION_STEP_PARAM = "step";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

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
  const pollStartRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: booking, isLoading } = useGetBookingBySession(sessionToken, {
    query: {
      queryKey: ["booking", sessionToken],
      enabled: !!sessionToken,
    },
  });

  useEffect(() => {
    if (!pollingForPayment || !sessionToken) return;

    const stripeSessionId = new URLSearchParams(window.location.search).get(STRIPE_RETURN_PARAM);

    pollStartRef.current = Date.now();

    const tryConfirmCardPayment = async () => {
      if (
        stripeSessionId &&
        booking?.id &&
        booking.status !== "paid" &&
        booking.status !== "invoiced"
      ) {
        try {
          await customFetch("/api/stripe/confirm-card-payment", {
            method: "POST",
            body: JSON.stringify({ bookingId: booking.id, sessionId: stripeSessionId }),
          });
          await queryClient.invalidateQueries({ queryKey: ["booking", sessionToken] });
        } catch {
          // Confirm call failed — webhook will still fulfil the booking, so polling continues
        }
      }
    };

    // Fire-and-forget: if it succeeds the booking status updates and polling stops naturally
    tryConfirmCardPayment();

    pollIntervalRef.current = setInterval(async () => {
      const elapsed = Date.now() - (pollStartRef.current ?? 0);
      if (elapsed >= POLL_TIMEOUT_MS) {
        clearInterval(pollIntervalRef.current!);
        setPollingForPayment(false);
        setPollTimedOut(true);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["booking", sessionToken] });
      const cached = queryClient.getQueryData<typeof booking>(["booking", sessionToken]);
      if (cached?.status === "paid" || cached?.status === "invoiced") {
        clearInterval(pollIntervalRef.current!);
        setPollingForPayment(false);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollingForPayment, sessionToken, booking?.id]);

  useEffect(() => {
    if (pollingForPayment && (booking?.status === "paid" || booking?.status === "invoiced")) {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      setPollingForPayment(false);
    }
  }, [booking?.status, pollingForPayment]);

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
    if (viewBackStep !== null && viewBackStep > serverStep) {
      setViewBackStep(null);
    }
  }, [serverStep, viewBackStep]);

  const currentStep = optimisticStep ?? viewBackStep ?? serverStep;

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
        currentStep: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attendees: [],
      } as BookingWithAttendees);
    } else if (step === null) {
      setOptimisticBooking(null);
    }
  };

  if (isLoading && !booking) {
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
        <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          <div>
            <p className="text-2xl font-bold mb-2">Confirming your payment&hellip;</p>
            <p className="text-muted-foreground">
              Please wait while we finalise your registration.
            </p>
          </div>
        </div>
      </CheckoutLayout>
    );
  }

  if (pollTimedOut && booking?.status !== "paid") {
    return (
      <CheckoutLayout currentStep={4}>
        <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
          <p className="text-2xl font-bold mb-2">
            Payment confirmation is taking longer than expected.
          </p>
          <p className="text-muted-foreground">
            If you completed payment, your registration will be confirmed shortly and you'll receive
            a confirmation email. You can safely close this page.
          </p>
        </div>
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
        return effectiveBooking ? <Step4Payment booking={effectiveBooking} /> : null;
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
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.3 }}
        >
          {renderStep()}
        </motion.div>
      </AnimatePresence>
    </CheckoutLayout>
  );
}
