import ExcelJS from "exceljs";
import type { Attendee, Booking } from "@workspace/db";

export const SESSION_SCHEDULER_HEADERS = ["Name", "Email", "Company", "Job Title"] as const;

type SchedulerBooking = Pick<Booking, "id" | "status">;
type SchedulerAttendee = Pick<
  Attendee,
  | "id"
  | "bookingId"
  | "firstName"
  | "lastName"
  | "company"
  | "jobTitle"
  | "workEmail"
  | "isTbc"
  | "updatedAt"
>;

export interface SessionSchedulerExportRow {
  Name: string;
  Email: string;
  Company: string;
  "Job Title": string;
}

interface SessionSchedulerExportCandidate extends SessionSchedulerExportRow {
  attendeeId: number;
  updatedAt: Date;
}

const ELIGIBLE_BOOKING_STATUSES = new Set<Booking["status"]>(["paid", "invoiced"]);

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isUsableSchedulerEmail(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > 254 || /\s/.test(email)) return false;
  if (email.toLowerCase().endsWith("@tbc.placeholder")) return false;

  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator !== email.indexOf("@")) return false;

  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (localPart.length > 64 || domain.length === 0 || !domain.includes(".")) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes(".."))
    return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;

  return domain.split(".").every((label) => {
    return (
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/i.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-")
    );
  });
}

function candidateIsNewer(
  candidate: SessionSchedulerExportCandidate,
  current: SessionSchedulerExportCandidate,
): boolean {
  const candidateUpdatedAt = candidate.updatedAt.getTime();
  const currentUpdatedAt = current.updatedAt.getTime();
  if (candidateUpdatedAt !== currentUpdatedAt) return candidateUpdatedAt > currentUpdatedAt;
  return candidate.attendeeId > current.attendeeId;
}

export function buildSessionSchedulerExportRows(
  bookings: readonly SchedulerBooking[],
  attendees: readonly SchedulerAttendee[],
): SessionSchedulerExportRow[] {
  const eligibleBookingIds = new Set(
    bookings
      .filter((booking) => ELIGIBLE_BOOKING_STATUSES.has(booking.status))
      .map((booking) => booking.id),
  );
  const attendeesByEmail = new Map<string, SessionSchedulerExportCandidate>();

  for (const attendee of attendees) {
    if (!eligibleBookingIds.has(attendee.bookingId) || attendee.isTbc) continue;

    const email = attendee.workEmail.trim();
    if (!isUsableSchedulerEmail(email)) continue;

    const candidate: SessionSchedulerExportCandidate = {
      attendeeId: attendee.id,
      updatedAt: attendee.updatedAt,
      Name: collapseWhitespace(`${attendee.firstName} ${attendee.lastName}`),
      Email: email,
      Company: attendee.company.trim(),
      "Job Title": attendee.jobTitle.trim(),
    };
    const key = email.toLowerCase();
    const current = attendeesByEmail.get(key);

    if (!current || candidateIsNewer(candidate, current)) {
      attendeesByEmail.set(key, candidate);
    }
  }

  return Array.from(attendeesByEmail.values())
    .map(({ Name, Email, Company, "Job Title": JobTitle }) => ({
      Name,
      Email,
      Company,
      "Job Title": JobTitle,
    }))
    .sort((left, right) => {
      const nameComparison = left.Name.localeCompare(right.Name, "en-GB", {
        sensitivity: "base",
      });
      if (nameComparison !== 0) return nameComparison;
      return left.Email.localeCompare(right.Email, "en-GB", { sensitivity: "base" });
    });
}

export function createSessionSchedulerWorkbook(
  rows: readonly SessionSchedulerExportRow[],
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SWP Summit";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Attendees", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: SESSION_SCHEDULER_HEADERS[0], key: "Name", width: 30 },
    { header: SESSION_SCHEDULER_HEADERS[1], key: "Email", width: 34 },
    { header: SESSION_SCHEDULER_HEADERS[2], key: "Company", width: 30 },
    { header: SESSION_SCHEDULER_HEADERS[3], key: "Job Title", width: 30 },
  ] as ExcelJS.Column[];
  sheet.addRows(rows.map((row) => ({ ...row })));
  sheet.autoFilter = `A1:D${Math.max(1, sheet.rowCount)}`;

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF004EB9" } };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 24;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: "middle" };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFE2E8F0" } },
        left: { style: "thin", color: { argb: "FFE2E8F0" } },
        bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
        right: { style: "thin", color: { argb: "FFE2E8F0" } },
      };
    });
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F6FF" } };
      });
    }
  });

  return workbook;
}

export function getSessionSchedulerExportFilename(date = new Date()): string {
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    dateParts.find((datePart) => datePart.type === type)?.value ?? "";

  return `swp27-session-scheduler-attendees-${part("year")}-${part("month")}-${part("day")}.xlsx`;
}
