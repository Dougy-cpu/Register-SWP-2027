import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps updates opt-in and static offline caching scoped to sponsor pages", async () => {
  const [config, main, updates] = await Promise.all([
    readFile(resolve(process.cwd(), "artifacts/checkout/vite.config.ts"), "utf8"),
    readFile(resolve(process.cwd(), "artifacts/checkout/src/main.tsx"), "utf8"),
    readFile(resolve(process.cwd(), "artifacts/checkout/src/lib/scanner-updates.ts"), "utf8"),
  ]);
  expect(config).toContain('scope: "/sponsor/"');
  expect(config).toContain('registerType: "prompt"');
  expect(config).toContain("skipWaiting: false");
  expect(config).toContain("clientsClaim: false");
  expect(config).toContain("runtimeCaching: []");
  expect(updates).toContain('new CustomEvent("swp:update-ready")');
  expect(updates).toContain("if (approved)");
  expect(updates).toContain("scannerHasUnsettledWork()");
  expect(main).not.toContain("skipWaiting");
  expect(main).not.toContain("location.reload");
});
