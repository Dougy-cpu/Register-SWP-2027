import https from "https";
import http from "http";
import nodemailer from "nodemailer";
import { logger } from "./logger";
import { defaultOrderRef, DEFAULT_REF_PREFIX, DEFAULT_REF_OFFSET } from "./order-reference";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@workspace/db";
import {
  emailLogsTable,
  emailTemplatesTable,
  bookingsTable,
  attendeesTable,
  notificationEmailsTable,
  eventSettingsTable,
} from "@workspace/db";
import type { EventSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generatePdfReceipt } from "./pdf";
import { buildGoogleCalendarUrl, buildOutlookCalendarUrl, type CalendarEvent } from "./ics";

async function downloadHttpsPdf(url: string, redirectsLeft = 5): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            resolve(null);
            return;
          }
          downloadHttpsPdf(res.headers.location, redirectsLeft - 1).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(null));
      })
      .on("error", () => resolve(null));
  });
}

// Company info PDF attachment (attached to every confirmation email)
let _companyInfoPdf: Buffer | null | undefined = undefined;
function getCompanyInfoPdf(): Buffer | null {
  if (_companyInfoPdf !== undefined) return _companyInfoPdf;
  try {
    const _dir = dirname(fileURLToPath(import.meta.url));
    const assetPath = join(_dir, "assets", "company-info.pdf");
    if (existsSync(assetPath)) {
      _companyInfoPdf = readFileSync(assetPath);
      logger.info(
        { sizeBytes: _companyInfoPdf.length },
        "Company info PDF loaded for email attachments",
      );
    } else {
      logger.warn({ assetPath }, "Company info PDF not found â€” will not be attached to emails");
      _companyInfoPdf = null;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load company info PDF");
    _companyInfoPdf = null;
  }
  return _companyInfoPdf;
}

const defaultSettings: Omit<EventSettings, "id" | "updatedAt"> = {
  eventName: "SWP Summit",
  eventDate: "Wednesday, 3 March 2027",
  eventVenue: "1 Basinghall Avenue, London",
  eventVenuePostcode: "EC2V 5DD",
  orgName: "Dynamic Business Leaders Limited",
  orgAddress: "London, UK",
  orgWebsite: "https://swpsummit.com",
  logoDataUrl: null,
  fromName: "SWP Summit",
  fromEmail: "douglas@peoplestrategyhub.com",
  freeagentRefreshToken: null,
  freeagentAccessToken: null,
  freeagentTokenExpiresAt: null,
  attendeeChangesLocked: false,
  attendeeChangesLockedMessage: null,
  refPrefix: DEFAULT_REF_PREFIX,
  refOffset: DEFAULT_REF_OFFSET,
  notifyCompleteSubject: null,
  notifyIncompleteSubject: null,
  notifyAttendeeSubject: null,
  eventStartAt: null,
  eventEndAt: null,
  eventTimezone: "Europe/London",
  eventDescription: null,
  socialEnabled: false,
  socialName: null,
  socialStartAt: null,
  socialEndAt: null,
  socialVenue: null,
  socialDescription: null,
  invoiceHelpContent: null,
};

/**
 * Built-in fallback copy for the "How invoicing works" help block. Used
 * whenever an admin has not set `event_settings.invoice_help_content`. Edit
 * via Admin â†’ Settings â†’ Pay-by-Invoice Help.
 */
export const DEFAULT_INVOICE_HELP_CONTENT = `When will I receive the invoice?
We email a VAT invoice to the billing address you provide as soon as your registration is confirmed â€” usually within a few minutes.

What are the payment terms?
Invoices are due within 14 days, or before the event date if sooner. Your seats are reserved as soon as the invoice is issued.

How can I pay?
- Card or bank transfer using the secure "Pay Online" link on the invoice.
- BACS / wire transfer to the bank account printed at the bottom of the invoice (please quote your booking reference).

Where do I send remittance advice?
Email remittance to douglas@peoplestrategyhub.com so we can match your payment quickly.

Need a PO number on the invoice?
You can add or update a PO number â€” and edit any billing field â€” at any time before payment using the secure self-service link in your confirmation email. We'll re-issue the invoice automatically.

Questions?
Email douglas@peoplestrategyhub.com and we'll come back to you within one working day.`;

/**
 * Render plain-text invoice help into safe HTML for emails. Paragraphs are
 * separated by blank lines; consecutive lines starting with "- " render as a
 * <ul>. All other text is HTML-escaped.
 */
export function renderInvoiceHelpHtml(text: string): string {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) return "";
      const allBullets = lines.every((l) => /^\s*-\s+/.test(l));
      if (allBullets) {
        const items = lines
          .map((l) => `<li style="margin:4px 0;">${escHtml(l.replace(/^\s*-\s+/, ""))}</li>`)
          .join("");
        return `<ul style="margin:8px 0 8px 20px;padding:0;">${items}</ul>`;
      }
      // First line of a multi-line block is treated as a bold heading.
      if (lines.length > 1) {
        const [heading, ...rest] = lines;
        return `<p style="margin:12px 0 4px;font-weight:600;color:#000000;">${escHtml(heading)}</p><p style="margin:0 0 8px;color:#444;">${escHtml(rest.join(" "))}</p>`;
      }
      return `<p style="margin:8px 0;color:#444;">${escHtml(lines[0])}</p>`;
    })
    .join("");
}

export async function getEventSettings(): Promise<EventSettings> {
  const [settings] = await db.select().from(eventSettingsTable);
  if (settings) return settings;
  // Seed defaults if not present
  const [inserted] = await db.insert(eventSettingsTable).values(defaultSettings).returning();
  return inserted;
}

function applySubjectVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/**
 * Escape a value for safe inclusion as HTML text/attribute content. Used to
 * prevent stored-XSS via attendee/billing/promo fields that flow into our
 * branded HTML email templates. Pre-built HTML fragments (calendar blocks,
 * management link section, attendee table HTML, etc.) must NOT be escaped.
 */
export function escHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = parseInt(process.env.SMTP_PORT || "587");

  if (!host || !user || !pass) {
    logger.warn("SMTP credentials not configured â€” emails will be logged but not sent");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

const FROM_EMAIL = process.env.FROM_EMAIL || "douglas@peoplestrategyhub.com";
const FROM_NAME = process.env.FROM_NAME || "SWP Summit";

async function logEmail(
  bookingId: number | null,
  recipient: string,
  type: "confirmation" | "receipt" | "welcome" | "invoice" | "test",
  status: "sent" | "failed" | "pending",
  errorMessage?: string,
) {
  try {
    await db.insert(emailLogsTable).values({
      bookingId,
      recipient,
      type,
      status,
      errorMessage: errorMessage || null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to log email");
  }
}

export async function sendMail(options: {
  to: string | string[];
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  fromName?: string;
  fromEmail?: string;
  bcc?: string | string[];
}): Promise<boolean> {
  const transporter = createTransporter();
  if (!transporter) {
    logger.info(
      { to: options.to, subject: options.subject },
      "Email not sent â€” SMTP not configured",
    );
    return false;
  }

  const fromName = options.fromName || FROM_NAME;
  const fromEmail = options.fromEmail || FROM_EMAIL;

  try {
    const nodemailerAttachments = (options.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
      encoding: "base64",
      contentType: a.contentType,
      contentDisposition: "attachment" as const,
    }));
    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: options.to,
      bcc: options.bcc,
      subject: options.subject,
      html: options.html,
      attachments: nodemailerAttachments,
    });
    return true;
  } catch (err) {
    logger.error({ err, to: options.to }, "Failed to send email");
    return false;
  }
}

type BrandingSettings = {
  eventName?: string;
  eventDate?: string;
  eventVenue?: string;
  orgName?: string;
  orgAddress?: string;
  orgWebsite?: string;
  logoDataUrl?: string | null;
};

const EMAIL_LOGO_SIZE_PX = 96;

export function wrapInBrandedLayout(
  content: string,
  settingsOrTitle?: BrandingSettings | string,
): string {
  const settings: BrandingSettings =
    typeof settingsOrTitle === "object" && settingsOrTitle !== null ? settingsOrTitle : {};

  const eventName = settings.eventName || "SWP Summit";
  const eventDate = settings.eventDate || "Wednesday, 3 March 2027";
  const eventVenue = settings.eventVenue || "1 Basinghall Avenue, London";
  const orgName = settings.orgName || "Dynamic Business Leaders Limited";
  const orgAddress = settings.orgAddress || "London, UK";
  const orgWebsite = settings.orgWebsite || "https://swpsummit.com";
  const logoDataUrl = settings.logoDataUrl;

  const headerContent = logoDataUrl
    ? `<img src="${escHtml(logoDataUrl)}" alt="${escHtml(orgName)}" width="${EMAIL_LOGO_SIZE_PX}" height="${EMAIL_LOGO_SIZE_PX}" style="display:block;width:${EMAIL_LOGO_SIZE_PX}px!important;height:${EMAIL_LOGO_SIZE_PX}px!important;max-width:${EMAIL_LOGO_SIZE_PX}px!important;max-height:${EMAIL_LOGO_SIZE_PX}px!important;margin:0 auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;object-fit:contain;" />`
    : `<strong style="font-size: 20px; color: #004eb9;">${escHtml(eventName)}</strong>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${eventName}</title>
  <style>
    body { font-family: 'Figtree', Arial, sans-serif; background: #f0f6ff; margin: 0; padding: 0; color: #000; }
    .wrapper { max-width: 600px; margin: 0 auto; background: #fff; }
    .header { background: #f0f6ff; padding: 24px 32px; border-bottom: 2px solid #004eb9; text-align: center; }
    .content { padding: 32px; }
    .footer { background: #1a1a1a; color: #ccc; padding: 24px 32px; text-align: center; font-size: 13px; }
    .footer a { color: #266cc7; text-decoration: none; }
    h1, h2, h3 { color: #000; }
    .badge { display: inline-block; background: #f0f6ff; color: #000000; padding: 4px 12px; border-radius: 100px; font-size: 12px; font-weight: 600; }
    .cta-btn { display: inline-block; background: #004eb9; color: #fff; padding: 12px 28px; border-radius: 300px; text-decoration: none; font-weight: 600; margin: 16px 0; }
    .price-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
    .price-total { display: flex; justify-content: space-between; padding: 12px 0; font-weight: 700; font-size: 18px; }
    .info-box { background: #f0f6ff; border: 1px solid #e2e8f0; padding: 16px 20px; border-radius: 4px; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      ${headerContent}
      <div style="font-size: 13px; color: #666; margin-top: 4px;">${eventDate} Â· ${eventVenue}</div>
    </div>
    <div class="content">
      ${content}
    </div>
    <div class="footer">
      <p>&copy; 2027 ${eventName}. All rights reserved.</p>
      <p><a href="${orgWebsite}">${orgWebsite.replace(/^https?:\/\//, "")}</a></p>
      <p style="font-size: 11px; color: #999;">${orgName} Â· ${orgAddress}</p>
    </div>
  </div>
</body>
</html>`;
}

