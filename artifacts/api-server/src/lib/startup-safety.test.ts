import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release startup safeguards", () => {
  it("checks the schema without invoking legacy migrations or default-data updates", () => {
    const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(entry).toContain("await checkSchemaConsistency()");
    expect(entry).not.toMatch(/\b(?:seed|runMigrations)\s*\(/);
    expect(entry).not.toMatch(/from\s+["'][^"']*\/seed["']/);
  });

  it("does not apply database changes as a side effect of pulling source", () => {
    const postMerge = readFileSync(
      new URL("../../../../scripts/post-merge.sh", import.meta.url),
      "utf8",
    );
    expect(postMerge).toContain("pnpm install --frozen-lockfile");
    const commands = postMerge
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(commands).not.toMatch(/(?:db|drizzle|migrat|seed)/i);
  });
});
