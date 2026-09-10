import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSponsorRoute, syncSponsorManifestLink } from "./App";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryHtml = readFileSync(resolve(checkoutRoot, "index.html"), "utf8");
const manifest = JSON.parse(
  readFileSync(resolve(checkoutRoot, "public/manifest.webmanifest"), "utf8"),
) as { scope: string; start_url: string; name: string };

describe("sponsor-scanner PWA manifest", () => {
  it("does not inject a manifest link into the shared checkout HTML", () => {
    expect(entryHtml).not.toMatch(/<link[^>]+rel=["']manifest["']/i);
  });

  it("recognises only sponsor routes for manifest linking", () => {
    expect(isSponsorRoute("/")).toBe(false);
    expect(isSponsorRoute("/admin/login")).toBe(false);
    expect(isSponsorRoute("/manage/example-token")).toBe(false);
    expect(isSponsorRoute("/sponsor")).toBe(true);
    expect(isSponsorRoute("/sponsor/scanner")).toBe(true);
  });

  it("adds and removes the manifest link with route changes", () => {
    syncSponsorManifestLink("/");
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();

    syncSponsorManifestLink("/sponsor/scanner");
    const link = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    expect(link?.href).toBe(`${window.location.origin}/manifest.webmanifest`);
    expect(link?.dataset.swpSponsorManifest).toBe("true");

    syncSponsorManifestLink("/admin");
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
  });

  it("keeps the install manifest scoped to the sponsor scanner", () => {
    expect(manifest.name).toBe("SWP Summit Sponsor Scanner");
    expect(manifest.scope).toBe("/sponsor/");
    expect(manifest.start_url).toBe("/sponsor/scanner");
  });
});
