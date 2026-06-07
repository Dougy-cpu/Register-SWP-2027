import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const checkoutRoot = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return readFileSync(path.join(checkoutRoot, relativePath), "utf8");
}

describe("checkout visual guardrails", () => {
  it("does not use the legacy HR Analytics orange treatment", () => {
    const source = [
      read("index.css"),
      read("pages/checkout/Step1Lead.tsx"),
      read("pages/checkout/Step2Passes.tsx"),
      read("pages/checkout/Step3Attendees.tsx"),
      read("pages/checkout/Step4Payment.tsx"),
    ].join("\n");

    expect(source).not.toMatch(/#E74F3E|rgba\(231,\s*79,\s*62/i);
  });

  it("uses the shared premium card and primary CTA treatments on Steps 1-3", () => {
    for (const file of [
      "pages/checkout/Step1Lead.tsx",
      "pages/checkout/Step2Passes.tsx",
      "pages/checkout/Step3Attendees.tsx",
    ]) {
      const source = read(file);
      expect(source, file).toContain("swp-card");
      expect(source, file).toContain("swp-primary-btn");
    }
  });
});
