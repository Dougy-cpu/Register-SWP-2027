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
    await db.execute(
      sql`ALTER TYPE email_template_type ADD VALUE IF NOT EXISTS 'community_social'`,
    );
    await db.execute(sql`ALTER TYPE email_log_type ADD VALUE IF NOT EXISTS 'community_social'`);
    await db.execute(sql`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS community_social_email_sent BOOLEAN NOT NULL DEFAULT FALSE
    `);
    logger.info("Migration: Community Social email types and delivery flag ensured");
  } catch (err) {
    logger.warn({ err }, "Migration: could not ensure Community Social email support");
  }

  try {
    await db.execute(sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hear_about_us TEXT`);
    logger.info("Migration: hear_about_us column ensured");
  } catch (err) {
    logger.warn({ err }, "Migration: could not ensure hear_about_us column");
  }

  try {
    await db.execute(sql`
      ALTER TABLE notification_emails
      ADD COLUMN IF NOT EXISTS notify_checkout_expired BOOLEAN NOT NULL DEFAULT FALSE
    `);
    logger.info("Migration: notify_checkout_expired column ensured");
  } catch (err) {
    logger.warn({ err }, "Migration: could not ensure notify_checkout_expired column");
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS booking_documents (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS booking_documents_booking_type_uniq
      ON booking_documents (booking_id, document_type)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS booking_documents_booking_id_idx
      ON booking_documents (booking_id)
    `);
    logger.info("Migration: booking_documents table ensured");
  } catch (err) {
    logger.warn({ err }, "Migration: could not ensure booking_documents table");
  }
}

const DEFAULT_CONFIRMATION_SUBJECT = "Booking Confirmed - {{orderReference}} - SWP Summit 2027";

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
<p style="margin: 0 0 16px; color: #444; line-height: 1.6;">You have a secure self-service link to manage all your attendee information. You can fill in placeholder seats, update existing details and add dietary requirements without logging in. Need to share registration with colleagues? Forward them the link to enter their own details.</p>

{{managementLink}}

<p>A PDF VAT receipt is attached to this email for your records.</p>
{{invoiceConfirmation}}
{{invoicePaymentButton}}
{{billingEditLink}}
{{invoiceHelp}}
{{emailDeliveryReminder}}
<p>We look forward to seeing you at the SWP Summit!</p>
`;

const DEFAULT_WELCOME_SUBJECT = "Welcome to SWP Summit 2027 - We Can't Wait to See You!";

const DEFAULT_WELCOME_BODY = `
<h2>Welcome, {{firstName}}!</h2>

<p>We're absolutely thrilled to have you joining us at the <strong>SWP Summit 2027</strong>, the UK's leading event for HR leaders, people analytics practitioners, and business innovators who are shaping the future of work.</p>

<p>Here's what to look forward to on <strong>Wednesday, 3 March 2027</strong> at <strong>1 Basinghall Avenue, London</strong>:</p>

<ul>
  <li><strong>Inspiring keynotes</strong> from world-class HR and analytics leaders</li>
  <li><strong>Practical breakout sessions</strong> covering the latest in people data, AI in HR, and workforce planning</li>
  <li><strong>Networking opportunities</strong> throughout the day, meet your peers and discover new solutions</li>
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

const DEFAULT_COMMUNITY_SOCIAL_SUBJECT = "{{socialName}} invitation - {{eventName}}";

