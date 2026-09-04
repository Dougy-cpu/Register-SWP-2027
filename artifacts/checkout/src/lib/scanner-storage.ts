import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  LeadPackAttendee,
  PendingAnnotation,
  PendingScan,
  RejectedSyncItem,
  ScannerCredential,
  ScannerOfflinePackDownload,
  StoredOfflinePack,
} from "@/types/lead-scanner";

interface OfflineReadinessMarker {
  key: "offline-readiness";
  stage: "armed" | "observed";
  armedAt: string;
  observedAt?: string;
}

interface ScannerDatabase extends DBSchema {
  config: {
    key: string;
    value: ScannerCredential | OfflineReadinessMarker | { key: string; value: string };
  };
  packs: {
    key: string;
    value: StoredOfflinePack;
  };
  pendingScans: {
    key: string;
    value: PendingScan;
    indexes: { "by-captured-at": string };
  };
  pendingAnnotations: {
    key: string;
    value: PendingAnnotation;
    indexes: { "by-created-at": string; "by-scan-id": string };
  };
  rejectedItems: {
    key: string;
    value: RejectedSyncItem;
    indexes: { "by-rejected-at": string };
  };
}

let databasePromise: Promise<IDBPDatabase<ScannerDatabase>> | null = null;

function database(): Promise<IDBPDatabase<ScannerDatabase>> {
  if (!databasePromise) {
    databasePromise = openDB<ScannerDatabase>("swp-sponsor-scanner", 1, {
      upgrade(db) {
        db.createObjectStore("config");
        db.createObjectStore("packs", { keyPath: "key" });
        const scans = db.createObjectStore("pendingScans", { keyPath: "id" });
        scans.createIndex("by-captured-at", "capturedAt");
        const annotations = db.createObjectStore("pendingAnnotations", { keyPath: "id" });
        annotations.createIndex("by-created-at", "createdAt");
        annotations.createIndex("by-scan-id", "scanId");
        const rejected = db.createObjectStore("rejectedItems", { keyPath: "id" });
        rejected.createIndex("by-rejected-at", "rejectedAt");
      },
    });
  }
  return databasePromise;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function getScannerCredential(): Promise<ScannerCredential | null> {
  const value = await (await database()).get("config", "device");
  return value && "token" in value ? value : null;
}

export async function saveScannerCredential(credential: ScannerCredential): Promise<void> {
  await (await database()).put("config", credential, "device");
}

export async function clearScannerCredential(): Promise<void> {
  const db = await database();
  const tx = db.transaction(
    ["config", "packs", "pendingScans", "pendingAnnotations", "rejectedItems"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("config").clear(),
    tx.objectStore("packs").clear(),
    tx.objectStore("pendingScans").clear(),
    tx.objectStore("pendingAnnotations").clear(),
    tx.objectStore("rejectedItems").clear(),
    tx.done,
  ]);
}

export async function storeOfflinePack(
  pack: ScannerOfflinePackDownload,
): Promise<StoredOfflinePack> {
  const stored: StoredOfflinePack = {
    ...pack,
    key: "current",
  };
  await (await database()).put("packs", stored);
  return stored;
}

export async function getOfflinePack(): Promise<StoredOfflinePack | null> {
  return (await (await database()).get("packs", "current")) ?? null;
}

export function normaliseScannedValue(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[0-9A-F]{12}$/.test(code) ? code : null;
}

async function derivedRecordBytes(label: "lookup" | "record", context: string, code: string) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`swp-lead-${label}-v1|${context}|${code}`),
    ),
  );
}

function bytesBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function decryptPackAttendee(code: string): Promise<LeadPackAttendee | null> {
  const normalisedCode = normaliseScannedValue(code);
  if (!normalisedCode) return null;
  const pack = await getOfflinePack();
  if (!pack) return null;
  if (pack.expiresAt && Date.now() > new Date(pack.expiresAt).getTime()) return null;
  const lookup = bytesBase64Url(
    await derivedRecordBytes("lookup", pack.keyContext, normalisedCode),
  );
  const record = pack.records.find((item) => item.lookup === lookup);
  if (!record) return null;
  const decryptionKey = await crypto.subtle.importKey(
    "raw",
    await derivedRecordBytes("record", pack.keyContext, normalisedCode),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const additionalData = new TextEncoder().encode(`${record.lookup}|${pack.version}`);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlBytes(record.iv),
      additionalData,
      tagLength: 128,
    },
    decryptionKey,
    base64UrlBytes(record.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as LeadPackAttendee;
}

export async function queueScan(
  input: Omit<PendingScan, "id" | "capturedAt">,
): Promise<PendingScan> {
  const scan: PendingScan = {
    ...input,
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
  };
  const db = await database();
  const tx = db.transaction("pendingScans", "readwrite");
  await tx.store.add(scan);
  await tx.done;
  return scan;
}

export async function queueAnnotation(input: {
  scanId: string;
  note?: string | null;
  rating?: number | null;
}): Promise<PendingAnnotation | null> {
  const note = input.note?.trim() || null;
  const rating = input.rating ?? null;
  if (!note && rating === null) return null;
  const annotation: PendingAnnotation = {
    id: crypto.randomUUID(),
    scanId: input.scanId,
    note,
    rating,
    createdAt: new Date().toISOString(),
  };
  const db = await database();
  const tx = db.transaction("pendingAnnotations", "readwrite");
  await tx.store.add(annotation);
  await tx.done;
  return annotation;
}

export async function pendingScannerItems(): Promise<{
  scans: PendingScan[];
  annotations: PendingAnnotation[];
}> {
  const db = await database();
  const [scans, annotations] = await Promise.all([
    db.getAllFromIndex("pendingScans", "by-captured-at"),
    db.getAllFromIndex("pendingAnnotations", "by-created-at"),
  ]);
  return { scans, annotations };
}

export async function pendingScannerCount(): Promise<number> {
  const db = await database();
  const [scans, annotations] = await Promise.all([
    db.count("pendingScans"),
    db.count("pendingAnnotations"),
  ]);
  return scans + annotations;
}

export async function applySyncResults(input: {
  scanResults: Array<{ id: string; status: string; reason?: string }>;
  annotationResults: Array<{ id: string; status: string; reason?: string }>;
}): Promise<void> {
  const db = await database();
  const tx = db.transaction(["pendingScans", "pendingAnnotations", "rejectedItems"], "readwrite");
  for (const result of input.scanResults) {
    if (!["accepted", "duplicate", "rejected"].includes(result.status)) continue;
    const payload = await tx.objectStore("pendingScans").get(result.id);
    if (!payload) continue;
    if (result.status === "rejected") {
      await tx.objectStore("rejectedItems").put({
        id: `scan:${result.id}`,
        kind: "scan",
        reason: result.reason ?? "The server rejected this scan",
        rejectedAt: new Date().toISOString(),
        payload,
      });
    }
    await tx.objectStore("pendingScans").delete(result.id);
  }
  for (const result of input.annotationResults) {
    if (!["accepted", "duplicate", "rejected"].includes(result.status)) continue;
    const payload = await tx.objectStore("pendingAnnotations").get(result.id);
    if (!payload) continue;
    if (result.status === "rejected") {
      await tx.objectStore("rejectedItems").put({
        id: `annotation:${result.id}`,
        kind: "annotation",
        reason: result.reason ?? "The server rejected this rating or note",
        rejectedAt: new Date().toISOString(),
        payload,
      });
    }
    await tx.objectStore("pendingAnnotations").delete(result.id);
  }
  await tx.done;
}

export async function rejectedScannerItems(): Promise<RejectedSyncItem[]> {
  return (await database()).getAllFromIndex("rejectedItems", "by-rejected-at");
}

export async function verifyOfflineStorage(): Promise<boolean> {
  const db = await database();
  const key = `test:${crypto.randomUUID()}`;
  const value = { key, value: new Date().toISOString() };
  await db.put("config", value, key);
  const read = await db.get("config", key);
  await db.delete("config", key);
  return Boolean(read && "value" in read && read.value === value.value);
}

export async function verifyOfflineQueue(): Promise<boolean> {
  const db = await database();
  const id = crypto.randomUUID();
  const sample: PendingScan = {
    id,
    code: "FFFFFFFFFFFF",
    source: "manual",
    capturedAt: new Date().toISOString(),
    attendee: {
      attendeeId: -1,
      name: "Scanner readiness test",
      firstName: "Scanner",
      lastName: "Test",
      jobTitle: "",
      company: "SWP Summit 2027",
      workEmail: "test@invalid.example",
    },
  };
  await db.add("pendingScans", sample);
  const read = await db.get("pendingScans", id);
  await db.delete("pendingScans", id);
  return read?.id === id;
}

export async function armOfflineReloadTest(): Promise<void> {
  const marker: OfflineReadinessMarker = {
    key: "offline-readiness",
    stage: "armed",
    armedAt: new Date().toISOString(),
  };
  await (await database()).put("config", marker, marker.key);
}

export async function observeOfflineReloadTest(
  isOffline: boolean,
): Promise<"none" | "armed" | "observed"> {
  const db = await database();
  const value = await db.get("config", "offline-readiness");
  if (!value || !("stage" in value)) return "none";
  if (value.stage === "armed" && isOffline) {
    await db.put(
      "config",
      { ...value, stage: "observed", observedAt: new Date().toISOString() },
      "offline-readiness",
    );
    return "observed";
  }
  return value.stage;
}

export async function clearOfflineReloadTest(): Promise<void> {
  await (await database()).delete("config", "offline-readiness");
}
