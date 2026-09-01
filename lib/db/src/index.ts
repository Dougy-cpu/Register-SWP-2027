import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl =
  process.env.DATABASE_URL ??
  (process.env.NODE_ENV === "test" ? "postgresql://test:test@127.0.0.1:1/test" : undefined);

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: positiveIntFromEnv("DB_POOL_MAX", 5),
  idleTimeoutMillis: positiveIntFromEnv("DB_IDLE_TIMEOUT_MS", 30_000),
  connectionTimeoutMillis: positiveIntFromEnv("DB_CONNECTION_TIMEOUT_MS", 10_000),
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error", err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
