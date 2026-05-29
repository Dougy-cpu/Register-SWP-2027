// Generates RFC 5545 iCalendar (.ics) content + Google/Outlook web calendar URLs.
// Used to embed "Add to Calendar" links in confirmation/welcome emails.

export type CalendarEvent = {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startAt: Date;
  endAt: Date;
  url?: string | null;
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Format date as UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ
export function formatIcsUtc(date: Date): string {
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

// Escape per RFC 5545 §3.3.11 — TEXT type
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// Fold lines longer than 75 octets per RFC 5545 §3.1
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (i === 0) {
      chunks.push(line.slice(0, 75));
      i = 75;
    } else {
      chunks.push(" " + line.slice(i, i + 74));
      i += 74;
    }
  }
  return chunks.join("\r\n");
}

export function buildIcs(event: CalendarEvent): string {
  const now = formatIcsUtc(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SWP Summit//Registration//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${now}`,
    `DTSTART:${formatIcsUtc(event.startAt)}`,
    `DTEND:${formatIcsUtc(event.endAt)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.url) lines.push(`URL:${escapeIcsText(event.url)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// Google Calendar quick-add URL.
// `tz` (IANA timezone) is optional but recommended — when supplied Google
// renders the event in that timezone instead of the viewer's local one.
export function buildGoogleCalendarUrl(event: CalendarEvent, tz?: string): string {
  const dates = `${formatIcsUtc(event.startAt)}/${formatIcsUtc(event.endAt)}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
  });
  if (event.description) params.set("details", event.description);
  if (event.location) params.set("location", event.location);
  if (tz) params.set("ctz", tz);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Outlook.com web calendar deeplink
export function buildOutlookCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.title,
    startdt: event.startAt.toISOString(),
    enddt: event.endAt.toISOString(),
  });
  if (event.description) params.set("body", event.description);
  if (event.location) params.set("location", event.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
