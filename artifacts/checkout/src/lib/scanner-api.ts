import type {
  PendingAnnotation,
  PendingScan,
  ScannerBootstrap,
  ScannerCredential,
  ScannerOfflinePackDownload,
} from "@/types/lead-scanner";
import { applySyncResults, getScannerCredential, pendingScannerItems } from "./scanner-storage";

export class ScannerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function scannerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const credential = await getScannerCredential();
  if (!credential) throw new ScannerApiError("This phone has not been activated", 401);
  return fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function scannerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await scannerFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ScannerApiError(
      body.error ?? "The scanner request could not be completed",
      response.status,
    );
  }
  return body as T;
}

export function getScannerBootstrap(): Promise<ScannerBootstrap> {
  return scannerJson<ScannerBootstrap>("/api/scanner/bootstrap");
}

export function downloadOfflinePack(): Promise<ScannerOfflinePackDownload> {
  return scannerJson<ScannerOfflinePackDownload>("/api/scanner/offline-pack");
}

export async function updateReadiness(
  values: Partial<{
    packVersion: string;
    cameraTested: boolean;
    qrTested: boolean;
    storageTested: boolean;
    offlineTested: boolean;
    syncTested: boolean;
  }>,
): Promise<void> {
  await scannerJson("/api/scanner/readiness", {
    method: "PATCH",
    body: JSON.stringify(values),
  });
}

interface SyncResponse {
  scans: Array<{ id: string; status: "accepted" | "duplicate" | "rejected"; reason?: string }>;
  annotations: Array<{
    id: string;
    status: "accepted" | "duplicate" | "rejected";
    reason?: string;
  }>;
  syncedAt: string;
}

function syncPayload(scans: PendingScan[], annotations: PendingAnnotation[]) {
  return {
    scans: scans.map(({ attendee: _attendee, ...scan }) => scan),
    annotations,
  };
}

let activeSync: Promise<{ remaining: number; rejected: number }> | null = null;

export async function syncPendingScannerItems(): Promise<{ remaining: number; rejected: number }> {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    let rejected = 0;
    for (let batch = 0; batch < 20; batch += 1) {
      const pending = await pendingScannerItems();
      const scans = pending.scans.slice(0, 100);
      const allPendingScanIds = new Set(pending.scans.map((scan) => scan.id));
      const sentScanIds = new Set(scans.map((scan) => scan.id));
      const annotations = pending.annotations
        .filter(
          (annotation) =>
            !allPendingScanIds.has(annotation.scanId) || sentScanIds.has(annotation.scanId),
        )
        .slice(0, 100);
      if (!scans.length && !annotations.length) return { remaining: 0, rejected };
      const result = await scannerJson<SyncResponse>("/api/scanner/sync", {
        method: "POST",
        body: JSON.stringify(syncPayload(scans, annotations)),
      });
      await applySyncResults({ scanResults: result.scans, annotationResults: result.annotations });
      rejected +=
        result.scans.filter((item) => item.status === "rejected").length +
        result.annotations.filter((item) => item.status === "rejected").length;
      if (!result.scans.length && !result.annotations.length) break;
    }
    const remainingItems = await pendingScannerItems();
    return {
      remaining: remainingItems.scans.length + remainingItems.annotations.length,
      rejected,
    };
  })().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

export async function activateScanner(operatorName: string): Promise<ScannerCredential> {
  const response = await fetch("/api/sponsor/scanner/devices", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-sponsor-csrf": sponsorCsrfCookie() },
    body: JSON.stringify({ operatorName }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ScannerApiError(body.error ?? "This phone could not be activated", response.status);
  return {
    id: body.id,
    token: body.token,
    operatorName: body.operatorName,
    sponsorId: body.sponsorId,
    sponsorCompany: body.sponsorCompany,
    activatedAt: new Date().toISOString(),
  };
}

function sponsorCsrfCookie(): string {
  const match = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("swp_sponsor_csrf="));
  return match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
}
