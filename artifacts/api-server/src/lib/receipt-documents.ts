import { eq, and } from "drizzle-orm";
import { db, attendeesTable, bookingDocumentsTable, bookingsTable } from "@workspace/db";
import { generatePdfReceipt } from "./pdf";
import { logger } from "./logger";
import { getStripe } from "./stripe-client";

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

function formatCardBrand(brand: string | null | undefined): string | null {
  if (!brand) return null;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

async function getReceiptCardDetails(
  booking: typeof bookingsTable.$inferSelect,
): Promise<{ cardBrand?: string | null; cardLast4?: string | null }> {
  if (booking.paymentMethod !== "card" || !booking.stripePaymentIntentId) return {};

  const stripe = getStripe();
  if (!stripe) return {};

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(booking.stripePaymentIntentId, {
      expand: ["latest_charge"],
    });
    const latestCharge = paymentIntent.latest_charge;
    if (!latestCharge || typeof latestCharge === "string") return {};

    const card = latestCharge.payment_method_details?.card;
    return {
      cardBrand: formatCardBrand(card?.brand),
      cardLast4: card?.last4 ?? null,
    };
  } catch (err) {
    logger.warn(
      { err, bookingId: booking.id, paymentIntentId: booking.stripePaymentIntentId },
      "Could not load Stripe card details for VAT receipt",
    );
    return {};
  }
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

export async function generateReceiptPdfForBooking(
  booking: typeof bookingsTable.$inferSelect,
  attendees: Array<typeof attendeesTable.$inferSelect>,
): Promise<Buffer> {
  const cardDetails = await getReceiptCardDetails(booking);
  return generatePdfReceipt({ ...booking, ...cardDetails }, attendees);
}

export async function archiveGeneratedReceiptForPaidBooking(
  booking: typeof bookingsTable.$inferSelect,
  attendees: Array<typeof attendeesTable.$inferSelect>,
): Promise<ReceiptDocument | null> {
  if (booking.status !== "paid") return null;

  const pdfBuffer = await generateReceiptPdfForBooking(booking, attendees);
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