async function buildConfirmationEmailHtml(
  booking: typeof bookingsTable.$inferSelect,
  attendees: Array<typeof attendeesTable.$inferSelect>,
  lead: typeof attendeesTable.$inferSelect,
  settings: EventSettings,
): Promise<{ html: string; subject: string }> {
  const passLabels: Record<string, string> = {
    single: "HR Professional Pass",
    team: "Team Pass (3 seats)",
    business: "Business Pass",
  };
  const passLabel = passLabels[booking.passType] || booking.passType;
  const quantityLabel = booking.quantity === 1 ? "pass" : "passes";

  const subtotal = parseFloat(booking.subtotalAmount?.toString() || "0");
  const vat = parseFloat(booking.vatAmount?.toString() || "0");
  const total = parseFloat(booking.totalAmount?.toString() || "0");
  const promoDiscount = parseFloat(booking.promoDiscountAmount?.toString() || "0");
  const groupDiscount = parseFloat(booking.groupDiscountAmount?.toString() || "0");
  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);

  const attendeeRowsHtml = attendees
    .map(
      (a) => `<tr>
      <td style="padding:8px 4px;border-bottom:1px solid #eee;">${a.isLead ? "âœ“ Lead" : ""}</td>
      <td style="padding:8px 4px;border-bottom:1px solid #eee;">${escHtml(a.firstName)} ${escHtml(a.lastName)}</td>
      <td style="padding:8px 4px;border-bottom:1px solid #eee;">${escHtml(a.jobTitle)}</td>
      <td style="padding:8px 4px;border-bottom:1px solid #eee;">${escHtml(a.company)}</td>
      <td style="padding:8px 4px;border-bottom:1px solid #eee;">${escHtml(a.workEmail)}</td>
      <td style="padding:8px 4px;border-bottom:1px solid #eee;">${a.phone ? escHtml(a.phone) : "â€”"}</td>
    </tr>`,
    )
    .join("");

  const attendeesTableHtml = `<table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
    <thead><tr style="background:#f5f5f5;">
      <th style="padding:8px 4px;text-align:left;">Lead</th>
      <th style="padding:8px 4px;text-align:left;">Name</th>
      <th style="padding:8px 4px;text-align:left;">Job Title</th>
      <th style="padding:8px 4px;text-align:left;">Company</th>
      <th style="padding:8px 4px;text-align:left;">Email</th>
      <th style="padding:8px 4px;text-align:left;">Phone</th>
    </tr></thead>
    <tbody>${attendeeRowsHtml}</tbody>
  </table>`;

  const priceSummaryHtml = [
    `<div class="price-row"><span>Subtotal (excl. VAT)</span><span>${formatCurrency(subtotal)}</span></div>`,
    groupDiscount > 0
      ? `<div class="price-row"><span>Group Discount</span><span>-${formatCurrency(groupDiscount)}</span></div>`
      : "",
    promoDiscount > 0
      ? `<div class="price-row"><span>Promo Code (${escHtml(booking.promoCode)})</span><span>-${formatCurrency(promoDiscount)}</span></div>`
      : "",
    `<div class="price-row"><span>VAT (20%)</span><span>${formatCurrency(vat)}</span></div>`,
    `<div class="price-total"><span>Total</span><span>${formatCurrency(total)}</span></div>`,
  ].join("");

  const manageUrl = booking.managementToken
    ? `${process.env.APP_BASE_URL || "https://register.swpsummit.com"}/manage/${booking.managementToken}`
    : null;
  const managementLinkHtml = manageUrl ? buildManageLinkSection(manageUrl) : "";

  const billingEditUrl =
    booking.managementToken && booking.paymentMethod === "invoice"
      ? `${process.env.APP_BASE_URL || "https://register.swpsummit.com"}/manage/${booking.managementToken}/billing`
      : "";
  const billingEditLinkHtml = billingEditUrl
    ? `<p style="margin:14px 0 0;font-size:14px;"><a href="${billingEditUrl}" style="color:#004eb9;font-weight:600;text-decoration:underline;">${booking.poNumber ? "Update PO number or billing details â†’" : "Add a PO number / update billing details â†’"}</a></p>`
    : "";
  // Inline form: leading <br> renders as a new line both inside the info-box
  // (where neighbouring fields use <br> separators) and in the standalone
  // fallback body. Empty string when no PO so no blank label is ever shown.
  const poNumberHtml = booking.poNumber
    ? `<br><strong>PO Number:</strong> <span style="font-family:monospace;">${escHtml(booking.poNumber)}</span>`
    : "";

  const invoicePaymentButtonHtml = booking.stripeInvoicePaymentUrl
    ? `<p style="margin-top:16px;"><a href="${booking.stripeInvoicePaymentUrl}" style="display:inline-block;background:#004eb9;color:#fff;padding:12px 28px;text-decoration:none;font-weight:bold;font-size:15px;">Download Invoice / Pay Online â†’</a></p>`
    : "";

  // "How invoicing works" help block â€” only rendered for invoice bookings.
  // Pulls admin-editable copy from event_settings (falls back to built-in
  // default) and renders a collapsed-style info card directly in the email.
  const invoiceHelpHtml =
    booking.paymentMethod === "invoice"
      ? `<div style="margin:20px 0;padding:16px 20px;background:#f0f6ff;border:1px solid #e2e8f0;border-radius:6px;">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#000000;">How invoicing works</p>
      ${renderInvoiceHelpHtml(settings.invoiceHelpContent || DEFAULT_INVOICE_HELP_CONTENT)}
    </div>`
      : "";

  const orderRef = booking.orderReference || `#${booking.id}`;

  // Standalone promo summary block â€” surfaced in the email body whenever a
  // promo code reduced the total, so customers can see exactly which code was
  // applied and how much they saved without having to open the attached PDF.
  const promoSummaryHtml =
    promoDiscount > 0 && booking.promoCode
      ? `<div style="margin:18px 0;padding:14px 18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;">
      <p style="margin:0;font-size:14px;font-weight:600;color:#166534;">Promo code applied: <span style="font-family:monospace;">${escHtml(booking.promoCode)}</span></p>
      <p style="margin:6px 0 0;font-size:13px;color:#166534;">You saved <strong>${formatCurrency(promoDiscount)}</strong> on this booking.</p>
    </div>`
      : "";

  // Try to use the DB template
  try {
    const [dbTemplate] = await db
      .select()
      .from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.type, "confirmation"));

    if (dbTemplate) {
      // Body vars: user-controlled values are HTML-escaped; pre-built HTML
      // fragments (calendar links, attendees table, manage-link section,
      // billing-edit link, etc.) MUST be inserted raw.
      const vars: Record<string, string> = {
        "{{firstName}}": escHtml(lead.firstName),
        "{{orderReference}}": escHtml(orderRef),
        "{{passLabel}}": escHtml(passLabel),
        "{{quantity}}": String(booking.quantity),
        "{{quantityLabel}}": quantityLabel,
        "{{attendeesTable}}": attendeesTableHtml,
        "{{priceSummary}}": priceSummaryHtml,
        "{{eventDate}}": escHtml(settings.eventDate || "Wednesday, 3 March 2027"),
        "{{eventVenue}}": escHtml(settings.eventVenue || "1 Basinghall Avenue, London"),
        "{{eventVenuePostcode}}": escHtml(settings.eventVenuePostcode || "EC2V 5DD"),
        "{{managementLink}}": managementLinkHtml,
        "{{invoicePaymentButton}}": invoicePaymentButtonHtml,
        "{{poNumber}}": escHtml(booking.poNumber || ""),
        "{{poNumberSection}}": poNumberHtml,
        "{{billingEditLink}}": billingEditLinkHtml,
        "{{billingEditUrl}}": billingEditUrl,
        "{{promoSummary}}": promoSummaryHtml,
        "{{promoCode}}": escHtml(booking.promoCode || ""),
        "{{promoDiscount}}": promoDiscount > 0 ? formatCurrency(promoDiscount) : "",
        "{{invoiceHelp}}": invoiceHelpHtml,
      };
      const calPh = getCalendarPlaceholders(settings);
      vars["{{eventCalendarLinks}}"] = calPh.eventCalendarLinks;
      vars["{{socialCalendarLinks}}"] = calPh.socialCalendarLinks;
      vars["{{calendarLinks}}"] = calPh.calendarLinks;
      vars["{{googleCalendarUrl}}"] = calPh.googleCalendarUrl;
      vars["{{outlookCalendarUrl}}"] = calPh.outlookCalendarUrl;
      vars["{{icsCalendarUrl}}"] = calPh.icsCalendarUrl;
      vars["{{socialGoogleCalendarUrl}}"] = calPh.socialGoogleCalendarUrl;
      vars["{{socialOutlookCalendarUrl}}"] = calPh.socialOutlookCalendarUrl;
      vars["{{socialIcsCalendarUrl}}"] = calPh.socialIcsCalendarUrl;

      // Subject is a plain-text email header â€” must use raw values, not
      // HTML-escaped ones, otherwise users see literal "&amp;" in their inbox.
      const subjectVars: Record<string, string> = {
        "{{firstName}}": lead.firstName,
        "{{orderReference}}": orderRef,
        "{{passLabel}}": passLabel,
        "{{quantity}}": String(booking.quantity),
        "{{quantityLabel}}": quantityLabel,
        "{{eventDate}}": settings.eventDate || "Wednesday, 3 March 2027",
        "{{eventVenue}}": settings.eventVenue || "1 Basinghall Avenue, London",
        "{{eventVenuePostcode}}": settings.eventVenuePostcode || "EC2V 5DD",
        "{{poNumber}}": booking.poNumber || "",
      };

      let body = dbTemplate.htmlBody;
      // If the DB template predates the new PO/billing-edit placeholders,
      // append a default block so invoice customers always see the link.
      if (
        billingEditLinkHtml &&
        !body.includes("{{billingEditLink}}") &&
        !body.includes("{{billingEditUrl}}") &&
        !body.includes(billingEditUrl)
      ) {
        const fallbackBlock =
          `\n<div style="margin:18px 0;padding:14px 18px;background:#fdf3f1;border:1px solid #f3c8c1;border-radius:6px;">` +
          `<p style="margin:0;font-size:14px;font-weight:600;color:#333;">Need a PO number on your invoice?</p>` +
          `<p style="margin:6px 0 0;font-size:13px;color:#555;">Add or update your PO number and billing details from the secure self-service link below â€” we'll re-issue the invoice automatically.</p>` +
          billingEditLinkHtml +
          `</div>`;
        const extraPo =
          poNumberHtml && !body.includes("{{poNumber}}") && !body.includes("{{poNumberSection}}")
            ? poNumberHtml
            : "";
        const insert = extraPo + fallbackBlock;
        // Detect </body> presence first â€” `.replace()` always returns a truthy
        // string even on no match, so `||` cannot be used as a fallback signal.
        if (/<\/body>/i.test(body)) {
          body = body.replace(/<\/body>/i, `${insert}</body>`);
        } else {
          body += insert;
        }
      }
      // If the DB template predates the new {{invoiceHelp}} placeholder,
      // append the help block so invoice customers always see the guidance
      // (timeline, payment methods, remittance, contact email).
      if (invoiceHelpHtml && !body.includes("{{invoiceHelp}}")) {
        if (/<\/body>/i.test(body)) {
          body = body.replace(/<\/body>/i, `${invoiceHelpHtml}</body>`);
        } else {
          body += invoiceHelpHtml;
        }
      }
      // If the DB template predates the new promo placeholders, append the
      // promo summary block so customers can always see which code was applied
      // and the amount they saved without opening the attached PDF receipt.
      if (
        promoSummaryHtml &&
        !body.includes("{{promoSummary}}") &&
        !body.includes("{{promoCode}}") &&
        !body.includes("{{promoDiscount}}") &&
        !body.includes("{{priceSummary}}")
      ) {
        if (/<\/body>/i.test(body)) {
          body = body.replace(/<\/body>/i, `${promoSummaryHtml}</body>`);
        } else {
          body += promoSummaryHtml;
        }
      }

      for (const [placeholder, value] of Object.entries(vars)) {
        body = body.replaceAll(placeholder, value);
      }

      let subject = dbTemplate.subject;
      for (const [placeholder, value] of Object.entries(subjectVars)) {
        subject = subject.replaceAll(placeholder, value);
      }

      return {
        html: wrapInBrandedLayout(body, settings),
        subject,
      };
    }
  } catch (err) {
    logger.warn(
      { err },
      "Could not load confirmation template from DB â€” using hardcoded fallback",
    );
  }

  // Fallback: hardcoded template
  const fallbackBody = `
    <h2>Booking Confirmed!</h2>
    <p>Dear ${escHtml(lead.firstName)},</p>
    <p>Thank you for registering for the <strong>${escHtml(settings.eventName || "SWP Summit 2027")}</strong>. Your booking is confirmed.</p>
    <div class="info-box">
      <strong>Order Reference:</strong> ${escHtml(orderRef)}<br>
      <strong>Pass Type:</strong> ${escHtml(passLabel)}<br>
      <strong>Quantity:</strong> ${booking.quantity} ${quantityLabel}
      ${poNumberHtml}
    </div>
    <h3>Registered Attendees</h3>${attendeesTableHtml}
    <h3>Price Summary</h3>${priceSummaryHtml}
    <div class="info-box" style="margin-top:24px;">
      <strong>Event Details</strong><br>
      <strong>Date:</strong> ${escHtml(settings.eventDate)}<br>
      <strong>Venue:</strong> ${escHtml(settings.eventVenue)}, ${escHtml(settings.eventVenuePostcode)}
    </div>
    <h3 style="margin-top:28px;margin-bottom:12px;color:#000;">Update Attendee Details Anytime</h3>
    <p style="margin:0 0 16px;color:#444;line-height:1.6;">You have a secure self-service link to manage all your attendee information. You can fill in placeholder seats, update existing details, add dietary requirements â€” all without logging in. Need to share registration with colleagues? Forward them the link to enter their own details.</p>
    ${managementLinkHtml}
    <p>A PDF VAT receipt is attached to this email for your records.</p>
    ${invoicePaymentButtonHtml}
    ${billingEditLinkHtml}
    ${invoiceHelpHtml}
    <p>We look forward to seeing you at the ${settings.eventName || "SWP Summit"}!</p>
  `;

  return {
    html: wrapInBrandedLayout(fallbackBody, settings),
    subject: `Booking Confirmed â€” ${settings.eventName || "SWP Summit"} (${orderRef})`,
  };
}

