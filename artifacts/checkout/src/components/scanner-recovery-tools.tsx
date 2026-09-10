import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createScannerBackup, downloadScannerBackup } from "@/lib/scanner-backup";
import { restoreScannerBackup } from "@/lib/scanner-storage";
import type { ScannerCredential } from "@/types/lead-scanner";

export function ScannerRecoveryTools({ credential }: { credential: ScannerCredential }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const run = async (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The recovery file could not be opened.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="text-sm border-t border-slate-200 pt-2">
      <summary className="cursor-pointer min-h-11 py-3 font-semibold">
        Offline backup and recovery
      </summary>
      <p className="mb-3">
        Save a recovery file of this scanner's waiting leads and notes, even without a connection.
        Keep the file private and give it only to your organiser.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              downloadScannerBackup(await createScannerBackup(credential));
              return "Recovery download started. Check it is saved in your phone's Downloads.";
            })
          }
        >
          Download offline backup
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          Restore recovery file
        </Button>
      </div>
      <input
        ref={input}
        className="hidden"
        type="file"
        accept=".json,application/json"
        aria-label="Scanner recovery file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void run(async () => {
            if (file.size > 20_000_000) throw new Error("This recovery file is too large.");
            const count = await restoreScannerBackup(await file.text(), credential);
            return `${count} saved items restored. Existing work was kept. Reconnect to back up waiting items.`;
          });
        }}
      />
      {message && (
        <p role="status" className="mt-3">
          {message}
        </p>
      )}
      <p className="mt-3 text-slate-600">
        Restore using the same team member's scanner link. Keep this app and its browser data until
        all work is backed up.
      </p>
    </details>
  );
}
