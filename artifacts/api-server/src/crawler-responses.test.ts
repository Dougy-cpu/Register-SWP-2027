import express, { type Express } from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCrawlerResponses, ROBOTS_TXT } from "./crawler-responses";

let server: Server;
let baseUrl: string;

function startServer(app: Express): Promise<void> {
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Crawler test listener unavailable");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

beforeAll(async () => {
  const app = express();
  registerCrawlerResponses(app);
  app.get("/checkout", (_request, response) => response.send("SPA fallback"));
  await startServer(app);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("crawler responses", () => {
  it("serves UTF-8 plain-text robots rules for the public root and private app groups", async () => {
    const response = await fetch(`${baseUrl}/robots.txt`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain; charset=utf-8$/);
    expect(body).toBe(ROBOTS_TXT);
    expect(body).toContain("User-agent: *\n");
    expect(body).toContain("Allow: /\n");
    for (const path of ["/admin/", "/sponsor/", "/manage/", "/api/"]) {
      expect(body).toContain(`Disallow: ${path}\n`);
    }
    expect(body).not.toContain("<html");
  });

  it("returns a plain-text 404 for the nonexistent sitemap", async () => {
    const response = await fetch(`${baseUrl}/sitemap.xml`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain; charset=utf-8$/);
    expect(await response.text()).toBe("Sitemap not found.\n");
  });

  it("does not intercept ordinary application routes", async () => {
    const response = await fetch(`${baseUrl}/checkout`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SPA fallback");
  });
});