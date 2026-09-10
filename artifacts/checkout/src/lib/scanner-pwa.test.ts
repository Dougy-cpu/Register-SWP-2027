import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps updates opt-in and static offline caching scoped to sponsor pages", async () => {
  const [config, main] = await Promise.all([
    readFile(resolve(process.cwd(), "artifacts/checkout/vite.config.ts"), "utf8"),
    readFile(resolve(process.cwd(), "artifacts/checkout/src/main.tsx"), "utf8"),
  ]);
  expect(config).toContain('scope: "/sponsor/"');
  expect(config).toContain('registerType: "prompt"');
  expect(config).toContain("skipWaiting: false");
  expect(config).toContain("clientsClaim: false");
  expect(config).toContain("runtimeCaching: []");
  expect(main).toContain('new CustomEvent("swp:update-ready")');
  expect(main).not.toContain("skipWaiting");
  expect(main).not.toContain("location.reload");
});
