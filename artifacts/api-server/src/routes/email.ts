import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { emailTemplatesTable, emailLogsTable, eventSettingsTable } from "@workspace/db";
import { getEventSettings, DEFAULT_INVOICE_HELP_CONTENT } from "../lib/email";
import { DEFAULT_REF_PREFIX, DEFAULT_REF_OFFSET } from "../lib/order-reference";
import { adminAuth } from "../middleware/admin-auth";
import { logAdminAction } from "../lib/audit";

const router: IRouter = Router();

function formatTemplate(t: typeof emailTemplatesTable.$inferSelect) {
  return {
    ...t,
    updatedAt: t.updatedAt.toISOString(),
  };
}

function formatLog(l: typeof emailLogsTable.$inferSelect) {
  return {
    ...l,
    sentAt: l.sentAt.toISOString(),
  };
}

// ─── Event Settings ───────────────────────────────────────────────────────────

router.get("/admin/event-settings", adminAuth, async (_req, res): Promise<void> => {
  const settings = await getEventSettings();
  res.json({
    ...settings,
    updatedAt: settings.updatedAt.toISOString(),
  });
});

// Public, unauthenticated subset of event-settings - only the fields needed
// by the public checkout (currently the "How invoicing works" help block).
// Falls back to the built-in default copy when admins haven't customised it.
router.get("/event-settings/public", async (_req, res): Promise<void> => {
  const settings = await getEventSettings();
  res.json({
    invoiceHelpContent: settings.invoiceHelpContent || DEFAULT_INVOICE_HELP_CONTENT,
  });
});

