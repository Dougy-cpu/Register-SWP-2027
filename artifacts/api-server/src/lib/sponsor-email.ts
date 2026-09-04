import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  attendeesTable,
  db,
  emailLogsTable,
  emailTemplatesTable,
  notificationEmailsTable,
  sponsorActivityTable,
  sponsorContactsTable,
  sponsorPromoCodesTable,
  sponsorsTable,
  promoCodesTable,
  sponsorTasksTable,
} from "@workspace/db";
import {
  buildCalendarLinksSection,
  escHtml,
  getEventSettings,
  sendMail,
  wrapInBrandedLayout,
} from "./email";
import { sponsorAccessUrl, SponsorConflictError, SponsorNotFoundError } from "./sponsor-service";
import { logger } from "./logger";

export type SponsorNotificationCategory = "admin" | "passes" | "content" | "deadlines";

function replaceVariables(template: string, variables: Record<string, string>): string {
  return template.replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (_match, key: string) => variables[key] ?? "",
  );
}

async function sponsorEmailData(sponsorId: number) {
  const [sponsor] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
  if (!sponsor) throw new SponsorNotFoundError();
  const [contacts, mappings, tasks] = await Promise.all([
    db.select().from(sponsorContactsTable).where(eq(sponsorContactsTable.sponsorId, sponsorId)),
    db
      .select({ kind: sponsorPromoCodesTable.kind, promo: promoCodesTable })
      .from(sponsorPromoCodesTable)
      .innerJoin(promoCodesTable, eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id))
      .where(eq(sponsorPromoCodesTable.sponsorId, sponsorId)),
    db.select().from(sponsorTasksTable).where(eq(sponsorTasksTable.sponsorId, sponsorId)),
  ]);
  const primary = contacts.filter((contact) => contact.isPrimary || contact.role === "primary");
  if (!primary.length) throw new SponsorConflictError("A primary contact is required");
  const vip = mappings.find((mapping) => mapping.kind === "vip")?.promo;
  const publicCode = mappings.find((mapping) => mapping.kind === "public")?.promo;
  if (!vip || !publicCode)
    throw new SponsorConflictError("Confirm the sponsor before previewing welcome email");
  const base = (process.env.APP_BASE_URL ?? "https://register.swpsummit.com").replace(/\/$/, "");
  return {
    sponsor,
    primary,
    vip,
    publicCode,
    tasks,
    vipUrl: `${base}/?pass=single&promo=${encodeURIComponent(vip.code)}`,
    publicUrl: `${base}/?pass=single&promo=${encodeURIComponent(publicCode.code)}`,
  };
}

function sponsorWelcomeDefaultBody(data: Awaited<ReturnType<typeof sponsorEmailData>>): string {
  const deadlines = data.tasks
    .filter((task) => task.required && task.dueAt)
    .map(
      (task) =>
        `<li><strong>${escHtml(task.label)}:</strong> ${escHtml(task.dueAt?.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }) ?? "")}</li>`,
    )
    .join("");
  return `
    <h2>Welcome to SWP Summit 2027</h2>
    <p>Hi ${escHtml(data.primary[0].firstName)},</p>
    <p>It is great to have <strong>${escHtml(data.sponsor.company)}</strong> joining us as a ${escHtml(data.sponsor.packageLabel)} sponsor.</p>
    <p>Your private sponsor workspace brings your passes, staff registrations, session information, assets and logistics into one place.</p>
    <p style="text-align:center;margin:28px 0"><a href="${escHtml(sponsorAccessUrl(data.sponsor))}" style="display:inline-block;background:#004eb9;color:#fff;padding:13px 26px;border-radius:6px;text-decoration:none;font-weight:700">Open your sponsor workspace</a></p>
    <div class="info-box">
      <strong>Private VIP Workforce passes</strong><br>
      Code: <strong>${escHtml(data.vip.code)}</strong><br>
      Allocation: ${data.sponsor.vipAllocation}<br>
      Maximum per booking: ${data.sponsor.vipMaxPerBooking}<br>
      <a href="${escHtml(data.vipUrl)}">Open VIP registration link</a>
    </div>
    <div class="info-box" style="margin-top:16px">
      <strong>Public Workforce discount</strong><br>
      Code: <strong>${escHtml(data.publicCode.code)}</strong><br>
      Discount: 20% after any group discount<br>
      <a href="${escHtml(data.publicUrl)}">Open public registration link</a>
    </div>
    <p>You also have <strong>${data.sponsor.staffAllocation}</strong> sponsor staff ${data.sponsor.staffAllocation === 1 ? "place" : "places"}. Please register each staff member in the workspace when their details are confirmed.</p>
    ${deadlines ? `<h3>Key deadlines</h3><ul>${deadlines}</ul>` : ""}
    <p>If you need more passes or have any questions, use the request button in the workspace and we will pick it up straight away.</p>
    <p>Best,<br><strong>The SWP Summit team</strong></p>
  `;
}

