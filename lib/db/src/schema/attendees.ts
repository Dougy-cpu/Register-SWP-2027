import { pgTable, text, serial, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { bookingsTable } from "./bookings";

export const attendeesTable = pgTable(
  "attendees",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    isLead: boolean("is_lead").notNull().default(false),
    seatIndex: integer("seat_index").notNull().default(0),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    jobTitle: text("job_title").notNull(),
    company: text("company").notNull(),
    workEmail: text("work_email").notNull(),
    phone: text("phone"),
    dietaryAccessibility: text("dietary_accessibility"),
    isTbc: boolean("is_tbc").notNull().default(false),
    gdprConsent: boolean("gdpr_consent").notNull().default(false),
    gdprConsentAt: timestamp("gdpr_consent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // Every booking detail page joins attendees on bookingId. Unindexed today.
    bookingIdIdx: index("attendees_booking_id_idx").on(table.bookingId),
  }),
);

export const insertAttendeeSchema = createInsertSchema(attendeesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAttendee = z.infer<typeof insertAttendeeSchema>;
export type Attendee = typeof attendeesTable.$inferSelect;
