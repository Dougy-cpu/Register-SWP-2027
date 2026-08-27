import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { Attendee, Booking } from "@workspace/db";
import {
  buildSessionSchedulerExportRows,
  createSessionSchedulerWorkbook,
  getSessionSchedulerExportFilename,
  isUsableSchedulerEmail,
} from "./session-scheduler-export";

type TestBooking = Pick<Booking, "id" | "status">;
type TestAttendee = Pick<
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

function booking(id: number, status: Booking["status"]): TestBooking {
  return { id, status };
}

function attendee(overrides: Partial<TestAttendee> = {}): TestAttendee {
  return {
    id: 101,
    bookingId: 1,
    firstName: "Alice",
    lastName: "Smith",
    company: "Acme Ltd",
    jobTitle: "People Director",
    workEmail: "alice@example.com",
    isTbc: false,
    updatedAt: new Date("2026-08-27T09:00:00Z"),
    ...overrides,
  };
}

describe("buildSessionSchedulerExportRows", () => {
  it("includes paid and invoiced bookings and excludes all other states", () => {
    const bookings: TestBooking[] = [
      booking(1, "paid"),
      booking(2, "invoiced"),
      booking(3, "partial"),
      booking(4, "pending_payment"),
      booking(5, "cancelled"),
      booking(6, "refunded"),
      booking(7, "disputed"),
      booking(8, "transferred"),
    ];
    const attendees = [
      attendee({ id: 101, bookingId: 1, firstName: "Paid", workEmail: "paid@example.com" }),
      attendee({
        id: 102,
        bookingId: 2,
        firstName: "Invoiced",
        workEmail: "invoiced@example.com",
      }),
      attendee({ id: 103, bookingId: 3, workEmail: "partial@example.com" }),
      attendee({ id: 104, bookingId: 4, workEmail: "pending@example.com" }),
      attendee({ id: 105, bookingId: 5, workEmail: "cancelled@example.com" }),
      attendee({ id: 106, bookingId: 6, workEmail: "refunded@example.com" }),
      attendee({ id: 107, bookingId: 7, workEmail: "disputed@example.com" }),
      attendee({ id: 108, bookingId: 8, workEmail: "transferred@example.com" }),
      attendee({ id: 109, bookingId: 1, isTbc: true, workEmail: "tbc@example.com" }),
      attendee({ id: 110, bookingId: 1, workEmail: "not-an-email" }),
      attendee({ id: 111, bookingId: 1, workEmail: "seat-2@tbc.placeholder" }),
    ];

    expect(buildSessionSchedulerExportRows(bookings, attendees)).toEqual([
      {
        Name: "Invoiced Smith",
        Email: "invoiced@example.com",
        Company: "Acme Ltd",
        "Job Title": "People Director",
      },
      {
        Name: "Paid Smith",
        Email: "paid@example.com",
        Company: "Acme Ltd",
        "Job Title": "People Director",
      },
    ]);
  });

  it("normalises fields and keeps the latest case-insensitive email match", () => {
    const older = new Date("2026-08-27T08:00:00Z");
    const latest = new Date("2026-08-27T10:00:00Z");
    const rows = buildSessionSchedulerExportRows(
      [booking(1, "paid"), booking(2, "invoiced")],
      [
        attendee({
          id: 201,
          bookingId: 1,
          firstName: " Old ",
          lastName: " Record ",
          company: " Old Company ",
          jobTitle: " Old Title ",
          workEmail: " Person@Example.com ",
          updatedAt: older,
        }),
        attendee({
          id: 202,
          bookingId: 2,
          firstName: "Latest",
          lastName: "Record",
          company: " Latest Company ",
          jobTitle: " Latest Title ",
          workEmail: "person@example.com",
          updatedAt: latest,
        }),
        attendee({
          id: 203,
          bookingId: 1,
          firstName: "Tie",
          lastName: "Winner",
          company: " Tie Winner Ltd ",
          jobTitle: " Chief People Officer ",
          workEmail: "PERSON@example.com",
          updatedAt: latest,
        }),
      ],
    );

    expect(rows).toEqual([
      {
        Name: "Tie Winner",
        Email: "PERSON@example.com",
        Company: "Tie Winner Ltd",
        "Job Title": "Chief People Officer",
      },
    ]);
  });

  it("sorts predictably and grows when live input gains an attendee", () => {
    const bookings = [booking(1, "paid")];
    const initial = [
      attendee({ id: 301, firstName: "Zara", lastName: "Lane", workEmail: "zara@example.com" }),
      attendee({
        id: 302,
        firstName: "  Alice ",
        lastName: "  Smith  ",
        workEmail: "z@example.com",
      }),
    ];

    expect(buildSessionSchedulerExportRows(bookings, initial).map((row) => row.Email)).toEqual([
      "z@example.com",
      "zara@example.com",
    ]);

    const refreshedRows = buildSessionSchedulerExportRows(bookings, [
      ...initial,
      attendee({
        id: 303,
        firstName: "Alice",
        lastName: "Smith",
        workEmail: "a@example.com",
      }),
    ]);
    expect(refreshedRows).toHaveLength(3);
    expect(refreshedRows.map((row) => row.Email)).toEqual([
      "a@example.com",
      "z@example.com",
      "zara@example.com",
    ]);
    expect(refreshedRows[0]?.Name).toBe("Alice Smith");
  });
});

describe("Session Scheduler workbook", () => {
  it("round-trips through ExcelJS with the exact SWP worksheet contract", async () => {
    const workbook = createSessionSchedulerWorkbook([
      {
        Name: "Alice Smith",
        Email: "alice@example.com",
        Company: "Acme Ltd",
        "Job Title": "People Director",
      },
      {
        Name: "Ben Jones",
        Email: "ben@example.com",
        Company: "Example Group",
        "Job Title": "Workforce Planning Lead",
      },
    ]);
    const bytes = await workbook.xlsx.writeBuffer();
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(bytes);

    expect(reopened.creator).toBe("SWP Summit");
    expect(reopened.worksheets).toHaveLength(1);
    const sheet = reopened.worksheets[0];
    expect(sheet?.name).toBe("Attendees");
    expect([1, 2, 3, 4].map((column) => sheet?.getCell(1, column).value)).toEqual([
      "Name",
      "Email",
      "Company",
      "Job Title",
    ]);
    expect(sheet?.columnCount).toBe(4);
    expect(sheet?.getRow(2).values).toEqual([
      undefined,
      "Alice Smith",
      "alice@example.com",
      "Acme Ltd",
      "People Director",
    ]);
    expect(sheet?.getRow(3).values).toEqual([
      undefined,
      "Ben Jones",
      "ben@example.com",
      "Example Group",
      "Workforce Planning Lead",
    ]);
    expect(sheet?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet?.autoFilter).toBe("A1:D3");
    expect(sheet?.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF004EB9" } });
  });

  it("uses the required London-date filename", () => {
    expect(getSessionSchedulerExportFilename(new Date("2026-08-27T12:00:00Z"))).toBe(
      "swp27-session-scheduler-attendees-2026-08-27.xlsx",
    );
  });
});

describe("isUsableSchedulerEmail", () => {
  it.each([
    ["person@example.com", true],
    ["person+event@example.co.uk", true],
    ["not-an-email", false],
    ["person@localhost", false],
    ["seat@tbc.placeholder", false],
    ["person @example.com", false],
  ])("validates %s", (email, expected) => {
    expect(isUsableSchedulerEmail(email)).toBe(expected);
  });
});
