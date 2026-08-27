import { useEffect } from "react";
import { CheckCircle2, FileText, Calendar, MapPin, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BookingWithAttendees } from "@/types/booking";
import { InvoiceBadge } from "@/components/InvoiceBadge";

interface ConfirmationProps {
  booking: BookingWithAttendees;
}

export default function Confirmation({ booking }: ConfirmationProps) {
  useEffect(() => {
    // If we landed here after stripe redirect, we might want to check the session_id
    // session_id is available via new URLSearchParams(window.location.search).get('session_id') if needed
    // For now, assume backend webhook handles fulfillment, we just show success
  }, []);

  return (
    <div className="max-w-3xl mx-auto text-center space-y-8 py-12">
      <div className="flex justify-center mb-6">
        <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center">
          <CheckCircle2 className="w-12 h-12 text-primary" />
        </div>
      </div>

      <div>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">You are registered!</h1>
        <p className="text-xl text-muted-foreground">
          We cannot wait to see you at the SWP Summit.
        </p>
      </div>

      <div className="swp-card relative mt-12 grid grid-cols-1 gap-8 overflow-hidden rounded-2xl p-8 text-left md:grid-cols-2">
        <div className="absolute top-0 right-0 p-8 opacity-5">
          <CheckCircle2 className="w-48 h-48" />
        </div>

        <div className="space-y-6 relative z-10">
          <div>
            <h3 className="text-sm text-muted-foreground font-bold uppercase tracking-wider mb-1">
              Order Reference
            </h3>
            <p className="text-2xl font-mono font-bold">{booking.orderReference || "PENDING"}</p>
          </div>

          <div>
            <h3 className="text-sm text-muted-foreground font-bold uppercase tracking-wider mb-2">
              Event Details
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Calendar className="w-5 h-5 text-primary" />
                <span className="font-medium">Wednesday, 3 March 2027</span>
              </div>
              <div className="flex items-center gap-3">
                <MapPin className="w-5 h-5 text-primary" />
                <span className="font-medium">1 Basinghall Avenue, London</span>
              </div>
            </div>
          </div>

          {booking.paymentMethod === "invoice" && (
            <div className="rounded-md border border-primary/20 bg-primary/5 p-5">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-primary mt-0.5" />
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-bold text-foreground">Invoice issued</h4>
                    <InvoiceBadge status={booking.invoiceBadgeStatus} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your registration is confirmed and the invoice has been emailed to{" "}
                    <span className="font-semibold text-foreground">
                      {booking.billingEmail || "the billing contact"}
                    </span>
                    .
                  </p>
                  <p className="text-sm text-muted-foreground">
                    The invoice email includes supplier details, bank information, payment
                    instructions and a secure Stripe payment link. Your finance team can settle the
                    invoice by bank transfer or through Stripe.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Need to add a PO number later? Use the secure billing link in your confirmation
                    email. Once updated, we will automatically re-issue the invoice with the PO
                    included.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    If you do not see the email within a few minutes, please check your junk or spam
                    folder.
                  </p>
                  {booking.poNumber && (
                    <p className="text-sm text-muted-foreground">
                      <span className="font-semibold">PO Number:</span>{" "}
                      <span className="font-mono">{booking.poNumber}</span>
                    </p>
                  )}
                  {(booking.stripeInvoicePaymentUrl || booking.managementToken) && (
                    <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap">
                      {booking.stripeInvoicePaymentUrl && (
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={booking.stripeInvoicePaymentUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Pay invoice online
                          </a>
                        </Button>
                      )}
                      {booking.managementToken && (
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/manage/${booking.managementToken}/billing`}
                          >
                            Add PO number or update billing
                          </a>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-6 relative z-10">
          <div>
            <h3 className="text-sm text-muted-foreground font-bold uppercase tracking-wider mb-2">
              Registration
            </h3>
            <div className="flex justify-between items-end border-b border-border pb-2 mb-2">
              <span className="font-bold text-lg">
                {booking.quantity} x{" "}
                {booking.passType === "single" ? "Workforce Pass" : "Business Pass"}
              </span>
              <span className="font-bold text-lg">&pound;{booking.totalAmount.toFixed(2)}</span>
            </div>
          </div>

          <div>
            <h3 className="text-sm text-muted-foreground font-bold uppercase tracking-wider mb-3">
              Attendees
            </h3>
            <div className="space-y-3">
              {(
                booking.attendees?.filter(
                  (a, idx, arr) =>
                    arr.findIndex((b) => b.seatIndex === a.seatIndex && b.isLead === a.isLead) ===
                    idx,
                ) ?? []
              ).map((attendee, i) => {
                const isTbc = attendee.isTbc || !attendee.firstName || !attendee.lastName;
                const attendeeName = isTbc
                  ? `Attendee ${(attendee.seatIndex ?? i) + 1} (TBC)`
                  : `${attendee.firstName} ${attendee.lastName}`;
                const initials = isTbc
                  ? "TBC"
                  : `${attendee.firstName.charAt(0)}${attendee.lastName.charAt(0)}`;

                return (
                  <div key={i} className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                      {initials}
                    </div>
                    <div>
                      <p className="font-bold">{attendeeName}</p>
                      {attendee.workEmail && (
                        <p className="text-xs text-muted-foreground">{attendee.workEmail}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {booking.managementToken && (
        <div className="rounded-xl border border-primary/15 bg-primary/[0.025] p-5 text-left">
          <div className="flex items-start gap-3">
            <ExternalLink className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-bold mb-1">Need to update attendee details?</h4>
              <p className="text-sm text-muted-foreground mb-3">
                You can add or update attendee names and contact information at any time, including
                TBC slots. This link is also included in your confirmation email.
              </p>
              <a
                href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/manage/${booking.managementToken}`}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
              >
                Manage attendees
              </a>
            </div>
          </div>
        </div>
      )}

      <div className="pt-8">
        <p className="text-muted-foreground mb-6">
          A confirmation email has been sent to the lead attendee. If you do not see the email
          within a few minutes, please check your junk or spam folder.
        </p>
        <Button
          size="lg"
          className="swp-primary-btn h-14 px-10 text-lg"
          onClick={() => (window.location.href = "https://swpsummit.com")}
        >
          Return to Website
        </Button>
      </div>

      {import.meta.env.DEV && (
        <div className="pt-4 border-t border-dashed border-border mt-4">
          <p className="text-xs text-muted-foreground mb-3 font-mono uppercase tracking-wider">
            Dev only
          </p>
          <Button
            variant="outline"
            size="sm"
            className="border-dashed border-muted-foreground/50 text-muted-foreground hover:text-foreground"
            onClick={() => {
              try {
                sessionStorage.removeItem("booking_session");
              } catch {
                /* ignore */
              }
              try {
                localStorage.removeItem("booking_session");
              } catch {
                /* ignore */
              }
              window.location.href = "/";
            }}
          >
            Start new test registration
          </Button>
        </div>
      )}
    </div>
  );
}
