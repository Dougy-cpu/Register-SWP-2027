import { useState, useEffect, useRef, type ReactNode } from "react";
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
  Building2,
  Landmark,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { BookingWithAttendees } from "@/types/booking";

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
    <div className="flex items-center justify-between gap-3 mb-1.5">
      <FormLabel className="!mb-0">{label}</FormLabel>
      {canLink && linked && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full"
          title="This field is linked to your lead attendee. Editing it unlinks just this field."
          data-testid={`linked-${field}`}
        >
          <Link2 className="w-3 h-3" /> Same as lead attendee
        </span>
      )}
      {canLink && !linked && (
        <button
          type="button"
          onClick={onRelink}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-primary"
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
  return `GBP ${value.toFixed(2)}`;
}

function markCompletionReturn() {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  url.searchParams.set("step", "5");
  window.history.replaceState({ ...(window.history.state ?? {}), checkoutStep: 5 }, "", url);
}

function StepBadge({ value }: { value: number }) {
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
      {value}
    </span>
  );
}

function NextStep({ value, children }: { value: number; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] items-start gap-3 text-sm text-muted-foreground">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-50 text-xs font-bold text-green-700">
        {value}
      </span>
      <span>{children}</span>
    </li>
  );
}

function InvoiceProcessStep({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-3 rounded-lg border border-primary/10 bg-white/85 p-3 shadow-[0_10px_25px_rgba(0,78,185,0.04)]">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <p className="text-sm font-bold text-foreground">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

export default function Step4Payment({ booking }: Step4PaymentProps) {
  const queryClient = useQueryClient();
  const updateBooking = useUpdateBooking();
  const createStripeSession = useCreateStripeCheckoutSession();
  const createInvoice = useCreateStripeInvoice();

  const [paymentMethod, setPaymentMethod] = useState<"card" | "invoice">("card");
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

  const calculatePricingMutation = useCalculatePricing();

  useEffect(() => {
    calculatePricingMutation.mutate({
      data: {
        passType: booking.passType,
        quantity: booking.quantity,
        promoCode: booking.promoCode || undefined,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.passType, booking.quantity]);

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

  const currentPricing = calculatePricingMutation.data;
  const bookingPassLabel = booking.passType === "single" ? "Workforce Pass" : "Business Pass";
  const bookingPassSummary = booking.quantity === 1 ? bookingPassLabel : `${bookingPassLabel}es`;

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
        const savedVal = (savedRaw ?? "").toLowerCase();
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
    },
  });
  const watchedPoNumber = form.watch("poNumber")?.trim();

  const onSubmit = async (data?: z.infer<typeof invoiceSchema>) => {
    setIsProcessing(true);
    setPaymentError(null);
    try {
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
    setIsFreeConfirming(true);
    setPaymentError(null);
    try {
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
            <div className="bg-red-50 border border-red-200 rounded p-4 text-sm text-red-800">
              <p className="font-semibold mb-1">Error</p>
              <p>{paymentError}</p>
            </div>
          )}

          <div className="space-y-3 pt-4">
            <div className="flex justify-between">
              <Button
                variant="outline"
                size="lg"
                className="px-8 h-14 text-lg border-border"
                onClick={async () => {
                  await updateBooking.mutateAsync({ id: booking.id, data: { currentStep: 3 } });
                  queryClient.invalidateQueries({ queryKey: ["booking"] });
                }}
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

  if (!isFreeBooking) {
    const submitLabel = isProcessing
      ? "Processing..."
      : paymentMethod === "card"
        ? "Proceed to secure card payment"
        : "Confirm registration and email invoice";

    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-widest text-primary">Step 4 of 4</p>
          <h1 className="text-4xl md:text-5xl font-bold">Final checkout</h1>
          <p className="max-w-3xl text-lg text-muted-foreground">
            Pay securely by card, or request a VAT invoice with supplier details, bank information
            and payment instructions. VAT and the final total are shown before confirmation.
          </p>
        </div>

        <div className="swp-metric-strip grid grid-cols-1 divide-y divide-primary/10 overflow-hidden sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="min-h-[82px] p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Booking
            </p>
            <p className="mt-1 text-lg font-bold">
              {booking.quantity} {bookingPassSummary}
            </p>
          </div>
          <div className="min-h-[82px] p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Payment choice
            </p>
            <p className="mt-1 text-lg font-bold">
              {paymentMethod === "card" ? "Card" : "Invoice"}
            </p>
          </div>
          <div className="min-h-[82px] p-4">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Total due
            </p>
            <p className="mt-1 text-lg font-bold">{formatMoney(currentPricing?.total)}</p>
          </div>
        </div>

        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <section className="swp-card rounded-2xl">
              <div className="border-b border-border/70 p-5">
                <h2 className="text-xl font-bold">Choose payment method</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick the route that matches your procurement process.
                </p>
              </div>
              <div className="p-5">
                <RadioGroup
                  value={paymentMethod}
                  onValueChange={(val: "card" | "invoice") => setPaymentMethod(val)}
                  className="grid gap-4 md:grid-cols-2"
                >
                  <div
                    className={`min-h-[128px] cursor-pointer rounded-lg border-2 p-5 transition-all hover:-translate-y-1 hover:shadow-[0_12px_30px_rgba(0,78,185,0.08)] ${
                      paymentMethod === "card"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40"
                    }`}
                    onClick={() => setPaymentMethod("card")}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <RadioGroupItem value="card" className="mt-1" />
                        <div>
                          <div className="flex items-center gap-2">
                            <CreditCard className="h-5 w-5 text-primary" />
                            <span className="text-lg font-bold">Pay by card now</span>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Pay securely through Stripe and confirm your booking immediately.
                          </p>
                        </div>
                      </div>
                      {paymentMethod === "card" && (
                        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
                          Selected
                        </span>
                      )}
                    </div>
                  </div>

                  <div
                    className={`min-h-[128px] cursor-pointer rounded-lg border-2 p-5 transition-all hover:-translate-y-1 hover:shadow-[0_12px_30px_rgba(0,78,185,0.08)] ${
                      paymentMethod === "invoice"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40"
                    }`}
                    onClick={() => setPaymentMethod("invoice")}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <RadioGroupItem value="invoice" className="mt-1" />
                        <div>
                          <div className="flex items-center gap-2">
                            <FileText className="h-5 w-5 text-primary" />
                            <span className="text-lg font-bold">Pay by invoice</span>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Confirm registration and receive a VAT invoice with supplier details,
                            bank information, payment instructions and a secure Stripe payment link.
                          </p>
                        </div>
                      </div>
                      {paymentMethod === "invoice" && (
                        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
                          Selected
                        </span>
                      )}
                    </div>
                  </div>
                </RadioGroup>
              </div>
            </section>

            {paymentMethod === "invoice" && (
              <section className="swp-card rounded-2xl">
                <div className="flex flex-col gap-3 border-b border-border/70 p-5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-xl font-bold">Billing details for the invoice</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      These details appear on your VAT invoice. You can update billing details or
                      add a PO number later using the secure billing link in the invoice email.
                    </p>
                  </div>
                </div>

                <div className="space-y-4 p-5">
                  <div className="overflow-hidden rounded-xl border border-primary/20 bg-[linear-gradient(135deg,#f0f6ff_0%,#ffffff_100%)] p-5 shadow-[0_18px_45px_rgba(0,78,185,0.08)]">
                    <div className="flex flex-col gap-4">
                      <div className="max-w-3xl">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">
                          How invoice payment works
                        </p>
                        <h3 className="mt-2 text-xl font-extrabold tracking-[-0.02em] text-foreground">
                          Built for procurement and finance teams
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                          Invoice payment is a first-class checkout route for procurement or
                          finance-led bookings. If you are ready to pay by card now, use the card
                          option above.
                        </p>
                      </div>
                      <div className="flex items-start gap-3 rounded-lg border border-primary/15 bg-white/80 p-3 text-sm leading-relaxed text-muted-foreground">
                        <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <p>
                          The invoice email includes supplier details, bank information, payment
                          instructions and a secure Stripe payment link for your finance team.
                        </p>
                      </div>
                    </div>

                    <ol className="mt-5 grid gap-3 md:grid-cols-3">
                      <InvoiceProcessStep icon={CheckCircle2} title="Confirm and issue">
                        Your registration is confirmed when the invoice is issued and emailed.
                      </InvoiceProcessStep>
                      <InvoiceProcessStep icon={Building2} title="Finance-ready details">
                        Supplier details, bank information, payment instructions and a secure Stripe
                        payment link are included.
                      </InvoiceProcessStep>
                      <InvoiceProcessStep icon={Landmark} title="Pay or update later">
                        Add a PO now, or add it later through the secure billing link before
                        payment.
                      </InvoiceProcessStep>
                    </ol>
                  </div>

                  {invoiceHelpContent && (
                    <div className="rounded-lg border border-border bg-white p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-start gap-3">
                          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                          <div>
                            <p className="font-bold">More invoice details</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              Extra invoice guidance is available if your finance team needs it.
                            </p>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full border-primary bg-white text-primary hover:bg-primary/5 sm:w-auto"
                          onClick={() => setHelpExpanded((v) => !v)}
                          aria-expanded={helpExpanded}
                        >
                          {helpExpanded ? "Hide details" : "View full details"}
                        </Button>
                      </div>
                      {helpExpanded && (
                        <div className="mt-4 border-t border-primary/15 pt-4 text-sm leading-relaxed">
                          <InvoiceHelpRendered text={invoiceHelpContent} />
                        </div>
                      )}
                    </div>
                  )}

                  <Form {...form}>
                    <form
                      className="space-y-4"
                      id="invoice-form"
                      onSubmit={form.handleSubmit(onSubmit)}
                    >
                      <section className="rounded-xl border border-primary/15 bg-primary/[0.018] p-4">
                        <div className="mb-4 flex items-start gap-3">
                          <StepBadge value={1} />
                          <div>
                            <h3 className="font-bold">Billing contact</h3>
                            <p className="text-sm text-muted-foreground">
                              Linked to lead attendee unless manually changed.
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                          <FormField
                            control={form.control}
                            name="billingName"
                            render={({ field }) => (
                              <FormItem>
                                <LinkedFieldLabel
                                  label="Billing contact name *"
                                  field="billingName"
                                  linked={linkedFields.billingName}
                                  canLink={!!getLeadValue("billingName")}
                                  onRelink={() => relinkField("billingName")}
                                />
                                <FormControl>
                                  <Input
                                    {...field}
                                    onChange={(e) => {
                                      field.onChange(e);
                                      unlinkField("billingName");
                                    }}
                                    className="h-12 bg-white"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingCompany"
                            render={({ field }) => (
                              <FormItem>
                                <LinkedFieldLabel
                                  label="Company name *"
                                  field="billingCompany"
                                  linked={linkedFields.billingCompany}
                                  canLink={!!getLeadValue("billingCompany")}
                                  onRelink={() => relinkField("billingCompany")}
                                />
                                <FormControl>
                                  <Input
                                    {...field}
                                    onChange={(e) => {
                                      field.onChange(e);
                                      unlinkField("billingCompany");
                                    }}
                                    className="h-12 bg-white"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingEmail"
                            render={({ field }) => (
                              <FormItem>
                                <LinkedFieldLabel
                                  label="Invoice email address *"
                                  field="billingEmail"
                                  linked={linkedFields.billingEmail}
                                  canLink={!!getLeadValue("billingEmail")}
                                  onRelink={() => relinkField("billingEmail")}
                                />
                                <FormControl>
                                  <Input
                                    type="email"
                                    {...field}
                                    onChange={(e) => {
                                      field.onChange(e);
                                      unlinkField("billingEmail");
                                    }}
                                    className="h-12 bg-white"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingPhone"
                            render={({ field }) => (
                              <FormItem>
                                <LinkedFieldLabel
                                  label="Purchaser contact number *"
                                  field="billingPhone"
                                  linked={linkedFields.billingPhone}
                                  canLink={!!getLeadValue("billingPhone")}
                                  onRelink={() => relinkField("billingPhone")}
                                />
                                <FormControl>
                                  <Input
                                    type="tel"
                                    {...field}
                                    onChange={(e) => {
                                      field.onChange(e);
                                      unlinkField("billingPhone");
                                    }}
                                    className="h-12 bg-white"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      </section>

                      <section className="rounded-xl border border-primary/15 bg-primary/[0.018] p-4">
                        <div className="mb-4 flex items-start gap-3">
                          <StepBadge value={2} />
                          <div>
                            <h3 className="font-bold">Billing address</h3>
                            <p className="text-sm text-muted-foreground">
                              Address fields stay together so the form is easier to scan.
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                          <FormField
                            control={form.control}
                            name="billingAddressLine1"
                            render={({ field }) => (
                              <FormItem className="md:col-span-2">
                                <FormLabel>Address line 1 *</FormLabel>
                                <FormControl>
                                  <Input {...field} className="h-12 bg-white" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingAddressLine2"
                            render={({ field }) => (
                              <FormItem className="md:col-span-2">
                                <FormLabel>
                                  Address line 2{" "}
                                  <span className="font-normal text-muted-foreground">
                                    (optional)
                                  </span>
                                </FormLabel>
                                <FormControl>
                                  <Input {...field} className="h-12 bg-white" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingTown"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Town / City *</FormLabel>
                                <FormControl>
                                  <Input {...field} className="h-12 bg-white" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingRegion"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  Region / County{" "}
                                  <span className="font-normal text-muted-foreground">
                                    (optional)
                                  </span>
                                </FormLabel>
                                <FormControl>
                                  <Input {...field} className="h-12 bg-white" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingPostcode"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Postcode *</FormLabel>
                                <FormControl>
                                  <Input {...field} className="h-12 bg-white" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="billingCountry"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Country *</FormLabel>
                                <FormControl>
                                  <Input {...field} className="h-12 bg-white" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      </section>

                      <section className="rounded-xl border border-primary/15 bg-primary/[0.018] p-4">
                        <div className="mb-4 flex items-start gap-3">
                          <StepBadge value={3} />
                          <div>
                            <h3 className="font-bold">Invoice references</h3>
                            <p className="text-sm text-muted-foreground">
                              Add a PO now if you have one. If not, you can confirm registration and
                              add it later before payment through the secure billing link.
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                          <FormField
                            control={form.control}
                            name="billingVatNumber"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  VAT number{" "}
                                  <span className="font-normal text-muted-foreground">
                                    (optional)
                                  </span>
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    {...field}
                                    placeholder="Optional"
                                    className="h-12 bg-white"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="poNumber"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  PO number{" "}
                                  <span className="font-normal text-muted-foreground">
                                    (optional)
                                  </span>
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    {...field}
                                    placeholder="e.g. PO-12345"
                                    className="h-12 bg-white"
                                    maxLength={30}
                                  />
                                </FormControl>
                                <FormMessage />
                                {watchedPoNumber ? (
                                  <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-primary">
                                    <p className="font-bold">PO number ready for invoice.</p>
                                    <p className="mt-1">
                                      This PO number will appear on the invoice when you confirm
                                      registration.
                                    </p>
                                  </div>
                                ) : (
                                  <div className="rounded-md border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
                                    <p className="font-bold text-foreground">
                                      No PO number yet? That is fine.
                                    </p>
                                    <p className="mt-1">
                                      You can confirm registration now and add the PO later using
                                      the secure billing link in the invoice email. Once added, we
                                      will automatically email a revised invoice with the PO
                                      included.
                                    </p>
                                  </div>
                                )}
                              </FormItem>
                            )}
                          />
                        </div>
                      </section>
                    </form>
                  </Form>
                </div>
              </section>
            )}

            {paymentError && (
              <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <p className="mb-1 font-semibold">Payment error</p>
                <p>{paymentError}</p>
                <p className="mt-2 text-red-700">
                  If this continues, please email us at{" "}
                  <a href="mailto:douglas@peoplestrategyhub.com" className="underline">
                    douglas@peoplestrategyhub.com
                  </a>{" "}
                  to complete your registration.
                </p>
              </div>
            )}
          </div>

          <aside className="swp-checkout-sticky-sidebar space-y-5 md:self-start">
            <section className="swp-card overflow-hidden rounded-2xl">
              <div className="border-b border-border/70 p-5">
                <h3 className="text-lg font-bold">Order summary</h3>
              </div>
              <div className="space-y-3 p-5">
                {currentPricing ? (
                  <>
                    <div className="flex justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">Pass type</span>
                      <strong className="text-right">{bookingPassLabel}</strong>
                    </div>
                    <div className="flex justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">Quantity</span>
                      <strong>{booking.quantity}</strong>
                    </div>
                    <div className="flex justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">Subtotal</span>
                      <strong>{formatMoney(currentPricing.baseSubtotal)}</strong>
                    </div>
                    {currentPricing.groupDiscountAmount > 0 && (
                      <div className="flex justify-between gap-4 text-sm font-bold text-primary">
                        <span>Group discount</span>
                        <span>-{formatMoney(currentPricing.groupDiscountAmount)}</span>
                      </div>
                    )}
                    {currentPricing.promoDiscountAmount > 0 && (
                      <div className="flex justify-between gap-4 text-sm font-bold text-primary">
                        <span>Promo code</span>
                        <span>-{formatMoney(currentPricing.promoDiscountAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">VAT (20%)</span>
                      <strong>{formatMoney(currentPricing.vatAmount)}</strong>
                    </div>
                    <div className="flex justify-between gap-4 border-t border-border pt-4 text-xl font-bold">
                      <span>Total</span>
                      <span>{formatMoney(currentPricing.total)}</span>
                    </div>
                  </>
                ) : (
                  <div className="animate-pulse space-y-3">
                    <div className="h-4 rounded bg-border" />
                    <div className="h-4 rounded bg-border" />
                    <div className="h-4 rounded bg-border" />
                  </div>
                )}
              </div>
            </section>

            <div className="space-y-5">
              <section className="swp-card rounded-2xl p-5">
                <div className="flex flex-col gap-3">
                  {paymentMethod === "invoice" && (
                    <div className="rounded-lg border border-primary/15 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
                      <p className="font-bold text-foreground">Ready to issue the invoice?</p>
                      <p className="mt-1">
                        This confirms the registration and emails the invoice immediately to the
                        billing contact. The invoice includes supplier details, bank information,
                        payment instructions and a secure Stripe payment link. PO and billing
                        details can still be updated before payment from the secure billing link.
                      </p>
                    </div>
                  )}
                  <Button
                    size="lg"
                    className="swp-primary-btn h-14 w-full min-w-0 px-6 text-base"
                    onClick={() => {
                      if (paymentMethod === "invoice") {
                        void form.handleSubmit(onSubmit)();
                      } else {
                        void onSubmit();
                      }
                    }}
                    disabled={isProcessing}
                  >
                    {submitLabel}
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-12 w-full min-w-0 border-border bg-white px-5 text-sm"
                    onClick={async () => {
                      setPaymentError(null);
                      try {
                        await updateBooking.mutateAsync({
                          id: booking.id,
                          data: { currentStep: 3 },
                        });
                        queryClient.invalidateQueries({ queryKey: ["booking"] });
                      } catch (e) {
                        const err = e as { data?: { error?: string }; message?: string };
                        setPaymentError(
                          err?.data?.error ||
                            err?.message ||
                            "We could not return to attendee details. Please try again.",
                        );
                      }
                    }}
                    disabled={isProcessing}
                  >
                    Back to attendees
                  </Button>
                  <SaveAndReturnButton
                    onSave={savePaymentProgress}
                    disabled={isProcessing}
                    buttonClassName="text-base"
                  />
                </div>
              </section>

              <section className="swp-card overflow-hidden rounded-2xl">
                <div className="flex items-center justify-between gap-4 border-b border-border/70 p-5">
                  <h3 className="text-lg font-bold">What happens next</h3>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
                    {paymentMethod === "card" ? "Card selected" : "Invoice selected"}
                  </span>
                </div>
                <div className="p-5">
                  <ol className="space-y-3">
                    {paymentMethod === "card" ? (
                      <>
                        <NextStep value={1}>You are taken to Stripe to pay securely.</NextStep>
                        <NextStep value={2}>
                          Your booking is confirmed after successful payment.
                        </NextStep>
                        <NextStep value={3}>
                          A confirmation email is sent to the lead attendee.
                        </NextStep>
                      </>
                    ) : (
                      <>
                        <NextStep value={1}>
                          Registration is confirmed when the invoice is issued and emailed.
                        </NextStep>
                        <NextStep value={2}>
                          Supplier details, bank information, payment instructions and a secure
                          Stripe payment link are included.
                        </NextStep>
                        <NextStep value={3}>
                          Pay by bank transfer or Stripe, and update PO or billing details securely
                          before payment.
                        </NextStep>
                      </>
                    )}
                  </ol>
                </div>
              </section>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return null;
}
