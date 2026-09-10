import { z } from "zod";
import type { ScannerCredential } from "@/types/lead-scanner";
import {
  cachedScannerLeads,
  pendingScannerItems,
  rejectedScannerItems,
  scannerScope,
} from "./scanner-storage";

const text = z.string().max(4000);
const identifier = z.string().min(1).max(150);
const timestamp = z.string().datetime({ offset: true });
const attendee = z.object({
  attendeeId: z.number().int().positive(),
  name: text,
  firstName: text,
  lastName: text,
  jobTitle: text,
  company: text,
  workEmail: text,
});
const scan = z.object({
  scope: identifier,
  id: identifier,
  code: z.string().regex(/^[A-F0-9]{12}$/),
  source: z.enum(["camera", "image", "manual"]),
  capturedAt: timestamp,
  attendee: attendee.nullable(),
});
const annotation = z.object({
  scope: identifier,
  id: identifier,
  scanId: identifier,
  note: text.nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  createdAt: timestamp,
});
const rejection = z.discriminatedUnion("kind", [
  z.object({
    scope: identifier,
    id: identifier,
    kind: z.literal("scan"),
    reason: text,
    rejectedAt: timestamp,
    payload: scan,
  }),
  z.object({
    scope: identifier,
    id: identifier,
    kind: z.literal("annotation"),
    reason: text,
    rejectedAt: timestamp,
    payload: annotation,
  }),
]);
const fallback = z.object({
  scanId: identifier,
  note: text,
  rating: z.number().int().min(1).max(5).nullable(),
});
const backupSchema = z.object({
  format: z.literal("swp-scanner-recovery-v1"),
  createdAt: timestamp,
  owner: z.object({
    deviceId: identifier,
    sponsorId: z.number().int().positive(),
    operatorName: text,
  }),
  scans: z.array(scan).max(20000),
  annotations: z.array(annotation).max(40000),
  rejected: z.array(rejection).max(40000),
  drafts: z.array(fallback).max(40000),
});
export type ScannerBackup = z.infer<typeof backupSchema>;

export function parseScannerBackup(contents: string, credential: ScannerCredential): ScannerBackup {
  if (contents.length > 20_000_000)
    throw new Error("This recovery file is too large. Ask the organiser for help.");
  const parsed = backupSchema.safeParse(JSON.parse(contents));
  if (!parsed.success) throw new Error("This is not a valid SWP scanner recovery file.");
  const data = parsed.data;
  const scope = scannerScope(credential);
  if (
    data.owner.deviceId !== credential.id ||
    data.owner.sponsorId !== credential.sponsorId ||
    [...data.scans, ...data.annotations, ...data.rejected].some((item) => item.scope !== scope) ||
    data.rejected.some((item) => item.payload.scope !== scope)
  ) {
    throw new Error(
      "Open the same team member's scanner link before restoring this file. Saved work has not moved.",
    );
  }
  return data;
}

export async function createScannerBackup(credential: ScannerCredential): Promise<ScannerBackup> {
  const [pending, rejected, leads] = await Promise.all([
    pendingScannerItems(credential),
    rejectedScannerItems(credential),
    cachedScannerLeads(credential),
  ]);
  const prefix = `${scannerScope(credential)}:note-fallback:`;
  const scanIds = new Set([
    ...pending.scans.map((item) => item.id),
    ...leads.flatMap((lead) => lead.scans.map((item) => item.id)),
    ...rejected.flatMap((item) => (item.kind === "scan" ? [item.payload.id] : [])),
  ]);
  const drafts: ScannerBackup["drafts"] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix) || !scanIds.has(key.slice(prefix.length))) continue;
      try {
        const value = fallback.safeParse({
          ...JSON.parse(localStorage.getItem(key) ?? "null"),
          scanId: key.slice(prefix.length),
        });
        if (value.success) drafts.push(value.data);
      } catch {
        /* A damaged fallback does not prevent rescuing the durable queue. */
      }
    }
  } catch {
    /* Some browsers disable localStorage while IndexedDB still works. */
  }

  const result = {
    format: "swp-scanner-recovery-v1",
    createdAt: new Date().toISOString(),
    owner: {
      deviceId: credential.id,
      sponsorId: credential.sponsorId,
      operatorName: credential.operatorName,
    },
    scans: pending.scans.filter((item) => item.code !== "FFFFFFFFFFFF"),
    annotations: pending.annotations,
    rejected,
    drafts,
  };
  // Round-trip through the allowlist: credentials, downloaded attendee packs and
  // unrelated fields can never enter the recovery file.
  return parseScannerBackup(JSON.stringify(result), credential);
}

export function downloadScannerBackup(backup: ScannerBackup) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `swp-scanner-recovery-${backup.createdAt.slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
