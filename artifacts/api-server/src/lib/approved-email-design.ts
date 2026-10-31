import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attendee, Booking, EventSettings } from "@workspace/db";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const marker = "<!-- swp-transactional-v2 -->";
const blue = "#004eb9";
const ink = "#101c2e";
const muted = "#4a5568";
const font = "Arial, Helvetica, sans-serif";
const contactEmail = "douglas@peoplestrategyhub.com";

function asset(name: string): Buffer {
  const path = [join(moduleDir, "assets", name), join(moduleDir, "../assets", name)].find(
    existsSync,
  );
  if (!path) throw new Error(`Required email asset missing: ${name}`);
  return readFileSync(path);
}

export const approvedEmailTemplates = {
  confirmation: {
    subject: "Booking confirmed — {{orderReference}} — {{eventName}}",
    htmlBody: asset("email/confirmation.html").toString("utf8"),
  },
  welcome: {
    subject: "Your visit to {{eventName}} — {{eventDate}}",
    htmlBody: asset("email/welcome.html").toString("utf8"),
  },
};
const frame = asset("email/frame.html").toString("utf8");
const logos = [
  {
    cid: "swp-transactional-v2@swpsummit.com",
    filename: "swp-summit.png",
    content: asset("receipt/swp-summit.png"),
  },
  {
    cid: "psh-transactional-v2@swpsummit.com",
    filename: "people-strategy-hub.png",
    content: asset("email/psh.png"),
  },
];

export function isApprovedEmailDesign(html: string): boolean {
  return html.includes(marker);
}

export function approvedEmailImages(html: string) {
  return logos
    .filter((logo) => html.includes(`cid:${logo.cid}`))
    .map((logo) => ({
      ...logo,
      contentType: "image/png",
      contentDisposition: "inline" as const,
    }));
}

/** Browser previews alone need data URLs. The sender always embeds the original PNG bytes. */
export function emailBrowserPreview(html: string): string {
  for (const logo of approvedEmailImages(html)) {
    html = html.replaceAll(
      `cid:${logo.cid}`,
      `data:image/png;base64,${logo.content.toString("base64")}`,
    );
  }
  return html;
}

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Single pass: user text containing another placeholder is never interpreted as a template. */
export function fillEmailTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{[a-zA-Z][a-zA-Z0-9]*\}\}/g, (key) => vars[key] ?? key);
}

