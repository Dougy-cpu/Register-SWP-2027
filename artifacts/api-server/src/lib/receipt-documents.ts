import { eq, and } from "drizzle-orm";
import { db, attendeesTable, bookingDocumentsTable, bookingsTable } from "@workspace/db";
import { generatePdfReceipt } from "./pdf";
import { logger } from "./logger";

const RECEIPT_DOCUMENT_TYPE = "receipt";
const RECEIPT_CONTENT_TYPE = "application/pdf";

type ReceiptDocument = {
  buffer: Buffer;
  filename: string;
  contentType: string;
  source: "archive" | "generated";
};

function receiptFilename(bookingId: number, orderReference: string | null): string {
  const ref = (orderReference || String(bookingId)).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `receipt-${ref}.pdf`;
}

async function getArchivedReceipt(bookingId: number): Promise<ReceiptDocument | null> {
  const [doc] = await db
    .select()
    .from(bookingDocumentsTable)
    .where(
      and(
        eq(bookingDocumentsTable.bookingId, bookingId),
        eq(bookingDocumentsTable.documentType, RECEIPT_DOCUMENT_TYPE),
      ),
    );

  if (!doc) return null;
  return {
    buffer: Buffer.from(doc.data),
    filename: doc.filename,
    contentType: doc.contentType,
    source: "archive",
  };
}

export async function archiveReceiptPdf(
  bookingId: number,
  pdfBuffer: Buffer,
  filename: string,
): Promise<void> {
  await db
    .insert(bookingDocumentsTable)
    .values({
      bookingId,
      documentType: RECEIPT_DOCUMENT_TYPE,
      filename,
      contentType: RECEIPT_CONTENT_TYPE,
      data: pdfBuffer,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [bookingDocumentsTable.bookingId, bookingDocumentsTable.documentType],
      set: {
        filename,
        contentType: RECEIPT_CONTENT_TYPE,
        data: pdfBuffer,
        updatedAt: new Date(),
      },
    });
}

export async function archiveGeneratedReceiptForPaidBooking(
  booking: typeof bookingsTable.$inferSelect,
  attendees: Array<typeof attendeesTable.$inferSelect>,
): Promise<ReceiptDocument | null> {
  if (booking.status !== "paid") return null;

  const pdfBuffer = await generatePdfReceipt(booking, attendees);
  const filename = receiptFilename(booking.id, booking.orderReference);
  await archiveReceiptPdf(booking.id, pdfBuffer, filename);

  return {
    buffer: pdfBuffer,
    filename,
    contentType: RECEIPT_CONTENT_TYPE,
    source: "generated",
  };
}

export async function getOrCreateArchivedReceiptPdf(bookingId: number): Promise<ReceiptDocument> {
  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    throw new Error("Booking not found");
  }
  if (booking.status !== "paid") {
    throw new Error("VAT receipt is only available after payment is complete");
  }

  const archived = await getArchivedReceipt(bookingId);
  if (archived) return archived;

  const attendees = await db
    .select()
    .from(attendeesTable)
    .where(eq(attendeesTable.bookingId, bookingId));

  const generated = await archiveGeneratedReceiptForPaidBooking(booking, attendees);
  if (!generated) {
    throw new Error("Could not generate VAT receipt");
  }

  logger.info({ bookingId }, "Backfilled archived VAT receipt PDF");
  return generated;
}
