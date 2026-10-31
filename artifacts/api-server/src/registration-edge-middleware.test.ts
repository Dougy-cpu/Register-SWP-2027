import type { Server } from "node:http";
import { afterAll, beforeAll, it, vi, expect } from "vitest";
const capture = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("./routes", async () => {
  const { Router } = await import("express");
  const routes = Router();
  routes.use((_req, res) => {
    res.status(204).end();
  });
  return { default: routes };
});
vi.mock("./lib/logger", async () => {
  const { default: pino } = await import("pino");
  return {
    logger: pino(
      { level: "info" },
      {
        write: (v: string) => {
          capture.lines.push(v);
        },
      },
    ),
  };
});
let server: Server, origin: string;
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "production");
  const app = (await import("./app")).default;
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw Error("missing test listener");
  origin = "http://127.0.0.1:" + addr.port;
});
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllEnvs();
});
it.each([
  ["by-session", "/api/bookings/by-session/", "GET"],
  ["by-management-token", "/api/bookings/by-management-token/", "GET"],
  ["management page", "/manage/", "GET"],
  ["sponsor landing page", "/sponsor/access/", "GET"],
  ["sponsor link", "/api/sponsor/access/", "POST"],
])("access logs must redact a %s credential", async (label, prefix, method) => {
  const sentinel = "synthetic-credential-" + label.replaceAll(" ", "-");
  const from = capture.lines.length;
  const res = await fetch(origin + prefix + sentinel, { method });
  expect([200, 204, 404]).toContain(res.status);
  const events = capture.lines
    .slice(from)
    .map((l) => JSON.parse(l))
    .filter((x) => x.req);
  expect(events.length).toBeGreaterThan(0);
  const persisted = events.some((e) => String(e.req.url).includes(sentinel));
  console.log("OBSERVED credential retained", label, persisted);
  expect(persisted).toBe(false);
});
it.each(["/api/bookings", "/api/bookings/start"])(
  "booking creation throttle covers %s",
  async (path) => {
    const responses: number[] = [];
    for (let i = 0; i < 11; i++)
      responses.push(
        (
          await fetch(origin + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      );
    console.log("OBSERVED 11th fake creation request", path, responses.at(-1));
    expect(responses.at(-1)).toBe(429);
  },
);
