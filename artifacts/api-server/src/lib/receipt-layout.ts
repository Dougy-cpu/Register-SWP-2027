import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

function asset(name: string): string {
  // esbuild puts this module in dist/index.mjs; tests run it from src/lib.
  const directories = [join(moduleDir, "assets/receipt"), join(moduleDir, "../assets/receipt")];
  const path = directories.map((directory) => join(directory, name)).find(existsSync);
  if (!path) throw new Error(`Receipt asset missing: ${name}`);
  return path;
}

export const receiptColours = {
  blue: "#004eb9",
  wash: "#f0f6ff",
  ink: "#111820",
  muted: "#4a5568",
  line: "#dce4ef",
};

export interface ReceiptPosition {
  page: number;
  y: number;
}

interface TextStyle {
  size?: number;
  font?: "Regular" | "SemiBold" | "ExtraBold";
  colour?: string;
  spacing?: number;
  align?: "left" | "right";
}

/** Measured text and explicit page breaks keep billing details out of price columns. */
export class ReceiptLayout {
  readonly left = 44;
  readonly right: number;
  readonly bottom = 779;
  readonly continuationTop = 116;
  private pageCount = 1;

  constructor(readonly doc: PDFKit.PDFDocument) {
    this.right = doc.page.width - this.left;
    for (const font of ["Regular", "SemiBold", "ExtraBold"] as const) {
      doc.registerFont(font, asset(`Figtree-${font}.ttf`));
    }
    this.decoratePage(0);
  }

  private selectStyle(style: TextStyle) {
    this.doc.font(style.font ?? "Regular").fontSize(style.size ?? 10.5);
    this.doc.fillColor(style.colour ?? receiptColours.ink);
  }

  text(value: string, x: number, top: number, style: TextStyle = {}) {
    this.selectStyle(style);
    const size = style.size ?? 10.5;
    const options = { characterSpacing: style.spacing ?? 0 };
    const width = this.doc.widthOfString(value, options);
    this.doc.text(value, style.align === "right" ? x - width : x, top + size * 0.82, {
      ...options,
      lineBreak: false,
      baseline: "alphabetic",
    });
  }

  label(value: string, x: number, top: number, align: "left" | "right" = "left") {
    this.text(value, x, top, {
      size: 8.4,
      font: "SemiBold",
      colour: receiptColours.blue,
      spacing: 0.8,
      align,
    });
  }

  rule(top: number, colour = receiptColours.line, width = 0.65) {
    this.doc
      .moveTo(this.left, top)
      .lineTo(this.right, top)
      .strokeColor(colour)
      .lineWidth(width)
      .stroke();
  }

  /** Currency and quantities always occupy one line, even for unusually large bookings. */
  number(value: string, right: number, top: number, width: number, style: TextStyle = {}) {
    this.selectStyle(style);
    const size = style.size ?? 10.5;
    const fittedSize = size * Math.min(1, width / Math.max(1, this.doc.widthOfString(value)));
    this.text(value, right, top, { ...style, size: fittedSize, align: "right" });
  }

  lines(value: string, width: number, style: TextStyle = {}): string[] {
    this.selectStyle(style);
    const lines: string[] = [];
    for (const paragraph of value.split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.trim().split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.doc.widthOfString(candidate) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = "";
        // Long email addresses, references and unbroken strings must not escape the column.
        for (const character of word) {
          if (line && this.doc.widthOfString(line + character) > width) {
            lines.push(line);
            line = "";
          }
          line += character;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  selectPage(page: number) {
    while (page >= this.pageCount) {
      this.doc.addPage();
      this.decoratePage(this.pageCount++);
    }
    this.doc.switchToPage(page);
  }

  nextPage(position: ReceiptPosition): ReceiptPosition {
    const next = { page: position.page + 1, y: this.continuationTop };
    this.selectPage(next.page);
    return next;
  }

  ensure(position: ReceiptPosition, height: number): ReceiptPosition {
    if (position.y + height > this.bottom) return this.nextPage(position);
    this.selectPage(position.page);
    return position;
  }

  paragraph(
    value: string,
    x: number,
    width: number,
    position: ReceiptPosition,
    style: TextStyle = {},
  ) {
    const lineHeight = (style.size ?? 10.5) * 1.35;
    let cursor = { ...position };
    for (const line of this.lines(value, width, style)) {
      cursor = this.ensure(cursor, lineHeight);
      this.text(line, style.align === "right" ? x + width : x, cursor.y, style);
      cursor.y += lineHeight;
    }
    return cursor;
  }

  private decoratePage(page: number) {
    const { doc, left, right } = this;
    doc.rect(0, 0, doc.page.width, 3.5).fill(receiptColours.blue);
    if (page === 0) {
      doc.image(asset("swp-summit.png"), left, 44, { width: 66 });
      doc.image(asset("people-strategy-hub.png"), right - 122, 50, { width: 122 });
      this.text("SWP Summit 2027", 134, 46, {
        size: 16,
        font: "ExtraBold",
        colour: receiptColours.blue,
      });
      this.text("Wednesday, 3 March 2027", 134, 72, { size: 9.7, colour: receiptColours.muted });
      this.text("1 Basinghall Avenue", 134, 90, { size: 9.7, colour: receiptColours.muted });
      this.text("London EC2V 5DD", 134, 105, { size: 9.7, colour: receiptColours.muted });
      this.rule(137, receiptColours.blue, 0.8);
    } else {
      doc.image(asset("swp-summit.png"), left, 28, { width: 48 });
      doc.image(asset("people-strategy-hub.png"), right - 100, 28, { width: 100 });
      this.text("VAT Receipt - continued", 108, 38, { size: 17, font: "ExtraBold" });
      this.text("SWP Summit 2027", 108, 64, { size: 10, colour: receiptColours.blue });
      this.rule(94, receiptColours.blue, 0.8);
    }
    this.rule(793);
    this.text("SWP Summit - 1 Basinghall Avenue, London EC2V 5DD", left, 805, {
      size: 8,
      colour: receiptColours.muted,
    });
    this.text("swpsummit.com", right, 805, {
      size: 8,
      font: "SemiBold",
      colour: receiptColours.blue,
      align: "right",
    });
    doc.link(right - 65, 803, 65, 14, "https://swpsummit.com");
    if (page > 0)
      this.text(`Page ${page + 1}`, right, 824, {
        size: 7,
        colour: receiptColours.muted,
        align: "right",
      });
  }
}
