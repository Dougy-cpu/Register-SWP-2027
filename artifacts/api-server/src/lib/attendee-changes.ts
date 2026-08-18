export interface AttendeeChangeSnapshot {
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  phone: string | null;
  dietaryAccessibility: string | null;
  gdprConsent: boolean;
  isTbc: boolean;
  isLead: boolean;
  seatIndex: number;
}

export type AttendeeChangeField =
  | "firstName"
  | "lastName"
  | "jobTitle"
  | "company"
  | "workEmail"
  | "phone"
  | "dietaryAccessibility"
  | "gdprConsent"
  | "isTbc";

export interface AttendeeFieldChange {
  field: AttendeeChangeField;
  label: string;
  previous: string;
  current: string;
}

interface AttendeeSnapshotSource {
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  phone: string | null;
  dietaryAccessibility: string | null;
  gdprConsent: boolean;
  isTbc: boolean;
  isLead: boolean;
  seatIndex: number;
}

const FIELD_DEFINITIONS: ReadonlyArray<{
  field: AttendeeChangeField;
  label: string;
}> = [
  { field: "firstName", label: "First name" },
  { field: "lastName", label: "Last name" },
  { field: "jobTitle", label: "Job title" },
  { field: "company", label: "Company" },
  { field: "workEmail", label: "Work email" },
  { field: "phone", label: "Phone" },
  { field: "dietaryAccessibility", label: "Dietary / accessibility requirements" },
  { field: "gdprConsent", label: "GDPR consent" },
  { field: "isTbc", label: "Attendee status" },
];

export function createAttendeeChangeSnapshot(
  attendee: AttendeeSnapshotSource,
): AttendeeChangeSnapshot {
  return {
    firstName: attendee.firstName,
    lastName: attendee.lastName,
    jobTitle: attendee.jobTitle,
    company: attendee.company,
    workEmail: attendee.workEmail,
    phone: attendee.phone,
    dietaryAccessibility: attendee.dietaryAccessibility,
    gdprConsent: attendee.gdprConsent,
    isTbc: attendee.isTbc,
    isLead: attendee.isLead,
    seatIndex: attendee.seatIndex,
  };
}

function comparableValue(value: string | boolean | null): string | boolean {
  return value ?? "";
}

function isTbcPlaceholderEmail(value: string | boolean | null): boolean {
  return typeof value === "string" && value.toLowerCase().endsWith("@tbc.placeholder");
}

function displayValue(field: AttendeeChangeField, value: string | boolean | null): string {
  if (field === "gdprConsent") return value === true ? "Agreed" : "Not agreed";
  if (field === "isTbc") return value === true ? "Details needed (TBC)" : "Details complete";
  if (field === "workEmail" && isTbcPlaceholderEmail(value)) return "Not provided";
  if (value === null || value === "" || (typeof value === "string" && value.trim() === "")) {
    return "Not provided";
  }
  return String(value);
}

export function getAttendeeFieldChanges(
  previous: AttendeeChangeSnapshot,
  current: AttendeeChangeSnapshot,
): AttendeeFieldChange[] {
  return FIELD_DEFINITIONS.flatMap(({ field, label }) => {
    const previousValue = previous[field];
    const currentValue = current[field];
    if (comparableValue(previousValue) === comparableValue(currentValue)) return [];

    return [
      {
        field,
        label,
        previous: displayValue(field, previousValue),
        current: displayValue(field, currentValue),
      },
    ];
  });
}

export function formatAttendeeSnapshotName(attendee: AttendeeChangeSnapshot): string {
  if (attendee.isTbc) return "TBC attendee";
  const name = `${attendee.firstName} ${attendee.lastName}`.trim();
  return name || "Not provided";
}

export function formatAttendeeSeatLabel(
  attendee: AttendeeChangeSnapshot,
  bookingQuantity: number,
): string {
  const seatNumber = Math.max(1, attendee.seatIndex + 1);
  const totalSeats = Math.max(1, seatNumber, bookingQuantity);
  return attendee.isLead
    ? `Lead attendee, seat ${seatNumber} of ${totalSeats}`
    : `Attendee ${seatNumber}, seat ${seatNumber} of ${totalSeats}`;
}
