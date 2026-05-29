import PDFDocument from "pdfkit";
import { PASS_PRICES } from "./pricing";

interface BookingForPdf {
  id: number;
  orderReference: string | null;
  passType: string;
  quantity: number;
  subtotalAmount: string | null;
  vatAmount: string | null;
  totalAmount: string | null;
  promoCode: string | null;
  promoDiscountAmount: string | null;
  groupDiscountAmount: string | null;
  billingName: string | null;
  billingCompany: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingTown?: string | null;
  billingRegion?: string | null;
  billingPostcode?: string | null;
  billingCountry?: string | null;
  billingPhone?: string | null;
  billingVatNumber?: string | null;
  poNumber?: string | null;
  createdAt: Date;
}

interface AttendeeForPdf {
  firstName: string;
  lastName: string;
  company: string;
  workEmail: string;
  isLead: boolean;
}

const passLabels: Record<string, string> = {
  single: "HR Professional Pass â€” SWP Summit",
  team: "Team Pass (3 Seats) â€” SWP Summit",
  business: "Business Pass â€” SWP Summit",
};

export function generatePdfReceipt(
  booking: BookingForPdf,
  attendees: AttendeeForPdf[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4", compress: false });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const formatCurrency = (n: number) => `Â£${n.toFixed(2)}`;

    const lead = attendees.find((a) => a.isLead) || attendees[0];
    const dateStr = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    // booking.subtotalAmount IS subtotalAfterDiscounts (stored post-discount).
    const subtotalAfterDiscounts = parseFloat(booking.subtotalAmount?.toString() || "0");
    const vat = parseFloat(booking.vatAmount?.toString() || "0");
    const total = parseFloat(booking.totalAmount?.toString() || "0");
    const promoDiscount = parseFloat(booking.promoDiscountAmount?.toString() || "0");
    const groupDiscount = parseFloat(booking.groupDiscountAmount?.toString() || "0");

    // Reconstruct gross amount shown in the top line item.
    const baseAmount = subtotalAfterDiscounts + groupDiscount + promoDiscount;

    // For team pass (bundle product): billing is 1 bundle, qty shown = 1.
    const passInfo = PASS_PRICES[booking.passType];
    const isBundlePass = passInfo ? passInfo.seats > 1 : false;
    const displayQty = isBundlePass ? 1 : booking.quantity;
    const displayUnitPrice = baseAmount / Math.max(displayQty, 1);

    doc.fontSize(22).fillColor("#004eb9").text("SWP Summit", { align: "left" });

    doc
      .fontSize(11)
      .fillColor("#666")
      .text("Wednesday, 3 March 2027 Â· 1 Basinghall Avenue, London EC2V 5DD", { align: "left" });

    doc.moveDown(0.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#004eb9").lineWidth(2).stroke();

    doc.moveDown(1);

    doc.fontSize(18).fillColor("#000").text("VAT Receipt", { align: "left" });

    doc.moveDown(0.5);
    doc.fontSize(11).fillColor("#333");
    doc.text(`Receipt Number: ${booking.orderReference || `INV-${booking.id}`}`);
    doc.text(`Date: ${dateStr}`);
    doc.text(`Booking Reference: ${booking.orderReference || `#${booking.id}`}`);
    if (booking.poNumber) {
      doc.text(`PO Number: ${booking.poNumber}`);
    }

    doc.moveDown(1);

    doc.fontSize(12).fillColor("#000").text("Bill To:", { underline: true });
    doc.fontSize(11).fillColor("#333");
    if (booking.billingName || lead) {
      doc.text(booking.billingName || `${lead?.firstName} ${lead?.lastName}` || "");
    }
    if (booking.billingCompany || lead?.company) {
      doc.text(booking.billingCompany || lead?.company || "");
    }
    if (booking.billingEmail || lead?.workEmail) {
      doc.text(booking.billingEmail || lead?.workEmail || "");
    }
    if (booking.billingAddressLine1) {
      doc.text(booking.billingAddressLine1);
      if (booking.billingAddressLine2) doc.text(booking.billingAddressLine2);
      const cityLine = [booking.billingTown, booking.billingRegion].filter(Boolean).join(", ");
      if (cityLine) doc.text(cityLine);
      if (booking.billingPostcode) doc.text(booking.billingPostcode);
      if (booking.billingCountry) doc.text(booking.billingCountry);
    } else if (booking.billingAddress) {
      doc.text(booking.billingAddress);
    }
    if (booking.billingPhone) {
      doc.text(`Tel: ${booking.billingPhone}`);
    }
    if (booking.billingVatNumber) {
      doc.text(`VAT No: ${booking.billingVatNumber}`);
    }

    doc.moveDown(1.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").lineWidth(1).stroke();

    const tableTop = doc.y + 10;
    doc
      .fontSize(11)
      .fillColor("#666")
      .text("Description", 50, tableTop)
      .text("Qty", 370, tableTop, { width: 50, align: "right" })
      .text("Unit Price", 420, tableTop, { width: 70, align: "right" })
      .text("Amount", 490, tableTop, { width: 55, align: "right" });

    doc
      .moveTo(50, tableTop + 18)
      .lineTo(545, tableTop + 18)
      .strokeColor("#ddd")
      .lineWidth(1)
      .stroke();

    let rowY = tableTop + 26;

    doc
      .fontSize(11)
      .fillColor("#000")
      .text(passLabels[booking.passType] || booking.passType, 50, rowY, { width: 310 })
      .text(String(displayQty), 370, rowY, { width: 50, align: "right" })
      .text(formatCurrency(displayUnitPrice), 420, rowY, { width: 70, align: "right" })
      .text(formatCurrency(baseAmount), 490, rowY, { width: 55, align: "right" });

    rowY += 24;

    if (groupDiscount > 0) {
      doc
        .fontSize(11)
        .fillColor("#333")
        .text("Group Discount", 50, rowY)
        .text("", 370, rowY, { width: 50, align: "right" })
        .text("", 420, rowY, { width: 70, align: "right" })
        .text(`-${formatCurrency(groupDiscount)}`, 490, rowY, { width: 55, align: "right" });
      rowY += 24;
    }

    if (promoDiscount > 0) {
      doc
        .fontSize(11)
        .fillColor("#333")
        .text(`Promo Code (${booking.promoCode})`, 50, rowY)
        .text(`-${formatCurrency(promoDiscount)}`, 490, rowY, { width: 55, align: "right" });
      rowY += 24;
    }

    doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor("#ddd").lineWidth(1).stroke();

    rowY += 10;

    // Subtotal (excl. VAT) = subtotalAfterDiscounts â€” discounts already subtracted above.
    doc
      .fontSize(11)
      .fillColor("#333")
      .text("Subtotal (excl. VAT)", 50, rowY)
      .text(formatCurrency(subtotalAfterDiscounts), 490, rowY, { width: 55, align: "right" });

    rowY += 20;

    doc
      .text("VAT (20%)", 50, rowY)
      .text(formatCurrency(vat), 490, rowY, { width: 55, align: "right" });

    rowY += 20;

    doc.moveTo(390, rowY).lineTo(545, rowY).strokeColor("#000").lineWidth(1.5).stroke();

    rowY += 8;

    doc
      .fontSize(14)
      .fillColor("#000")
      .text("Total (incl. VAT)", 50, rowY)
      .text(formatCurrency(total), 490, rowY, { width: 55, align: "right" });

    rowY += 40;

    doc.fontSize(10).fillColor("#555");
    doc.text("This document serves as a VAT receipt. VAT Reg No: 336124621", 50, rowY);

    rowY += 30;
    doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor("#eee").lineWidth(1).stroke();

    rowY += 20;
    doc.fontSize(9).fillColor("#555");

    doc.text("Issued by: Dynamic Business Leaders Limited", 50, rowY, { align: "center" });
    rowY += 13;
    doc.text("Company No. 12252258   |   VAT No. 336124621", 50, rowY, { align: "center" });
    rowY += 13;
    doc.text(
      "Registered Address: 45 Lemsford Village, Welwyn Garden City, Hertfordshire AL8 7TR",
      50,
      rowY,
      { align: "center" },
    );
    rowY += 13;
    doc.text("Contact: douglas@dynamicbusinessleaders.co.uk   |   Tel: 07763618052", 50, rowY, {
      align: "center",
    });

    rowY += 20;
    doc.text("Bank: Tide (ClearBank)", 50, rowY, { align: "center" });
    rowY += 13;
    doc.text("Sort Code: 04-06-05   |   Account: 16963209", 50, rowY, { align: "center" });
    rowY += 13;
    doc.text("IBAN (GBP): GB65CLRB04060516963209   |   SWIFT: CLRBGB22", 50, rowY, {
      align: "center",
    });
    rowY += 13;
    doc.text("IBAN (EUR): GB45TCCL00997990500906   |   BIC: TCCLGB31", 50, rowY, {
      align: "center",
    });

    rowY += 20;
    doc.fillColor("#888");
    doc.text("SWP Summit Â· 1 Basinghall Avenue, London EC2V 5DD Â· swpsummit.com", 50, rowY, {
      align: "center",
    });

    doc.end();
  });
}
