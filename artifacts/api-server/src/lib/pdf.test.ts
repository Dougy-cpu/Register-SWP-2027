import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePdfReceipt } from "./pdf";

// Only the static seat counts are used by the renderer. No database or email connection.
vi.mock("./pricing", () => ({
  PASS_PRICES: { single: { seats: 1 }, team: { seats: 3 }, business: { seats: 1 } },
}));

const booking: Parameters<typeof generatePdfReceipt>[0] = {
  id: 1,
  orderReference: "SWP27-TEST",
  passType: "single",
  quantity: 5,
  subtotalAmount: "604.80",
  vatAmount: "120.96",
  totalAmount: "725.76",
  promoCode: "WELCOMEBACK",
  promoDiscountAmount: "151.20",
  groupDiscountAmount: "189.00",
  billingName: "Alex Example",
  billingCompany: "Example Company",
  billingEmail: "alex@example.com",
  billingAddress: null,
  paymentMethod: "card",
  paidAt: "2026-10-30T12:00:00Z",
  cardBrand: "Visa",
  cardLast4: "1234",
  createdAt: new Date("2026-10-30T12:00:00Z"),
};

interface TextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: object;
}

function observeRendering() {
  const boxes: TextBox[] = [];
  const original = PDFDocument.prototype.text;
  vi.spyOn(PDFDocument.prototype, "text").mockImplementation(function (
    this: PDFKit.PDFDocument,
    text: string,
    x?: number | PDFKit.Mixins.TextOptions,
    y?: number | PDFKit.Mixins.TextOptions,
    options?: PDFKit.Mixins.TextOptions,
  ) {
    if (typeof x === "number" && typeof y === "number") {
      const size = (this as unknown as { _fontSize: number })._fontSize;
      boxes.push({
        text,
        x,
        y: y - size * 0.82,
        width: this.widthOfString(text, options),
        height: size,
        page: this.page,
      });
    }
    return original.call(this, text, x as number, y as number, options);
  });
  return boxes;
}

function assertNoOverlaps(boxes: TextBox[]) {
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i]!;
    if (!a.text) continue;
    expect(a.x, a.text).toBeGreaterThanOrEqual(43);
    expect(a.x + a.width, a.text).toBeLessThanOrEqual(552);
    expect(a.y, a.text).toBeGreaterThanOrEqual(0);
    expect(a.y + a.height, a.text).toBeLessThan(842);
    for (const b of boxes.slice(i + 1)) {
      if (a.page !== b.page || !b.text) continue;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapX > 0.2 && overlapY > 0.2, `${a.text} overlaps ${b.text}`).toBe(false);
    }
  }
}

async function saveForVisualCheck(name: string, pdf: Buffer) {
  // Opt-in local artefacts, never production records or outgoing attachments.
  if (!process.env.RECEIPT_QA_DIR) return;
  await mkdir(process.env.RECEIPT_QA_DIR, { recursive: true });
  await writeFile(join(process.env.RECEIPT_QA_DIR, `${name}.pdf`), pdf);
}

afterEach(() => vi.restoreAllMocks());

