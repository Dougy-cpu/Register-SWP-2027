import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findScannerTestBadge,
  normaliseScannerTestValue,
  SCANNER_TEST_BADGES,
  SCANNER_TEST_LINK_MATRIX,
  SCANNER_TEST_URL,
} from "./scanner-test-data";

describe("lead scanner public test kit", () => {
  it("uses four unique, clearly reserved synthetic badge references", () => {
    const codes = SCANNER_TEST_BADGES.map((badge) => badge.code);
    expect(codes).toHaveLength(4);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => /^FACADE[0-9]{6}$/.test(code))).toBe(true);
    expect(SCANNER_TEST_BADGES.every((badge) => badge.workEmail.endsWith(".invalid"))).toBe(true);
  });

  it("normalises only badge-shaped values and resolves only the synthetic set", () => {
    expect(normaliseScannerTestValue(" facade000001 ")).toBe("FACADE000001");
    expect(normaliseScannerTestValue("https://example.com/FACADE000001")).toBeNull();
    expect(findScannerTestBadge("facade000002")?.name).toBe("Priya Shah");
    expect(findScannerTestBadge("ABCDEF123456")).toBeNull();
  });

  it("contains square, binary QR matrices with a production scanner link", () => {
    expect(SCANNER_TEST_URL).toBe("https://register.swpsummit.com/scanner-test");
    expect(SCANNER_TEST_BADGES.every((badge) => badge.matrix.length === 21)).toBe(true);
    for (const matrix of [
      SCANNER_TEST_LINK_MATRIX,
      ...SCANNER_TEST_BADGES.map((badge) => badge.matrix),
    ]) {
      expect(matrix.every((row) => row.length === matrix.length && /^[01]+$/.test(row))).toBe(true);
    }
  });

  it("keeps the public device test isolated from APIs and scanner persistence", async () => {
    const source = await readFile(
      resolve(process.cwd(), "artifacts/checkout/src/pages/scanner-test.tsx"),
      "utf8",
    );
    expect(source).not.toContain("/api/");
    expect(source).not.toContain("scanner-api");
    expect(source).not.toContain("scanner-storage");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("indexedDB");
  });
});
