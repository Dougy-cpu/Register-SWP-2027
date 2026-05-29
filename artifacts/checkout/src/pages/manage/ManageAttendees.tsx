import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { z } from "zod";
import {
  CheckCircle2,
  User,
  Clock,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  Calendar,
  MapPin,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { InvoiceBadge } from "@/components/InvoiceBadge";
import InvoiceActions from "@/components/manage/InvoiceActions";
import type { Attendee, BookingWithAttendees } from "@/types/booking";
import logoUrl from "@assets/swp-summit-logo.png";

const attendeeSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  jobTitle: z.string().min(1, "Job title is required"),
  company: z.string().min(1, "Company is required"),
  workEmail: z.string().email("Valid email is required"),
  phone: z.string().optional(),
  dietaryAccessibility: z.string().optional(),
  gdprConsent: z.boolean().refine((val) => val === true, {
    message: "You must agree to the terms before saving",
  }),
});

type AttendeeFormData = z.infer<typeof attendeeSchema>;

interface AttendeeFormErrors {
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  company?: string;
  workEmail?: string;
  gdprConsent?: string;
}

function AttendeeCard({
  attendee,
  token,
  onSaved,
  locked,
}: {
  attendee: Attendee;
  token: string;
  onSaved: () => void;
  locked: boolean;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(!locked && (attendee.isTbc ?? false));
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<AttendeeFormData>({
    firstName: attendee.isTbc ? "" : attendee.firstName,
    lastName: attendee.isTbc ? "" : attendee.lastName,
    jobTitle: attendee.isTbc ? "" : (attendee.jobTitle ?? ""),
    company: attendee.isTbc ? "" : (attendee.company ?? ""),
    workEmail: attendee.isTbc ? "" : attendee.workEmail,
    phone: attendee.phone ?? "",
    dietaryAccessibility: attendee.dietaryAccessibility ?? "",
    gdprConsent: attendee.gdprConsent ?? false,
  });
  const [errors, setErrors] = useState<AttendeeFormErrors>({});

  const mutation = useMutation({
    mutationFn: async (data: AttendeeFormData) => {
      const result = await customFetch<Attendee>(`/api/attendees/${attendee.id}/managed`, {
        method: "PATCH",
        body: JSON.stringify({ managementToken: token, ...data }),
      });
      return result;
    },
    onSuccess: () => {
      setSaved(true);
      setExpanded(false);
      onSaved();
      toast({
        title: "Attendee details saved",
        description: `${form.firstName} ${form.lastName}'s details have been updated.`,
      });
    },
  });

  const validate = (data: AttendeeFormData): AttendeeFormErrors => {
    const result = attendeeSchema.safeParse(data);
    if (result.success) return {};
    const errs: AttendeeFormErrors = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0] as keyof AttendeeFormErrors;
      if (!errs[key]) errs[key] = issue.message;
    }
    return errs;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate(form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    mutation.mutate(form);
  };

  const isTbc = attendee.isTbc && !saved;

  return (
    <div
      className={`bg-white border rounded-sm overflow-hidden transition-all ${isTbc ? "border-amber-300" : "border-border"}`}
    >
      <div className="flex items-center justify-between p-5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {saved || !attendee.isTbc ? (
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4 text-primary" />
            </div>
          ) : (
            <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <Clock className="w-4 h-4 text-amber-600" />
            </div>
          )}
          <div className="min-w-0">
            {saved ? (
              <>
                <p className="font-bold truncate">
                  {form.firstName} {form.lastName}
                </p>
                <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Details saved
                </p>
              </>
            ) : attendee.isTbc ? (
              <>
                <p className="font-bold text-amber-700">
                  Attendee {attendee.seatIndex} â€” Details Needed
                </p>
                <p className="text-xs text-amber-600 font-medium">No details entered yet</p>
              </>
            ) : (
              <>
                <p className="font-bold truncate">
                  {attendee.firstName} {attendee.lastName}
                </p>
                <p className="text-sm text-muted-foreground truncate">{attendee.workEmail}</p>
              </>
            )}
          </div>
        </div>

        {locked ? (
          <span className="flex-shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded border border-border text-muted-foreground bg-muted/40 select-none">
            <Lock className="w-3.5 h-3.5" />
            Read-only
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={`flex-shrink-0 flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded border transition-colors ${
              isTbc
                ? "border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            {isTbc ? "Fill in Details" : saved ? "Edit" : "Edit Details"}
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>

      {!locked && expanded && (
        <div className="border-t border-border p-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-1.5">First Name *</label>
                <Input
                  value={form.firstName}
                  onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                  placeholder="Jane"
                  className={errors.firstName ? "border-red-400" : ""}
                />
                {errors.firstName && (
                  <p className="text-xs text-red-500 mt-1">{errors.firstName}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1.5">Last Name *</label>
                <Input
                  value={form.lastName}
                  onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                  placeholder="Smith"
                  className={errors.lastName ? "border-red-400" : ""}
                />
                {errors.lastName && <p className="text-xs text-red-500 mt-1">{errors.lastName}</p>}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1.5">Job Title *</label>
              <Input
                value={form.jobTitle}
                onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
                placeholder="Chief People Officer"
                className={errors.jobTitle ? "border-red-400" : ""}
              />
              {errors.jobTitle && <p className="text-xs text-red-500 mt-1">{errors.jobTitle}</p>}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1.5">Company *</label>
              <Input
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Acme Ltd"
                className={errors.company ? "border-red-400" : ""}
              />
              {errors.company && <p className="text-xs text-red-500 mt-1">{errors.company}</p>}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1.5">Work Email *</label>
              <Input
                type="email"
                value={form.workEmail}
                onChange={(e) => setForm((f) => ({ ...f, workEmail: e.target.value }))}
                placeholder="jane.smith@acme.com"
                className={errors.workEmail ? "border-red-400" : ""}
              />
              {errors.workEmail && <p className="text-xs text-red-500 mt-1">{errors.workEmail}</p>}
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1.5">Phone Number</label>
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+44 7700 900 000"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-1.5">
                Dietary / Accessibility Requirements
              </label>
              <Input
                value={form.dietaryAccessibility}
                onChange={(e) => setForm((f) => ({ ...f, dietaryAccessibility: e.target.value }))}
                placeholder="e.g. vegetarian, wheelchair access"
              />
            </div>

            <div className="pt-4 mt-2 border-t border-border">
              <div className="flex items-start space-x-3">
                <Checkbox
                  checked={form.gdprConsent}
                  onCheckedChange={(val) => {
                    setForm((f) => ({ ...f, gdprConsent: !!val }));
                    if (errors.gdprConsent) setErrors((e) => ({ ...e, gdprConsent: undefined }));
                  }}
                  className="mt-1"
                />
                <div className="space-y-1 leading-none">
                  <label className="font-normal text-base cursor-pointer">
                    I understand how my data will be processed in accordance with{" "}
                    <a
                      href="https://peoplestrategyhub.com/your-data-gdpr"
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-primary hover:text-primary/80"
                    >
                      GDPR
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://swpsummit.com/terms-and-conditions"
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-primary hover:text-primary/80"
                    >
                      Conference T&Cs
                    </a>
                  </label>
                  {errors.gdprConsent && (
                    <p className="text-xs text-destructive">{errors.gdprConsent}</p>
                  )}
                </div>
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

            <div className="flex items-center gap-3 pt-1">
              <Button
                type="submit"
                disabled={mutation.isPending}
                className="bg-primary hover:bg-primary/90 text-white"
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Savingâ€¦
                  </>
                ) : (
                  "Save Attendee Details"
                )}
              </Button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

interface ManageBookingResponse extends BookingWithAttendees {
  changesLocked?: boolean;
  lockedMessage?: string | null;
}

export default function ManageAttendees() {
  const [, params] = useRoute("/manage/:token");
  const token = params?.token ?? "";
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<ManageBookingResponse>({
    queryKey: ["booking-by-token", token],
    queryFn: () => customFetch<ManageBookingResponse>(`/api/bookings/by-management-token/${token}`),
    enabled: !!token,
    retry: false,
  });

  const handleSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["booking-by-token", token] });
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Invalid Link</h1>
          <p className="text-muted-foreground">
            This management link is not valid. Please check your confirmation email.
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
            We couldn't find a booking for this link. It may have expired or been used already.
            Please check your confirmation email.
          </p>
        </div>
      </div>
    );
  }

  const booking = data;
  const attendees = booking.attendees ?? [];
  const tbcCount = attendees.filter((a) => a.isTbc).length;
  const allFilled = tbcCount === 0;
  const changesLocked = booking.changesLocked ?? false;
  const lockedMessage =
    booking.lockedMessage ||
    "Attendee changes are now closed. If you need to make a change, please contact us at douglas@peoplestrategyhub.com";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-white py-4 px-6 flex items-center justify-center">
        <img src={logoUrl} alt="SWP Summit" className="h-12 w-auto object-contain" />
      </header>

      <main className="max-w-2xl mx-auto px-4 py-10">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Manage Attendees</h1>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground mt-1 mb-3">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-primary flex-shrink-0" />
              Wednesday, 3 March 2027
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-primary flex-shrink-0" />1 Basinghall Avenue, London
            </span>
          </div>
          <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>
              Order reference:{" "}
              <span className="font-mono font-semibold text-foreground">
                {booking.orderReference || "PENDING"}
              </span>
              {" Â· "}
              {booking.quantity}{" "}
              {booking.passType === "single" ? "HR Professional Pass" : "Business Pass"}
              {booking.quantity !== 1 ? "es" : ""}
            </span>
            {booking.paymentMethod === "invoice" && (
              <InvoiceBadge status={booking.invoiceBadgeStatus} size="sm" />
            )}
          </p>
        </div>

        {changesLocked && (
          <div className="border border-red-200 bg-red-50 rounded-sm p-5 mb-6 flex items-start gap-4">
            <Lock className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-red-800 mb-1">Attendee changes are closed</p>
              <p className="text-sm text-red-700">{lockedMessage}</p>
            </div>
          </div>
        )}

        {!changesLocked && !allFilled && (
          <div className="bg-amber-50 border border-amber-200 rounded-sm p-4 mb-6 flex items-start gap-3">
            <Clock className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-amber-800">
                {tbcCount} attendee {tbcCount === 1 ? "detail" : "details"} still needed
              </p>
              <p className="text-sm text-amber-700 mt-0.5">
                Please fill in the details below before the event. You can return to this page at
                any time using the link in your confirmation email.
              </p>
            </div>
          </div>
        )}

        {!changesLocked && allFilled && (
          <div className="bg-green-50 border border-green-200 rounded-sm p-4 mb-6 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-green-800">All attendee details are complete</p>
              <p className="text-sm text-green-700 mt-0.5">
                You can still update any attendee's details by expanding their card below.
              </p>
            </div>
          </div>
        )}

        {(booking.status === "invoiced" || booking.status === "paid") && (
          <div className="mb-6">
            <InvoiceActions
              token={token}
              paymentMethod={booking.paymentMethod ?? null}
              recipientHint={
                booking.billingEmail ||
                attendees.find((a) => a.isLead)?.workEmail ||
                attendees[0]?.workEmail ||
                null
              }
            />
          </div>
        )}

        <div className="space-y-3">
          {attendees.map((attendee) => (
            <AttendeeCard
              key={attendee.id}
              attendee={attendee}
              token={token}
              onSaved={handleSaved}
              locked={changesLocked}
            />
          ))}
        </div>

        <p className="text-xs text-muted-foreground mt-8 text-center">
          SWP Summit Â· Wednesday, 3 March 2027 Â· 1 Basinghall Avenue, London
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
