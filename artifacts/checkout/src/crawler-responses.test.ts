import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  crawlerResponsesMiddleware,
  ROBOTS_TXT,
  SITEMAP_XML,
} from "./crawler-responses";

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticRobots = readFileSync(resolve(checkoutRoot, "public/robots.txt"), "utf8");
const staticSitemap = readFileSync(resolve(checkoutRoot, "public/sitemap.xml"), "utf8");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    crawlerResponsesMiddleware(request, response, () => {
      response.statusCode = 200;
      response.end("SPA fallback");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Checkout crawler test listener unavailable");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("checkout crawler responses", () => {
  it("serves the existing robots policy as plain text with query strings", async () => {
    const response = await fetch(`${baseUrl}/robots.txt?source=search`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(ROBOTS_TXT);
  });

  it("keeps the static and middleware robots policy identical", () => {
    expect(staticRobots).toBe(ROBOTS_TXT);
  });

  it("returns the static XML sitemap with query strings", async () => {
    const response = await fetch(`${baseUrl}/sitemap.xml?format=xml`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await response.text()).toBe(SITEMAP_XML);
  });

  it("keeps the static and middleware sitemap XML identical", () => {
    expect(staticSitemap).toBe(SITEMAP_XML);
  });

  it("passes ordinary routes through to the checkout fallback", async () => {
    const response = await fetch(`${baseUrl}/checkout?step=details`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SPA fallback");
  });
});