function p(html: string, size = 16, colour = ink, margin = "0 0 18px") {
  return `<p style="margin:${margin};font-family:${font};font-size:${size}px;line-height:1.6;color:${colour};overflow-wrap:anywhere;">${html}</p>`;
}
function label(html: string) {
  return p(html, 11, blue, "0 0 12px").replace(
    "line-height:1.6;",
    "line-height:1.5;font-weight:bold;letter-spacing:1.8px;",
  );
}
function heading(html: string, size = 24, margin = "0 0 16px") {
  return `<h2 style="margin:${margin};font-family:${font};font-size:${size}px;line-height:1.25;font-weight:700;color:${ink};overflow-wrap:anywhere;">${html}</h2>`;
}
export function emailSection(html: string, top = 28, bottom = 28, border = true) {
  return `<tr><td class="pad" style="padding:${top}px 40px ${bottom}px;${border ? "border-top:1px solid #e2e8f0;" : ""}">${html}</td></tr>`;
}
function button(title: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${blue}" style="background:${blue};border-radius:4px;mso-padding-alt:16px 22px;"><a href="${escape(url)}" style="display:inline-block;border:16px solid ${blue};border-left-width:22px;border-right-width:22px;border-radius:4px;background:${blue};font-family:${font};font-size:16px;line-height:20px;font-weight:bold;text-align:center;color:#ffffff;text-decoration:none;mso-padding-alt:0;">${escape(title)}</a></td></tr></table>`;
}
function link(title: string, url: string) {
  return `<a href="${escape(url)}" style="color:${blue};text-decoration:underline;word-break:break-word;overflow-wrap:anywhere;">${escape(title)}</a>`;
}
function manageDetails(url: string) {
  return (
    p(
      "No account or login needed. Use the same link to add colleagues, update names, job titles, companies and emails, and record dietary or accessibility requirements.",
      14,
      muted,
      "18px 0 12px",
    ) +
    p(
      "You can share it with trusted colleagues to complete their details. <strong>Anyone with this link can view and update every attendee in this booking.</strong>",
      14,
      muted,
      "0 0 12px",
    ) +
    p(
      `If the button does not work, copy your secure link:<br>${link(url, url).replace("word-break:break-word;", "word-break:break-all;font-size:12px;")}`,
      13,
      muted,
      "0",
    )
  );
}
function money(value: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
}
function amount(value: string | number | null | undefined) {
  return Number(value ?? 0);
}
function eventName(settings: Pick<EventSettings, "eventName">) {
  const name = settings.eventName || "SWP Summit";
  return name === "SWP Summit" ? "SWP Summit 2027" : name;
}
function eventDetails(settings: EventSettings, times: boolean) {
  const venue = settings.eventVenue || "1 Basinghall Avenue, London";
  const london = /,\s*London$/i.test(venue);
  let content =
    label("THE DETAILS") +
    heading(escape(settings.eventDate || "Wednesday, 3 March 2027"), 22, "0 0 9px") +
    p(
      `<strong>${escape(london ? venue.replace(/,\s*London$/i, "") : venue)}</strong><br>${london ? "London " : ""}${escape(settings.eventVenuePostcode || "EC2V 5DD")}`,
      16,
      ink,
      "0",
    );
  if (times)
    content += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:20px;"><tr><td width="50%" valign="top" style="padding-right:12px;border-right:1px solid #cddcf1;">${label("REGISTRATION")}</td><td width="50%" valign="top" style="padding-left:16px;">${label("EVENT OPENS")}</td></tr><tr><td valign="top" style="padding-right:12px;border-right:1px solid #cddcf1;">${heading("08:30", 25, "0")}</td><td valign="top" style="padding-left:16px;">${heading("09:00", 25, "0")}</td></tr></table>`;
  return emailSection(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f0f6ff" style="width:100%;background:#f0f6ff;"><tr><td style="padding:24px;">${content}</td></tr></table>`,
    0,
    30,
    false,
  );
}

export interface EmailDocument {
  filename: string;
  contentType: string;
}
export interface ConfirmationDesignContext {
  booking: Booking;
  attendees: Attendee[];
  lead: Attendee;
  settings: EventSettings;
  documents?: EmailDocument[];
  calendarHtml?: string;
  invoiceHelpHtml?: string;
  appBaseUrl?: string;
}

function commonVars(settings: EventSettings, calendarHtml = "") {
  return {
    "{{eventName}}": escape(eventName(settings)),
    "{{eventDate}}": escape(settings.eventDate || "Wednesday, 3 March 2027"),
    "{{eventVenue}}": escape(settings.eventVenue || "1 Basinghall Avenue, London"),
    "{{eventVenuePostcode}}": escape(settings.eventVenuePostcode || "EC2V 5DD"),
    "{{calendarSection}}": calendarHtml ? emailSection(calendarHtml, 0, 28, false) : "",
  };
}
function managementUrl(booking: Booking | null | undefined, base: string, billing = false) {
  return booking?.managementToken
    ? `${base.replace(/\/$/, "")}/manage${billing ? "/billing" : ""}#${encodeURIComponent(booking.managementToken)}`
    : "";
}
function priceRow(left: string, right: string, bold = false) {
  const style = `font-family:${font};font-size:15px;line-height:1.5;padding:7px 0;color:${bold ? ink : muted};${bold ? "font-weight:bold;" : ""}`;
  return `<tr><td valign="top" style="${style}padding-right:12px;">${left}</td><td align="right" valign="top" style="${style}white-space:nowrap;">${right}</td></tr>`;
}

