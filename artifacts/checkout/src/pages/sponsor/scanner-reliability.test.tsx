import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SponsorScanner from "./scanner";
import { recordScannerContact } from "@/lib/scanner-connection";
import { cameraMock, installCameraMock, latestCamera } from "@/test/badge-camera-mock";
const fake = vi.hoisted(() => ({
  decode: null as null | ((value: { data: string }) => void),
  bootstrap: vi.fn(),
  lookup: vi.fn(),
  decrypt: vi.fn(),
  queue: vi.fn(),
  stop: vi.fn(),
  sync: vi.fn(),
  readiness: vi.fn(),
  importLink: vi.fn(),
  download: vi.fn(),
  storePack: vi.fn(),
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
vi.mock("@/lib/scanner-updates", () => ({
  scannerUpdateState: () => ({
    running: "2026.09.10.2",
    latest: "2026.09.10.2",
    checked: true,
    waiting: false,
    offlineReady: true,
  }),
  checkScannerUpdate: vi.fn(),
  applyScannerUpdate: vi.fn(),
}));
vi.mock("@/components/scanner-recovery-tools", () => ({ ScannerRecoveryTools: () => null }));
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
  updateReadiness: (...args: unknown[]) => fake.readiness(...args),
  downloadOfflinePack: (...args: unknown[]) => fake.download(...args),
  activateScanner: vi.fn(),
  recoverScanner: vi.fn(),
  importScannerLink: (...args: unknown[]) => fake.importLink(...args),
}));
vi.mock("@/lib/scanner-storage", () => ({
  getScannerCredential: vi.fn(async () => credential),
  getOfflinePack: vi.fn(async () => pack),
  cachedScannerBootstrap: vi.fn(async () => state),
  readScannerValue: vi.fn(async () => null),
  pendingScannerCount: vi.fn(async () => 2),
  rejectedScannerItems: vi.fn(async () => []),
  observeOfflineReloadTest: vi.fn(async () => "none"),
  decryptPackAttendee: (...args: unknown[]) => fake.decrypt(...args),
  normaliseScannedValue: (value: string) => (/^[0-9A-F]{12}$/.test(value) ? value : null),
  pendingScannerItems: vi.fn(async () => ({ scans: [], annotations: [] })),
  cachedScannerLeads: vi.fn(async () => []),
  queueScan: (...args: unknown[]) => fake.queue(...args),
  storeOfflinePack: (...args: unknown[]) => fake.storePack(...args),
  saveScannerCredential: vi.fn(),
  clearScannerCredential: vi.fn(),
  armOfflineReloadTest: vi.fn(),
  clearOfflineReloadTest: vi.fn(),
  verifyOfflineQueue: vi.fn(),
  verifyOfflineStorage: vi.fn(async () => true),
  prepareScannerStorage: vi.fn(async () => ({ persistent: false })),
  offlineReadinessAcknowledged: vi.fn(async () => false),
  retryRejectedScans: vi.fn(),
}));
vi.mock("qr-scanner", async () => ({
  default: (await import("@/test/badge-camera-mock")).MockQrScanner,
}));
beforeEach(() => {
  vi.clearAllMocks();
  recordScannerContact(true);
  installCameraMock();
  fake.decode = null;
  fake.bootstrap.mockResolvedValue(state);
  fake.lookup.mockReset().mockResolvedValue(null);
  fake.decrypt.mockReset().mockResolvedValue(null);
  fake.queue.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({
    ...input,
    id: "scan1",
    scope: "swp-2027:1:phone1",
    capturedAt: new Date().toISOString(),
  }));
  fake.sync.mockResolvedValue({ remaining: 2, rejected: 0 });
  fake.readiness.mockReset().mockResolvedValue(undefined);
  fake.download.mockReset().mockResolvedValue(pack);
  fake.storePack.mockReset().mockImplementation(async (value: unknown) => value);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});
