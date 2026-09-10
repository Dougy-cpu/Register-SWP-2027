import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BADGE_SCANNER_MAX_SCANS_PER_SECOND,
  BADGE_SCANNER_OPTIONS,
  BADGE_SCANNER_PROCESSING_SIZE,
  calculateBadgeScanRegion,
} from "./scanner-camera";
import { BADGE_CODE_LENGTH, BADGE_CODE_PATTERN, normaliseBadgeCode } from "./scanner-code";

describe("application-wide badge scanner contract", () => {
  it("accepts only a compact 12-character uppercase hexadecimal payload", () => {
    expect(BADGE_CODE_LENGTH).toBe(12);
    expect(BADGE_CODE_PATTERN.test("FACADE000001")).toBe(true);
    expect(normaliseBadgeCode(" facade000001 ")).toBe("FACADE000001");
    expect(normaliseBadgeCode("FACADE00001")).toBeNull();
    expect(normaliseBadgeCode("FACADE00000G")).toBeNull();
    expect(normaliseBadgeCode("https://example.com/FACADE000001")).toBeNull();
  });

  it("uses one high-resolution, quick camera configuration for real and test scans", () => {
    const region = calculateBadgeScanRegion({ videoWidth: 1920, videoHeight: 1080 });
    expect(region).toEqual({
      x: 539,
      y: 119,
      width: 842,
      height: 842,
      downScaledWidth: BADGE_SCANNER_PROCESSING_SIZE,
      downScaledHeight: BADGE_SCANNER_PROCESSING_SIZE,
    });
    expect(BADGE_SCANNER_MAX_SCANS_PER_SECOND).toBe(20);
    expect(BADGE_SCANNER_OPTIONS.calculateScanRegion).toBe(calculateBadgeScanRegion);
    expect(BADGE_SCANNER_OPTIONS.preferredCamera).toBe("environment");
  });

  it("uses the shared camera configuration in both real and public test scanners", async () => {
    const [realScanner, testScanner] = await Promise.all([
      readFile(resolve(process.cwd(), "artifacts/checkout/src/pages/sponsor/scanner.tsx"), "utf8"),
      readFile(resolve(process.cwd(), "artifacts/checkout/src/pages/scanner-test.tsx"), "utf8"),
    ]);
    for (const source of [realScanner, testScanner]) {
      expect(source).toContain('import { useBadgeCamera } from "@/hooks/use-badge-camera"');
      expect(source).toContain("<BadgeCameraView");
      expect(source).not.toContain("maxScansPerSecond:");
      // qr-scanner permanently collapses a video that is display:none when its
      // constructor runs. Keep the video rendered behind the inactive overlay
      // so an authorised mobile camera stream is actually visible.
      expect(source).not.toContain('cameraActive ? "block" : "hidden"');
    }
    const lifecycle = await readFile(
      resolve(process.cwd(), "artifacts/checkout/src/lib/badge-camera.ts"),
      "utf8",
    );
    expect(lifecycle).toContain("...BADGE_SCANNER_OPTIONS,");
  });

  it("does not upscale low-resolution camera frames", () => {
    const region = calculateBadgeScanRegion({ videoWidth: 320, videoHeight: 240 });
    expect(region.width).toBe(187);
    expect(region.downScaledWidth).toBe(187);
    expect(region.downScaledHeight).toBe(187);
  });
});
