import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Image as ImageIcon, List, ScanLine, Search, Star } from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BadgeCameraView } from "@/components/badge-camera-view";
import { LeadAnnotationFields, type LeadAnnotation } from "@/components/lead-annotation-fields";
import { useBadgeCamera } from "@/hooks/use-badge-camera";
import { useBadgePhoto } from "@/hooks/use-badge-photo";
import { useScannerAwake } from "@/hooks/use-scanner-awake";
import { isScannerPhone } from "@/lib/scanner-device";
import { prepareScannerDecoder } from "@/lib/scanner-decoder";
import {
  clearRehearsal,
  readRehearsal,
  saveRehearsal,
  type RehearsalLead,
} from "@/lib/scanner-rehearsal";
import { findScannerTestBadge } from "@/lib/scanner-test-data";
import ScannerTestBadges from "./scanner-test-badges";

export default function ScannerTest() {
  return isScannerPhone() ? <PhoneScannerTest /> : <ScannerTestBadges />;
}

function PhoneScannerTest() {
  const [initial] = useState(() => {
    try {
      return { leads: readRehearsal(), problem: "" };
    } catch {
      return {
        leads: [],
        problem:
          "Your practice leads could not be opened. Reopen the page, or use Reset rehearsal to start again.",
      };
    }
  });
  const [leads, setLeads] = useState<RehearsalLead[]>(initial.leads);
  const leadsRef = useRef(leads);
  const [view, setView] = useState<"scan" | "leads">("scan");
  const viewRef = useRef(view);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [quickNotes, setQuickNotes] = useState(false);
  const notesOpenRef = useRef(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [loadError, setLoadError] = useState(initial.problem);
  const loadBlocked = useRef(Boolean(initial.problem));
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const recent = useRef({ code: "", at: 0 });
  const imageInputRef = useRef<HTMLInputElement>(null);
  const camera = useBadgeCamera((value) => handleDecoded(value, "camera"));
  const photo = useBadgePhoto((value) => handleDecoded(value, "image"), setError);
  useScannerAwake(camera.phase === "active");

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "SWP Summit 2027 | Phone scanner rehearsal";
    prepareScannerDecoder();
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (!storageError) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [storageError]);

  function remember(next: RehearsalLead[]) {
    leadsRef.current = next;
    setLeads(next);
  }

  function store(next: RehearsalLead[]) {
    if (loadBlocked.current) return false;
    try {
      saveRehearsal(next);
      setStorageError("");
      return true;
    } catch {
      setStorageError(
        "Practice saving is unavailable. Keep this page open and try again. Any new badge must be scanned again once saving is working.",
      );
      return false;
    }
  }

  function handleDecoded(value: string, source: RehearsalLead["source"]) {
    if (viewRef.current !== "scan" || notesOpenRef.current || loadBlocked.current) return;
    const badge = findScannerTestBadge(value);
    if (!badge) {
      setError("That is not one of the four SWP test badges. Nothing was saved. Try a test badge.");
      return;
    }
    if (recent.current.code === badge.code && Date.now() - recent.current.at < 1500) return;
    const existing = leadsRef.current.find((lead) => lead.code === badge.code);
    const next = existing
      ? leadsRef.current
      : [
          {
            code: badge.code,
            source,
            capturedAt: new Date().toISOString(),
            note: "",
            rating: null,
          },
          ...leadsRef.current,
        ];
    // Confirm only after the browser has saved the practice record.
    if (!store(next)) return;
    remember(next);
    recent.current = { code: badge.code, at: Date.now() };
    setLastCode(badge.code);
    setError("");
    setNotice("");
    setConfirmation(existing ? "Already added" : "Saved for practice");
    if (!existing) navigator.vibrate?.(50);
  }

  function changeView(next: "scan" | "leads") {
    photo.cancel();
    camera.stop();
    viewRef.current = next;
    setView(next);
    notesOpenRef.current = false;
    setQuickNotes(false);
    setError("");
    setSearch("");
  }

  function startScanning() {
    photo.cancel();
    recent.current = { code: "", at: 0 };
    notesOpenRef.current = false;
    setQuickNotes(false);
    setError("");
    setNotice("");
    camera.start();
  }

  function annotate(code: string, value: LeadAnnotation) {
    const next = leadsRef.current.map((lead) =>
      lead.code === code ? { ...lead, ...value } : lead,
    );
    // Keep the latest text visible if browser storage fails, and offer a retry.
    remember(next);
    store(next);
  }

  function reset() {
    photo.cancel();
    camera.stop();
    try {
      clearRehearsal();
    } catch {
      setError(
        "The rehearsal could not be cleared. Your practice leads are still here. Try again.",
      );
      return;
    }
    loadBlocked.current = false;
    setLoadError("");
    setStorageError("");
    remember([]);
    setLastCode(null);
    setExpanded(null);
    recent.current = { code: "", at: 0 };
    changeView("scan");
    setConfirmation("");
    setNotice("Rehearsal cleared. Start scanning to try again.");
  }

  const lastLead = leads.find((lead) => lead.code === lastCode);
  const lastBadge = lastLead ? findScannerTestBadge(lastLead.code) : null;
  const filtered = leads.filter((lead) => {
    const badge = findScannerTestBadge(lead.code)!;
    return [badge.name, badge.company, badge.jobTitle, badge.workEmail].some((text) =>
      text.toLowerCase().includes(search.trim().toLowerCase()),
    );
  });
  const scanning = view === "scan";
  const annotationFields = (lead: RehearsalLead) => (
    <div className="space-y-4 p-4 text-slate-950">
      <LeadAnnotationFields
        id={`practice-${lead.code}`}
        value={lead}
        onChange={(value) => annotate(lead.code, value)}
      />
      <p role="status" className={`text-sm ${storageError ? "text-rose-700" : "text-slate-600"}`}>
        {storageError
          ? "Changes are still on screen but have not been saved. Try saving again above."
          : "Saved in this browser for practice. Notes save automatically."}
      </p>
    </div>
  );

  return (
    <div
      className={`min-h-screen pb-6 ${scanning ? "bg-slate-950 text-white" : "bg-slate-50 text-slate-950"}`}
    >
      <header
        className={`sticky top-0 z-20 border-b ${scanning ? "border-white/10 bg-slate-950" : "border-slate-200 bg-white"}`}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <img src={logoUrl} alt="SWP Summit" className="h-10 w-auto rounded bg-white p-1" />
          <div className="min-w-0 flex-1">
            <h1 className="font-bold">{scanning ? "Scan" : "Leads"}</h1>
            <p className={`text-xs ${scanning ? "text-slate-300" : "text-slate-600"}`}>
              Practice · fictional people
            </p>
          </div>
          <Button
            variant={scanning ? "secondary" : "default"}
            className="h-12 shrink-0"
            onClick={() => changeView(scanning ? "leads" : "scan")}
          >
            {scanning ? <List className="h-5 w-5" /> : <ScanLine className="h-5 w-5" />}
            {scanning ? "Leads" : "Scan"}
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        <p className={`text-sm ${scanning ? "text-slate-300" : "text-slate-600"}`}>
          {leads.length} practice {leads.length === 1 ? "lead" : "leads"} ·{" "}
          {storageError || loadError ? "Saving needs attention" : "Saved in this browser"}
        </p>
        {(storageError || loadError) && (
          <div
            role="alert"
            className="space-y-3 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900"
          >
            <p>{loadError || storageError}</p>
            {!loadError && (
              <Button
                variant="outline"
                className="h-12 bg-white text-slate-950"
                onClick={() => store(leadsRef.current)}
              >
                Try saving again
              </Button>
            )}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"
          >
            {error}
          </div>
        )}
        {notice && (
          <p role="status" className={scanning ? "text-sm text-blue-100" : "text-sm text-primary"}>
            {notice}
          </p>
        )}
        {scanning ? (
          <>
            <p className="text-sm text-slate-300">
              Scan several badges, then open Leads to add notes whenever you're ready.
            </p>
            <BadgeCameraView
              camera={{
                ...camera,
                selectCamera: (selected) => {
                  photo.cancel();
                  notesOpenRef.current = false;
                  setQuickNotes(false);
                  setError("");
                  camera.selectCamera(selected);
                },
              }}
              startLabel="Start scanning"
              onStart={startScanning}
              disabled={Boolean(loadError)}
            />
            {lastLead && lastBadge && (
              <Card className="overflow-hidden border-emerald-200 bg-white text-slate-950">
                <div className="flex items-center gap-3 bg-emerald-50 p-4">
                  <div className="min-w-0 flex-1">
                    <p
                      role="status"
                      className="flex items-center gap-1 text-sm font-semibold text-emerald-800"
                    >
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      {confirmation}
                    </p>
                    <h2 className="mt-1 text-lg font-bold">{lastBadge.name}</h2>
                    <p className="text-sm text-slate-600">{lastBadge.company}</p>
                  </div>
                  <Button
                    variant="outline"
                    className="h-12 shrink-0 bg-white"
                    aria-expanded={quickNotes}
                    onClick={() => {
                      photo.cancel();
                      camera.stop();
                      notesOpenRef.current = !quickNotes;
                      setQuickNotes(!quickNotes);
                    }}
                  >
                    {quickNotes ? "Close notes" : "Add note"}
                  </Button>
                </div>
                {quickNotes && annotationFields(lastLead)}
              </Card>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              aria-label="Test badge photo"
              onChange={(event) => {
                void photo.scan(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              className="h-12 w-full"
              disabled={photo.busy || Boolean(loadError)}
              onClick={() => {
                camera.stop();
                notesOpenRef.current = false;
                setQuickNotes(false);
                setError("");
                imageInputRef.current?.click();
              }}
            >
              <ImageIcon className="h-4 w-4" />
              {photo.busy ? "Reading photo…" : "Scan a badge photo"}
            </Button>
            {photo.busy && (
              <Button variant="secondary" className="h-12 w-full" onClick={photo.cancel}>
                Cancel photo
              </Button>
            )}
          </>
        ) : (
          <>
            <div>
              <h2 className="text-xl font-bold">Your practice leads</h2>
              <p className="mt-1 text-sm text-slate-600">
                Tap a person to add or edit notes and a rating.
              </p>
            </div>
            {leads.length > 0 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-slate-400" />
                <Input
                  aria-label="Search practice leads"
                  placeholder="Search name or company"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="h-12 bg-white pl-10 text-base"
                />
              </div>
            )}
            <div className="space-y-3">
              {filtered.map((lead) => {
                const badge = findScannerTestBadge(lead.code)!;
                const open = expanded === lead.code;
                return (
                  <Card key={lead.code} className="overflow-hidden border-slate-200 bg-white">
                    <button
                      type="button"
                      className="w-full p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                      aria-expanded={open}
                      aria-label={`Edit ${badge.name}`}
                      onClick={() => setExpanded(open ? null : lead.code)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-lg font-bold">{badge.name}</h3>
                        {lead.rating !== null && (
                          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
                            <Star className="h-4 w-4" />
                            {lead.rating}/5
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-slate-700">{badge.jobTitle}</p>
                      <p className="text-sm text-slate-600">{badge.company}</p>
                      <p className="mt-1 break-all text-sm text-slate-600">{badge.workEmail}</p>
                      <p className="mt-3 line-clamp-2 break-words text-sm text-primary">
                        {lead.note || "Add a note or rating"}
                      </p>
                    </button>
                    {open && (
                      <div className="border-t border-slate-100">{annotationFields(lead)}</div>
                    )}
                  </Card>
                );
              })}
              {filtered.length === 0 && (
                <Card className="space-y-3 p-6 text-center text-slate-600">
                  <p>
                    {leads.length
                      ? "No practice leads match that search."
                      : "Your practice leads will appear here."}
                  </p>
                  {!leads.length && (
                    <Button className="h-12" onClick={() => changeView("scan")}>
                      Scan a badge
                    </Button>
                  )}
                </Card>
              )}
            </div>
          </>
        )}
        <details
          className={`rounded-xl border p-4 text-sm ${scanning ? "border-white/15 text-slate-300" : "border-slate-200 text-slate-600"}`}
        >
          <summary className="cursor-pointer py-1 font-medium">About this rehearsal</summary>
          <p className="mt-3">
            Use the four fictional test badges. Practice leads and notes stay in this browser until
            you reset the rehearsal or clear browser data. They are never uploaded or included in
            real leads, reports or exports.
          </p>
          <p className="mt-2">
            Open the test page while connected. In the actual scanner, waiting leads and notes also
            back up automatically when a connection is available.
          </p>
        </details>
        <div
          className={`flex flex-wrap items-center justify-between gap-2 border-t pt-3 ${scanning ? "border-white/15" : "border-slate-200"}`}
        >
          <p className={`text-sm ${scanning ? "text-slate-300" : "text-slate-600"}`}>
            {leads.length} of 4 practice badges saved
          </p>
          <Button variant={scanning ? "secondary" : "outline"} className="h-12" onClick={reset}>
            Reset rehearsal
          </Button>
        </div>
      </main>
    </div>
  );
}
