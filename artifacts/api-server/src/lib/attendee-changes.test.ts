import { describe, expect, it } from "vitest";
import {
  formatAttendeeSeatLabel,
  formatAttendeeSnapshotName,
  getAttendeeFieldChanges,
  type AttendeeChangeSnapshot,
} from "./attendee-changes";

const baseAttendee: AttendeeChangeSnapshot = {
  firstName: "Alice",
  lastName: "Smith",
  jobTitle: "Head of People",
  company: "Acme Ltd",
  workEmail: "alice@acme.test",
  phone: null,
  dietaryAccessibility: null,
  gdprConsent: true,
  isTbc: false,
  isLead: true,
  seatIndex: 0,
};

describe("getAttendeeFieldChanges", () => {
  it("returns only fields whose stored values changed", () => {
    const current: AttendeeChangeSnapshot = {
      ...baseAttendee,
      firstName: "Alicia",
      jobTitle: "Chief People Officer",
      company: "Acme Group",
      workEmail: "alicia@acme.test",
    };

    expect(getAttendeeFieldChanges(baseAttendee, current)).toEqual([
      { field: "firstName", label: "First name", previous: "Alice", current: "Alicia" },
      {
        field: "jobTitle",
        label: "Job title",
        previous: "Head of People",
        current: "Chief People Officer",
      },
      { field: "company", label: "Company", previous: "Acme Ltd", current: "Acme Group" },
      {
        field: "workEmail",
        label: "Work email",
        previous: "alice@acme.test",
        current: "alicia@acme.test",
      },
    ]);
  });

  it("shows exact contact, dietary and consent values when they are added or removed", () => {
    const withRequirements: AttendeeChangeSnapshot = {
      ...baseAttendee,
      phone: "+44 7700 900 000",
      dietaryAccessibility: "Vegetarian and step-free access",
      gdprConsent: false,
    };

    expect(getAttendeeFieldChanges(baseAttendee, withRequirements)).toEqual([
      {
        field: "phone",
        label: "Phone",
        previous: "Not provided",
        current: "+44 7700 900 000",
      },
      {
        field: "dietaryAccessibility",
        label: "Dietary / accessibility requirements",
        previous: "Not provided",
        current: "Vegetarian and step-free access",
      },
      {
        field: "gdprConsent",
        label: "GDPR consent",
        previous: "Agreed",
        current: "Not agreed",
      },
    ]);

    const removed = getAttendeeFieldChanges(withRequirements, baseAttendee);
    expect(removed.find((change) => change.field === "phone")?.current).toBe("Not provided");
    expect(removed.find((change) => change.field === "dietaryAccessibility")?.current).toBe(
      "Not provided",
    );
  });

  it("returns no changes for an identical stored snapshot", () => {
    expect(getAttendeeFieldChanges(baseAttendee, { ...baseAttendee })).toEqual([]);
  });

  it("renders TBC completion without exposing the internal placeholder email", () => {
    const tbc: AttendeeChangeSnapshot = {
      ...baseAttendee,
      firstName: "TBC",
      lastName: "TBC",
      jobTitle: "TBC",
      workEmail: "tbc-101-2@tbc.placeholder",
      gdprConsent: false,
      isTbc: true,
      isLead: false,
      seatIndex: 2,
    };
    const completed: AttendeeChangeSnapshot = {
      ...baseAttendee,
      firstName: "Ben",
      lastName: "Jones",
      workEmail: "ben@example.test",
      isLead: false,
      seatIndex: 2,
    };

    const changes = getAttendeeFieldChanges(tbc, completed);
    expect(changes.find((change) => change.field === "workEmail")).toEqual({
      field: "workEmail",
      label: "Work email",
      previous: "Not provided",
      current: "ben@example.test",
    });
    expect(changes.find((change) => change.field === "isTbc")).toEqual({
      field: "isTbc",
      label: "Attendee status",
      previous: "Details needed (TBC)",
      current: "Details complete",
    });
    expect(JSON.stringify(changes)).not.toContain("@tbc.placeholder");
    expect(formatAttendeeSnapshotName(tbc)).toBe("TBC attendee");
    expect(formatAttendeeSnapshotName(completed)).toBe("Ben Jones");
  });
});

describe("formatAttendeeSeatLabel", () => {
  it("identifies the lead attendee and an additional attendee within a group booking", () => {
    expect(formatAttendeeSeatLabel(baseAttendee, 3)).toBe("Lead attendee, seat 1 of 3");
    expect(formatAttendeeSeatLabel({ ...baseAttendee, isLead: false, seatIndex: 1 }, 3)).toBe(
      "Attendee 2, seat 2 of 3",
    );
  });
});
