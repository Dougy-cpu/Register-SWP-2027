import { useState, useEffect, useRef, useCallback } from "react";
import {
  useUpdateBooking,
  useListDiscountTiers,
  customFetch,
  type PricingRequestPassType,
  type DiscountTier,
  type PricingBreakdown,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SaveAndReturnButton from "@/components/checkout/SaveAndReturnButton";
import { Check, Minus, Plus, ArrowLeft, ArrowRight, Tag, X } from "lucide-react";
import type { BookingWithAttendees } from "@/types/booking";
import { CompShortfallPrompt } from "./CompShortfallPrompt";
import { calculateCheckoutPricing } from "@/lib/checkout-pricing";

interface Step2PassesProps {
  booking: BookingWithAttendees;
  onAdvance?: (step: number) => void;
}

const DEFAULT_SINGLE_BENEFITS = [
  "Full summit day",
  "Main stage keynotes and content forums",
  "Planning Lab sessions",
  "PowerPulse and optional Quickfire sessions",
  "Personalised agenda creator before the event",
  "Networking breaks, lunch and drinks reception",
  "Session slides and recordings after the event",
];

const DEFAULT_BUSINESS_EXTRA_BENEFITS = [
  "This is an attendee pass, not a sponsorship package.",
  "Speaking, branding, sponsor visibility and VIP invitations are handled separately.",
];

const DEFAULT_PRICING_PERIOD = "Super Early Bird";

interface PassConfig {
  passType: string;
  currentPrice: string;
  originalPrice: string;
  pricingPeriodName: string;
  benefits: string[];
  extraBenefits: string[];
}

const FALLBACK_HEAR_OPTIONS = [
  "LinkedIn",
  "Google / Search engine",
  "Email newsletter",
  "Word of mouth / Colleague",
  "Previous attendee",
  "Industry publication or press",
  "Podcast",
  "Social media",
  "Other",
];

function getNextTier(tiers: DiscountTier[], passType: string, qty: number): DiscountTier | null {
  const relevant = tiers
    .filter((t) => t.passType === passType)
    .sort((a, b) => a.minQuantity - b.minQuantity);
  return relevant.find((t) => t.minQuantity > qty) ?? null;
}

export default function Step2Passes({ booking, onAdvance }: Step2PassesProps) {
  const updateBooking = useUpdateBooking();
  const isHR = booking.attendeeType === "hr_professional";
  const isVendor = booking.attendeeType === "consultant_vendor";

  const resolveInitialPass = (): PricingRequestPassType => {
    const stored = booking.passType as PricingRequestPassType;
    if (isVendor) return "business";
    if (isHR && stored === "business") return "single";
    return stored || "single";
  };

  const [selectedPass] = useState<PricingRequestPassType>(resolveInitialPass);
  const [quantity, setQuantity] = useState<number>(() => booking.quantity || 1);
  const [inventory, setInventory] = useState<Record<string, number | null>>({
    single: null,
    business: null,
  });
  const [inventoryKnown, setInventoryKnown] = useState(false);
  const [passConfig, setPassConfig] = useState<Record<string, PassConfig | null>>({
    single: null,
    business: null,
  });

  const [linkPromo] = useState(
    () => new URLSearchParams(window.location.search).get("promo")?.trim().toUpperCase() || null,
  );
  const [promoInput, setPromoInput] = useState<string>(booking.promoCode ? "" : (linkPromo ?? ""));
  const [appliedPromoCode, setAppliedPromoCode] = useState<string | null>(
    booking.promoCode ?? null,
  );
  const [appliedViaLink, setAppliedViaLink] = useState<boolean>(false);
  const [promoExpanded, setPromoExpanded] = useState(!!booking.promoCode || !!linkPromo);
  const [promoError, setPromoError] = useState<string | null>(null);
  const promoRequestId = useRef(0);
  const [promoCandidate, setPromoCandidate] = useState<{
    code: string;
    viaLink: boolean;
    id: number;
  } | null>(() =>
    linkPromo && !booking.promoCode ? { code: linkPromo, viaLink: true, id: 0 } : null,
  );
  const promoValidating = promoCandidate !== null;
  const [saveError, setSaveError] = useState<string | null>(null);

  const leadEmail = booking.attendees?.find((a) => a.isLead)?.workEmail ?? null;

  const [hearAboutUs, setHearAboutUs] = useState<string>(
    ((booking as unknown as Record<string, unknown>).hearAboutUs as string) ?? "",
  );
  const [hearOptions, setHearOptions] = useState<string[]>(FALLBACK_HEAR_OPTIONS);
  const hauFetched = useRef(false);

  const queryClient = useQueryClient();

  const { data: allTiers = [] } = useListDiscountTiers();

  // Pricing fetch: trailing-debounced + abortable. We tag every request with
  // a monotonically-increasing reqId and only commit the response when it
  // matches the latest request — this drops out-of-order responses caused by
  // rapid quantity changes (which would otherwise leave the order summary
  // showing a price for the wrong quantity).
  const pricingKey = JSON.stringify([selectedPass, quantity, appliedPromoCode]);
  const [quote, setQuote] = useState<{ key: string; data: PricingBreakdown } | null>(null);
  // A changed selection must invalidate the old quote immediately, before the effect runs.
  const currentPricing = quote?.key === pricingKey ? quote.data : null;
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingAttempt, setPricingAttempt] = useState(0);
  const pricingReqIdRef = useRef(0);

  useEffect(() => {
    fetch("/api/passes/inventory")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (
          data &&
          ["single", "business"].every(
            (type) => data[type] === null || (typeof data[type] === "number" && data[type] >= 0),
          )
        ) {
          setInventory(data);
          setInventoryKnown(true);
        }
      })
      .catch(() => {});
    fetch("/api/passes/config")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => setPassConfig(data))
      .catch(() => {});
    if (!hauFetched.current) {
      hauFetched.current = true;
      fetch("/api/hear-about-us-options")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { label: string }[] | null) => {
          if (Array.isArray(data) && data.length > 0) {
            setHearOptions(data.map((o) => o.label));
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    const reqId = ++pricingReqIdRef.current;
    const ac = new AbortController();
    setPricingLoading(true);
    setPricingError(null);
    const timer = setTimeout(() => {
      calculateCheckoutPricing(
        { passType: selectedPass, quantity, promoCode: appliedPromoCode ?? undefined },
        { signal: ac.signal },
      )
        .then((data) => {
          // Drop the response if a newer request has been issued in the meantime
          if (!ac.signal.aborted && reqId === pricingReqIdRef.current) {
            setQuote({ key: pricingKey, data });
            setPricingLoading(false);
          }
        })
        .catch(() => {
          if (!ac.signal.aborted && reqId === pricingReqIdRef.current) {
            setQuote(null);
            setPricingLoading(false);
            setPricingError("We couldn't update your total. Please retry before continuing.");
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [selectedPass, quantity, appliedPromoCode, pricingKey, pricingAttempt]);

  // Complimentary codes are capped by pass count, not booking count. When
  // the requested quantity exceeds the seats remaining on the comp code, the
  // server returns the code as applied but does not zero out the price — the
  // user must either reduce their quantity or remove the code before they
  // can continue.
  const compRemaining =
    currentPricing?.promoDiscountType === "complimentary"
      ? (currentPricing.promoRemainingSeats ?? null)
      : null;
  const compShortfall = compRemaining !== null && compRemaining < quantity;
  const handleReduceToCompCap = () => {
    if (compRemaining !== null && compRemaining > 0) setQuantity(compRemaining);
  };

  const validatePromo = useCallback(
    async (
      codeToValidate: string,
      signal: AbortSignal,
    ): Promise<{ ok: boolean; code?: string; error?: string }> => {
      try {
        const res = await customFetch(`/api/promo-codes/validate`, {
          method: "POST",
          signal,
          body: JSON.stringify({
            code: codeToValidate,
            passType: selectedPass,
            quantity,
            leadEmail: leadEmail ?? undefined,
          }),
        });
        const data = res as {
          valid?: boolean;
          error?: string;
          code?: string;
          remainingSeats?: number | null;
        } | null;
        if (data?.valid && data?.code) return { ok: true, code: data.code };
        return {
          ok: false,
          error: typeof data?.error === "string" ? data.error : "Invalid promo code",
        };
      } catch (e: unknown) {
        if (signal.aborted)
          return { ok: false, error: "We couldn't check this code. Please try again." };
        const err = e as Record<string, unknown> | null;
        const apiMsg =
          err?.data && typeof (err.data as Record<string, unknown>)?.error === "string"
            ? ((err.data as Record<string, unknown>).error as string)
            : null;
        const fallbackMsg = typeof err?.message === "string" ? err.message : null;
        return { ok: false, error: apiMsg || fallbackMsg || "Invalid or expired promo code" };
      }
    },
    [selectedPass, quantity, leadEmail],
  );

  const clearLinkPromo = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("promo");
    window.history.replaceState(window.history.state, "", url);
  };

  const handleApplyPromo = () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    clearLinkPromo();
    setPromoError(null);
    setPromoCandidate({ code, viaLink: false, id: ++promoRequestId.current });
  };

  const handleRemovePromo = () => {
    ++promoRequestId.current;
    setPromoCandidate(null);
    setAppliedPromoCode(null);
    setAppliedViaLink(false);
    setPromoInput("");
    setPromoError(null);
    // Respect deliberate removal across quantity changes, refresh and returning to this step.
    clearLinkPromo();
  };

  // Both link and typed codes use the same cancellable check. A stale response
  // cannot replace a newer choice, and a linked code blocks Continue while checking.
  useEffect(() => {
    if (!promoCandidate) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let cancelled = false;
    (async () => {
      const result = await validatePromo(promoCandidate.code, controller.signal);
      if (cancelled || promoCandidate.id !== promoRequestId.current) return;
      clearTimeout(timeout);
      setPromoCandidate(null);
      if (result.ok && result.code) {
        setAppliedPromoCode(result.code);
        setAppliedViaLink(promoCandidate.viaLink);
        setPromoInput("");
        setPromoError(null);
      } else {
        setPromoError(result.error ?? "Invalid promo code");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [promoCandidate, validatePromo]);

  const savePassSelection = async (currentStep: number) => {
    await updateBooking.mutateAsync({
      id: booking.id,
      data: {
        passType: selectedPass as "single" | "business",
        quantity,
        promoCode: appliedPromoCode,
        hearAboutUs: hearAboutUs || undefined,
        currentStep,
      } as Parameters<typeof updateBooking.mutateAsync>[0]["data"],
    });
    queryClient.invalidateQueries({ queryKey: ["booking"] });
  };

  const handleContinue = async () => {
    if (!currentPricing || pricingLoading || pricingError || promoValidating || compShortfall)
      return;
    setSaveError(null);
    try {
      await savePassSelection(3);
      onAdvance?.(3);
    } catch {
      setSaveError("We could not save your pass selection. Please try again.");
    }
  };

  const handleSaveAndReturn = async () => {
    if (promoValidating) throw new Error("Please wait while we check your promo code.");
    await savePassSelection(2);
  };

  const maxQuantity = selectedPass === "business" ? 10 : 20;
  const remaining = inventory[selectedPass];
  const nextTier = getNextTier(allTiers, selectedPass, quantity);
  const nextQuantity = nextTier?.minQuantity ?? 0;
  const canOfferGroup =
    !!currentPricing &&
    !pricingLoading &&
    !pricingError &&
    !promoValidating &&
    !updateBooking.isPending &&
    inventoryKnown &&
    currentPricing.total > 0 &&
    currentPricing.promoDiscountType !== "complimentary" &&
    nextQuantity > quantity &&
    nextQuantity <= maxQuantity &&
    (remaining === null || nextQuantity <= remaining);
  const offerKey = JSON.stringify([
    selectedPass,
    quantity,
    appliedPromoCode,
    nextQuantity,
    currentPricing?.total,
    currentPricing?.groupDiscountPercent,
  ]);
  const [groupQuote, setGroupQuote] = useState<{ key: string; data: PricingBreakdown } | null>(
    null,
  );
  const groupOffer =
    canOfferGroup &&
    groupQuote?.key === offerKey &&
    groupQuote.data.total > 0 &&
    groupQuote.data.promoDiscountType !== "complimentary" &&
    groupQuote.data.groupDiscountPercent > (currentPricing?.groupDiscountPercent ?? 0)
      ? groupQuote.data
      : null;

  // An optional group offer uses the same authoritative pricing and promo rules
  // as checkout. Failure here never blocks a valid current selection.
  useEffect(() => {
    if (!canOfferGroup) return;
    const controller = new AbortController();
    calculateCheckoutPricing(
      { passType: selectedPass, quantity: nextQuantity, promoCode: appliedPromoCode ?? undefined },
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setGroupQuote({ key: offerKey, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setGroupQuote(null);
      });
    return () => controller.abort();
  }, [canOfferGroup, selectedPass, nextQuantity, appliedPromoCode, offerKey]);

  const config = passConfig[selectedPass];
  const currentPrice =
    currentPricing?.pricePerHead ?? (config ? Number(config.currentPrice) : null);
  const periodName = config?.pricingPeriodName ?? DEFAULT_PRICING_PERIOD;
  const benefits = config?.benefits.length ? config.benefits : DEFAULT_SINGLE_BENEFITS;
  const extraBenefits = config?.extraBenefits.length
    ? config.extraBenefits
    : DEFAULT_BUSINESS_EXTRA_BENEFITS;
  const passLabel = selectedPass === "business" ? "Business Pass" : "Workforce Pass";
  const relevantTiers = allTiers
    .filter((tier) => tier.passType === selectedPass)
    .sort((a, b) => a.minQuantity - b.minQuantity);
  const blocked =
    !currentPricing ||
    pricingLoading ||
    !!pricingError ||
    promoValidating ||
    !booking.id ||
    compShortfall ||
    updateBooking.isPending;
  const money = (value: number) =>
    `£${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const handleBack = async () => {
    setSaveError(null);
    try {
      await savePassSelection(1);
      onAdvance?.(1);
    } catch {
      setSaveError("We could not save your pass selection. Please try again.");
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.8fr)_minmax(340px,1fr)] lg:gap-6">
      <section className="min-w-0 lg:border-r lg:border-primary/15 lg:pr-6">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
          Choose your passes
        </h1>
        <p className="mt-3 text-base text-muted-foreground md:text-lg">
          Group savings are applied automatically. You can add attendee names next.
        </p>

        <div className="mt-6 flex flex-col justify-between gap-5 sm:flex-row sm:gap-8">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold md:text-3xl">{passLabel}</h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base">
              {isVendor
                ? "For consultants, vendors and organisations providing products or services to workforce and HR teams."
                : "For employer-side HR, people and workforce professionals. This pass is not available to consultants or vendors."}
            </p>
            <Button
              type="button"
              variant="link"
              className="mt-1 min-h-11 px-0 text-sm font-normal underline"
              onClick={handleBack}
              disabled={updateBooking.isPending || promoValidating}
            >
              Change booking type
            </Button>
          </div>
          <div className="shrink-0 sm:text-right">
            <p className="inline-block rounded bg-[#f0f6ff] px-3 py-1 text-sm font-semibold text-primary">
              {periodName}
            </p>
            <p className="mt-1 text-4xl font-bold tracking-tight md:text-5xl">
              {currentPrice === null
                ? "—"
                : `£${currentPrice.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">per person, excluding VAT</p>
            {currentPrice !== null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {money(currentPrice * 1.2)} including VAT
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <label id="pass-quantity-label" className="text-base font-semibold">
              Number of passes
            </label>
            {inventoryKnown && remaining !== null && (
              <p className="mt-1 text-sm text-muted-foreground">
                {remaining} {remaining === 1 ? "place" : "places"} available
              </p>
            )}
          </div>
          <div
            role="group"
            aria-labelledby="pass-quantity-label"
            className="flex h-12 w-40 shrink-0 overflow-hidden rounded-md border border-border bg-white"
          >
            <button
              type="button"
              aria-label="Decrease pass quantity"
              className="flex w-12 items-center justify-center hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1 || updateBooking.isPending}
            >
              <Minus className="h-4 w-4" />
            </button>
            <output
              aria-live="polite"
              className="flex flex-1 items-center justify-center border-x border-border text-xl font-semibold"
            >
              {quantity}
            </output>
            <button
              type="button"
              aria-label="Increase pass quantity"
              className="flex w-12 items-center justify-center hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
              disabled={
                quantity >= maxQuantity ||
                updateBooking.isPending ||
                (inventoryKnown && remaining !== null && quantity >= remaining)
              }
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {groupOffer && (
          <div
            className="mt-5 flex flex-col items-start gap-3 rounded-lg border border-primary/15 bg-[#f0f6ff] p-4 sm:flex-row sm:items-center sm:justify-between"
            aria-label="Group savings offer"
          >
            <div>
              <p className="text-base font-semibold text-primary md:text-lg">
                Add {nextQuantity - quantity} more{" "}
                {nextQuantity - quantity === 1 ? "pass" : "passes"} for{" "}
                {groupOffer.groupDiscountPercent}% off all {nextQuantity}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {nextQuantity} passes total:{" "}
                <span className="font-semibold text-foreground">{money(groupOffer.total)}</span>{" "}
                including VAT{appliedPromoCode ? ", with your promo code" : ""}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 border px-4 text-sm"
              onClick={() => setQuantity(nextQuantity)}
            >
              Add {nextQuantity - quantity} {nextQuantity - quantity === 1 ? "pass" : "passes"}
            </Button>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-sm">
          {currentPricing && currentPricing.groupDiscountAmount > 0 && (
            <p className="flex items-center gap-2 py-3 text-primary">
              <Check className="h-4 w-4 shrink-0" />
              {currentPricing.groupDiscountPercent}% group saving applied to your current {quantity}{" "}
              passes
            </p>
          )}
          {relevantTiers.length > 0 && (
            <details className="min-w-0 flex-1 basis-48 sm:text-right">
              <summary className="cursor-pointer py-3 text-primary underline underline-offset-4">
                View all group rates
              </summary>
              <ul className="space-y-2 rounded-md border border-border p-4 text-left text-muted-foreground">
                {relevantTiers.map((tier) => (
                  <li key={tier.id} className="flex justify-between gap-4">
                    <span>{tier.minQuantity}+ passes</span>
                    <span className="font-semibold text-foreground">
                      {tier.discountPercent}% off
                    </span>
                  </li>
                ))}
                <li className="pt-2 text-xs">
                  Applied automatically to all passes in your booking.
                </li>
              </ul>
            </details>
          )}
        </div>

        <div className="mt-2 border-t border-border pt-5">
          <h2 className="text-lg font-semibold">Every pass includes</h2>
          <ul className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {benefits.map((benefit) => (
              <li
                key={benefit}
                className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground"
              >
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>{benefit}</span>
              </li>
            ))}
          </ul>
          {isVendor && (
            <div className="mt-5 space-y-1.5 text-sm text-muted-foreground">
              {extraBenefits.map((benefit) => (
                <p key={benefit}>{benefit}</p>
              ))}
            </div>
          )}
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <label htmlFor="hear-about-us" className="text-sm font-semibold">
            How did you hear about the event?{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <select
            id="hear-about-us"
            aria-label="How did you hear about the event?"
            value={hearAboutUs}
            onChange={(e) => setHearAboutUs(e.target.value)}
            className="mt-2 h-12 w-full rounded-md border border-input bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Select an option…</option>
            {hearOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="link"
          className="mt-5 min-h-11 px-0 font-normal text-muted-foreground"
          onClick={handleBack}
          disabled={updateBooking.isPending || promoValidating}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </section>

      <aside
        aria-label="Your booking"
        className="min-w-0 self-start rounded-xl border border-primary/10 bg-[#f0f6ff] p-5 sm:p-7"
      >
        <h2 className="text-2xl font-bold">Your booking</h2>
        <div className="my-6 border-t border-primary/10" />
        {currentPricing ? (
          <dl className="space-y-4 text-base">
            <div className="flex justify-between gap-4">
              <dt>
                {quantity} × {passLabel}
              </dt>
              <dd className="shrink-0 tabular-nums">{money(currentPricing.baseSubtotal)}</dd>
            </div>
            {currentPricing.groupDiscountAmount > 0 && (
              <div className="flex justify-between gap-4 text-primary">
                <dt>Group saving ({currentPricing.groupDiscountPercent}%)</dt>
                <dd className="shrink-0 tabular-nums">
                  −{money(currentPricing.groupDiscountAmount)}
                </dd>
              </div>
            )}
            {currentPricing.promoDiscountAmount > 0 && (
              <div className="flex justify-between gap-4 text-primary">
                <dt>Promo code saving</dt>
                <dd className="shrink-0 tabular-nums">
                  −{money(currentPricing.promoDiscountAmount)}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t border-primary/10 pt-4">
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{money(currentPricing.subtotalAfterDiscounts)}</dd>
            </div>
            <div className="flex justify-between gap-4 text-muted-foreground">
              <dt>VAT ({Math.round(currentPricing.vatRate * 100)}%)</dt>
              <dd className="tabular-nums">{money(currentPricing.vatAmount)}</dd>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-primary/15 pt-4">
              <dt className="text-xl font-semibold">
                Total
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  Including VAT
                </span>
              </dt>
              <dd className="text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
                {money(currentPricing.total)}
              </dd>
            </div>
          </dl>
        ) : (
          <div role="status" className="py-5 text-sm text-muted-foreground">
            {pricingError ? "Your total is unavailable." : "Updating your total…"}
          </div>
        )}

        <details
          className="mt-6 border-t border-primary/10 pt-2"
          open={promoExpanded || promoValidating || !!promoError}
          onToggle={(event) => setPromoExpanded(event.currentTarget.open)}
        >
          <summary className="cursor-pointer py-3 text-sm font-medium text-primary">
            Have a promo or VIP code?
          </summary>
          {appliedPromoCode ? (
            <div className="space-y-3 pb-3">
              <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 pl-3 text-sm text-green-800">
                <Tag className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 break-all">
                  Code <strong>{appliedPromoCode}</strong> applied
                  {appliedViaLink && <span className="block text-xs">Applied via link</span>}
                </span>
                <button
                  type="button"
                  onClick={handleRemovePromo}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  aria-label="Remove promo code"
                  disabled={updateBooking.isPending}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {compShortfall && compRemaining !== null && (
                <CompShortfallPrompt
                  remaining={compRemaining}
                  quantity={quantity}
                  onReduce={handleReduceToCompCap}
                  onRemove={handleRemovePromo}
                />
              )}
            </div>
          ) : (
            <div className="space-y-2 pb-3">
              <div className="flex gap-2">
                <Input
                  className="h-11 min-w-0 bg-white uppercase"
                  placeholder="Enter code"
                  aria-label="Promo code"
                  aria-invalid={!!promoError}
                  aria-describedby={promoError ? "promo-code-error" : undefined}
                  value={promoInput}
                  onChange={(e) => {
                    setPromoInput(e.target.value.toUpperCase());
                    setPromoError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleApplyPromo();
                    }
                  }}
                  disabled={updateBooking.isPending}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 shrink-0 border px-4"
                  onClick={handleApplyPromo}
                  disabled={promoValidating || !promoInput.trim() || updateBooking.isPending}
                >
                  {promoValidating ? "Checking…" : "Apply"}
                </Button>
              </div>
              {promoError && (
                <p id="promo-code-error" role="alert" className="text-sm text-destructive">
                  {promoError}
                </p>
              )}
            </div>
          )}
        </details>
        {pricingError && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-white p-3 text-sm text-destructive"
          >
            <p>{pricingError}</p>
            <Button
              type="button"
              variant="outline"
              className="mt-2"
              onClick={() => setPricingAttempt((attempt) => attempt + 1)}
              disabled={pricingLoading}
            >
              Retry total
            </Button>
          </div>
        )}
        {saveError && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-white p-3 text-sm text-destructive"
          >
            {saveError}
          </p>
        )}
        <Button
          type="button"
          size="lg"
          className="swp-primary-btn mt-5 min-h-14 w-full whitespace-normal px-4 py-3 text-base font-semibold"
          onClick={handleContinue}
          disabled={blocked}
        >
          {updateBooking.isPending ? "Saving…" : "Continue to Attendees"}
          <ArrowRight className="h-4 w-4" />
        </Button>
        <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
          Attendee names can be confirmed later.
        </p>
        <SaveAndReturnButton
          appearance="link"
          onSave={handleSaveAndReturn}
          disabled={blocked}
          className="mt-3"
        />
        <p className="mt-5 border-t border-primary/10 pt-5 text-center text-xs text-muted-foreground">
          Need help?{" "}
          <a
            href="mailto:douglas@peoplestrategyhub.com"
            className="text-primary underline underline-offset-2"
          >
            Contact the event team
          </a>
        </p>
      </aside>
    </div>
  );
}
