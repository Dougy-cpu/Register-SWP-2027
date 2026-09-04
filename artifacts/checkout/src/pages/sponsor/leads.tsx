import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Download, Search, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  activateScanner,
  scannerFetch,
  syncPendingScannerItems,
  refreshScannerLeads,
  ScannerApiError,
} from "@/lib/scanner-api";
import {
  cachedScannerLeads,
  getScannerCredential,
  pendingScannerItems,
  rejectedScannerItems,
  getLeadDraft,
  saveLeadDraft,
  saveScannerCredential,
  scannerScope,
} from "@/lib/scanner-storage";
import { mergeScannerLeads } from "@/lib/scanner-leads";
import { sponsorFetch, sponsorJson } from "@/lib/sponsor-api";
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
const leadKey = (lead: SponsorLead) => (lead.attendeeId ? `attendee:${lead.attendeeId}` : lead.id);

function LeadNotes({ lead, credential }: { lead: SponsorLead; credential: ScannerCredential }) {
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
              .then(() => syncPendingScannerItems())
              .catch(() => setStatus("Saved on this phone · reconnecting"));
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
        setStatus("Saved on this phone");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (navigator.onLine)
            void syncPendingScannerItems()
              .then((result) =>
                setStatus(result.remaining ? "Saved on this phone · reconnecting" : "All saved"),
              )
              .catch(() => setStatus("Saved on this phone · reconnecting"));
        }, 800);
      })
      .catch(() => {
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
      <div>
        <Label>Rating (optional)</Label>
        <div className="mt-2 flex gap-2" role="group" aria-label="Lead rating">
          {[1, 2, 3, 4, 5].map((value) => (
            <Button
              key={value}
              variant={draft.rating === value ? "default" : "outline"}
              aria-pressed={draft.rating === value}
              aria-label={`Rate ${value} out of 5`}
              onClick={() => persist({ ...draft, rating: draft.rating === value ? null : value })}
            >
              {value}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <Label htmlFor={`note-${scanId}`}>Notes</Label>
        <Textarea
          id={`note-${scanId}`}
          rows={4}
          maxLength={4000}
          className="mt-2 bg-white"
          value={draft.note}
          placeholder="What would you like to follow up on?"
          onChange={(event) => persist({ ...draft, note: event.target.value })}
        />
      </div>
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

export default function SponsorLeads() {
  const [, navigate] = useLocation();
  const organiser = new URLSearchParams(window.location.search).get("organiser") === "1";
  const [leads, setLeads] = useState<SponsorLead[]>([]),
    [credential, setCredential] = useState<ScannerCredential | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null),
    [pending, setPending] = useState(0);
  const [exporting, setExporting] = useState(false),
    [operatorName, setOperatorName] = useState("");
  const [activating, setActivating] = useState(false);
  const organiserId = useRef<number | null>(null),
    syncing = useRef(false);
  const hasLocal = useRef(false);
  const loadLocal = useCallback(async () => {
    const saved = await getScannerCredential();
    if (!saved || (organiser && organiserId.current !== saved.sponsorId)) {
      setLoading(false);
      return;
    }
    setCredential((current) =>
      current?.id === saved.id && current.token === saved.token ? current : saved,
    );
    const [confirmed, queue, rejected] = await Promise.all([
      cachedScannerLeads(saved),
      pendingScannerItems(saved),
      rejectedScannerItems(),
    ]);
    const merged = mergeScannerLeads(confirmed, queue.scans, queue.annotations, rejected, saved);
    hasLocal.current = merged.length > 0;
    setLeads(merged);
    setPending(queue.scans.length + queue.annotations.length + rejected.length);
    setLoading(false);
  }, [organiser]);
  const refresh = useCallback(async () => {
    if (syncing.current || !navigator.onLine) return;
    syncing.current = true;
    try {
      const saved = await getScannerCredential();
      if (organiser) {
        // Validate the organiser's sponsor before showing any phone-local data.
        const workspace = await sponsorJson<{ id: number }>("/api/sponsor/workspace");
        organiserId.current = workspace.id;
        if (!saved || saved.sponsorId !== workspace.id) {
          setCredential(null);
          const data = await sponsorJson<{ leads: SponsorLead[] }>("/api/sponsor/leads");
          setLeads(data.leads);
          setLoading(false);
          setError("");
          return;
        }
      } else if (!saved) {
        setError("Open your scanner link to view your leads.");
        return;
      }
      if (saved) {
        await loadLocal();
        // Loading confirmed rows is independent of uploading the local queue.
        await refreshScannerLeads(saved);
        await loadLocal();
        setError("");
        void syncPendingScannerItems()
          .then(loadLocal)
          .catch((caught) => {
            if (caught instanceof ScannerApiError && caught.status === 401)
              setError("Your saved leads are available. Open Scan to reconnect this phone.");
          });
      }
    } catch (caught) {
      if (!hasLocal.current || (caught instanceof ScannerApiError && caught.status === 401))
        setError(
          "We couldn't connect. Saved leads and notes stay on this phone. Try again or open Scan to reconnect.",
        );
    } finally {
      syncing.current = false;
      setLoading(false);
    }
  }, [loadLocal, organiser]);
  useEffect(() => {
    void loadLocal().catch(() => {
      setError("Phone storage is unavailable. Keep this page open and reconnect.");
      setLoading(false);
    });
    void refresh();
    const local = () => {
      void loadLocal().catch(() => undefined);
    };
    const online = () => {
      void refresh();
    };
    const interval = window.setInterval(online, 15000);
    window.addEventListener("swp:scanner-data", local);
    window.addEventListener("online", online);
    return () => {
      clearInterval(interval);
      window.removeEventListener("swp:scanner-data", local);
      window.removeEventListener("online", online);
    };
  }, [loadLocal, refresh]);
  const filtered = useMemo(
    () =>
      leads.filter((lead) =>
        [lead.name, lead.company, lead.jobTitle, lead.workEmail].some((value) =>
          value.toLowerCase().includes(search.toLowerCase()),
        ),
      ),
    [leads, search],
  );
  const confirmed = leads.filter((lead) => !lead.localStatus).length;
  const download = async (format: "csv" | "xlsx") => {
    if (!confirmed || exporting) return;
    setExporting(true);
    try {
      const path = `/api/${credential ? "scanner" : "sponsor"}/leads/export?format=${format}`;
      const response = credential
        ? await scannerFetch(path, {}, credential)
        : await sponsorFetch(path);
      if (!response.ok) throw new Error("Reconnect to download your confirmed leads.");
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `swp-2027-confirmed-leads.${format}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export unavailable. Try again.");
    } finally {
      setExporting(false);
    }
  };
  const activate = async () => {
    if (activating || operatorName.trim().length < 2) return;
    setActivating(true);
    try {
      const saved = await activateScanner(operatorName.trim());
      await saveScannerCredential(saved);
      setCredential(saved);
      await refresh();
    } catch {
      setError("Open your sponsor management link again, then return to Leads.");
    } finally {
      setActivating(false);
    }
  };
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 h-20 flex items-center justify-between gap-3">
          <div>
            <h1 className="font-bold text-xl">Leads</h1>
            <p className="text-xs text-muted-foreground">
              {credential?.sponsorCompany ?? "SWP Summit 2027"}
            </p>
          </div>
          <div className="flex gap-2">
            {organiser && (
              <Button variant="outline" onClick={() => navigate("/sponsor")}>
                Workspace
              </Button>
            )}
            <Button onClick={() => navigate("/sponsor/scanner")}>Scan</Button>
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        {error && (
          <Card className="p-4 border-amber-300 bg-amber-50">
            <p role="alert">{error}</p>
            <Button variant="outline" className="mt-3" onClick={() => void refresh()}>
              Try again
            </Button>
          </Card>
        )}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Your leads</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Add notes and ratings whenever you're ready.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!confirmed || exporting}
              onClick={() => void download("csv")}
            >
              <Download className="h-4 w-4 mr-2" />
              CSV
            </Button>
            <Button
              variant="outline"
              disabled={!confirmed || exporting}
              onClick={() => void download("xlsx")}
            >
              Excel
            </Button>
          </div>
        </div>
        {pending > 0 && (
          <p role="status" className="text-sm text-amber-900">
            {pending} saved item{pending === 1 ? "" : "s"} awaiting connection or a badge check.
            Downloads include {confirmed} confirmed lead{confirmed === 1 ? "" : "s"} only.
          </p>
        )}
        {!credential && organiser && (
          <Card className="p-4 space-y-3">
            <Label htmlFor="lead-operator">Your name (to add notes)</Label>
            <Input
              id="lead-operator"
              value={operatorName}
              onChange={(event) => setOperatorName(event.target.value)}
            />
            <Button
              disabled={activating || operatorName.trim().length < 2}
              onClick={() => void activate()}
            >
              Enable notes on this device
            </Button>
          </Card>
        )}
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search leads"
            className="pl-9 bg-white"
            placeholder="Search your leads"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {loading ? (
          <p>Opening saved leads…</p>
        ) : filtered.length ? (
          filtered.map((lead) => (
            <Card key={leadKey(lead)} className="overflow-hidden">
              <button
                className="w-full text-left p-5 min-h-20"
                aria-expanded={expanded === leadKey(lead)}
                onClick={() => setExpanded(expanded === leadKey(lead) ? null : leadKey(lead))}
              >
                <div className="flex justify-between gap-3">
                  <h3 className="font-bold">{lead.name}</h3>
                  {lead.rating && (
                    <span className="flex items-center text-sm text-primary">
                      <Star className="h-4 w-4 mr-1" />
                      {lead.rating}/5
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {[lead.jobTitle, lead.company].filter(Boolean).join(" · ")}
                </p>
                {lead.workEmail && (
                  <p className="text-sm text-primary mt-1 break-all">{lead.workEmail}</p>
                )}
                <p className="text-xs mt-2 text-muted-foreground">
                  {lead.localStatus === "rejected"
                    ? "Needs an event-team check. The saved scan is retained."
                    : lead.localStatus === "checking"
                      ? "Saved for checking when connected"
                      : lead.localStatus
                        ? "Saved on this phone · awaiting sync"
                        : date(lead.lastScannedAt)}
                </p>
              </button>
              {expanded === leadKey(lead) && credential && (
                <LeadNotes lead={lead} credential={credential} />
              )}
            </Card>
          ))
        ) : (
          <Card className="p-8 text-center">
            <h3 className="font-semibold">
              {search ? "No matching leads" : "Your leads will appear here"}
            </h3>
            <p className="text-sm text-muted-foreground mt-2">
              Scan a badge, then return here when you're ready to follow up.
            </p>
            <Button className="mt-4" onClick={() => navigate("/sponsor/scanner")}>
              Scan a badge
            </Button>
          </Card>
        )}
      </main>
    </div>
  );
}
