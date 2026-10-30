import type { Attendee, Booking, EventSettings } from "@workspace/db";
import {
  confirmationDesignVars,
  renderApprovedEmail,
  welcomeDesignVars,
} from "./approved-email-design";

/** Fictional data only. Admin preview and test use the same renderers as real delivery. */
export function renderApprovedEmailSample(options: {
  type: "confirmation" | "welcome";
  template: { subject: string; htmlBody: string };
  settings: EventSettings;
  toName?: string;
  toEmail?: string;
  calendarHtml?: string;
  documents?: Array<{ filename: string; contentType: string }>;
}) {
  const firstName = options.toName?.split(" ")[0] || "Alex";
  const lead = {
    id: 1,
    isLead: true,
    isTbc: false,
    firstName,
    lastName: "Morgan",
    jobTitle: "Workforce Planning Director",
    company: "Example Company",
    workEmail: options.toEmail || "alex@example.invalid",
    phone: "+44 7700 900123",
  } as Attendee;
  const booking = {
    id: 1,
    orderReference: "SWP27-PREVIEW",
    passType: "single",
    quantity: 5,
    subtotalAmount: "604.80",
    vatAmount: "120.96",
    totalAmount: "725.76",
    groupDiscountAmount: "189.00",
    promoDiscountAmount: "151.20",
    promoCode: "WELCOME20",
    status: "paid",
    paymentMethod: "card",
    registrationSource: "checkout",
    managementToken: "PREVIEW-ONLY-NOT-A-REAL-BOOKING",
  } as Booking;
  const attendees = [
    lead,
    ...Array.from({ length: 4 }, (_, i) => ({
      ...lead,
      id: i + 2,
      isLead: false,
      isTbc: true,
      workEmail: `placeholder-${i}@tbc.placeholder`,
    })),
  ];
  const vars =
    options.type === "confirmation"
      ? confirmationDesignVars({
          booking,
          attendees,
          lead,
          settings: options.settings,
          calendarHtml: options.calendarHtml,
          documents: options.documents,
        })
      : welcomeDesignVars({
          firstName,
          booking,
          settings: options.settings,
          calendarHtml: options.calendarHtml,
        });
  return renderApprovedEmail(options.template, vars, options.settings, {
    "{{firstName}}": firstName,
  });
}
