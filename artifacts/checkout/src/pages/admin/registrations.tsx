import { useState, Fragment } from "react";
import { useListRegistrations, useGetRegistration } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import AdminLayout from "@/components/layout/AdminLayout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Download,
  Trash2,
  AlertTriangle,
  Send,
  Check,
  Clock,
  Pencil,
  X,
  Loader2,
  Copy,
  Link,
} from "lucide-react";
import { InvoiceBadge } from "@/components/InvoiceBadge";
import {
  RegistrationQuickViews,
  type RegistrationQuickView,
} from "@/components/admin/RegistrationQuickViews";

const STATUS_OPTIONS = [
  { value: "paid", label: "Paid" },
  { value: "invoiced", label: "Invoiced" },
  { value: "pending_payment", label: "Pending Payment" },
  { value: "partial", label: "Partial (in progress)" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
  { value: "disputed", label: "Disputed" },
];

const statusBadge = (status: string) => {
  const cls =
    status === "paid"
      ? "bg-green-100 text-green-800"
      : status === "invoiced"
        ? "bg-blue-100 text-blue-800"
        : status === "cancelled"
          ? "bg-red-100 text-red-800"
          : status === "refunded"
            ? "bg-purple-100 text-purple-800"
            : status === "disputed"
              ? "bg-amber-100 text-amber-800"
              : "bg-yellow-100 text-yellow-800";
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-bold uppercase ${cls}`}>
      {STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status}
    </span>
  );
};

interface AttendeeEditForm {
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  phone: string;
  dietaryAccessibility: string;
}

function ExpandedRegistrationDetail({
  id,
  onStatusChanged,
}: {
  id: number;
  onStatusChanged: () => void;
}) {
  const { data, isLoading, refetch } = useGetRegistration(id, {
    query: { queryKey: ["registration", id] },
  });
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [stripeActionResult, setStripeActionResult] = useState<string | null>(null);
  const [redeliverState, setRedeliverState] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [redeliverMessage, setRedeliverMessage] = useState<string | null>(null);

  const handleRedeliver = async () => {
    setRedeliverState("loading");
    setRedeliverMessage(null);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const res = await fetch(`/api/admin/registrations/${id}/redeliver`, {
        method: "POST",
        headers: { "x-admin-token": token },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Redeliver failed");
      }
      const body = (await res.json().catch(() => ({}))) as {
        redelivery?: { ran: string[]; skipped: string[]; failed: string[] };
      };
      const r = body.redelivery;
      if (r) {
        if (r.failed.length > 0) {
          setRedeliverMessage(
            `Some side-effects still failed: ${r.failed.join(", ")} — check API logs.`,
          );
          setRedeliverState("error");
        } else if (r.ran.length === 0) {
          setRedeliverMessage("Nothing to redeliver — every flag was already green.");
          setRedeliverState("success");
        } else {
          setRedeliverMessage(`Redelivered: ${r.ran.join(", ")}.`);
          setRedeliverState("success");
        }
      } else {
        setRedeliverState("success");
      }
      await refetch();
      onStatusChanged();
    } catch (err) {
      setRedeliverMessage(err instanceof Error ? err.message : "Redeliver failed");
      setRedeliverState("error");
    }
  };
  const [reminderState, setReminderState] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [editingAttendeeId, setEditingAttendeeId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<AttendeeEditForm>({
    firstName: "",
    lastName: "",
    jobTitle: "",
    company: "",
    workEmail: "",
    phone: "",
    dietaryAccessibility: "",
  });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [editingBilling, setEditingBilling] = useState(false);
  const [billingForm, setBillingForm] = useState({
    poNumber: "",
    billingName: "",
    billingCompany: "",
    billingEmail: "",
    billingAddressLine1: "",
    billingAddressLine2: "",
    billingTown: "",
    billingRegion: "",
    billingPostcode: "",
    billingCountry: "",
    billingPhone: "",
    billingVatNumber: "",
  });
  const [billingSaveState, setBillingSaveState] = useState<"idle" | "saving" | "success" | "error">(
    "idle",
  );
  const [billingSaveError, setBillingSaveError] = useState<string | null>(null);
  const [billingReissueInfo, setBillingReissueInfo] = useState<string | null>(null);

  const startEditBilling = () => {
    if (!data) return;
    setBillingForm({
      poNumber: data.poNumber ?? "",
      billingName: data.billingName ?? "",
      billingCompany: data.billingCompany ?? "",
      billingEmail: data.billingEmail ?? "",
      billingAddressLine1: data.billingAddressLine1 ?? "",
      billingAddressLine2: data.billingAddressLine2 ?? "",
      billingTown: data.billingTown ?? "",
      billingRegion: data.billingRegion ?? "",
      billingPostcode: data.billingPostcode ?? "",
      billingCountry: data.billingCountry ?? "",
      billingPhone: data.billingPhone ?? "",
      billingVatNumber: data.billingVatNumber ?? "",
    });
    setBillingSaveState("idle");
    setBillingSaveError(null);
    setBillingReissueInfo(null);
    setEditingBilling(true);
  };

  const handleSaveBilling = async () => {
    setBillingSaveState("saving");
    setBillingSaveError(null);
    setBillingReissueInfo(null);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const res = await fetch(`/api/bookings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify(billingForm),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Save failed");
      }
      const body = await res.json().catch(() => ({}));
      const r = body?.reissue || {};
      if (r.alreadyPaid)
        setBillingReissueInfo(
          "Invoice already paid in Stripe — details saved but invoice was not re-issued.",
        );
      else if (r.reissued) setBillingReissueInfo("Invoice re-issued and emailed to the customer.");
      else if (r.error) setBillingReissueInfo(`Saved, but invoice re-issue failed: ${r.error}`);
      setBillingSaveState("success");
      await refetch();
      setTimeout(() => {
        setEditingBilling(false);
        setBillingSaveState("idle");
      }, 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save";
      setBillingSaveError(message);
      setBillingSaveState("error");
    }
  };

  const startEditing = (a: NonNullable<typeof data>["attendees"][number]) => {
    setEditingAttendeeId(a.id);
    setEditForm({
      firstName: a.isTbc ? "" : a.firstName,
      lastName: a.isTbc ? "" : a.lastName,
      jobTitle: a.isTbc ? "" : (a.jobTitle ?? ""),
      company: a.isTbc ? "" : (a.company ?? ""),
      workEmail: a.isTbc ? "" : a.workEmail,
      phone: a.phone ?? "",
      dietaryAccessibility: a.dietaryAccessibility ?? "",
    });
    setSaveState("idle");
    setSaveError(null);
  };

  const cancelEditing = () => {
    setEditingAttendeeId(null);
    setSaveState("idle");
    setSaveError(null);
  };

  const handleSaveAttendee = async (attendeeId: number) => {
    if (
      !editForm.firstName ||
      !editForm.lastName ||
      !editForm.jobTitle ||
      !editForm.company ||
      !editForm.workEmail
    ) {
      setSaveError("First name, last name, job title, company, and email are required.");
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const res = await fetch(`/api/bookings/${id}/attendees/${attendeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          firstName: editForm.firstName,
          lastName: editForm.lastName,
          jobTitle: editForm.jobTitle,
          company: editForm.company,
          workEmail: editForm.workEmail,
          phone: editForm.phone || null,
          dietaryAccessibility: editForm.dietaryAccessibility || null,
          isTbc: false,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Save failed");
      }
      setSaveState("success");
      await refetch();
      setTimeout(() => {
        setEditingAttendeeId(null);
        setSaveState("idle");
      }, 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save. Please try again.";
      setSaveError(message);
      setSaveState("error");
    }
  };

  const invoiceDueDate = data?.invoiceDueDate ? new Date(data.invoiceDueDate) : null;
  const isInvoiceOverdue =
    data?.status === "invoiced" && !!invoiceDueDate && invoiceDueDate < new Date();
  const invoiceDueDateStr = invoiceDueDate
    ? invoiceDueDate.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;

  const handleSendReminder = async () => {
    setReminderState("loading");
    setReminderError(null);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const res = await fetch(`/api/admin/bookings/${id}/send-invoice-reminder`, {
        method: "POST",
        headers: { "x-admin-token": token },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to send reminder");
      }
      setReminderState("success");
      setTimeout(() => setReminderState("idle"), 3500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send reminder";
      setReminderError(message);
      setReminderState("error");
      setTimeout(() => {
        setReminderState("idle");
        setReminderError(null);
      }, 4000);
    }
  };

  const handleStatusChange = (newStatus: string) => {
    if (newStatus === data?.status) return;
    if (newStatus === "cancelled" || newStatus === "refunded") {
      setPendingStatus(newStatus);
    } else {
      void confirmStatusChange(newStatus);
    }
  };

  const confirmStatusChange = async (newStatus: string) => {
    setStripeActionResult(null);
    setUpdatingStatus(true);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const res = await fetch(`/api/admin/registrations/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Status update failed");
      const body = await res.json().catch(() => ({}));
      if (body.stripeAction && body.stripeAction !== "skipped") {
        setStripeActionResult(body.stripeAction);
      }
      await refetch();
      onStatusChanged();
    } catch {
      alert("Failed to update status. Please try again.");
    } finally {
      setUpdatingStatus(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  const isGroup = (data?.attendees?.length ?? 0) > 1;
  const manageUrl = data?.managementToken
    ? `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/manage/${data.managementToken}`
    : null;

  return (
    <div className="space-y-6">
      {/* Booking meta strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div className="bg-white border border-border p-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">
            Booking Ref
          </p>
          <p className="font-mono font-medium">{data?.orderReference || "—"}</p>
        </div>
        <div className="bg-white border border-border p-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">
            Payment
          </p>
          <p className="font-medium capitalize">{data?.paymentMethod || "—"}</p>
        </div>
        <div className="bg-white border border-border p-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">
            Billing Email
          </p>
          <p className="font-medium truncate">
            {data?.billingEmail || data?.attendees?.find((a) => a.isLead)?.workEmail || "—"}
          </p>
        </div>
        <div className="bg-white border border-border p-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">
            Promo Code
          </p>
          <p className="font-medium">{data?.promoCode || "—"}</p>
        </div>
        {Boolean((data as unknown as Record<string, unknown> | undefined)?.hearAboutUs) && (
          <div className="bg-white border border-border p-3 col-span-2 md:col-span-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">
              How they heard about us
            </p>
            <p className="font-medium">
              {(data as unknown as Record<string, unknown>).hearAboutUs as string}
            </p>
          </div>
        )}
      </div>

      {/* Self-service management link */}
      {manageUrl && (
        <div className="bg-white border border-border p-3 text-sm">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-2 flex items-center gap-1.5">
            <Link className="w-3 h-3" />
            Self-Service Attendee Link
          </p>
          <div className="flex items-start gap-2">
            <code className="flex-1 text-xs font-mono text-foreground bg-slate-50 border border-border px-2 py-1.5 break-all">
              {manageUrl}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  .writeText(manageUrl)
                  .then(() => {
                    setCopyState("copied");
                    setTimeout(() => setCopyState("idle"), 2000);
                  })
                  .catch(() => {
                    setCopyState("copied");
                    setTimeout(() => setCopyState("idle"), 2000);
                  });
              }}
              className="flex-none flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-border bg-slate-50 hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              {copyState === "copied" ? (
                <>
                  <Check className="w-3.5 h-3.5 text-green-600" />
                  <span className="text-green-700">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy link</span>
                </>
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            Send this link to the registrant — anyone with it can update attendee details for this
            booking.
          </p>
        </div>
      )}

      {/* Confirmation dialog for irreversible status changes */}
      <AlertDialog
        open={!!pendingStatus}
        onOpenChange={(open) => {
          if (!open) setPendingStatus(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Are you sure?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-foreground">
                {pendingStatus === "cancelled" &&
                data?.paymentMethod === "card" &&
                data?.status === "paid" ? (
                  <p>
                    A <strong>full refund</strong> will be issued to the customer's card. This
                    cannot be reversed.
                  </p>
                ) : pendingStatus === "cancelled" &&
                  data?.paymentMethod === "invoice" &&
                  data?.status === "invoiced" ? (
                  <p>
                    The outstanding <strong>Stripe invoice will be voided</strong>. This cannot be
                    reversed.
                  </p>
                ) : pendingStatus === "refunded" ? (
                  <p>
                    The booking will be marked as <strong>refunded</strong>. Ensure any payment has
                    already been returned to the customer.
                  </p>
                ) : (
                  <p>
                    This will mark the booking as <strong>{pendingStatus}</strong>. This action
                    cannot be reversed.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingStatus(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                const s = pendingStatus!;
                setPendingStatus(null);
                void confirmStatusChange(s);
              }}
            >
              {pendingStatus === "cancelled" &&
              data?.paymentMethod === "card" &&
              data?.status === "paid"
                ? "Yes, issue refund"
                : pendingStatus === "cancelled" &&
                    data?.paymentMethod === "invoice" &&
                    data?.status === "invoiced"
                  ? "Yes, void invoice"
                  : "Yes, confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Stripe action result banner */}
      {stripeActionResult && (
        <div
          className={`flex items-start gap-2 px-4 py-2 text-sm border-b ${stripeActionResult === "failed" ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-green-50 border-green-200 text-green-800"}`}
        >
          {stripeActionResult === "failed" ? (
            <>
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Status updated but the Stripe action failed — please check the Stripe dashboard.
              </span>
            </>
          ) : stripeActionResult === "refund_issued" ? (
            <>
              <Check className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Refund issued · Status set to Refunded</span>
            </>
          ) : stripeActionResult === "invoice_voided" ? (
            <>
              <Check className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Booking cancelled · Stripe invoice voided</span>
            </>
          ) : null}
          <button
            className="ml-auto text-xs opacity-60 hover:opacity-100"
            onClick={() => setStripeActionResult(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Manual status override */}
      <div className="flex items-center gap-4 py-3 px-4 bg-slate-50 border border-border">
        <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground shrink-0">
          Override Status
        </span>
        <Select
          value={data?.status ?? ""}
          onValueChange={handleStatusChange}
          disabled={updatingStatus}
        >
          <SelectTrigger className="w-52 h-9 bg-white text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {updatingStatus && (
          <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>
        )}
        <span className="text-xs text-muted-foreground ml-2">
          Use this to mark invoice payments received directly to Tide, or to cancel a booking.
        </span>
      </div>

      {/* Delivery status — per-side-effect flags + redeliver action */}
      {data && (data.status === "paid" || data.status === "invoiced") && (
        <div
          className={`border p-4 ${data.needsAttention ? "bg-amber-50 border-amber-300" : "bg-emerald-50 border-emerald-200"}`}
        >
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h4
              className={`font-bold uppercase text-xs tracking-wider ${data.needsAttention ? "text-amber-800" : "text-emerald-800"}`}
            >
              Delivery Status
              {data.needsAttention && (
                <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold uppercase text-amber-900 bg-amber-200 px-1.5 py-0.5 rounded">
                  <AlertTriangle className="w-2.5 h-2.5" /> Needs attention
                </span>
              )}
            </h4>
            <button
              onClick={handleRedeliver}
              disabled={redeliverState === "loading"}
              className={`inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded transition-all ${
                redeliverState === "loading"
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : data.needsAttention
                    ? "bg-amber-600 text-white hover:bg-amber-700"
                    : "bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-100"
              }`}
            >
              {redeliverState === "loading" && (
                <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
              )}
              {redeliverState === "loading" ? "Redelivering…" : "Redeliver"}
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {(
              [
                ["confirmationEmailSent", "Confirmation email"],
                ["welcomeEmailsSent", "Welcome emails"],
                ["organiserNotified", "Organiser notified"],
                ["sheetsSynced", "Sheets sync"],
              ] as const
            ).map(([key, label]) => {
              const ok = (data as unknown as Record<string, boolean>)[key];
              return (
                <div key={key} className="flex items-center gap-2">
                  {ok ? (
                    <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <X className="w-4 h-4 text-amber-700 shrink-0" />
                  )}
                  <span className={ok ? "text-emerald-900" : "text-amber-900 font-medium"}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          {redeliverMessage && (
            <p
              className={`mt-3 text-xs ${redeliverState === "error" ? "text-red-700" : "text-emerald-800"}`}
            >
              {redeliverMessage}
            </p>
          )}
        </div>
      )}

      {/* Invoice details — shown when payment method is invoice */}
      {data?.paymentMethod === "invoice" && (
        <div
          className={`${isInvoiceOverdue ? "bg-red-50 border-red-300" : "bg-blue-50 border-blue-200"} border p-4`}
        >
          <div className="flex items-center justify-between mb-3">
            <h4
              className={`font-bold uppercase text-xs tracking-wider ${isInvoiceOverdue ? "text-red-700" : "text-blue-700"}`}
            >
              Invoice Details
              <span className="ml-2 inline-flex">
                <InvoiceBadge status={data?.invoiceBadgeStatus} />
              </span>
            </h4>
            <button
              onClick={handleSendReminder}
              disabled={reminderState === "loading" || reminderState === "success"}
              className={`
                inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded transition-all
                ${
                  reminderState === "success"
                    ? "bg-green-100 text-green-700 cursor-not-allowed"
                    : reminderState === "error"
                      ? "bg-red-100 text-red-700 hover:bg-red-200"
                      : reminderState === "loading"
                        ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                        : isInvoiceOverdue
                          ? "bg-red-600 text-white hover:bg-red-700"
                          : "bg-blue-600 text-white hover:bg-blue-700"
                }
              `}
            >
              {reminderState === "loading" && (
                <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
              )}
              {reminderState === "success" && <Check className="w-3 h-3" />}
              {reminderState === "error" && <AlertTriangle className="w-3 h-3" />}
              {reminderState === "idle" && <Send className="w-3 h-3" />}
              {reminderState === "loading"
                ? "Sending…"
                : reminderState === "success"
                  ? "Sent!"
                  : reminderState === "error"
                    ? reminderError || "Failed"
                    : "Send Reminder"}
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-36 shrink-0">Invoice Ref</span>
              <span className="font-mono font-semibold">{data?.orderReference || "—"}</span>
            </div>
            <div className="flex gap-2">
              <span
                className={`w-36 shrink-0 ${isInvoiceOverdue ? "text-red-600 font-semibold" : "text-muted-foreground"}`}
              >
                {isInvoiceOverdue ? "⚠️ Due Date" : "Due Date"}
              </span>
              <span className={`font-medium ${isInvoiceOverdue ? "text-red-700 font-bold" : ""}`}>
                {invoiceDueDateStr ? (
                  <>
                    {invoiceDueDateStr}
                    {isInvoiceOverdue ? " — OVERDUE" : ""}
                  </>
                ) : (
                  <span className="text-muted-foreground italic">Not recorded</span>
                )}
              </span>
            </div>
            {data?.billingName && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-36 shrink-0">Billing Contact</span>
                <span className="font-medium">{data.billingName}</span>
              </div>
            )}
            {data?.billingCompany && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-36 shrink-0">Billing Company</span>
                <span className="font-medium">{data.billingCompany}</span>
              </div>
            )}
            {data?.billingEmail && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-36 shrink-0">Billing Email</span>
                <span className="font-medium">{data.billingEmail}</span>
              </div>
            )}
            {(data?.billingAddressLine1 || data?.billingAddress) && (
              <div className="flex gap-2 sm:col-span-2">
                <span className="text-muted-foreground w-36 shrink-0">Billing Address</span>
                <span className="font-medium">
                  {data.billingAddressLine1 ? (
                    <>
                      {data.billingAddressLine1}
                      {data.billingAddressLine2 ? `, ${data.billingAddressLine2}` : ""}
                      {data.billingTown || data.billingRegion
                        ? `, ${[data.billingTown, data.billingRegion].filter(Boolean).join(", ")}`
                        : ""}
                      {data.billingPostcode ? `, ${data.billingPostcode}` : ""}
                      {data.billingCountry ? `, ${data.billingCountry}` : ""}
                    </>
                  ) : (
                    data.billingAddress
                  )}
                </span>
              </div>
            )}
            <div className="flex gap-2 sm:col-span-2">
              <span className="text-muted-foreground w-36 shrink-0">PO Number</span>
              <span className="font-mono font-semibold">
                {data?.poNumber || (
                  <span className="text-muted-foreground italic font-sans font-normal">
                    Not provided
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Edit billing / PO */}
          <div className="mt-4 pt-3 border-t border-blue-200">
            {!editingBilling ? (
              <button
                onClick={startEditBilling}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
              >
                <Pencil className="w-3 h-3" /> Edit PO / billing details
                {data?.stripeInvoiceId ? (
                  <span className="text-muted-foreground font-normal italic">
                    — will re-issue invoice
                  </span>
                ) : null}
              </button>
            ) : (
              <div className="bg-white border border-primary/30 rounded-sm p-4 space-y-3">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Editing billing details{" "}
                  {data?.stripeInvoiceId ? "(saving will re-issue invoice)" : ""}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      PO Number
                    </label>
                    <Input
                      value={billingForm.poNumber}
                      maxLength={30}
                      onChange={(e) => setBillingForm((f) => ({ ...f, poNumber: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Billing Contact
                    </label>
                    <Input
                      value={billingForm.billingName}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingName: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Company
                    </label>
                    <Input
                      value={billingForm.billingCompany}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingCompany: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Invoice Email
                    </label>
                    <Input
                      type="email"
                      value={billingForm.billingEmail}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingEmail: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Phone
                    </label>
                    <Input
                      type="tel"
                      value={billingForm.billingPhone}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingPhone: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      VAT Number
                    </label>
                    <Input
                      value={billingForm.billingVatNumber}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingVatNumber: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Address Line 1
                    </label>
                    <Input
                      value={billingForm.billingAddressLine1}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingAddressLine1: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Address Line 2
                    </label>
                    <Input
                      value={billingForm.billingAddressLine2}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingAddressLine2: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Town
                    </label>
                    <Input
                      value={billingForm.billingTown}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingTown: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Region
                    </label>
                    <Input
                      value={billingForm.billingRegion}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingRegion: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Postcode
                    </label>
                    <Input
                      value={billingForm.billingPostcode}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingPostcode: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1">
                      Country
                    </label>
                    <Input
                      value={billingForm.billingCountry}
                      onChange={(e) =>
                        setBillingForm((f) => ({ ...f, billingCountry: e.target.value }))
                      }
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                {billingSaveError && <p className="text-xs text-red-600">{billingSaveError}</p>}
                {billingReissueInfo && billingSaveState === "success" && (
                  <p className="text-xs text-green-700 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" />
                    {billingReissueInfo}
                  </p>
                )}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={handleSaveBilling}
                    disabled={billingSaveState === "saving"}
                    className={`inline-flex items-center gap-2 text-sm font-semibold px-4 py-1.5 rounded ${
                      billingSaveState === "success"
                        ? "bg-green-100 text-green-700"
                        : billingSaveState === "saving"
                          ? "bg-primary/60 text-white"
                          : "bg-primary text-white hover:bg-primary/90"
                    }`}
                  >
                    {billingSaveState === "saving" && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    )}
                    {billingSaveState === "success" && <Check className="w-3.5 h-3.5" />}
                    {billingSaveState === "saving"
                      ? "Saving & re-issuing…"
                      : billingSaveState === "success"
                        ? "Saved"
                        : "Save & Re-issue"}
                  </button>
                  <button
                    onClick={() => setEditingBilling(false)}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Invoice links */}
          {(data?.stripeInvoicePaymentUrl || data?.stripeInvoicePdfUrl) && (
            <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-blue-200">
              {data?.stripeInvoicePaymentUrl && (
                <a
                  href={data.stripeInvoicePaymentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  View Invoice →
                </a>
              )}
              {data?.stripeInvoicePdfUrl && (
                <a
                  href={data.stripeInvoicePdfUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-blue-700 underline underline-offset-2 hover:text-blue-900"
                >
                  Download PDF →
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* Card payment invoice links (non-invoice method) */}
      {data?.paymentMethod !== "invoice" &&
        (data?.stripeInvoicePaymentUrl || data?.stripeInvoicePdfUrl) && (
          <div className="flex flex-wrap gap-3 text-sm">
            {data?.stripeInvoicePaymentUrl && (
              <a
                href={data.stripeInvoicePaymentUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
              >
                View Stripe Invoice →
              </a>
            )}
            {data?.stripeInvoicePdfUrl && (
              <a
                href={data.stripeInvoicePdfUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-semibold text-blue-600 underline underline-offset-2 hover:text-blue-800"
              >
                Download Invoice PDF →
              </a>
            )}
          </div>
        )}

      {/* Attendee table */}
      <div>
        <h4 className="font-bold mb-3 uppercase text-xs tracking-wider text-muted-foreground">
          All Attendees ({data?.attendees?.length ?? 0})
        </h4>
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground w-8">
                  #
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  Name
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  Job Title
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  Company
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  Email
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  Phone
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  Dietary / Access
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground">
                  GDPR
                </th>
                <th className="text-left p-3 font-bold uppercase text-xs tracking-wider text-muted-foreground w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data?.attendees
                ?.slice()
                .sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0))
                .map((a) => (
                  <Fragment key={a.id}>
                    {/* Display row */}
                    <tr
                      className={`${a.isLead ? "bg-primary/5" : "bg-white"} ${editingAttendeeId === a.id ? "border-b-0" : ""}`}
                    >
                      <td className="p-3 text-muted-foreground">{(a.seatIndex ?? 0) + 1}</td>
                      <td className="p-3">
                        {a.isTbc && editingAttendeeId !== a.id ? (
                          <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium italic">
                            <Clock className="w-3.5 h-3.5" /> TBC — pending
                          </span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            {a.isLead && isGroup && (
                              <span
                                className="text-primary font-bold text-base leading-none"
                                title="Lead attendee"
                              >
                                ★
                              </span>
                            )}
                            <span className="font-medium">
                              {a.firstName} {a.lastName}
                            </span>
                            {a.isLead && !isGroup && (
                              <span className="text-[10px] font-bold bg-primary text-white px-1.5 py-0.5 uppercase tracking-wider">
                                Lead
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {a.isTbc ? "—" : a.jobTitle || "—"}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {a.isTbc ? "—" : a.company || "—"}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {a.isTbc ? "—" : a.workEmail || "—"}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {a.isTbc ? "—" : a.phone || "—"}
                      </td>
                      <td className="p-3 text-muted-foreground max-w-[180px] truncate">
                        {a.isTbc ? "—" : a.dietaryAccessibility || "—"}
                      </td>
                      <td className="p-3">
                        {a.isTbc ? (
                          <span className="text-muted-foreground">—</span>
                        ) : a.gdprConsent ? (
                          <span className="text-[10px] font-bold bg-green-100 text-green-800 px-1.5 py-0.5 uppercase">
                            ✓ Yes
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold bg-red-100 text-red-800 px-1.5 py-0.5 uppercase">
                            No
                          </span>
                        )}
                      </td>
                      <td className="p-3">
                        {editingAttendeeId === a.id ? (
                          <button
                            onClick={cancelEditing}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title="Cancel editing"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => startEditing(a)}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary transition-colors"
                            title="Edit attendee"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>

                    {/* Inline edit row */}
                    {editingAttendeeId === a.id && (
                      <tr className={a.isLead ? "bg-primary/5" : "bg-white"}>
                        <td colSpan={9} className="px-4 pb-4 pt-0">
                          <div className="border border-primary/20 bg-white rounded-sm p-4 space-y-3">
                            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                              Editing: Attendee {(a.seatIndex ?? 0) + 1}
                              {a.isLead ? " (Lead)" : ""}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  First Name *
                                </label>
                                <Input
                                  value={editForm.firstName}
                                  onChange={(e) =>
                                    setEditForm((f) => ({ ...f, firstName: e.target.value }))
                                  }
                                  placeholder="Jane"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Last Name *
                                </label>
                                <Input
                                  value={editForm.lastName}
                                  onChange={(e) =>
                                    setEditForm((f) => ({ ...f, lastName: e.target.value }))
                                  }
                                  placeholder="Smith"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Job Title *
                                </label>
                                <Input
                                  value={editForm.jobTitle}
                                  onChange={(e) =>
                                    setEditForm((f) => ({ ...f, jobTitle: e.target.value }))
                                  }
                                  placeholder="Chief People Officer"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Company *
                                </label>
                                <Input
                                  value={editForm.company}
                                  onChange={(e) =>
                                    setEditForm((f) => ({ ...f, company: e.target.value }))
                                  }
                                  placeholder="Acme Ltd"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Work Email *
                                </label>
                                <Input
                                  type="email"
                                  value={editForm.workEmail}
                                  onChange={(e) =>
                                    setEditForm((f) => ({ ...f, workEmail: e.target.value }))
                                  }
                                  placeholder="jane@acme.com"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Phone
                                </label>
                                <Input
                                  type="tel"
                                  value={editForm.phone}
                                  onChange={(e) =>
                                    setEditForm((f) => ({ ...f, phone: e.target.value }))
                                  }
                                  placeholder="+44 7700 900 000"
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div className="sm:col-span-2 lg:col-span-3">
                                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                                  Dietary / Accessibility
                                </label>
                                <Input
                                  value={editForm.dietaryAccessibility}
                                  onChange={(e) =>
                                    setEditForm((f) => ({
                                      ...f,
                                      dietaryAccessibility: e.target.value,
                                    }))
                                  }
                                  placeholder="e.g. vegetarian, wheelchair access"
                                  className="h-8 text-sm"
                                />
                              </div>
                            </div>
                            {saveError && (
                              <p className="text-xs text-red-600 flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                                {saveError}
                              </p>
                            )}
                            <div className="flex items-center gap-3 pt-1">
                              <button
                                onClick={() => handleSaveAttendee(a.id)}
                                disabled={saveState === "saving" || saveState === "success"}
                                className={`inline-flex items-center gap-2 text-sm font-semibold px-4 py-1.5 rounded transition-all ${
                                  saveState === "success"
                                    ? "bg-green-100 text-green-700 cursor-not-allowed"
                                    : saveState === "saving"
                                      ? "bg-primary/60 text-white cursor-not-allowed"
                                      : "bg-primary text-white hover:bg-primary/90"
                                }`}
                              >
                                {saveState === "saving" && (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                )}
                                {saveState === "success" && <Check className="w-3.5 h-3.5" />}
                                {saveState === "saving"
                                  ? "Saving…"
                                  : saveState === "success"
                                    ? "Saved!"
                                    : "Save Changes"}
                              </button>
                              <button
                                onClick={cancelEditing}
                                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              {(!data?.attendees || data.attendees.length === 0) && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-muted-foreground">
                    No attendees recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function AdminRegistrations() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [passType, setPassType] = useState<string>("all");
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const queryClient = useQueryClient();

  const activeQuickView = needsAttentionOnly
    ? "needs_attention"
    : status === "partial"
      ? "incomplete"
      : status === "invoiced"
        ? "invoiced"
        : status === "paid"
          ? "paid"
          : status === "all"
            ? "all"
            : "custom";

  const applyQuickView = (view: RegistrationQuickView) => {
    setStatus(view.status);
    setNeedsAttentionOnly(view.needsAttention);
    setPage(1);
    setSelected(new Set());
  };

  const queryKey = ["registrations", search, status, passType, needsAttentionOnly, page];

  const { data, isLoading } = useListRegistrations(
    {
      search: search.trim() || undefined,
      status: status !== "all" ? status : undefined,
      passType: passType !== "all" ? passType : undefined,
      needsAttention: needsAttentionOnly ? "true" : undefined,
      page,
      limit: 20,
    },
    {
      query: { queryKey },
    },
  );

  const registrations = data?.registrations ?? [];
  const pageIds = registrations.map((r) => r.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const somePageSelected = pageIds.some((id) => selected.has(id));

  const toggleAll = () => {
    if (allPageSelected) {
      const next = new Set(selected);
      pageIds.forEach((id) => next.delete(id));
      setSelected(next);
    } else {
      const next = new Set(selected);
      pageIds.forEach((id) => next.add(id));
      setSelected(next);
    }
  };

  const toggleOne = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (passType !== "all") params.set("passType", passType);
      const res = await fetch(`/api/admin/registrations/export?${params.toString()}`, {
        headers: { "x-admin-token": token },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().split("T")[0];
      a.download = `swp27-registrations-${date}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  const handleBulkDelete = async () => {
    setDeleting(true);
    try {
      const token = localStorage.getItem("admin_token") || "";
      const res = await fetch("/api/admin/registrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setSelected(new Set());
      setConfirmDelete(false);
      if (expandedId && selected.has(expandedId)) setExpandedId(null);
      await queryClient.invalidateQueries({ queryKey: ["registrations"] });
    } catch {
      alert("Delete failed. Please try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AdminLayout title="Registrations">
      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-border shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-red-600 shrink-0" />
              <h2 className="text-lg font-bold">
                Delete {selected.size} registration{selected.size !== 1 ? "s" : ""}?
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              This will permanently delete the selected booking{selected.size !== 1 ? "s" : ""} and
              all associated attendee records. This action cannot be undone.
            </p>
            <div className="flex gap-3 pt-2 justify-end">
              <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={handleBulkDelete}
                disabled={deleting}
              >
                {deleting
                  ? "Deleting…"
                  : `Delete ${selected.size} record${selected.size !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      <RegistrationQuickViews activeView={activeQuickView} onSelect={applyQuickView} />

      {/* Filters bar */}
      <div className="bg-white p-6 border border-border shadow-sm mb-4 flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 w-full">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 block">
            Search
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-3 w-5 h-5 text-muted-foreground" />
            <Input
              placeholder="Search by name, email or reference..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                setSelected(new Set());
              }}
              className="pl-10 h-12"
            />
          </div>
        </div>
        <div className="w-full md:w-44">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 block">
            Status
          </label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(1);
              setSelected(new Set());
            }}
          >
            <SelectTrigger className="h-12 bg-white">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="invoiced">Invoiced</SelectItem>
              <SelectItem value="partial">Partial (in progress)</SelectItem>
              <SelectItem value="pending_payment">Pending Payment</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-full md:w-44">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 block">
            Pass Type
          </label>
          <Select
            value={passType}
            onValueChange={(v) => {
              setPassType(v);
              setPage(1);
              setSelected(new Set());
            }}
          >
            <SelectTrigger className="h-12 bg-white">
              <SelectValue placeholder="All Passes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Passes</SelectItem>
              <SelectItem value="single">Standard Pass (HR)</SelectItem>
              <SelectItem value="business">Business Pass (Vendor)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end shrink-0">
          <label className="inline-flex items-center gap-2 h-12 px-3 bg-white border border-border cursor-pointer text-sm font-semibold text-amber-900 hover:bg-amber-50">
            <Checkbox
              checked={needsAttentionOnly}
              onCheckedChange={(v) => {
                setNeedsAttentionOnly(v === true);
                setPage(1);
                setSelected(new Set());
              }}
              aria-label="Show only bookings needing attention"
            />
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Needs attention
          </label>
        </div>
        <Button
          onClick={handleExport}
          disabled={exporting}
          variant="outline"
          className="h-12 gap-2 shrink-0 border-primary text-primary hover:bg-primary hover:text-white"
        >
          <Download className="w-4 h-4" />
          {exporting ? "Exporting…" : "Export Excel"}
        </Button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-4 px-4 py-3 bg-slate-900 text-white border border-slate-700">
          <span className="text-sm font-semibold">{selected.size} selected</span>
          <Button
            size="sm"
            className="bg-red-600 hover:bg-red-700 text-white gap-2 h-8"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete selected
          </Button>
          <button
            className="text-xs text-slate-400 hover:text-white ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="bg-white border border-border shadow-sm">
        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all on this page"
                    className={somePageSelected && !allPageSelected ? "opacity-50" : ""}
                  />
                </TableHead>
                <TableHead className="w-8"></TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>Lead Attendee</TableHead>
                <TableHead>Pass Type</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Invoice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registrations.map((reg) => (
                <Fragment key={reg.id}>
                  <TableRow
                    className={`cursor-pointer hover:bg-muted/30 ${selected.has(reg.id) ? "bg-primary/5" : ""}`}
                    onClick={() => setExpandedId(expandedId === reg.id ? null : reg.id)}
                  >
                    <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(reg.id)}
                        onCheckedChange={() => toggleOne(reg.id)}
                        aria-label={`Select booking ${reg.orderReference}`}
                      />
                    </TableCell>
                    <TableCell>
                      {expandedId === reg.id ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{reg.orderReference || "-"}</TableCell>
                    <TableCell>
                      <p className="font-bold">{reg.leadName || "Unknown"}</p>
                      <p className="text-xs text-muted-foreground">{reg.leadEmail}</p>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`text-xs font-bold px-2 py-0.5 uppercase rounded ${reg.passType === "business" ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700"}`}
                      >
                        {reg.passType === "business" ? "Business" : "Standard"}
                      </span>
                    </TableCell>
                    <TableCell>{reg.quantity}</TableCell>
                    <TableCell className="font-medium">£{reg.totalAmount}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {statusBadge(reg.status)}
                        {reg.status === "invoiced" &&
                          reg.invoiceDueDate &&
                          new Date(reg.invoiceDueDate) < new Date() && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                              <Clock className="w-2.5 h-2.5" /> Overdue
                            </span>
                          )}
                        {reg.needsAttention && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-amber-900 bg-amber-200 px-1.5 py-0.5 rounded"
                            title="One or more confirmation side-effects (email, organiser notif, Sheets sync) have not been delivered"
                          >
                            <AlertTriangle className="w-2.5 h-2.5" /> Needs attention
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div>{new Date(reg.createdAt).toLocaleDateString()}</div>
                      {reg.status === "invoiced" && reg.invoiceDueDate && (
                        <div
                          className={`text-xs mt-0.5 ${new Date(reg.invoiceDueDate) < new Date() ? "text-red-600 font-semibold" : "text-muted-foreground"}`}
                        >
                          Due: {new Date(reg.invoiceDueDate).toLocaleDateString()}
                        </div>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {reg.stripeInvoicePaymentUrl && (
                        <a
                          href={reg.stripeInvoicePaymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-semibold text-primary underline underline-offset-2 hover:text-primary/80 whitespace-nowrap"
                        >
                          Invoice ↗
                        </a>
                      )}
                    </TableCell>
                  </TableRow>
                  {expandedId === reg.id && (
                    <TableRow className="bg-muted/10">
                      <TableCell colSpan={10} className="p-6">
                        <ExpandedRegistrationDetail
                          id={reg.id}
                          onStatusChanged={() =>
                            queryClient.invalidateQueries({ queryKey: ["registrations"] })
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
              {registrations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                    No registrations found for the current view.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {data && data.total > 0 && (
        <div className="flex justify-between items-center mt-6">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * data.limit + 1} to {Math.min(page * data.limit, data.total)} of{" "}
            {data.total}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * data.limit >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