router.put("/admin/event-settings", adminAuth, async (req, res): Promise<void> => {
  const {
    eventName,
    eventDate,
    eventVenue,
    eventVenuePostcode,
    orgName,
    orgAddress,
    orgWebsite,
    logoDataUrl,
    fromName,
    fromEmail,
    attendeeChangesLocked,
    attendeeChangesLockedMessage,
    refPrefix,
    refOffset,
    notifyCompleteSubject,
    notifyIncompleteSubject,
    notifyAttendeeSubject,
    eventStartAt,
    eventEndAt,
    eventTimezone,
    eventDescription,
    socialEnabled,
    socialName,
    socialStartAt,
    socialEndAt,
    socialVenue,
    socialDescription,
    invoiceHelpContent,
  } = req.body;

  function parseTs(v: unknown): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  }

  // Validate timezone identifier (IANA) if supplied.
  if (
    eventTimezone !== undefined &&
    eventTimezone !== null &&
    String(eventTimezone).trim() !== ""
  ) {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: String(eventTimezone).trim() }).format(
        new Date(),
      );
    } catch {
      res.status(400).json({ error: `Invalid timezone identifier: ${eventTimezone}` });
      return;
    }
  }

  const existing = await db.select().from(eventSettingsTable);

  // Validate start < end for event and social once we know the merged values.
  const current = existing[0];
  const mergedEventStart =
    eventStartAt !== undefined ? parseTs(eventStartAt) : (current?.eventStartAt ?? null);
  const mergedEventEnd =
    eventEndAt !== undefined ? parseTs(eventEndAt) : (current?.eventEndAt ?? null);
  if (
    mergedEventStart &&
    mergedEventEnd &&
    mergedEventEnd.getTime() <= mergedEventStart.getTime()
  ) {
    res.status(400).json({ error: "eventEndAt must be after eventStartAt" });
    return;
  }
  const mergedSocialStart =
    socialStartAt !== undefined ? parseTs(socialStartAt) : (current?.socialStartAt ?? null);
  const mergedSocialEnd =
    socialEndAt !== undefined ? parseTs(socialEndAt) : (current?.socialEndAt ?? null);
  if (
    mergedSocialStart &&
    mergedSocialEnd &&
    mergedSocialEnd.getTime() <= mergedSocialStart.getTime()
  ) {
    res.status(400).json({ error: "socialEndAt must be after socialStartAt" });
    return;
  }

  let updated;
  if (existing.length > 0) {
    [updated] = await db
      .update(eventSettingsTable)
      .set({
        ...(eventName !== undefined && { eventName }),
        ...(eventDate !== undefined && { eventDate }),
        ...(eventVenue !== undefined && { eventVenue }),
        ...(eventVenuePostcode !== undefined && { eventVenuePostcode }),
        ...(orgName !== undefined && { orgName }),
        ...(orgAddress !== undefined && { orgAddress }),
        ...(orgWebsite !== undefined && { orgWebsite }),
        ...(logoDataUrl !== undefined && { logoDataUrl }),
        ...(fromName !== undefined && { fromName }),
        ...(fromEmail !== undefined && { fromEmail }),
        ...(attendeeChangesLocked !== undefined && {
          attendeeChangesLocked: attendeeChangesLocked === true,
        }),
        ...(attendeeChangesLockedMessage !== undefined && {
          attendeeChangesLockedMessage: attendeeChangesLockedMessage || null,
        }),
        ...(refPrefix !== undefined && {
          refPrefix: String(refPrefix).trim() || DEFAULT_REF_PREFIX,
        }),
        ...(refOffset !== undefined && {
          refOffset: parseInt(String(refOffset), 10) || DEFAULT_REF_OFFSET,
        }),
        ...(notifyCompleteSubject !== undefined && {
          notifyCompleteSubject: notifyCompleteSubject || null,
        }),
        ...(notifyIncompleteSubject !== undefined && {
          notifyIncompleteSubject: notifyIncompleteSubject || null,
        }),
        ...(notifyAttendeeSubject !== undefined && {
          notifyAttendeeSubject: notifyAttendeeSubject || null,
        }),
        ...(eventStartAt !== undefined && { eventStartAt: parseTs(eventStartAt) }),
        ...(eventEndAt !== undefined && { eventEndAt: parseTs(eventEndAt) }),
        ...(eventTimezone !== undefined && {
          eventTimezone: String(eventTimezone).trim() || "Europe/London",
        }),
        ...(eventDescription !== undefined && { eventDescription: eventDescription || null }),
        ...(socialEnabled !== undefined && { socialEnabled: socialEnabled === true }),
        ...(socialName !== undefined && { socialName: socialName || null }),
        ...(socialStartAt !== undefined && { socialStartAt: parseTs(socialStartAt) }),
        ...(socialEndAt !== undefined && { socialEndAt: parseTs(socialEndAt) }),
        ...(socialVenue !== undefined && { socialVenue: socialVenue || null }),
        ...(socialDescription !== undefined && { socialDescription: socialDescription || null }),
        ...(invoiceHelpContent !== undefined && {
          invoiceHelpContent: invoiceHelpContent || null,
        }),
      })
      .where(eq(eventSettingsTable.id, existing[0].id))
      .returning();
  } else {
    [updated] = await db
      .insert(eventSettingsTable)
      .values({
        eventName: eventName || "SWP Summit",
        eventDate: eventDate || "Wednesday, 3 March 2027",
        eventVenue: eventVenue || "1 Basinghall Avenue, London",
        eventVenuePostcode: eventVenuePostcode || "EC2V 5DD",
        orgName: orgName || "People Strategy Hub Ltd",
        orgAddress: orgAddress || "London, UK",
        orgWebsite: orgWebsite || "https://swpsummit.com",
        logoDataUrl: logoDataUrl || null,
        fromName: fromName || "SWP Summit",
        fromEmail: fromEmail || "douglas@peoplestrategyhub.com",
        attendeeChangesLocked: attendeeChangesLocked === true,
        attendeeChangesLockedMessage: attendeeChangesLockedMessage || null,
        eventStartAt: parseTs(eventStartAt) ?? null,
        eventEndAt: parseTs(eventEndAt) ?? null,
        eventTimezone:
          (typeof eventTimezone === "string" && eventTimezone.trim()) || "Europe/London",
        eventDescription: eventDescription || null,
        socialEnabled: socialEnabled === true,
        socialName: socialName || null,
        socialStartAt: parseTs(socialStartAt) ?? null,
        socialEndAt: parseTs(socialEndAt) ?? null,
        socialVenue: socialVenue || null,
        socialDescription: socialDescription || null,
        invoiceHelpContent: invoiceHelpContent || null,
      })
      .returning();
  }

  await logAdminAction({
    type: "admin_event_settings_updated",
    summary: "Updated event settings",
    meta: {
      changedFields: Object.keys(req.body || {}).filter(
        (k) => (req.body as Record<string, unknown>)[k] !== undefined,
      ),
    },
  });

  res.json({
    ...updated,
    updatedAt: updated.updatedAt.toISOString(),
  });
});

