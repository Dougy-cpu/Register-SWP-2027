import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { getPort } from "./lib/env";
import { seed, runMigrations } from "./lib/seed";
import { checkSchemaConsistency } from "./lib/schema-check";

const port = getPort();

let server: ReturnType<typeof app.listen> | null = null;
let shuttingDown = false;

function gracefulShutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutdown signal received");

  const forceExitTimer = setTimeout(() => {
    logger.error({ signal }, "Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  const closeServer = server
    ? new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      })
    : Promise.resolve();

  closeServer
    .then(() => pool.end())
    .then(() => {
      clearTimeout(forceExitTimer);
      logger.info({ signal }, "Shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      clearTimeout(forceExitTimer);
      logger.error({ err, signal }, "Shutdown failed");
      process.exit(1);
    });
}

process.once("SIGTERM", gracefulShutdown);
process.once("SIGINT", gracefulShutdown);

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

async function start() {
  await runMigrations();

  const schemaOk = await checkSchemaConsistency();
  if (!schemaOk) {
    logger.error(
      "Aborting: database schema is out of date. Run 'pnpm --filter @workspace/db run push' then redeploy.",
    );
    process.exit(1);
  }

  server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    seed().catch((seedErr) => logger.error({ err: seedErr }, "Seed failed"));
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

start().catch((err) => {
  logger.error({ err }, "Startup failed");
  process.exit(1);
});
