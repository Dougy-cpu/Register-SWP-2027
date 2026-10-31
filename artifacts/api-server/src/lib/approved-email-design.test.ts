import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attendee, Booking, EventSettings } from "@workspace/db";
import { db } from "@workspace/db";
import {
  buildConfirmationEmailHtml,
  DEFAULT_INVOICE_HELP_CONTENT,
  renderInvoiceHelpHtml,
} from "./email";
import {
  approvedEmailImages,
  approvedEmailTemplates,
  confirmationDesignVars,
  emailBrowserPreview,
  emailPlainText,
  fillEmailTemplate,
  renderApprovedEmail,
  welcomeDesignVars,
} from "./approved-email-design";
import { renderApprovedEmailSample } from "./approved-email-sample";
import { planApprovedEmailUpgrade } from "./approved-email-upgrade";

const settings = {
  eventName: "SWP Summit",
  eventDate: "Wednesday, 3 March 2027",
  eventVenue: "1 Basinghall Avenue, London",
  eventVenuePostcode: "EC2V 5DD",
  eventTimezone: "Europe/London",
  eventStartAt: null,
  eventEndAt: null,
  socialEnabled: false,
} as EventSettings;
const lead = {
  id: 1,
  firstName: "Alex",
  lastName: "Morgan",
  company: "Example & Co",
  jobTitle: "L&D Director",
  workEmail: "alex@example.invalid",
  phone: "+44 7700 900123",
  isLead: true,
  isTbc: false,
} as Attendee;
const attendees = [
  lead,
  ...Array.from({ length: 4 }, (_, i) => ({
    ...lead,
    id: i + 2,
    isTbc: true,
    isLead: false,
    workEmail: `tbc-${i}@tbc.placeholder`,
  })),
];
const booking = {
  id: 1,
  orderReference: "SWP27-TEST",
  quantity: 5,
  passType: "single",
  status: "paid",
  registrationSource: "checkout",
  paymentMethod: "card",
  managementToken: "DEMONSTRATION-ONLY",
  subtotalAmount: "604.80",
  groupDiscountAmount: "189.00",
  promoDiscountAmount: "151.20",
  promoCode: "WELCOME20",
  vatAmount: "120.96",
  totalAmount: "725.76",
} as Booking;
const receipt = { filename: "receipt-SWP27-TEST.pdf", contentType: "application/pdf" };
function confirmation(overrides: Partial<Booking> = {}, people = attendees, documents = [receipt]) {
  return renderApprovedEmail(
    approvedEmailTemplates.confirmation,
    confirmationDesignVars({
      booking: { ...booking, ...overrides },
      attendees: people,
      lead: people[0],
      settings,
      documents,
      invoiceHelpHtml: renderInvoiceHelpHtml(DEFAULT_INVOICE_HELP_CONTENT),
    }),
    settings,
  );
}
afterEach(() => vi.restoreAllMocks());

