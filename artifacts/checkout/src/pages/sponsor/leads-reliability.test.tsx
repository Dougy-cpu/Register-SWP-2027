import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SponsorLeads from "./leads";
const fake = vi.hoisted(() => ({ download: vi.fn(), sync: vi.fn() }));
const owner = {
  id: "phone1",
  sponsorId: 1,
  sponsorCompany: "Sample",
  operatorName: "Alex",
  token: "t".repeat(43),
  activatedAt: "2026-09-10",
};
vi.mock("@/lib/scanner-api", () => ({
  ScannerApiError: class extends Error {},
  refreshScannerLeads: (...args: unknown[]) => fake.download(...args),
  syncPendingScannerItems: (...args: unknown[]) => fake.sync(...args),
  activateScanner: vi.fn(),
  scannerFetch: vi.fn(),
}));
vi.mock("@/lib/scanner-storage", () => ({
  getScannerCredential: async () => owner,
  cachedScannerLeads: async () => [],
  pendingScannerItems: async () => ({ scans: [], annotations: [] }),
  rejectedScannerItems: async () => [],
  saveScannerCredential: vi.fn(),
}));
vi.mock("@/components/scanner-recovery-tools", () => ({ ScannerRecoveryTools: () => null }));
vi.mock("@/components/scanner-lead-notes", () => ({ LeadNotes: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("uploads queued work independently of a stalled download, without trusting the online flag", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  fake.download.mockReturnValue(new Promise(() => undefined));
  fake.sync.mockResolvedValue({ remaining: 0, rejected: 0 });
  render(<SponsorLeads />);
  await screen.findByText("Your leads");
  await waitFor(() => expect(fake.download).toHaveBeenCalled());
  expect(fake.sync).toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("Opening saved leads…")).toBeNull());
});
