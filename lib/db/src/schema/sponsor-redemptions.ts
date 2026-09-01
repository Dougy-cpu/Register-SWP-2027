import {
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bookingsTable } from "./bookings";
import { promoCodesTable } from "./promo-codes";
import { sponsorsTable } from "./sponsors";

export const sponsorRedemptionStatusEnum = pgEnum("sponsor_redemption_status", [
  "reserved",
  "released",
]);

export const sponsorRedemptionsTable = pgTable(
  "sponsor_redemptions",
  {
    id: serial("id").primaryKey(),
    sponsorId: integer("sponsor_id")
      .notNull()
      .references(() => sponsorsTable.id, { onDelete: "restrict" }),
    promoCodeId: integer("promo_code_id")
      .notNull()
      .references(() => promoCodesTable.id, { onDelete: "restrict" }),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "restrict" }),
    units: integer("units").notNull(),
    status: sponsorRedemptionStatusEnum("status").notNull().default("reserved"),
    reservationKey: text("reservation_key").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    notificationSentAt: timestamp("notification_sent_at", { withTimezone: true }),
    notificationFailedAt: timestamp("notification_failed_at", { withTimezone: true }),
  },
  (table) => ({
    reservationUniq: uniqueIndex("sponsor_redemptions_reservation_key_uniq").on(
      table.reservationKey,
    ),
    bookingPromoUniq: uniqueIndex("sponsor_redemptions_booking_promo_uniq").on(
      table.bookingId,
      table.promoCodeId,
    ),
    sponsorStatusIdx: index("sponsor_redemptions_sponsor_status_idx").on(
      table.sponsorId,
      table.status,
    ),
  }),
);

export type SponsorRedemption = typeof sponsorRedemptionsTable.$inferSelect;
