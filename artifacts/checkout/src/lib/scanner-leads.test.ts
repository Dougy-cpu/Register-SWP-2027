import { describe, expect, it } from "vitest";
import { mergeScannerLeads } from "./scanner-leads";
import type { ScannerCredential, PendingScan } from "@/types/lead-scanner";
const credential: ScannerCredential = {
  id: "phone1",
  sponsorId: 1,
  sponsorCompany: "Sample",
  operatorName: "Alex",
  token: "unused",
  activatedAt: "2026-09-04",
};
const scan: PendingScan = {
  id: "scan1",
  code: "ABCDEF123456",
  scope: "swp-2027:1:phone1",
  source: "camera",
  capturedAt: "2026-09-04T09:00:00Z",
  attendee: {
    attendeeId: 1,
    firstName: "Jamie",
    lastName: "Example",
    name: "Jamie Example",
    jobTitle: "Director",
    company: "Test",
    workEmail: "test@example.invalid",
  },
};
describe("immediate sponsor-scoped lead views", () => {
  it("shows pending and unresolved scans before there is a server copy", () => {
    const leads = mergeScannerLeads(
      [],
      [scan, { ...scan, id: "scan2", code: "FEDCBA123456", attendee: null }],
      [],
      [],
      credential,
    );
    expect(leads).toHaveLength(2);
    expect(leads[0].localStatus).toBe("pending");
    expect(leads[1].localStatus).toBe("checking");
    expect(leads[1].workEmail).toBe("");
  });
  it("merges server acknowledgement without doubling the person or count", () => {
    const [pending] = mergeScannerLeads([], [scan], [], [], credential);
    const confirmed = { ...pending, id: "server-lead", localStatus: undefined };
    const result = mergeScannerLeads([confirmed], [scan], [], [], credential);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("server-lead");
    expect(result[0].scanCount).toBe(1);
  });
  it("shows queued notes while offline and never mixes sponsors or phones", () => {
    const result = mergeScannerLeads(
      [],
      [scan, { ...scan, id: "foreign", scope: "swp-2027:2:phone2" }],
      [
        {
          id: "note1",
          scope: scan.scope,
          scanId: scan.id,
          note: "Follow up next week",
          rating: 4,
          createdAt: scan.capturedAt,
        },
        {
          id: "foreign-note",
          scope: "swp-2027:2:phone2",
          scanId: scan.id,
          note: "Private",
          rating: 5,
          createdAt: scan.capturedAt,
        },
      ],
      [],
      credential,
    );
    expect(result).toHaveLength(1);
    expect(result[0].notes).toHaveLength(1);
    expect(result[0].rating).toBe(4);
  });
});
