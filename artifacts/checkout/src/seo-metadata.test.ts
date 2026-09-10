import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(checkoutRoot, "index.html"), "utf8");
const socialImage = readFileSync(resolve(checkoutRoot, "public/opengraph.png"));

function metadata(name: string): string | null {
  const match = html.match(
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
  );
  return match?.[1] ?? null;
}

describe("public registration metadata", () => {
  it("keeps the app out of search results while allowing crawlers to follow shared links", () => {
    expect(metadata("robots")).toBe("noindex,follow");
  });

  it("uses complete absolute canonical and social metadata", () => {
    expect(html).toContain('<link rel="canonical" href="https://register.swpsummit.com/" />');
    expect(metadata("og:url")).toBe("https://register.swpsummit.com/");
    expect(metadata("og:image")).toBe("https://register.swpsummit.com/opengraph.png");
    expect(metadata("og:image:width")).toBe("1200");
    expect(metadata("og:image:height")).toBe("630");
    expect(metadata("og:locale")).toBe("en_GB");
    expect(metadata("twitter:card")).toBe("summary_large_image");
    expect(metadata("twitter:image")).toBe("https://register.swpsummit.com/opengraph.png");
  });

  it("ships a 1200 by 630 PNG sharing image", () => {
    expect(socialImage.toString("ascii", 1, 4)).toBe("PNG");
    expect(socialImage.readUInt32BE(16)).toBe(1200);
    expect(socialImage.readUInt32BE(20)).toBe(630);
  });
});