export function confirmationDesignVars(context: ConfirmationDesignContext): Record<string, string> {
  const { booking, attendees, lead, settings } = context;
  const staff = booking.registrationSource === "sponsor_staff";
  const pass = staff
    ? "Sponsor staff pass"
    : booking.passType === "business"
      ? "Business pass"
      : "Workforce pass";
  const passes = `${pass}${booking.quantity === 1 ? "" : "es"}`;
  const total = amount(booking.totalAmount);
  const net = amount(booking.subtotalAmount);
  const vat = amount(booking.vatAmount);
  const group = amount(booking.groupDiscountAmount);
  const promo = amount(booking.promoDiscountAmount);
  const paid = booking.status === "paid";
  const free = total === 0;
  const paymentLabel = free ? "COMPLIMENTARY" : paid ? "PAID IN FULL" : "PAYMENT DUE";
  const totalLabel = free ? "Total" : paid ? "Total paid" : "Total due";
  const named = attendees.filter((a) => !a.isTbc);
  const pending = Math.max(
    attendees.filter((a) => a.isTbc).length,
    booking.quantity - named.length,
  );
  const manageUrl = managementUrl(booking, context.appBaseUrl || "https://register.swpsummit.com");
  const ref = booking.orderReference || `#${booking.id}`;
  let nextStep = "";
  if (manageUrl)
    nextStep = emailSection(
      label("YOUR NEXT STEP") +
        heading(
          pending
            ? `${pending} attendee ${pending === 1 ? "detail" : "details"} to add`
            : "Your booking, all in one place.",
          23,
          "0 0 12px",
        ) +
        p(
          pending
            ? "Your places are secured. Add your colleagues’ details when you’re ready."
            : "Check your attendee details and tell us about any dietary or accessibility requirements.",
          16,
          ink,
          "0 0 20px",
        ) +
        button(pending ? "Add attendee details" : "Manage booking details", manageUrl) +
        manageDetails(manageUrl),
      28,
      30,
    );
  else if (pending)
    nextStep = emailSection(
      label("YOUR NEXT STEP") +
        heading(`${pending} attendee ${pending === 1 ? "detail" : "details"} to add`, 23) +
        p(
          `Contact ${link(contactEmail, `mailto:${contactEmail}`)} to add your colleagues’ details.`,
          15,
          ink,
          "0",
        ),
    );

  let attendeeContent = named
    .map((a) =>
      p(
        `<strong>${escape(`${a.firstName} ${a.lastName}`.trim())}</strong>${a.isLead ? " · Lead attendee" : ""}<br>${[a.jobTitle, a.company].filter(Boolean).map(escape).join(" · ")}<br>${link(a.workEmail, `mailto:${a.workEmail}`)}${a.phone ? `<br>${escape(a.phone)}` : ""}`,
        15,
        ink,
        "0 0 16px",
      ),
    )
    .join("");
  // Group only unnamed seats; never expose internal placeholder addresses.
  const companies = new Map<string, number>();
  for (const attendee of attendees.filter((a) => a.isTbc))
    companies.set(
      attendee.company || lead.company,
      (companies.get(attendee.company || lead.company) || 0) + 1,
    );
  const missing = pending - [...companies.values()].reduce((sum, n) => sum + n, 0);
  if (missing > 0) companies.set(lead.company, (companies.get(lead.company) || 0) + missing);
  for (const [company, count] of companies)
    attendeeContent += p(
      `<strong>${count} further ${escape(pass)}${count === 1 ? "" : "es"}</strong><br>${company ? `${escape(company)} · ` : ""}Attendee details to be confirmed`,
      15,
      ink,
      "0 0 18px",
    );
  attendeeContent += p(
    "Each named attendee receives a separate welcome email. If it has not arrived, please check junk or spam.",
    14,
    muted,
    "0",
  );

  // Stored subtotal is already discounted. Reconstruct the display-only starting amount;
  // no price, tax, discount or booking values are changed.
  const beforeDiscounts = Math.round((net + group + promo) * 100) / 100;
  const unitPence = Math.round(beforeDiscounts * 100) / Math.max(booking.quantity, 1);
  const unitLabel = Number.isInteger(unitPence) ? ` × ${money(unitPence / 100)}` : "";
  let rows = priceRow(`${booking.quantity} ${escape(passes)}${unitLabel}`, money(beforeDiscounts));
  if (group > 0) rows += priceRow("Group discount", `−${money(group)}`);
  if (promo > 0)
    rows += priceRow(
      `Promo code: <strong>${escape(booking.promoCode || "Discount")}</strong>`,
      `−${money(promo)}`,
    );
  rows +=
    priceRow(
      `Subtotal${group > 0 || promo > 0 ? " after discounts" : ""} (excl. VAT)`,
      money(net),
      true,
    ) + priceRow("VAT (20%)", money(vat));
  rows += `<tr><td style="padding:20px 10px 0 0;border-top:1px solid #cddcf1;font-family:${font};font-size:18px;font-weight:bold;color:${ink};">${totalLabel} <span style="font-size:12px;font-weight:normal;">(incl. VAT)</span></td><td align="right" style="padding:20px 0 0;border-top:1px solid #cddcf1;font-family:${font};font-size:24px;font-weight:bold;white-space:nowrap;color:${blue};">${money(total)}</td></tr>`;
  const documents = (context.documents || []).filter((d) => d.contentType === "application/pdf");
  const documentCopy = documents.length
    ? p(
        documents
          .map(
            (d) =>
              `<strong>${d.filename.startsWith("invoice-") ? "Your invoice" : d.filename.startsWith("receipt-") ? (paid || free ? "Your receipt" : "Your booking summary") : "Company information"} is attached.</strong><br>${escape(d.filename)}`,
          )
          .join("<br><br>"),
        14,
        muted,
        "22px 0 0",
      )
    : "";

  let invoiceDetails = "";
  if (booking.paymentMethod === "invoice" && !staff) {
    const due = booking.invoiceDueDate
      ? new Intl.DateTimeFormat("en-GB", {
          dateStyle: "long",
          timeZone: settings.eventTimezone || "Europe/London",
        }).format(new Date(booking.invoiceDueDate))
      : "";
    let content =
      label(paid ? "INVOICE PAID" : "YOUR INVOICE") +
      (booking.billingEmail
        ? p(`Billing contact: <strong>${escape(booking.billingEmail)}</strong>`, 15)
        : "") +
      (booking.poNumber ? p(`PO number: <strong>${escape(booking.poNumber)}</strong>`, 15) : "");
    if (!paid && !free)
      content +=
        (due ? p(`Payment due: <strong>${escape(due)}</strong>`, 15) : "") +
        p(
          "Your registration is confirmed. Your finance team can settle the invoice by bank transfer or through Stripe. The invoice email includes supplier details, bank information and payment instructions.",
          15,
        ) +
        (booking.stripeInvoicePaymentUrl
          ? button("Pay invoice online", booking.stripeInvoicePaymentUrl)
          : "");
    if (manageUrl)
      content += p(
        `${link("Update PO number or billing details", managementUrl(booking, context.appBaseUrl || "https://register.swpsummit.com", true))}<br>Use this secure link to add or update your PO number and billing details. We will automatically re-issue the invoice after the update.`,
        14,
        muted,
        "20px 0 18px",
      );
    if (!paid && !free && context.invoiceHelpHtml)
      content += heading("How invoicing works", 20) + context.invoiceHelpHtml;
    content += p(
      "If the invoice email has not arrived, please check junk or spam, or contact the event team.",
      14,
      muted,
      "18px 0 0",
    );
    invoiceDetails = emailSection(content);
  }
  return {
    ...commonVars(settings, context.calendarHtml),
    "{{firstName}}": escape(lead.firstName),
    "{{orderReference}}": escape(ref),
    "{{bookingIntro}}": `Thank you, ${escape(lead.firstName)}. Your <strong>${booking.quantity} ${escape(passes)}</strong> for ${escape(eventName(settings))} ${booking.quantity === 1 ? "is" : "are"} confirmed.`,
    "{{bookingSummary}}": emailSection(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="padding-right:10px;">${label("BOOKING REFERENCE")}${heading(escape(ref), 22, "0")}</td><td align="right" valign="top">${label(paymentLabel)}${heading(staff ? "Sponsor staff" : money(total), 22, "0")}</td></tr></table>`,
      24,
      24,
    ),
    "{{nextStep}}": nextStep,
    "{{eventDetails}}": eventDetails(settings, false),
    "{{attendees}}": emailSection(
      label("YOUR ATTENDEES") +
        heading(
          pending
            ? `${named.length} named. ${pending} to follow.`
            : `${named.length} ${named.length === 1 ? "attendee" : "attendees"} confirmed.`,
          23,
        ) +
        attendeeContent,
    ),
    "{{paymentSummary}}": staff
      ? ""
      : emailSection(
          label("PAYMENT SUMMARY") +
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" aria-label="Payment breakdown" style="width:100%;">${rows}</table>` +
            documentCopy,
          28,
          30,
        ),
    "{{invoiceDetails}}": invoiceDetails,
  };
}

