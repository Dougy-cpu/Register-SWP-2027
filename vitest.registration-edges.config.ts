import { defineConfig } from "vitest/config";

// Run explicitly against a disposable loopback PostgreSQL instance.
export default defineConfig({
  test: {
    include: ["artifacts/api-server/src/routes/registration-edge-audit.integration.ts"],
    environment: "node",
    env: { QA_STREAM_FAILURE: "1" },
  },
});