export async function buildSponsorWelcomePreview(sponsorId: number) {
  const data = await sponsorEmailData(sponsorId);
  const settings = await getEventSettings();
  const [template] = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.type, "sponsor_welcome"));
  const variables = {
    firstName: escHtml(data.primary[0].firstName),
    company: escHtml(data.sponsor.company),
    packageLabel: escHtml(data.sponsor.packageLabel),
    workspaceUrl: escHtml(sponsorAccessUrl(data.sponsor)),
    vipCode: escHtml(data.vip.code),
    vipUrl: escHtml(data.vipUrl),
    vipAllocation: String(data.sponsor.vipAllocation),
    vipMaxPerBooking: String(data.sponsor.vipMaxPerBooking),
    publicCode: escHtml(data.publicCode.code),
    publicUrl: escHtml(data.publicUrl),
    staffAllocation: String(data.sponsor.staffAllocation),
    eventName: escHtml(settings.eventName),
  };
  const subject = replaceVariables(
    template?.subject ?? "Welcome to SWP Summit 2027 - {{company}} sponsor workspace",
    variables,
  );
  const body = template?.htmlBody
    ? replaceVariables(template.htmlBody, variables)
    : sponsorWelcomeDefaultBody(data);
  const html = wrapInBrandedLayout(body, settings);
  const to = [...new Set(data.primary.map((contact) => contact.email.trim().toLowerCase()))];
  const previewHash = createHash("sha256")
    .update(JSON.stringify({ to, subject, html }))
    .digest("hex");
  return { to, subject, html, previewHash };
}

export async function sendReviewedSponsorWelcome(
  sponsorId: number,
  expectedPreviewHash: string,
): Promise<boolean> {
  const preview = await buildSponsorWelcomePreview(sponsorId);
  if (preview.previewHash !== expectedPreviewHash) {
    throw new SponsorConflictError(
      "Sponsor details changed after the preview. Review the refreshed email before sending.",
    );
  }
  const sent = await sendMail({ to: preview.to, subject: preview.subject, html: preview.html });
  await db.transaction(async (tx) => {
    await tx.insert(emailLogsTable).values(
      preview.to.map((recipient) => ({
        sponsorId,
        recipient,
        type: "sponsor_welcome" as const,
        status: sent ? ("sent" as const) : ("failed" as const),
        errorMessage: sent ? null : "SMTP not configured or delivery failed",
      })),
    );
    if (sent) {
      await tx
        .update(sponsorsTable)
        .set({ welcomeEmailSentAt: new Date(), updatedAt: new Date() })
        .where(eq(sponsorsTable.id, sponsorId));
    }
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: sent ? "welcome_sent" : "welcome_failed",
      actorType: "admin",
      data: { recipients: preview.to },
    });
  });
  return sent;
}