export function welcomeDesignVars(context: {
  firstName: string;
  settings: EventSettings;
  booking?: Booking | null;
  calendarHtml?: string;
  appBaseUrl?: string;
}): Record<string, string> {
  const manageUrl = managementUrl(
    context.booking,
    context.appBaseUrl || "https://register.swpsummit.com",
  );
  const staff = context.booking?.registrationSource === "sponsor_staff";
  return {
    ...commonVars(context.settings, context.calendarHtml),
    "{{firstName}}": escape(context.firstName),
    "{{eventDetails}}": eventDetails(context.settings, true),
    "{{nextStep}}": manageUrl
      ? emailSection(
          label("BEFORE YOU ARRIVE") +
            heading("Check your booking details.", 24) +
            p(
              "Take a moment to check your details and add any dietary or accessibility requirements.",
              15,
            ) +
            button("Manage booking details", manageUrl) +
            manageDetails(manageUrl),
        )
      : emailSection(
          label("BEFORE YOU ARRIVE") +
            p(
              `If your details change, or you have dietary or accessibility requirements, contact ${link(contactEmail, `mailto:${contactEmail}`)}.`,
              15,
              ink,
              "0",
            ),
        ),
    "{{checkinDetails}}": staff
      ? "Please bring a digital or printed copy of your sponsor staff confirmation for check-in."
      : "Please bring a digital or printed copy of your booking confirmation for check-in. Your booking organiser receives the confirmation and any receipt or invoice separately.",
    "{{badgeNotice}}": emailSection(
      heading("Badge scanning and sponsor leads", 16, "0 0 10px") +
        p(
          `At the event, sponsors may scan the QR on your badge to save your name, job title, company and work email as a lead. The QR itself contains only an attendee reference.<br><br>Scanning is optional. To ask for your badge to be excluded from sponsor scanning, email ${link(contactEmail, `mailto:${contactEmail}`)}.`,
          14,
          muted,
          "0",
        ),
    ),
  };
}

