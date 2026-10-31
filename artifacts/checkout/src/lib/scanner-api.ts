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
  approvedProfiles,
  approvedProfileForToken,
  getScannerCredential,
  pendingScannerItems,
  scannerScope,
  writeScannerValue,
  saveScannerCredential,
  cacheScannerLeads,
  readScannerValue,
} from "./scanner-storage";
import { recordScannerContact, scannerRetryDue } from "./scanner-connection";

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
  try {
    return await fetch(path, {
      ...init,
      signal: init.signal ?? boundedSignal(),
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (error) {
    recordScannerContact(false);
    throw error;
  }
}
export async function scannerJson<T>(
  path: string,
  init?: RequestInit,
  credential?: ScannerCredential,
): Promise<T> {
  const response = await scannerFetch(path, init, credential);
  let body;
  try {
    body = await response.json();
  } catch {
    recordScannerContact(false);
    throw new TypeError(
      "Network response could not be read. Your saved work remains on this phone.",
    );
  }
  if (!body || typeof body !== "object") {
    recordScannerContact(false);
    throw new TypeError("Network response was incomplete. Your saved work remains on this phone.");
  }
  recordScannerContact(response.status < 500 && response.status !== 429);
  if (!response.ok) {
    const error = new ScannerApiError(
      body.error ?? "We couldn't connect. Your saved work is safe.",
      response.status,
      body.code,
    );
    if (response.status === 401) {
      const saved = credential ?? (await getScannerCredential());
      if (saved) await writeScannerValue("access-error", body.code ?? "invalid_device", saved);
      const active = await getScannerCredential();
      if (active?.id === saved?.id && active?.token === saved?.token)
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
export function downloadOfflinePack(
  credential?: ScannerCredential,
): Promise<ScannerOfflinePackDownload> {
  return scannerJson<ScannerOfflinePackDownload>(
    "/api/scanner/offline-pack",
    undefined,
    credential,
  );
}
export async function lookupScannerBadge(
  code: string,
  credential?: ScannerCredential,
): Promise<LeadPackAttendee> {
  return scannerJson(
    "/api/scanner/lookup",
    {
      method: "POST",
      signal: boundedSignal(2500),
      body: JSON.stringify({ code }),
    },
    credential,
  );
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
  credential?: ScannerCredential,
): Promise<void> {
  await scannerJson(
    "/api/scanner/readiness",
    { method: "PATCH", body: JSON.stringify(values) },
    credential,
  );
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
export async function syncPendingScannerItems(
  options: { force?: boolean } = {},
): Promise<{ remaining: number; rejected: number }> {
  const current = await getScannerCredential();
  if (!current) return { remaining: 0, rejected: 0 };
  const others = (await approvedProfiles(current.sponsorId)).filter((p) => p.id !== current.id);
  const results = await Promise.allSettled([
    syncProfile(current, options),
    ...others.map(async (profile) => {
      const pending = await pendingScannerItems(profile);
      if (!pending.scans.length && !pending.annotations.length)
        return { remaining: 0, rejected: 0 };
      return syncProfile(profile, options);
    }),
  ]);
  const failed = results.find((r) => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.reduce(
    (total, r) =>
      r.status === "fulfilled"
        ? {
            remaining: total.remaining + r.value.remaining,
            rejected: total.rejected + r.value.rejected,
          }
        : total,
    { remaining: 0, rejected: 0 },
  );
}
async function syncProfile(credential: ScannerCredential, options: { force?: boolean }) {
  const scope = scannerScope(credential),
    syncKey = `${scope}:${credential.token}`;
  const running = activeSync.get(syncKey);
  if (running) return running;
  const remaining = async () => {
    const pending = await pendingScannerItems(credential);
    return { remaining: pending.scans.length + pending.annotations.length, rejected: 0 };
  };
  if (!scannerRetryDue(options.force)) return remaining();
  const work = async () => {
    let rejected = 0;
    for (let batch = 0; batch < 20; batch++) {
      const active = await getScannerCredential();
      if (!active || active.sponsorId !== credential.sponsorId) break;
      if (
        active.id === credential.id
          ? active.token !== credential.token
          : !(await approvedProfiles(credential.sponsorId)).some(
              (p) => p.id === credential.id && p.token === credential.token,
            )
      )
        break;
      const pending = await pendingScannerItems(credential);
      const readiness = await readScannerValue<{ stage: string; scanId?: string }>(
        "offline-readiness",
        credential,
      );
      const scans = pending.scans
        .filter((scan) => !(readiness?.stage === "armed" && readiness.scanId === scan.id))
        .slice(0, 100);
      const waiting = new Set(pending.scans.map((scan) => scan.id)),
        sending = new Set(scans.map((scan) => scan.id));
      const annotations = pending.annotations
        .filter((item) => !waiting.has(item.scanId) || sending.has(item.scanId))
        .slice(0, 100);
      if (!scans.length && !annotations.length) return { ...(await remaining()), rejected };
      const result = await scannerJson<SyncResponse>(
        "/api/scanner/sync",
        { method: "POST", body: JSON.stringify(syncPayload(scans, annotations)) },
        credential,
      );
      if (
        !Array.isArray(result.scans) ||
        !Array.isArray(result.annotations) ||
        [...result.scans, ...result.annotations].some(
          (item) =>
            !item ||
            typeof item.id !== "string" ||
            !["accepted", "duplicate", "rejected", "deferred"].includes(item.status),
        ) ||
        result.scans.some((item) => !scans.some((sent) => sent.id === item.id)) ||
        result.annotations.some((item) => !annotations.some((sent) => sent.id === item.id)) ||
        new Set(result.scans.map((item) => item.id)).size !== result.scans.length ||
        new Set(result.annotations.map((item) => item.id)).size !== result.annotations.length
      ) {
        recordScannerContact(false);
        throw new Error("The server did not confirm this upload. Your saved work will be retried.");
      }
      // Compatibility with an older deployment during a rolling update.
      const leads =
        result.leads ??
        (await scannerJson<{ leads: SponsorLead[] }>("/api/scanner/leads", undefined, credential))
          .leads;
      if (
        !Array.isArray(leads) ||
        leads.some((lead) => !lead || !Array.isArray(lead.scans) || !Array.isArray(lead.notes))
      ) {
        recordScannerContact(false);
        throw new Error(
          "The server returned an incomplete lead copy. Your saved work will be retried.",
        );
      }
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
  };
  const promise = (async () =>
    navigator.locks?.request
      ? await navigator.locks.request(
          `swp-scanner-sync:${scope}`,
          { mode: "exclusive", ifAvailable: true },
          (lock) => (lock ? work() : remaining()),
        )
      : await work())().finally(() => activeSync.delete(syncKey));
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
export async function importScannerLink(
  token: string,
  confirmSwitch = true,
): Promise<ScannerCredential> {
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
  let data: ScannerBootstrap | null = null;
  let credential: ScannerCredential;
  try {
    const response = await scannerFetch("/api/scanner/bootstrap", {}, provisional);
    const body = await response.json();
    if (!response.ok)
      throw new ScannerApiError(
        body.error ?? "Ask your organiser for a new scanner link",
        response.status,
        body.code,
      );
    if (!body.device?.id || !Number.isInteger(body.device.sponsorId) || !body.device.operatorName)
      throw new Error("This scanner link could not be verified.");
    data = body as ScannerBootstrap;
    credential = {
      ...provisional,
      id: data.device.id,
      sponsorId: data.device.sponsorId,
      sponsorCompany: data.device.sponsorCompany,
      operatorName: data.device.operatorName,
    };
  } catch (error) {
    if (
      !(
        error instanceof TypeError ||
        (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) ||
        error instanceof SyntaxError
      )
    )
      throw error;
    const known = await approvedProfileForToken(token);
    if (
      !known ||
      (await readScannerValue("access-error", known)) ||
      !(await readScannerValue("bootstrap", known))
    )
      throw error;
    credential = known;
  }
  const current = await getScannerCredential();
  if (
    confirmSwitch &&
    current &&
    scannerScope(current) !== scannerScope(credential) &&
    !window.confirm(
      "Switch from " +
        current.operatorName +
        " to " +
        credential.operatorName +
        " at " +
        credential.sponsorCompany +
        "? Saved scans stay with the person who made them.",
    )
  )
    throw new Error("Scanner switch cancelled.");
  await saveScannerCredential(credential);
  if (data) {
    await writeScannerValue("bootstrap", data, credential);
    await writeScannerValue("access-error", null, credential);
  }
  return credential;
}
function sponsorCsrfCookie(): string {
  const match = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("swp_sponsor_csrf="));
  return match ? decodeURIComponent(match.slice(match.indexOf("=") + 1)) : "";
}
