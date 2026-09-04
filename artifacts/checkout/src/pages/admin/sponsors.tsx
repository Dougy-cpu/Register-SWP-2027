import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Building2, ChevronRight, CircleAlert, Plus, Search, Users, X } from "lucide-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { adminJson } from "@/lib/admin-api";
import type { SponsorStatus, SponsorSummary, SponsorWorkspace } from "@/types/sponsor";
import {
  createSponsorSessionEntitlement,
  removeSponsorSessionEntitlement,
  sponsorSessionEntitlementError,
  sponsorSessionPayload,
  sponsorSessionTaskRequirements,
  updateSponsorSessionEntitlement,
  type SponsorSessionEntitlementDraft,
} from "./sponsor-session-entitlements";

const STATUS_LABELS: Record<SponsorStatus, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

function codeFromCompany(company: string) {
  return company.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function statusClass(status: SponsorStatus) {
  if (status === "confirmed") return "bg-emerald-100 text-emerald-800";
  if (status === "draft") return "bg-amber-100 text-amber-800";
  if (status === "paused") return "bg-orange-100 text-orange-800";
  if (status === "cancelled") return "bg-rose-100 text-rose-800";
  return "bg-blue-100 text-blue-800";
}

type CreateForm = {
  company: string;
  packageLabel: string;
  confirmationDate: string;
  notes: string;
  vipAllocation: string;
  vipMaxPerBooking: string;
  staffAllocation: string;
  vipCode: string;
  publicCode: string;
  primaryFirstName: string;
  primaryLastName: string;
  primaryJobTitle: string;
  primaryEmail: string;
  primaryPhone: string;
  onsiteFirstName: string;
  onsiteLastName: string;
  onsiteEmail: string;
  sessions: SponsorSessionEntitlementDraft[];
  sessionDeadline: string;
  assetDeadline: string;
  logisticsDeadline: string;
  assetsRequired: boolean;
  logisticsRequired: boolean;
  onsiteContactsRequired: boolean;
  communitySocialRequired: boolean;
};

const EMPTY_FORM: CreateForm = {
  company: "",
  packageLabel: "",
  confirmationDate: "",
  notes: "",
  vipAllocation: "0",
  vipMaxPerBooking: "1",
  staffAllocation: "0",
  vipCode: "",
  publicCode: "",
  primaryFirstName: "",
  primaryLastName: "",
  primaryJobTitle: "",
  primaryEmail: "",
  primaryPhone: "",
  onsiteFirstName: "",
  onsiteLastName: "",
  onsiteEmail: "",
  sessions: [],
  sessionDeadline: "",
  assetDeadline: "",
  logisticsDeadline: "",
  assetsRequired: true,
  logisticsRequired: true,
  onsiteContactsRequired: true,
  communitySocialRequired: true,
};

function SponsorCreatePanel({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const nextSessionId = useRef(1);
  const [codesEdited, setCodesEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const updateCompany = (company: string) => {
    const base = codeFromCompany(company);
    setForm((current) => ({
      ...current,
      company,
      ...(codesEdited ? {} : { vipCode: base ? `${base}VIP` : "", publicCode: base }),
    }));
  };

  const addSessionEntitlement = () => {
    const clientId = `session-${nextSessionId.current}`;
    nextSessionId.current += 1;
    setForm((current) => ({
      ...current,
      sessions: [...current.sessions, createSponsorSessionEntitlement(clientId)],
    }));
  };

  const updateSessionEntitlement = (
    clientId: string,
    patch: Partial<Omit<SponsorSessionEntitlementDraft, "clientId">>,
  ) => {
    setForm((current) => ({
      ...current,
      sessions: updateSponsorSessionEntitlement(current.sessions, clientId, patch),
    }));
  };

  const removeSessionEntitlement = (clientId: string) => {
    setForm((current) => ({
      ...current,
      sessions: removeSponsorSessionEntitlement(current.sessions, clientId),
    }));
  };

  const save = async () => {
    setError("");
    if (!form.company.trim() || !form.packageLabel.trim() || !form.primaryEmail.trim()) {
      setError("Company, package and primary contact details are required.");
      return;
    }
    const entitlementError = sponsorSessionEntitlementError(form.sessions);
    if (entitlementError) {
      setError(entitlementError);
      return;
    }
    setSaving(true);
    try {
      const contacts = [
        {
          role: "primary",
          firstName: form.primaryFirstName,
          lastName: form.primaryLastName,
          jobTitle: form.primaryJobTitle || null,
          email: form.primaryEmail,
          phone: form.primaryPhone || null,
          isPrimary: true,
        },
      ];
      if (form.onsiteFirstName || form.onsiteLastName || form.onsiteEmail) {
        contacts.push({
          role: "onsite",
          firstName: form.onsiteFirstName,
          lastName: form.onsiteLastName,
          jobTitle: null,
          email: form.onsiteEmail,
          phone: null,
          isPrimary: false,
        });
      }
      const task = (taskKey: string, label: string, dueAt: string, required = true) => ({
        taskKey,
        label,
        required,
        dueAt: dueAt ? new Date(`${dueAt}T17:00:00`).toISOString() : null,
        status: required ? "todo" : "not_required",
      });
      const sessions = sponsorSessionPayload(form.sessions);
      const sessionRequirements = sponsorSessionTaskRequirements(form.sessions);
      const tasks = [
        task("staff", "Sponsor staff", "", Number(form.staffAllocation) > 0),
        task(
          "sessions",
          "Session details",
          form.sessionDeadline,
          sessionRequirements.sessionsRequired,
        ),
        task(
          "speakers",
          "Speaker details",
          form.sessionDeadline,
          sessionRequirements.sessionsRequired,
        ),
        task("assets", "Brand and content assets", form.assetDeadline, form.assetsRequired),
        task("logistics", "Logistics", form.logisticsDeadline, form.logisticsRequired),
        task(
          "onsite_contacts",
          "Onsite contacts",
          form.logisticsDeadline,
          form.onsiteContactsRequired,
        ),
        task("slides", "Session slides", form.sessionDeadline, sessionRequirements.slidesRequired),
        task(
          "community_social",
          "Community Social details",
          form.logisticsDeadline,
          form.communitySocialRequired,
        ),
      ];
      const created = await adminJson<SponsorWorkspace>("/api/admin/sponsors", {
        method: "POST",
        body: JSON.stringify({
          company: form.company,
          packageLabel: form.packageLabel,
          confirmationDate: form.confirmationDate || null,
          notes: form.notes || null,
          vipAllocation: Number(form.vipAllocation),
          vipMaxPerBooking: Number(form.vipMaxPerBooking),
          staffAllocation: Number(form.staffAllocation),
          vipCode: form.vipCode,
          publicCode: form.publicCode,
          contacts,
          tasks,
          sessions,
        }),
      });
      navigate(`/admin/sponsors/${created.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sponsor could not be created");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm overflow-y-auto">
      <div className="min-h-full flex justify-end">
        <div className="w-full max-w-3xl bg-white min-h-screen shadow-2xl">
          <div className="sticky top-0 z-10 bg-white border-b px-6 py-5 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold">Add sponsor</h2>
              <p className="text-sm text-muted-foreground">
                Saved as a draft. Nothing is emailed until you review and send it.
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div className="p-6 space-y-8">
            <section className="grid md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <h3 className="font-semibold mb-1">Agreement</h3>
                <p className="text-sm text-muted-foreground">
                  Record the contract as agreed. Package names do not set allocations automatically.
                </p>
              </div>
              <div>
                <Label>Company</Label>
                <Input value={form.company} onChange={(e) => updateCompany(e.target.value)} />
              </div>
              <div>
                <Label>Package label</Label>
                <Input
                  value={form.packageLabel}
                  onChange={(e) => update("packageLabel", e.target.value)}
                  placeholder="e.g. Gold Partner"
                />
              </div>
              <div>
                <Label>Confirmation date</Label>
                <Input
                  type="date"
                  value={form.confirmationDate}
                  onChange={(e) => update("confirmationDate", e.target.value)}
                />
              </div>
              <div className="md:col-span-2">
                <Label>Internal notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => update("notes", e.target.value)}
                  rows={3}
                />
              </div>
            </section>

            <section className="grid sm:grid-cols-3 gap-4">
              <div className="sm:col-span-3">
                <h3 className="font-semibold">Pass allocations</h3>
              </div>
              <div>
                <Label>Free VIP passes</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.vipAllocation}
                  onChange={(e) => update("vipAllocation", e.target.value)}
                />
              </div>
              <div>
                <Label>VIP max per booking</Label>
                <Input
                  type="number"
                  min="1"
                  value={form.vipMaxPerBooking}
                  onChange={(e) => update("vipMaxPerBooking", e.target.value)}
                />
              </div>
              <div>
                <Label>Sponsor staff passes</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.staffAllocation}
                  onChange={(e) => update("staffAllocation", e.target.value)}
                />
              </div>
              <div>
                <Label>Private VIP code</Label>
                <Input
                  value={form.vipCode}
                  onChange={(e) => {
                    setCodesEdited(true);
                    update("vipCode", codeFromCompany(e.target.value));
                  }}
                />
              </div>
              <div>
                <Label>Public 20% code</Label>
                <Input
                  value={form.publicCode}
                  onChange={(e) => {
                    setCodesEdited(true);
                    update("publicCode", codeFromCompany(e.target.value));
                  }}
                />
              </div>
              <p className="sm:col-span-3 text-xs text-muted-foreground">
                Both codes are Workforce-only. The VIP code is capped; the public code is unlimited
                and applies after group discount.
              </p>
            </section>

            <section className="grid md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <h3 className="font-semibold">Primary contact</h3>
              </div>
              <div>
                <Label>First name</Label>
                <Input
                  value={form.primaryFirstName}
                  onChange={(e) => update("primaryFirstName", e.target.value)}
                />
              </div>
              <div>
                <Label>Last name</Label>
                <Input
                  value={form.primaryLastName}
                  onChange={(e) => update("primaryLastName", e.target.value)}
                />
              </div>
              <div>
                <Label>Job title</Label>
                <Input
                  value={form.primaryJobTitle}
                  onChange={(e) => update("primaryJobTitle", e.target.value)}
                />
              </div>
              <div>
                <Label>Work email</Label>
                <Input
                  type="email"
                  value={form.primaryEmail}
                  onChange={(e) => update("primaryEmail", e.target.value)}
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  value={form.primaryPhone}
                  onChange={(e) => update("primaryPhone", e.target.value)}
                />
              </div>
              <div className="md:col-span-2 pt-3">
                <h4 className="text-sm font-semibold">Onsite contact (optional)</h4>
              </div>
              <div>
                <Label>First name</Label>
                <Input
                  value={form.onsiteFirstName}
                  onChange={(e) => update("onsiteFirstName", e.target.value)}
                />
              </div>
              <div>
                <Label>Last name</Label>
                <Input
                  value={form.onsiteLastName}
                  onChange={(e) => update("onsiteLastName", e.target.value)}
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.onsiteEmail}
                  onChange={(e) => update("onsiteEmail", e.target.value)}
                />
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-semibold">Session entitlements</h3>
                  <p className="text-sm text-muted-foreground">
                    Add every contracted Quickfire, speaking slot or other session separately. They
                    are never inferred from the package name.
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={addSessionEntitlement}>
                  <Plus className="h-4 w-4 mr-2" />
                  {form.sessions.length === 0 ? "Add session" : "Add another session"}
                </Button>
              </div>

              {form.sessions.length === 0 && (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No session slots are included in this agreement.
                </div>
              )}

              <div className="space-y-4">
                {form.sessions.map((session, index) => {
                  const typeId = `${session.clientId}-type`;
                  const labelId = `${session.clientId}-label`;
                  const placeholder =
                    session.type === "quickfire"
                      ? "e.g. 10-minute Quickfire"
                      : session.type === "keynote"
                        ? "e.g. 30-minute main-stage speaking slot"
                        : "e.g. Panel, workshop or breakout slot";
                  return (
                    <Card key={session.clientId} className="p-4 space-y-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold">Session {index + 1}</p>
                          <p className="text-xs text-muted-foreground">
                            This will appear as a separate submission in the sponsor workspace.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeSessionEntitlement(session.clientId)}
                          aria-label={`Remove session ${index + 1}`}
                        >
                          Remove
                        </Button>
                      </div>
                      <div className="grid md:grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor={typeId}>Session type</Label>
                          <Select
                            value={session.type}
                            onValueChange={(value) =>
                              updateSessionEntitlement(session.clientId, {
                                type: value as SponsorSessionEntitlementDraft["type"],
                              })
                            }
                          >
                            <SelectTrigger id={typeId}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="quickfire">Quickfire</SelectItem>
                              <SelectItem value="keynote">Keynote / main-stage slot</SelectItem>
                              <SelectItem value="other">Speaking slot / other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label htmlFor={labelId}>Entitlement label</Label>
                          <Input
                            id={labelId}
                            value={session.entitlementLabel}
                            onChange={(e) =>
                              updateSessionEntitlement(session.clientId, {
                                entitlementLabel: e.target.value,
                              })
                            }
                            placeholder={placeholder}
                            maxLength={250}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={session.headshotRequired}
                            onChange={(e) =>
                              updateSessionEntitlement(session.clientId, {
                                headshotRequired: e.target.checked,
                              })
                            }
                          />{" "}
                          Headshot required
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={session.takeawaysRequired}
                            onChange={(e) =>
                              updateSessionEntitlement(session.clientId, {
                                takeawaysRequired: e.target.checked,
                              })
                            }
                          />{" "}
                          Takeaways required
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={session.slidesRequired}
                            onChange={(e) =>
                              updateSessionEntitlement(session.clientId, {
                                slidesRequired: e.target.checked,
                              })
                            }
                          />{" "}
                          Slides required
                        </label>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>

            <section className="grid sm:grid-cols-3 gap-4">
              <div className="sm:col-span-3">
                <h3 className="font-semibold">Deliverables and deadlines</h3>
                <p className="text-sm text-muted-foreground">
                  Only mark items required when they are part of this sponsor's agreement.
                </p>
              </div>
              <div className="sm:col-span-3 flex flex-wrap gap-x-6 gap-y-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.assetsRequired}
                    onChange={(e) => update("assetsRequired", e.target.checked)}
                  />{" "}
                  Brand/content assets
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.logisticsRequired}
                    onChange={(e) => update("logisticsRequired", e.target.checked)}
                  />{" "}
                  Logistics
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.onsiteContactsRequired}
                    onChange={(e) => update("onsiteContactsRequired", e.target.checked)}
                  />{" "}
                  Onsite contact
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.communitySocialRequired}
                    onChange={(e) => update("communitySocialRequired", e.target.checked)}
                  />{" "}
                  Community Social details
                </label>
              </div>
              <div>
                <Label>Session and speaker</Label>
                <Input
                  type="date"
                  value={form.sessionDeadline}
                  onChange={(e) => update("sessionDeadline", e.target.value)}
                />
              </div>
              <div>
                <Label>Assets</Label>
                <Input
                  type="date"
                  value={form.assetDeadline}
                  onChange={(e) => update("assetDeadline", e.target.value)}
                />
              </div>
              <div>
                <Label>Logistics</Label>
                <Input
                  type="date"
                  value={form.logisticsDeadline}
                  onChange={(e) => update("logisticsDeadline", e.target.value)}
                />
              </div>
            </section>

            {error && (
              <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-sm text-rose-800">
                {error}
              </div>
            )}
          </div>
          <div className="sticky bottom-0 bg-white border-t px-6 py-4 flex justify-end gap-3">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save draft sponsor"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminSponsors() {
  const [, navigate] = useLocation();
  const [sponsors, setSponsors] = useState<SponsorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | SponsorStatus>("all");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setLoading(true);
    const query = new URLSearchParams();
    if (status !== "all") query.set("status", status);
    if (search.trim()) query.set("search", search.trim());
    const timer = window.setTimeout(() => {
      adminJson<{ sponsors: SponsorSummary[] }>(`/api/admin/sponsors?${query}`)
        .then((data) => {
          setSponsors(data.sponsors);
          setError("");
        })
        .catch((caught) =>
          setError(caught instanceof Error ? caught.message : "Sponsors could not be loaded"),
        )
        .finally(() => setLoading(false));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, status]);

  const totals = useMemo(
    () => ({
      confirmed: sponsors.filter((item) => item.status === "confirmed").length,
      vipRemaining: sponsors.reduce(
        (sum, item) => sum + Math.max(0, item.vipAllocation - item.vipUsed),
        0,
      ),
      attention: sponsors.reduce((sum, item) => sum + item.needsAttention, 0),
    }),
    [sponsors],
  );

  return (
    <AdminLayout title="Sponsors">
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
          <div>
            <p className="text-muted-foreground">
              Passes, people, content, files and deadlines in one place.
            </p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add sponsor
          </Button>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <Card className="p-5">
            <p className="text-xs uppercase font-bold text-muted-foreground">Confirmed sponsors</p>
            <p className="text-3xl font-bold mt-1">{totals.confirmed}</p>
          </Card>
          <Card className="p-5">
            <p className="text-xs uppercase font-bold text-muted-foreground">
              VIP passes remaining
            </p>
            <p className="text-3xl font-bold mt-1">{totals.vipRemaining}</p>
          </Card>
          <Card className={`p-5 ${totals.attention ? "border-amber-300 bg-amber-50" : ""}`}>
            <p className="text-xs uppercase font-bold text-muted-foreground">Needs attention</p>
            <p className="text-3xl font-bold mt-1">{totals.attention}</p>
          </Card>
        </div>

        <Card className="p-4 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search company"
            />
          </div>
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger className="sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Card>

        {error && (
          <div className="rounded-md bg-rose-50 border border-rose-200 p-4 text-rose-800">
            {error}
          </div>
        )}
        <Card className="overflow-hidden">
          <div className="divide-y">
            {sponsors.map((sponsor) => (
              <button
                key={sponsor.id}
                onClick={() => navigate(`/admin/sponsors/${sponsor.id}`)}
                className="w-full text-left p-5 hover:bg-blue-50/50 transition-colors grid md:grid-cols-[minmax(220px,1.4fr)_1fr_1fr_1fr_auto] gap-4 items-center"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-primary/10 rounded-md flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold">{sponsor.company}</p>
                    <p className="text-sm text-muted-foreground">{sponsor.packageLabel}</p>
                  </div>
                </div>
                <div>
                  <Badge className={statusClass(sponsor.status)}>
                    {STATUS_LABELS[sponsor.status]}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">VIP use</p>
                  <p className="font-semibold">
                    {sponsor.vipUsed} / {sponsor.vipAllocation}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Staff</p>
                  <p className="font-semibold">
                    {sponsor.staffUsed} / {sponsor.staffAllocation}
                  </p>
                </div>
                <div className="flex items-center gap-3 justify-end">
                  {sponsor.needsAttention > 0 && (
                    <span className="inline-flex items-center gap-1 text-sm text-amber-700">
                      <CircleAlert className="h-4 w-4" /> {sponsor.needsAttention}
                    </span>
                  )}
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </div>
              </button>
            ))}
            {!loading && sponsors.length === 0 && (
              <div className="p-12 text-center">
                <Users className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                <p className="font-semibold">No sponsors found</p>
                <p className="text-sm text-muted-foreground">
                  Add the first sponsor or change the filters.
                </p>
              </div>
            )}
            {loading && (
              <div className="p-12 text-center text-muted-foreground">Loading sponsors…</div>
            )}
          </div>
        </Card>
      </div>
      {creating && <SponsorCreatePanel onClose={() => setCreating(false)} />}
    </AdminLayout>
  );
}
