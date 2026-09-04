import type {
  PendingAnnotation,
  PendingScan,
  RejectedSyncItem,
  ScannerCredential,
  SponsorLead,
} from "@/types/lead-scanner";

// Pending people are visible before any network round trip. Server IDs replace local IDs
// without duplicating a person; the scan ID remains the durable annotation target.
export function mergeScannerLeads(
  confirmed: SponsorLead[],
  scans: PendingScan[],
  annotations: PendingAnnotation[],
  rejected: RejectedSyncItem[],
  credential: ScannerCredential,
): SponsorLead[] {
  const scope = `swp-2027:${credential.sponsorId}:${credential.id}`;
  scans = scans.filter((item) => item.scope === scope);
  annotations = annotations.filter((item) => item.scope === scope);
  rejected = rejected.filter((item) => item.scope === scope);
  const byPerson = new Map(
    confirmed
      .filter((lead) => lead.sponsorId === credential.sponsorId)
      .map((lead) => [
        String(lead.attendeeId),
        { ...lead, scans: [...lead.scans], notes: [...lead.notes] },
      ]),
  );
  const rejectedIds = new Set(
    rejected.filter((item) => item.kind === "scan").map((item) => item.payload.id),
  );
  const localScans = [
    ...scans,
    ...rejected.filter((item) => item.kind === "scan").map((item) => item.payload as PendingScan),
  ];
  for (const scan of localScans) {
    if (scan.code === "FFFFFFFFFFFF") continue;
    const attendee = scan.attendee,
      key = attendee ? String(attendee.attendeeId) : scan.id;
    let lead = byPerson.get(key);
    if (!lead) {
      lead = {
        id: scan.id,
        sponsorId: credential.sponsorId,
        sponsorCompany: credential.sponsorCompany,
        attendeeId: attendee?.attendeeId ?? 0,
        firstName: attendee?.firstName ?? "",
        lastName: attendee?.lastName ?? "",
        name: attendee?.name ?? "Badge awaiting check",
        company: attendee?.company ?? "",
        jobTitle: attendee?.jobTitle ?? "",
        workEmail: attendee?.workEmail ?? "",
        rating: null,
        scanCount: 0,
        firstScannedAt: scan.capturedAt,
        lastScannedAt: scan.capturedAt,
        scans: [],
        notes: [],
        localStatus: rejectedIds.has(scan.id) ? "rejected" : attendee ? "pending" : "checking",
      };
      byPerson.set(key, lead);
    }
    if (!lead.scans.some((item) => item.id === scan.id)) {
      lead.scans.push({
        id: scan.id,
        capturedAt: scan.capturedAt,
        source: scan.source,
        operatorName: credential.operatorName,
      });
      lead.scanCount++;
    }
  }
  for (const annotation of annotations) {
    const lead = [...byPerson.values()].find((item) =>
      item.scans.some((scan) => scan.id === annotation.scanId),
    );
    if (!lead) continue;
    lead.notes = lead.notes.filter((note) => note.id !== annotation.id);
    lead.notes.unshift({
      id: annotation.id,
      operatorName: credential.operatorName,
      note: annotation.note,
      rating: annotation.rating,
      createdAt: annotation.createdAt,
    });
    lead.rating = annotation.rating;
  }
  return [...byPerson.values()].sort((a, b) =>
    (b.lastScannedAt ?? "").localeCompare(a.lastScannedAt ?? ""),
  );
}
