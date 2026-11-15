import nodemailer from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  bookingsTable,
  attendeesTable,
  emailTemplatesTable,
  eventSettingsTable,
  sponsorsTable,
} from "@workspace/db";
import type { Attendee, Booking, EventSettings } from "@workspace/db";
import { approvedEmailTemplates } from "./approved-email-design";
import {
  resendConfirmationAndReceipt,
  sendBookingEmails,
  sendConfirmationAndReceiptEmail,
  sendReissuedInvoiceEmail,
  sendWelcomeEmail,
} from "./email";
import { generateReceiptPdfForBooking } from "./receipt-documents";
import { sendSponsorStaffWelcome } from "./sponsor-email";

vi.mock("./receipt-documents", () => ({
  generateReceiptPdfForBooking: vi.fn(),
  archiveReceiptPdf: vi.fn(),
  archiveGeneratedReceiptForPaidBooking: vi.fn(),
}));

describe("real booking-email delivery paths with an intercepted transport", () => {
  let booking: Booking;
  let attendees: Attendee[];
  const receptionInstructions =
    "When you arrive, just give your name at reception. We’ll have your pass ready for you.";
  const sent = vi.fn().mockResolvedValue({ messageId: "intercepted-only" });
  const settings = {
    eventName: "SWP Summit",
    eventDate: "Wednesday, 3 March 2027",
    eventVenue: "1 Basinghall Avenue, London",
    eventVenuePostcode: "EC2V 5DD",
    fromName: "SWP Summit",
    fromEmail: "registration@example.invalid",
    eventStartAt: null,
    eventEndAt: null,
    socialEnabled: false,
  } as EventSettings;

  beforeEach(() => {
    sent.mockClear();
    vi.stubEnv("SMTP_HOST", "never-contacted.invalid");
    vi.stubEnv("SMTP_USER", "intercepted");
    vi.stubEnv("SMTP_PASS", "intercepted");
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail: sent,
    } as unknown as nodemailer.Transporter);
    booking = {
      id: 7,
      status: "paid",
      registrationSource: "checkout",
      quantity: 2,
      passType: "single",
      paymentMethod: "card",
      subtotalAmount: "378.00",
      vatAmount: "75.60",
      totalAmount: "453.60",
      groupDiscountAmount: "0",
      promoDiscountAmount: "0",
      orderReference: "SWP27-TEST",
      managementToken: "TEST-TOKEN",
    } as Booking;
    attendees = [
      {
        id: 1,
        bookingId: 7,
        isLead: true,
        isTbc: false,
        firstName: "Alex",
        lastName: "Morgan",
        company: "Example",
        jobTitle: "Director",
        workEmail: "alex@example.invalid",
      },
      {
        id: 2,
        bookingId: 7,
        isLead: false,
        isTbc: true,
        firstName: "TBC",
        lastName: "TBC",
        company: "Example",
        jobTitle: "TBC",
        workEmail: "internal@tbc.placeholder",
      },
    ] as Attendee[];
    vi.mocked(generateReceiptPdfForBooking).mockResolvedValue(
      Buffer.from("%PDF-1.4\nMock receipt\n%%EOF"),
    );
    vi.spyOn(db, "select").mockReturnValue({
      from: (table: unknown) => {
        const rows =
          new Map<unknown, unknown[]>([
            [bookingsTable, [booking]],
            [attendeesTable, attendees],
            [eventSettingsTable, [settings]],
            [sponsorsTable, [{ company: "Example Sponsor" }]],
          ]).get(table) ?? [];
        return Object.assign(Promise.resolve(rows), {
          where: (condition: { queryChunks?: unknown[] }) => {
            if (table !== emailTemplatesTable) return Promise.resolve(rows);
            const entry = Object.entries(approvedEmailTemplates).find(([type]) =>
              condition.queryChunks?.some(
                (chunk) =>
                  typeof chunk === "object" && chunk && "value" in chunk && chunk.value === type,
              ),
            );
            return Promise.resolve(entry ? [entry[1]] : []);
          },
        });
      },
    } as unknown as ReturnType<typeof db.select>);
    vi.spyOn(db, "insert").mockReturnValue({
      values: () => Promise.resolve([]),
    } as unknown as ReturnType<typeof db.insert>);
    vi.spyOn(db, "update").mockReturnValue({
      set: () => ({ where: () => Promise.resolve([]) }),
    } as unknown as ReturnType<typeof db.update>);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([sendConfirmationAndReceiptEmail, resendConfirmationAndReceipt])(
    "keeps receipt bytes and correct attachment copy in %s",
    async (send) => {
      await send(7);
      expect(sent).toHaveBeenCalledTimes(1);
      const message = sent.mock.calls[0][0];
      expect(message.to).toBe("alex@example.invalid");
      expect(message.html).toContain("Your receipt is attached");
      expect(message.html).toContain("receipt-SWP27-TEST.pdf");
      expect(message.text).toContain("453.60");
      expect(message.html.split(receptionInstructions)).toHaveLength(2);
      expect(message.text.split(receptionInstructions)).toHaveLength(2);
      expect(message.text.indexOf(receptionInstructions)).toBeGreaterThan(
        message.text.indexOf("EC2V 5DD"),
      );
      expect(
        message.attachments.filter((a: { contentType: string }) => a.contentType === "image/png"),
      ).toHaveLength(2);
      expect(Buffer.from(message.attachments[0].content, "base64").toString()).toContain(
        "Mock receipt",
      );
    },
  );
  it("shows sponsor staff how to collect their pass when there is no saved template", async () => {
    expect(await sendSponsorStaffWelcome(3, 7, 1)).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    const [message] = sent.mock.calls[0];
    expect(message.to).toBe("alex@example.invalid");
    expect(message.html).toContain("Example Sponsor");
    expect(message.html.split(receptionInstructions)).toHaveLength(2);
    expect(message.html.indexOf(receptionInstructions)).toBeGreaterThan(
      message.html.lastIndexOf(settings.eventVenue),
    );
    expect(message.html.indexOf(receptionInstructions)).toBeLessThan(
      message.html.indexOf("There is nothing to pay"),
    );
    expect(message.html).toContain("Badge scanning and sponsor leads");
    expect(message.attachments).toHaveLength(0);
  });
  it("remains truthful if generating the receipt fails", async () => {
    vi.mocked(generateReceiptPdfForBooking).mockRejectedValue(new Error("Fixture PDF failure"));
    await sendConfirmationAndReceiptEmail(7);
    expect(sent.mock.calls[0][0].text).not.toContain("is attached");
    expect(
      sent.mock.calls[0][0].attachments.every(
        (a: { contentType: string }) => a.contentType === "image/png",
      ),
    ).toBe(true);
  });
  it("sends one confirmation and one welcome for the named attendee, never a placeholder", async () => {
    await sendBookingEmails(7);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls.every(([message]) => message.to === "alex@example.invalid")).toBe(true);
    const welcome = sent.mock.calls[1][0];
    expect(welcome.html).toContain("See you in London");
    expect(welcome.text).not.toContain("£");
    expect(
      welcome.attachments.every((a: { contentType: string }) => a.contentType === "image/png"),
    ).toBe(true);
  });
  it("uses the new welcome subject and includes the badge privacy notice once", async () => {
    await sendWelcomeEmail(7, "Alex & Sam", "alex@example.invalid");
    const message = sent.mock.calls[0][0];
    expect(message.subject).toContain("Your visit to SWP Summit 2027");
    expect(message.html).toContain("Alex &amp; Sam");
    expect(message.text.match(/Badge scanning and sponsor leads/g)).toHaveLength(1);
    expect(message.text).toContain("Anyone with this link can view and update every attendee");
  });
  it("places the reissue notice inside the email and keeps invoice metadata and PDF", async () => {
    booking = {
      ...booking,
      status: "invoiced",
      paymentMethod: "invoice",
      billingEmail: "finance@example.invalid",
      poNumber: "PO-123",
    };
    await sendReissuedInvoiceEmail(7);
    const message = sent.mock.calls[0][0];
    expect(message.to).toBe("finance@example.invalid");
    expect(message.subject).toContain("Updated Invoice");
    expect(message.html.indexOf("Your invoice has been re-issued")).toBeGreaterThan(
      message.html.indexOf("<body"),
    );
    expect(message.html).toContain("invoice-SWP27-TEST.pdf");
    expect(message.text).toContain("PO-123");
    expect(message.text).toContain("PAYMENT DUE");
  });
});
