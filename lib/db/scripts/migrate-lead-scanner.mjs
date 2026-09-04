import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

if (process.env.NODE_ENV === "production" && !process.env.PRODUCTION_BACKUP_REFERENCE) {
  throw new Error(
    "Refusing production migration without PRODUCTION_BACKUP_REFERENCE. Create and verify a production backup first, then provide its reference for this run.",
  );
}

const version = "20260904_001_lead_scanner";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(scriptDir, `../migrations/${version}.sql`);
const sql = await fs.readFile(migrationPath, "utf8");
const client = new pg.Client({ connectionString: databaseUrl });

await client.connect();
try {
  const existing = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS table_name",
  );
  if (existing.rows[0]?.table_name) {
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
      version,
    ]);
    if (applied.rowCount) {
      console.log(`Lead scanner migration ${version} already applied; no changes made.`);
      process.exitCode = 0;
    } else {
      await client.query(sql);
      console.log(`Applied migration ${version}.`);
    }
  } else {
    await client.query(sql);
    console.log(`Applied migration ${version}.`);
  }
} finally {
  await client.end();
}
