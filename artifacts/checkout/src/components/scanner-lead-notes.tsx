import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LeadAnnotationFields } from "@/components/lead-annotation-fields";
import { getLeadDraft, saveLeadDraft, scannerScope } from "@/lib/scanner-storage";
import { syncPendingScannerItems } from "@/lib/scanner-api";
import type { ScannerCredential, SponsorLead } from "@/types/lead-scanner";
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

export function LeadNotes({
  lead,
  credential,
}: {
  lead: SponsorLead;
  credential: ScannerCredential;
}) {
  const [scanId, setScanId] = useState(
    () =>
      [...lead.scans].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))[0]?.id ?? lead.id,
  );
  const key = `${scannerScope(credential)}:note-fallback:${scanId}`;
  const [draft, setDraft] = useState({ note: "", rating: null as number | null });
  const [status, setStatus] = useState("Notes save automatically");
  const [problem, setProblem] = useState("");
  const edited = useRef(false),
    writes = useRef(Promise.resolve()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  useEffect(() => {
    let active = true;
    let fallback: { note: string; rating: number | null } | null = null;
    try {
      fallback = JSON.parse(localStorage.getItem(key) ?? "null");
      if (!edited.current && fallback && typeof fallback.note === "string") {
        setDraft(fallback);
        latest.current = fallback;
      }
    } catch {
      /* IndexedDB is the primary local store. */
    }
    void Promise.all(lead.scans.map((scan) => getLeadDraft(scan.id, credential)))
      .then((savedDrafts) => {
        const saved = savedDrafts
          .filter((item) => item !== null)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (active && !edited.current && fallback) {
          if (!saved || saved.note !== fallback.note || saved.rating !== fallback.rating)
            void saveLeadDraft(scanId, fallback.note, fallback.rating, credential)
              .then(() => {
                if (active && !edited.current) setStatus("Saved on this phone");
                void syncPendingScannerItems().catch(() => {
                  if (active && !edited.current) setStatus("Saved on this phone · reconnecting");
                });
              })
              .catch(() => {
                if (active && !edited.current) {
                  setStatus("Not saved yet");
                  setProblem(
                    "Your note has not reached phone storage. Keep this page open and try again.",
                  );
                }
              });
        } else if (active && !edited.current && saved) {
          setScanId(saved.scanId);
          const value = { note: saved.note ?? "", rating: saved.rating };
          setDraft(value);
          latest.current = value;
        }
      })
      .catch(() =>
        setProblem("This browser could not open saved notes. Keep this page open and try again."),
      );
    return () => {
      active = false;
    };
  }, [key, scanId, credential, lead.scans]);
  const persist = (value: typeof draft) => {
    edited.current = true;
    latest.current = value;
    setDraft(value);
    setStatus("Saving on this phone…");
    setProblem("");
    // The synchronous fallback protects the very last keystroke on a sudden close.
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* The durable queue below reports failure. */
    }
    writes.current = writes.current
      .catch(() => undefined)
      .then(async () => {
        await saveLeadDraft(scanId, value.note, value.rating, credential);
        if (latest.current !== value) return;
        setStatus("Saved on this phone");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void syncPendingScannerItems()
            .then((result) => {
              if (latest.current === value)
                setStatus(result.remaining ? "Saved on this phone · reconnecting" : "All saved");
            })
            .catch(() => {
              if (latest.current === value) setStatus("Saved on this phone · reconnecting");
            });
        }, 800);
      })
      .catch(() => {
        if (latest.current !== value) return;
        setProblem("Your note has not reached phone storage. Keep this page open and try again.");
        setStatus("Not saved yet");
      });
  };
  useEffect(() => {
    if (!problem) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [problem]);
  return (
    <div className="space-y-4 border-t p-5 bg-slate-50">
      <p className="text-sm font-semibold">Your notes · {credential.operatorName}</p>
      <LeadAnnotationFields id={scanId} value={draft} onChange={persist} />
      <p role="status" className="text-xs text-muted-foreground">
        {status}
      </p>
      {problem && (
        <div role="alert" className="text-sm text-rose-800">
          {problem}
          <Button variant="outline" onClick={() => persist(latest.current)}>
            Try again
          </Button>
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer min-h-11 py-3">Team notes and scan history</summary>
        {lead.notes
          .filter((note) => note.note || note.rating)
          .map((item) => (
            <div key={item.id} className="bg-white p-3 border rounded-lg mb-2">
              <p className="font-medium">
                {item.operatorName} · {date(item.createdAt)}
                {item.rating ? ` · ${item.rating}/5` : ""}
              </p>
              <p className="whitespace-pre-wrap mt-1">{item.note}</p>
            </div>
          ))}
        {lead.scans.map((scan) => (
          <p key={scan.id} className="text-muted-foreground py-1">
            Scanned by {scan.operatorName} · {date(scan.capturedAt)}
          </p>
        ))}
      </details>
    </div>
  );
}
