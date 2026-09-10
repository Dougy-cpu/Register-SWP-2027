import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScannerBackup, parseScannerBackup } from "./scanner-backup";
const fake = vi.hoisted(() => ({ pending: vi.fn(), rejected: vi.fn(), leads: vi.fn() }));
vi.mock("./scanner-storage", () => ({
  pendingScannerItems: fake.pending,
  rejectedScannerItems: fake.rejected,
  cachedScannerLeads: fake.leads,
  scannerScope: (owner: { sponsorId: number; id: string }) =>
    `swp-2027:${owner.sponsorId}:${owner.id}`,
}));
const owner = {
  id: "device-1",
  sponsorId: 1,
  operatorName: "Alex",
  sponsorCompany: "Sample",
  activatedAt: "2026-09-10",
  token: "never-export-this-secret",
};
const scan = {
  id: "scan-1",
  scope: "swp-2027:1:device-1",
  code: "AABBCCDDEEFF",
  capturedAt: "2026-09-10T09:00:00.000Z",
  source: "camera",
  attendee: null,
};
const backup = {
  format: "swp-scanner-recovery-v1",
  createdAt: scan.capturedAt,
  owner: { deviceId: owner.id, sponsorId: 1, operatorName: owner.operatorName },
  scans: [scan],
  annotations: [],
  rejected: [],
  drafts: [],
};
beforeEach(() => {
  localStorage.clear();
  fake.pending.mockResolvedValue({ scans: [scan], annotations: [] });
  fake.rejected.mockResolvedValue([]);
  fake.leads.mockResolvedValue([]);
});
describe("offline recovery files", () => {
  it("retains original scan IDs and rejects files belonging to another operator or sponsor", () => {
    expect(parseScannerBackup(JSON.stringify(backup), owner).scans[0].id).toBe(scan.id);
    expect(() => parseScannerBackup(JSON.stringify(backup), { ...owner, id: "device-2" })).toThrow(
      "same team member",
    );
    expect(() => parseScannerBackup(JSON.stringify(backup), { ...owner, sponsorId: 2 })).toThrow(
      "same team member",
    );
  });
  it("rejects foreign records even if the outer owner matches", () => {
    expect(() =>
      parseScannerBackup(
        JSON.stringify({ ...backup, scans: [{ ...scan, scope: "swp-2027:2:device-1" }] }),
        owner,
      ),
    ).toThrow("same team member");
  });
  it("rejects malformed badge payloads and invalid note values", () => {
    expect(() =>
      parseScannerBackup(
        JSON.stringify({ ...backup, scans: [{ ...scan, code: "https://example.com" }] }),
        owner,
      ),
    ).toThrow("valid SWP");
    expect(() =>
      parseScannerBackup(
        JSON.stringify({ ...backup, drafts: [{ scanId: scan.id, note: "x", rating: 6 }] }),
        owner,
      ),
    ).toThrow("valid SWP");
  });
  it("exports waiting work and the last keystroke without credentials, packs or foreign drafts", async () => {
    localStorage.setItem(
      `swp-2027:1:device-1:note-fallback:${scan.id}`,
      JSON.stringify({ note: "Last keystroke", rating: 4 }),
    );
    localStorage.setItem(
      `swp-2027:2:device-2:note-fallback:${scan.id}`,
      JSON.stringify({ note: "Foreign", rating: 5 }),
    );
    fake.pending.mockResolvedValue({
      scans: [{ ...scan, token: owner.token, pack: { private: true } }],
      annotations: [],
    });
    const result = await createScannerBackup(owner);
    expect(result.drafts).toEqual([{ scanId: scan.id, note: "Last keystroke", rating: 4 }]);
    expect(JSON.stringify(result)).not.toContain(owner.token);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("Foreign");
  });
});
