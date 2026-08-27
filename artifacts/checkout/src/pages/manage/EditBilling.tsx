import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { CheckCircle2, Loader2, AlertCircle, Calendar, MapPin, FileText, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { customFetch } from "@workspace/api-client-react";
import InvoiceActions from "@/components/manage/InvoiceActions";
import logoUrl from "@assets/swp-summit-logo.png";

interface BillingResponse {
  id: number;
  orderReference: string | null;
  paymentMethod: string | null;
  status: string;
  alreadyPaid: boolean;
  locked?: boolean;
  lockedMessage?: string | null;
  billingName: string | null;
  billingCompany: string | null;
  billingEmail: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingTown: string | null;
  billingRegion: string | null;
  billingPostcode: string | null;
  billingCountry: string | null;
  billingPhone: string | null;
  billingVatNumber: string | null;
  poNumber: string | null;
  stripeInvoicePaymentUrl: string | null;
  stripeInvoicePdfUrl: string | null;
}

interface SaveResponse {
  ok: boolean;
  poNumber: string | null;
  status: string;
  stripeInvoicePaymentUrl: string | null;
  stripeInvoicePdfUrl: string | null;
  reissue: { reissued?: boolean; alreadyPaid?: boolean; error?: string };
}

interface BillingForm {
  poNumber: string;
  billingName: string;
  billingCompany: string;
  billingEmail: string;
  billingAddressLine1: string;
  billingAddressLine2: string;
  billingTown: string;
  billingRegion: string;
  billingPostcode: string;
  billingCountry: string;
  billingPhone: string;
  billingVatNumber: string;
}

const emptyBillingForm: BillingForm = {
  poNumber: "",
  billingName: "",
  billingCompany: "",
  billingEmail: "",
  billingAddressLine1: "",
  billingAddressLine2: "",
  billingTown: "",
  billingRegion: "",
  billingPostcode: "",
  billingCountry: "United Kingdom",
  billingPhone: "",
  billingVatNumber: "",
};

const billingFormFromResponse = (data: BillingResponse): BillingForm => ({
  poNumber: data.poNumber ?? "",
  billingName: data.billingName ?? "",
  billingCompany: data.billingCompany ?? "",
  billingEmail: data.billingEmail ?? "",
  billingAddressLine1: data.billingAddressLine1 ?? "",
  billingAddressLine2: data.billingAddressLine2 ?? "",
  billingTown: data.billingTown ?? "",
  billingRegion: data.billingRegion ?? "",
  billingPostcode: data.billingPostcode ?? "",
  billingCountry: data.billingCountry ?? "United Kingdom",
  billingPhone: data.billingPhone ?? "",
  billingVatNumber: data.billingVatNumber ?? "",
});

const formsMatch = (a: BillingForm | null, b: BillingForm) =>
  !!a &&
  Object.keys(emptyBillingForm).every(
    (key) => a[key as keyof BillingForm] === b[key as keyof BillingForm],
  );

export default function EditBilling() {
  const [, params] = useRoute("/manage/:token/billing");
  const token = params?.token ?? "";
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<BillingResponse>({
    queryKey: ["booking-billing", token],
    queryFn: () =>
      customFetch<BillingResponse>(`/api/bookings/by-management-token/${token}/billing`),
    enabled: !!token,
    retry: false,
  });

  const [form, setForm] = useState<BillingForm>(emptyBillingForm);
  const [lastSavedForm, setLastSavedForm] = useState<BillingForm | null>(null);
  const [saved, setSaved] = useState(false);
  const [discarded, setDiscarded] = useState(false);

  useEffect(() => {
    if (!data) return;
    const loadedForm = billingFormFromResponse(data);
    setForm(loadedForm);
    setLastSavedForm(loadedForm);
    setDiscarded(false);
  }, [data]);

  const mutation = useMutation({
    mutationFn: async (payload: BillingForm) =>
      customFetch<SaveResponse>(`/api/bookings/by-management-token/${token}/billing`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (_result, savedForm) => {
      setForm(savedForm);
      setLastSavedForm(savedForm);
      setSaved(true);
      setDiscarded(false);
      queryClient.invalidateQueries({ queryKey: ["booking-billing", token] });
      setTimeout(() => setSaved(false), 6000);
    },
  });

  if (!token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Invalid Link</h1>
          <p className="text-muted-foreground">
            This billing link is not valid. Please check your confirmation email.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Booking Not Found</h1>
          <p className="text-muted-foreground">
            We couldn't find a booking for this link. Please check your confirmation email.
          </p>
        </div>
      </div>
    );
  }

  const isPaid = data.alreadyPaid || data.status === "paid";
  const isInvoice = data.paymentMethod === "invoice";
  const isLocked = !!data.locked;
  const hasUnsavedChanges = !formsMatch(lastSavedForm, form);

  const handleDiscardChanges = () => {
    if (!lastSavedForm) return;
    setForm(lastSavedForm);
    setSaved(false);
    setDiscarded(true);
    mutation.reset();
    setTimeout(() => setDiscarded(false), 4000);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-white py-4 px-6 flex items-center justify-center">
        <img src={logoUrl} alt="SWP Summit" className="h-12 w-auto object-contain" />
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10">
        <div className="mb-8 rounded-2xl border border-primary/15 bg-white p-6 shadow-[0_10px_30px_rgba(0,78,185,0.04)]">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-[0.18em] text-primary">
            Secure invoice update
          </p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-[-0.02em] mb-3">
            Update billing and PO details
          </h1>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground mt-1 mb-3">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-primary" />
              Wednesday, 3 March 2027
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-primary" />1 Basinghall Avenue, London
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Order reference:{" "}
            <span className="font-mono font-semibold text-foreground">
              {data.orderReference || "PENDING"}
            </span>
          </p>
          {isInvoice && !isPaid && !isLocked && (
            <p className="mt-4 max-w-3xl text-sm leading-6 text-muted-foreground">
              Use this page to update the billing details or add a PO number for your invoice. After
              you save changes, we will re-issue the invoice with the updated information.
            </p>
          )}
        </div>

        {(data.status === "invoiced" || data.status === "paid") && (
          <div className="mb-6">
            <InvoiceActions
              token={token}
              paymentMethod={data.paymentMethod}
              recipientHint={data.billingEmail || null}
            />
          </div>
        )}

        {!isInvoice ? (
          <div className="border border-border bg-muted/40 rounded-sm p-6 flex items-start gap-4">
            <FileText className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold mb-1">Not an invoice booking</p>
              <p className="text-sm text-muted-foreground">
                This booking was paid by card, so there is no invoice to update. If you need a PO
                added to your receipt, please contact us at{" "}
                <a href="mailto:douglas@peoplestrategyhub.com" className="underline">
                  douglas@peoplestrategyhub.com
                </a>
                .
              </p>
            </div>
          </div>
        ) : isLocked ? (
          <div className="border border-amber-300 bg-amber-50 rounded-sm p-6 flex items-start gap-4">
            <Lock className="w-5 h-5 text-amber-700 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-amber-900 mb-1">
                Booking edits are currently locked
              </p>
              <p className="text-sm text-amber-800">
                {data.lockedMessage ||
                  "Online edits to PO and billing details are temporarily disabled as the event approaches."}{" "}
                If you need to update your PO number or billing details, please email us at{" "}
                <a href="mailto:douglas@peoplestrategyhub.com" className="underline">
                  douglas@peoplestrategyhub.com
                </a>
                .
              </p>
            </div>
          </div>
        ) : isPaid ? (
          <div className="border border-green-300 bg-green-50 rounded-sm p-6 flex items-start gap-4">
            <Lock className="w-5 h-5 text-green-700 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-green-900 mb-1">
                This invoice has already been paid
              </p>
              <p className="text-sm text-green-800">
                Billing details and PO number can no longer be changed because the invoice is
                already settled. If you need a PO recorded for your records, please email us at{" "}
                <a href="mailto:douglas@peoplestrategyhub.com" className="underline">
                  douglas@peoplestrategyhub.com
                </a>
                .
              </p>
              {data.stripeInvoicePdfUrl && (
                <a
                  href={data.stripeInvoicePdfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block mt-3 text-sm font-semibold text-primary underline underline-offset-2"
                >
                  Download paid invoice PDF
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                mutation.mutate(form);
              }}
              className="bg-white border border-primary/15 rounded-2xl p-6 space-y-5 shadow-[0_10px_30px_rgba(0,78,185,0.04)]"
            >
              <div className="rounded-xl border border-primary/15 bg-[#f0f6ff] p-5">
                <label className="block text-sm font-semibold mb-1.5">
                  PO Number <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input
                  value={form.poNumber}
                  maxLength={30}
                  onChange={(e) => setForm((f) => ({ ...f, poNumber: e.target.value }))}
                  placeholder="Add to appear on the invoice"
                  className="bg-white"
                />
                {form.poNumber.trim() ? (
                  <p className="text-xs text-primary font-semibold mt-2">
                    This PO number will appear on the re-issued invoice.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-2">
                    No PO number yet? You can leave this blank and update it later using this same
                    secure link.
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Max 30 characters. PO number remains optional.
                </p>
              </div>

              <div className="border-t border-border pt-5">
                <h3 className="font-bold mb-1">Billing details</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  These details appear on the invoice and can be updated before the invoice is paid.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5">
                      Billing Contact Name
                    </label>
                    <Input
                      value={form.billingName}
                      onChange={(e) => setForm((f) => ({ ...f, billingName: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5">Company</label>
                    <Input
                      value={form.billingCompany}
                      onChange={(e) => setForm((f) => ({ ...f, billingCompany: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-semibold mb-1.5">Invoice Email</label>
                  <Input
                    type="email"
                    value={form.billingEmail}
                    onChange={(e) => setForm((f) => ({ ...f, billingEmail: e.target.value }))}
                  />
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-semibold mb-1.5">Phone</label>
                  <Input
                    type="tel"
                    value={form.billingPhone}
                    onChange={(e) => setForm((f) => ({ ...f, billingPhone: e.target.value }))}
                  />
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-semibold mb-1.5">Address Line 1</label>
                  <Input
                    value={form.billingAddressLine1}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, billingAddressLine1: e.target.value }))
                    }
                  />
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-semibold mb-1.5">
                    Address Line 2{" "}
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <Input
                    value={form.billingAddressLine2}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, billingAddressLine2: e.target.value }))
                    }
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5">Town / City</label>
                    <Input
                      value={form.billingTown}
                      onChange={(e) => setForm((f) => ({ ...f, billingTown: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5">
                      Region / County{" "}
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </label>
                    <Input
                      value={form.billingRegion}
                      onChange={(e) => setForm((f) => ({ ...f, billingRegion: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-sm font-semibold mb-1.5">Postcode</label>
                    <Input
                      value={form.billingPostcode}
                      onChange={(e) => setForm((f) => ({ ...f, billingPostcode: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-1.5">Country</label>
                    <Input
                      value={form.billingCountry}
                      onChange={(e) => setForm((f) => ({ ...f, billingCountry: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-semibold mb-1.5">
                    VAT Number <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <Input
                    value={form.billingVatNumber}
                    onChange={(e) => setForm((f) => ({ ...f, billingVatNumber: e.target.value }))}
                  />
                </div>
              </div>

              {mutation.isError && (
                <div className="flex items-start gap-2 text-red-600 bg-red-50 border border-red-200 rounded-sm p-3 text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>
                    {mutation.error instanceof Error
                      ? mutation.error.message
                      : "Failed to save. Please try again."}
                  </span>
                </div>
              )}

              {saved && mutation.data && (
                <div className="flex items-start gap-2 text-green-700 bg-green-50 border border-green-200 rounded-sm p-3 text-sm">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div>
                    {mutation.data.reissue.alreadyPaid ? (
                      <span>
                        The invoice has just been marked as paid in Stripe, so no changes were
                        applied.
                      </span>
                    ) : mutation.data.reissue.reissued ? (
                      <span>
                        Saved. A fresh invoice with your new details has been emailed to{" "}
                        {form.billingEmail || "your billing email"}. If the updated invoice email
                        does not arrive within a few minutes, please check your junk or spam folder.
                      </span>
                    ) : mutation.data.reissue.error ? (
                      <span>
                        Saved, but the invoice could not be re-issued: {mutation.data.reissue.error}
                        . Please email us.
                      </span>
                    ) : (
                      <span>Saved.</span>
                    )}
                  </div>
                </div>
              )}

              {discarded && (
                <div className="flex items-start gap-2 text-blue-700 bg-[#f0f6ff] border border-primary/15 rounded-sm p-3 text-sm">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>Unsaved changes discarded.</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2 flex-wrap">
                <Button
                  type="submit"
                  disabled={mutation.isPending}
                  className="bg-primary hover:bg-primary/90 text-white"
                >
                  {mutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Saving and re-issuing invoice
                    </>
                  ) : (
                    "Save and re-issue invoice"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={mutation.isPending || !hasUnsavedChanges}
                  onClick={handleDiscardChanges}
                >
                  Discard changes
                </Button>
                {data.stripeInvoicePaymentUrl && (
                  <a
                    href={data.stripeInvoicePaymentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-semibold text-primary underline underline-offset-2"
                  >
                    View current invoice
                  </a>
                )}
              </div>
            </form>

            <aside className="space-y-4 lg:sticky lg:top-8 lg:self-start">
              <div className="rounded-2xl border border-primary/15 bg-[#f0f6ff] p-5">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-primary mb-2">
                  What happens after you save?
                </p>
                <ul className="space-y-3 text-sm text-muted-foreground">
                  {[
                    "Updated billing details are saved.",
                    "The invoice is re-issued with the latest details.",
                    "The updated invoice is emailed to the billing contact.",
                    "Payment can then be made by bank transfer or using the secure Stripe payment link.",
                  ].map((item) => (
                    <li key={item} className="flex gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-primary/15 bg-white p-5 text-sm text-muted-foreground shadow-[0_10px_30px_rgba(0,78,185,0.04)]">
                <p className="font-semibold text-foreground mb-1">Email delivery</p>
                <p>
                  If the updated invoice email does not arrive within a few minutes, please check
                  your junk or spam folder.
                </p>
              </div>
            </aside>
          </div>
        )}

        <p className="text-xs text-muted-foreground mt-8 text-center">
          SWP Summit, Wednesday, 3 March 2027, 1 Basinghall Avenue, London
          <br />
          Questions? Email{" "}
          <a href="mailto:douglas@peoplestrategyhub.com" className="underline">
            douglas@peoplestrategyhub.com
          </a>
        </p>
      </main>
    </div>
  );
}