export async function sendSponsorStaffWelcome(
  sponsorId: number,
  bookingId: number,
  attendeeId: number,
): Promise<boolean> {
  const [sponsor] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
  const [attendee] = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.id, attendeeId));
  if (!sponsor || !attendee) return false;
  const settings = await getEventSettings();
  const [template] = await db
    .select()
    .from(emailTemplatesTable)
    .where(eq(emailTemplatesTable.type, "sponsor_staff"));
  const variables = {
    firstName: escHtml(attendee.firstName),
    company: escHtml(sponsor.company),
    eventName: escHtml(settings.eventName),
    eventDate: escHtml(settings.eventDate),
    eventVenue: escHtml(settings.eventVenue),
  };
  const subject = replaceVariables(
    template?.subject ?? "Your SWP Summit 2027 sponsor staff registration is confirmed",
    variables,
  );
  const defaultBody = `
    <h2>Your place is confirmed</h2>
    <p>Hi ${variables.firstName},</p>
    <p>You have been registered as part of the <strong>${variables.company}</strong> sponsor team for <strong>${variables.eventName}</strong>.</p>
    <div class="info-box"><strong>Date:</strong> ${variables.eventDate}<br><strong>Venue:</strong> ${variables.eventVenue}</div>
    ${buildCalendarLinksSection(settings)}
    <p>There is nothing to pay and no invoice or receipt is needed. If any of your details change, your sponsor contact can update them in the sponsor workspace.</p>
    <div class="info-box"><strong>Badge scanning and sponsor leads</strong><br>At the event, sponsors may scan the QR on your badge to save your name, job title, company and work email as a lead. The QR itself contains only an attendee reference. Scanning is optional. Contact the SWP Summit team if you want your badge excluded from sponsor scanning.</div>
    <p>We look forward to seeing you there.</p>
    <p>Best,<br><strong>The SWP Summit team</strong></p>
  `;
  const body = template?.htmlBody ? replaceVariables(template.htmlBody, variables) : defaultBody;
  const leadSharingNotice = body.includes("Badge scanning and sponsor leads")
    ? ""
    : `<div class="info-box"><strong>Badge scanning and sponsor leads</strong><br>At the event, sponsors may scan the QR on your badge to save your name, job title, company and work email as a lead. The QR itself contains only an attendee reference. Scanning is optional. Contact the SWP Summit team if you want your badge excluded from sponsor scanning.</div>`;
  const html = wrapInBrandedLayout(`${body}${leadSharingNotice}`, settings);
  const sent = await sendMail({ to: attendee.workEmail, subject, html });
  if (sent) {
    await db
      .update(attendeesTable)
      .set({ leadSharingNoticeAt: new Date(), updatedAt: new Date() })
      .where(eq(attendeesTable.id, attendeeId));
  }
  await db.insert(emailLogsTable).values({
    sponsorId,
    bookingId,
    recipient: attendee.workEmail,
    type: "sponsor_staff",
    status: sent ? "sent" : "failed",
    errorMessage: sent ? null : "SMTP not configured or delivery failed",
  });
  return sent;
}

function categoryFlag(category: SponsorNotificationCategory) {
  switch (category) {
    case "passes":
      return notificationEmailsTable.notifySponsorPasses;
    case "content":
      return notificationEmailsTable.notifySponsorContent;
    case "deadlines":
      return notificationEmailsTable.notifySponsorDeadlines;
    default:
      return notificationEmailsTable.notifySponsorAdmin;
  }
}

export async function sendSponsorInternalNotification(input: {
  sponsorId: number;
  category: SponsorNotificationCategory;
  event: string;
  summary: string;
  detailHtml?: string;
}): Promise<boolean> {
  const [sponsor] = await db
    .select()
    .from(sponsorsTable)
    .where(eq(sponsorsTable.id, input.sponsorId));
  if (!sponsor) return false;
  const flag = categoryFlag(input.category);
  const configured = await db
    .select({ email: notificationEmailsTable.email })
    .from(notificationEmailsTable)
    .where(eq(flag, true));
  const recipients = [
    ...new Set(configured.map((item) => item.email.trim().toLowerCase()).filter(Boolean)),
  ];
  if (!recipients.length) {
    logger.info(
      { sponsorId: input.sponsorId, category: input.category },
      "No sponsor notification recipients configured",
    );
    return true;
  }
  const settings = await getEventSettings();
  const subject = `[Sponsor] ${sponsor.company}: ${input.event}`;
  const html = wrapInBrandedLayout(
    `<h2>${escHtml(input.event)}</h2><p><strong>${escHtml(sponsor.company)}</strong> (${escHtml(sponsor.packageLabel)})</p><p>${escHtml(input.summary)}</p>${input.detailHtml ?? ""}`,
    settings,
  );
  let allSent = true;
  for (const recipient of recipients) {
    const sent = await sendMail({ to: recipient, subject, html });
    if (!sent) allSent = false;
    await db.insert(emailLogsTable).values({
      sponsorId: input.sponsorId,
      recipient,
      type: "sponsor_internal",
      status: sent ? "sent" : "failed",
      errorMessage: sent ? null : "SMTP not configured or delivery failed",
    });
  }
  return allSent;
}
