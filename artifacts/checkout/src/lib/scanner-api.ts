import type {
  PendingAnnotation,
  PendingScan,
  ScannerBootstrap,
  ScannerCredential,
  ScannerOfflinePackDownload,
  SponsorLead,
  LeadPackAttendee,
} from "@/types/lead-scanner";
import {
  applySyncResults,
  getScannerCredential,
  pendingScannerItems,
  scannerScope,
  writeScannerValue,
  saveScannerCredential,
  cacheScannerLeads,
} from "./scanner-storage";

export class ScannerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}
export function boundedSignal(ms = 8000): AbortSignal {
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
export async function scannerFetch(
  path: string,
  init: RequestInit = {},
  explicit?: ScannerCredential,
): Promise<Response> {
  const credential = explicit ?? (await getScannerCredential());
  if (!credential)
    throw new ScannerApiError("Open your scanner link to get started", 401, "invalid_device");
  return fetch(path, {
    ...init,
    signal: init.signal ?? boundedSignal(),
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
export async function scannerJson<T>(
  path: string,
  init?: RequestInit,
  credential?: ScannerCredential,
): Promise<T> {
  const response = await scannerFetch(path, init, credential);
  const body = await response.json();
  if (!response.ok) {
    const error = new ScannerApiError(
      body.error ?? "We couldn't connect. Your saved work is safe.",
      response.status,
      body.code,
    );
    if (response.status === 401) {
      const saved = credential ?? (await getScannerCredential());
      if (saved) await writeScannerValue("access-error", body.code ?? "invalid_device", saved);
      window.dispatchEvent(new CustomEvent("swp:scanner-access", { detail: error }));
    }
    throw error;
  }
  return body as T;
}
export async function getScannerBootstrap(): Promise<ScannerBootstrap> {
  const credential = await getScannerCredential();
  if (!credential) throw new ScannerApiError("Open your scanner link", 401);
  const data = await scannerJson<ScannerBootstrap>("/api/scanner/bootstrap", undefined, credential);
  if (data.device.id !== credential.id || data.device.sponsorId !== credential.sponsorId)
    throw new Error("This scanner belongs to another sponsor.");
  await writeScannerValue("bootstrap", data, credential);
  await writeScannerValue("access-error", null, credential);
  return data;
}
export function downloadOfflinePack(): Promise<ScannerOfflinePackDownload> {
  return scannerJson<ScannerOfflinePackDownload>("/api/scanner/offline-pack");
}
export async function lookupScannerBadge(code: string): Promise<LeadPackAttendee> {
  return scannerJson("/api/scanner/lookup", {
    method: "POST",
    signal: boundedSignal(2500),
    body: JSON.stringify({ code }),
  });
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
  await scannerJson("/api/scanner/readiness", { method: "PATCH", body: JSON.stringify(values) });
}
interface SyncResponse {
  scans: Array<{
    id: string;
    status: "accepted" | "duplicate" | "rejected" | "deferred";
    reason?: string;
  }>;
  annotations: Array<{
    id: string;
    status: "accepted" | "duplicate" | "rejected" | "deferred";
    reason?: string;
  }>;
  syncedAt: string;
  leads?: SponsorLead[];
}
function syncPayload(scans: PendingScan[], annotations: PendingAnnotation[]) {
  return {
    scans: scans.map(({ id, code, source, capturedAt }) => ({ id, code, source, capturedAt })),
    annotations: annotations.map(({ id, scanId, note, rating, createdAt }) => ({
      id,
      scanId,
      note,
      rating,
      createdAt,
    })),
  };
}
const activeSync = new Map<string, Promise<{ remaining: number; rejected: number }>>();
export async function syncPendingScannerItems(): Promise<{ remaining: number; rejected: number }> {
  const credential = await getScannerCredential();
  if (!credential) return { remaining: 0, rejected: 0 };
  const scope = scannerScope(credential),
    syncKey = `${scope}:${credential.token}`;
  const running = activeSync.get(syncKey);
  if (running) return running;
  const promise = (async () => {
    let rejected = 0;
    for (let batch = 0; batch < 20; batch++) {
      const active = await getScannerCredential();
      if (!active || scannerScope(active) !== scope || active.token !== credential.token) break;
      const pending = await pendingScannerItems(credential),
        scans = pending.scans.slice(0, 100);
      const waiting = new Set(pending.scans.map((scan) => scan.id)),
        sending = new Set(scans.map((scan) => scan.id));
      const annotations = pending.annotations
        .filter((item) => !waiting.has(item.scanId) || sending.has(item.scanId))
        .slice(0, 100);
      if (!scans.length && !annotations.length) return { remaining: 0, rejected };
      const result = await scannerJson<SyncResponse>(
        "/api/scanner/sync",
        { method: "POST", body: JSON.stringify(syncPayload(scans, annotations)) },
        credential,
      );
      // Compatibility with an older deployment during a rolling update.
      const leads =
        result.leads ??
        (await scannerJson<{ leads: SponsorLead[] }>("/api/scanner/leads", undefined, credential))
          .leads;
      await applySyncResults({
        credential,
        leads,
        sentAnnotations: annotations,
        scanResults: result.scans,
        annotationResults: result.annotations,
      });
      rejected += [...result.scans, ...result.annotations].filter(
        (item) => item.status === "rejected",
      ).length;
      if (![...result.scans, ...result.annotations].some((item) => item.status !== "deferred"))
        break;
    }
    const pending = await pendingScannerItems(credential);
    return { remaining: pending.scans.length + pending.annotations.length, rejected };
  })().finally(() => activeSync.delete(syncKey));
  activeSync.set(syncKey, promise);
  return promise;
}
export async function refreshScannerLeads(credential: ScannerCredential): Promise<SponsorLead[]> {
  const result = await scannerJson<{ leads: SponsorLead[] }>(
    "/api/scanner/leads",
    undefined,
    credential,
  );
  await cacheScannerLeads(result.leads, credential);
  return result.leads;
}
async function sponsorDeviceRequest(path: string, body: unknown): Promise<ScannerCredential> {
  const response = await fetch(path, {
    method: "POST",
    signal: boundedSignal(),
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-sponsor-csrf": sponsorCsrfCookie() },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ScannerApiError(
      data.error ?? "Your scanner could not be activated",
      response.status,
      data.code,
    );
  return {
    id: data.id,
    token: data.token,
    operatorName: data.operatorName,
    sponsorId: data.sponsorId,
    sponsorCompany: data.sponsorCompany,
    activatedAt: new Date().toISOString(),
  };
}
export const activateScanner = (operatorName: string) =>
  sponsorDeviceRequest("/api/sponsor/scanner/devices", { operatorName });
export async function recoverScanner(credential: ScannerCredential): Promise<ScannerCredential> {
  const renewed = await sponsorDeviceRequest(
    `/api/sponsor/scanner/devices/${encodeURIComponent(credential.id)}/recover`,
    { token: credential.token },
  );
  if (scannerScope(renewed) !== scannerScope(credential))
    throw new Error("Recovery does not match this phone. Saved leads have not moved.");
  await saveScannerCredential(renewed);
  await writeScannerValue("access-error", null, renewed);
  return renewed;
}
export async function importScannerLink(token: string): Promise<ScannerCredential> {
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token))
    throw new Error("This scanner link is incomplete. Ask your organiser for a new one.");
  const provisional: ScannerCredential = {
    id: "",
    token,
    operatorName: "",
    sponsorId: 0,
    sponsorCompany: "",
    activatedAt: new Date().toISOString(),
  };
  // Read using the link before selecting local storage: never store unverified ownership.
  const response = await scannerFetch("/api/scanner/bootstrap", {}, provisional),
    data = await response.json();
  if (!response.ok)
    throw new ScannerApiError(
      data.error ?? "Ask your organiser for a new scanner link",
      response.status,
      data.code,
    );
  const device = (data as ScannerBootstrap).device;
  const credential = {
    ...provisional,
    id: device.id,
    sponsorId: device.sponsorId,
    sponsorCompany: device.sponsorCompany,
    operatorName: device.operatorName,
  };
  const current = await getScannerCredential();
  if (
    current &&
    scannerScope(current) !== scannerScope(credential) &&
    !window.confirm(
      `Open ${credential.sponsorCompany}'s scanner for ${credential.operatorName}? Any saved work for ${current.sponsorCompany} stays on this phone and is not transferred.`,
    )
  )
    throw new Error("Scanner switch cancelled. Your original saved work is unchanged.");
  await saveScannerCredential(credential);
  await writeScannerValue("bootstrap", data, credential);
  await writeScannerValue("access-error", null, credential);
  return credential;
}
function sponsorCsrfCookie(): string {
  const match = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("swp_sponsor_csrf="));
  return match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
}
