import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Download, Search, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LeadNotes } from "@/components/scanner-lead-notes";
import { ScannerRecoveryTools } from "@/components/scanner-recovery-tools";
import { ScannerSaveStatus } from "@/components/scanner-save-status";
import { useScannerSummary } from "@/hooks/use-scanner-summary";
import { isScannerNetworkFailure } from "@/lib/scanner-connection";
import { syncPendingScannerItems, refreshScannerLeads, ScannerApiError } from "@/lib/scanner-api";
import {
  cachedScannerLeads,
  getScannerCredential,
  pendingScannerItems,
  rejectedScannerItems,
  watchOtherScannerTabs,
} from "@/lib/scanner-storage";
import { mergeScannerLeads } from "@/lib/scanner-leads";
import { sponsorFetch, sponsorJson } from "@/lib/sponsor-api";
import type { ScannerCredential, SponsorLead } from "@/types/lead-scanner";

import { ScannerReportSummary, type ScannerReport } from "@/components/scanner-report-summary";
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

export default function SponsorLeads() {
  const [, navigate] = useLocation();
  const organiser = new URLSearchParams(window.location.search).get("organiser") === "1";
  const [leads, setLeads] = useState<SponsorLead[]>([]),
    [credential, setCredential] = useState<ScannerCredential | null>(null);
  const summary = useScannerSummary(credential);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null),
    [pending, setPending] = useState(0);
  const [view, setView] = useState<"mine" | "team">("mine");
  const [report, setReport] = useState<ScannerReport | null>(null);
  const [exporting, setExporting] = useState(false);
  const syncing = useRef(false);
  const localGeneration = useRef(0);
  const hasLocal = useRef(false);
  const loadLocal = useCallback(async () => {
    if (organiser) return;
    const generation = ++localGeneration.current;
    const saved = await getScannerCredential();
    if (generation !== localGeneration.current) return;
    if (!saved) {
      setLeads([]);
      setCredential(null);
      setExpanded(null);
      setLoading(false);
      return;
    }
    setCredential((current) =>
      current?.id === saved.id && current.token === saved.token ? current : saved,
    );
    const [confirmed, queue, rejected] = await Promise.all([
      cachedScannerLeads(saved),
      pendingScannerItems(saved),
      rejectedScannerItems(saved),
    ]);
    if (generation !== localGeneration.current) return;
    const merged = mergeScannerLeads(confirmed, queue.scans, queue.annotations, rejected, saved);
    hasLocal.current = merged.length > 0;
    setLeads(merged);
    setPending(queue.scans.length + queue.annotations.length + rejected.length);
    setLoading(false);
  }, [organiser]);
  const refresh = useCallback(
    async (force = false) => {
      if (syncing.current) return;
      syncing.current = true;
      try {
        if (organiser) {
          const data = await sponsorJson<{ leads: SponsorLead[]; report: ScannerReport }>(
            "/api/sponsor/leads",
          );
          setReport(data.report);
          setLeads(data.leads);
          setLoading(false);
          setError("");
          return;
        }
        const saved = await getScannerCredential();
        if (!saved) {
          setError("Open your scanner link to view your leads.");
          return;
        }
        if (saved) {
          await loadLocal();
          // An unavailable lead download must never prevent queued work uploading.
          const results = await Promise.allSettled([
            refreshScannerLeads(saved),
            syncPendingScannerItems({ force }),
          ]);
          await loadLocal();
          for (const result of results) if (result.status === "rejected") throw result.reason;
          setError("");
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
    },
    [loadLocal, organiser],
  );
  useEffect(() => {
    void loadLocal().catch(() => {
      setError("Phone storage is unavailable. Keep this page open and reconnect.");
      setLoading(false);
    });
    void refresh(true);
    const local = () => {
      void loadLocal().catch(() => undefined);
    };
    const online = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const reconnected = () => {
      if (!organiser)
        void syncPendingScannerItems({ force: true })
          .then(local)
          .catch(() => undefined);
      online();
    };
    const unwatch = organiser
      ? () => {}
      : watchOtherScannerTabs(() => {
          ++localGeneration.current;
          setCredential(null);
          setLeads([]);
          setExpanded(null);
          setView("mine");
          setSearch("");
          local();
        });
    const interval = window.setInterval(online, 15000);
    window.addEventListener("swp:scanner-data", local);
    window.addEventListener("online", reconnected);
    document.addEventListener("visibilitychange", online);
    const channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("swp-scanner-data") : null;
    if (channel) channel.onmessage = local;
    return () => {
      unwatch();
      clearInterval(interval);
      window.removeEventListener("swp:scanner-data", local);
      window.removeEventListener("online", reconnected);
      document.removeEventListener("visibilitychange", online);
      channel?.close();
    };
  }, [loadLocal, refresh, organiser]);
  const filtered = useMemo(
    () =>
      leads
        .filter(
          (lead) =>
            organiser ||
            view === "team" ||
            lead.scans.some((s) => s.operatorId === credential?.id && !!credential),
        )
        .filter((lead) =>
          [lead.name, lead.company, lead.jobTitle, lead.workEmail].some((value) =>
            value.toLowerCase().includes(search.toLowerCase()),
          ),
        ),
    [leads, search, organiser, view, credential],
  );
  const confirmed = leads.filter((lead) => !lead.localStatus).length;
  const syncNow = async () => {
    try {
      await syncPendingScannerItems({ force: true });
      await loadLocal();
      setError("");
    } catch (caught) {
      if (!isScannerNetworkFailure(caught))
        setError("Saved work is still on this phone. Reconnect and try again.");
    }
  };
  const download = async (format: "csv" | "xlsx") => {
    if (!organiser || exporting) return;
    setExporting(true);
    try {
      const response = await sponsorFetch("/api/sponsor/leads/export?format=" + format);
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
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 h-20 flex items-center justify-between gap-3">
          <div>
            <h1 className="font-bold text-xl">Leads</h1>
            <p className="text-xs text-muted-foreground">
              {credential
                ? credential.operatorName + " · " + credential.sponsorCompany
                : "SWP Summit 2027"}
            </p>
          </div>
          <div className="flex gap-2">
            {organiser && (
              <Button variant="outline" onClick={() => navigate("/sponsor")}>
                Workspace
              </Button>
            )}
            {!organiser && <Button onClick={() => navigate("/sponsor/scanner")}>Scan</Button>}
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        {credential && <ScannerSaveStatus summary={summary} onSync={syncNow} />}
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
            <h2 className="text-2xl font-bold">
              {organiser || view === "team" ? "Team leads" : "My scans"}
            </h2>
            <p className="text-sm text-muted-foreground mt-2">
              {organiser ? "Confirmed leads for your company." : "Tap a person to add notes."}
            </p>
          </div>
          {organiser && (
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
                disabled={!report || exporting}
                onClick={() => void download("xlsx")}
              >
                Sponsor report (Excel)
              </Button>
            </div>
          )}
        </div>
        {organiser && report && <ScannerReportSummary report={report} />}
        {!organiser && (
          <div className="flex gap-2" role="group" aria-label="Lead list">
            <Button
              aria-pressed={view === "mine"}
              variant={view === "mine" ? "default" : "outline"}
              onClick={() => {
                setView("mine");
                setExpanded(null);
              }}
            >
              My scans
            </Button>
            <Button
              aria-pressed={view === "team"}
              variant={view === "team" ? "default" : "outline"}
              onClick={() => {
                setView("team");
                setExpanded(null);
              }}
            >
              Team leads
            </Button>
          </div>
        )}
        {pending > 0 && (
          <p role="status" className="text-sm text-amber-900">
            {pending} saved item{pending === 1 ? "" : "s"} awaiting connection or a badge check.
            Company reports include confirmed leads only.
          </p>
        )}
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search leads"
            className="pl-9 bg-white"
            placeholder="Search name or company"
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
              {expanded === leadKey(lead) && organiser && (
                <div className="border-t p-4">
                  {lead.notes.map((n) => (
                    <p key={n.id} className="mb-2">
                      <strong>{n.operatorName}</strong>
                      {n.rating ? " · " + n.rating + "/5" : ""}
                      {n.note ? ": " + n.note : ""}
                    </p>
                  ))}
                  {!lead.notes.length && <p>No notes yet.</p>}
                </div>
              )}
              {expanded === leadKey(lead) && credential && (
                <LeadNotes
                  key={credential.id + ":" + lead.id}
                  lead={lead}
                  credential={credential}
                />
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
            {!organiser && (
              <Button className="mt-4" onClick={() => navigate("/sponsor/scanner")}>
                Scan a badge
              </Button>
            )}
          </Card>
        )}
        {credential && (
          <Card className="p-4 space-y-3">
            <details>
              <summary className="cursor-pointer min-h-11 py-3 font-semibold">
                Finished scanning?
              </summary>
              <p className="text-sm">
                {summary.pendingScans +
                  summary.pendingNotes +
                  summary.rejected +
                  summary.otherWork >
                  0 ||
                summary.error ||
                !summary.loaded
                  ? "Keep this phone's saved work until the status above shows everything is backed up. You can download an offline recovery file if the connection has not returned."
                  : "All your saved leads and notes are backed up. Your coordinator can download the company report."}
              </p>
            </details>
            <ScannerRecoveryTools credential={credential} />
          </Card>
        )}
      </main>
    </div>
  );
}
