import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateBookingBody } from "@workspace/api-client-react";

export const BILLING_FIELDS = [
  "billingName",
  "billingCompany",
  "billingEmail",
  "billingAddressLine1",
  "billingAddressLine2",
  "billingTown",
  "billingRegion",
  "billingPostcode",
  "billingCountry",
  "billingPhone",
  "billingVatNumber",
  "poNumber",
] as const;

export type PaymentDraft = {
  paymentMethod: "card" | "invoice";
  billing: Record<(typeof BILLING_FIELDS)[number], string>;
};

function draftKey(bookingId: number) {
  let token: string | null = null;
  try {
    token = window.localStorage.getItem("booking_session");
  } catch {
    /* session storage may still be available */
  }
  if (!token) {
    try {
      token = window.sessionStorage.getItem("booking_session");
    } catch {
      /* server save still works */
    }
  }
  return token ? `swp-payment-draft:${bookingId}:${token}` : null;
}

function readCachedDraft(key: string | null): PaymentDraft | null {
  try {
    if (!key) return null;
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    if (
      !stored ||
      Date.now() - stored.savedAt > 24 * 60 * 60 * 1000 ||
      !Number.isFinite(stored.savedAt)
    )
      return null;
    const draft = stored.draft as PaymentDraft;
    if (
      !draft ||
      !["card", "invoice"].includes(draft.paymentMethod) ||
      !BILLING_FIELDS.every((field) => typeof draft.billing?.[field] === "string")
    )
      return null;
    return draft;
  } catch {
    return null;
  }
}

export function readPaymentDraft(bookingId: number): PaymentDraft | null {
  return readCachedDraft(draftKey(bookingId));
}

function cacheDraft(key: string | null, draft: PaymentDraft | null) {
  try {
    if (!key) return;
    if (draft) window.sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), draft }));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Server persistence still works when browser storage is unavailable.
  }
}

function clearSavedDraft(key: string | null, snapshot: string) {
  // A previous mounted screen must not delete a newer screen's pending changes.
  if (JSON.stringify(readCachedDraft(key)) === snapshot) cacheDraft(key, null);
}

const pendingWrites = new Map<string, Promise<unknown>>();

export function paymentDraftBody(draft: PaymentDraft): UpdateBookingBody {
  return {
    paymentMethod: draft.paymentMethod,
    ...Object.fromEntries(BILLING_FIELDS.map((field) => [field, draft.billing[field] || null])),
  };
}

// Serialise server writes so an older, slow save cannot overwrite newer billing details.
// The tab cache protects the short debounce window and failures; the server is the durable copy.
export function usePaymentDraft({
  bookingId,
  draft,
  restored,
  enabled,
  save,
}: {
  bookingId: number;
  draft: PaymentDraft;
  restored: boolean;
  enabled: boolean;
  save: (data: UpdateBookingBody) => Promise<unknown>;
}) {
  const [storageKey] = useState(() => draftKey(bookingId));
  const serialized = JSON.stringify(draft);
  const latest = useRef(serialized);
  latest.current = serialized;
  const saved = useRef(restored ? "" : serialized);
  const saveRef = useRef(save);
  saveRef.current = save;
  const observed = useRef(restored ? "" : serialized);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const enqueue = useCallback(
    (snapshot: string) => {
      const key = storageKey ?? `booking-${bookingId}`;
      const persist = saveRef.current;
      const pending = (pendingWrites.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          if (saved.current === snapshot) {
            clearSavedDraft(storageKey, snapshot);
            if (mounted.current && latest.current === snapshot) setStatus("saved");
            return;
          }
          try {
            if (storageKey && draftKey(bookingId) !== storageKey)
              throw new Error("Booking session changed. Reopen your booking before saving.");
            await persist(paymentDraftBody(JSON.parse(snapshot) as PaymentDraft));
            saved.current = snapshot;
            if (latest.current === snapshot) {
              clearSavedDraft(storageKey, snapshot);
              if (mounted.current) setStatus("saved");
            }
          } catch (error) {
            if (mounted.current && latest.current === snapshot) setStatus("error");
            throw error;
          }
        });
      pendingWrites.set(key, pending);
      const finished = () => {
        if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
      };
      void pending.then(finished, finished);
      return pending;
    },
    [bookingId, storageKey],
  );

  useEffect(() => {
    if (!enabled) {
      observed.current = "";
      return;
    }
    if (serialized === observed.current) return;
    observed.current = serialized;
    cacheDraft(storageKey, JSON.parse(serialized) as PaymentDraft);
    setStatus("saving");
    timer.current = setTimeout(() => {
      void enqueue(serialized).catch(() => {});
    }, 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [storageKey, enabled, enqueue, serialized]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      // Browser Back can unmount this step without using its explicit Back button.
      if (enabledRef.current && latest.current !== saved.current)
        void enqueue(latest.current).catch(() => {});
    },
    [enqueue],
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const snapshot = latest.current;
    cacheDraft(storageKey, JSON.parse(snapshot) as PaymentDraft);
    if (mounted.current) setStatus("saving");
    await enqueue(snapshot);
    if (mounted.current && latest.current === snapshot) setStatus("saved");
  }, [storageKey, enqueue]);

  return { status, flush };
}
