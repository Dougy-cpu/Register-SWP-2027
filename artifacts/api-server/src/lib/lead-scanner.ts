import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  attendeeBadgesTable,
  attendeesTable,
  bookingsTable,
  db,
  eventSettingsTable,
  sponsorLeadNotesTable,
  sponsorLeadScanEventsTable,
  sponsorLeadsTable,
  sponsorScannerDevicesTable,
  sponsorsTable,
} from "@workspace/db";

export const SCANNER_TEST_CODE = "FFFFFFFFFFFF";
export const BADGE_CODE_PATTERN = /^[0-9A-F]{12}$/;
export const LEAD_PACK_FORMAT = 1;
export const MAX_SYNC_BATCH = 100;
const ACTIVE_BOOKING_STATUSES = ["paid", "invoiced"] as const;
const PACK_REFRESH_MS = 12 * 60 * 60 * 1000;
const SCANNER_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function normaliseBadgeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return BADGE_CODE_PATTERN.test(code) ? code : null;
}

export function generateBadgeCode(): string {
  let code = SCANNER_TEST_CODE;
  while (code === SCANNER_TEST_CODE || !/^[A-F]/.test(code)) {
    code = randomBytes(6).toString("hex").toUpperCase();
  }
  return code;
}

export function scannerDeviceRateLimitKey(deviceId: string): string {
  return `scanner:${deviceId}`;
}

export function offlineRecordLookup(keyContext: string, code: string): string {
  return createHash("sha256")
    .update(`swp-lead-lookup-v1|${keyContext}|${code}`)
    .digest("base64url");
}

function offlineRecordKey(keyContext: string, code: string): Buffer {
  return createHash("sha256").update(`swp-lead-record-v1|${keyContext}|${code}`).digest();
}