// ─── Generic Template Routes ──────────────────────────────────────────────────

// Read-only template fetch. Locked behind admin auth and made side-effect
// free: previously this endpoint would silently INSERT a default template
// row on first read, which let any unauth caller seed DB rows simply by
// hitting the endpoint with a valid `type`. Now we either return the
// persisted row or, if absent, the in-memory default - the row is only
// created when an admin explicitly saves via PUT.
const TEMPLATE_DEFAULTS: Record<string, { subject: string; htmlBody: string }> = {
  welcome: {
    subject: "Welcome to SWP Summit 2027!",
    htmlBody:
      "<h2>Welcome, {{firstName}}!</h2><p>We're thrilled to have you join us at the SWP Summit 2027. Your booking is confirmed and we can't wait to see you there.</p><p>If you have any questions in the meantime, don't hesitate to reach out.</p><p>See you on 3 March!</p>",
  },
  confirmation: {
    subject: "Booking Confirmed - SWP Summit 2027",
    htmlBody:
      "<h2>Booking Confirmed, {{firstName}}!</h2><p>Thank you for registering. Your order reference is <strong>{{orderReference}}</strong>.</p><p>You have booked <strong>{{quantity}}</strong> {{passType}} pass(es). A full VAT receipt is attached to this email.</p>{{invoiceConfirmation}}{{promoSummary}}{{emailDeliveryReminder}}<p>We look forward to seeing you at the SWP Summit!</p>",
  },
  invoice_reminder: {
    subject: "Invoice Reminder - {{orderReference}} - SWP Summit 2027",
    htmlBody:
      '<p>Dear {{recipientName}},</p><p>This is a friendly reminder that invoice <strong>{{orderReference}}</strong> for your registration to the <strong>SWP Summit 2027</strong> is due on <strong>{{dueDate}}</strong>.</p><p>Please arrange payment at your earliest convenience using the bank transfer details below. A copy of the invoice PDF is attached for your reference.</p>{{payOnlineButton}}<p>If you have already arranged payment, please disregard this email. For any queries, please contact <a href="mailto:douglas@dynamicbusinessleaders.co.uk">douglas@dynamicbusinessleaders.co.uk</a>.</p>',
  },
};

router.get("/email-templates/:type", adminAuth, async (req, res): Promise<void> => {
  const type = req.params.type as "welcome" | "confirmation" | "invoice_reminder";
  if (!["welcome", "confirmation", "invoice_reminder"].includes(type)) {
    res.status(400).json({ error: "Invalid template type" });
    return;
  }

  const [template] = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.type, type));

  if (template) {
    res.json(formatTemplate(template));
    return;
  }

  const def = TEMPLATE_DEFAULTS[type];
  if (!def) {
    res.status(404).json({ error: `${type} email template not found` });
    return;
  }
  // Synthetic record using in-memory defaults - not persisted. The admin UI
  // edits this and saves via PUT, which performs the actual insert.
  res.json({
    id: null,
    type,
    subject: def.subject,
    htmlBody: def.htmlBody,
    updatedAt: new Date().toISOString(),
    isDefault: true,
  });
});

router.put("/email-templates/:type", adminAuth, async (req, res): Promise<void> => {
  const type = req.params.type as "welcome" | "confirmation" | "invoice_reminder";
  if (!["welcome", "confirmation", "invoice_reminder"].includes(type)) {
    res.status(400).json({ error: "Invalid template type" });
    return;
  }

  const { subject, htmlBody } = req.body;

  if (!subject || !htmlBody) {
    res.status(400).json({ error: "subject and htmlBody are required" });
    return;
  }

  const existing = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.type, type));

  let updated;
  if (existing.length > 0) {
    [updated] = await db
      .update(emailTemplatesTable)
      .set({ subject, htmlBody })
      .where(eq(emailTemplatesTable.type, type))
      .returning();
  } else {
    [updated] = await db
      .insert(emailTemplatesTable)
      .values({ type, subject, htmlBody })
      .returning();
  }

  await logAdminAction({
    type: "admin_email_template_updated",
    summary: `Updated ${type} email template`,
    before: existing[0]
      ? { subject: existing[0].subject, htmlLength: existing[0].htmlBody.length }
      : undefined,
    after: { subject, htmlLength: String(htmlBody).length },
    meta: { templateType: type },
  });

  res.json(formatTemplate(updated));
});

