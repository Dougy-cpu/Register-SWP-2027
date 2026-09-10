import type QrScanner from "qr-scanner";

export const BADGE_SCANNER_MAX_SCANS_PER_SECOND = 20;
export const BADGE_SCANNER_REGION_RATIO = 0.78;
export const BADGE_SCANNER_PROCESSING_SIZE = 640;

type VideoDimensions = Pick<HTMLVideoElement, "videoWidth" | "videoHeight">;

export function calculateBadgeScanRegion(video: VideoDimensions): QrScanner.ScanRegion {
  const shortestSide = Math.max(1, Math.min(video.videoWidth, video.videoHeight));
  const regionSize = Math.max(1, Math.round(shortestSide * BADGE_SCANNER_REGION_RATIO));
  const processingSize = Math.min(regionSize, BADGE_SCANNER_PROCESSING_SIZE);

  return {
    x: Math.round((video.videoWidth - regionSize) / 2),
    y: Math.round((video.videoHeight - regionSize) / 2),
    width: regionSize,
    height: regionSize,
    downScaledWidth: processingSize,
    downScaledHeight: processingSize,
  };
}

export const BADGE_SCANNER_OPTIONS = {
  preferredCamera: "environment" as const,
  calculateScanRegion: calculateBadgeScanRegion,
  highlightScanRegion: true,
  highlightCodeOutline: true,
  maxScansPerSecond: BADGE_SCANNER_MAX_SCANS_PER_SECOND,
  returnDetailedScanResult: true as const,
};
