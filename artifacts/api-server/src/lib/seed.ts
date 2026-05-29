import { db } from "@workspace/db";
import {
  emailTemplatesTable,
  discountTiersTable,
  passConfigTable,
  eventSettingsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export async function runMigrations() {
  try {
    await db.execute(sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hear_about_us TEXT`);
    logger.info("Migration: hear_about_us column ensured");
  } catch (err) {
    logger.warn({ err }, "Migration: could not ensure hear_about_us column");
  }
}

const DEFAULT_CONFIRMATION_SUBJECT = "Booking Confirmed — {{orderReference}} — SWP Summit 2027";

const DEFAULT_CONFIRMATION_BODY = `
<h2>Booking Confirmed!</h2>
<p>Dear {{firstName}},</p>
<p>Thank you for registering for the <strong>SWP Summit 2027</strong>. Your booking is confirmed.</p>

<div class="info-box">
  <strong>Order Reference:</strong> {{orderReference}}<br>
  <strong>Pass Type:</strong> {{passLabel}}<br>
  <strong>Quantity:</strong> {{quantity}} {{quantityLabel}}
  {{poNumberSection}}
</div>

<h3>Registered Attendees</h3>
{{attendeesTable}}

<h3>Price Summary</h3>
{{priceSummary}}

<div class="info-box" style="margin-top: 24px;">
  <strong>Event Details</strong><br>
  <strong>Date:</strong> {{eventDate}}<br>
  <strong>Venue:</strong> {{eventVenue}}, {{eventVenuePostcode}}
</div>

{{eventCalendarLinks}}
{{socialCalendarLinks}}

<h3 style="margin-top: 28px; margin-bottom: 12px; color: #000;">Update Attendee Details Anytime</h3>
<p style="margin: 0 0 16px; color: #444; line-height: 1.6;">You have a secure self-service link to manage all your attendee information. You can fill in placeholder seats, update existing details, add dietary requirements — all without logging in. Need to share registration with colleagues? Forward them the link to enter their own details.</p>

{{managementLink}}

<p>A PDF VAT receipt is attached to this email for your records.</p>
{{invoicePaymentButton}}
<p>We look forward to seeing you at the SWP Summit!</p>
`;

const DEFAULT_WELCOME_SUBJECT = "Welcome to SWP Summit 2027 — We Can't Wait to See You!";

const DEFAULT_WELCOME_BODY = `
<h2>Welcome, {{firstName}}!</h2>

<p>We're absolutely thrilled to have you joining us at the <strong>SWP Summit 2027</strong> — the UK's leading event for HR leaders, people analytics practitioners, and business innovators who are shaping the future of work.</p>

<p>Here's what to look forward to on <strong>Wednesday, 3 March 2027</strong> at <strong>1 Basinghall Avenue, London</strong>:</p>

<ul>
  <li><strong>Inspiring keynotes</strong> from world-class HR and analytics leaders</li>
  <li><strong>Practical breakout sessions</strong> covering the latest in people data, AI in HR, and workforce planning</li>
  <li><strong>Networking opportunities</strong> throughout the day — meet your peers, discover new solutions</li>
  <li><strong>Happy Hour with entertainment</strong> to close out the day</li>
  <li><strong>Award-winning food & drink</strong> served throughout</li>
</ul>

<div class="info-box">
  <strong>Event Details</strong><br>
  <strong>Date:</strong> Wednesday, 3 March 2027<br>
  <strong>Venue:</strong> 1 Basinghall Avenue, London EC2V 5DD<br>
  <strong>Registration:</strong> From 8:30am<br>
  <strong>Event Opens:</strong> 9:00am
</div>

<p>Your conference pass and receipt are included in the accompanying email. Please bring a digital or printed copy for check-in.</p>

{{eventCalendarLinks}}
{{socialCalendarLinks}}

{{managementLink}}

<p>If you have any questions before the event, please don't hesitate to reach out to us at <a href="mailto:douglas@peoplestrategyhub.com">douglas@peoplestrategyhub.com</a>.</p>

<p>We look forward to seeing you there!</p>

<p>Warm regards,<br>
<strong>The SWP Summit Team</strong></p>
`;

const DEFAULT_DISCOUNT_TIERS = [
  { passType: "single" as const, minQuantity: 4, discountPercent: "10", label: "4+ passes" },
  { passType: "single" as const, minQuantity: 8, discountPercent: "15", label: "8+ passes" },
  { passType: "single" as const, minQuantity: 12, discountPercent: "20", label: "12+ passes" },
  {
    passType: "business" as const,
    minQuantity: 2,
    discountPercent: "10",
    label: "2+ Business Passes",
  },
  {
    passType: "business" as const,
    minQuantity: 5,
    discountPercent: "15",
    label: "5+ Business Passes",
  },
];

function rebrandLegacyText(value: string): string {
  return value
    .replaceAll("HR Analytics Summit 2026", "SWP Summit 2027")
    .replaceAll("HR Analytics Summit", "SWP Summit")
    .replaceAll("hranalyticssummit.com", "swpsummit.com")
    .replaceAll("noreply@swpsummit.com", "douglas@peoplestrategyhub.com")
    .replaceAll("info@swpsummit.com", "douglas@peoplestrategyhub.com")
    .replaceAll("hello@swpsummit.com", "douglas@peoplestrategyhub.com")
    .replaceAll("accounts@swpsummit.com", "douglas@peoplestrategyhub.com")
    .replaceAll("Thursday, 3 September 2026", "Wednesday, 3 March 2027")
    .replaceAll("3 September 2026", "Wednesday, 3 March 2027")
    .replaceAll("3 Sep 2026", "3 Mar 2027")
    .replaceAll("155 Bishopsgate, London EC2M 3TQ", "1 Basinghall Avenue, London EC2V 5DD")
    .replaceAll("155 Bishopsgate, London", "1 Basinghall Avenue, London")
    .replaceAll("EC2M 3TQ", "EC2V 5DD")
    .replaceAll("#E74F3E", "#004eb9")
    .replaceAll("#F48847", "#266cc7")
    .replaceAll("#FCFBFA", "#f0f6ff")
    .replaceAll("#DEDDDC", "#e2e8f0");
}

async function rebrandLegacyDefaults() {
  const [settings] = await db.select().from(eventSettingsTable);
  if (settings) {
    const updates: Partial<typeof eventSettingsTable.$inferInsert> = {};
    if (settings.eventName === "HR Analytics Summit") updates.eventName = "SWP Summit";
    if (settings.eventDate === "3 September 2026") updates.eventDate = "Wednesday, 3 March 2027";
    if (settings.eventVenue === "155 Bishopsgate, London")
      updates.eventVenue = "1 Basinghall Avenue, London";
    if (settings.eventVenuePostcode === "EC2M 3TQ") updates.eventVenuePostcode = "EC2V 5DD";
    if (settings.orgWebsite === "https://www.hranalyticssummit.com")
      updates.orgWebsite = "https://swpsummit.com";
    if (settings.fromName === "HR Analytics Summit") updates.fromName = "SWP Summit";
    if (settings.fromEmail === "noreply@hranalyticssummit.com")
      updates.fromEmail = "douglas@peoplestrategyhub.com";
    if (settings.refPrefix === "HRAS26") updates.refPrefix = "SWP27";

    if (Object.keys(updates).length > 0) {
      await db
        .update(eventSettingsTable)
        .set(updates)
        .where(eq(eventSettingsTable.id, settings.id));
      logger.info({ fields: Object.keys(updates) }, "Rebranded legacy event setting defaults");
    }
  }

  const templates = await db.select().from(emailTemplatesTable);
  for (const template of templates) {
    const subject = rebrandLegacyText(template.subject);
    const htmlBody = rebrandLegacyText(template.htmlBody);
    if (subject !== template.subject || htmlBody !== template.htmlBody) {
      await db
        .update(emailTemplatesTable)
        .set({ subject, htmlBody })
        .where(eq(emailTemplatesTable.id, template.id));
      logger.info({ type: template.type }, "Rebranded legacy email template text");
    }
  }
}

export async function seed() {
  try {
    await rebrandLegacyDefaults();

    const existing = await db
      .select()
      .from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.type, "welcome"));

    if (existing.length === 0) {
      await db.insert(emailTemplatesTable).values({
        type: "welcome",
        subject: DEFAULT_WELCOME_SUBJECT,
        htmlBody: DEFAULT_WELCOME_BODY,
      });
      logger.info("Seeded welcome email template");
    } else {
      logger.debug("Welcome email template already present, skipping seed");
    }

    // Seed confirmation email template (insert-only; never overwrite admin edits)
    const existingConfirmation = await db
      .select()
      .from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.type, "confirmation"));

    if (existingConfirmation.length === 0) {
      await db.insert(emailTemplatesTable).values({
        type: "confirmation",
        subject: DEFAULT_CONFIRMATION_SUBJECT,
        htmlBody: DEFAULT_CONFIRMATION_BODY,
      });
      logger.info("Seeded confirmation email template");
    } else {
      logger.debug("Confirmation email template already present, skipping seed");
    }

    const existingTiers = await db.select().from(discountTiersTable);
    if (existingTiers.length === 0) {
      await db.insert(discountTiersTable).values(DEFAULT_DISCOUNT_TIERS);
      logger.info("Seeded default discount tiers");
    }

    const existingPasses = await db.select().from(passConfigTable);
    if (existingPasses.length === 0) {
      await db.insert(passConfigTable).values([
        {
          passType: "single",
          currentPrice: "199.00",
          originalPrice: "429.00",
          pricingPeriodName: "Super Early Bird",
          benefits: [
            "Conference Sessions",
            "Networking Sessions",
            "Happy Hour Networking",
            "Personalised Agenda",
            "Access to Pre-Event Social",
            "Exhibition Hall",
            "Award-winning Food & Drink",
            "On-Demand Recordings",
            "Additional Content Access",
            "Presentation Slides",
            "Post-Event Content",
          ],
          extraBenefits: [],
        },
        {
          passType: "business",
          currentPrice: "499.00",
          originalPrice: "999.00",
          pricingPeriodName: "Super Early Bird",
          benefits: [
            "Conference Sessions",
            "Networking Sessions",
            "Happy Hour with Entertainment",
            "Exhibition Hall",
            "Award-winning Food & Drink",
            "On-Demand Recordings",
            "Additional Content Access",
            "Presentation Slides",
            "Post-Event Content",
          ],
          extraBenefits: ["Exclusive Attendee Report", "Company Branding at the Summit"],
        },
      ]);
      logger.info("Seeded default pass config");
    }
  } catch (err) {
    logger.error({ err }, "Seed failed");
  }
}
