import type { EventSettings } from "@workspace/db";
import { approvedEmailImages, approvedEmailTemplates } from "./approved-email-design";
import { renderApprovedEmailSample } from "./approved-email-sample";
import nodemailer from "nodemailer";
import type StreamTransport from "nodemailer/lib/stream-transport";
import sharp from "sharp";
import { format } from "prettier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMail, wrapInBrandedLayout } from "./email";
import { prepareInlineEmailImages } from "./email-images";

const pixel = { r: 0, g: 78, b: 185, alpha: 0.5 };
const image = () => sharp({ create: { width: 4, height: 3, channels: 4, background: pixel } });
const dataUrl = (type: string, bytes: Buffer) =>
  `data:image/${type};base64,${bytes.toString("base64")}`;

// Inspect the real MIME bytes built by Nodemailer, with no SMTP transport or network delivery.
function leafParts(message: Buffer) {
  return message
    .toString()
    .split(/\r\n--[^\r\n]+\r\n/)
    .flatMap((part) => {
      const split = part.indexOf("\r\n\r\n");
      if (split < 0) return [];
      const headers = part.slice(0, split).replace(/\r\n\s+/g, " ");
      if (/^Content-Type: multipart\//im.test(headers)) return [];
      const body = part.slice(split + 4).trim();
      const content = /^Content-Transfer-Encoding: base64/im.test(headers)
        ? Buffer.from(body, "base64")
        : Buffer.from(
            body
              .replace(/=\r\n/g, "")
              .replace(/=([a-f0-9]{2})/gi, (_, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
            "binary",
          );
      return [{ headers, content }];
    });
}

function expectIntactOutlookConditionals(html: string) {
  // Outlook interprets these comments even though a browser preview ignores them.
  // A line break between <! and [endif] left the 4 November messages blank in Outlook.
  expect(html).not.toMatch(/<!\s+\[endif\]/i);
  const comments = html.match(/<!--\[if\b[\s\S]*?-->/gi) ?? [];
  expect(comments).toHaveLength(3);
  for (const comment of comments) {
    expect(comment).toMatch(/^<!--\[if [^\]\r\n]+\]>/);
    expect(comment).toMatch(/<!\[endif\]-->$/);
  }
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain("</xml><![endif]-->");
}

describe("email image delivery", () => {
  let transport: nodemailer.Transporter<StreamTransport.SentMessageInfo>;
  let messages: StreamTransport.SentMessageInfo[];

  beforeEach(() => {
    vi.stubEnv("SMTP_HOST", "unused.invalid");
    vi.stubEnv("SMTP_USER", "test");
    vi.stubEnv("SMTP_PASS", "test");
    transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    });
    const compile = transport.sendMail.bind(transport);
    messages = [];
    vi.spyOn(transport, "sendMail").mockImplementation(async (options) => {
      const result = await compile(options);
      messages.push(result);
      return result;
    });
    vi.spyOn(nodemailer, "createTransport").mockReturnValue(transport);
  });

  afterEach(() => {
    transport.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("converts a saved WebP logo into a related inline PNG, preserving PDF and calendar attachments", async () => {
    const webp = await image().webp({ lossless: true }).toBuffer();
    const html = wrapInBrandedLayout("<p>Registration confirmed.</p>", {
      orgName: "People Strategy Hub",
      logoDataUrl: dataUrl("webp", webp),
    });
    const pdf = Buffer.from("%PDF-1.4\nTest fixture\n%%EOF");
    const calendar = Buffer.from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n");

    expect(
      await sendMail({
        to: "attendee@example.invalid",
        fromEmail: "registration@example.invalid",
        subject: "Registration preview - not sent",
        html,
        attachments: [
          { filename: "receipt.pdf", content: pdf, contentType: "application/pdf" },
          { filename: "event.ics", content: calendar, contentType: "text/calendar" },
        ],
      }),
    ).toBe(true);

    expect(messages).toHaveLength(1);
    const raw = messages[0].message as Buffer;
    const parts = leafParts(raw);
    const htmlPart = parts.find((part) => /^Content-Type: text\/html/im.test(part.headers))!;
    const pngPart = parts.find((part) => /^Content-Type: image\/png/im.test(part.headers))!;
    const cid = /Content-ID: <([^>]+)>/i.exec(pngPart.headers)?.[1];
    expect(cid).toBeTruthy();
    expect(raw.toString()).toContain("multipart/related");
    expect(htmlPart.content.toString()).toContain(`src="cid:${cid}"`);
    expect(htmlPart.content.toString()).not.toContain("data:image");
    expect(pngPart.headers).toMatch(/Content-Disposition: inline/i);
    expect(pngPart.content.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await sharp(pngPart.content).raw().toBuffer()).toEqual(
      await sharp(webp).raw().toBuffer(),
    );
    for (const [type, content] of [
      ["application/pdf", pdf],
      ["text/calendar", calendar],
    ] as const) {
      const part = parts.find((candidate) => candidate.headers.includes(`Content-Type: ${type}`))!;
      expect(part.headers).toMatch(/Content-Disposition: attachment/i);
      expect(part.content).toEqual(content);
    }
    expect(html).toContain('src="data:image/webp;base64,');
  });

  it("keeps the text header and message intact when no logo is configured", async () => {
    const html = wrapInBrandedLayout("<p>Welcome.</p>", { eventName: "SWP Summit 2027" });
    expect(await sendMail({ to: "attendee@example.invalid", subject: "Preview", html })).toBe(true);
    const parts = leafParts(messages[0].message as Buffer);
    expect(parts).toHaveLength(1);
    expect(parts[0].content.toString()).toBe(html.trim());
    expect(parts[0].content.toString()).toContain("SWP Summit 2027");
  });

  it("uses safe alternative text instead of breaking delivery for a corrupt uploaded logo", async () => {
    const html = wrapInBrandedLayout("<p>Keep this confirmation.</p>", {
      orgName: "People & Strategy Hub",
      logoDataUrl: dataUrl("webp", Buffer.from("not an image")),
    });
    expect(await sendMail({ to: "attendee@example.invalid", subject: "Preview", html })).toBe(true);
    const deliveredHtml = leafParts(messages[0].message as Buffer)[0].content.toString();
    expect(deliveredHtml).toContain("People &amp; Strategy Hub");
    expect(deliveredHtml).toContain("Keep this confirmation.");
    expect(deliveredHtml).not.toContain("<img");
  });
  it.each(["confirmation", "welcome"] as const)(
    "builds the approved %s as complete HTML/text MIME with the exact two original PNGs",
    async (type) => {
      const settings = {
        eventName: "SWP Summit",
        eventDate: "Wednesday, 3 March 2027",
        eventVenue: "1 Basinghall Avenue, London",
        eventVenuePostcode: "EC2V 5DD",
      } as EventSettings;
      const designed = renderApprovedEmailSample({
        type,
        template: approvedEmailTemplates[type],
        settings,
      });
      const pdf = Buffer.from("%PDF-1.4\nFixture only\n%%EOF");
      expect(
        await sendMail({
          to: "preview@example.invalid",
          subject: designed.subject,
          html: designed.html,
          attachments:
            type === "confirmation"
              ? [{ filename: "receipt.pdf", content: pdf, contentType: "application/pdf" }]
              : [],
        }),
      ).toBe(true);
      const parts = leafParts(messages[0].message as Buffer);
      const html = parts
        .find((part) => /^Content-Type: text\/html/im.test(part.headers))!
        .content.toString();
      const text = parts
        .find((part) => /^Content-Type: text\/plain/im.test(part.headers))!
        .content.toString();
      const imageParts = parts.filter((part) => /^Content-Type: image\/png/im.test(part.headers));
      expect(imageParts).toHaveLength(2);
      expect(html.match(/src="cid:/g)).toHaveLength(3);
      expect(html).not.toContain("data:image");
      expectIntactOutlookConditionals(html);
      // Exercise the formatter too: it originally split the Office XML closing delimiter.
      expectIntactOutlookConditionals(await format(html, { parser: "html", printWidth: 100 }));
      expect(text).toContain("People Strategy Hub");
      expect(text).toContain("/manage/PREVIEW-ONLY-NOT-A-REAL-BOOKING");
      for (const original of approvedEmailImages(designed.html)) {
        const actual = imageParts.find((part) => part.headers.includes(`<${original.cid}>`))!;
        expect(actual).toBeDefined();
        expect(actual.headers).toMatch(/Content-Disposition: inline/i);
        expect(actual.content).toEqual(original.content);
      }
      const pdfParts = parts.filter((part) => /Content-Type: application\/pdf/i.test(part.headers));
      expect(pdfParts).toHaveLength(type === "confirmation" ? 1 : 0);
      if (type === "confirmation") expect(pdfParts[0].content).toEqual(pdf);
    },
  );
});

describe("embedded image preparation", () => {
  it.each(["png", "jpeg", "webp", "svg"] as const)(
    "accepts %s uploads and emits PNG bytes",
    async (format) => {
      const bytes =
        format === "svg"
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#004eb9"/></svg>',
            )
          : await image().toFormat(format).toBuffer();
      const html = await prepareInlineEmailImages(
        `<img alt='Logo' src='${dataUrl(format === "svg" ? "svg+xml" : format, bytes)}' width='96'>`,
      );
      const base64 = /src='data:image\/png;base64,([^']+)'/.exec(html)?.[1];
      expect(base64).toBeTruthy();
      const metadata = await sharp(Buffer.from(base64!, "base64")).metadata();
      expect(metadata).toMatchObject({ format: "png", width: 4, height: 3 });
      expect(html).toContain("width='96'");
    },
  );

  it("preserves separate embedded images, external images and the rest of the template", async () => {
    const logo = dataUrl("webp", await image().webp().toBuffer());
    const banner = dataUrl("jpeg", await image().jpeg().toBuffer());
    const external = '<img src="https://example.invalid/logo.png" alt="External">';
    const html = await prepareInlineEmailImages(
      `<p>Before</p><img src="${logo}"><p>Between</p>${external}<img src="${banner}"><p>After</p>`,
    );
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(html).toContain(external);
    expect(html).toContain("<p>Before</p>");
    expect(html).toContain("<p>Between</p>");
    expect(html).toContain("<p>After</p>");
  });

  it("bounds image dimensions and falls back safely for excessive pixel counts", async () => {
    const wide = await sharp({
      create: { width: 2000, height: 100, channels: 3, background: "white" },
    })
      .webp()
      .toBuffer();
    const html = await prepareInlineEmailImages(`<img src="${dataUrl("webp", wide)}">`);
    const bytes = Buffer.from(/base64,([^"]+)/.exec(html)![1], "base64");
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 1600, height: 80 });
    const huge = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"/>',
    );
    expect(
      await prepareInlineEmailImages(`<img alt="&lt;Logo&gt;" src="${dataUrl("svg+xml", huge)}">`),
    ).toBe("&lt;Logo&gt;");
  });
});