function encryptRecord(
  keyContext: string,
  code: string,
  packVersion: string,
  record: LeadPackAttendee,
): { lookup: string; iv: string; ciphertext: string } {
  const lookup = offlineRecordLookup(keyContext, code);
  const key = offlineRecordKey(keyContext, code);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${lookup}|${packVersion}`, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(record), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    lookup,
    iv: iv.toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
  };
}

export interface LeadPackAttendee {
  attendeeId: number;
  name: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
}

interface EligibleBadgeRow extends LeadPackAttendee {
  code: string;
  badgeVersion: number;
  attendeeUpdatedAt: Date;
  badgeUpdatedAt: Date;
}

async function eligibleAttendeeIds(): Promise<number[]> {
  const rows = await db
    .select({ id: attendeesTable.id })
    .from(attendeesTable)
    .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
    .where(
      and(
        inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
        eq(attendeesTable.isTbc, false),
        eq(attendeesTable.leadSharingExcluded, false),
        isNotNull(attendeesTable.leadSharingNoticeAt),
      ),
    )
    .orderBy(asc(attendeesTable.id));
  return rows.map((row) => row.id);
}

export async function ensureEligibleAttendeeBadges(): Promise<void> {
  const attendeeIds = await eligibleAttendeeIds();
  if (!attendeeIds.length) return;
  const existing = await db
    .select({ attendeeId: attendeeBadgesTable.attendeeId })
    .from(attendeeBadgesTable)
    .where(inArray(attendeeBadgesTable.attendeeId, attendeeIds));
  const existingIds = new Set(existing.map((row) => row.attendeeId));
  let missingIds = attendeeIds.filter((attendeeId) => !existingIds.has(attendeeId));
  for (let attempt = 0; missingIds.length && attempt < 5; attempt += 1) {
    await db
      .insert(attendeeBadgesTable)
      .values(missingIds.map((attendeeId) => ({ attendeeId, code: generateBadgeCode() })))
      .onConflictDoNothing();
    const nowPresent = await db
      .select({ attendeeId: attendeeBadgesTable.attendeeId })
      .from(attendeeBadgesTable)
      .where(inArray(attendeeBadgesTable.attendeeId, missingIds));
    const presentIds = new Set(nowPresent.map((row) => row.attendeeId));
    missingIds = missingIds.filter((attendeeId) => !presentIds.has(attendeeId));
  }
  if (missingIds.length) throw new Error("Could not allocate unique badge references");
}

async function eligibleBadgeRows(): Promise<EligibleBadgeRow[]> {
  await ensureEligibleAttendeeBadges();
  const rows = await db
    .select({
      attendeeId: attendeesTable.id,
      firstName: attendeesTable.firstName,
      lastName: attendeesTable.lastName,
      jobTitle: attendeesTable.jobTitle,
      company: attendeesTable.company,
      workEmail: attendeesTable.workEmail,
      attendeeUpdatedAt: attendeesTable.updatedAt,
      code: attendeeBadgesTable.code,
      badgeVersion: attendeeBadgesTable.version,
      badgeUpdatedAt: attendeeBadgesTable.updatedAt,
    })
    .from(attendeeBadgesTable)
    .innerJoin(attendeesTable, eq(attendeesTable.id, attendeeBadgesTable.attendeeId))
    .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
    .where(
      and(
        eq(attendeeBadgesTable.active, true),
        inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
        eq(attendeesTable.isTbc, false),
        eq(attendeesTable.leadSharingExcluded, false),
        isNotNull(attendeesTable.leadSharingNoticeAt),
      ),
    )
    .orderBy(asc(attendeesTable.id));
  return rows.map((row) => ({
    ...row,
    name: `${row.firstName} ${row.lastName}`.trim(),
  }));
}

function leadPackVersionForRows(rows: EligibleBadgeRow[], scanClosesAt: string | null): string {
  const content = {
    format: LEAD_PACK_FORMAT,
    scanClosesAt,
    attendees: rows.map((row) => ({
      attendeeId: row.attendeeId,
      code: row.code,
      badgeVersion: row.badgeVersion,
      firstName: row.firstName,
      lastName: row.lastName,
      jobTitle: row.jobTitle,
      company: row.company,
      workEmail: row.workEmail,
      attendeeUpdatedAt: row.attendeeUpdatedAt.toISOString(),
      badgeUpdatedAt: row.badgeUpdatedAt.toISOString(),
    })),
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export async function currentLeadPackVersion(): Promise<string> {
  const [rows, window] = await Promise.all([eligibleBadgeRows(), getScannerWindow()]);
  return leadPackVersionForRows(rows, window.scanClosesAt);
}

export async function getScannerWindow(now = new Date()): Promise<{
  eventStartAt: string | null;
  eventEndAt: string | null;
  scanClosesAt: string | null;
  scanningOpen: boolean;
}> {
  const [settings] = await db
    .select({
      eventStartAt: eventSettingsTable.eventStartAt,
      eventEndAt: eventSettingsTable.eventEndAt,
    })
    .from(eventSettingsTable)
    .limit(1);
  const closesAt = settings?.eventEndAt
    ? new Date(settings.eventEndAt.getTime() + SCANNER_GRACE_MS)
    : null;
  return {
    eventStartAt: settings?.eventStartAt?.toISOString() ?? null,
    eventEndAt: settings?.eventEndAt?.toISOString() ?? null,
    scanClosesAt: closesAt?.toISOString() ?? null,
    scanningOpen: Boolean(closesAt && now.getTime() <= closesAt.getTime()),
  };
}

export async function buildOfflineLeadPack(device: { id: string; accessVersion: number }): Promise<{
  format: number;
  version: string;
  generatedAt: string;
  refreshAfter: string;
  expiresAt: string | null;
  keyContext: string;
  records: Array<{ lookup: string; badgeVersion: number; iv: string; ciphertext: string }>;
}> {
  const [rows, window] = await Promise.all([eligibleBadgeRows(), getScannerWindow()]);
  const version = leadPackVersionForRows(rows, window.scanClosesAt);
  const keyContext = randomBytes(16).toString("base64url");
  void device;
  const now = new Date();
  const refreshAfter = new Date(now.getTime() + PACK_REFRESH_MS);
  const expiresAt = window.scanClosesAt ? new Date(window.scanClosesAt) : null;
  return {
    format: LEAD_PACK_FORMAT,
    version,
    generatedAt: now.toISOString(),
    refreshAfter: refreshAfter.toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null,
    keyContext,
    records: rows.map((row) => ({
      badgeVersion: row.badgeVersion,
      ...encryptRecord(keyContext, row.code, version, {
        attendeeId: row.attendeeId,
        name: row.name,
        firstName: row.firstName,
        lastName: row.lastName,
        jobTitle: row.jobTitle,
        company: row.company,
        workEmail: row.workEmail,
      }),
    })),
  };
}

export interface ScannerSyncScan {
  id: string;
  code: string;
  source: "camera" | "image" | "manual";
  capturedAt: string;
}

export interface ScannerSyncAnnotation {
  id: string;
  scanId: string;
  note?: string | null;
  rating?: number | null;
  createdAt: string;
}

export interface ScannerIdentity {
  id: string;
  sponsorId: number;
  operatorName: string;
}

type SyncResult = {
  id: string;
  status: "accepted" | "duplicate" | "rejected" | "deferred";
  reason?: string;
};

function parsedClientDate(value: string): Date | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  if (parsed.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  return parsed;
}

function annotationValues(annotation: ScannerSyncAnnotation): {
  note: string | null;
  rating: number | null;
  createdAt: Date;
} | null {
  const note = typeof annotation.note === "string" ? annotation.note.trim().slice(0, 4000) : null;
  const rating = Number.isInteger(annotation.rating) ? Number(annotation.rating) : null;
  const createdAt = parsedClientDate(annotation.createdAt);
  if (!createdAt) return null;
  if (rating !== null && (rating < 1 || rating > 5)) return null;
  return { note: note || null, rating, createdAt };
}

export async function syncScannerBatch(
  identity: ScannerIdentity,
  scans: ScannerSyncScan[],
  annotations: ScannerSyncAnnotation[],
): Promise<{
  scans: SyncResult[];
  annotations: SyncResult[];
  syncedAt: string;
  leads: LeadListRow[];
}> {
  if (scans.length > MAX_SYNC_BATCH || annotations.length > MAX_SYNC_BATCH) {
    throw new Error(`A sync batch cannot contain more than ${MAX_SYNC_BATCH} items of each type`);
  }
  const window = await getScannerWindow();
  const closesAt = window.scanClosesAt ? new Date(window.scanClosesAt) : null;
  const scanResults: SyncResult[] = [];
  const annotationResults: SyncResult[] = [];

  await db.transaction(async (tx) => {
    for (const scan of scans) {
      if (typeof scan.id !== "string" || scan.id.length < 16 || scan.id.length > 100) {
        scanResults.push({
          id: String(scan.id ?? ""),
          status: "rejected",
          reason: "Invalid event ID",
        });
        continue;
      }
      const code = normaliseBadgeCode(scan.code);
      const capturedAt = parsedClientDate(scan.capturedAt);
      if (!code || !capturedAt) {
        scanResults.push({ id: scan.id, status: "rejected", reason: "Invalid scan data" });
        continue;
      }
      if (!(["camera", "image", "manual"] as const).includes(scan.source)) {
        scanResults.push({ id: scan.id, status: "rejected", reason: "Invalid scan source" });
        continue;
      }
      if (code === SCANNER_TEST_CODE) {
        await tx
          .update(sponsorScannerDevicesTable)
          .set({ syncTested: true, updatedAt: new Date() })
          .where(eq(sponsorScannerDevicesTable.id, identity.id));
        scanResults.push({ id: scan.id, status: "accepted" });
        continue;
      }
      if (closesAt && capturedAt.getTime() > closesAt.getTime()) {
        scanResults.push({
          id: scan.id,
          status: "rejected",
          reason: "Scanning had already closed",
        });
        continue;
      }
      if (!closesAt) {
        scanResults.push({
          id: scan.id,
          status: "rejected",
          reason: "Event end time is not configured",
        });
        continue;
      }
      const [existingEvent] = await tx
        .select({
          id: sponsorLeadScanEventsTable.id,
          sponsorId: sponsorLeadScanEventsTable.sponsorId,
          deviceId: sponsorLeadScanEventsTable.scannerDeviceId,
        })
        .from(sponsorLeadScanEventsTable)
        .where(eq(sponsorLeadScanEventsTable.id, scan.id));
      if (existingEvent) {
        scanResults.push({
          id: scan.id,
          status:
            existingEvent.sponsorId === identity.sponsorId && existingEvent.deviceId === identity.id
              ? "duplicate"
              : "rejected",
          reason: "Scan identifier already belongs to another phone",
        });
        continue;
      }
      const [badge] = await tx
        .select({
          attendeeId: attendeesTable.id,
          badgeVersion: attendeeBadgesTable.version,
        })
        .from(attendeeBadgesTable)
        .innerJoin(attendeesTable, eq(attendeesTable.id, attendeeBadgesTable.attendeeId))
        .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
        .where(
          and(
            eq(attendeeBadgesTable.code, code),
            eq(attendeeBadgesTable.active, true),
            inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
            eq(attendeesTable.isTbc, false),
            eq(attendeesTable.leadSharingExcluded, false),
            isNotNull(attendeesTable.leadSharingNoticeAt),
          ),
        );
      if (!badge) {
        scanResults.push({
          id: scan.id,
          status: "rejected",
          reason: "Badge is invalid, out of date or excluded from lead sharing",
        });
        continue;
      }
      const proposedLeadId = uuidv4();
      await tx
        .insert(sponsorLeadsTable)
        .values({ id: proposedLeadId, sponsorId: identity.sponsorId, attendeeId: badge.attendeeId })
        .onConflictDoNothing({
          target: [sponsorLeadsTable.sponsorId, sponsorLeadsTable.attendeeId],
        });
      const [lead] = await tx
        .select({ id: sponsorLeadsTable.id })
        .from(sponsorLeadsTable)
        .where(
          and(
            eq(sponsorLeadsTable.sponsorId, identity.sponsorId),
            eq(sponsorLeadsTable.attendeeId, badge.attendeeId),
          ),
        );
      if (!lead) throw new Error("Lead could not be created");
      const inserted = await tx
        .insert(sponsorLeadScanEventsTable)
        .values({
          id: scan.id,
          leadId: lead.id,
          sponsorId: identity.sponsorId,
          attendeeId: badge.attendeeId,
          scannerDeviceId: identity.id,
          operatorName: identity.operatorName,
          badgeVersion: badge.badgeVersion,
          source: scan.source,
          capturedAt,
        })
        .onConflictDoNothing()
        .returning({ id: sponsorLeadScanEventsTable.id });
      if (!inserted.length) {
        scanResults.push({ id: scan.id, status: "duplicate" });
        continue;
      }
      await tx
        .update(sponsorLeadsTable)
        .set({
          scanCount: sql`${sponsorLeadsTable.scanCount} + 1`,
          firstScannedAt: sql`LEAST(COALESCE(${sponsorLeadsTable.firstScannedAt}, ${capturedAt}), ${capturedAt})`,
          lastScannedAt: sql`GREATEST(COALESCE(${sponsorLeadsTable.lastScannedAt}, ${capturedAt}), ${capturedAt})`,
          updatedAt: new Date(),
        })
        .where(eq(sponsorLeadsTable.id, lead.id));
      scanResults.push({ id: scan.id, status: "accepted" });
    }

    for (const annotation of annotations) {
      const values = annotationValues(annotation);
      if (
        typeof annotation.id !== "string" ||
        annotation.id.length < 16 ||
        annotation.id.length > 100 ||
        typeof annotation.scanId !== "string" ||
        !values
      ) {
        annotationResults.push({
          id: String(annotation.id ?? ""),
          status: "rejected",
          reason: "Invalid rating or note",
        });
        continue;
      }
      const [event] = await tx
        .select({ leadId: sponsorLeadScanEventsTable.leadId })
        .from(sponsorLeadScanEventsTable)
        .where(
          and(
            eq(sponsorLeadScanEventsTable.id, annotation.scanId),
            eq(sponsorLeadScanEventsTable.sponsorId, identity.sponsorId),
          ),
        );
      if (!event) {
        annotationResults.push({
          id: annotation.id,
          status: "deferred",
          reason: "The matching scan has not been accepted",
        });
        continue;
      }
      const [existingNote] = await tx
        .select()
        .from(sponsorLeadNotesTable)
        .where(eq(sponsorLeadNotesTable.id, annotation.id))
        .for("update");
      if (
        existingNote &&
        (existingNote.scannerDeviceId !== identity.id || existingNote.leadId !== event.leadId)
      ) {
        annotationResults.push({
          id: annotation.id,
          status: "rejected",
          reason: "This note belongs to another phone",
        });
        continue;
      }
      const inserted = await tx
        .insert(sponsorLeadNotesTable)
        .values({
          id: annotation.id,
          leadId: event.leadId,
          scannerDeviceId: identity.id,
          operatorName: identity.operatorName,
          note: values.note,
          rating: values.rating,
          createdAt: values.createdAt,
        })
        .onConflictDoUpdate({
          target: sponsorLeadNotesTable.id,
          set: { note: values.note, rating: values.rating, createdAt: values.createdAt },
          setWhere: and(
            eq(sponsorLeadNotesTable.scannerDeviceId, identity.id),
            eq(sponsorLeadNotesTable.leadId, event.leadId),
            sql`${sponsorLeadNotesTable.createdAt} < ${values.createdAt}`,
          ),
        })
        .returning({ id: sponsorLeadNotesTable.id });
      if (!inserted.length) {
        annotationResults.push({ id: annotation.id, status: "duplicate" });
        continue;
      }
      {
        const [latestRating] = await tx
          .select({ rating: sponsorLeadNotesTable.rating })
          .from(sponsorLeadNotesTable)
          .where(eq(sponsorLeadNotesTable.leadId, event.leadId))
          .orderBy(desc(sponsorLeadNotesTable.createdAt), desc(sponsorLeadNotesTable.id))
          .limit(1);
        await tx
          .update(sponsorLeadsTable)
          .set({ rating: latestRating?.rating ?? null, updatedAt: new Date() })
          .where(eq(sponsorLeadsTable.id, event.leadId));
      }
      annotationResults.push({ id: annotation.id, status: "accepted" });
    }

    await tx
      .update(sponsorScannerDevicesTable)
      .set({ lastSyncedAt: new Date(), lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(sponsorScannerDevicesTable.id, identity.id));
  });

  return {
    scans: scanResults,
    annotations: annotationResults,
    syncedAt: new Date().toISOString(),
    leads: await listLeadRows(identity.sponsorId),
  };
}

export interface LeadListRow {
  id: string;
  sponsorId: number;
  sponsorCompany: string;
  attendeeId: number;
  firstName: string;
  lastName: string;
  name: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  rating: number | null;
  scanCount: number;
  firstScannedAt: string | null;
  lastScannedAt: string | null;
  scans: Array<{
    id: string;
    operatorName: string;
    source: "camera" | "image" | "manual";
    capturedAt: string;
  }>;
  notes: Array<{
    id: string;
    operatorName: string;
    note: string | null;
    rating: number | null;
    createdAt: string;
  }>;
}

export async function listLeadRows(sponsorId?: number): Promise<LeadListRow[]> {
  const conditions: SQL[] = [];
  if (sponsorId) conditions.push(eq(sponsorLeadsTable.sponsorId, sponsorId));
  const leads = await db
    .select({
      lead: sponsorLeadsTable,
      attendee: attendeesTable,
      sponsorCompany: sponsorsTable.company,
    })
    .from(sponsorLeadsTable)
    .innerJoin(attendeesTable, eq(attendeesTable.id, sponsorLeadsTable.attendeeId))
    .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorLeadsTable.sponsorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sponsorLeadsTable.lastScannedAt), asc(attendeesTable.lastName));
  const leadIds = leads.map((row) => row.lead.id);
  const scans = leadIds.length
    ? await db
        .select()
        .from(sponsorLeadScanEventsTable)
        .where(inArray(sponsorLeadScanEventsTable.leadId, leadIds))
        .orderBy(desc(sponsorLeadScanEventsTable.capturedAt))
    : [];
  const notes = leadIds.length
    ? await db
        .select()
        .from(sponsorLeadNotesTable)
        .where(inArray(sponsorLeadNotesTable.leadId, leadIds))
        .orderBy(desc(sponsorLeadNotesTable.createdAt))
    : [];
  const scansByLead = new Map<string, LeadListRow["scans"]>();
  for (const scan of scans) {
    const items = scansByLead.get(scan.leadId) ?? [];
    items.push({
      id: scan.id,
      operatorName: scan.operatorName,
      source: scan.source,
      capturedAt: scan.capturedAt.toISOString(),
    });
    scansByLead.set(scan.leadId, items);
  }
  const notesByLead = new Map<string, LeadListRow["notes"]>();
  for (const note of notes) {
    const items = notesByLead.get(note.leadId) ?? [];
    items.push({
      id: note.id,
      operatorName: note.operatorName,
      note: note.note,
      rating: note.rating,
      createdAt: note.createdAt.toISOString(),
    });
    notesByLead.set(note.leadId, items);
  }
  return leads.map(({ lead, attendee, sponsorCompany }) => ({
    id: lead.id,
    sponsorId: lead.sponsorId,
    sponsorCompany,
    attendeeId: lead.attendeeId,
    firstName: attendee.firstName,
    lastName: attendee.lastName,
    name: `${attendee.firstName} ${attendee.lastName}`.trim(),
    jobTitle: attendee.jobTitle,
    company: attendee.company,
    workEmail: attendee.workEmail,
    rating: lead.rating,
    scanCount: lead.scanCount,
    firstScannedAt: lead.firstScannedAt?.toISOString() ?? null,
    lastScannedAt: lead.lastScannedAt?.toISOString() ?? null,
    scans: scansByLead.get(lead.id) ?? [],
    notes: notesByLead.get(lead.id) ?? [],
  }));
}

export async function addLeadAnnotation(input: {
  sponsorId: number;
  leadId: string;
  operatorName: string;
  note?: string | null;
  rating?: number | null;
}): Promise<void> {
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 4000) : null;
  const rating = Number.isInteger(input.rating) ? Number(input.rating) : null;
  if ((!note && rating === null) || (rating !== null && (rating < 1 || rating > 5))) {
    throw new Error("Add a note or choose a rating from 1 to 5");
  }
  await db.transaction(async (tx) => {
    const [lead] = await tx
      .select({ id: sponsorLeadsTable.id })
      .from(sponsorLeadsTable)
      .where(
        and(
          eq(sponsorLeadsTable.id, input.leadId),
          eq(sponsorLeadsTable.sponsorId, input.sponsorId),
        ),
      );
    if (!lead) throw new Error("Lead not found");
    await tx.insert(sponsorLeadNotesTable).values({
      id: uuidv4(),
      leadId: lead.id,
      operatorName: input.operatorName.trim().slice(0, 200) || "Sponsor team",
      note: note || null,
      rating,
    });
    if (rating !== null) {
      await tx
        .update(sponsorLeadsTable)
        .set({ rating, updatedAt: new Date() })
        .where(eq(sponsorLeadsTable.id, lead.id));
    }
  });
}

export interface BadgeExportRow {
  attendeeId: number;
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  qrCode: string;
  badgeVersion: number;
}

function badgeCsvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function badgeExportCsv(rows: BadgeExportRow[]): string {
  const headings = ["First Name", "Last Name", "Job Title", "Company", "QR Code"];
  const values = rows.map((row) => [
    row.firstName,
    row.lastName,
    row.jobTitle,
    row.company,
    row.qrCode,
  ]);
  return [headings, ...values].map((row) => row.map(badgeCsvCell).join(",")).join("\r\n");
}

export async function badgeExportRows(): Promise<BadgeExportRow[]> {
  const rows = await eligibleBadgeRows();
  return rows.map((row) => ({
    attendeeId: row.attendeeId,
    firstName: row.firstName,
    lastName: row.lastName,
    jobTitle: row.jobTitle,
    company: row.company,
    qrCode: row.code,
    badgeVersion: row.badgeVersion,
  }));
}