/**
 * Send the customer-facing confirmation email (with PDF receipt / Stripe
 * invoice attached) for a booking. Returns true if the message was actually
 * accepted by the SMTP server, false otherwise.
 *
 * Split out from `sendBookingEmails` so the booking-confirmation helper can
 * track confirmation vs. welcome delivery as independent retryable side-effects.
 */
export async function sendConfirmationAndReceiptEmail(bookingId: number): Promise<boolean> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    logger.warn({ bookingId }, "Booking not found for confirmation email");
    return false;
  }
  const settings = await getEventSettings();
  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) {
    logger.warn({ bookingId }, "No lead attendee found for confirmation email");
    return false;
  }

  const { html: confirmationHtml, subject: confirmationSubject } = await buildConfirmationEmailHtml(
    booking,
    attendees,
    lead,
    settings,
  );

  let pdfBuffer: Buffer | null = null;
  let pdfFilename = `receipt-${booking.orderReference || bookingId}.pdf`;
  const stripeInvoicePdfUrl = booking.stripeInvoicePdfUrl;
  if (stripeInvoicePdfUrl) {
    try {
      pdfBuffer = await downloadHttpsPdf(stripeInvoicePdfUrl);
      if (pdfBuffer) {
        pdfFilename = `invoice-${booking.orderReference || bookingId}.pdf`;
      }
    } catch (err) {
      logger.warn({ err }, "Could not download Stripe PDF â€” falling back to custom receipt");
    }
  }
  if (!pdfBuffer) {
    try {
      pdfBuffer = await generatePdfReceipt(booking, attendees);
    } catch (err) {
      logger.error({ err }, "Failed to generate PDF receipt");
    }
  }

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (pdfBuffer) {
    attachments.push({ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" });
  }
  const companyInfoPdf = getCompanyInfoPdf();
  if (companyInfoPdf && booking.paymentMethod === "invoice") {
    attachments.push({
      filename: "DBL-company-information.pdf",
      content: companyInfoPdf,
      contentType: "application/pdf",
    });
  }

  const confirmSent = await sendMail({
    to: lead.workEmail,
    subject: confirmationSubject,
    html: confirmationHtml,
    attachments,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
  });

  await logEmail(
    bookingId,
    lead.workEmail,
    "confirmation",
    confirmSent ? "sent" : "failed",
    confirmSent ? undefined : "SMTP not configured or send failed",
  );
  if (pdfBuffer) {
    await logEmail(bookingId, lead.workEmail, "receipt", confirmSent ? "sent" : "failed");
  }

  return confirmSent;
}

/**
 * Send the per-attendee welcome email to every confirmed (non-TBC) attendee
 * on a booking. Returns true only if EVERY welcome email was accepted by SMTP
 * â€” partial success returns false so the booking-confirmation helper retries
 * the whole batch on the next webhook replay (welcomes are deduped per
 * recipient by sendWelcomeEmail's own once-per-attendee guard).
 */
export async function sendAttendeeWelcomeEmails(bookingId: number): Promise<boolean> {
  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const welcomeAttendees = attendees.filter((a) => !a.isTbc);
  let allOk = true;
  for (const attendee of welcomeAttendees) {
    try {
      const ok = await sendWelcomeEmail(bookingId, attendee.firstName, attendee.workEmail);
      if (!ok) allOk = false;
    } catch (err) {
      allOk = false;
      logger.error({ err, bookingId, recipient: attendee.workEmail }, "Welcome email threw");
    }
  }
  return allOk;
}

export async function sendBookingEmails(bookingId: number): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));

  if (!booking) {
    logger.warn({ bookingId }, "Booking not found for email sending");
    return;
  }

  const settings = await getEventSettings();

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));

  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) {
    logger.warn({ bookingId }, "No lead attendee found for email sending");
    return;
  }

  const { html: confirmationHtml, subject: confirmationSubject } = await buildConfirmationEmailHtml(
    booking,
    attendees,
    lead,
    settings,
  );

  // Prefer Stripe invoice PDF, then fall back to our custom receipt
  let pdfBuffer: Buffer | null = null;
  let pdfFilename = `receipt-${booking.orderReference || bookingId}.pdf`;
  const stripeInvoicePdfUrl = booking.stripeInvoicePdfUrl;
  if (stripeInvoicePdfUrl) {
    try {
      pdfBuffer = await downloadHttpsPdf(stripeInvoicePdfUrl);
      if (pdfBuffer) {
        pdfFilename = `invoice-${booking.orderReference || bookingId}.pdf`;
        logger.info(
          { bookingId, sizeBytes: pdfBuffer.length },
          "Using Stripe invoice PDF for email attachment",
        );
      } else {
        logger.warn({ bookingId }, "Stripe PDF not available â€” falling back to custom receipt");
      }
    } catch (err) {
      logger.warn({ err }, "Could not download Stripe PDF â€” falling back to custom receipt");
    }
  }
  if (!pdfBuffer) {
    try {
      pdfBuffer = await generatePdfReceipt(booking, attendees);
      if (pdfBuffer)
        logger.info(
          { bookingId, sizeBytes: pdfBuffer.length },
          "Using custom PDF receipt for email attachment",
        );
    } catch (err) {
      logger.error({ err }, "Failed to generate PDF receipt");
    }
  }

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (pdfBuffer) {
    attachments.push({ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" });
  }
  const companyInfoPdf = getCompanyInfoPdf();
  if (companyInfoPdf && booking.paymentMethod === "invoice") {
    attachments.push({
      filename: "DBL-company-information.pdf",
      content: companyInfoPdf,
      contentType: "application/pdf",
    });
  }

  const confirmSent = await sendMail({
    to: lead.workEmail,
    subject: confirmationSubject,
    html: confirmationHtml,
    attachments,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
  });

  await logEmail(
    bookingId,
    lead.workEmail,
    "confirmation",
    confirmSent ? "sent" : "failed",
    confirmSent ? undefined : "SMTP not configured or send failed",
  );

  if (pdfBuffer) {
    await logEmail(bookingId, lead.workEmail, "receipt", confirmSent ? "sent" : "failed");
  }

  // Send a welcome email to every confirmed (non-TBC) attendee, including the
  // lead. Previously the lead got a standalone `sendWelcomeEmail()` call AND
  // the per-attendee loop excluded them, but the audit flagged that the
  // standalone path could fire twice when both `sendBookingEmails` and a
  // separate caller (e.g. lead-capture) raced. Unifying through one filtered
  // loop guarantees exactly-one welcome per attendee for this booking flow.
  const welcomeAttendees = attendees.filter((a) => !a.isTbc);
  for (const attendee of welcomeAttendees) {
    await sendWelcomeEmail(bookingId, attendee.firstName, attendee.workEmail);
  }
}

/**
 * Send a "your invoice has been re-issued" email to the billing email
 * (falling back to the lead's work email) with the freshly-generated Stripe
 * invoice PDF attached. Used after self-serve or admin billing/PO edits.
 */
export async function sendReissuedInvoiceEmail(bookingId: number): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    logger.warn({ bookingId }, "Booking not found for re-issued invoice email");
    return;
  }
  const settings = await getEventSettings();
  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) return;

  const recipient = booking.billingEmail || lead.workEmail;
  const orderRef = booking.orderReference || `#${bookingId}`;

  // Build the standard confirmation body but prepend a re-issue notice banner
  const { html: bodyHtml, subject: baseSubject } = await buildConfirmationEmailHtml(
    booking,
    attendees,
    lead,
    settings,
  );

  const reissueBanner = `
    <div style="background:#f0f6ff;border:2px solid #004eb9;border-radius:6px;padding:18px 22px;margin:0 0 20px;">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#004eb9;">Your invoice has been re-issued</p>
      <p style="margin:0;font-size:14px;color:#333;line-height:1.5;">
        We've updated your billing details${booking.poNumber ? ` (including PO Number <strong style="font-family:monospace;">${escHtml(booking.poNumber)}</strong>)` : ""} and issued a fresh invoice. The previous invoice has been voided. The latest invoice PDF is attached and a payment link is below.
      </p>
    </div>`;
  // Inject the banner just after the opening branded layout container if
  // present. `.replace()` always returns a truthy string, so we explicitly
  // check whether the marker exists before deciding where to put the banner.
  const containerRe = /(<div class="container"[^>]*>)/i;
  const html = containerRe.test(bodyHtml)
    ? bodyHtml.replace(containerRe, `$1${reissueBanner}`)
    : reissueBanner + bodyHtml;

  let pdfBuffer: Buffer | null = null;
  const pdfFilename = `invoice-${booking.orderReference || bookingId}.pdf`;
  if (booking.stripeInvoicePdfUrl) {
    try {
      pdfBuffer = await downloadHttpsPdf(booking.stripeInvoicePdfUrl);
    } catch (err) {
      logger.warn({ err, bookingId }, "Failed to download re-issued invoice PDF");
    }
  }
  if (!pdfBuffer) {
    try {
      pdfBuffer = await generatePdfReceipt(booking, attendees);
    } catch (err) {
      logger.warn({ err }, "Failed to generate fallback PDF for re-issued invoice");
    }
  }
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (pdfBuffer)
    attachments.push({ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" });

  const sent = await sendMail({
    to: recipient,
    subject: `Updated Invoice â€” ${settings.eventName || "SWP Summit"} (${orderRef})`,
    html,
    attachments,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
  });
  void baseSubject;
  await logEmail(
    bookingId,
    recipient,
    "invoice",
    sent ? "sent" : "failed",
    sent ? undefined : "SMTP not configured or send failed",
  );
}

export async function resendConfirmationAndReceipt(
  bookingId: number,
): Promise<{ recipient: string } | null> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));

  if (!booking) {
    logger.warn({ bookingId }, "Booking not found for email resend");
    return null;
  }

  const settings = await getEventSettings();

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));

  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) {
    logger.warn({ bookingId }, "No lead attendee found for email resend");
    return null;
  }

  const { html: confirmationHtml, subject: confirmationSubject } = await buildConfirmationEmailHtml(
    booking,
    attendees,
    lead,
    settings,
  );

  // Prefer Stripe invoice PDF, then fall back to custom receipt
  let pdfBuffer: Buffer | null = null;
  let pdfFilename = `receipt-${booking.orderReference || bookingId}.pdf`;
  const stripeInvoicePdfUrlResend = booking.stripeInvoicePdfUrl;
  if (stripeInvoicePdfUrlResend) {
    try {
      pdfBuffer = await downloadHttpsPdf(stripeInvoicePdfUrlResend);
      if (pdfBuffer) {
        pdfFilename = `invoice-${booking.orderReference || bookingId}.pdf`;
        logger.info(
          { bookingId, sizeBytes: pdfBuffer.length },
          "Using Stripe invoice PDF for resend",
        );
      } else {
        logger.warn(
          { bookingId },
          "Stripe PDF not available for resend â€” falling back to custom receipt",
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        "Could not download Stripe PDF for resend â€” falling back to custom receipt",
      );
    }
  }
  if (!pdfBuffer) {
    try {
      pdfBuffer = await generatePdfReceipt(booking, attendees);
      if (pdfBuffer)
        logger.info(
          { bookingId, sizeBytes: pdfBuffer.length },
          "Using custom PDF receipt for resend",
        );
    } catch (err) {
      logger.error({ err }, "Failed to generate PDF for resend");
    }
  }

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (pdfBuffer) {
    attachments.push({ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" });
  }
  const companyInfoPdfResend = getCompanyInfoPdf();
  if (companyInfoPdfResend && booking.paymentMethod === "invoice") {
    attachments.push({
      filename: "DBL-company-information.pdf",
      content: companyInfoPdfResend,
      contentType: "application/pdf",
    });
  }

  const recipient = booking.billingEmail || lead.workEmail;
  const sent = await sendMail({
    to: recipient,
    subject: confirmationSubject,
    html: confirmationHtml,
    attachments,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
  });

  await logEmail(
    bookingId,
    recipient,
    "confirmation",
    sent ? "sent" : "failed",
    sent ? undefined : "SMTP not configured or send failed",
  );
  if (pdfBuffer) {
    await logEmail(bookingId, recipient, "receipt", sent ? "sent" : "failed");
  }
  return sent ? { recipient } : null;
}

export async function sendOrganiserNotification(bookingId: number): Promise<boolean> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  // Booking not found â†’ nothing to retry; treat as a terminal success so the
  // delivery flag isn't left flapping forever.
  if (!booking) return true;

  const storedEmails = await db
    .select()
    .from(notificationEmailsTable)
    .orderBy(notificationEmailsTable.createdAt);

  const recipients = sanitizeRecipients([
    ...storedEmails.filter((e) => e.notifyComplete).map((e) => e.email),
    process.env.ORGANISER_EMAIL,
  ]);

  if (recipients.length === 0) {
    logger.info(
      { bookingId },
      "No notification recipients configured â€” skipping organiser notification",
    );
    // No recipients = nothing to deliver; terminal success so the flag flips
    // and we don't keep re-attempting on every webhook replay.
    return true;
  }

  const settings = await getEventSettings();
  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];

  const passLabels: Record<string, string> = {
    single: "HR Professional Pass",
    team: "Team Pass (3 seats)",
    business: "Business Pass",
  };

  const subtotal = parseFloat(booking.subtotalAmount?.toString() || "0");
  const vat = parseFloat(booking.vatAmount?.toString() || "0");
  const total = parseFloat(booking.totalAmount?.toString() || "0");
  const groupDiscount = parseFloat(booking.groupDiscountAmount?.toString() || "0");
  const promoDiscount = parseFloat(booking.promoDiscountAmount?.toString() || "0");

  const attendeeRows = attendees
    .map(
      (a, i) => `
    <tr style="background:${i % 2 === 0 ? "#f9f9f9" : "#fff"}">
      <td style="padding:8px 10px;border:1px solid #e5e5e5">${escHtml(a.firstName)} ${escHtml(a.lastName)}${a.isLead ? ' <span style="font-size:11px;color:#004eb9;font-weight:bold">(Buyer)</span>' : ""}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5">${escHtml(a.workEmail)}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5">${a.phone ? escHtml(a.phone) : "â€”"}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5">${a.jobTitle ? escHtml(a.jobTitle) : "â€”"}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5">${a.company ? escHtml(a.company) : "â€”"}</td>
    </tr>
  `,
    )
    .join("");

  const defaultCompleteSubject = `New Registration: {{orderReference}} â€” {{firstName}} {{lastName}}`;
  const subjectTemplate = settings.notifyCompleteSubject || defaultCompleteSubject;
  const subject = applySubjectVars(subjectTemplate, {
    orderReference: booking.orderReference || `#${bookingId}`,
    firstName: lead?.firstName || "Unknown",
    lastName: lead?.lastName || "",
    eventName: settings.eventName,
    passType: booking.passType,
    quantity: String(booking.quantity),
    paymentMethod: booking.paymentMethod || "",
  });

  const html = wrapInBrandedLayout(`
    <h2 style="margin:0 0 8px;font-size:22px">New Registration Received</h2>
    <p style="margin:0 0 24px;color:#666">A new booking has been completed on the SWP Summit checkout.</p>

    <h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#888">Order Details</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <tr><td style="padding:7px 0;color:#666;width:180px;border-bottom:1px solid #f0f0f0">Order Reference</td><td style="border-bottom:1px solid #f0f0f0"><strong style="font-family:monospace">${escHtml(booking.orderReference || `#${bookingId}`)}</strong></td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Pass Type</td><td style="border-bottom:1px solid #f0f0f0">${passLabels[booking.passType] || booking.passType}</td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Quantity</td><td style="border-bottom:1px solid #f0f0f0">${booking.quantity} ${booking.quantity === 1 ? "ticket" : "tickets"}</td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Payment Method</td><td style="border-bottom:1px solid #f0f0f0">${booking.paymentMethod === "card" ? "Credit/Debit Card" : booking.paymentMethod === "invoice" ? "Invoice" : "â€”"}</td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Status</td><td style="border-bottom:1px solid #f0f0f0"><strong style="color:${booking.status === "paid" ? "#16a34a" : "#d97706"}">${booking.status === "paid" ? "Paid" : booking.status === "invoiced" ? "Invoiced (Awaiting Payment)" : escHtml(booking.status)}</strong></td></tr>
      ${booking.promoCode ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Promo Code</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(booking.promoCode)}</td></tr>` : ""}
    </table>

    <h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#888">Pricing</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <tr><td style="padding:7px 0;color:#666;width:180px;border-bottom:1px solid #f0f0f0">Base Subtotal</td><td style="border-bottom:1px solid #f0f0f0">Â£${subtotal.toFixed(2)}</td></tr>
      ${groupDiscount > 0 ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Group Discount</td><td style="border-bottom:1px solid #f0f0f0;color:#004eb9">-Â£${groupDiscount.toFixed(2)}</td></tr>` : ""}
      ${promoDiscount > 0 ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Promo Discount</td><td style="border-bottom:1px solid #f0f0f0;color:#004eb9">-Â£${promoDiscount.toFixed(2)}</td></tr>` : ""}
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">VAT (20%)</td><td style="border-bottom:1px solid #f0f0f0">Â£${vat.toFixed(2)}</td></tr>
      <tr><td style="padding:7px 0;font-weight:bold;border-bottom:1px solid #f0f0f0">Total</td><td style="border-bottom:1px solid #f0f0f0"><strong>Â£${total.toFixed(2)}</strong></td></tr>
    </table>

    ${
      booking.paymentMethod === "invoice" && booking.billingName
        ? `
    <h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#888">Billing Details</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <tr><td style="padding:7px 0;color:#666;width:180px;border-bottom:1px solid #f0f0f0">Billing Contact</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(booking.billingName)}</td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Company</td><td style="border-bottom:1px solid #f0f0f0">${booking.billingCompany ? escHtml(booking.billingCompany) : "â€”"}</td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Invoice Email</td><td style="border-bottom:1px solid #f0f0f0">${booking.billingEmail ? escHtml(booking.billingEmail) : "â€”"}</td></tr>
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Address</td><td style="border-bottom:1px solid #f0f0f0">${(() => {
        if (booking.billingAddressLine1) {
          const cityRegion =
            booking.billingTown && booking.billingRegion
              ? `${booking.billingTown}, ${booking.billingRegion}`
              : booking.billingTown || booking.billingRegion;
          return [
            booking.billingAddressLine1,
            booking.billingAddressLine2,
            cityRegion,
            booking.billingPostcode,
            booking.billingCountry,
          ]
            .filter(Boolean)
            .map((s) => escHtml(s))
            .join("<br>");
        }
        return escHtml(booking.billingAddress || "â€”").replace(/\n/g, "<br>");
      })()}</td></tr>
      ${booking.billingPhone ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Contact Phone</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(booking.billingPhone)}</td></tr>` : ""}
      ${booking.billingVatNumber ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">VAT Number</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(booking.billingVatNumber)}</td></tr>` : ""}
      ${booking.poNumber ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">PO Number</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace"><strong>${escHtml(booking.poNumber)}</strong></td></tr>` : ""}
    </table>
    `
        : ""
    }

    <h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#888">Attendees (${attendees.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
      <thead>
        <tr style="background:#1e293b;color:#fff">
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Name</th>
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Work Email</th>
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Phone</th>
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Job Title</th>
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Company</th>
        </tr>
      </thead>
      <tbody>
        ${attendeeRows || '<tr><td colspan="5" style="padding:10px;border:1px solid #e5e5e5;color:#888">No attendee details recorded yet</td></tr>'}
      </tbody>
    </table>
  `);

  // sendMail() is non-throwing: it returns false (and logs the underlying
  // SMTP error itself) when delivery fails. Aggregate by inspecting the
  // boolean return so we get an accurate sent/failed split per booking.
  let sentCount = 0;
  const failedRecipients: string[] = [];
  for (const to of recipients) {
    let ok = false;
    try {
      ok = await sendMail({ to, subject, html });
    } catch (err) {
      // Defensive: sendMail should never throw, but if it ever does we log
      // the unexpected error here rather than swallowing it silently.
      logger.error({ err, bookingId, to }, "Organiser notification threw unexpectedly");
    }
    if (ok) {
      sentCount++;
    } else {
      failedRecipients.push(to);
    }
  }
  if (failedRecipients.length > 0) {
    // Single consolidated warning per booking (per task #68 acceptance: "a
    // single warning log per booking with the full recipient list"). Each
    // underlying SMTP failure is already error-logged inside sendMail().
    logger.warn(
      {
        bookingId,
        sentCount,
        failedCount: failedRecipients.length,
        total: recipients.length,
        failedRecipients,
      },
      "Organiser notifications: one or more recipients failed",
    );
  }
  logger.info({ bookingId, sentCount, total: recipients.length }, "Organiser notifications sent");
  // Treat the side-effect as successful only if every recipient was reached.
  // Any partial failure must release the organiserNotified flag so a webhook
  // retry / admin redeliver can re-attempt the unsent recipients.
  return failedRecipients.length === 0 && sentCount > 0;
}

export type BillingEditChange = {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
};

/**
 * Build a list of {field, label, before, after} change descriptors for the
 * billing-edit notification. Only fields that actually changed are returned.
 * Empty/null values render as "â€”" in the email so organisers can see when a
 * customer cleared a field.
 */
export function diffBillingFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): BillingEditChange[] {
  const fields: Array<{ key: string; label: string }> = [
    { key: "poNumber", label: "PO Number" },
    { key: "billingName", label: "Billing Contact" },
    { key: "billingCompany", label: "Company" },
    { key: "billingEmail", label: "Invoice Email" },
    { key: "billingAddressLine1", label: "Address Line 1" },
    { key: "billingAddressLine2", label: "Address Line 2" },
    { key: "billingTown", label: "Town / City" },
    { key: "billingRegion", label: "Region / State" },
    { key: "billingPostcode", label: "Postcode" },
    { key: "billingCountry", label: "Country" },
    { key: "billingPhone", label: "Contact Phone" },
    { key: "billingVatNumber", label: "VAT Number" },
  ];
  const norm = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };
  const out: BillingEditChange[] = [];
  for (const { key, label } of fields) {
    const a = norm(before[key]);
    const b = norm(after[key]);
    if (a !== b) out.push({ field: key, label, before: a, after: b });
  }
  return out;
}

/**
 * Notify organisers when a customer self-serves a PO/billing edit on their
 * booking via /manage/:token/billing. Honours the `notifyBillingEdit` flag on
 * the notificationEmailsTable (defaults to true). Returns true when every
 * recipient was reached (or when there was nothing to do).
 */
export async function sendBillingEditNotification(
  bookingId: number,
  changes: BillingEditChange[],
): Promise<boolean> {
  if (changes.length === 0) {
    logger.info({ bookingId }, "Billing edit notification skipped â€” no field changes detected");
    return true;
  }

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return true;

  const storedEmails = await db
    .select()
    .from(notificationEmailsTable)
    .orderBy(notificationEmailsTable.createdAt);

  const recipients = sanitizeRecipients([
    ...storedEmails.filter((e) => e.notifyBillingEdit).map((e) => e.email),
    process.env.ORGANISER_EMAIL,
  ]);

  if (recipients.length === 0) {
    logger.info(
      { bookingId },
      "No notification recipients configured â€” skipping billing edit notification",
    );
    return true;
  }

  const settings = await getEventSettings();
  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];

  const orderRef = booking.orderReference || `#${bookingId}`;
  const editedAtStr = new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const renderVal = (v: string | null): string =>
    v === null
      ? `<span style="color:#999">â€”</span>`
      : `<span style="font-family:monospace">${escHtml(v)}</span>`;

  const changesRows = changes
    .map(
      (c, i) => `
    <tr style="background:${i % 2 === 0 ? "#f9f9f9" : "#fff"}">
      <td style="padding:8px 10px;border:1px solid #e5e5e5;font-weight:600;width:170px">${escHtml(c.label)}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5;color:#b91c1c">${renderVal(c.before)}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5;color:#15803d">${renderVal(c.after)}</td>
    </tr>`,
    )
    .join("");

  const subject = `Billing details updated: ${orderRef}${lead ? ` â€” ${lead.firstName} ${lead.lastName}` : ""}`;

  const html = wrapInBrandedLayout(
    `
    <h2 style="margin:0 0 8px;font-size:22px">Customer updated billing details</h2>
    <p style="margin:0 0 24px;color:#666">A customer just edited their PO number / billing details from the self-service portal. The Stripe invoice has been re-issued and re-emailed to them automatically.</p>

    <h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#888">Booking</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <tr><td style="padding:7px 0;color:#666;width:180px;border-bottom:1px solid #f0f0f0">Order Reference</td><td style="border-bottom:1px solid #f0f0f0"><strong style="font-family:monospace">${escHtml(orderRef)}</strong></td></tr>
      ${lead ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Buyer</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(lead.firstName)} ${escHtml(lead.lastName)} &lt;${escHtml(lead.workEmail)}&gt;</td></tr>` : ""}
      <tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Edited At</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(editedAtStr)}</td></tr>
      ${booking.stripeInvoiceId ? `<tr><td style="padding:7px 0;color:#666;border-bottom:1px solid #f0f0f0">Stripe Invoice</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace">${escHtml(booking.stripeInvoiceId)}</td></tr>` : ""}
    </table>

    <h3 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#888">Changes (${changes.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
      <thead>
        <tr style="background:#1e293b;color:#fff">
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Field</th>
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Was</th>
          <th style="padding:9px 10px;text-align:left;border:1px solid #1e293b">Now</th>
        </tr>
      </thead>
      <tbody>${changesRows}</tbody>
    </table>

    <p style="margin:0;color:#666;font-size:13px">Update your internal records (finance / CRM) to reflect the new details. The customer has already received the re-issued invoice by email.</p>
  `,
    settings,
  );

  let sentCount = 0;
  const failedRecipients: string[] = [];
  for (const to of recipients) {
    let ok = false;
    try {
      ok = await sendMail({ to, subject, html });
    } catch (err) {
      logger.error({ err, bookingId, to }, "Billing edit notification threw unexpectedly");
    }
    if (ok) {
      sentCount++;
    } else {
      failedRecipients.push(to);
    }
  }
  if (failedRecipients.length > 0) {
    logger.warn(
      {
        bookingId,
        sentCount,
        failedCount: failedRecipients.length,
        total: recipients.length,
        failedRecipients,
      },
      "Billing edit notifications: one or more recipients failed",
    );
  }
  logger.info(
    { bookingId, sentCount, total: recipients.length, changeCount: changes.length },
    "Billing edit notifications sent",
  );
  return failedRecipients.length === 0 && sentCount > 0;
}

export async function sendIncompleteFormNotification(bookingId: number): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return;

  const storedEmails = await db
    .select()
    .from(notificationEmailsTable)
    .orderBy(notificationEmailsTable.createdAt);

  const recipients = sanitizeRecipients([
    ...storedEmails.filter((e) => e.notifyIncomplete).map((e) => e.email),
    process.env.ORGANISER_EMAIL,
  ]);

  if (recipients.length === 0) {
    logger.info(
      { bookingId },
      "No notification recipients configured â€” skipping incomplete form notification",
    );
    return;
  }

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) return;

  const passLabels: Record<string, string> = {
    single: "HR Professional Pass (HR Professional)",
    team: "Team Pass (3 seats)",
    business: "Business Pass (Vendor/Consultant)",
  };

  const submittedAt = booking.updatedAt || booking.createdAt;
  const submittedAtStr = submittedAt
    ? new Date(submittedAt).toLocaleString("en-GB", {
        timeZone: "Europe/London",
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "Unknown";

  const dataRows = [
    ["First Name", lead.firstName],
    ["Last Name", lead.lastName],
    ["Email", lead.workEmail],
    ["Company", lead.company || "â€”"],
    ["Job Title", lead.jobTitle || "â€”"],
    ["Pass Type", passLabels[booking.passType] || booking.passType],
    ["Quantity", String(booking.quantity)],
    ["Submitted At", submittedAtStr],
  ];

  const tableRows = dataRows
    .map(
      ([label, value], i) => `
    <tr style="background:${i % 2 === 0 ? "#1e293b" : "#263548"}">
      <td style="padding:11px 16px;font-weight:bold;color:#94a3b8;font-size:13px;width:160px;border-bottom:1px solid #334155">${escHtml(label)}</td>
      <td style="padding:11px 16px;color:#f1f5f9;font-size:13px;border-bottom:1px solid #334155">${escHtml(value)}</td>
    </tr>
  `,
    )
    .join("");

  const settings = await getEventSettings();
  const defaultIncompleteSubject = `Incomplete Registration: {{firstName}} {{lastName}} â€” {{eventName}}`;
  const subject = applySubjectVars(settings.notifyIncompleteSubject || defaultIncompleteSubject, {
    firstName: lead.firstName,
    lastName: lead.lastName,
    eventName: settings.eventName,
    passType: passLabels[booking.passType] || booking.passType,
    quantity: String(booking.quantity),
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:32px 16px">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

          <!-- Header -->
          <tr>
            <td style="background:#1e293b;padding:32px 32px 24px;border-radius:4px 4px 0 0">
              <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em">
                Incomplete SWP Summit Registration
              </h1>
              <p style="margin:0;font-size:14px;color:#64748b">
                SWP Summit &mdash; 3 Mar 2027, 1 Basinghall Avenue, London
              </p>
            </td>
          </tr>

          <!-- Warning banner -->
          <tr>
            <td style="background:#854d0e;padding:12px 32px">
              <p style="margin:0;font-size:14px;color:#fef9c3">
                This person submitted their details but has <strong style="color:#fef08a">not yet completed payment</strong>.
              </p>
            </td>
          </tr>

          <!-- Data table -->
          <tr>
            <td style="background:#1e293b;padding:0">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                ${tableRows}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0f172a;padding:20px 32px;border-top:1px solid #1e293b;border-radius:0 0 4px 4px">
              <p style="margin:0;font-size:12px;color:#475569">
                SWP Summit &bull; Dynamic Business Leaders Limited &bull; This is an internal organiser notification.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // See note in sendOrganiserNotification: sendMail returns false on failure
  // rather than throwing, so we aggregate based on the boolean return.
  let sentCount = 0;
  const failedRecipients: string[] = [];
  for (const to of recipients) {
    let ok = false;
    try {
      ok = await sendMail({ to, subject, html });
    } catch (err) {
      logger.error({ err, bookingId, to }, "Incomplete form notification threw unexpectedly");
    }
    if (ok) {
      sentCount++;
    } else {
      failedRecipients.push(to);
    }
  }
  if (failedRecipients.length > 0) {
    // See sendOrganiserNotification: warn-level consolidated summary.
    logger.warn(
      {
        bookingId,
        sentCount,
        failedCount: failedRecipients.length,
        total: recipients.length,
        failedRecipients,
      },
      "Incomplete form notifications: one or more recipients failed",
    );
  }
  logger.info(
    { bookingId, sentCount, total: recipients.length },
    "Incomplete form notifications sent",
  );
}

/**
 * Drop empty / whitespace / invalid (no `@`) entries and trim. Without this,
 * a stray blank row in `notification_emails` (or an empty ORGANISER_EMAIL env
 * var) would make nodemailer throw EENVELOPE "No recipients defined" on every
 * delivery, leaving the organiserNotified flag stuck at false and the booking
 * permanently flagged as "needs attention" in the admin panel.
 */
function sanitizeRecipients(raw: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (!r) continue;
    const trimmed = r.trim();
    if (!trimmed || !trimmed.includes("@")) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function getOrganiserEmails(): Promise<string[]> {
  const storedEmails = await db
    .select()
    .from(notificationEmailsTable)
    .orderBy(notificationEmailsTable.createdAt);
  return sanitizeRecipients([
    ...storedEmails.filter((e) => e.notifyComplete).map((e) => e.email),
    process.env.ORGANISER_EMAIL,
  ]);
}

function formatCalendarRangeLabel(start: Date, end: Date, tz: string): string {
  try {
    const dateFmt = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: tz,
    });
    const timeFmt = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });
    return `${dateFmt.format(start)} Â· ${timeFmt.format(start)}â€“${timeFmt.format(end)}`;
  } catch {
    return `${start.toUTCString()} â€“ ${end.toUTCString()}`;
  }
}

export type CalendarPlaceholders = {
  eventCalendarLinks: string;
  socialCalendarLinks: string;
  calendarLinks: string; // backward-compat: event + social concatenated
  googleCalendarUrl: string;
  outlookCalendarUrl: string;
  icsCalendarUrl: string;
  socialGoogleCalendarUrl: string;
  socialOutlookCalendarUrl: string;
  socialIcsCalendarUrl: string;
};

function renderCalendarBlockHtml(opts: {
  heading: string;
  title: string;
  subtitle: string;
  google: string;
  outlook: string;
  icsUrl: string;
}): string {
  return `
    <div style="margin:24px 0;">
      <h3 style="margin:0 0 8px;color:#000;">${opts.heading}</h3>
      <div style="border:1px solid #e2e8f0;border-radius:6px;padding:18px 20px;margin:12px 0;background:#fff;">
        <p style="margin:0 0 4px;font-weight:700;font-size:15px;color:#000;">${opts.title}</p>
        <p style="margin:0 0 14px;font-size:13px;color:#666;">${opts.subtitle}</p>
        <p style="margin:0;">
          <a href="${opts.google}" style="display:inline-block;background:#004eb9;color:#fff;padding:9px 18px;border-radius:300px;text-decoration:none;font-weight:600;font-size:13px;margin:4px 6px 4px 0;">Add to Google Calendar</a>
          <a href="${opts.outlook}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:9px 18px;border-radius:300px;text-decoration:none;font-weight:600;font-size:13px;margin:4px 6px 4px 0;">Add to Outlook</a>
          <a href="${opts.icsUrl}" style="display:inline-block;background:#fff;color:#000;border:1px solid #000;padding:8px 18px;border-radius:300px;text-decoration:none;font-weight:600;font-size:13px;margin:4px 6px 4px 0;">Download .ics (Apple / other)</a>
        </p>
      </div>
    </div>`;
}

function renderSocialTbcHtml(): string {
  return `
    <div style="margin:24px 0;">
      <h3 style="margin:0 0 8px;color:#000;">Pre-event social</h3>
      <div style="border:1px dashed #e2e8f0;border-radius:6px;padding:18px 20px;margin:12px 0;background:#f0f6ff;">
        <p style="margin:0;font-size:14px;color:#444;line-height:1.5;">
          Details to follow â€” we'll be in touch closer to the date with the time, venue, and an invite you can pop in your calendar.
        </p>
      </div>
    </div>`;
}

export function getCalendarPlaceholders(settings: EventSettings): CalendarPlaceholders {
  const appBaseUrl = process.env.APP_BASE_URL || "https://register.swpsummit.com";
  const tz = settings.eventTimezone || "Europe/London";

  let eventCalendarLinks = "";
  let googleCalendarUrl = "";
  let outlookCalendarUrl = "";
  let icsCalendarUrl = "";

  if (settings.eventStartAt && settings.eventEndAt) {
    const start = new Date(settings.eventStartAt);
    const end = new Date(settings.eventEndAt);
    const eventName = settings.eventName || "SWP Summit";
    const location =
      [settings.eventVenue, settings.eventVenuePostcode].filter(Boolean).join(", ") || null;
    const ev: CalendarEvent = {
      uid: `event-settings-${settings.id}-main@swpsummit.com`,
      title: eventName,
      description: settings.eventDescription || null,
      location,
      startAt: start,
      endAt: end,
      url: settings.orgWebsite,
    };
    googleCalendarUrl = buildGoogleCalendarUrl(ev, tz);
    outlookCalendarUrl = buildOutlookCalendarUrl(ev);
    icsCalendarUrl = `${appBaseUrl}/api/calendar/main.ics`;
    eventCalendarLinks = renderCalendarBlockHtml({
      heading: "Save the date",
      title: eventName,
      subtitle: formatCalendarRangeLabel(start, end, tz) + (location ? ` Â· ${location}` : ""),
      google: googleCalendarUrl,
      outlook: outlookCalendarUrl,
      icsUrl: icsCalendarUrl,
    });
  }

  let socialCalendarLinks = renderSocialTbcHtml();
  let socialGoogleCalendarUrl = "";
  let socialOutlookCalendarUrl = "";
  let socialIcsCalendarUrl = "";

  if (settings.socialEnabled && settings.socialStartAt && settings.socialEndAt) {
    const start = new Date(settings.socialStartAt);
    const end = new Date(settings.socialEndAt);
    const name = settings.socialName || "Pre-Event Social";
    const ev: CalendarEvent = {
      uid: `event-settings-${settings.id}-social@swpsummit.com`,
      title: name,
      description: settings.socialDescription || null,
      location: settings.socialVenue || null,
      startAt: start,
      endAt: end,
      url: settings.orgWebsite,
    };
    socialGoogleCalendarUrl = buildGoogleCalendarUrl(ev, tz);
    socialOutlookCalendarUrl = buildOutlookCalendarUrl(ev);
    socialIcsCalendarUrl = `${appBaseUrl}/api/calendar/social.ics`;
    socialCalendarLinks = renderCalendarBlockHtml({
      heading: "Pre-event social",
      title: name,
      subtitle:
        formatCalendarRangeLabel(start, end, tz) +
        (settings.socialVenue ? ` Â· ${settings.socialVenue}` : ""),
      google: socialGoogleCalendarUrl,
      outlook: socialOutlookCalendarUrl,
      icsUrl: socialIcsCalendarUrl,
    });
  }

  return {
    eventCalendarLinks,
    socialCalendarLinks,
    calendarLinks: eventCalendarLinks + socialCalendarLinks,
    googleCalendarUrl,
    outlookCalendarUrl,
    icsCalendarUrl,
    socialGoogleCalendarUrl,
    socialOutlookCalendarUrl,
    socialIcsCalendarUrl,
  };
}

// Backward-compat shim â€” returns combined block
export function buildCalendarLinksSection(settings: EventSettings): string {
  return getCalendarPlaceholders(settings).calendarLinks;
}

function buildManageLinkSection(manageUrl: string): string {
  return `
    <div style="margin: 28px 0; background: #f0f6ff; border: 2px solid #004eb9; border-radius: 6px; overflow: hidden;">
      <div style="background: #004eb9; padding: 14px 24px;">
        <p style="margin: 0; font-size: 15px; font-weight: 700; color: #fff; letter-spacing: -0.01em;">
          Manage Your Attendee Details Online
        </p>
      </div>
      <div style="padding: 20px 24px;">
        <p style="margin: 0 0 12px; font-size: 14px; color: #444; line-height: 1.6;">
          Your booking comes with a secure self-service link that lets you fill in or update attendee details at any time â€” <strong>no login or account needed</strong>. Use it to:
        </p>
        <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 14px; color: #444; line-height: 2;">
          <li>Fill in details for any placeholder (TBC) attendee seats</li>
          <li>Update names, job titles, companies, and email addresses</li>
          <li>Add dietary or accessibility requirements</li>
          <li>Forward the link to colleagues so they can enter their own details directly</li>
        </ul>
        <p style="text-align: center; margin: 20px 0 16px;">
          <a href="${manageUrl}" style="display: inline-block; background: #004eb9; color: #fff; padding: 13px 32px; border-radius: 300px; text-decoration: none; font-weight: 700; font-size: 15px;">
            Manage Attendees â†’
          </a>
        </p>
        <p style="margin: 0 0 6px; font-size: 13px; color: #888; text-align: center;">Or copy this link:</p>
        <p style="margin: 0; text-align: center;">
          <a href="${manageUrl}" style="font-size: 12px; color: #004eb9; word-break: break-all; font-family: monospace;">${manageUrl}</a>
        </p>
        <p style="margin: 14px 0 0; font-size: 12px; color: #aaa; text-align: center;">
          Keep this link safe â€” anyone with it can view and update attendee details for your booking.
        </p>
      </div>
    </div>`;
}

export async function sendWelcomeEmail(
  bookingId: number | null,
  firstName: string,
  toEmail: string,
): Promise<boolean> {
  try {
    const [template] = await db
      .select()
      .from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.type, "welcome"));

    if (!template) {
      logger.warn("No welcome email template found");
      return false;
    }

    const settings = await getEventSettings();
    const appBaseUrl = process.env.APP_BASE_URL || "https://register.swpsummit.com";

    let manageLinkHtml = "";
    if (bookingId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));
      if (booking?.managementToken) {
        manageLinkHtml = buildManageLinkSection(`${appBaseUrl}/manage/${booking.managementToken}`);
      }
    }

    const calPh = getCalendarPlaceholders(settings);

    const safeFirstName = escHtml(firstName);
    const personalised = template.htmlBody
      .replace(/\{\{firstName\}\}/g, safeFirstName)
      .replace(/\{\{name\}\}/g, safeFirstName)
      .replace(/\{\{managementLink\}\}/g, manageLinkHtml)
      .replace(/\{\{eventCalendarLinks\}\}/g, calPh.eventCalendarLinks)
      .replace(/\{\{socialCalendarLinks\}\}/g, calPh.socialCalendarLinks)
      .replace(/\{\{calendarLinks\}\}/g, calPh.calendarLinks)
      .replace(/\{\{googleCalendarUrl\}\}/g, calPh.googleCalendarUrl)
      .replace(/\{\{outlookCalendarUrl\}\}/g, calPh.outlookCalendarUrl)
      .replace(/\{\{icsCalendarUrl\}\}/g, calPh.icsCalendarUrl)
      .replace(/\{\{socialGoogleCalendarUrl\}\}/g, calPh.socialGoogleCalendarUrl)
      .replace(/\{\{socialOutlookCalendarUrl\}\}/g, calPh.socialOutlookCalendarUrl)
      .replace(/\{\{socialIcsCalendarUrl\}\}/g, calPh.socialIcsCalendarUrl);

    const html = wrapInBrandedLayout(personalised, settings);

    const sent = await sendMail({
      to: toEmail,
      subject: template.subject,
      html,
      fromName: settings.fromName,
      fromEmail: settings.fromEmail,
    });

    await logEmail(
      bookingId,
      toEmail,
      "welcome",
      sent ? "sent" : "failed",
      sent ? undefined : "SMTP not configured or send failed",
    );
    return sent;
  } catch (err) {
    logger.error({ err }, "Failed to send welcome email");
    return false;
  }
}

export async function sendAttendeeChangeNotification(
  bookingId: number,
  attendeeId: number,
  updatedData: {
    firstName: string;
    lastName: string;
    jobTitle?: string;
    company?: string;
    workEmail: string;
  },
): Promise<void> {
  try {
    const recipients = await getOrganiserEmails();
    if (recipients.length === 0) {
      logger.info(
        { bookingId, attendeeId },
        "No notification recipients â€” skipping attendee change notification",
      );
      return;
    }

    const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
    if (!booking) return;

    const settings = await getEventSettings();
    const orderRef =
      booking.orderReference || `${settings.refPrefix}-${settings.refOffset + bookingId}`;
    const changedAt = new Date().toLocaleString("en-GB", {
      timeZone: "Europe/London",
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });

    const defaultAttendeeSubject = `Attendee Details Updated â€” {{orderReference}} â€” {{firstName}} {{lastName}}`;
    const subject = applySubjectVars(settings.notifyAttendeeSubject || defaultAttendeeSubject, {
      orderReference: orderRef,
      firstName: updatedData.firstName,
      lastName: updatedData.lastName,
      eventName: settings.eventName,
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:32px 16px">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
          <tr>
            <td style="background:#1e293b;padding:32px 32px 24px;border-radius:4px 4px 0 0">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f8fafc;letter-spacing:-0.02em">
                Attendee Details Updated
              </h1>
              <p style="margin:0;font-size:14px;color:#64748b">
                SWP Summit &mdash; Self-Service Change Notification
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#166534;padding:12px 32px">
              <p style="margin:0;font-size:14px;color:#dcfce7">
                An attendee updated their details via the self-service management link at <strong style="color:#bbf7d0">${changedAt}</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#1e293b;padding:0">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                ${[
                  ["Order Reference", orderRef],
                  ["Attendee ID", String(attendeeId)],
                  ["First Name", updatedData.firstName],
                  ["Last Name", updatedData.lastName],
                  ["Job Title", updatedData.jobTitle || "â€”"],
                  ["Company", updatedData.company || "â€”"],
                  ["Work Email", updatedData.workEmail],
                  ["Changed At", changedAt],
                ]
                  .map(
                    ([label, value], i) => `
                  <tr style="background:${i % 2 === 0 ? "#1e293b" : "#263548"}">
                    <td style="padding:11px 16px;font-weight:bold;color:#94a3b8;font-size:13px;width:160px;border-bottom:1px solid #334155">${escHtml(label)}</td>
                    <td style="padding:11px 16px;color:#f1f5f9;font-size:13px;border-bottom:1px solid #334155">${escHtml(value)}</td>
                  </tr>`,
                  )
                  .join("")}
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#0f172a;padding:20px 32px;border-top:1px solid #1e293b;border-radius:0 0 4px 4px">
              <p style="margin:0;font-size:12px;color:#475569">
                SWP Summit &bull; ${settings.orgName} &bull; Internal organiser notification
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    // See note in sendOrganiserNotification: sendMail returns false on
    // failure rather than throwing, so aggregate from the boolean return.
    let sentCount = 0;
    const failedRecipients: string[] = [];
    for (const to of recipients) {
      let ok = false;
      try {
        ok = await sendMail({ to, subject, html });
      } catch (err) {
        logger.error(
          { err, bookingId, attendeeId, to },
          "Attendee change notification threw unexpectedly",
        );
      }
      if (ok) {
        sentCount++;
      } else {
        failedRecipients.push(to);
      }
    }
    if (failedRecipients.length > 0) {
      // See sendOrganiserNotification: warn-level consolidated summary.
      logger.warn(
        {
          bookingId,
          attendeeId,
          sentCount,
          failedCount: failedRecipients.length,
          total: recipients.length,
          failedRecipients,
        },
        "Attendee change notifications: one or more recipients failed",
      );
    }
    logger.info({ bookingId, attendeeId, sentCount }, "Attendee change notifications sent");
  } catch (err) {
    logger.error({ err }, "Failed to send attendee change notification");
  }
}

export async function sendCheckoutExpiredEmail(bookingId: number): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return;

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) return;

  const settings = await getEventSettings();
  const organisers = await getOrganiserEmails();

  const name = `${lead.firstName} ${lead.lastName}`;
  const safeName = escHtml(name);
  const checkoutUrl = settings.orgWebsite || "https://swpsummit.com";

  const html = wrapInBrandedLayout(
    `
    <div style="background:#fff3cd;border:1px solid #ffc107;padding:16px 20px;border-radius:4px;margin-bottom:24px;">
      <strong style="color:#856404;">Checkout session expired</strong>
    </div>
    <h2 style="margin-top:0;">Incomplete Registration â€” Session Expired</h2>
    <p>Hi ${safeName},</p>
    <p>Your checkout session for <strong>SWP Summit 2027</strong> expired before the payment was completed. This usually happens if the browser was left open for more than 24 hours without submitting payment.</p>
    <p><strong>Your booking details are still saved.</strong> To complete your registration, simply return to the checkout and restart the payment step â€” you won't need to re-enter your attendee information.</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${checkoutUrl}" class="cta-btn" style="display:inline-block;background:#004eb9;color:#fff;padding:12px 28px;border-radius:300px;text-decoration:none;font-weight:600;">
        Return to Checkout â†’
      </a>
    </p>
    <p style="color:#666;font-size:14px;">If you have any questions, please contact us at <a href="mailto:douglas@dynamicbusinessleaders.co.uk">douglas@dynamicbusinessleaders.co.uk</a>.</p>
  `,
    settings,
  );

  const recipientEmail = booking.billingEmail || lead.workEmail;

  await sendMail({
    to: recipientEmail,
    bcc: organisers.length > 0 ? organisers : undefined,
    subject: `Action Required: Your SWP Summit checkout session expired â€” ${name}`,
    html,
  });

  logger.info({ bookingId, to: recipientEmail }, "Checkout expired email sent");
}

export async function sendRefundConfirmationEmail(
  bookingId: number,
  refundAmountPence: number,
): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return;

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) return;

  const settings = await getEventSettings();
  const recipients = await getOrganiserEmails();

  const name = `${lead.firstName} ${lead.lastName}`;
  const refundAmount = (refundAmountPence / 100).toFixed(2);
  const orderRef = booking.orderReference || defaultOrderRef(bookingId);

  const html = wrapInBrandedLayout(
    `
    <h2 style="margin-top:0;">Your Refund Has Been Processed</h2>
    <p>Hi ${escHtml(name)},</p>
    <p>We have processed a refund for your registration at <strong>SWP Summit 2027</strong>. The amount will appear in your account within 5â€“10 business days depending on your bank.</p>
    <div class="info-box">
      <table style="width:100%;font-size:15px;">
        <tr><td style="color:#666;padding:4px 0;">Booking Reference</td><td style="text-align:right;font-family:monospace;font-weight:600;">${escHtml(orderRef)}</td></tr>
        <tr><td style="color:#666;padding:4px 0;">Refund Amount</td><td style="text-align:right;font-weight:700;color:#004eb9;">Â£${refundAmount}</td></tr>
        <tr><td style="color:#666;padding:4px 0;">Status</td><td style="text-align:right;">Refunded &amp; Booking Cancelled</td></tr>
      </table>
    </div>
    <p>If you have any questions about your refund, please contact us at <a href="mailto:douglas@dynamicbusinessleaders.co.uk">douglas@dynamicbusinessleaders.co.uk</a> quoting your booking reference above.</p>
    <p>We hope to see you at a future event.</p>
  `,
    settings,
  );

  await sendMail({
    to: booking.billingEmail || lead.workEmail,
    bcc: recipients.length > 0 ? recipients : undefined,
    subject: `Refund Confirmed â€” SWP Summit 2027 (${orderRef})`,
    html,
  });

  logger.info({ bookingId, refundAmount }, "Refund confirmation email sent");
}

export async function sendInvoicePaymentFailedEmail(
  bookingId: number,
  declineReason?: string,
  attemptCount?: number,
): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return;

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) return;

  const settings = await getEventSettings();
  const recipients = await getOrganiserEmails();

  const name = `${lead.firstName} ${lead.lastName}`;
  const orderRef = booking.orderReference || defaultOrderRef(bookingId);
  const paymentUrl = booking.stripeInvoicePaymentUrl;

  const attemptNote = attemptCount
    ? `<p style="color:#666;font-size:14px;">Payment attempt: <strong>${attemptCount}</strong>.</p>`
    : "";

  const declineNote = declineReason
    ? `<div style="background:#f8d7da;border:1px solid #f5c2c7;padding:12px 16px;border-radius:4px;margin:16px 0;font-size:14px;color:#842029;">
        <strong>Reason:</strong> ${escHtml(declineReason)}
      </div>`
    : "";

  const html = wrapInBrandedLayout(
    `
    <div style="background:#fff3cd;border:1px solid #ffc107;padding:16px 20px;border-radius:4px;margin-bottom:24px;">
      <strong style="color:#856404;">Invoice payment unsuccessful</strong>
    </div>
    <h2 style="margin-top:0;">Action Required: Invoice Payment Failed</h2>
    <p>Hi ${escHtml(name)},</p>
    <p>We attempted to collect payment for your SWP Summit 2027 invoice but the payment was unsuccessful. Your booking reference is <strong>${escHtml(orderRef)}</strong>.</p>
    ${declineNote}
    ${attemptNote}
    <p>Please use the button below to pay your invoice. If you continue to have difficulties, contact your bank or reach out to us directly.</p>
    ${
      paymentUrl
        ? `
    <p style="text-align:center;margin:32px 0;">
      <a href="${paymentUrl}" class="cta-btn" style="display:inline-block;background:#004eb9;color:#fff;padding:12px 28px;border-radius:300px;text-decoration:none;font-weight:600;">
        Pay Invoice Now â†’
      </a>
    </p>
    `
        : ""
    }
    <p style="color:#666;font-size:14px;">If you need assistance, email us at <a href="mailto:douglas@dynamicbusinessleaders.co.uk">douglas@dynamicbusinessleaders.co.uk</a> or call <a href="tel:+447763618052">07763 618052</a>.</p>
  `,
    settings,
  );

  await sendMail({
    to: booking.billingEmail || lead.workEmail,
    bcc: recipients.length > 0 ? recipients : undefined,
    subject: `Action Required: Invoice Payment Failed â€” SWP Summit 2027 (${orderRef})`,
    html,
  });

  logger.info(
    { bookingId, orderRef, declineReason, attemptCount },
    "Invoice payment failed email sent",
  );
}

export async function sendDisputeAlertEmail(
  bookingId: number,
  disputeId: string,
  disputeAmountPence: number,
  disputeReason: string,
  evidenceDueBy: Date | null,
): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return;

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];

  const settings = await getEventSettings();
  const recipients = await getOrganiserEmails();
  if (recipients.length === 0) {
    logger.warn(
      { bookingId, disputeId },
      "sendDisputeAlertEmail: no organiser emails configured, skipping",
    );
    return;
  }

  const customerName = lead ? `${lead.firstName} ${lead.lastName}` : "Unknown";
  const orderRef = booking.orderReference || defaultOrderRef(bookingId);
  const disputeAmount = (disputeAmountPence / 100).toFixed(2);
  const deadlineStr = evidenceDueBy
    ? evidenceDueBy.toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "Check Stripe dashboard";
  const stripeUrl = `https://dashboard.stripe.com/disputes/${disputeId}`;

  const html = wrapInBrandedLayout(
    `
    <div style="background:#f8d7da;border:2px solid #dc3545;padding:16px 20px;border-radius:4px;margin-bottom:24px;">
      <strong style="color:#842029;font-size:16px;">ðŸš¨ Chargeback / Dispute Filed</strong>
    </div>
    <h2 style="margin-top:0;color:#842029;">Urgent: Payment Dispute Received</h2>
    <p>A customer has filed a chargeback with their bank. <strong>You must respond by the deadline below</strong> or the funds will be automatically returned and a dispute fee charged.</p>
    <div class="info-box">
      <table style="width:100%;font-size:15px;">
        <tr><td style="color:#666;padding:6px 0;">Booking Reference</td><td style="text-align:right;font-family:monospace;font-weight:600;">${escHtml(orderRef)}</td></tr>
        <tr><td style="color:#666;padding:6px 0;">Customer</td><td style="text-align:right;font-weight:600;">${escHtml(customerName)}</td></tr>
        <tr><td style="color:#666;padding:6px 0;">Disputed Amount</td><td style="text-align:right;font-weight:700;color:#842029;">Â£${disputeAmount}</td></tr>
        <tr><td style="color:#666;padding:6px 0;">Dispute Reason</td><td style="text-align:right;">${escHtml(disputeReason)}</td></tr>
        <tr><td style="color:#666;padding:6px 0;font-weight:700;">Evidence Deadline</td><td style="text-align:right;font-weight:700;color:#842029;">${deadlineStr}</td></tr>
      </table>
    </div>
    <p style="text-align:center;margin:32px 0;">
      <a href="${stripeUrl}" class="cta-btn" style="display:inline-block;background:#842029;color:#fff;padding:12px 28px;border-radius:300px;text-decoration:none;font-weight:600;">
        View Dispute in Stripe â†’
      </a>
    </p>
    <p style="font-size:14px;color:#666;">Evidence to submit typically includes: the booking confirmation email, signed terms and conditions, and any correspondence with the customer.</p>
  `,
    settings,
  );

  await sendMail({
    to: recipients,
    subject: `ðŸš¨ Dispute Filed â€” ${orderRef} â€” Â£${disputeAmount} â€” Deadline: ${deadlineStr}`,
    html,
  });

  logger.info(
    { bookingId, disputeId, disputeAmount, deadlineStr, recipients },
    "Dispute alert email sent to organisers",
  );
}

