import { defineConfig } from "vitest/config";

// Root config for `vitest run` invoked at the repo top-level. Per-package
// vitest.config.ts files are picked up via `projects` (e.g. checkout uses
// jsdom + the @/ alias for component tests). Packages without a dedicated
// config fall back to the api-server entry below.
export default defineConfig({
  test: {
    projects: [
      "artifacts/checkout",
      {
        test: {
          name: "api-server",
          include: ["artifacts/api-server/src/**/*.test.{ts,tsx}", "lib/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],
  },
});
