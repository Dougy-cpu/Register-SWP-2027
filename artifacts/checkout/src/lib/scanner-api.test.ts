import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingScan } from "@/types/lead-scanner";
const fake = vi.hoisted(() => ({
  scans: [] as PendingScan[],
  marker: null as null | { stage: string; scanId: string },
  apply: vi.fn(),
}));
const credential = {
  id: "phone1",
  sponsorId: 1,
  operatorName: "Alex",
  sponsorCompany: "Sample",
  token: "t".repeat(43),
  activatedAt: "2026-09-10",
};
const scan: PendingScan = {
  id: "scan-0123456789012345",
  scope: "swp-2027:1:phone1",
  code: "AABBCCDDEEFF",
  source: "camera",
  attendee: null,
  capturedAt: "2026-09-10T09:00:00Z",
};
vi.mock("./scanner-storage", () => ({
  getScannerCredential: async () => credential,
  pendingScannerItems: async () => ({ scans: fake.scans, annotations: [] }),
  scannerScope: () => "swp-2027:1:phone1",
  readScannerValue: async () => fake.marker,
  applySyncResults: (...args: unknown[]) => fake.apply(...args),
  writeScannerValue: vi.fn(),
  saveScannerCredential: vi.fn(),
  cacheScannerLeads: vi.fn(),
}));
const response = (scans = [{ id: scan.id, status: "accepted" }]) =>
  new Response(JSON.stringify({ scans, annotations: [], leads: [], syncedAt: scan.capturedAt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  vi.resetModules();
  fake.scans = [scan];
  fake.marker = null;
  fake.apply.mockReset().mockImplementation(async () => {
    fake.scans = [];
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("retry-safe scanner upload", () => {
  it("attempts a real request even if the browser's network hint says offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fetcher = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const api = await import("./scanner-api");
    expect((await api.syncPendingScannerItems()).remaining).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).scans[0].id).toBe(scan.id);
  });
  it("retains every original record when the network fails or an acknowledgement is unrelated", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(response([{ id: "a-different-record", status: "accepted" }])),
    );
    const api = await import("./scanner-api");
    await expect(api.syncPendingScannerItems()).rejects.toThrow("Failed to fetch");
    await expect(api.syncPendingScannerItems({ force: true })).rejects.toThrow("did not confirm");
    expect(fake.apply).not.toHaveBeenCalled();
    expect(fake.scans[0].id).toBe(scan.id);
  });
  it("does not accept a Wi-Fi login page as a successful upload", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("<html>Log in to Wi-Fi</html>", { status: 200 }),
    );
    const api = await import("./scanner-api");
    await expect(api.syncPendingScannerItems()).rejects.toThrow("could not be read");
    expect(fake.apply).not.toHaveBeenCalled();
  });
  it("holds a readiness record until it has survived the offline reopen", async () => {
    fake.scans = [{ ...scan, code: "FFFFFFFFFFFF" }];
    fake.marker = { stage: "armed", scanId: scan.id };
    const fetcher = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const api = await import("./scanner-api");
    expect((await api.syncPendingScannerItems()).remaining).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    fake.marker.stage = "observed";
    expect((await api.syncPendingScannerItems()).remaining).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
