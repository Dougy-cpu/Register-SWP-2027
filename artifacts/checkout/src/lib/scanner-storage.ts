import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  LeadPackAttendee,
  PendingAnnotation,
  PendingScan,
  RejectedSyncItem,
  ScannerCredential,
  ScannerOfflinePackDownload,
  StoredOfflinePack,
  SponsorLead,
  ScannerBootstrap,
} from "@/types/lead-scanner";

interface OfflineReadinessMarker {
  key: "offline-readiness";
  stage: "armed" | "observed";
  armedAt: string;
  observedAt?: string;
}

interface ScannerDatabase extends DBSchema {
  leads: { key: string; value: { key: string; scope: string; lead: SponsorLead } };
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
export const scannerScope = (credential: Pick<ScannerCredential, "id" | "sponsorId">) =>
  `swp-2027:${credential.sponsorId}:${credential.id}`;
function changed() {
  window.dispatchEvent(new Event("swp:scanner-data"));
}

function database(): Promise<IDBPDatabase<ScannerDatabase>> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBPDatabase<ScannerDatabase>>((resolve, reject) => {
      let blocked = false;
      let connection: IDBPDatabase<ScannerDatabase> | null = null;
      void openDB<ScannerDatabase>("swp-sponsor-scanner", 2, {
        blocked() {
          blocked = true;
          reject(
            new Error(
              "Close any other open scanner tabs, then reload this page. Your saved leads have not been removed.",
            ),
          );
        },
        blocking() {
          connection?.close();
          databasePromise = null;
        },
        terminated() {
          databasePromise = null;
        },
        upgrade(db, oldVersion, _newVersion, tx) {
          if (oldVersion < 1) {
            db.createObjectStore("config");
            db.createObjectStore("packs", { keyPath: "key" });
            const scans = db.createObjectStore("pendingScans", { keyPath: "id" });
            scans.createIndex("by-captured-at", "capturedAt");
            const annotations = db.createObjectStore("pendingAnnotations", { keyPath: "id" });
            annotations.createIndex("by-created-at", "createdAt");
            annotations.createIndex("by-scan-id", "scanId");
            const rejected = db.createObjectStore("rejectedItems", { keyPath: "id" });
            rejected.createIndex("by-rejected-at", "rejectedAt");
          }
          if (oldVersion < 2) {
            db.createObjectStore("leads", { keyPath: "key" });
            // Legacy queues keep their original owner. Unknown ownership is never guessed.
            void (async () => {
              const saved = await tx.objectStore("config").get("device");
              if (!saved || !("token" in saved)) return;
              const scope = scannerScope(saved);
              for (const name of ["pendingScans", "pendingAnnotations", "rejectedItems"] as const) {
                let cursor = await tx.objectStore(name).openCursor();
                while (cursor) {
                  await cursor.update({ ...cursor.value, scope });
                  cursor = await cursor.continue();
                }
              }
              const pack = await tx.objectStore("packs").get("current");
              if (pack) await tx.objectStore("packs").put({ ...pack, key: scope });
            })().catch(() => tx.abort());
          }
        },
      }).then((db) => {
        if (blocked) {
          db.close();
          return;
        }
        connection = db;
        resolve(db);
      }, reject);
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
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
  const tx = (await database()).transaction("config", "readwrite");
  await tx.store.put(credential, "device");
  await tx.store.put(credential, `credential:${scannerScope(credential)}`);
  await tx.done;
  changed();
}

export async function clearScannerCredential(): Promise<void> {
  // Disconnecting is not deletion. A matching renewed link reopens the original queue.
  await (await database()).delete("config", "device");
  changed();
}

async function owner(credential?: ScannerCredential): Promise<ScannerCredential> {
  const saved = credential ?? (await getScannerCredential());
  if (!saved)
    throw new Error("Open your scanner link to continue. Your saved work has not been removed.");
  return saved;
}
export async function readScannerValue<T>(
  key: string,
  credential?: ScannerCredential,
): Promise<T | null> {
  const scope = scannerScope(await owner(credential));
  const value = await (await database()).get("config", `${scope}:${key}`);
  if (!value || !("value" in value)) return null;
  try {
    return JSON.parse(value.value) as T;
  } catch {
    return null;
  }
}
export async function writeScannerValue(
  key: string,
  value: unknown,
  credential?: ScannerCredential,
): Promise<void> {
  const scope = scannerScope(await owner(credential));
  await (await database()).put("config", { key, value: JSON.stringify(value) }, `${scope}:${key}`);
}
export const cachedScannerBootstrap = () => readScannerValue<ScannerBootstrap>("bootstrap");

export async function storeOfflinePack(
  pack: ScannerOfflinePackDownload,
  credential?: ScannerCredential,
): Promise<StoredOfflinePack> {
  const stored: StoredOfflinePack = {
    ...pack,
    key: scannerScope(await owner(credential)),
  };
  await (await database()).put("packs", stored);
  return stored;
}

export async function getOfflinePack(
  credential?: ScannerCredential,
): Promise<StoredOfflinePack | null> {
  const saved = credential ?? (await getScannerCredential());
  return saved ? ((await (await database()).get("packs", scannerScope(saved))) ?? null) : null;
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
  input: Omit<PendingScan, "id" | "capturedAt" | "scope">,
): Promise<PendingScan> {
  const scan: PendingScan = {
    ...input,
    scope: scannerScope(await owner()),
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
  };
  const db = await database();
  const tx = db.transaction("pendingScans", "readwrite");
  await tx.store.add(scan);
  await tx.done;
  changed();
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
    scope: scannerScope(await owner()),
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
  changed();
  return annotation;
}

export async function pendingScannerItems(credential?: ScannerCredential): Promise<{
  scans: PendingScan[];
  annotations: PendingAnnotation[];
}> {
  const db = await database();
  const [scans, annotations] = await Promise.all([
    db.getAllFromIndex("pendingScans", "by-captured-at"),
    db.getAllFromIndex("pendingAnnotations", "by-created-at"),
  ]);
  const saved = credential ?? (await getScannerCredential());
  if (!saved) return { scans: [], annotations: [] };
  const scope = scannerScope(saved);
  return {
    scans: scans.filter((item) => item.scope === scope),
    annotations: annotations.filter((item) => item.scope === scope),
  };
}

export async function pendingScannerCount(): Promise<number> {
  const pending = await pendingScannerItems();
  return pending.scans.length + pending.annotations.length;
}

export async function applySyncResults(input: {
  credential?: ScannerCredential;
  leads?: SponsorLead[];
  sentAnnotations?: PendingAnnotation[];
  scanResults: Array<{ id: string; status: string; reason?: string }>;
  annotationResults: Array<{ id: string; status: string; reason?: string }>;
}): Promise<void> {
  const db = await database();
  const credential = await owner(input.credential),
    scope = scannerScope(credential);
  const tx = db.transaction(
    ["pendingScans", "pendingAnnotations", "rejectedItems", "leads"],
    "readwrite",
  );
  // Cache and acknowledgement commit together, so accepted scans cannot disappear.
  for (const lead of input.leads ?? []) {
    if (lead.sponsorId === credential.sponsorId)
      await tx.objectStore("leads").put({ key: `${scope}:${lead.id}`, scope, lead });
  }
  for (const result of input.scanResults) {
    if (!["accepted", "duplicate", "rejected"].includes(result.status)) continue;
    const payload = await tx.objectStore("pendingScans").get(result.id);
    if (!payload || payload.scope !== scope) continue;
    if (result.status === "rejected") {
      await tx.objectStore("rejectedItems").put({
        id: `scan:${result.id}`,
        scope,
        kind: "scan",
        reason: result.reason ?? "The server rejected this scan",
        rejectedAt: new Date().toISOString(),
        payload,
      });
    }
    const known = (input.leads ?? []).some((lead) =>
      lead.scans.some((scan) => scan.id === payload.id),
    );
    if (result.status === "rejected" || known || payload.code === "FFFFFFFFFFFF")
      await tx.objectStore("pendingScans").delete(result.id);
  }
  for (const result of input.annotationResults) {
    if (!["accepted", "duplicate", "rejected"].includes(result.status)) continue;
    const payload = await tx.objectStore("pendingAnnotations").get(result.id);
    if (!payload || payload.scope !== scope) continue;
    const sent = input.sentAnnotations?.find((item) => item.id === result.id);
    if (sent && sent.createdAt !== payload.createdAt) continue;
    if (result.status === "rejected") {
      await tx.objectStore("rejectedItems").put({
        id: `annotation:${result.id}`,
        scope,
        kind: "annotation",
        reason: result.reason ?? "The server rejected this rating or note",
        rejectedAt: new Date().toISOString(),
        payload,
      });
    }
    await tx.objectStore("pendingAnnotations").delete(result.id);
  }
  await tx.done;
  changed();
}

export async function rejectedScannerItems(): Promise<RejectedSyncItem[]> {
  const saved = await getScannerCredential();
  if (!saved) return [];
  return (await (await database()).getAllFromIndex("rejectedItems", "by-rejected-at")).filter(
    (item) => item.scope === scannerScope(saved),
  );
}

export async function cachedScannerLeads(credential?: ScannerCredential): Promise<SponsorLead[]> {
  const saved = credential ?? (await getScannerCredential());
  if (!saved) return [];
  return (await (await database()).getAll("leads"))
    .filter((item) => item.scope === scannerScope(saved))
    .map((item) => item.lead);
}
export async function cacheScannerLeads(
  leads: SponsorLead[],
  credential: ScannerCredential,
): Promise<void> {
  await applySyncResults({ credential, leads, scanResults: [], annotationResults: [] });
}
export async function saveLeadDraft(
  scanId: string,
  note: string,
  rating: number | null,
  credential: ScannerCredential,
): Promise<PendingAnnotation> {
  const key = `${scannerScope(credential)}:note:${scanId}`;
  const tx = (await database()).transaction(["config", "pendingAnnotations"], "readwrite");
  const previous = await tx.objectStore("config").get(key);
  const draft =
    previous && "value" in previous ? (JSON.parse(previous.value) as PendingAnnotation) : null;
  const annotation: PendingAnnotation = {
    id: draft?.id ?? crypto.randomUUID(),
    scope: scannerScope(credential),
    scanId,
    note: note.slice(0, 4000),
    rating,
    createdAt: new Date(
      Math.max(Date.now(), (Date.parse(draft?.createdAt ?? "") || 0) + 1),
    ).toISOString(),
  };
  await tx.objectStore("config").put({ key, value: JSON.stringify(annotation) }, key);
  await tx.objectStore("pendingAnnotations").put(annotation);
  await tx.done;
  changed();
  return annotation;
}
export const getLeadDraft = (scanId: string, credential?: ScannerCredential) =>
  readScannerValue<PendingAnnotation>(`note:${scanId}`, credential);
export async function retryRejectedScans(): Promise<void> {
  const items = await rejectedScannerItems();
  const tx = (await database()).transaction(
    ["rejectedItems", "pendingScans", "pendingAnnotations"],
    "readwrite",
  );
  for (const item of items) {
    if (item.kind === "scan") await tx.objectStore("pendingScans").put(item.payload as PendingScan);
    else await tx.objectStore("pendingAnnotations").put(item.payload as PendingAnnotation);
    await tx.objectStore("rejectedItems").delete(item.id);
  }
  await tx.done;
  changed();
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
  await writeScannerValue(marker.key, marker);
}

export async function observeOfflineReloadTest(
  isOffline: boolean,
): Promise<"none" | "armed" | "observed"> {
  if (!(await getScannerCredential())) return "none";
  const value = await readScannerValue<OfflineReadinessMarker>("offline-readiness");
  if (!value) return "none";
  if (value.stage === "armed" && isOffline) {
    await writeScannerValue("offline-readiness", {
      ...value,
      stage: "observed",
      observedAt: new Date().toISOString(),
    });
    return "observed";
  }
  return value.stage;
}

export async function clearOfflineReloadTest(): Promise<void> {
  await writeScannerValue("offline-readiness", null);
}
