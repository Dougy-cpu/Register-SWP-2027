// Local-only UX preview. All API calls terminate here; no database, storage or email integration.
// Run: node artifacts/checkout/preview-sponsor-portal.mjs
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let fixture;
let makeStaff;
const previewPort = Number(process.env.SPONSOR_PREVIEW_PORT ?? 4174);
const previewDevices = [];
const vite = await createServer({
  configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: previewPort, strictPort: true },
  plugins: [
    {
      name: "local-sponsor-preview-api",
      transformIndexHtml() {
        return [
          {
            tag: "div",
            attrs: {
              style:
                "background:#fff3cd;color:#664d03;text-align:center;padding:8px;font:13px sans-serif",
            },
            children: "SAMPLE PREVIEW · No live data, uploads or emails",
            injectTo: "body-prepend",
          },
        ];
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = (request.url ?? "").split("?")[0];
          if (path === "/scanner-storage-check") {
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local scanner storage checks</title></head><body><h1>Local scanner storage checks</h1><p>Isolated sample data only. No live API, database, storage or email.</p><button>Run browser storage checks</button><pre style="white-space:pre-wrap"></pre><a href="/sponsor/scanner">Open sample scanner</a> · <a href="/sponsor/leads">Open sample leads</a><script type="module" src="/src/dev/scanner-storage-check.ts"></script></body></html>',
            );
            return;
          }
          if (!path.startsWith("/api/")) return next();
          const reply = (data, status = 200) => {
            response.statusCode = status;
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify(data));
          };
          if (!fixture) return reply({ error: "Preview is starting. Try again." }, 503);
          try {
            if (request.method === "GET" && path === "/api/sponsor/workspace")
              return reply(fixture);
            if (path === "/api/scanner/bootstrap")
              return reply({
                device: {
                  id: "preview-phone",
                  sponsorId: 90001,
                  sponsorCompany: "Sample Preview Sponsor",
                  operatorName: "Alex Preview",
                  packVersion: "sample",
                  currentPackVersion: "sample",
                  ready: true,
                  outOfDate: false,
                },
                scannerWindow: {
                  eventStartAt: new Date().toISOString(),
                  eventEndAt: new Date(Date.now() + 86400000).toISOString(),
                  scanClosesAt: new Date(Date.now() + 172800000).toISOString(),
                  scanningOpen: true,
                },
                testQrValue: "FFFFFFFFFFFF",
              });
            if (path === "/api/scanner/offline-pack")
              return reply({
                format: 1,
                version: "sample",
                generatedAt: new Date().toISOString(),
                refreshAfter: new Date(Date.now() + 3600000).toISOString(),
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
                keyContext: "sample",
                records: [],
              });
            if (path === "/api/scanner/leads" || path === "/api/sponsor/leads")
              return reply({ leads: [] });
            if (path === "/api/scanner/sync")
              return reply(
                { error: "Sample offline mode: your test leads stay on this phone." },
                503,
              );
            if (path === "/api/scanner/readiness") return reply({ success: true });
            if ((request.headers["content-type"] ?? "").includes("multipart"))
              return reply(
                {
                  error:
                    "This local preview does not store files. Upload behaviour is covered by isolated automated tests.",
                },
                400,
              );
            let raw = "";
            for await (const chunk of request) {
              raw += chunk;
              if (raw.length > 100_000) return reply({ error: "Preview request too large" }, 413);
            }
            const body = raw ? JSON.parse(raw) : {};
            if (path === "/api/sponsor/scanner/devices") {
              if (request.method === "GET") return reply({ devices: previewDevices });
              const device = {
                id: `preview-${previewDevices.length + 1}`,
                operatorName: body.operatorName,
                revokedAt: null,
                lastSyncedAt: null,
                token: "p".repeat(43),
                sponsorId: 90001,
                sponsorCompany: "Sample Preview Sponsor",
              };
              previewDevices.push(device);
              return reply(device, 201);
            }
            if (path.startsWith("/api/admin/sponsors/attention"))
              return reply({
                items: [
                  {
                    sponsorId: fixture.id,
                    company: fixture.company,
                    label: "Review Quickfire session",
                    section: "sessions",
                  },
                  {
                    sponsorId: fixture.id,
                    company: fixture.company,
                    label: "Decide pass request: 2 VIP / 1 staff",
                    section: "requests",
                  },
                ],
              });
            const sessionMatch = path.match(/^\/api\/sponsor\/sessions\/(\d+)(\/submit)?$/);
            if (sessionMatch) {
              const session = fixture.sessions.find((item) => item.id === Number(sessionMatch[1]));
              if (!session) return reply({ error: "Session not found" }, 404);
              if (
                body.expectedRevision !== undefined &&
                body.expectedRevision !== session.currentRevision
              )
                return reply(
                  { error: "This session was updated elsewhere. Refresh your saved details." },
                  409,
                );
              {
                Object.assign(session, body, { currentRevision: session.currentRevision + 1 });
                session.presenters = session.presenters.map((person, index) => ({
                  ...person,
                  id: person.id ?? session.id * 100 + index,
                }));
              }
              session.status = sessionMatch[2] ? "submitted" : "draft";
              return reply(session);
            }
            if (path === "/api/sponsor/onsite-contact" && request.method === "PUT") {
              let contact = fixture.contacts.find((person) => person.id === body.id);
              if (!contact) {
                contact = { id: Date.now(), isPrimary: false };
                fixture.contacts.push(contact);
              }
              Object.assign(contact, body, { role: "onsite" });
              return reply(contact);
            }
            if (path.match(/^\/api\/sponsor\/tasks\/(staff|community_social)\/complete$/)) {
              const task = fixture.tasks.find((item) => item.taskKey === path.split("/")[4]);
              Object.assign(task, { status: "completed", completedAt: new Date().toISOString() });
              return reply(task);
            }
            if (path === "/api/sponsor/staff" && request.method === "POST") {
              const member = makeStaff({ ...body, bookingId: Date.now(), attendeeId: Date.now() });
              fixture.staff.push(member);
              fixture.sponsor.staffUsed++;
              fixture.tasks
                .filter((task) => ["staff", "community_social"].includes(task.taskKey))
                .forEach((task) => {
                  task.status = "todo";
                });
              return reply(member, 201);
            }
            if (path.match(/^\/api\/sponsor\/staff\/\d+$/)) {
              const member = fixture.staff.find(
                (person) => person.bookingId === Number(path.split("/").at(-1)),
              );
              if (!member) return reply({ error: "Team member not found" }, 404);
              if (request.method === "DELETE") {
                member.status = "cancelled";
                fixture.sponsor.staffUsed--;
              } else Object.assign(member, body);
              fixture.tasks
                .filter((task) => ["staff", "community_social"].includes(task.taskKey))
                .forEach((task) => {
                  task.status = "todo";
                });
              return reply(member);
            }
            if (path === "/api/sponsor/pass-requests") {
              const passRequest = {
                ...body,
                id: Date.now(),
                status: "open",
                createdAt: new Date().toISOString(),
                resolvedAt: null,
              };
              fixture.passRequests ??= [];
              fixture.passRequests.push(passRequest);
              return reply(passRequest, 201);
            }
            return reply({ error: "This action is not enabled in the local sample preview." }, 404);
          } catch {
            reply({ error: "The local preview could not complete this action." }, 400);
          }
        });
      },
    },
  ],
});
const samples = await vite.ssrLoadModule("/src/pages/sponsor/__fixtures__/portal.ts");
fixture = samples.createPortalFixture();
makeStaff = samples.makeStaff;
await vite.listen();
console.log(
  `Local sample sponsor portal: http://127.0.0.1:${previewPort}/sponsor (no emails or live data)`,
);
