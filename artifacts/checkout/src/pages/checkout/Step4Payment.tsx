import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useUpdateBooking,
  useCalculatePricing,
  useCreateStripeCheckoutSession,
  useCreateStripeInvoice,
  customFetch,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import SaveAndReturnButton from "@/components/checkout/SaveAndReturnButton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Check,
  CheckCircle2,
  Link2,
  Link2Off,
  CreditCard,
  FileText,
  ArrowLeft,
  ChevronDown,
} from "lucide-react";
import type { BookingWithAttendees } from "@/types/booking";
import { calculateCheckoutPricing } from "@/lib/checkout-pricing";
import {
  BILLING_FIELDS,
  readPaymentDraft,
  usePaymentDraft,
  type PaymentDraft,
} from "@/lib/checkout-payment-draft";

// Fields on the billing form that can be auto-linked to the lead attendee.
// Editing any of them unlinks just that field; clicking the "Use lead
// attendee" button re-links it and copies the value back from the lead.
const LINKABLE_FIELDS = ["billingName", "billingCompany", "billingEmail", "billingPhone"] as const;
type LinkableField = (typeof LINKABLE_FIELDS)[number];

// Renders the form label plus a small "Same as lead attendee" badge (when
// linked) or a "Use lead attendee" relink button (when unlinked but a lead
// value exists). When there's no lead value to copy from, only the plain
// label is rendered.
function LinkedFieldLabel({
  label,
  field,
  linked,
  canLink,
  onRelink,
}: {
  label: string;
  field: LinkableField;
  linked: boolean;
  canLink: boolean;
  onRelink: () => void;
}) {
  return (
    <div className="mb-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <FormLabel className="!mb-0 text-sm font-semibold">{label}</FormLabel>
      {canLink && linked && (
        <span
          className="inline-flex shrink-0 items-center text-primary/70"
          title="This field is linked to your lead attendee. Editing it unlinks just this field."
          data-testid={`linked-${field}`}
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">Same as lead attendee</span>
        </span>
      )}
      {canLink && !linked && (
        <button
          type="button"
          onClick={onRelink}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2"
          data-testid={`relink-${field}`}
        >
          <Link2Off className="w-3 h-3" /> Use lead attendee
        </button>
      )}
    </div>
  );
}

// Renders admin-editable plain-text help copy in the checkout. Mirrors the
// server-side renderer in api-server/src/lib/email.ts: blank-line-separated
// paragraphs, lines starting with "- " become bullet lists, and the first
// line of a multi-line block becomes a bold heading.
function InvoiceHelpRendered({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, idx) => {
        const lines = block.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length === 0) return null;
        const allBullets = lines.every((l) => /^\s*-\s+/.test(l));
        if (allBullets) {
          return (
            <ul key={idx} className="list-disc pl-5 space-y-1 text-muted-foreground">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*-\s+/, "")}</li>
              ))}
            </ul>
          );
        }
        if (lines.length > 1) {
          const [heading, ...rest] = lines;
          return (
            <div key={idx}>
              <p className="font-semibold text-foreground">{heading}</p>
              <p className="text-muted-foreground">{rest.join(" ")}</p>
            </div>
          );
        }
        return (
          <p key={idx} className="text-muted-foreground">
            {lines[0]}
          </p>
        );
      })}
    </>
  );
}

const invoiceSchema = z.object({
  billingName: z.string().min(1, "Billing name is required"),
  billingCompany: z.string().min(1, "Company is required"),
  billingEmail: z.string().email("Valid email is required"),
  billingAddressLine1: z.string().min(1, "Address line 1 is required"),
  billingAddressLine2: z.string().optional(),
  billingTown: z.string().min(1, "Town / City is required"),
  billingRegion: z.string().optional(),
  billingPostcode: z.string().min(1, "Postcode is required"),
  billingCountry: z.string().min(1, "Country is required"),
  billingPhone: z.string().min(1, "Contact number is required"),
  billingVatNumber: z.string().optional(),
  poNumber: z.string().optional(),
});
type InvoiceFormValues = z.infer<typeof invoiceSchema>;

interface Step4PaymentProps {
  booking: BookingWithAttendees;
}