const DEFAULT_COMMUNITY_SOCIAL_BODY = `
<h2>You're invited to the Community Social</h2>

<p>Hi {{firstName}},</p>

<p>We'd like to invite you to <strong>{{socialName}}</strong>, connected with {{eventName}}.</p>

<div class="info-box">
  <strong>{{socialName}}</strong><br>
  <strong>Date:</strong> {{socialDate}}<br>
  <strong>Time:</strong> {{socialTime}}<br>
  <strong>Venue:</strong> {{socialVenue}}
</div>

<p>{{socialDescription}}</p>

{{socialCalendarLinks}}

<p style="text-align:center;margin:28px 0;">
  <a href="{{socialDetailsUrl}}" style="display:inline-block;background:#004eb9;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:700;">Visit the SWP Summit website</a>
</p>

<p><a href="{{socialMapUrl}}">View the venue on Google Maps</a></p>

<p>Best,<br>
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

const DEFAULT_PASS_BENEFITS = [
  "Full summit day",
  "Main stage keynotes and content forums",
  "Planning Lab sessions",
  "PowerPulse and optional Quickfire sessions",
  "Personalised agenda creator before the event",
  "Networking breaks, lunch and drinks reception",
  "Session slides and recordings after the event",
];

const DEFAULT_BUSINESS_EXTRA_BENEFITS = [
  "This is an attendee pass, not a sponsorship package.",
  "Speaking, branding, sponsor visibility and VIP invitations are handled separately.",
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

  const passConfigs = await db.select().from(passConfigTable);
  for (const config of passConfigs) {
    const updates: Partial<typeof passConfigTable.$inferInsert> = {};
    const benefits = Array.isArray(config.benefits) ? config.benefits : [];
    const extraBenefits = Array.isArray(config.extraBenefits) ? config.extraBenefits : [];
    const currentPrice = Number(config.currentPrice);

    if (config.passType === "single") {
      if (currentPrice === 199) updates.currentPrice = "249.00";
      if (config.pricingPeriodName === "Early Bird") updates.pricingPeriodName = "Super Early Bird";
      if (
        benefits.includes("Conference Sessions") ||
        benefits.includes("Access to Pre-Event Social")
      ) {
        updates.benefits = DEFAULT_PASS_BENEFITS;
      }
    }

    if (config.passType === "business") {
      if (currentPrice === 599) updates.currentPrice = "499.00";
      if (config.pricingPeriodName === "Early Bird") updates.pricingPeriodName = "Super Early Bird";
      if (
        benefits.includes("Conference Sessions") ||
        benefits.includes("Happy Hour with Entertainment")
      ) {
        updates.benefits = DEFAULT_PASS_BENEFITS;
      }
      if (
        extraBenefits.includes("Exclusive Attendee Report") ||
        extraBenefits.includes("Company Branding at the Summit")
      ) {
        updates.extraBenefits = DEFAULT_BUSINESS_EXTRA_BENEFITS;
      }
    }

    if (Object.keys(updates).length > 0) {
      await db
        .update(passConfigTable)
        .set(updates)
        .where(eq(passConfigTable.passType, config.passType));
      logger.info({ passType: config.passType }, "Updated legacy pass config defaults");
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

    // This template is available for manual sends only. It is intentionally
    // not part of the automatic post-booking email sequence.
    const existingCommunitySocial = await db
      .select()
      .from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.type, "community_social"));

    if (existingCommunitySocial.length === 0) {
      await db.insert(emailTemplatesTable).values({
        type: "community_social",
        subject: DEFAULT_COMMUNITY_SOCIAL_SUBJECT,
        htmlBody: DEFAULT_COMMUNITY_SOCIAL_BODY,
      });
      logger.info("Seeded Community Social email template");
    } else {
      logger.debug("Community Social email template already present, skipping seed");
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
          currentPrice: "249.00",
          originalPrice: "429.00",
          pricingPeriodName: "Super Early Bird",
          benefits: DEFAULT_PASS_BENEFITS,
          extraBenefits: [],
        },
        {
          passType: "business",
          currentPrice: "499.00",
          originalPrice: "999.00",
          pricingPeriodName: "Super Early Bird",
          benefits: DEFAULT_PASS_BENEFITS,
          extraBenefits: DEFAULT_BUSINESS_EXTRA_BENEFITS,
        },
      ]);
      logger.info("Seeded default pass config");
    }
  } catch (err) {
    logger.error({ err }, "Seed failed");
  }
}