export async function sendInvoiceReminder(bookingId: number): Promise<void> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) throw new Error(`Booking ${bookingId} not found`);
  if (!booking.stripeInvoicePaymentUrl && !booking.stripeInvoicePdfUrl) {
    throw new Error("No Stripe invoice found for this booking");
  }

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));
  const lead = attendees.find((a) => a.isLead) || attendees[0];
  if (!lead) throw new Error("No attendee found for booking");

  const settings = await getEventSettings();
  const to = booking.billingEmail || lead.workEmail;
  const orderRef = booking.orderReference || defaultOrderRef(bookingId);

  const dueDate = booking.invoiceDueDate ? new Date(booking.invoiceDueDate) : null;
  const now = new Date();
  const isOverdue = dueDate ? dueDate < now : false;
  const dueDateStr = dueDate
    ? dueDate.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "14 days from invoice issue";

  const passLabels: Record<string, string> = {
    single: "HR Professional Pass â€” HR Professional",
    business: "Business Pass â€” Vendor/Consultant",
  };
  const passLabel = passLabels[booking.passType] || booking.passType;
  const totalAmount = parseFloat(booking.totalAmount?.toString() || "0").toFixed(2);
  const vatAmount = parseFloat(booking.vatAmount?.toString() || "0").toFixed(2);
  const subtotalAfterDiscounts = parseFloat(booking.subtotalAmount?.toString() || "0");
  const groupDiscount = parseFloat(booking.groupDiscountAmount?.toString() || "0");
  const promoDiscount = parseFloat(booking.promoDiscountAmount?.toString() || "0");
  const baseAmount = subtotalAfterDiscounts + groupDiscount + promoDiscount;

  const recipientName = booking.billingName || `${lead.firstName} ${lead.lastName}`;

  // Load editable template (intro body + subject) from DB, falling back to defaults
  const [storedTemplate] = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.type, "invoice_reminder"));
  const payOnlineButton = booking.stripeInvoicePaymentUrl
    ? `<p style="margin:24px 0;text-align:center;"><a href="${booking.stripeInvoicePaymentUrl}" style="display:inline-block;background:#004eb9;color:#fff;padding:14px 32px;text-decoration:none;font-weight:bold;font-size:15px;border-radius:4px;">Pay Invoice Online â†’</a></p>`
    : "";

  // Body-vars are HTML-escaped (these are inserted into HTML email content),
  // except `payOnlineButton` which is a pre-built HTML fragment.
  const templateVars: Record<string, string> = {
    "{{firstName}}": escHtml(lead.firstName || recipientName),
    "{{recipientName}}": escHtml(recipientName),
    "{{orderReference}}": escHtml(orderRef),
    "{{dueDate}}": escHtml(dueDateStr),
    "{{payOnlineButton}}": payOnlineButton,
    "{{payOnlineUrl}}": booking.stripeInvoicePaymentUrl || "",
  };
  // Subject is a plain-text mail header â€” must use raw values.
  const subjectVars: Record<string, string> = {
    "{{firstName}}": lead.firstName || recipientName,
    "{{recipientName}}": recipientName,
    "{{orderReference}}": orderRef,
    "{{dueDate}}": dueDateStr,
    "{{payOnlineUrl}}": booking.stripeInvoicePaymentUrl || "",
    "{{payOnlineButton}}": "",
  };
  const templateHasPayButton = !!storedTemplate?.htmlBody.includes("{{payOnlineButton}}");

  let introHtml: string;
  if (storedTemplate) {
    introHtml = storedTemplate.htmlBody;
    for (const [key, val] of Object.entries(templateVars)) {
      introHtml = introHtml.replaceAll(key, val);
    }
  } else {
    introHtml = `<p>Dear ${escHtml(recipientName)},</p>
    <p>${
      isOverdue
        ? `We are writing to remind you that invoice <strong>${escHtml(orderRef)}</strong> for your registration to the <strong>SWP Summit 2027</strong> was due on <strong>${escHtml(dueDateStr)}</strong> and remains unpaid.`
        : `This is a friendly reminder that invoice <strong>${escHtml(orderRef)}</strong> for your registration to the <strong>SWP Summit 2027</strong> is due on <strong>${escHtml(dueDateStr)}</strong>.`
    }</p>
    <p>Please arrange payment at your earliest convenience using the details below. A copy of the invoice PDF is attached to this email for your reference.</p>`;
  }

  let rawSubject =
    storedTemplate?.subject ||
    (isOverdue
      ? `Overdue Invoice â€” {{orderReference}} â€” SWP Summit 2027`
      : `Invoice Reminder â€” {{orderReference}} â€” SWP Summit 2027`);
  for (const [key, val] of Object.entries(subjectVars)) {
    rawSubject = rawSubject.replaceAll(key, val);
  }
  const subject = isOverdue
    ? rawSubject.replace(/^Invoice Reminder/, "Overdue Invoice")
    : rawSubject;

  const html = wrapInBrandedLayout(
    `
    <div style="background:${isOverdue ? "#fff3cd" : "#e8f4fd"};border-left:4px solid ${isOverdue ? "#004eb9" : "#266cc7"};padding:16px 20px;border-radius:4px;margin-bottom:24px;">
      <strong style="color:${isOverdue ? "#004eb9" : "#266cc7"};font-size:15px;">${isOverdue ? "Invoice Overdue" : "Invoice Reminder"}</strong>
    </div>

    ${introHtml}

    <div class="info-box" style="margin-bottom:24px;">
      <strong>Order Details</strong><br><br>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#666;width:180px;border-bottom:1px solid #f0f0f0">Reference</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600;">${escHtml(orderRef)}</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Event</td><td style="border-bottom:1px solid #f0f0f0">SWP Summit 2027, Wednesday, 3 March 2027</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Venue</td><td style="border-bottom:1px solid #f0f0f0">1 Basinghall Avenue, London EC2V 5DD</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Pass Type</td><td style="border-bottom:1px solid #f0f0f0">${escHtml(passLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Quantity</td><td style="border-bottom:1px solid #f0f0f0">${booking.quantity}</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Net Amount</td><td style="border-bottom:1px solid #f0f0f0">Â£${baseAmount.toFixed(2)}</td></tr>
        ${groupDiscount > 0 ? `<tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Group Discount</td><td style="border-bottom:1px solid #f0f0f0;color:#004eb9">-Â£${groupDiscount.toFixed(2)}</td></tr>` : ""}
        ${promoDiscount > 0 ? `<tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Promo Discount</td><td style="border-bottom:1px solid #f0f0f0;color:#004eb9">-Â£${promoDiscount.toFixed(2)}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">VAT (20%)</td><td style="border-bottom:1px solid #f0f0f0">Â£${vatAmount}</td></tr>
        <tr><td style="padding:6px 0;font-weight:700;border-bottom:1px solid #f0f0f0">Total Due</td><td style="border-bottom:1px solid #f0f0f0"><strong style="font-size:16px;">Â£${totalAmount}</strong></td></tr>
        <tr><td style="padding:6px 0;color:${isOverdue ? "#004eb9" : "#888"};border-bottom:1px solid #f0f0f0">Invoice Due</td><td style="border-bottom:1px solid #f0f0f0;color:${isOverdue ? "#004eb9" : "inherit"};font-weight:${isOverdue ? "700" : "400"};">${escHtml(dueDateStr)}${isOverdue ? " â€” OVERDUE" : ""}</td></tr>
      </table>
    </div>

    ${!templateHasPayButton ? payOnlineButton : ""}

    <div class="info-box" style="margin-bottom:24px;">
      <strong>Bank Transfer Details</strong><br><br>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#666;width:180px;border-bottom:1px solid #f0f0f0">Account Name</td><td style="border-bottom:1px solid #f0f0f0">Dynamic Business Leaders Limited</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Bank</td><td style="border-bottom:1px solid #f0f0f0">Tide (ClearBank)</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Sort Code</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600;">04-06-05</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Account Number</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600;">16963209</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">IBAN (GBP)</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace;">GB65CLRB04060516963209</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">SWIFT/BIC</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace;">CLRBGB22</td></tr>
        <tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #f0f0f0">Reference</td><td style="border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:600;">${escHtml(orderRef)}</td></tr>
      </table>
    </div>

    <p style="font-size:14px;color:#666;">If you have already arranged payment, please disregard this email. For queries, please contact <a href="mailto:douglas@dynamicbusinessleaders.co.uk">douglas@dynamicbusinessleaders.co.uk</a>.</p>
    <p style="font-size:14px;color:#666;"><strong>Dynamic Business Leaders Limited</strong> Â· Company No. 12252258 Â· VAT No. 336124621</p>
  `,
    settings,
  );

  let pdfBuffer: Buffer | null = null;
  const pdfFilename = `invoice-${orderRef}.pdf`;
  if (booking.stripeInvoicePdfUrl) {
    try {
      pdfBuffer = await downloadHttpsPdf(booking.stripeInvoicePdfUrl);
      if (pdfBuffer)
        logger.info(
          { bookingId, sizeBytes: pdfBuffer.length },
          "Stripe invoice PDF attached to reminder",
        );
    } catch (err) {
      logger.warn(
        { err },
        "Could not download Stripe PDF for reminder â€” attaching custom receipt",
      );
    }
  }
  if (!pdfBuffer) {
    try {
      pdfBuffer = await generatePdfReceipt(booking, attendees);
    } catch (err) {
      logger.warn({ err }, "Could not generate PDF receipt for reminder");
    }
  }

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (pdfBuffer)
    attachments.push({ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" });
  const companyInfoPdf = getCompanyInfoPdf();
  if (companyInfoPdf)
    attachments.push({
      filename: "DBL-company-information.pdf",
      content: companyInfoPdf,
      contentType: "application/pdf",
    });

  const ok = await sendMail({ to, subject, html, attachments });
  if (!ok) {
    // sendMail swallows transport errors and returns false; surface as a thrown
    // error so callers (single-send route + bulk-remind loop) can classify the
    // failure and so we do NOT mark the timestamp as if it succeeded.
    throw new Error("Failed to send invoice reminder email");
  }
  // Record successful send so the admin dashboard can show "last reminder sent"
  // and so the unpaid-invoices widget aging info is fresh after a manual send.
  await db
    .update(bookingsTable)
    .set({ lastInvoiceReminderSentAt: new Date() })
    .where(eq(bookingsTable.id, bookingId));

  logger.info({ bookingId, to, orderRef, isOverdue }, "Invoice reminder email sent");
}

/**
 * Resolve the latest invoice/receipt PDF for a booking.
 * Prefers the Stripe-hosted invoice PDF (always reflects the most recent
 * re-issue) and falls back to our own generated receipt PDF when Stripe is
 * unavailable or the booking has no Stripe invoice (e.g. card payments).
 */
export async function resolveLatestBookingPdf(
  bookingId: number,
): Promise<{ buffer: Buffer; filename: string; source: "stripe" | "custom" } | null> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) return null;

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));

  const ref = booking.orderReference || String(bookingId);
  // Invoice bookings always get an invoice-prefixed filename even when the
  // custom PDF fallback is used; only true card-payment bookings get a
  // receipt-prefixed filename.
  const isInvoiceBooking = booking.paymentMethod === "invoice";
  let buffer: Buffer | null = null;
  let filename = isInvoiceBooking ? `invoice-${ref}.pdf` : `receipt-${ref}.pdf`;
  let source: "stripe" | "custom" = "custom";

  if (booking.stripeInvoicePdfUrl) {
    try {
      buffer = await downloadHttpsPdf(booking.stripeInvoicePdfUrl);
      if (buffer) {
        filename = `invoice-${ref}.pdf`;
        source = "stripe";
      }
    } catch (err) {
      logger.warn({ err, bookingId }, "Failed to fetch Stripe PDF â€” falling back to custom");
    }
  }
  if (!buffer) {
    try {
      buffer = await generatePdfReceipt(booking, attendees);
    } catch (err) {
      logger.error({ err, bookingId }, "Failed to generate fallback PDF receipt");
      return null;
    }
  }
  return buffer ? { buffer, filename, source } : null;
}
