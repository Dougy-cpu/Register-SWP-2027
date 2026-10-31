import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LeadNotes } from "./scanner-lead-notes";
import { saveLeadDraft } from "@/lib/scanner-storage";
import type { ScannerCredential, SponsorLead } from "@/types/lead-scanner";

vi.mock("@/lib/scanner-storage", () => ({
  getLeadDraft: async () => null,
  saveLeadDraft: vi.fn(async () => {}),
  scannerScope: () => "swp-2027:1:rep-1-2",
}));
vi.mock("@/lib/scanner-api", () => ({ syncPendingScannerItems: async () => ({ remaining: 0 }) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

it("opens the rep's confirmed note on another device and never uploads an older local fallback over it", async () => {
  const credential: ScannerCredential = {
    id: "rep-1-2",
    operatorName: "Alex",
    sponsorId: 1,
    sponsorCompany: "Sample",
    token: "test",
    activatedAt: "2026-10-31",
  };
  const lead: SponsorLead = {
    id: "lead-1",
    sponsorId: 1,
    sponsorCompany: "Sample",
    attendeeId: 10,
    firstName: "Robin",
    lastName: "Example",
    name: "Robin Example",
    jobTitle: "Director",
    company: "Fictional",
    workEmail: "robin@example.invalid",
    rating: 4,
    scanCount: 2,
    firstScannedAt: null,
    lastScannedAt: null,
    scans: [
      {
        id: "first-scan",
        operatorId: "rep-1-1",
        operatorName: "Alex",
        source: "camera",
        capturedAt: "2026-10-31T09:00:00Z",
      },
      {
        id: "own-scan",
        operatorId: credential.id,
        operatorName: "Alex",
        source: "camera",
        capturedAt: "2026-10-31T09:10:00Z",
      },
    ],
    notes: [
      {
        id: "personal-note",
        operatorId: credential.id,
        operatorName: "Alex",
        note: "Meet on Friday",
        rating: 4,
        createdAt: "2026-10-31T09:30:00Z",
      },
    ],
  };
  localStorage.setItem(
    "swp-2027:1:rep-1-2:note-fallback:own-scan",
    JSON.stringify({ note: "Old draft", rating: 2, createdAt: "2026-10-31T09:20:00Z" }),
  );
  render(<LeadNotes credential={credential} lead={lead} />);
  const box = screen.getByRole("textbox");
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Meet on Friday"));
  expect(saveLeadDraft).not.toHaveBeenCalled();
  fireEvent.change(box, { target: { value: "Follow up Monday" } });
  await waitFor(() =>
    expect(saveLeadDraft).toHaveBeenCalledWith("own-scan", "Follow up Monday", 4, credential),
  );
});
