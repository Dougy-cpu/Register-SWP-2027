import { useEffect, useState } from "react";
import { scannerConnection } from "@/lib/scanner-connection";
import type { ScannerSummary } from "@/hooks/use-scanner-summary";

export function ScannerSaveStatus({
  summary,
  dark = false,
}: {
  summary: ScannerSummary;
  dark?: boolean;
}) {
  const [connection, setConnection] = useState(scannerConnection);
  useEffect(() => {
    const update = () => setConnection(scannerConnection());
    const offline = () => setConnection("unavailable");
    window.addEventListener("swp:scanner-connection", update);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("swp:scanner-connection", update);
      window.removeEventListener("offline", offline);
    };
  }, []);
  const waiting = summary.pendingScans + summary.pendingNotes;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl px-4 py-3 text-sm ${dark ? "bg-white/10 text-slate-100" : "bg-blue-50 text-slate-800"}`}
    >
      {summary.error ? (
        <p>{summary.error}</p>
      ) : !summary.loaded ? (
        <p>Opening saved leads…</p>
      ) : (
        <>
          <p className="font-semibold">
            {summary.leads.length} lead{summary.leads.length === 1 ? "" : "s"} ·{" "}
            {summary.rejected
              ? "Some items need help"
              : waiting
                ? "Saved on this phone"
                : summary.leads.length
                  ? "All backed up"
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
          {summary.rejected > 0 && (
            <p className="mt-1">
              {summary.rejected} item{summary.rejected === 1 ? " needs" : "s need"} organiser help.
              Saved work is retained.
            </p>
          )}
          {connection === "unavailable" && (
            <p className="mt-1">Connection unavailable. Saved leads stay on this phone.</p>
          )}
        </>
      )}
    </div>
  );
}
