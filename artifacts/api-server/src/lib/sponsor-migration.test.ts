import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../../../../lib/db/migrations/20260901_001_sponsor_workspace.sql",
  import.meta.url,
);
const BASE_SCHEMA = `
  CREATE TYPE email_template_type AS ENUM (
    'welcome', 'confirmation', 'invoice_reminder', 'community_social'
  );
  CREATE TYPE email_log_type AS ENUM (
    'welcome', 'confirmation', 'invoice_reminder', 'community_social', 'test'
  );
  CREATE TABLE promo_codes (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE
  );
  CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    manual_entry BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE attendees (id SERIAL PRIMARY KEY);
  CREATE TABLE notification_emails (id SERIAL PRIMARY KEY);
  CREATE TABLE email_logs (id SERIAL PRIMARY KEY);
`;

const databases: PGlite[] = [];

async function baseDatabase(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(BASE_SCHEMA);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("sponsor workspace database migration", () => {
  it("applies to a clean application schema with its constraints intact", async () => {
    const database = await baseDatabase();
    const migration = await readFile(migrationUrl, "utf8");

    await database.exec(migration);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'sponsor%'
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "sponsors",
        "sponsor_contacts",
        "sponsor_sessions",
        "sponsor_assets",
        "sponsor_redemptions",
      ]),
    );

    await expect(
      database.exec(`
        INSERT INTO sponsors (
          company, package_label, vip_allocation, staff_allocation,
          vip_code_draft, public_code_draft
        ) VALUES ('Invalid allocation', 'Test', -1, 0, 'INVALIDVIP', 'INVALID');
      `),
    ).rejects.toThrow();
  });

  it("preserves existing records, backfills manual sources and is idempotent", async () => {
    const database = await baseDatabase();
    const migration = await readFile(migrationUrl, "utf8");
    await database.exec(`
      INSERT INTO promo_codes (code) VALUES ('EXISTING');
      INSERT INTO bookings (manual_entry, status) VALUES (TRUE, 'paid'), (FALSE, 'pending');
      INSERT INTO attendees DEFAULT VALUES;
      INSERT INTO notification_emails DEFAULT VALUES;
      INSERT INTO email_logs DEFAULT VALUES;
    `);

    await database.exec(migration);
    await database.exec(migration);

    const bookings = await database.query<{
      manual_entry: boolean;
      registration_source: string;
    }>(`
      SELECT manual_entry, registration_source::text AS registration_source
      FROM bookings
      ORDER BY id
    `);
    expect(bookings.rows).toEqual([
      { manual_entry: true, registration_source: "manual" },
      { manual_entry: false, registration_source: "checkout" },
    ]);

    const counts = await database.query<{
      promo_count: number;
      attendee_count: number;
      migration_count: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM promo_codes) AS promo_count,
        (SELECT count(*)::int FROM attendees) AS attendee_count,
        (SELECT count(*)::int FROM schema_migrations
          WHERE version = '20260901_001_sponsor_workspace') AS migration_count
    `);
    expect(counts.rows[0]).toEqual({ promo_count: 1, attendee_count: 1, migration_count: 1 });
  });
});
