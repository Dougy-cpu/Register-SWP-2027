import {
  customType,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bookingsTable } from "./bookings";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const bookingDocumentsTable = pgTable(
  "booking_documents",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    bookingIdIdx: index("booking_documents_booking_id_idx").on(table.bookingId),
    bookingDocumentTypeUniq: uniqueIndex("booking_documents_booking_type_uniq").on(
      table.bookingId,
      table.documentType,
    ),
  }),
);

export type BookingDocument = typeof bookingDocumentsTable.$inferSelect;
