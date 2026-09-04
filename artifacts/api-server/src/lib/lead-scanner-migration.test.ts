import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const sponsorMigrationUrl = new URL(
  "../../../../lib/db/migrations/20260901_001_sponsor_workspace.sql",
  import.meta.url,
);
const scannerMigrationUrl = new URL(
  "../../../../lib/db/migrations/20260904_001_lead_scanner.sql",
  import.meta.url,
);

const BASE_SCHEMA = `
  CREATE TYPE email_template_type AS ENUM (
    'welcome', 'confirmation', 'invoice_reminder', 'community_social'
  );
  CREATE TYPE email_log_type AS ENUM (
    'welcome', 'confirmation', 'invoice_reminder', 'community_social', 'test'
  );
  CREATE TABLE promo_codes (id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE);
  CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    manual_entry BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE attendees (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER REFERENCES bookings(id),
    is_tbc BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE TABLE notification_emails (id SERIAL PRIMARY KEY);
  CREATE TABLE email_logs (id SERIAL PRIMARY KEY);
`;

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function migratedDatabase(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(BASE_SCHEMA);
  await database.exec(await readFile(sponsorMigrationUrl, "utf8"));
  return database;
}

describe("lead scanner database migration", () => {
  it("is additive, idempotent and preserves existing attendees", async () => {
    const database = await migratedDatabase();
    await database.exec(`
      INSERT INTO bookings (manual_entry, status) VALUES (FALSE, 'paid');
      INSERT INTO attendees (booking_id) VALUES (1);
    `);
    const migration = await readFile(scannerMigrationUrl, "utf8");
    await database.exec(migration);
    await database.exec(migration);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'attendee_badges', 'sponsor_scanner_devices', 'sponsor_leads',
          'sponsor_lead_scan_events', 'sponsor_lead_notes'
        )
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "attendee_badges",
      "sponsor_lead_notes",
      "sponsor_lead_scan_events",
      "sponsor_leads",
      "sponsor_scanner_devices",
    ]);

    const attendee = await database.query<{
      lead_sharing_excluded: boolean;
      lead_sharing_notice_at: Date | null;
    }>("SELECT lead_sharing_excluded, lead_sharing_notice_at FROM attendees WHERE id = 1");
    expect(attendee.rows[0]).toEqual({
      lead_sharing_excluded: false,
      lead_sharing_notice_at: null,
    });
    const applied = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM schema_migrations
      WHERE version = '20260904_001_lead_scanner'
    `);
    expect(applied.rows[0]?.count).toBe(1);
  });

  it("enforces badge shape, per-sponsor deduplication and rating bounds", async () => {
    const database = await migratedDatabase();
    await database.exec(await readFile(scannerMigrationUrl, "utf8"));
    await database.exec(`
      INSERT INTO bookings (manual_entry, status) VALUES (FALSE, 'paid');
      INSERT INTO attendees (booking_id) VALUES (1);
      INSERT INTO sponsors (
        company, package_label, vip_allocation, staff_allocation,
        vip_code_draft, public_code_draft
      ) VALUES ('Sponsor', 'Partner', 0, 0, 'VIP', 'PUBLIC');
      INSERT INTO attendee_badges (attendee_id, code) VALUES (1, 'CC4FFD33219D');
      INSERT INTO sponsor_leads (id, sponsor_id, attendee_id) VALUES ('lead-1', 1, 1);
    `);
    await expect(
      database.exec("INSERT INTO attendee_badges (attendee_id, code) VALUES (1, 'not-a-code')"),
    ).rejects.toThrow();
    await expect(
      database.exec(
        "INSERT INTO sponsor_leads (id, sponsor_id, attendee_id) VALUES ('lead-2', 1, 1)",
      ),
    ).rejects.toThrow();
    await expect(
      database.exec("UPDATE sponsor_leads SET rating = 6 WHERE id = 'lead-1'"),
    ).rejects.toThrow();
  });

  it("supports the planned 500 attendees, 50 sponsors and 150 scanner devices", async () => {
    const database = await migratedDatabase();
    await database.exec(await readFile(scannerMigrationUrl, "utf8"));
    await database.exec(`
      INSERT INTO bookings (manual_entry, status)
      SELECT FALSE, 'paid' FROM generate_series(1, 500);

      INSERT INTO attendees (booking_id, lead_sharing_notice_at)
      SELECT id, NOW() FROM bookings ORDER BY id LIMIT 500;

      INSERT INTO sponsors (
        company, package_label, status, vip_allocation, staff_allocation,
        vip_code_draft, public_code_draft
      )
      SELECT
        'Sponsor ' || value,
        'Partner',
        'confirmed',
        0,
        0,
        'VIP-' || value,
        'PUBLIC-' || value
      FROM generate_series(1, 50) AS series(value);

      INSERT INTO attendee_badges (attendee_id, code)
      SELECT id, upper(lpad(to_hex(id), 12, '0')) FROM attendees;

      INSERT INTO sponsor_scanner_devices (
        id, sponsor_id, access_version, token_hash, operator_name
      )
      SELECT
        'device-' || value,
        ((value - 1) % 50) + 1,
        1,
        'token-hash-' || value,
        'Operator ' || value
      FROM generate_series(1, 150) AS series(value);

      INSERT INTO sponsor_leads (id, sponsor_id, attendee_id, scan_count)
      SELECT 'lead-' || id, id, 1, 1 FROM sponsors;
    `);

    const counts = await database.query<{
      attendees: number;
      badges: number;
      sponsors: number;
      devices: number;
      isolated_leads: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM attendees) AS attendees,
        (SELECT count(*)::int FROM attendee_badges) AS badges,
        (SELECT count(*)::int FROM sponsors) AS sponsors,
        (SELECT count(*)::int FROM sponsor_scanner_devices) AS devices,
        (SELECT count(*)::int FROM sponsor_leads WHERE attendee_id = 1) AS isolated_leads
    `);
    expect(counts.rows[0]).toEqual({
      attendees: 500,
      badges: 500,
      sponsors: 50,
      devices: 150,
      isolated_leads: 50,
    });

    await expect(
      database.exec(
        "INSERT INTO sponsor_leads (id, sponsor_id, attendee_id) VALUES ('duplicate', 1, 1)",
      ),
    ).rejects.toThrow();
  });
});
