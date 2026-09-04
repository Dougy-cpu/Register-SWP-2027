import { describe, expect, it } from "vitest";
import {
  BADGE_CODE_PATTERN,
  badgeExportCsv,
  generateBadgeCode,
  normaliseBadgeCode,
  offlineRecordLookup,
  SCANNER_TEST_CODE,
  scannerDeviceRateLimitKey,
} from "./lead-scanner";

describe("lead scanner badge references", () => {
  it("accepts only the exact 12-character hexadecimal payload shape", () => {
    expect(normaliseBadgeCode("cc4ffd33219d")).toBe("CC4FFD33219D");
    expect(normaliseBadgeCode(" CC4FFD33219D ")).toBe("CC4FFD33219D");
    expect(normaliseBadgeCode("CC4FFD33219")).toBeNull();
    expect(normaliseBadgeCode("CC4FFD33219G")).toBeNull();
    expect(normaliseBadgeCode("https://example.com/CC4FFD33219D")).toBeNull();
    expect(normaliseBadgeCode(null)).toBeNull();
  });

  it("generates converter-ready references without allocating the readiness-test value", () => {
    const references = Array.from({ length: 2_000 }, () => generateBadgeCode());
    expect(references.every((value) => BADGE_CODE_PATTERN.test(value))).toBe(true);
    expect(references.every((value) => /^[A-F]/.test(value))).toBe(true);
    expect(references).not.toContain(SCANNER_TEST_CODE);
    expect(new Set(references).size).toBe(references.length);
  });

  it("uses a separate authenticated rate-limit key for every scanner phone", () => {
    const keys = Array.from({ length: 150 }, (_, index) =>
      scannerDeviceRateLimitKey(`device-${index + 1}`),
    );
    expect(new Set(keys).size).toBe(150);
    expect(keys.every((key) => key.startsWith("scanner:device-"))).toBe(true);
  });

  it("does not expose badge references in the downloadable record index", () => {
    const first = offlineRecordLookup("pack-a", "CC4FFD33219D");
    expect(first).not.toContain("CC4FFD33219D");
    expect(first).not.toBe(offlineRecordLookup("pack-a", "CC4FFD33219E"));
    expect(first).not.toBe(offlineRecordLookup("pack-b", "CC4FFD33219D"));
  });

  it("exports exactly the five requested badge CSV columns", () => {
    const csv = badgeExportCsv([
      {
        attendeeId: 1,
        firstName: "Cinzia",
        lastName: "Dalé",
        jobTitle: "Payroll Manager",
        company: "IDEXX",
        qrCode: "CC4FFD33219D",
        badgeVersion: 1,
      },
    ]);
    expect(csv).toBe(
      '"First Name","Last Name","Job Title","Company","QR Code"\r\n' +
        '"Cinzia","Dalé","Payroll Manager","IDEXX","CC4FFD33219D"',
    );
  });
});
