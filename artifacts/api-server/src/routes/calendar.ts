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
  sendIcs(res, "hr-analytics-summit.ics", buildIcs(event));
});

router.get("/calendar/social.ics", async (_req, res): Promise<void> => {
  const settings = await getEventSettings();
  if (!settings.socialEnabled || !settings.socialStartAt || !settings.socialEndAt) {
    res.status(404).type("text/plain").send("Pre-event social is not configured.");
    return;
  }
  const start = new Date(settings.socialStartAt);
  const end = new Date(settings.socialEndAt);
  const event: CalendarEvent = {
    uid: `event-settings-${settings.id}-social@swpsummit.com`,
    title: settings.socialName || "Pre-Event Social",
    description: settings.socialDescription || null,
    location: settings.socialVenue || null,
    startAt: start,
    endAt: end,
    url: settings.orgWebsite,
  };
  sendIcs(res, "hr-analytics-summit-social.ics", buildIcs(event));
});

export default router;