// Build a sample placeholder map for previews / test sends so admins see
// exactly what recipients would. Shared by /preview and /test-send so the
// two stay in lockstep.
async function buildSampleVars(
  type: "welcome" | "confirmation" | "invoice_reminder",
  toName: string | undefined,
  toEmail: string,
): Promise<{ vars: Record<string, string>; subjectVars: Record<string, string> }> {
  const settings = await getEventSettings();
  const { getCalendarPlaceholders } = await import("../lib/email");

  const sampleAttendeeRows = `
      <tr>
        <td style="padding:8px 4px;border-bottom:1px solid #eee;">Lead</td>
        <td style="padding:8px 4px;border-bottom:1px solid #eee;">${toName || "Test User"}</td>
        <td style="padding:8px 4px;border-bottom:1px solid #eee;">Head of People Analytics</td>
        <td style="padding:8px 4px;border-bottom:1px solid #eee;">Acme Corp Ltd</td>
        <td style="padding:8px 4px;border-bottom:1px solid #eee;">${toEmail}</td>
        <td style="padding:8px 4px;border-bottom:1px solid #eee;">-</td>
      </tr>`;

  const sampleAttendeesTable = `<table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:8px 4px;text-align:left;">Lead</th>
        <th style="padding:8px 4px;text-align:left;">Name</th>
        <th style="padding:8px 4px;text-align:left;">Job Title</th>
        <th style="padding:8px 4px;text-align:left;">Company</th>
        <th style="padding:8px 4px;text-align:left;">Email</th>
        <th style="padding:8px 4px;text-align:left;">Phone</th>
      </tr></thead>
      <tbody>${sampleAttendeeRows}</tbody>
    </table>`;

  const samplePriceSummary = `
      <div class="price-row"><span>Subtotal (excl. VAT)</span><span>£249.00</span></div>
      <div class="price-row"><span>VAT (20%)</span><span>£49.80</span></div>
      <div class="price-total"><span>Total</span><span>£298.80</span></div>`;

  const sampleManagementLink = `<div style="background:#f0f6ff;border:2px solid #004eb9;border-radius:6px;padding:20px;margin:24px 0;">
      <p style="margin:0 0 12px;font-weight:700;color:#004eb9;font-size:15px;">Your Attendee Management Link</p>
      <ul style="margin:0 0 12px;padding-left:20px;color:#444;line-height:1.8;">
        <li>Fill in or update any attendee details</li>
        <li>No login required - just use the secure link</li>
      </ul>
      <p style="margin:0 0 12px;text-align:center;"><a href="#" style="display:inline-block;background:#004eb9;color:#fff;padding:12px 28px;text-decoration:none;font-weight:bold;font-size:15px;border-radius:4px;">[SAMPLE LINK - not active in preview]</a></p>
    </div>`;

  const vars: Record<string, string> =
    type === "invoice_reminder"
      ? {
          "{{firstName}}": toName?.split(" ")[0] || "Test",
          "{{recipientName}}": toName || "Test User",
          "{{orderReference}}": "SWP27-TEST-001",
          "{{dueDate}}": "30 April 2027",
          "{{payOnlineButton}}": `<p style="margin:24px 0;text-align:center;"><a href="#" style="display:inline-block;background:#004eb9;color:#fff;padding:14px 32px;text-decoration:none;font-weight:bold;font-size:15px;border-radius:4px;">Pay invoice online</a></p>`,
          "{{payOnlineUrl}}": "#",
        }
      : {
          "{{firstName}}": toName?.split(" ")[0] || toName || "Test",
          "{{name}}": toName || "Test User",
          "{{orderReference}}": "SWP27-TEST-001",
          "{{passLabel}}": "Workforce Pass",
          "{{passType}}": "Workforce Pass",
          "{{quantity}}": "1",
          "{{quantityLabel}}": "pass",
          "{{attendeesTable}}": sampleAttendeesTable,
          "{{priceSummary}}": samplePriceSummary,
          "{{eventDate}}": settings.eventDate || "Wednesday, 3 March 2027",
          "{{eventVenue}}": settings.eventVenue || "1 Basinghall Avenue, London",
          "{{eventVenuePostcode}}": settings.eventVenuePostcode || "EC2V 5DD",
          "{{managementLink}}": sampleManagementLink,
          "{{invoicePaymentButton}}": "",
          "{{invoiceConfirmation}}": `<div style="margin:20px 0;padding:16px 20px;background:#f0f6ff;border:1px solid #e2e8f0;border-radius:6px;">
      <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#000000;">Invoice issued</p>
      <p style="margin:0 0 10px;font-size:14px;color:#444;line-height:1.6;">Your registration is confirmed and the invoice has been emailed to <strong>${toEmail}</strong>.</p>
      <p style="margin:0 0 10px;font-size:14px;color:#444;line-height:1.6;">The invoice email includes supplier details, bank information, payment instructions and a secure Stripe payment link. Your finance team can settle the invoice by bank transfer or through Stripe.</p>
      <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">You can add or update a PO number before payment using the secure billing link. We will re-issue the invoice automatically after billing or PO updates.</p>
    </div>`,
          "{{poNumber}}": "PO-2027-001",
          "{{poNumberSection}}": `<br><strong>PO Number:</strong> <span style="font-family:monospace;">PO-2027-001</span>`,
          "{{billingEditLink}}": `<p style="margin:14px 0 0;font-size:14px;"><a href="#" style="color:#004eb9;font-weight:600;text-decoration:underline;">Add PO number or update billing</a></p>`,
          "{{billingEditUrl}}": "#",
          "{{invoiceHelp}}": "",
          "{{emailDeliveryReminder}}": `<p style="font-size:13px;color:#666;line-height:1.5;">If the email does not arrive within a few minutes, please check your junk or spam folder.</p>`,
          "{{total}}": "£238.80",
          "{{promoCode}}": "SAVE20",
          "{{promoDiscount}}": "£20.00",
          "{{promoSummary}}": `<div style="margin:18px 0;padding:14px 18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;">
      <p style="margin:0;font-size:14px;font-weight:600;color:#166534;">Promo code applied: <span style="font-family:monospace;">SAVE20</span></p>
      <p style="margin:6px 0 0;font-size:13px;color:#166534;">You saved <strong>£20.00</strong> on this booking.</p>
    </div>`,
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

  const subjectVars: Record<string, string> = {
    "{{orderReference}}": "SWP27-TEST-001",
    "{{recipientName}}": toName || "Test User",
    "{{firstName}}": toName?.split(" ")[0] || "Test",
  };

  return { vars, subjectVars };
}

router.post("/email-templates/:type/test-send", adminAuth, async (req, res): Promise<void> => {
  const type = req.params.type as "welcome" | "confirmation" | "invoice_reminder";
  const { toEmail, toName } = req.body;

  if (!toEmail) {
    res.status(400).json({ error: "toEmail is required" });
    return;
  }

  // All template types go through the same render path so test-sends and the
  // live preview stay in lockstep - admins see exactly what recipients will.
  const [template] = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.type, type));

  if (!template) {
    res.status(404).json({ error: `No ${type} template found` });
    return;
  }

  const settings = await getEventSettings();
  const { sendMail, wrapInBrandedLayout: wrap } = await import("../lib/email");
  const { vars, subjectVars } = await buildSampleVars(type, toName, toEmail);

  let personalised = template.htmlBody;
  for (const [key, val] of Object.entries(vars)) {
    personalised = personalised.replaceAll(key, val);
  }

  let subject = template.subject;
  for (const [key, val] of Object.entries(subjectVars)) {
    subject = subject.replaceAll(key, val);
  }

  const html = wrap(personalised, settings);
  await sendMail({
    to: toEmail,
    subject: `[TEST] ${subject}`,
    html,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
  });

  await logAdminAction({
    type: "admin_email_template_test_sent",
    summary: `Sent test ${type} email to ${toEmail}`,
    meta: { templateType: type, toEmail },
  });

  res.json({ success: true, message: `Test email sent to ${toEmail}` });
});

