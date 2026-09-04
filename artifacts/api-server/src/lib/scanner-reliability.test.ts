import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import express from "express";
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
  it("does not accept badges excluded from sharing and allows checking later after an eligible badge is issued", async () => {
    const queued = { ...scan, id: "scan-000000000000003", code: "ABCDEF654321" };
    expect((await syncScannerBatch(identity, [queued], [])).scans[0].status).toBe("rejected");
    await database.exec(
      "UPDATE attendee_badges SET code='ABCDEF654321',version=2 WHERE attendee_id=1",
    );
    expect((await syncScannerBatch(identity, [queued], [])).scans[0].status).toBe("accepted");
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
