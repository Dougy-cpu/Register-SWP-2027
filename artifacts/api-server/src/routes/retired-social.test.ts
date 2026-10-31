import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), settings: vi.fn(), mail: vi.fn() }));
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema")),
  db: { select: mocks.select },
}));
vi.mock("../middleware/admin-auth", () => ({
  adminAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../lib/email", async (original) => ({
  ...(await original<typeof import("../lib/email")>()),
  getEventSettings: mocks.settings,
  sendMail: mocks.mail,
}));
import calendar from "./calendar";
import emails from "./email";

describe("retired Community Social endpoints", () => {
  let server: ReturnType<express.Express["listen"]>;
  let origin: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", calendar, emails);
    await new Promise<void>((ready, reject) => {
      server = app.listen(0, "127.0.0.1", () => ready());
      server.once("error", reject);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({
      id: 1,
      eventName: "SWP Summit",
      eventDate: "3 March 2027",
      eventVenue: "London",
      eventVenuePostcode: "EC2V 5DD",
      orgName: "People Strategy Hub",
      orgAddress: "London",
      orgWebsite: "https://swpsummit.com",
      fromName: "SWP Summit",
      fromEmail: "summit@example.invalid",
      attendeeChangesLocked: false,
      refPrefix: "SWP27",
      refOffset: 0,
      eventTimezone: "Europe/London",
      updatedAt: new Date(),
      eventStartAt: new Date("2027-03-03T09:00:00Z"),
      eventEndAt: new Date("2027-03-03T17:00:00Z"),
      socialEnabled: true,
      socialName: "Community Social",
      socialStartAt: new Date("2027-03-02T18:00:00Z"),
      socialEndAt: new Date("2027-03-02T20:00:00Z"),
    });
  });

  it("retires the old calendar URL even if a saved event is enabled, while the summit ICS downloads", async () => {
    const retired = await fetch(`${origin}/calendar/social.ics`);
    expect(retired.status).toBe(410);
    expect(await retired.text()).not.toContain("BEGIN:VEVENT");
    const summit = await fetch(`${origin}/calendar/main.ics`);
    expect(summit.status).toBe(200);
    expect(await summit.text()).toContain("SUMMARY:SWP Summit");
    const settings = (await (await fetch(`${origin}/admin/event-settings`)).json()) as Record<
      string,
      unknown
    >;
    expect(settings.eventName).toBe("SWP Summit");
    expect(Object.keys(settings).some((key) => key.startsWith("social"))).toBe(false);
  });

  it.each([
    ["GET", ""],
    ["PUT", ""],
    ["POST", "/preview"],
    ["POST", "/test-send"],
  ])(
    "rejects the old %s template action %s before reading or sending a saved invitation",
    async (method, action) => {
      const response = await fetch(`${origin}/email-templates/community_social${action}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method !== "GET" && { body: JSON.stringify({ toEmail: "sample@example.invalid" }) }),
      });
      expect(response.status).toBe(400);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.mail).not.toHaveBeenCalled();
    },
  );

  it("shows the summit calendar token in an existing welcome template without the retired token", async () => {
    mocks.select.mockReturnValue({
      from: () => ({
        where: async () => [
          {
            type: "welcome",
            subject: "Welcome",
            htmlBody: "<p>Welcome</p>{{socialCalendarLinks}}{{eventCalendarLinks}}",
            updatedAt: new Date(),
          },
        ],
      }),
    });
    const response = await fetch(`${origin}/email-templates/welcome`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      htmlBody: "<p>Welcome</p>{{eventCalendarLinks}}",
    });
  });
});
