// Local preview only. This module is not imported by the application entry point.
import type { PendingScan, ScannerCredential, SponsorLead } from "@/types/lead-scanner";
const output = document.querySelector("pre")!;
const assert = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
  output.textContent += `PASS ${label}\n`;
};
const credential: ScannerCredential = {
  id: "preview-phone",
  sponsorId: 90001,
  sponsorCompany: "Sample Preview Sponsor",
  operatorName: "Alex Preview",
  token: "p".repeat(43),
  activatedAt: new Date().toISOString(),
};
const attendee = {
  attendeeId: 90001,
  firstName: "Jamie",
  lastName: "Example",
  name: "Jamie Example",
  jobTitle: "Director",
  company: "Sample Company",
  workEmail: "jamie@example.invalid",
};
document.querySelector("button")!.addEventListener(
  "click",
  () =>
    void (async () => {
      output.textContent = "";
      const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("swp-sponsor-scanner");
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("config");
          db.createObjectStore("packs", { keyPath: "key" });
          db.createObjectStore("pendingScans", { keyPath: "id" }).createIndex(
            "by-captured-at",
            "capturedAt",
          );
          const notes = db.createObjectStore("pendingAnnotations", { keyPath: "id" });
          notes.createIndex("by-created-at", "createdAt");
          notes.createIndex("by-scan-id", "scanId");
          db.createObjectStore("rejectedItems", { keyPath: "id" }).createIndex(
            "by-rejected-at",
            "rejectedAt",
          );
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const fresh = legacy.version === 1;
      if (fresh)
        await new Promise<void>((resolve, reject) => {
          const tx = legacy.transaction(["config", "pendingScans"], "readwrite");
          tx.objectStore("config").put(credential, "device");
          tx.objectStore("pendingScans").put({
            id: "legacy-scan-0000000001",
            code: "ABCDEF123456",
            source: "camera",
            capturedAt: new Date().toISOString(),
            attendee,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      const storage = await import("@/lib/scanner-storage");
      if (fresh) {
        const blocked = await storage.getScannerCredential().then(
          () => "",
          (error: Error) => error.message,
        );
        assert(
          blocked.includes("Close any other open scanner tabs"),
          "an older open tab gives a clear recovery action instead of loading forever",
        );
      }
      legacy.close();
      if (fresh)
        assert(
          (await storage.pendingScannerItems()).scans.some(
            (item) =>
              item.id === "legacy-scan-0000000001" &&
              item.scope === storage.scannerScope(credential),
          ),
          "legacy upgrade preserves IDs and sponsor ownership",
        );
      await storage.saveScannerCredential(credential);
      const scan = await storage.queueScan({ code: "ABCDEF123456", source: "camera", attendee });
      const unknown = await storage.queueScan({
        code: "FEDCBA123456",
        source: "image",
        attendee: null,
      });
      const before = (await storage.pendingScannerItems()).scans.map((item) => item.id);
      await storage.saveScannerCredential({ ...credential, token: "r".repeat(43) });
      assert(
        JSON.stringify((await storage.pendingScannerItems()).scans.map((item) => item.id)) ===
          JSON.stringify(before),
        "renewing the same phone retains every original scan ID",
      );
      const other = {
        ...credential,
        id: "other-preview-phone",
        sponsorId: 90002,
        token: "s".repeat(43),
      };
      await storage.saveScannerCredential(other);
      assert(
        (await storage.pendingScannerItems()).scans.length === 0,
        "another sponsor never sees the first sponsor's pending scans",
      );
      await storage.saveScannerCredential(credential);
      const first = await storage.saveLeadDraft(scan.id, "First note", 3, credential);
      const latest = await storage.saveLeadDraft(
        scan.id,
        "Notes survive switching screens",
        5,
        credential,
      );
      const lead: SponsorLead = {
        id: "preview-confirmed",
        sponsorId: credential.sponsorId,
        sponsorCompany: credential.sponsorCompany,
        ...attendee,
        rating: 5,
        scanCount: 1,
        firstScannedAt: scan.capturedAt,
        lastScannedAt: scan.capturedAt,
        scans: [
          {
            id: scan.id,
            source: scan.source,
            operatorName: credential.operatorName,
            capturedAt: scan.capturedAt,
          },
        ],
        notes: [
          {
            id: latest.id,
            operatorName: credential.operatorName,
            note: latest.note,
            rating: latest.rating,
            createdAt: latest.createdAt,
          },
        ],
      };
      await storage.applySyncResults({
        credential,
        leads: [lead],
        scanResults: [{ id: scan.id, status: "accepted" }],
        sentAnnotations: [first],
        annotationResults: [{ id: first.id, status: "accepted" }],
      });
      assert(
        (await storage.pendingScannerItems()).annotations.some(
          (item) => item.id === latest.id && item.note === latest.note,
        ),
        "an acknowledgement never deletes a newer note written in flight",
      );
      assert(
        (await storage.cachedScannerLeads()).some((item) => item.id === lead.id) &&
          !(await storage.pendingScannerItems()).scans.some((item) => item.id === scan.id),
        "confirmed lead and queue acknowledgement commit together",
      );
      await storage.applySyncResults({
        credential,
        scanResults: [
          { id: unknown.id, status: "rejected", reason: "Sample badge awaiting issue" },
        ],
        annotationResults: [],
      });
      assert(
        (await storage.rejectedScannerItems()).some((item) => item.payload.id === unknown.id),
        "unresolved rejected scans remain recoverable",
      );
      await storage.retryRejectedScans();
      assert(
        (await storage.pendingScannerItems()).scans.some((item) => item.id === unknown.id),
        "retry keeps the original scan ID",
      );
      await storage.clearScannerCredential();
      await storage.saveScannerCredential(credential);
      assert(
        (await storage.pendingScannerItems()).scans.some((item) => item.id === unknown.id),
        "disconnect and reconnect do not delete pending work",
      );
      await storage.storeOfflinePack({
        format: 1,
        version: "sample",
        generatedAt: new Date().toISOString(),
        refreshAfter: new Date(Date.now() + 3600000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        keyContext: "sample",
        records: [],
      });
      const queued = (await storage.pendingScannerItems()).scans as PendingScan[];
      assert(
        queued.every((item) => item.scope === storage.scannerScope(credential)),
        "all visible queued items have the active sponsor and phone scope",
      );
      output.textContent += "\nDONE · All checks use sample data on this local preview origin.\n";
    })().catch((error) => {
      output.textContent += `FAIL ${error instanceof Error ? error.stack : String(error)}`;
    }),
);
