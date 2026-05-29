import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookingsTable, attendeesTable } from "@workspace/db";
import { logger } from "./logger";

function getSheetsClient() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!spreadsheetId || !clientEmail || !privateKey) {
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId };
}

// One row per attendee — booking-level fields repeated per row for flat analysis.
const SHEET_HEADERS = [
  "Order Reference",
  "Booking Date",
  "Pass Type",
  "Quantity",
  "Attendee Type",
  "Payment Method",
  "Booking Status",
  "Seat Index",
  "Is Lead",
  "First Name",
  "Last Name",
  "Job Title",
  "Company",
  "Work Email",
  "Phone",
  "GDPR Consent",
  "GDPR Consent At",
  "Subtotal (exc VAT)",
  "VAT",
  "Total (inc VAT)",
  "Promo Code",
  "Group Discount",
  "Promo Discount",
];

async function ensureSheetHeaders(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
): Promise<void> {
  const range = "Sheet1!A1:W1";
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });

  if (!existing.data.values || existing.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

export async function syncBookingToSheets(bookingId: number): Promise<void> {
  const client = getSheetsClient();
  if (!client) {
    logger.debug("Google Sheets not configured — skipping sync");
    return;
  }

  const { sheets, spreadsheetId } = client;

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));

  if (!booking) {
    logger.error({ bookingId }, "Booking not found for Google Sheets sync");
    return;
  }

  const allAttendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));

  if (allAttendees.length === 0) {
    logger.warn({ bookingId }, "No attendees found for Google Sheets sync");
    return;
  }

  await ensureSheetHeaders(sheets, spreadsheetId);

  // One row per attendee — booking pricing fields are repeated for each row.
  const rows = allAttendees.map((attendee) => [
    booking.orderReference || `#${booking.id}`,
    new Date(booking.createdAt).toISOString().split("T")[0],
    booking.passType,
    String(booking.quantity),
    booking.attendeeType,
    booking.paymentMethod || "",
    booking.status,
    String(attendee.seatIndex),
    attendee.isLead ? "Yes" : "No",
    attendee.firstName,
    attendee.lastName,
    attendee.jobTitle || "",
    attendee.company,
    attendee.workEmail,
    attendee.phone || "",
    attendee.gdprConsent ? "Yes" : "No",
    attendee.gdprConsentAt ? new Date(attendee.gdprConsentAt).toISOString() : "",
    booking.subtotalAmount?.toString() || "0",
    booking.vatAmount?.toString() || "0",
    booking.totalAmount?.toString() || "0",
    booking.promoCode || "",
    booking.groupDiscountAmount?.toString() || "0",
    booking.promoDiscountAmount?.toString() || "0",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Sheet1!A:W",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  logger.info(
    { bookingId, orderRef: booking.orderReference, attendeeCount: rows.length },
    "Booking attendees synced to Google Sheets",
  );
}
