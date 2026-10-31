import { Router, type IRouter } from "express";
import { getEventSettings } from "../lib/email";
import { buildIcs, type CalendarEvent } from "../lib/ics";

const router: IRouter = Router();

function sendIcs(res: import("express").Response, filename: string, ics: string) {
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(ics);
}

router.get("/calendar/main.ics", async (_req, res): Promise<void> => {
  const settings = await getEventSettings();
  if (!settings.eventStartAt || !settings.eventEndAt) {
    res.status(404).type("text/plain").send("Event schedule not configured yet.");
    return;
  }
  const start = new Date(settings.eventStartAt);
  const end = new Date(settings.eventEndAt);
  const event: CalendarEvent = {
    uid: `event-settings-${settings.id}-main@swpsummit.com`,
    title: settings.eventName || "SWP Summit",
    description: settings.eventDescription || null,
    location: [settings.eventVenue, settings.eventVenuePostcode].filter(Boolean).join(", ") || null,
    startAt: start,
    endAt: end,
    url: settings.orgWebsite,
  };
  sendIcs(res, "swp-summit.ics", buildIcs(event));
});

// Old invitations may still contain this URL.
router.get("/calendar/social.ics", (_req, res) => {
  res.sendStatus(410);
});

export default router;
