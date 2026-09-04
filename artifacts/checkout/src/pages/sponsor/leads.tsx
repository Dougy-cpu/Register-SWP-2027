import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Download,
  Search,
  Star,
  TriangleAlert,
} from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { syncPendingScannerItems } from "@/lib/scanner-api";
import { pendingScannerCount, rejectedScannerItems } from "@/lib/scanner-storage";
import { sponsorFetch, sponsorJson } from "@/lib/sponsor-api";
import type { SponsorLead } from "@/types/lead-scanner";

function formatDateTime(value?: string | null): string {
  if (!value) return "Not available";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SponsorLeads() {
  const [, navigate] = useLocation();
  const [leads, setLeads] = useState<SponsorLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [operatorName, setOperatorName] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [localItemsNeedingAttention, setLocalItemsNeedingAttention] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (navigator.onLine) await syncPendingScannerItems().catch(() => undefined);
      const [pending, rejected] = await Promise.all([
        pendingScannerCount(),
        rejectedScannerItems(),
      ]);
      const data = await sponsorJson<{ leads: SponsorLead[] }>("/api/sponsor/leads");
      setLeads(data.leads);
      setLocalItemsNeedingAttention(pending + rejected.length);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Leads could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return leads;
    return leads.filter((lead) =>
      [lead.name, lead.jobTitle, lead.company, lead.workEmail].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [leads, search]);

  const openLead = (lead: SponsorLead) => {
    const next = expanded === lead.id ? null : lead.id;
    setExpanded(next);
    setRating(next ? lead.rating : null);
    setNote("");
  };

  const save = async (leadId: string) => {
    setSaving(true);
    setError("");
    try {
      await sponsorJson(`/api/sponsor/leads/${leadId}`, {
        method: "PATCH",
        body: JSON.stringify({ operatorName, rating, note }),
      });
      setNote("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The lead could not be updated");
    } finally {
      setSaving(false);
    }
  };

  const download = async (format: "csv" | "xlsx") => {
    if (localItemsNeedingAttention) {
      setError("Finish synchronising or ask the organiser to review this phone before exporting.");
      return;
    }
    setExporting(format);
    setError("");
    try {
      const response = await sponsorFetch(`/api/sponsor/leads/export?format=${format}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "The export could not be created");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `swp-2027-sponsor-leads.${format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The export could not be created");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between gap-4">
          <button
            onClick={() => navigate("/sponsor")}
            className="flex items-center gap-3 text-left"
          >
            <ArrowLeft className="h-5 w-5" />
            <img src={logoUrl} alt="SWP Summit" className="h-10 w-auto hidden sm:block" />
            <div>
              <h1 className="font-bold">Leads</h1>
              <p className="text-xs text-muted-foreground">Server-synchronised sponsor leads</p>
            </div>
          </button>
          <Button onClick={() => navigate("/sponsor/scanner")}>Scan badge</Button>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-800 flex gap-2">
            <TriangleAlert className="h-5 w-5 shrink-0" />
            <div>
              <p>{error}</p>
              {/expired|session/i.test(error) && (
                <p className="text-sm mt-1">Open your private sponsor link again to continue.</p>
              )}
            </div>
          </div>
        )}
        {localItemsNeedingAttention > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 flex gap-2">
            <TriangleAlert className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Export is paused on this phone</p>
              <p className="text-sm mt-1">
                {localItemsNeedingAttention} saved item
                {localItemsNeedingAttention === 1 ? " needs" : "s need"} to finish synchronising or
                be reviewed. Nothing has been discarded.
              </p>
            </div>
          </div>
        )}
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] font-bold text-primary">
              SWP Summit 2027
            </p>
            <h2 className="text-3xl font-bold mt-1">Your scanned leads</h2>
            <p className="text-muted-foreground mt-2">
              {leads.length} unique lead{leads.length === 1 ? "" : "s"}. Duplicate scans are kept in
              the history, not added as extra people.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void download("csv")}
              disabled={Boolean(exporting) || localItemsNeedingAttention > 0}
            >
              <Download className="h-4 w-4 mr-2" /> CSV
            </Button>
            <Button
              onClick={() => void download("xlsx")}
              disabled={Boolean(exporting) || localItemsNeedingAttention > 0}
            >
              <Download className="h-4 w-4 mr-2" /> {exporting === "xlsx" ? "Preparing…" : "Excel"}
            </Button>
          </div>
        </div>
        <Card className="p-4 swp-card">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, company, job title or email"
              className="pl-9"
            />
          </div>
        </Card>
        {loading ? (
          <Card className="p-10 text-center text-muted-foreground">Loading leads…</Card>
        ) : filtered.length ? (
          <div className="space-y-3">
            {filtered.map((lead) => (
              <Card key={lead.id} className="overflow-hidden swp-card">
                <button
                  className="w-full p-5 text-left flex items-start justify-between gap-4"
                  onClick={() => openLead(lead)}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold text-lg">{lead.name}</h3>
                      {lead.rating && (
                        <Badge className="bg-blue-50 text-primary border border-blue-100">
                          <Star className="h-3 w-3 mr-1 fill-current" /> {lead.rating}/5
                        </Badge>
                      )}
                      {lead.scanCount > 1 && (
                        <Badge variant="outline">Scanned {lead.scanCount}×</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1">
                      {lead.jobTitle}, {lead.company}
                    </p>
                    <p className="text-sm text-primary mt-1 break-all">{lead.workEmail}</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      Last scanned {formatDateTime(lead.lastScannedAt)}
                    </p>
                  </div>
                  {expanded === lead.id ? (
                    <ChevronUp className="h-5 w-5 shrink-0" />
                  ) : (
                    <ChevronDown className="h-5 w-5 shrink-0" />
                  )}
                </button>
                {expanded === lead.id && (
                  <div className="border-t bg-slate-50/70 p-5 space-y-5">
                    <div className="grid md:grid-cols-2 gap-5">
                      <div>
                        <h4 className="font-semibold">Scan history</h4>
                        <div className="space-y-2 mt-2">
                          {lead.scans.map((scan) => (
                            <div key={scan.id} className="text-sm rounded-lg bg-white border p-3">
                              <span className="font-medium">{scan.operatorName}</span>
                              <span className="text-muted-foreground">
                                {` · ${formatDateTime(scan.capturedAt)} · ${scan.source}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <h4 className="font-semibold">Notes and rating history</h4>
                        <div className="space-y-2 mt-2">
                          {lead.notes.map((item) => (
                            <div key={item.id} className="text-sm rounded-lg bg-white border p-3">
                              <p>
                                <span className="font-medium">{item.operatorName}</span>
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {formatDateTime(item.createdAt)}
                                </span>
                              </p>
                              {item.rating && (
                                <p className="text-primary font-semibold mt-1">
                                  Rating {item.rating}/5
                                </p>
                              )}
                              {item.note && <p className="mt-1 whitespace-pre-wrap">{item.note}</p>}
                            </div>
                          ))}
                          {!lead.notes.length && (
                            <p className="text-sm text-muted-foreground">No notes yet.</p>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="border-t pt-5">
                      <h4 className="font-semibold">Add an update</h4>
                      <div className="grid md:grid-cols-[220px_1fr] gap-4 mt-3">
                        <div>
                          <Label htmlFor={`operator-${lead.id}`}>Your name</Label>
                          <Input
                            id={`operator-${lead.id}`}
                            value={operatorName}
                            onChange={(event) => setOperatorName(event.target.value)}
                            className="mt-1"
                          />
                          <Label className="block mt-4">Rating</Label>
                          <div className="flex gap-1 mt-1">
                            {[1, 2, 3, 4, 5].map((value) => (
                              <button
                                key={value}
                                onClick={() => setRating(rating === value ? null : value)}
                                className={`h-9 w-9 rounded-lg border font-semibold ${
                                  rating === value
                                    ? "bg-primary text-white border-primary"
                                    : "bg-white"
                                }`}
                              >
                                {value}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <Label htmlFor={`note-${lead.id}`}>New note</Label>
                          <Textarea
                            id={`note-${lead.id}`}
                            rows={4}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="Add context from your conversation"
                            className="mt-1 bg-white"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end mt-3">
                        <Button
                          onClick={() => void save(lead.id)}
                          disabled={
                            saving ||
                            operatorName.trim().length < 2 ||
                            (!note.trim() && rating === null)
                          }
                        >
                          {saving ? "Saving…" : "Save update"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <Card className="p-10 text-center">
            <h3 className="font-semibold">No matching leads</h3>
            <p className="text-sm text-muted-foreground mt-2">
              Scan an attendee badge, then wait for the phone to show All leads synced.
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