// Live preview - renders the supplied draft HTML/subject through the same
// branded layout + sample-variable substitution that test-sends use, so the
// admin sees exactly what recipients will see.
router.post("/email-templates/:type/preview", adminAuth, async (req, res): Promise<void> => {
  const type = req.params.type as "welcome" | "confirmation" | "invoice_reminder";
  if (!["welcome", "confirmation", "invoice_reminder"].includes(type)) {
    res.status(400).json({ error: "Invalid template type" });
    return;
  }

  const { subject = "", htmlBody = "", toName } = req.body || {};

  const settings = await getEventSettings();
  const { wrapInBrandedLayout: wrap } = await import("../lib/email");
  const { vars, subjectVars } = await buildSampleVars(type, toName, "preview@example.com");

  // For welcome previews, also substitute the welcome-specific manage link
  // sample so the section is visible to admins.
  if (type === "welcome") {
    vars["{{managementLink}}"] =
      vars["{{managementLink}}"] ||
      `<div style="background:#f0f6ff;border:2px solid #004eb9;border-radius:6px;padding:20px;margin:24px 0;"><p style="margin:0;text-align:center;color:#004eb9;font-weight:700;">[SAMPLE - Manage attendees button appears here in real emails]</p></div>`;
  }

  let personalised = String(htmlBody);
  for (const [key, val] of Object.entries(vars)) {
    personalised = personalised.replaceAll(key, val);
  }

  let renderedSubject = String(subject);
  for (const [key, val] of Object.entries(subjectVars)) {
    renderedSubject = renderedSubject.replaceAll(key, val);
  }

  const html = wrap(personalised, settings);
  res.json({ subject: renderedSubject, html });
});