export function renderApprovedEmail(
  template: { subject: string; htmlBody: string },
  vars: Record<string, string>,
  settings: EventSettings,
  subjectVars: Record<string, string> = {},
) {
  const rawVars = Object.fromEntries(
    Object.entries(vars)
      .filter(([, v]) => !/<[a-z]/i.test(v))
      .map(([k, v]) => [k, decodeEntities(v)]),
  );
  const subject = fillEmailTemplate(template.subject, { ...rawVars, ...subjectVars });
  const content = fillEmailTemplate(template.htmlBody, vars);
  const shortDate = (settings.eventDate || "Wednesday, 3 March 2027")
    .replace(/^[a-z]+,?\s*/i, "")
    .replace(/\s+20\d\d$/, "");
  const html = fillEmailTemplate(frame, {
    "{{title}}": escape(subject),
    "{{content}}": content,
    "{{preheader}}": escape(
      isApprovedEmailDesign(template.htmlBody) && template.htmlBody.includes("{{bookingIntro}}")
        ? `Your booking details for ${eventName(settings)}.`
        : `Your venue, programme and booking details for ${eventName(settings)}.`,
    ),
    "{{eventName}}": escape(eventName(settings).toUpperCase()),
    "{{headerEventDate}}": escape(`${shortDate} · London`),
  });
  return { html, subject, text: emailPlainText(html) };
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    pound: "£",
    copy: "©",
    ndash: "–",
    mdash: "—",
    middot: "·",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (!code.startsWith("#")) return named[code.toLowerCase()] ?? whole;
    const number =
      code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
  });
}

/** A complete text alternative, including action URLs and every dynamic detail. */
export function emailPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<div\b[^>]*style="[^"]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, "")
      .replace(
        /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        (_whole, url: string, title: string) =>
          `${title}${decodeEntities(title.replace(/<[^>]+>/g, "")) === decodeEntities(url) || url.startsWith("mailto:") ? "" : ` (${url})`}`,
      )
      .replace(/<br\s*\/?>|<\/(?:p|h[1-6]|tr|div|li)>/gi, "\n")
      .replace(/<\/(?:td|th)>/gi, "  ")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}
