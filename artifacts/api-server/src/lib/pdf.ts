import PDFDocument from "pdfkit";
import { PASS_PRICES } from "./pricing";
import { ReceiptLayout, receiptColours, type ReceiptPosition } from "./receipt-layout";

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
  paymentMethod?: string | null;
  paidAt?: Date | string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
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
  single: "Workforce Pass, SWP Summit",
  team: "Team Pass, SWP Summit",
  business: "Business Pass, SWP Summit",
};

export function generatePdfReceipt(
  booking: BookingForPdf,
  attendees: AttendeeForPdf[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const reference = booking.orderReference || `INV-${booking.id}`;
    const doc = new PDFDocument({
      margin: 0,
      size: "A4",
      bufferPages: true,
      compress: false,
      info: {
        Title: `SWP Summit 2027 - VAT Receipt ${reference}`,
        Author: "People Strategy Hub",
        Subject: `VAT receipt ${reference}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const layout = new ReceiptLayout(doc);
      const { left, right } = layout;
      const { muted, blue, wash } = receiptColours;
      const formatCurrency = (n: number) => `GBP ${n.toFixed(2)}`;
      const lead = attendees.find((a) => a.isLead) || attendees[0];
      const receiptDate =
        booking.paymentMethod === "card" && booking.paidAt ? new Date(booking.paidAt) : new Date();
      const dateStr = receiptDate.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });

      // Preserve the stored post-discount amounts and existing bundle display rules.
      const subtotalAfterDiscounts = parseFloat(booking.subtotalAmount?.toString() || "0");
      const vat = parseFloat(booking.vatAmount?.toString() || "0");
      const total = parseFloat(booking.totalAmount?.toString() || "0");
      const promoDiscount = parseFloat(booking.promoDiscountAmount?.toString() || "0");
      const groupDiscount = parseFloat(booking.groupDiscountAmount?.toString() || "0");
      const baseAmount = subtotalAfterDiscounts + groupDiscount + promoDiscount;
      const passInfo = PASS_PRICES[booking.passType];
      const isBundlePass = passInfo ? passInfo.seats > 1 : false;
      const displayQty = isBundlePass ? 1 : booking.quantity;
      const displayUnitPrice = baseAmount / Math.max(displayQty, 1);

      layout.text("VAT Receipt", left, 161, { size: 31, font: "ExtraBold" });
      layout.label("RECEIPT NUMBER", right, 166, "right");
      const referenceEnd = layout.paragraph(
        reference,
        311,
        right - 311,
        { page: 0, y: 183 },
        {
          size: 17.5,
          font: "SemiBold",
          align: "right",
        },
      );
      const detailsStart = layout.ensure(
        { page: referenceEnd.page, y: Math.max(219, referenceEnd.y + 12) },
        50,
      );
      layout.label("BILL TO", left, detailsStart.y);
      let billing: ReceiptPosition = { ...detailsStart, y: detailsStart.y + 20 };
      const billingLine = (value: string | null | undefined, size = 10, bold = false) => {
        if (!value) return;
        billing = layout.paragraph(value, left, 260, billing, {
          size,
          font: bold ? "SemiBold" : "Regular",
          colour: bold ? receiptColours.ink : muted,
        });
        billing.y += 3;
      };
      billingLine(
        booking.billingName || (lead ? `${lead.firstName} ${lead.lastName}` : ""),
        12.5,
        true,
      );
      billingLine(booking.billingCompany || lead?.company, 10.5);
      billingLine(booking.billingEmail || lead?.workEmail);
      if (booking.billingAddressLine1) {
        billingLine(booking.billingAddressLine1);
        billingLine(booking.billingAddressLine2);
        billingLine([booking.billingTown, booking.billingRegion].filter(Boolean).join(", "));
        billingLine(booking.billingPostcode);
        billingLine(booking.billingCountry);
      } else {
        billingLine(booking.billingAddress);
      }
      if (booking.billingPhone) billingLine(`Tel: ${booking.billingPhone}`);
      if (booking.billingVatNumber) billingLine(`VAT No: ${booking.billingVatNumber}`);

      let metadata: ReceiptPosition = { ...detailsStart, y: detailsStart.y + 1 };
      const metadataRows = [
        ["Date", dateStr],
        ["Booking Reference", booking.orderReference || `#${booking.id}`],
        ...(booking.cardBrand && booking.cardLast4
          ? [["Payment Card", `${booking.cardBrand} ending ${booking.cardLast4}`]]
          : []),
        ...(booking.poNumber ? [["PO Number", booking.poNumber]] : []),
      ];
      for (const [key, value] of metadataRows) {
        metadata = layout.ensure(metadata, 27);
        layout.text(key!, 333, metadata.y + 1, { size: 9.1, colour: muted });
        const end = layout.paragraph(value!, 442, right - 442, metadata, {
          size: 10.1,
          font: "SemiBold",
          align: "right",
        });
        metadata = {
          page: end.page,
          y: Math.max(end.y + 12, end.page === metadata.page ? metadata.y + 27 : 0),
        };
      }

      const end =
        billing.page > metadata.page || (billing.page === metadata.page && billing.y > metadata.y)
          ? billing
          : metadata;
      let position: ReceiptPosition = {
        page: end.page,
        y: Math.max(end.page === 0 ? 315 : 0, end.y + 14),
      };
      const rows = [
        {
          description: passLabels[booking.passType] || booking.passType,
          quantity: String(displayQty),
          unit: formatCurrency(displayUnitPrice),
          amount: formatCurrency(baseAmount),
        },
        ...(groupDiscount > 0
          ? [
              {
                description: "Group Discount",
                quantity: "",
                unit: "",
                amount: `-${formatCurrency(groupDiscount)}`,
              },
            ]
          : []),
        ...(promoDiscount > 0
          ? [
              {
                description: `Promo Code (${booking.promoCode})`,
                quantity: "",
                unit: "",
                amount: `-${formatCurrency(promoDiscount)}`,
              },
            ]
          : []),
      ];
      const rowHeights = rows.map((row) =>
        Math.max(30, layout.lines(row.description, 240).length * 14.175 + 14),
      );
      // Keep prices, totals and legal details together where they fit on a fresh page.
      const summaryHeight = 43 + rowHeights.reduce((sum, height) => sum + height, 0) - 1 + 330;
      if (summaryHeight <= layout.bottom - layout.continuationTop)
        position = layout.ensure(position, summaryHeight);
      else position = layout.ensure(position, 90);

      const tableHeader = () => {
        doc.rect(left, position.y, right - left, 28).fill(wash);
        for (const [x, value, align] of [
          [54, "DESCRIPTION", "left"],
          [321, "QTY", "right"],
          [431, "UNIT PRICE", "right"],
          [541, "AMOUNT", "right"],
        ] as const) {
          layout.text(value, x, position.y + 10, {
            size: 8.3,
            font: "SemiBold",
            colour: blue,
            spacing: 0.45,
            align,
          });
        }
        position.y += 43;
      };
      layout.selectPage(position.page);
      tableHeader();
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        if (position.y + Math.min(rowHeights[index]!, 90) > layout.bottom) {
          position = layout.nextPage(position);
          tableHeader();
        }
        layout.number(row.quantity, 321, position.y, 25);
        layout.number(row.unit, 431, position.y, 90);
        layout.number(row.amount, 541, position.y, 90, { font: "SemiBold" });
        const descriptionEnd = layout.paragraph(row.description, 54, 240, position);
        position = {
          page: descriptionEnd.page,
          y: Math.max(
            descriptionEnd.y + 14,
            descriptionEnd.page === position.page ? position.y + 30 : 0,
          ),
        };
        layout.rule(position.y - (index === rows.length - 1 ? 1 : 9));
      }
      // Totals are a single block, with no currency wrapping or automatic page breaks.
      position.y -= 1;
      position = layout.ensure(position, 165);
      layout.text("Subtotal (excl. VAT)", 333, position.y + 23, { size: 10.1, colour: muted });
      layout.number(formatCurrency(subtotalAfterDiscounts), 541, position.y + 23, 90, {
        size: 10.7,
        font: "SemiBold",
      });
      layout.text("VAT (20%)", 333, position.y + 47, { size: 10.1, colour: muted });
      layout.number(formatCurrency(vat), 541, position.y + 47, 90, {
        size: 10.7,
        font: "SemiBold",
      });
      doc.rect(left, position.y + 79, right - left, 55).fill(wash);
      doc.rect(left, position.y + 79, 3, 55).fill(blue);
      layout.text("Total (incl. VAT)", 64, position.y + 100, { size: 13, font: "SemiBold" });
      layout.number(formatCurrency(total), right - 18, position.y + 93, 220, {
        size: 25,
        font: "ExtraBold",
        colour: blue,
      });
      layout.text(
        "This document serves as a VAT receipt. VAT Reg No: 336124621",
        left,
        position.y + 153,
        { size: 8.9, colour: muted },
      );

      position.y += 179;
      position = layout.ensure(position, 151);
      layout.rule(position.y);
      layout.label("ISSUED BY", left, position.y + 19);
      layout.label("BANK DETAILS", 321, position.y + 19);
      const issuer = [
        [39, "Dynamic Business Leaders Limited", 10, true],
        [57, "Company No. 12252258  |  VAT No. 336124621", 8.6, false],
        [77, "Registered Address:", 8.5, true],
        [91, "45 Lemsford Village, Welwyn Garden City,", 8.7, false],
        [105, "Hertfordshire AL8 7TR", 8.7, false],
        [124, "Contact: douglas@dynamicbusinessleaders.co.uk", 8.5, false],
        [139, "Tel: 07763618052", 8.7, false],
      ] as const;
      const bank = [
        [39, "Bank: Tide (ClearBank)", 10, true],
        [57, "Sort Code: 04-06-05  |  Account: 16963209", 8.6, false],
        [78, "IBAN (GBP): GB65CLRB04060516963209", 8.6, false],
        [93, "SWIFT: CLRBGB22", 8.7, false],
        [115, "IBAN (EUR): GB45TCCL00997990500906", 8.6, false],
        [130, "BIC: TCCLGB31", 8.7, false],
      ] as const;
      for (const [x, lines] of [
        [left, issuer],
        [321, bank],
      ] as const) {
        for (const [offset, value, size, bold] of lines) {
          layout.text(value, x, position.y + offset, {
            size,
            font: bold ? "SemiBold" : "Regular",
            colour: bold ? receiptColours.ink : muted,
          });
        }
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