describe("approved confirmation design", () => {
  it("preserves the complete paid booking while hiding internal placeholder addresses", () => {
    const result = confirmation();
    for (const detail of [
      "Alex Morgan",
      "L&D Director",
      "Example & Co",
      "alex@example.invalid",
      "+44 7700 900123",
      "4 attendee details to add",
      "1 named. 4 to follow.",
      "PAID IN FULL",
      "£725.76",
      "3 March 2027",
      "EC2V 5DD",
      "receipt-SWP27-TEST.pdf",
      "People Strategy Hub",
    ])
      expect(result.text).toContain(detail);
    expect(result.text).not.toContain("tbc.placeholder");
    expect(result.html).not.toMatch(/\{\{[a-zA-Z]/);
    expect(result.subject).toBe("Booking confirmed — SWP27-TEST — SWP Summit 2027");
    expect(result.html).not.toContain("design preview");
  });
  it("shows discounts once, before the already-discounted subtotal", () => {
    const { text } = confirmation();
    const amounts = ["£945.00", "−£189.00", "−£151.20", "£604.80", "£120.96"];
    for (let i = 0; i < amounts.length - 1; i++)
      expect(text.indexOf(amounts[i])).toBeLessThan(text.indexOf(amounts[i + 1]));
    expect(text).toContain("5 Workforce passes × £189.00");
    expect(text.match(/−£151.20/g)).toHaveLength(1);
  });
  it("gives a single fully named attendee an appropriate next action", () => {
    const { text } = confirmation(
      {
        quantity: 1,
        passType: "business",
        subtotalAmount: "499.00",
        totalAmount: "598.80",
        vatAmount: "99.80",
        groupDiscountAmount: "0",
        promoDiscountAmount: "0",
      },
      [lead],
    );
    expect(text).toContain("1 Business pass");
    expect(text).toContain("is confirmed");
    expect(text).toContain("1 attendee confirmed");
    expect(text).toContain("Manage booking details");
    expect(text).not.toContain("details to add");
  });
  it("preserves unpaid invoice, PO, deadline, procurement and billing information", () => {
    const { text } = confirmation(
      {
        status: "invoiced",
        paymentMethod: "invoice",
        billingEmail: "finance@example.invalid",
        poNumber: "PO-123",
        invoiceDueDate: new Date("2026-11-13T12:00:00Z"),
        stripeInvoicePaymentUrl: "https://invoice.stripe.com/i/test",
      },
      attendees,
      [
        { ...receipt, filename: "invoice-SWP27-TEST.pdf" },
        { ...receipt, filename: "DBL-company-information.pdf" },
      ],
    );
    for (const detail of [
      "PAYMENT DUE",
      "Total due",
      "finance@example.invalid",
      "PO-123",
      "13 November 2026",
      "Pay invoice online",
      "https://invoice.stripe.com/i/test",
      "/manage/billing#DEMONSTRATION-ONLY",
      "automatically re-issue",
      "bank transfer",
      "remittance",
      "one working day",
      "Company information is attached",
      "Your invoice is attached",
    ])
      expect(text).toContain(detail);
    expect(text).not.toContain("PAID IN FULL");
    expect(text).not.toContain("Your receipt is attached");
  });
  it("does not ask an already-paid invoice customer to pay again", () => {
    const { text } = confirmation({
      paymentMethod: "invoice",
      stripeInvoicePaymentUrl: "https://invoice.stripe.com/i/test",
    });
    expect(text).toContain("INVOICE PAID");
    expect(text).not.toContain("Pay invoice online");
    expect(text).not.toContain("Payment due:");
  });
  it("labels a free manual registration correctly", () => {
    const { text } = confirmation({
      registrationSource: "manual",
      manualEntry: true,
      subtotalAmount: "0",
      totalAmount: "0",
      vatAmount: "0",
      groupDiscountAmount: "0",
      promoDiscountAmount: "0",
    });
    expect(text).toContain("COMPLIMENTARY");
    expect(text).not.toContain("PAID IN FULL");
    expect(text).not.toContain("Total paid");
  });
  it("does not add invoice or receipt language to sponsor-staff content", () => {
    const { text } = confirmation({
      registrationSource: "sponsor_staff",
      subtotalAmount: "0",
      totalAmount: "0",
      vatAmount: "0",
      paymentMethod: "invoice",
    });
    expect(text).toContain("Sponsor staff");
    expect(text).not.toContain("PAYMENT SUMMARY");
    expect(text).not.toMatch(/receipt|invoice|billing/i);
  });
  it("never promises a missing PDF attachment", () => {
    expect(confirmation({}, attendees, []).text).not.toContain("is attached");
    expect(confirmation({ status: "invoiced", paymentMethod: "invoice" }).text).toContain(
      "Your booking summary is attached",
    );
  });
  it("keeps unnamed places recoverable without a management token", () => {
    const { text } = confirmation({ managementToken: null });
    expect(text).toContain("4 attendee details to add");
    expect(text).toContain("douglas@peoplestrategyhub.com");
    expect(text).not.toContain("/manage/");
  });
  it("keeps separate company groups and every named person's contact details", () => {
    const people = [
      lead,
      {
        ...lead,
        isLead: false,
        firstName: "Sam",
        workEmail: "sam@example.invalid",
        company: "Other Company",
      },
      { ...lead, isLead: false, isTbc: true },
      { ...lead, isLead: false, isTbc: true, company: "Other Company" },
    ];
    const { text } = confirmation({ quantity: 4 }, people);
    expect(text).toContain("2 named. 2 to follow.");
    expect(text).toContain("sam@example.invalid");
    expect(text).toContain("Other Company · Attendee details to be confirmed");
    expect(text).toContain("Example & Co · Attendee details to be confirmed");
  });
  it("escapes attendee, company, promo and booking reference fields without recursive substitution", () => {
    const malicious = {
      ...lead,
      firstName: '<img src=x onerror="alert(1)"> {{orderReference}}',
      company: "<script>bad</script>",
    };
    const { html } = confirmation(
      { quantity: 1, orderReference: "REF<&", promoCode: "<b>BAD</b>" },
      [malicious],
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;BAD&lt;/b&gt;");
    expect(html).toContain("{{orderReference}}");
  });
  it("uses compact email-safe markup with three logo references and only two small image parts", () => {
    const { html } = confirmation();
    expect(Buffer.byteLength(html)).toBeLessThan(25000);
    expect(html).not.toMatch(/display:\s*(flex|grid)|<script|data:image|\.webp/i);
    expect(html.match(/src="cid:/g)).toHaveLength(3);
    const images = approvedEmailImages(html);
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.content.length).sort((a, b) => a - b)).toEqual([
      9000, 18635,
    ]);
    expect(html.match(/width="84"\s+height="84"/g)).toHaveLength(3);
    expect(emailBrowserPreview(html)).not.toContain('src="cid:');
  });
});

describe("approved welcome design", () => {
  function welcome(overrides: Partial<Booking> = {}, token = booking.managementToken) {
    return renderApprovedEmail(
      approvedEmailTemplates.welcome,
      welcomeDesignVars({
        firstName: "Alex",
        settings,
        booking: { ...booking, ...overrides, managementToken: token },
      }),
      settings,
    );
  }
  it("preserves programme, arrival, support and badge privacy information without financial or group details", () => {
    const { text, html } = welcome();
    for (const detail of [
      "08:30",
      "09:00",
      "3 March 2027",
      "Basinghall",
      "EC2V 5DD",
      "keynotes",
      "breakout",
      "AI in HR",
      "Happy Hour",
      "food and drink",
      "Manage booking details",
      "anyone",
      "every attendee",
      "QR itself contains only an attendee reference",
      "Scanning is optional",
    ])
      expect(text.toLowerCase()).toContain(detail.toLowerCase());
    expect(text).not.toContain("alex@example.invalid");
    expect(text).not.toContain("£");
    expect(text).not.toContain("conference pass and receipt are included");
    expect(text.match(/Badge scanning and sponsor leads/g)).toHaveLength(1);
    expect(html).not.toMatch(/\{\{[a-zA-Z]/);
    expect(text).not.toContain("calendar.google");
  });
  it("does not promise a receipt to sponsor staff and still has a next action without a booking link", () => {
    const { text } = welcome({ registrationSource: "sponsor_staff" }, null);
    expect(text).toContain("sponsor staff confirmation");
    expect(text).not.toContain("receipt");
    expect(text).toContain("dietary or accessibility requirements, contact");
  });
  it("uses the same renderer in admin previews and embeds browser-only logo data", () => {
    const sample = renderApprovedEmailSample({
      type: "welcome",
      template: approvedEmailTemplates.welcome,
      settings,
      toName: "Test Name",
    });
    expect(sample.text).toContain("Test.");
    expect(sample.html).toContain('src="cid:');
    expect(emailBrowserPreview(sample.html)).toContain('src="data:image/png;base64,');
    expect(sample.text).not.toContain("is attached");
  });
});

describe("production renderer and safe template rollout", () => {
  function mockTemplate(template: typeof approvedEmailTemplates.confirmation | null) {
    vi.spyOn(db, "select").mockReturnValue({
      from: () => ({ where: async () => (template ? [template] : []) }),
    } as unknown as ReturnType<typeof db.select>);
  }
  it("renders the stored approved template with actual confirmed attachment metadata", async () => {
    mockTemplate(approvedEmailTemplates.confirmation);
    const result = await buildConfirmationEmailHtml(booking, attendees, lead, settings, [receipt]);
    expect(result.html).toContain("receipt-SWP27-TEST.pdf");
    expect(result.html).toContain("4 attendee details to add");
    expect(result.html).not.toContain("tbc.placeholder");
    expect(result.html).toContain("cid:psh-transactional-v2");
  });
  it("preserves unrelated custom templates", async () => {
    mockTemplate({
      subject: "Our custom subject",
      htmlBody: "<h2>A personal note for {{firstName}}</h2>{{priceSummary}}",
    });
    const result = await buildConfirmationEmailHtml(booking, attendees, lead, settings);
    expect(result.subject).toBe("Our custom subject");
    expect(result.html).toContain("A personal note for Alex");
    expect(result.html).not.toContain("See you in London");
  });
  it("uses the approved default when no confirmation template is stored", async () => {
    mockTemplate(null);
    expect((await buildConfirmationEmailHtml(booking, attendees, lead, settings)).html).toContain(
      "swp-transactional-v2",
    );
  });
  it("is idempotent after both reviewed templates have been installed", () => {
    expect(
      planApprovedEmailUpgrade(
        Object.entries(approvedEmailTemplates).map(([type, template], id) => ({
          id,
          type,
          ...template,
        })),
      ),
    ).toEqual([]);
  });
  it("refuses missing or edited templates rather than overwriting admin changes", () => {
    expect(() => planApprovedEmailUpgrade([])).toThrow("missing");
    expect(() =>
      planApprovedEmailUpgrade([
        {
          id: 1,
          type: "confirmation",
          subject: "Edited subject",
          htmlBody: "<p>New custom copy</p>",
        },
      ]),
    ).toThrow("differs from the reviewed version");
  });
  it("produces readable text with usable URLs and Unicode without treating escaped values as markup", () => {
    const text = emailPlainText(
      '<style>hide me</style><p>A &amp; B &pound;20</p><a href="https://example.invalid?a=1&amp;b=2">Manage</a><p>&lt;script&gt;</p>',
    );
    expect(text).toContain("A & B £20");
    expect(text).toContain("Manage (https://example.invalid?a=1&b=2)");
    expect(text).toContain("<script>");
    expect(text).not.toContain("hide me");
    expect(
      fillEmailTemplate("{{firstName}} {{orderReference}}", {
        "{{firstName}}": "{{orderReference}}",
        "{{orderReference}}": "REF",
      }),
    ).toBe("{{orderReference}} REF");
  });
});