describe("fast scanner failure paths", () => {
  it("automatically retries badge preparation when a connection returns", async () => {
    fake.bootstrap.mockResolvedValue({
      ...state,
      device: { ...state.device, currentPackVersion: "v2" },
    });
    fake.download.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SponsorScanner />);
    await screen.findByRole("button", { name: "Start scanning" });
    await screen.findByText("Ready to scan. Updates will retry automatically.");
    fake.download.mockResolvedValue({ ...pack, version: "v2" });
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() =>
      expect(fake.storePack).toHaveBeenCalledWith(
        expect.objectContaining({ version: "v2" }),
        credential,
      ),
    );
    expect(screen.queryByText("Scanner ready check")).toBeNull();
  });
  it("reuses a prepared scanner when its original link is reopened offline", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.history.replaceState(null, "", `/#activate=${credential.token}`);
    render(<SponsorScanner />);
    await screen.findByRole("button", { name: "Start scanning" });
    expect(fake.importLink).not.toHaveBeenCalled();
    expect(screen.queryByText("Scanner ready check")).toBeNull();
  });
  it("saves an unknown badge without waiting for any online lookup", async () => {
    fake.lookup.mockReturnValue(new Promise(() => undefined));
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await screen.findByText("Camera ready");
    act(() => latestCamera().decode({ data: "AABBCC112233" }));
    await screen.findByText("Saved for checking");
    expect(fake.queue).toHaveBeenCalled();
    expect(fake.lookup).not.toHaveBeenCalled();
  });
  it("allows cancelling a photo while its local badge read is pending", async () => {
    let resolveLookup!: (value: unknown) => void;
    fake.decrypt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    cameraMock.photo.mockResolvedValue({ data: "ABCDABCDABCD" });
    const { container } = render(<SponsorScanner />);
    await screen.findByRole("button", { name: "Start scanning" });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["QR"], "badge.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(fake.decrypt).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel photo" }));
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(["QR"], "retry.png", { type: "image/png" })] },
    });
    await screen.findByText(
      "A previous badge is still being checked or saved. Wait a moment, then try this photo again.",
    );
    await act(async () => resolveLookup({ attendeeId: 2, name: "Jamie", company: "Sample" }));
    expect(fake.queue).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved on this phone", { selector: "[role=status] *" })).toBeNull();
  });
  it("shows a readiness error even after the real test QR intentionally stops the camera", async () => {
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await screen.findByText("Camera ready");
    await waitFor(() => expect(fake.readiness).toHaveBeenCalled());
    fake.readiness.mockRejectedValueOnce(new Error("Readiness could not be saved. Try again."));
    await act(async () => latestCamera().decode({ data: state.testQrValue }));
    await screen.findByText("Readiness could not be saved. Try again.");
    expect(fake.queue).not.toHaveBeenCalled();
  });
  it("shows success only after durable saving and allows retry after a storage failure", async () => {
    let saved!: () => void;
    fake.decrypt.mockResolvedValue({ attendeeId: 2, name: "Jamie", company: "Sample" });
    fake.queue.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await screen.findByText("Camera ready");
    act(() => latestCamera().decode({ data: "ABABABABABAB" }));
    await waitFor(() => expect(fake.queue).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Saved on this phone", { selector: "[role=status] *" })).toBeNull();
    await act(async () => saved());
    await screen.findByText("Saved on this phone");
    fake.queue.mockRejectedValueOnce(new Error("Phone storage is full"));
    await act(async () => latestCamera().decode({ data: "CDCDCDCDCDCD" }));
    await screen.findByText("Phone storage is full");
    expect(screen.queryByText("Saved on this phone", { selector: "[role=status] *" })).toBeNull();
    await act(async () => latestCamera().decode({ data: "CDCDCDCDCDCD" }));
    await waitFor(() => expect(fake.queue).toHaveBeenCalledTimes(3));
    expect(latestCamera().destroy).not.toHaveBeenCalled();
  });
  it("updates connectivity feedback without requiring another scan", async () => {
    render(<SponsorScanner />);
    await screen.findByRole("button", { name: "Start scanning" });
    const offlineMessage = "Connection unavailable. Saved leads stay on this phone.";
    expect(screen.queryByText(offlineMessage)).toBeNull();
    act(() => window.dispatchEvent(new Event("offline")));
    expect(await screen.findByText(offlineMessage)).toBeTruthy();
    act(() => window.dispatchEvent(new Event("online")));
    expect(screen.getByText(offlineMessage)).toBeTruthy();
    act(() => recordScannerContact(true));
    await waitFor(() => expect(screen.queryByText(offlineMessage)).toBeNull());
  });
  it("keeps desktop handoff separate without activating a scanner or opening storage", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows Chrome");
    const { container } = render(<SponsorScanner />);
    expect(screen.getByText("Scan badges on your phone")).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
    expect(fake.bootstrap).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Start scanning" })).toBeNull();
  });
  it("does not save a stale local badge read after the operator stops the camera", async () => {
    let resolveLookup!: (value: unknown) => void;
    fake.decrypt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await screen.findByText("Camera ready");
    act(() => latestCamera().decode({ data: "ABCDABCDABCD" }));
    await waitFor(() => expect(fake.decrypt).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Stop camera" }));
    await act(async () => resolveLookup({ attendeeId: 2, name: "Jamie", company: "Sample" }));
    expect(fake.queue).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved on this phone", { selector: "[role=status] *" })).toBeNull();
  });
  it("opens cached scanning without waiting for a stalled bootstrap", async () => {
    fake.bootstrap.mockReturnValue(new Promise(() => undefined));
    render(<SponsorScanner />);
    expect(await screen.findByRole("button", { name: "Start scanning" })).toBeTruthy();
    expect(screen.queryByText("Getting your scanner ready…")).toBeNull();
    expect(screen.queryByText(/enter.*QR/i)).toBeNull();
  });
  it("reads a cached badge locally, stores it before confirming and leaves the camera running", async () => {
    const attendee = { attendeeId: 2, name: "Jamie", company: "Sample" };
    fake.decrypt.mockResolvedValue(attendee);
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await screen.findByText("Camera ready");
    await act(async () => {
      latestCamera().decode({ data: "ABCDEF123456" });
    });
    await screen.findByText("Saved on this phone");
    expect(fake.queue).toHaveBeenCalledWith(expect.objectContaining({ attendee }), credential);
    expect(fake.lookup).not.toHaveBeenCalled();
    expect(latestCamera().destroy).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /note/i })).toBeNull();
    await act(async () => {
      latestCamera().decode({ data: "ABCDEF123456" });
    });
    expect(fake.queue).toHaveBeenCalledTimes(1);
  });
  it("retains an unresolved offline badge with a truthful brief message", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<SponsorScanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
    await screen.findByText("Camera ready");
    await act(async () => {
      latestCamera().decode({ data: "ABCDEF654321" });
    });
    await screen.findByText("Saved for checking");
    expect(fake.queue).toHaveBeenCalledWith(
      expect.objectContaining({ attendee: null }),
      credential,
    );
    expect(fake.lookup).not.toHaveBeenCalled();
  });
});