function readBookingSessionToken(): string | null {
  if (typeof window === "undefined") return null;

  let fromLocal: string | null = null;
  let fromSession: string | null = null;

  try {
    fromLocal = window.localStorage?.getItem("booking_session") ?? null;
  } catch {
    /* localStorage may be blocked */
  }

  try {
    fromSession = window.sessionStorage?.getItem("booking_session") ?? null;
  } catch {
    /* sessionStorage may be blocked */
  }

  if (fromLocal) {
    if (fromSession !== fromLocal) {
      try {
        window.sessionStorage?.setItem("booking_session", fromLocal);
      } catch {
        /* sessionStorage may be blocked */
      }
    }
    return fromLocal;
  }

  return fromSession;
}

function formatMoney(value: number | undefined) {
  if (value === undefined) return "Calculating";
  return `£${value.toFixed(2)}`;
}

function markCompletionReturn() {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  url.searchParams.set("step", "5");
  window.history.replaceState({ ...(window.history.state ?? {}), checkoutStep: 5 }, "", url);
}

export default function Step4Payment({ booking }: Step4PaymentProps) {
  const queryClient = useQueryClient();
  // Checkout drafts must never inherit an admin session's invoice-reissue behaviour.
  const updateBooking = useUpdateBooking({ request: { headers: { "x-admin-token": "" } } });
  const createStripeSession = useCreateStripeCheckoutSession();
  const createInvoice = useCreateStripeInvoice();

  const [restoredDraft] = useState(() => readPaymentDraft(booking.id));
  const [paymentMethod, setPaymentMethod] = useState<"card" | "invoice">(
    restoredDraft?.paymentMethod ?? (booking.paymentMethod === "invoice" ? "invoice" : "card"),
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isFreeConfirming, setIsFreeConfirming] = useState(false);
  const [invoiceHelpContent, setInvoiceHelpContent] = useState<string>("");
  const [helpExpanded, setHelpExpanded] = useState(false);

  // Fetch the admin-editable "How invoicing works" copy. Falls back silently;
  // if the request fails we just hide the help block (it's an enhancement,
  // never blocking the checkout). Re-runs only when the user opens Step 4.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/event-settings/public")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { invoiceHelpContent?: string } | null) => {
        if (!cancelled && data?.invoiceHelpContent) {
          setInvoiceHelpContent(data.invoiceHelpContent);
        }
      })
      .catch(() => {
        /* silently ignore — help block is non-critical */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Set to true just before intentional navigation (Stripe redirect / invoice success)
  // so the beforeunload handler does NOT fire a false incomplete-ping.
  const isSubmittingPaymentRef = useRef(false);

  const calculatePricingMutation = useCalculatePricing({
    mutation: { mutationFn: ({ data }) => calculateCheckoutPricing(data) },
  });
  const pricingKey = JSON.stringify([booking.passType, booking.quantity, booking.promoCode]);
  const pricingFor = useRef<string | null>(null);

  const refreshPricing = () => {
    pricingFor.current = pricingKey;
    calculatePricingMutation.mutate({
      data: {
        passType: booking.passType,
        quantity: booking.quantity,
        promoCode: booking.promoCode || undefined,
      },
    });
  };

  useEffect(() => {
    refreshPricing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.passType, booking.quantity, booking.promoCode]);

  // Abandonment detection: fire incomplete-ping when the user leaves without paying.
  // Two triggers: (1) beforeunload via sendBeacon for tab close / navigation away,
  // (2) a 20-minute setTimeout as a fallback for users who stay but then leave.
  // Both are no-ops if the booking has already been paid/invoiced.
  // The beforeunload beacon is gated on the user having stayed on this step
  // for at least PING_DWELL_MS so quick bounces (loaded → immediately closed)
  // don't flood the incomplete-booking notification logic. Reaching Step 4
  // already implies the user has progressed past Step 1.
  useEffect(() => {
    if (booking.status !== "partial") return;

    const PING_DWELL_MS = 10_000;
    const pingUrl = `/api/bookings/${booking.id}/incomplete-ping`;
    const mountedAt = Date.now();
    const bookingSessionToken = readBookingSessionToken();

    const sendIncompletePing = () => {
      if (!bookingSessionToken) return;

      const payload = JSON.stringify({ sessionToken: bookingSessionToken });
      const blob = new Blob([payload], { type: "application/json" });

      if (navigator.sendBeacon?.(pingUrl, blob)) {
        return;
      }

      void fetch(pingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {
        /* best-effort notification only */
      });
    };

    const handleBeforeUnload = () => {
      if (isSubmittingPaymentRef.current) return;
      if (Date.now() - mountedAt < PING_DWELL_MS) return;
      sendIncompletePing();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    const timer = setTimeout(
      () => {
        sendIncompletePing();
      },
      20 * 60 * 1000,
    );

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      clearTimeout(timer);
    };
  }, [booking.id, booking.status]);

  const currentPricing =
    pricingFor.current === pricingKey && calculatePricingMutation.isSuccess
      ? calculatePricingMutation.data
      : undefined;
  const bookingPassLabel = booking.passType === "single" ? "Workforce Pass" : "Business Pass";

  const billingLead =
    booking.attendees?.find((a) => a.isLead && !a.isTbc) ??
    booking.attendees?.find((a) => !a.isTbc);

  // Resolve the lead's value for each linkable billing field. Returns "" when
  // the lead has no usable value, so callers can decide whether linking even
  // makes sense (we never link to an empty source).
  const getLeadValue = (field: LinkableField): string => {
    if (!billingLead) return "";
    switch (field) {
      case "billingName":
        return `${billingLead.firstName ?? ""} ${billingLead.lastName ?? ""}`.trim();
      case "billingCompany":
        return billingLead.company ?? "";
      case "billingEmail":
        return billingLead.workEmail ?? "";
      case "billingPhone":
        return billingLead.phone ?? "";
    }
  };

  // Initial linked state: a field is linked if it currently matches the lead's
  // value (case-insensitive), or if both the booking and the lead are empty
  // (nothing to link to). We treat "matching" as the source of truth so a
  // returning customer who didn't override the prefill still sees the badge.
  const initialLinkedRef = useRef<Record<LinkableField, boolean>>(
    Object.fromEntries(
      LINKABLE_FIELDS.map((f) => {
        const leadVal = getLeadValue(f).toLowerCase();
        const savedRaw =
          f === "billingName"
            ? booking.billingName
            : f === "billingCompany"
              ? booking.billingCompany
              : f === "billingEmail"
                ? booking.billingEmail
                : booking.billingPhone;
        const savedVal = (restoredDraft?.billing[f] ?? savedRaw ?? "").toLowerCase();
        const linked = leadVal !== "" && (savedVal === "" || savedVal === leadVal);
        return [f, linked];
      }),
    ) as Record<LinkableField, boolean>,
  );

  const [linkedFields, setLinkedFields] = useState<Record<LinkableField, boolean>>(
    initialLinkedRef.current,
  );

  // Re-link a field: copy the lead's value back into the form and mark linked.
  // Only callable when there's a non-empty lead value to copy from.
  const relinkField = (field: LinkableField) => {
    const leadVal = getLeadValue(field);
    if (!leadVal) return;
    form.setValue(field, leadVal, { shouldDirty: true, shouldValidate: true });
    setLinkedFields((prev) => ({ ...prev, [field]: true }));
  };

  // Mark a field as unlinked. Called from the input's onChange so any user
  // edit visibly breaks the link without waiting for a value comparison.
  const unlinkField = (field: LinkableField) => {
    setLinkedFields((prev) => (prev[field] ? { ...prev, [field]: false } : prev));
  };

  const form = useForm<z.infer<typeof invoiceSchema>>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      billingName:
        booking.billingName ||
        (billingLead ? `${billingLead.firstName} ${billingLead.lastName}` : ""),
      billingCompany: booking.billingCompany || billingLead?.company || "",
      billingEmail: booking.billingEmail || billingLead?.workEmail || "",
      billingAddressLine1: booking.billingAddressLine1 || "",
      billingAddressLine2: booking.billingAddressLine2 || "",
      billingTown: booking.billingTown || "",
      billingRegion: booking.billingRegion || "",
      billingPostcode: booking.billingPostcode || "",
      billingCountry: booking.billingCountry || "United Kingdom",
      billingPhone: booking.billingPhone || billingLead?.phone || "",
      billingVatNumber: booking.billingVatNumber || "",
      poNumber: booking.poNumber || "",
      ...restoredDraft?.billing,
    },
  });
  const watchedBilling = form.watch();
  const draft: PaymentDraft = {
    paymentMethod,
    billing: Object.fromEntries(
      BILLING_FIELDS.map((field) => [field, watchedBilling[field] ?? ""]),
    ) as PaymentDraft["billing"],
  };
  const { status: draftStatus, flush: flushDraft } = usePaymentDraft({
    bookingId: booking.id,
    draft,
    restored: restoredDraft !== null,
    enabled:
      ["partial", "pending_payment"].includes(booking.status) && !isProcessing && !isFreeConfirming,
    save: async (data) => {
      const persisted = await updateBooking.mutateAsync({ id: booking.id, data });
      await queryClient.cancelQueries({
        queryKey: ["booking"],
        predicate: (query) =>
          (query.state.data as BookingWithAttendees | undefined)?.id === booking.id,
      });
      // Browser Back can return to this step before a refetch completes. Keep the
      // saved billing fields current without overwriting a newer step or status.
      const billing = Object.fromEntries(
        [...BILLING_FIELDS, "paymentMethod" as const].map((field) => [field, persisted[field]]),
      );
      queryClient.setQueriesData<BookingWithAttendees>({ queryKey: ["booking"] }, (previous) =>
        previous?.id === booking.id ? { ...previous, ...billing } : previous,
      );
      return persisted;
    },
  });

  const onSubmit = async (data?: z.infer<typeof invoiceSchema>) => {
    if (!currentPricing || isProcessing) return;
    setIsProcessing(true);
    setPaymentError(null);
    try {
      await flushDraft();
      await updateBooking.mutateAsync({
        id: booking.id,
        data: {
          paymentMethod,
          ...(paymentMethod === "invoice" && data
            ? {
                billingName: data.billingName,
                billingCompany: data.billingCompany,
                billingEmail: data.billingEmail,
                billingAddressLine1: data.billingAddressLine1,
                billingAddressLine2: data.billingAddressLine2 || null,
                billingTown: data.billingTown,
                billingRegion: data.billingRegion || null,
                billingPostcode: data.billingPostcode,
                billingCountry: data.billingCountry,
                billingPhone: data.billingPhone,
                billingVatNumber: data.billingVatNumber || null,
                poNumber: data.poNumber || null,
              }
            : {}),
        },
      });

      if (paymentMethod === "card") {
        const currentUrl = window.location.origin;
        const session = await createStripeSession.mutateAsync({
          data: {
            bookingId: booking.id,
            successUrl: `${currentUrl}/?session_id={CHECKOUT_SESSION_ID}&step=5`,
            cancelUrl: `${currentUrl}/?step=4`,
          },
        });
        if (session?.url) {
          isSubmittingPaymentRef.current = true;
          window.location.href = session.url;
        } else {
          setPaymentError(
            "No redirect URL received from payment provider. Please try again or contact us.",
          );
          setIsProcessing(false);
        }
      } else {
        isSubmittingPaymentRef.current = true;
        await createInvoice.mutateAsync({
          data: { bookingId: booking.id },
        });
        markCompletionReturn();
        queryClient.invalidateQueries({ queryKey: ["booking"] });
      }
    } catch (e) {
      console.error(e);
      isSubmittingPaymentRef.current = false;
      const err = e as { data?: { error?: string }; message?: string };
      const message =
        err?.data?.error || err?.message || "Something went wrong. Please try again or contact us.";
      setPaymentError(message);
      setIsProcessing(false);
    }
  };

  const handleConfirmFree = async () => {
    if (!currentPricing || currentPricing.total !== 0 || isFreeConfirming) return;
    setIsFreeConfirming(true);
    setPaymentError(null);
    try {
      await flushDraft();
      await customFetch(`/api/bookings/${booking.id}/confirm-free`, { method: "POST" });
      markCompletionReturn();
      queryClient.invalidateQueries({ queryKey: ["booking"] });
    } catch (e) {
      const err = e as { data?: { error?: string }; message?: string };
      const message =
        err?.data?.error || err?.message || "Something went wrong. Please try again or contact us.";
      setPaymentError(message);
      setIsFreeConfirming(false);
    }
  };

  const invoiceSaveData = (data: InvoiceFormValues) => ({
    billingName: data.billingName || null,
    billingCompany: data.billingCompany || null,
    billingEmail: data.billingEmail || null,
    billingAddressLine1: data.billingAddressLine1 || null,
    billingAddressLine2: data.billingAddressLine2 || null,
    billingTown: data.billingTown || null,
    billingRegion: data.billingRegion || null,
    billingPostcode: data.billingPostcode || null,
    billingCountry: data.billingCountry || null,
    billingPhone: data.billingPhone || null,
    billingVatNumber: data.billingVatNumber || null,
    poNumber: data.poNumber || null,
  });

  const savePaymentProgress = async () => {
    setPaymentError(null);
    await flushDraft();
    await updateBooking.mutateAsync({
      id: booking.id,
      data: {
        paymentMethod,
        currentStep: 4,
        ...(paymentMethod === "invoice" ? invoiceSaveData(form.getValues()) : {}),
      },
    });
    queryClient.invalidateQueries({ queryKey: ["booking"] });
    isSubmittingPaymentRef.current = true;
  };

  const saveFreeProgress = async () => {
    setPaymentError(null);
    await updateBooking.mutateAsync({
      id: booking.id,
      data: { currentStep: 4 },
    });
    queryClient.invalidateQueries({ queryKey: ["booking"] });
    isSubmittingPaymentRef.current = true;
  };

  const isFreeBooking = currentPricing !== undefined && currentPricing.total === 0;

  if (isFreeBooking) {
    return (
      <div className="max-w-5xl mx-auto space-y-8 flex flex-col md:flex-row gap-12">
        <div className="flex-1 space-y-8">
          <div>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Confirm Registration</h1>
            <p className="text-lg text-muted-foreground">
              Your promo code covers the full cost — no payment needed.
            </p>
          </div>

          <div className="bg-white border border-border p-6 md:p-8 space-y-4">
            <div className="flex items-start gap-3 text-green-800 bg-green-50 border border-green-200 p-4">
              <Check className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">Your promo code has been applied</p>
                <p className="text-sm text-green-700 mt-0.5">
                  This booking is completely free. Click the button below to confirm your place at
                  the summit.
                </p>
              </div>
            </div>
          </div>

          {paymentError && (
            <div
              role="alert"
              className="bg-red-50 border border-red-200 rounded p-4 text-sm text-red-800"
            >
              <p className="font-semibold mb-1">Error</p>
              <p>{paymentError}</p>
            </div>
          )}

          <div className="space-y-3 pt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
              <Button
                variant="outline"
                size="lg"
                className="px-8 h-14 text-lg border-border"
                onClick={async () => {
                  setPaymentError(null);
                  try {
                    await flushDraft();
                    await updateBooking.mutateAsync({ id: booking.id, data: { currentStep: 3 } });
                    queryClient.invalidateQueries({ queryKey: ["booking"] });
                  } catch {
                    setPaymentError("We couldn't save your progress. Please try again.");
                  }
                }}
                disabled={isFreeConfirming || updateBooking.isPending}
              >
                Back
              </Button>
              <Button
                size="lg"
                className="px-10 h-14 text-lg bg-primary hover:bg-primary/90 text-white border-none"
                onClick={handleConfirmFree}
                disabled={isFreeConfirming}
              >
                {isFreeConfirming ? "Confirming…" : "Confirm Registration"}
              </Button>
            </div>
            <SaveAndReturnButton onSave={saveFreeProgress} disabled={isFreeConfirming} />
          </div>
        </div>

        <div className="w-full md:w-[380px] shrink-0 space-y-6">
          <div className="bg-muted p-6">
            <h3 className="text-xl font-bold mb-6">Order Summary</h3>
            <div className="space-y-4">
              <div className="flex justify-between text-base">
                <span>
                  {booking.quantity} × {bookingPassLabel}
                </span>
                <span>£{currentPricing.baseSubtotal.toFixed(2)}</span>
              </div>
              {currentPricing.groupDiscountAmount > 0 && (
                <div className="flex justify-between text-base text-primary font-bold">
                  <span>Group Discount</span>
                  <span>-£{currentPricing.groupDiscountAmount.toFixed(2)}</span>
                </div>
              )}
              {currentPricing.promoDiscountAmount > 0 && (
                <div className="flex justify-between text-base text-primary font-bold">
                  <span>Promo Code</span>
                  <span>-£{currentPricing.promoDiscountAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-base">
                <span>Subtotal</span>
                <span>£{currentPricing.subtotalAfterDiscounts.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-base text-muted-foreground border-b border-border pb-4">
                <span>VAT (20%)</span>
                <span>£{currentPricing.vatAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold text-2xl pt-2">
                <span>Total</span>
                <span>£0.00</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const submitLabel = isProcessing
    ? "Processing…"
    : paymentMethod === "card"
      ? "Continue to secure payment"
      : "Confirm booking & email invoice";
  const invoiceRecipient = watchedBilling.billingEmail?.trim();
  const fieldClassName = "h-11 rounded-md border-primary/20 bg-white text-sm shadow-none sm:h-10";
  const contactFields = [
    {
      name: "billingName",
      label: "Billing contact name *",
      type: "text",
      autoComplete: "billing name",
    },
    {
      name: "billingCompany",
      label: "Company name *",
      type: "text",
      autoComplete: "billing organization",
    },
    {
      name: "billingEmail",
      label: "Invoice email address *",
      type: "email",
      autoComplete: "billing email",
    },
    { name: "billingPhone", label: "Contact number *", type: "tel", autoComplete: "billing tel" },
  ] as const;
  const addressFields = [
    {
      name: "billingAddressLine1",
      label: "Address line 1",
      optional: false,
      fullWidth: true,
      autoComplete: "billing address-line1",
    },
    {
      name: "billingAddressLine2",
      label: "Address line 2",
      optional: true,
      fullWidth: true,
      autoComplete: "billing address-line2",
    },
    {
      name: "billingTown",
      label: "Town / City",
      optional: false,
      fullWidth: false,
      autoComplete: "billing address-level2",
    },
    {
      name: "billingRegion",
      label: "Region / County",
      optional: true,
      fullWidth: false,
      autoComplete: "billing address-level1",
    },
    {
      name: "billingPostcode",
      label: "Postcode",
      optional: false,
      fullWidth: false,
      autoComplete: "billing postal-code",
    },
    {
      name: "billingCountry",
      label: "Country",
      optional: false,
      fullWidth: false,
      autoComplete: "billing country-name",
    },
  ] as const;

  return (
    <div className="mx-auto grid w-full min-w-0 grid-cols-1 items-start gap-7 lg:grid-cols-[minmax(0,1.8fr)_minmax(340px,1fr)] lg:gap-6">
      <div className="min-w-0 lg:border-r lg:border-primary/15 lg:pr-6">
        <header className="mb-5 space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl xl:text-5xl">
            Complete your booking
          </h1>
          <p className="text-lg text-muted-foreground">Choose how you would like to pay.</p>
        </header>

        <section aria-label="Payment options" className="space-y-3">
          <RadioGroup
            aria-label="Payment method"
            value={paymentMethod}
            disabled={isProcessing}
            onValueChange={(value: "card" | "invoice") => setPaymentMethod(value)}
            className="grid gap-3 sm:grid-cols-2"
          >
            {(
              [
                {
                  value: "card",
                  label: "Pay by card",
                  description: "Continue to secure payment with Stripe.",
                  Icon: CreditCard,
                },
                {
                  value: "invoice",
                  label: "Pay by invoice",
                  description: "Confirm now. Pay by invoice.",
                  Icon: FileText,
                },
              ] as const
            ).map(({ value, label, description, Icon }) => (
              <div
                key={value}
                className={`min-w-0 rounded-md border p-4 transition-colors ${isProcessing ? "cursor-default" : "cursor-pointer"} ${paymentMethod === value ? "border-primary bg-[#f0f6ff]" : "border-primary/20 bg-white hover:border-primary/50"}`}
                onClick={() => !isProcessing && setPaymentMethod(value)}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <RadioGroupItem value={value} aria-label={label} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                      <span className="text-lg font-bold leading-snug">{label}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
                  </div>
                </div>
              </div>
            ))}
          </RadioGroup>

          {paymentMethod === "invoice" ? (
            <>
              <p className="text-sm leading-relaxed text-muted-foreground">
                We’ll email your VAT invoice with supplier details, bank details and a secure
                payment link.
              </p>
              <button
                type="button"
                className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-primary underline underline-offset-4"
                aria-expanded={helpExpanded}
                aria-controls="invoice-payment-help"
                onClick={() => setHelpExpanded((expanded) => !expanded)}
              >
                <ChevronDown
                  className={`h-4 w-4 shrink-0 ${helpExpanded ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                How invoice payment works
              </button>
              {helpExpanded && (
                <div
                  id="invoice-payment-help"
                  className="space-y-3 rounded-md border border-primary/15 bg-[#f0f6ff] p-4 text-sm leading-relaxed"
                >
                  {invoiceHelpContent ? (
                    <InvoiceHelpRendered text={invoiceHelpContent} />
                  ) : (
                    <>
                      <p>
                        Your registration is confirmed when the invoice is issued. Payment is due
                        within 14 days, or before the event if sooner, by bank transfer or the
                        secure Stripe payment link.
                      </p>
                      <p>
                        You can add a PO number or update billing details before payment using the
                        secure link in your invoice email. We’ll email a revised invoice
                        automatically.
                      </p>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Your booking is confirmed after payment. A confirmation email is sent to the lead
              attendee.
            </p>
          )}
        </section>

        {paymentMethod === "invoice" && (
          <section
            className="mt-6 border-t border-primary/15 pt-5"
            aria-labelledby="billing-details-heading"
          >
            <div className="mb-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 id="billing-details-heading" className="text-2xl font-bold tracking-tight">
                  Billing details
                </h2>
                {draftStatus !== "error" && (
                  <p
                    role="status"
                    className={`inline-flex items-center gap-2 text-xs ${draftStatus === "saved" ? "text-green-700" : "text-muted-foreground"}`}
                  >
                    {draftStatus === "saved" && (
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    )}
                    {draftStatus === "saving" ? "Saving billing details…" : "Billing details saved"}
                  </p>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Pre-filled from your lead attendee. Edit if finance needs different details.
              </p>
              {draftStatus === "error" && (
                <div
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
                >
                  <p>We couldn't save your billing details. Keep this page open and retry.</p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2"
                    onClick={() => {
                      void flushDraft().catch(() => {});
                    }}
                  >
                    Retry saving details
                  </Button>
                </div>
              )}
            </div>

            <Form {...form}>
              <fieldset disabled={isProcessing} className="min-w-0">
                <form
                  id="invoice-form"
                  className="space-y-5"
                  onSubmit={form.handleSubmit(onSubmit)}
                >
                  <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                    {contactFields.map(({ name, label, type, autoComplete }) => (
                      <FormField
                        key={name}
                        control={form.control}
                        name={name}
                        render={({ field }) => (
                          <FormItem className="min-w-0 space-y-1.5">
                            <LinkedFieldLabel
                              label={label}
                              field={name}
                              linked={linkedFields[name]}
                              canLink={!!getLeadValue(name)}
                              onRelink={() => relinkField(name)}
                            />
                            <FormControl>
                              <Input
                                {...field}
                                type={type}
                                autoComplete={autoComplete}
                                aria-required="true"
                                className={fieldClassName}
                                onChange={(event) => {
                                  field.onChange(event);
                                  unlinkField(name);
                                }}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    ))}
                  </div>

                  <section aria-labelledby="billing-address-heading">
                    <h3 id="billing-address-heading" className="mb-3 text-lg font-bold">
                      Billing address
                    </h3>
                    <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                      {addressFields.map(({ name, label, optional, fullWidth, autoComplete }) => (
                        <FormField
                          key={name}
                          control={form.control}
                          name={name}
                          render={({ field }) => (
                            <FormItem
                              className={`min-w-0 space-y-1.5 ${fullWidth ? "sm:col-span-2" : ""}`}
                            >
                              <FormLabel className="text-sm font-semibold">
                                {label}
                                {optional ? (
                                  <span className="font-normal text-muted-foreground">
                                    {" "}
                                    (optional)
                                  </span>
                                ) : (
                                  " *"
                                )}
                              </FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  autoComplete={autoComplete}
                                  aria-required={!optional}
                                  className={fieldClassName}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                  </section>

                  <section aria-labelledby="invoice-references-heading">
                    <h3 id="invoice-references-heading" className="mb-3 text-lg font-bold">
                      Invoice references
                    </h3>
                    <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                      {(
                        [
                          { name: "billingVatNumber", label: "VAT number" },
                          { name: "poNumber", label: "PO number" },
                        ] as const
                      ).map(({ name, label }) => (
                        <FormField
                          key={name}
                          control={form.control}
                          name={name}
                          render={({ field }) => (
                            <FormItem className="min-w-0 space-y-1.5">
                              <FormLabel className="text-sm font-semibold">
                                {label}{" "}
                                <span className="font-normal text-muted-foreground">
                                  (optional)
                                </span>
                              </FormLabel>
                              <FormControl>
                                <Input {...field} className={fieldClassName} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      You can add a PO number or update billing details later, before payment, using
                      the secure link in your invoice email. We’ll email a revised invoice
                      automatically.
                    </p>
                  </section>
                </form>
              </fieldset>
            </Form>
          </section>
        )}

        <Button
          variant="link"
          className="mt-3 h-auto min-h-11 gap-2 px-0 text-sm text-primary underline underline-offset-4"
          onClick={async () => {
            setPaymentError(null);
            try {
              await flushDraft();
              await updateBooking.mutateAsync({ id: booking.id, data: { currentStep: 3 } });
              queryClient.invalidateQueries({ queryKey: ["booking"] });
            } catch (error) {
              const err = error as { data?: { error?: string }; message?: string };
              setPaymentError(
                err?.data?.error ||
                  err?.message ||
                  "We could not return to attendee details. Please try again.",
              );
            }
          }}
          disabled={isProcessing}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to attendees
        </Button>
      </div>

      <aside
        className="min-w-0 rounded-lg bg-[#f0f6ff] p-5 sm:p-6"
        aria-labelledby="payment-booking-summary"
      >
        <h2
          id="payment-booking-summary"
          className="border-b border-primary/15 pb-4 text-2xl font-bold tracking-tight"
        >
          Your booking
        </h2>
        {calculatePricingMutation.isError && (
          <div
            role="alert"
            className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <p>We couldn't update your total. Please retry before confirming your booking.</p>
            <Button type="button" variant="outline" className="mt-2" onClick={refreshPricing}>
              Retry total
            </Button>
          </div>
        )}
        {currentPricing ? (
          <>
            <dl className="space-y-4 py-5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="min-w-0 text-muted-foreground">
                  {booking.quantity} × {bookingPassLabel}
                </dt>
                <dd className="shrink-0 font-medium tabular-nums">
                  {formatMoney(currentPricing.baseSubtotal)}
                </dd>
              </div>
              {currentPricing.groupDiscountAmount > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="min-w-0 text-muted-foreground">
                    Group saving ({currentPricing.groupDiscountPercent}%)
                  </dt>
                  <dd className="shrink-0 font-medium tabular-nums text-green-700">
                    −{formatMoney(currentPricing.groupDiscountAmount)}
                  </dd>
                </div>
              )}
              {currentPricing.promoDiscountAmount > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="min-w-0 break-words text-muted-foreground">
                    Promo code{booking.promoCode ? ` (${booking.promoCode})` : ""}
                  </dt>
                  <dd className="shrink-0 font-medium tabular-nums text-green-700">
                    −{formatMoney(currentPricing.promoDiscountAmount)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="shrink-0 font-medium tabular-nums">
                  {formatMoney(currentPricing.subtotalAfterDiscounts)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">VAT (20%)</dt>
                <dd className="shrink-0 font-medium tabular-nums">
                  {formatMoney(currentPricing.vatAmount)}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2 border-y border-primary/15 py-5">
              <span className="text-base font-bold">Total including VAT</span>
              <strong className="text-3xl font-extrabold tracking-tight tabular-nums sm:text-4xl">
                {formatMoney(currentPricing.total)}
              </strong>
            </div>
          </>
        ) : !calculatePricingMutation.isError ? (
          <p role="status" className="py-6 text-sm text-muted-foreground">
            Updating your total…
          </p>
        ) : null}

        <div className="space-y-4 pt-5">
          <p className="break-words text-sm leading-relaxed text-muted-foreground">
            {paymentMethod === "invoice" ? (
              <>
                This confirms your {booking.quantity === 1 ? "place" : "places"} and emails the
                invoice to {invoiceRecipient || "your billing contact"}. No payment is taken now.
              </>
            ) : (
              <>
                Continue to Stripe to pay securely. We’ll confirm your booking and email the lead
                attendee after payment.
              </>
            )}
          </p>
          {paymentError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              <p className="mb-1 font-semibold">We couldn't complete that step</p>
              <p className="break-words">{paymentError}</p>
              <p className="mt-2">
                If this continues,{" "}
                <a href="mailto:douglas@peoplestrategyhub.com" className="underline">
                  contact the event team
                </a>{" "}
                for help.
              </p>
            </div>
          )}
          <Button
            size="lg"
            className="swp-primary-btn h-auto min-h-12 w-full min-w-0 whitespace-normal rounded-md px-5 py-3 text-base leading-snug"
            onClick={() => {
              if (paymentMethod === "invoice") {
                void form.handleSubmit(onSubmit)();
              } else {
                void onSubmit();
              }
            }}
            disabled={isProcessing || !currentPricing}
          >
            <span>{submitLabel}</span>
          </Button>
          {paymentMethod === "invoice" && (
            <p className="text-center text-sm leading-relaxed text-muted-foreground">
              Payment due within 14 days, or before the event if sooner.
            </p>
          )}
          <SaveAndReturnButton
            onSave={savePaymentProgress}
            disabled={isProcessing}
            appearance="link"
          />
        </div>
        <div className="mt-5 border-t border-primary/15 pt-4 text-center">
          <a
            href="mailto:douglas@peoplestrategyhub.com"
            className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline underline-offset-4"
          >
            Need help? Contact the event team
          </a>
        </div>
      </aside>
    </div>
  );
}
