import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import express from "express";
import ExcelJS from "exceljs";
import type {
  GetSponsorScannerTeam200,
  ScannerRepGrant,
  ScannerRepCredential,
  ScannerSyncResponse,
  ListSponsorLeads200,
} from "../../../../lib/api-zod/src/generated/types";
import { issueAdminToken } from "../middleware/admin-auth";
import { verifySponsorAccessToken } from "../middleware/sponsor-auth";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../lib/db/src/schema";
let database: PGlite;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let server: Server, base: string;
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: new Proxy({}, { get: (_, key) => Reflect.get(testDb, key) }),
}));
import { syncScannerBatch, listLeadRows } from "./lead-scanner";
import { scannerAuth, scannerTokenHash } from "../middleware/scanner-auth";
import { setSponsorSessionCookie } from "../middleware/sponsor-auth";
import scannerRouter from "../routes/lead-scanner";
const identity = { id: "phone-1", sponsorId: 1, operatorName: "Alex" };
const capturedAt = new Date().toISOString();
const scan = {
  id: "scan-000000000000001",
  code: "ABCDEF123456",
  source: "camera" as const,
  capturedAt,
};
beforeAll(async () => {
  database = new PGlite();
  testDb = drizzle(database, { schema });
  const attendeeColumns = Object.values(getTableColumns(schema.attendeesTable))
    .filter((column) => !["lead_sharing_notice_at", "lead_sharing_excluded"].includes(column.name))
    .map((column) => `"${column.name}" ${column.getSQLType()}`)
    .join(",");
  await database.exec(`CREATE TYPE email_template_type AS ENUM ('welcome','confirmation','invoice_reminder','community_social');
    CREATE TYPE email_log_type AS ENUM ('welcome','confirmation','invoice_reminder','community_social','test');
    CREATE TABLE promo_codes (id SERIAL PRIMARY KEY,code TEXT UNIQUE); CREATE TABLE bookings (id SERIAL PRIMARY KEY,manual_entry BOOLEAN DEFAULT FALSE,status TEXT);
    CREATE TABLE attendees (${attendeeColumns},PRIMARY KEY(id)); CREATE TABLE notification_emails (id SERIAL PRIMARY KEY); CREATE TABLE email_logs (id SERIAL PRIMARY KEY);
    CREATE TABLE event_settings (id SERIAL PRIMARY KEY,event_start_at TIMESTAMPTZ,event_end_at TIMESTAMPTZ);`);
  for (const migration of ["20260901_001_sponsor_workspace", "20260904_001_lead_scanner"])
    await database.exec(
      await readFile(
        new URL(`../../../../lib/db/migrations/${migration}.sql`, import.meta.url),
        "utf8",
      ),
    );
  await database.exec(`INSERT INTO event_settings (event_start_at,event_end_at) VALUES (NOW()-INTERVAL '1 hour',NOW()+INTERVAL '1 hour');
    INSERT INTO sponsors (id,company,package_label,status,vip_code_draft,public_code_draft) VALUES (1,'Sample','Test','confirmed','SAMPLEVIP','SAMPLE'),(2,'Other','Test','confirmed','OTHERVIP','OTHER');
    INSERT INTO bookings (id,status) VALUES (1,'paid');
    INSERT INTO attendees (id,booking_id,first_name,last_name,job_title,company,work_email,is_tbc,lead_sharing_excluded,lead_sharing_notice_at) VALUES (1,1,'Jamie','Example','Director','Sample','sample@example.invalid',false,false,NOW());
    INSERT INTO attendee_badges (attendee_id,code) VALUES (1,'ABCDEF123456');
    INSERT INTO sponsor_scanner_devices (id,sponsor_id,access_version,token_hash,operator_name) VALUES ('phone-1',1,1,'${scannerTokenHash("a".repeat(43))}','Alex'),('phone-2',2,1,'${scannerTokenHash("b".repeat(43))}','Other');`);
  const app = express();
  app.use(express.json());
  app.use(scannerRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test listener unavailable");
  base = `http://127.0.0.1:${address.port}`;
}, 20000);
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await database?.close();
});
function sponsorHeaders(id: number, version: number) {
  const cookies: Record<string, string> = {};
  setSponsorSessionCookie(
    {
      cookie: (name: string, value: string) => {
        cookies[name] = value;
      },
    } as never,
    id,
    version,
  );
  return {
    "Content-Type": "application/json",
    "x-sponsor-csrf": cookies.swp_sponsor_csrf,
    Cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  };
}
describe("scanner recovery and idempotent synchronisation", () => {
  it("returns a cacheable lead and deduplicates repeated delivery", async () => {
    const result = await syncScannerBatch(identity, [scan], []);
    expect(result.scans[0].status).toBe("accepted");
    expect(result.leads[0].name).toBe("Jamie Example");
    const again = await syncScannerBatch(identity, [scan], []);
    expect(again.scans[0].status).toBe("duplicate");
    expect(again.leads[0].scanCount).toBe(1);
    const other = await syncScannerBatch({ ...identity, id: "phone-2", sponsorId: 2 }, [scan], []);
    expect(other.scans[0].status).toBe("rejected");
    expect(other.leads).toEqual([]);
  });
  it("updates one personal note safely and ignores delayed older autosaves", async () => {
    const note = {
      id: "note-000000000000001",
      scanId: scan.id,
      note: "First draft",
      rating: 3,
      createdAt: capturedAt,
    };
    await syncScannerBatch(identity, [], [note]);
    await syncScannerBatch(
      identity,
      [],
      [
        {
          ...note,
          note: "Final notes",
          rating: 5,
          createdAt: new Date(Date.parse(capturedAt) + 1000).toISOString(),
        },
      ],
    );
    await syncScannerBatch(identity, [], [note]);
    const leads = await listLeadRows(1);
    expect(leads[0].notes).toHaveLength(1);
    expect(leads[0].notes[0].note).toBe("Final notes");
    expect(leads[0].rating).toBe(5);
    const missing = await syncScannerBatch(
      identity,
      [],
      [{ ...note, id: "note-000000000000002", scanId: "scan-awaiting-resolution" }],
    );
    expect(missing.annotations[0].status).toBe("deferred");
  });
  it("honours reusable rep access and reports two reps meeting one person, including retries and personal notes", async () => {
    await database.exec(`INSERT INTO bookings(id,status,sponsor_id,registration_source) VALUES (11,'paid',1,'sponsor_staff'),(12,'invoiced',1,'sponsor_staff'),(13,'paid',2,'sponsor_staff'),(14,'cancelled',1,'sponsor_staff');
      INSERT INTO attendees(id,booking_id,first_name,last_name,is_tbc) VALUES (11,11,'Alex','Stand',false),(12,12,'Alex','Stand',false),(13,13,'Other','Rep',false),(14,14,'Cancelled','Rep',false),(15,12,'TBC','Staff',true);
      INSERT INTO attendees(id,booking_id,first_name,last_name,job_title,company,work_email,is_tbc,lead_sharing_excluded,lead_sharing_notice_at) VALUES(21,1,'Robin','Visitor','Director','Fictional','robin@example.invalid',false,false,NOW());
      INSERT INTO attendee_badges(attendee_id,code) VALUES(21,'102030405060');`);
    const coordinator = sponsorHeaders(1, 1);
    const api = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
      fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const bearer = (token: string) => ({ Authorization: "Bearer " + token });
    const team = (await (
      await api("/sponsor/scanner/team", coordinator)
    ).json()) as GetSponsorScannerTeam200;
    expect(team.staff).toEqual([
      { id: "rep-1-11", name: "Alex Stand" },
      { id: "rep-1-12", name: "Alex Stand" },
    ]);
    expect(verifySponsorAccessToken(team.companyKey)).toBeNull();
    expect((await api("/scanner/leads", bearer(team.companyKey))).status).toBe(401);
    const roster = await (
      await api("/scanner-team/roster", {}, { companyKey: team.companyKey })
    ).json();
    expect(roster).toEqual({ sponsorId: 1, sponsorCompany: "Sample", staff: team.staff });
    expect(
      (await api("/sponsor/scanner/team/rep-1-11", { ...coordinator, "x-sponsor-csrf": "" }, {}))
        .status,
    ).toBe(403);
    expect((await api("/sponsor/scanner/team/rep-2-13", coordinator, {})).status).toBe(409);
    const grant = async (id: string, renew = false) =>
      (
        await api("/sponsor/scanner/team/" + id, coordinator, { renew })
      ).json() as Promise<ScannerRepGrant>;
    const a = await grant("rep-1-11"),
      b = await grant("rep-1-12");
    expect(a.token).toHaveLength(43);
    expect(a.pin).toMatch(/^\d{8}$/);
    expect((await grant(a.id)).token).toBe(a.token);
    const join = async (repId: string, pin: string) =>
      api("/scanner-team/access", {}, { companyKey: team.companyKey, repId, pin });
    expect((await join(a.id, a.pin === "00000000" ? "11111111" : "00000000")).status).toBe(403);
    expect((await join("rep-2-13", a.pin)).status).toBe(403);
    const fromPhone = await (await join(a.id, a.pin)).json(),
      fromTablet = (await (await join(a.id, a.pin)).json()) as ScannerRepCredential;
    expect(fromPhone).toEqual(fromTablet);
    expect(fromTablet.token).toBe(a.token);
    expect(fromTablet).not.toHaveProperty("pin");
    expect((await api("/sponsor/scanner/team", bearer(a.token))).status).toBe(401);
    expect((await api("/scanner/leads/export", bearer(a.token))).status).toBe(403);
    expect((await api("/sponsor/leads/export", bearer(a.token))).status).toBe(401);
    const send = async (rep: typeof a, id: string, note: string) => {
      const scan = { id, code: "102030405060", source: "camera", capturedAt };
      const result = await api("/scanner/sync", bearer(rep.token), {
        scans: [scan],
        annotations: note
          ? [{ id: "note-" + id, scanId: id, note, rating: 4, createdAt: capturedAt }]
          : [],
      });
      expect(result.status).toBe(200);
      return ((await result.json()) as ScannerSyncResponse).scans[0].status;
    };
    expect(await send(a, "registered-phone-receipt", "Meet on Friday")).toBe("accepted");
    expect(await send(a, "registered-tablet-receipt", "")).toBe("duplicate");
    expect(await send(a, "registered-phone-receipt", "Meet on Friday")).toBe("duplicate");
    expect(await send(b, "another-rep-badge-receipt", "Send the summary")).toBe("accepted");
    const saved = (await (await api("/sponsor/leads", coordinator)).json()) as ListSponsorLeads200;
    const contact = saved.leads.find((item: { attendeeId: number }) => item.attendeeId === 21);
    expect(contact?.scanCount).toBe(2);
    expect(contact?.notes.map((n) => n.operatorId).sort()).toEqual([a.id, b.id].sort());
    expect(saved.report.companies[0]).toMatchObject({
      sponsorId: 1,
      people: 2,
      scans: 3,
      reps: expect.arrayContaining([
        { id: a.id, name: "Alex Stand", scans: 1 },
        { id: b.id, name: "Alex Stand", scans: 1 },
      ]),
    });
    const csv = await (await api("/sponsor/leads/export?format=csv", coordinator)).text();
    expect(csv.split("robin@example.invalid")).toHaveLength(2);
    const foreignCsv = await (
      await api("/sponsor/leads/export?format=csv&sponsorId=1", sponsorHeaders(2, 1))
    ).text();
    expect(foreignCsv).not.toContain("robin@example.invalid");
    const xlsx = await api("/sponsor/leads/export?format=xlsx", coordinator);
    expect(xlsx.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await xlsx.arrayBuffer());
    expect(book.worksheets.map((s) => s.name)).toEqual(["Summary", "Company leads", "Rep scans"]);
    const credited: unknown[][] = [];
    book.getWorksheet("Rep scans")!.eachRow((row) => credited.push(row.values as unknown[]));
    const robin = credited.filter((row) => row.includes("robin@example.invalid"));
    expect(robin).toHaveLength(2);
    expect(robin.flat()).toEqual(
      expect.arrayContaining([a.id, b.id, "Meet on Friday", "Send the summary"]),
    );
    vi.stubEnv("ADMIN_PASSWORD", "fixture-password-for-scanner");
    try {
      const admin = { "x-admin-token": issueAdminToken("fixture-password-for-scanner").token };
      expect((await api("/admin/lead-scanner/leads/export", admin)).status).toBe(400);
      expect(
        await (await api("/admin/lead-scanner/leads/export?sponsorId=1&format=csv", admin)).text(),
      ).toContain("robin@example.invalid");
    } finally {
      vi.unstubAllEnvs();
    }
    const renewed = await grant(a.id, true);
    expect(renewed.id).toBe(a.id);
    expect(renewed.token).not.toBe(a.token);
    expect((await api("/scanner/leads", bearer(a.token))).status).toBe(401);
    expect((await join(a.id, a.pin)).status).toBe(403);
    await database.exec("UPDATE bookings SET status='cancelled' WHERE id=11");
    expect((await api("/scanner/leads", bearer(renewed.token))).status).toBe(401);
    expect((await join(a.id, renewed.pin)).status).toBe(403);
  });
  it("does not accept badges excluded from sharing and allows checking later after an eligible badge is issued", async () => {
    const queued = { ...scan, id: "scan-000000000000003", code: "ABCDEF654321" };
    expect((await syncScannerBatch(identity, [queued], [])).scans[0].status).toBe("rejected");
    await database.exec(
      "UPDATE attendee_badges SET code='ABCDEF654321',version=2 WHERE attendee_id=1",
    );
    expect((await syncScannerBatch(identity, [queued], [])).scans[0].status).toBe("duplicate");
    await database.exec("UPDATE attendees SET lead_sharing_excluded=true WHERE id=1");
    expect(
      (await syncScannerBatch(identity, [{ ...queued, id: "scan-000000000000004" }], [])).scans[0]
        .status,
    ).toBe("rejected");
  });
  it("distinguishes access rotation, explicit revocation and invalid credentials", async () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    const request = { headers: { authorization: `Bearer ${"a".repeat(43)}` } };
    await database.exec("UPDATE sponsors SET portal_access_version=2 WHERE id=1");
    await scannerAuth(request as never, response as never, next);
    expect(response.json).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "access_refresh" }),
    );
    await database.exec("UPDATE sponsor_scanner_devices SET revoked_at=NOW() WHERE id='phone-1'");
    await scannerAuth(request as never, response as never, next);
    expect(response.json).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "device_revoked" }),
    );
    await scannerAuth(
      { headers: { authorization: `Bearer ${"z".repeat(43)}` } } as never,
      response as never,
      next,
    );
    expect(response.json).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "invalid_device" }),
    );
    expect(next).not.toHaveBeenCalled();
  });
  it("renews only the same sponsor's phone, enforces CSRF and requires explicit restoration after revocation", async () => {
    const headers = sponsorHeaders(1, 2),
      body = JSON.stringify({ token: "a".repeat(43) });
    let response = await fetch(`${base}/sponsor/scanner/devices/phone-1/recover`, {
      method: "POST",
      headers,
      body,
    });
    expect(response.status).toBe(403);
    await database.exec("UPDATE sponsor_scanner_devices SET revoked_at=NULL WHERE id='phone-1'");
    response = await fetch(`${base}/sponsor/scanner/devices/phone-1/recover`, {
      method: "POST",
      headers,
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "phone-1",
      token: "a".repeat(43),
      sponsorId: 1,
    });
    response = await fetch(`${base}/sponsor/scanner/devices/phone-1/recover`, {
      method: "POST",
      headers: sponsorHeaders(2, 1),
      body,
    });
    expect(response.status).toBe(404);
    response = await fetch(`${base}/sponsor/scanner/devices/phone-1/recover`, {
      method: "POST",
      headers: { ...headers, "x-sponsor-csrf": "" },
      body,
    });
    expect(response.status).toBe(403);
    await database.exec("UPDATE sponsor_scanner_devices SET revoked_at=NOW() WHERE id='phone-1'");
    response = await fetch(`${base}/sponsor/scanner/devices/phone-1/restore`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(response.status).toBe(200);
    const renewed = (await response.json()) as { id: string; token: string };
    expect(renewed.id).toBe("phone-1");
    expect(renewed.token).not.toBe("a".repeat(43));
    expect(
      (
        await database.query(
          "SELECT scanner_device_id FROM sponsor_lead_scan_events WHERE id='scan-000000000000001'",
        )
      ).rows,
    ).toEqual([{ scanner_device_id: "phone-1" }]);
    response = await fetch(`${base}/scanner/leads`, {
      headers: { Authorization: `Bearer ${renewed.token}` },
    });
    expect(response.status).toBe(200);
    response = await fetch(`${base}/sponsor/scanner/devices`, {
      headers: { Authorization: `Bearer ${renewed.token}` },
    });
    expect(response.status).toBe(401);
  });
});