// ─── Email Logs ───────────────────────────────────────────────────────────────

router.get("/admin/email-logs", adminAuth, async (req, res): Promise<void> => {
  const page = parseInt((req.query.page as string) || "1", 10);
  const limit = parseInt((req.query.limit as string) || "50", 10);
  const offset = (page - 1) * limit;

  const allLogs = await db
    .select()
    .from(emailLogsTable)
    .orderBy(desc(emailLogsTable.sentAt))
    .limit(limit)
    .offset(offset);

  const total = await db.select().from(emailLogsTable);

  res.json({
    logs: allLogs.map(formatLog),
    total: total.length,
    page,
    limit,
  });
});

router.post("/admin/email-logs/:bookingId/resend", adminAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.bookingId) ? req.params.bookingId[0] : req.params.bookingId;
  const bookingId = parseInt(raw, 10);

  const { resendConfirmationAndReceipt } = await import("../lib/email");
  await resendConfirmationAndReceipt(bookingId);

  await logAdminAction({
    type: "admin_email_resent",
    bookingId,
    summary: `Resent confirmation + receipt for booking #${bookingId}`,
  });

  res.json({ success: true, message: "Confirmation and PDF receipt resent successfully" });
});

router.post(
  "/admin/bookings/:bookingId/send-invoice-reminder",
  adminAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.bookingId)
      ? req.params.bookingId[0]
      : req.params.bookingId;
    const bookingId = parseInt(raw, 10);
    if (isNaN(bookingId)) {
      res.status(400).json({ error: "Invalid booking ID" });
      return;
    }
    try {
      const { sendInvoiceReminder } = await import("../lib/email");
      await sendInvoiceReminder(bookingId);
      await logAdminAction({
        type: "admin_invoice_reminder_sent",
        bookingId,
        summary: `Sent invoice reminder for booking #${bookingId}`,
      });
      res.json({ success: true, message: "Invoice reminder sent successfully" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send invoice reminder";
      res.status(500).json({ error: message });
    }
  },
);

// Debug: download the receipt PDF directly for a booking (to verify it's valid)
router.get(
  "/admin/email-logs/:bookingId/receipt-pdf",
  adminAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.bookingId)
      ? req.params.bookingId[0]
      : req.params.bookingId;
    const bookingId = parseInt(raw, 10);

    try {
      const { db } = await import("@workspace/db");
      const { bookingsTable, attendeesTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const { generatePdfReceipt } = await import("../lib/pdf");

      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, bookingId));
      if (!booking) {
        res.status(404).json({ error: "Booking not found" });
        return;
      }

      const attendees = await db
        .select()
        .from(attendeesTable)
        .where(eq(attendeesTable.bookingId, bookingId));
      const pdfBuffer = await generatePdfReceipt(booking, attendees);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="receipt-${booking.orderReference || bookingId}.pdf"`,
      );
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

export default router;