describe("branded VAT receipts", () => {
  it("renders both logos, every receipt detail and the stored discounted amounts without collisions", async () => {
    const boxes = observeRendering();
    const pdf = await generatePdfReceipt(booking, []);
    const text = boxes.map((box) => box.text).join("\n");
    for (const expected of [
      "VAT Receipt",
      "SWP27-TEST",
      "30 October 2026",
      "Visa ending 1234",
      "Alex Example",
      "Example Company",
      "alex@example.com",
      "Workforce Pass, SWP Summit",
      "5",
      "GBP 189.00",
      "GBP 945.00",
      "-GBP 189.00",
      "-GBP 151.20",
      "GBP 604.80",
      "GBP 120.96",
      "GBP 725.76",
      "Dynamic Business Leaders Limited",
      "12252258",
      "336124621",
      "45 Lemsford Village",
      "Hertfordshire AL8 7TR",
      "douglas@dynamicbusinessleaders.co.uk",
      "07763618052",
      "04-06-05",
      "16963209",
      "GB65CLRB04060516963209",
      "CLRBGB22",
      "GB45TCCL00997990500906",
      "TCCLGB31",
    ])
      expect(text).toContain(expected);
    expect(text).not.toMatch(/design preview|for approval/i);
    expect(pdf.toString("latin1")).not.toMatch(/design preview|for approval/i);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(
      (pdf.toString("latin1").match(/\/Subtype \/Image/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(boxes.map((box) => box.page)).size).toBe(1);
    assertNoOverlaps(boxes);
    await saveForVisualCheck("standard", pdf);
  });

  it("preserves full billing details and long references across pages", async () => {
    const boxes = observeRendering();
    const pdf = await generatePdfReceipt(
      {
        ...booking,
        billingName: "Alexandra Example-Sutherland and the Procurement Team",
        billingCompany: "International Workforce Planning and Organisational Development Limited",
        billingEmail: "alexandra.procurement.and.workforce.planning@example.com",
        billingAddressLine1: "Building 24, International Business and Research Campus",
        billingAddressLine2: "Floor 12, Finance and Procurement Department",
        billingTown: "Welwyn Garden City",
        billingRegion: "Hertfordshire",
        billingPostcode: "AL8 7TR",
        billingCountry: "United Kingdom",
        billingPhone: "+44 20 7946 0123",
        billingVatNumber: "GB123456789",
        poNumber: "PO-WORKFORCE-PLANNING-2027-PROCUREMENT-1234567890",
      },
      [],
    );
    const text = boxes
      .map((box) => box.text)
      .join("")
      .replace(/\s/g, "");
    for (const expected of [
      "GB123456789",
      "PO-WORKFORCE-PLANNING-2027-PROCUREMENT-1234567890",
      "+442079460123",
      "UnitedKingdom",
      "Floor12,FinanceandProcurementDepartment",
      "GBP725.76",
    ])
      expect(text).toContain(expected);
    expect(new Set(boxes.map((box) => box.page)).size).toBe(2);
    assertNoOverlaps(boxes);
    await saveForVisualCheck("long-billing", pdf);
  });

  it("shows a team booking as one bundle and falls back to the lead attendee", async () => {
    const boxes = observeRendering();
    const pdf = await generatePdfReceipt(
      {
        ...booking,
        passType: "team",
        quantity: 3,
        billingName: null,
        billingCompany: null,
        billingEmail: null,
        groupDiscountAmount: "0",
        promoDiscountAmount: "0",
        promoCode: null,
        subtotalAmount: "499.00",
        vatAmount: "99.80",
        totalAmount: "598.80",
      },
      [
        {
          firstName: "Taylor",
          lastName: "Example",
          company: "Example Team",
          workEmail: "taylor@example.com",
          isLead: true,
        },
      ],
    );
    const text = boxes.map((box) => box.text);
    expect(text).toContain("Team Pass, SWP Summit");
    expect(text).toContain("1");
    expect(text).not.toContain("3");
    expect(text).toContain("Taylor Example");
    expect(text).not.toContain("Group Discount");
    expect(text.filter((value) => value === "GBP 499.00")).toHaveLength(3);
    expect(text).toContain("GBP 598.80");
    assertNoOverlaps(boxes);
    await saveForVisualCheck("team", pdf);
  });

  it("keeps large monetary values on one line and never truncates legacy addresses", async () => {
    const boxes = observeRendering();
    const address = Array.from({ length: 90 }, (_, i) => `Billing address line ${i + 1}`).join(
      "\n",
    );
    const pdf = await generatePdfReceipt(
      {
        ...booking,
        passType: "business",
        quantity: 10000,
        subtotalAmount: "123456789.99",
        vatAmount: "24691358.00",
        totalAmount: "148148147.99",
        groupDiscountAmount: "0",
        promoDiscountAmount: "0",
        promoCode: null,
        billingAddress: address,
      },
      [],
    );
    const text = boxes.map((box) => box.text);
    expect(text).toContain("Billing address line 90");
    expect(text).toContain("GBP 123456789.99");
    expect(text).toContain("GBP 148148147.99");
    expect(text).toContain("Business Pass, SWP Summit");
    assertNoOverlaps(boxes);
    await saveForVisualCheck("overflow", pdf);
  });
});
