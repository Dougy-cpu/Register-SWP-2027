import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SponsorScanner from "./scanner";
const fake = vi.hoisted(() => ({
  decode: null as null | ((value: { data: string }) => void),
  bootstrap: vi.fn(),
  lookup: vi.fn(),
  queue: vi.fn(),
  stop: vi.fn(),
  sync: vi.fn(),
}));
const credential = {
  id: "phone1",
  token: "x".repeat(43),
  operatorName: "Alex",
  sponsorId: 1,
  sponsorCompany: "Sample",
  activatedAt: "2026-09-04",
};
const state = {
  device: { id: "phone1", sponsorId: 1, outOfDate: false },
  scannerWindow: { scanningOpen: true, scanClosesAt: "2027-03-05" },
  testQrValue: "FFFFFFFFFFFF",
};
const pack = {
  key: "current",
  format: 1,
  version: "v1",
  keyContext: "test",
  records: [],
  expiresAt: "2027-03-05",
};
vi.mock("@/lib/scanner-api", () => ({
  ScannerApiError: class extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
    ) {
      super(message);
    }
  },
  getScannerBootstrap: (...args: unknown[]) => fake.bootstrap(...args),
  lookupScannerBadge: (...args: unknown[]) => fake.lookup(...args),
  syncPendingScannerItems: (...args: unknown[]) => fake.sync(...args),
  updateReadiness: vi.fn(async () => undefined),
  downloadOfflinePack: vi.fn(),
  activateScanner: vi.fn(),
  recoverScanner: vi.fn(),
  importScannerLink: vi.fn(),
}));
vi.mock("@/lib/scanner-storage", () => ({
  getScannerCredential: vi.fn(async () => credential),
  getOfflinePack: vi.fn(async () => pack),
  cachedScannerBootstrap: vi.fn(async () => state),
  readScannerValue: vi.fn(async () => null),
  pendingScannerCount: vi.fn(async () => 2),
  rejectedScannerItems: vi.fn(async () => []),
  observeOfflineReloadTest: vi.fn(async () => "none"),
  decryptPackAttendee: vi.fn(async () => null),
  normaliseScannedValue: (value: string) => (/^[0-9A-F]{12}$/.test(value) ? value : null),
  pendingScannerItems: vi.fn(async () => ({ scans: [], annotations: [] })),
  cachedScannerLeads: vi.fn(async () => []),
  queueScan: (...args: unknown[]) => fake.queue(...args),
  storeOfflinePack: vi.fn(),
  saveScannerCredential: vi.fn(),
  clearScannerCredential: vi.fn(),
  armOfflineReloadTest: vi.fn(),
  clearOfflineReloadTest: vi.fn(),
  verifyOfflineQueue: vi.fn(),
  verifyOfflineStorage: vi.fn(),
  retryRejectedScans: vi.fn(),
}));
vi.mock("qr-scanner", () => ({
  default: class {
    constructor(_video: unknown, callback: (value: { data: string }) => void) {
      fake.decode = callback;
    }
    start = async () => undefined;
    stop = fake.stop;
    destroy = vi.fn();
    hasFlash = async () => false;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  fake.decode = null;
  fake.bootstrap.mockResolvedValue(state);
  fake.queue.mockResolvedValue({ id: "scan1" });
  fake.sync.mockResolvedValue({ remaining: 2, rejected: 0 });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("fast scanner failure paths", () => {
  it("opens cached scanning without waiting for a stalled bootstrap", async () => {
    fake.bootstrap.mockReturnValue(new Promise(() => undefined));
    render(<SponsorScanner />);
    expect(await screen.findByRole("button", { name: "Start scanning" })).toBeTruthy();
    expect(screen.queryByText("Getting your scanner ready…")).toBeNull();
    expect(screen.queryByText(/enter.*QR/i)).toBeNull();
  });
  it("checks a new badge online, stores it before confirming and leaves the camera running", async () => {
    const attendee = { attendeeId: 2, name: "Jamie", company: "Sample" };
    fake.lookup.mockResolvedValue(attendee);
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await waitFor(() => expect(fake.decode).not.toBeNull());
    await act(async () => {
      fake.decode?.({ data: "ABCDEF123456" });
    });
    await screen.findByText("Added to leads");
    expect(fake.queue).toHaveBeenCalledWith(expect.objectContaining({ attendee }));
    expect(fake.stop).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /note/i })).toBeNull();
    await act(async () => {
      fake.decode?.({ data: "ABCDEF123456" });
    });
    expect(fake.queue).toHaveBeenCalledTimes(1);
  });
  it("retains an unresolved offline badge with a truthful brief message", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await waitFor(() => expect(fake.decode).not.toBeNull());
    await act(async () => {
      fake.decode?.({ data: "ABCDEF654321" });
    });
    await screen.findByText("Saved for checking");
    expect(fake.queue).toHaveBeenCalledWith(expect.objectContaining({ attendee: null }));
    expect(fake.lookup).not.toHaveBeenCalled();
  });
});
