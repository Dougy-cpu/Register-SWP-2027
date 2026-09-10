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
import { normaliseBadgeCode } from "@/lib/scanner-code";
import { startStorageTransaction, storageOperation } from "./scanner-storage-guard";
import { SCANNER_RELEASE } from "./scanner-release";
import { parseScannerBackup, type ScannerBackup } from "./scanner-backup";

const pageSession = crypto.randomUUID();

interface OfflineReadinessMarker {
  key: "offline-readiness";
  stage: "armed" | "observed";
  armedAt: string;
  observedAt?: string;
  scanId?: string;
  pageSession?: string;
  release?: string;
  packVersion?: string;
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
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("swp-scanner-data");
    channel.postMessage("changed");
    channel.close();
  }
}

function database(): Promise<IDBPDatabase<ScannerDatabase>> {
  if (!databasePromise) {
    let expired = false;
    const opening = new Promise<IDBPDatabase<ScannerDatabase>>((resolve, reject) => {
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
        if (blocked || expired) {
          db.close();
          return;
        }
        connection = db;
        resolve(db);
      }, reject);
    });
    databasePromise = storageOperation(opening, () => {
      expired = true;
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function boundStorageOperation<T>(operation: Promise<T>): Promise<T> {
  return storageOperation(operation, () => {
    const previous = databasePromise;
    databasePromise = null;
    void previous?.then(
      (db) => db.close(),
      () => undefined,
    );
  });
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

async function getScannerCredentialOperation(): Promise<ScannerCredential | null> {
  const value = await (await database()).get("config", "device");
  return value && "token" in value ? value : null;
}

async function saveScannerCredentialOperation(credential: ScannerCredential): Promise<void> {
  const tx = startStorageTransaction((await database()).transaction("config", "readwrite"));
  await tx.store.put(credential, "device");
  await tx.store.put(credential, `credential:${scannerScope(credential)}`);
  await tx.done;
  changed();
}

async function clearScannerCredentialOperation(): Promise<void> {
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
  const value = await boundStorageOperation((await database()).get("config", `${scope}:${key}`));
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
  await boundStorageOperation(
    (await database()).put("config", { key, value: JSON.stringify(value) }, `${scope}:${key}`),
  );
}
export const cachedScannerBootstrap = () => readScannerValue<ScannerBootstrap>("bootstrap");

async function storeOfflinePackOperation(
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

async function getOfflinePackOperation(
  credential?: ScannerCredential,
): Promise<StoredOfflinePack | null> {
  const saved = credential ?? (await getScannerCredential());
  return saved ? ((await (await database()).get("packs", scannerScope(saved))) ?? null) : null;
}

export function normaliseScannedValue(value: string): string | null {
  return normaliseBadgeCode(value);
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

async function decryptPackAttendeeOperation(
  code: string,
  credential?: ScannerCredential,
): Promise<LeadPackAttendee | null> {
  const normalisedCode = normaliseScannedValue(code);
  if (!normalisedCode) return null;
  const pack = await getOfflinePack(credential);
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

async function queueScanOperation(
  input: Omit<PendingScan, "id" | "capturedAt" | "scope">,
  credential?: ScannerCredential,
): Promise<PendingScan> {
  const scan: PendingScan = {
    ...input,
    scope: scannerScope(await owner(credential)),
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
  };
  const db = await database();
  const tx = startStorageTransaction(db.transaction(["pendingScans", "config"], "readwrite"));
  const key = `${scan.scope}:capture:${scan.code}`;
  const previous = await tx.objectStore("config").get(key);
  if (previous && "value" in previous) {
    const receipt = JSON.parse(previous.value) as PendingScan;
    if (receipt.scope === scan.scope && receipt.code === scan.code) {
      await tx.done;
      return receipt;
    }
  }
  await tx.objectStore("pendingScans").add(scan);
  await tx.objectStore("config").put({ key, value: JSON.stringify(scan) }, key);
  await tx.done;
  changed();
  return scan;
}

async function queueAnnotationOperation(input: {
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
  const tx = startStorageTransaction(db.transaction("pendingAnnotations", "readwrite"));
  await tx.store.add(annotation);
  await tx.done;
  changed();
  return annotation;
}

async function pendingScannerItemsOperation(credential?: ScannerCredential): Promise<{
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

async function pendingScannerCountOperation(): Promise<number> {
  const pending = await pendingScannerItems();
  return pending.scans.length + pending.annotations.length;
}

async function applySyncResultsOperation(input: {
  credential?: ScannerCredential;
  leads?: SponsorLead[];
  sentAnnotations?: PendingAnnotation[];
  scanResults: Array<{ id: string; status: string; reason?: string }>;
  annotationResults: Array<{ id: string; status: string; reason?: string }>;
}): Promise<void> {
  const db = await database();
  const credential = await owner(input.credential),
    scope = scannerScope(credential);
  const tx = startStorageTransaction(
    db.transaction(
      ["pendingScans", "pendingAnnotations", "rejectedItems", "leads", "config"],
      "readwrite",
    ),
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
    if (payload.code === "FFFFFFFFFFFF" && ["accepted", "duplicate"].includes(result.status)) {
      const key = `${scope}:readiness-ack:${payload.id}`;
      await tx.objectStore("config").put({ key, value: JSON.stringify(true) }, key);
      // Readiness probes may be repeated; real capture receipts remain durable.
      await tx.objectStore("config").delete(`${scope}:capture:${payload.code}`);
    }
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

async function rejectedScannerItemsOperation(
  credential?: ScannerCredential,
): Promise<RejectedSyncItem[]> {
  const saved = credential ?? (await getScannerCredential());
  if (!saved) return [];
  return (await (await database()).getAllFromIndex("rejectedItems", "by-rejected-at")).filter(
    (item) => item.scope === scannerScope(saved),
  );
}

async function cachedScannerLeadsOperation(credential?: ScannerCredential): Promise<SponsorLead[]> {
  const saved = credential ?? (await getScannerCredential());
  if (!saved) return [];
  return (await (await database()).getAll("leads"))
    .filter((item) => item.scope === scannerScope(saved))
    .map((item) => item.lead);
}
async function cacheScannerLeadsOperation(
  leads: SponsorLead[],
  credential: ScannerCredential,
): Promise<void> {
  await applySyncResults({ credential, leads, scanResults: [], annotationResults: [] });
}
async function saveLeadDraftOperation(
  scanId: string,
  note: string,
  rating: number | null,
  credential: ScannerCredential,
): Promise<PendingAnnotation> {
  const key = `${scannerScope(credential)}:note:${scanId}`;
  const tx = startStorageTransaction(
    (await database()).transaction(["config", "pendingAnnotations"], "readwrite"),
  );
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
async function retryRejectedScansOperation(): Promise<void> {
  const items = await rejectedScannerItems();
  const tx = startStorageTransaction(
    (await database()).transaction(
      ["rejectedItems", "pendingScans", "pendingAnnotations"],
      "readwrite",
    ),
  );
  for (const item of items) {
    if (item.kind === "scan") await tx.objectStore("pendingScans").put(item.payload as PendingScan);
    else await tx.objectStore("pendingAnnotations").put(item.payload as PendingAnnotation);
    await tx.objectStore("rejectedItems").delete(item.id);
  }
  await tx.done;
  changed();
}

async function verifyOfflineStorageOperation(): Promise<boolean> {
  const db = await database();
  const key = `test:${crypto.randomUUID()}`;
  const value = { key, value: new Date().toISOString() };
  await db.put("config", value, key);
  const read = await db.get("config", key);
  await db.delete("config", key);
  return Boolean(read && "value" in read && read.value === value.value);
}

async function verifyOfflineQueueOperation(): Promise<boolean> {
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

async function armOfflineReloadTestOperation(): Promise<void> {
  const credential = await owner();
  const scope = scannerScope(credential);
  const pack = await getOfflinePack(credential);
  const scan: PendingScan = {
    id: crypto.randomUUID(),
    code: "FFFFFFFFFFFF",
    source: "manual",
    capturedAt: new Date().toISOString(),
    attendee: null,
    scope,
  };
  const marker: OfflineReadinessMarker = {
    key: "offline-readiness",
    stage: "armed",
    armedAt: new Date().toISOString(),
    scanId: scan.id,
    pageSession,
    release: SCANNER_RELEASE,
    packVersion: pack?.version,
  };
  const tx = startStorageTransaction(
    (await database()).transaction(["config", "pendingScans"], "readwrite"),
  );
  const key = `${scope}:offline-readiness`;
  const previous = await tx.objectStore("config").get(key);
  if (previous && "value" in previous) {
    const old = JSON.parse(previous.value) as OfflineReadinessMarker;
    if (old.scanId) {
      const oldScan = await tx.objectStore("pendingScans").get(old.scanId);
      if (oldScan?.scope === scope && oldScan.code === "FFFFFFFFFFFF")
        await tx.objectStore("pendingScans").delete(old.scanId);
    }
  }
  await tx.objectStore("pendingScans").add(scan);
  await tx.objectStore("config").put({ key, value: JSON.stringify(marker) }, key);
  await tx.done;
  changed();
}

async function observeOfflineReloadTestOperation(
  isOffline: boolean,
): Promise<"none" | "armed" | "observed"> {
  if (!(await getScannerCredential())) return "none";
  const value = await readScannerValue<OfflineReadinessMarker>("offline-readiness");
  if (!value) return "none";
  if (
    value.stage === "armed" &&
    isOffline &&
    value.pageSession !== pageSession &&
    value.release === SCANNER_RELEASE
  ) {
    const credential = await owner();
    const record = value.scanId ? await (await database()).get("pendingScans", value.scanId) : null;
    if (!record || record.scope !== scannerScope(credential) || record.code !== "FFFFFFFFFFFF")
      throw new Error(
        "The offline test record was not found. Your organiser can repeat the check.",
      );
    await writeScannerValue("offline-readiness", {
      ...value,
      stage: "observed",
      observedAt: new Date().toISOString(),
    });
    return "observed";
  }
  return value.stage;
}

async function clearOfflineReloadTestOperation(): Promise<void> {
  await writeScannerValue("offline-readiness", null);
}

export async function offlineReadinessAcknowledged(): Promise<boolean> {
  const marker = await readScannerValue<OfflineReadinessMarker>("offline-readiness");
  return Boolean(
    marker?.stage === "observed" &&
    marker.release === SCANNER_RELEASE &&
    marker.scanId &&
    (await readScannerValue<boolean>(`readiness-ack:${marker.scanId}`)),
  );
}

export async function prepareScannerStorage(): Promise<{
  persistent: boolean;
  availableBytes: number | null;
}> {
  if (!(await verifyOfflineStorage()))
    throw new Error("Phone storage could not save the check. Keep this page open and try again.");
  let persistent = false;
  let availableBytes: number | null = null;
  try {
    if (navigator.storage?.persisted)
      persistent = await storageOperation(navigator.storage.persisted());
    if (!persistent && navigator.storage?.persist)
      persistent = await storageOperation(navigator.storage.persist());
    const estimate = navigator.storage?.estimate
      ? await storageOperation(navigator.storage.estimate())
      : null;
    if (estimate?.quota !== undefined && estimate.usage !== undefined)
      availableBytes = Math.max(0, estimate.quota - estimate.usage);
  } catch {
    /* Persistence is best effort. Actual local writes remain authoritative. */
  }
  const result = { persistent, availableBytes };
  await writeScannerValue("storage-health", result);
  return result;
}

export async function scannerHasUnsettledWork(): Promise<boolean> {
  return storageOperation(
    (async () => {
      const db = await database();
      const counts = await Promise.all([
        db.count("pendingScans"),
        db.count("pendingAnnotations"),
        db.count("rejectedItems"),
      ]);
      return counts.some((count) => count > 0);
    })(),
  );
}

export async function restoreScannerBackup(
  contents: string,
  credential: ScannerCredential,
): Promise<number> {
  const backup: ScannerBackup = parseScannerBackup(contents, credential);
  return storageOperation(
    (async () => {
      const active = await owner();
      if (scannerScope(active) !== scannerScope(credential))
        throw new Error("The scanner changed. Open the original scanner link before restoring.");
      const scope = scannerScope(credential);
      const tx = startStorageTransaction(
        (await database()).transaction(
          ["pendingScans", "pendingAnnotations", "rejectedItems", "config"],
          "readwrite",
        ),
      );
      let restored = 0;
      const originalDrafts = new Set<string>();
      for (const draft of backup.drafts) {
        const key = `${scope}:note:${draft.scanId}`;
        if (await tx.objectStore("config").get(key)) originalDrafts.add(key);
      }
      for (const scan of backup.scans) {
        if (
          !(await tx.objectStore("pendingScans").get(scan.id)) &&
          !(await tx.objectStore("rejectedItems").get(`scan:${scan.id}`))
        ) {
          await tx.objectStore("pendingScans").add(scan);
          restored++;
        }
        const key = `${scope}:capture:${scan.code}`;
        if (!(await tx.objectStore("config").get(key)))
          await tx.objectStore("config").put({ key, value: JSON.stringify(scan) }, key);
      }
      for (const item of backup.annotations) {
        const existing = await tx.objectStore("pendingAnnotations").get(item.id);
        if (!existing && !(await tx.objectStore("rejectedItems").get(`annotation:${item.id}`))) {
          await tx.objectStore("pendingAnnotations").add(item);
          restored++;
        }
        const key = `${scope}:note:${item.scanId}`;
        if (!(await tx.objectStore("config").get(key)))
          await tx.objectStore("config").put({ key, value: JSON.stringify(item) }, key);
      }
      for (const item of backup.rejected) {
        const pendingStore = item.kind === "scan" ? "pendingScans" : "pendingAnnotations";
        if (
          !(await tx.objectStore("rejectedItems").get(item.id)) &&
          !(await tx.objectStore(pendingStore).get(item.payload.id))
        ) {
          await tx.objectStore("rejectedItems").add(item);
          restored++;
        }
      }
      for (const draft of backup.drafts) {
        const key = `${scope}:note:${draft.scanId}`;
        // Existing notes always win; an older rescue file cannot overwrite them.
        if (originalDrafts.has(key)) continue;
        const previous = await tx.objectStore("config").get(key);
        const restoredDraft =
          previous && "value" in previous
            ? (JSON.parse(previous.value) as PendingAnnotation)
            : null;
        if (restoredDraft?.note === draft.note && restoredDraft?.rating === draft.rating) continue;
        const item: PendingAnnotation = {
          id: restoredDraft?.id ?? crypto.randomUUID(),
          scope,
          scanId: draft.scanId,
          note: draft.note,
          rating: draft.rating,
          createdAt: new Date(
            Math.max(
              Date.parse(backup.createdAt),
              (Date.parse(restoredDraft?.createdAt ?? "") || 0) + 1,
            ),
          ).toISOString(),
        };
        await tx.objectStore("pendingAnnotations").put(item);
        await tx.objectStore("config").put({ key, value: JSON.stringify(item) }, key);
        restored++;
      }
      await tx.done;
      changed();
      return restored;
    })(),
  );
}

// Bound callers as well as transactions, including browsers that stop delivering IDB events.
export const getScannerCredential = (
  ...args: Parameters<typeof getScannerCredentialOperation>
): ReturnType<typeof getScannerCredentialOperation> =>
  boundStorageOperation(getScannerCredentialOperation(...args));
export const saveScannerCredential = (
  ...args: Parameters<typeof saveScannerCredentialOperation>
): ReturnType<typeof saveScannerCredentialOperation> =>
  boundStorageOperation(saveScannerCredentialOperation(...args));
export const clearScannerCredential = (
  ...args: Parameters<typeof clearScannerCredentialOperation>
): ReturnType<typeof clearScannerCredentialOperation> =>
  boundStorageOperation(clearScannerCredentialOperation(...args));
export const storeOfflinePack = (
  ...args: Parameters<typeof storeOfflinePackOperation>
): ReturnType<typeof storeOfflinePackOperation> =>
  boundStorageOperation(storeOfflinePackOperation(...args));
export const getOfflinePack = (
  ...args: Parameters<typeof getOfflinePackOperation>
): ReturnType<typeof getOfflinePackOperation> =>
  boundStorageOperation(getOfflinePackOperation(...args));
export const decryptPackAttendee = (
  ...args: Parameters<typeof decryptPackAttendeeOperation>
): ReturnType<typeof decryptPackAttendeeOperation> =>
  boundStorageOperation(decryptPackAttendeeOperation(...args));
export const queueScan = (
  ...args: Parameters<typeof queueScanOperation>
): ReturnType<typeof queueScanOperation> => boundStorageOperation(queueScanOperation(...args));
export const queueAnnotation = (
  ...args: Parameters<typeof queueAnnotationOperation>
): ReturnType<typeof queueAnnotationOperation> =>
  boundStorageOperation(queueAnnotationOperation(...args));
export const pendingScannerItems = (
  ...args: Parameters<typeof pendingScannerItemsOperation>
): ReturnType<typeof pendingScannerItemsOperation> =>
  boundStorageOperation(pendingScannerItemsOperation(...args));
export const pendingScannerCount = (
  ...args: Parameters<typeof pendingScannerCountOperation>
): ReturnType<typeof pendingScannerCountOperation> =>
  boundStorageOperation(pendingScannerCountOperation(...args));
export const applySyncResults = (
  ...args: Parameters<typeof applySyncResultsOperation>
): ReturnType<typeof applySyncResultsOperation> =>
  boundStorageOperation(applySyncResultsOperation(...args));
export const rejectedScannerItems = (
  ...args: Parameters<typeof rejectedScannerItemsOperation>
): ReturnType<typeof rejectedScannerItemsOperation> =>
  boundStorageOperation(rejectedScannerItemsOperation(...args));
export const cachedScannerLeads = (
  ...args: Parameters<typeof cachedScannerLeadsOperation>
): ReturnType<typeof cachedScannerLeadsOperation> =>
  boundStorageOperation(cachedScannerLeadsOperation(...args));
export const cacheScannerLeads = (
  ...args: Parameters<typeof cacheScannerLeadsOperation>
): ReturnType<typeof cacheScannerLeadsOperation> =>
  boundStorageOperation(cacheScannerLeadsOperation(...args));
export const saveLeadDraft = (
  ...args: Parameters<typeof saveLeadDraftOperation>
): ReturnType<typeof saveLeadDraftOperation> =>
  boundStorageOperation(saveLeadDraftOperation(...args));
export const retryRejectedScans = (
  ...args: Parameters<typeof retryRejectedScansOperation>
): ReturnType<typeof retryRejectedScansOperation> =>
  boundStorageOperation(retryRejectedScansOperation(...args));
export const verifyOfflineStorage = (
  ...args: Parameters<typeof verifyOfflineStorageOperation>
): ReturnType<typeof verifyOfflineStorageOperation> =>
  boundStorageOperation(verifyOfflineStorageOperation(...args));
export const verifyOfflineQueue = (
  ...args: Parameters<typeof verifyOfflineQueueOperation>
): ReturnType<typeof verifyOfflineQueueOperation> =>
  boundStorageOperation(verifyOfflineQueueOperation(...args));
export const armOfflineReloadTest = (
  ...args: Parameters<typeof armOfflineReloadTestOperation>
): ReturnType<typeof armOfflineReloadTestOperation> =>
  boundStorageOperation(armOfflineReloadTestOperation(...args));
export const observeOfflineReloadTest = (
  ...args: Parameters<typeof observeOfflineReloadTestOperation>
): ReturnType<typeof observeOfflineReloadTestOperation> =>
  boundStorageOperation(observeOfflineReloadTestOperation(...args));
export const clearOfflineReloadTest = (
  ...args: Parameters<typeof clearOfflineReloadTestOperation>
): ReturnType<typeof clearOfflineReloadTestOperation> =>
  boundStorageOperation(clearOfflineReloadTestOperation(...args));
