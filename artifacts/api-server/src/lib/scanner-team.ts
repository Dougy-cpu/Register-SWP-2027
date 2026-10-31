import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  bookingsTable,
  attendeesTable,
  sponsorScannerDevicesTable,
  sponsorsTable,
} from "@workspace/db";
import { scannerTokenHash } from "../middleware/scanner-auth";
import { scannerSignature } from "../middleware/sponsor-auth";

export const repId = (sponsorId: number, attendeeId: number) => `rep-${sponsorId}-${attendeeId}`;
export function sameSecret(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
export function companyKey(sponsorId: number, version: number) {
  return `${sponsorId}.${version}.${scannerSignature("team", sponsorId + "." + version)}`;
}
export async function companyForKey(key: unknown) {
  if (typeof key !== "string" || !/^\d{1,10}\.\d{1,10}\.[\w-]{43}$/.test(key)) return null;
  const [id, version] = key.split(".").map(Number);
  if (!sameSecret(key, companyKey(id, version))) return null;
  const [s] = await db
    .select({
      id: sponsorsTable.id,
      company: sponsorsTable.company,
      version: sponsorsTable.portalAccessVersion,
      status: sponsorsTable.status,
    })
    .from(sponsorsTable)
    .where(eq(sponsorsTable.id, id));
  return s && s.version === version && ["confirmed", "completed"].includes(s.status) ? s : null;
}
export function repSecrets(id: string, version: number, issuedAt: Date) {
  const input = [id, version, issuedAt.toISOString()].join("|");
  const token = scannerSignature("personal", input);
  const pin = (
    Buffer.from(scannerSignature("pin", input), "base64url").readUInt32BE(0) % 100_000_000
  )
    .toString()
    .padStart(8, "0");
  return { token, pin };
}
export async function scannerRoster(sponsorId: number) {
  const rows = await db
    .select({
      attendeeId: attendeesTable.id,
      firstName: attendeesTable.firstName,
      lastName: attendeesTable.lastName,
    })
    .from(attendeesTable)
    .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
    .where(
      and(
        eq(bookingsTable.sponsorId, sponsorId),
        eq(bookingsTable.registrationSource, "sponsor_staff"),
        inArray(bookingsTable.status, ["paid", "invoiced"]),
        eq(attendeesTable.isTbc, false),
      ),
    )
    .orderBy(attendeesTable.firstName, attendeesTable.lastName, attendeesTable.id);
  return rows.map((x) => ({
    id: repId(sponsorId, x.attendeeId),
    name: [x.firstName, x.lastName].filter(Boolean).join(" ").trim(),
  }));
}
// The existing scanner primary key is stable per registered person. The same rep's
// phone and iPad share attribution, while each browser retains its own offline queue.
export async function provisionRep(sponsorId: number, id: string, renew = false) {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select()
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId))
      .for("update");
    if (!s || !["confirmed", "completed"].includes(s.status)) return null;
    const attendeeId = Number(id.split("-")[2]);
    if (!Number.isSafeInteger(attendeeId) || attendeeId < 1 || id !== repId(sponsorId, attendeeId))
      return null;
    const [member] = await tx
      .select({ first: attendeesTable.firstName, last: attendeesTable.lastName })
      .from(attendeesTable)
      .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
      .where(
        and(
          eq(attendeesTable.id, attendeeId),
          eq(bookingsTable.sponsorId, sponsorId),
          eq(bookingsTable.registrationSource, "sponsor_staff"),
          inArray(bookingsTable.status, ["paid", "invoiced"]),
          eq(attendeesTable.isTbc, false),
        ),
      );
    if (!member) return null;
    const [old] = await tx
      .select()
      .from(sponsorScannerDevicesTable)
      .where(eq(sponsorScannerDevicesTable.id, id))
      .for("update");
    if (old && (old.revokedAt || old.accessVersion !== s.portalAccessVersion) && !renew)
      return null;
    const issued =
      old && !renew
        ? old.activatedAt
        : new Date(Math.max(Date.now(), (old?.activatedAt.getTime() ?? 0) + 1));
    const secrets = repSecrets(id, s.portalAccessVersion, issued);
    const operatorName = [member.first, member.last].filter(Boolean).join(" ").trim();
    const fields = {
      operatorName,
      tokenHash: scannerTokenHash(secrets.token),
      activatedAt: issued,
      accessVersion: s.portalAccessVersion,
    };
    if (old && !renew && old.tokenHash !== fields.tokenHash) return null;
    if (!old) await tx.insert(sponsorScannerDevicesTable).values({ id, sponsorId, ...fields });
    else if (renew || old.operatorName !== operatorName)
      await tx
        .update(sponsorScannerDevicesTable)
        .set({ ...fields, revokedAt: null, revokedReason: null, updatedAt: new Date() })
        .where(eq(sponsorScannerDevicesTable.id, id));
    return { id, sponsorId, operatorName, sponsorCompany: s.company, ...secrets };
  });
}
