import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { scannerConnection, subscribeScannerConnection } from "@/lib/scanner-connection";
import type { ScannerSummary } from "@/hooks/use-scanner-summary";

export function ScannerSaveStatus({
  summary,
  onSync,
  dark = false,
}: {
  summary: ScannerSummary;
  onSync: () => Promise<void>;
  dark?: boolean;
}) {
  const connection = useSyncExternalStore(subscribeScannerConnection, scannerConnection);
  const [syncing, setSyncing] = useState(false);
  const waiting = summary.pendingScans + summary.pendingNotes;
  const canSync = summary.loaded && !summary.error && waiting + summary.otherPending > 0;
  const otherHeld = summary.otherWork - summary.otherPending;

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div
      className={`rounded-xl px-4 py-3 text-sm ${dark ? "bg-white/10 text-slate-100" : "bg-blue-50 text-slate-800"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div role="status" aria-live="polite" className="min-w-0">
          {summary.error ? (
            <p>{summary.error}</p>
          ) : !summary.loaded ? (
            <p>Opening saved leads…</p>
          ) : (
            <>
              <p className="font-semibold">
                {summary.leads.length} team lead{summary.leads.length === 1 ? "" : "s"} ·{" "}
                {summary.rejected
                  ? "Some items need help"
                  : waiting + summary.otherPending > 0
                    ? "Saved on this device"
                    : summary.leads.length
                      ? "Your scans are backed up"
                      : "Ready for your first badge"}
              </p>
              {waiting > 0 && (
                <p className="mt-1">
                  {summary.pendingScans > 0
                    ? `${summary.pendingScans} badge${summary.pendingScans === 1 ? "" : "s"}`
                    : ""}
                  {summary.pendingScans > 0 && summary.pendingNotes > 0 ? " and " : ""}
                  {summary.pendingNotes > 0
                    ? `${summary.pendingNotes} note update${summary.pendingNotes === 1 ? "" : "s"}`
                    : ""}{" "}
                  waiting to back up.
                </p>
              )}
              {summary.otherPending > 0 && (
                <p className="mt-1">
                  {summary.otherPending} {summary.otherPending === 1 ? "item" : "items"} for other
                  reps still on this device, waiting to back up.
                </p>
              )}
              {otherHeld > 0 && (
                <p className="mt-1">
                  {otherHeld} {otherHeld === 1 ? "item" : "items"} for other reps{" "}
                  {otherHeld === 1 ? "needs" : "need"} organiser help on this device.
                </p>
              )}
              {summary.rejected > 0 && (
                <p className="mt-1">
                  {summary.rejected} item{summary.rejected === 1 ? " needs" : "s need"} organiser
                  help. Saved work is retained.
                </p>
              )}
            </>
          )}
        </div>
        {canSync && (
          <Button
            type="button"
            size="sm"
            variant={dark ? "secondary" : "outline"}
            className="min-h-11 shrink-0"
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        )}
      </div>
      {connection === "unavailable" && (
        <p role="status" className="mt-1">
          Connection unavailable. Saved scans and notes stay on this device. We’ll retry
          automatically.
        </p>
      )}
    </div>
  );
}
