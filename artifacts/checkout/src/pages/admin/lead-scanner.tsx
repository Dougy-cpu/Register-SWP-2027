import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  QrCode,
  RefreshCw,
  RotateCw,
  Search,
  ShieldOff,
  Smartphone,
  TriangleAlert,
  Users,
} from "lucide-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminJson, downloadAdminFile } from "@/lib/admin-api";
import type {
  LeadScannerAdminOverview,
  LeadScannerAttendee,
  SponsorLead,
} from "@/types/lead-scanner";

function formatDateTime(value?: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function deviceStatus(status: string): { label: string; className: string } {
  if (status === "ready") return { label: "Ready", className: "bg-emerald-100 text-emerald-800" };
  if (status === "out_of_date")
    return { label: "Out of date", className: "bg-amber-100 text-amber-900" };
  if (status === "revoked") return { label: "Revoked", className: "bg-slate-200 text-slate-700" };
  return { label: "Not tested", className: "bg-rose-100 text-rose-800" };
}

export default function AdminLeadScanner() {
  const [overview, setOverview] = useState<LeadScannerAdminOverview | null>(null);
  const [leads, setLeads] = useState<SponsorLead[]>([]);
  const [attendees, setAttendees] = useState<LeadScannerAttendee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [sponsorId, setSponsorId] = useState("all");
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = sponsorId === "all" ? "" : `?sponsorId=${sponsorId}`;
      const [overviewData, leadData, attendeeData] = await Promise.all([
        adminJson<LeadScannerAdminOverview>("/api/admin/lead-scanner/overview"),
        adminJson<{ leads: SponsorLead[] }>(`/api/admin/lead-scanner/leads${query}`),
        adminJson<{ attendees: LeadScannerAttendee[] }>("/api/admin/lead-scanner/attendees"),
      ]);
      setOverview(overviewData);
      setLeads(leadData.leads);
      setAttendees(attendeeData.attendees);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Lead scanner data could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [sponsorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sponsors = useMemo(() => {
    const values = new Map<number, string>();
    overview?.devices.forEach((device) => values.set(device.sponsorId, device.sponsorCompany));
    leads.forEach((lead) => values.set(lead.sponsorId, lead.sponsorCompany));
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [leads, overview]);

  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return leads;
    return leads.filter((lead) =>
      [lead.name, lead.company, lead.jobTitle, lead.workEmail, lead.sponsorCompany].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [leads, search]);

  const perform = async (key: string, action: () => Promise<unknown>, success: string) => {
    setWorking(key);
    setError("");
    try {
      await action();
      setNotice(success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved");
    } finally {
      setWorking(null);
    }
  };

  const exportQuery = sponsorId === "all" ? "" : `&sponsorId=${sponsorId}`;
  const badgeReady = attendees.filter(
    (attendee) =>
      !attendee.isTbc &&
      !attendee.leadSharingExcluded &&
      Boolean(attendee.leadSharingNoticeAt) &&
      attendee.badgeActive,
  ).length;

  return (
    <AdminLayout title="Sponsor Lead Scanner">
      <div className="space-y-6">
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-rose-800 flex gap-2">
            <TriangleAlert className="h-5 w-5 shrink-0" /> {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800 flex gap-2">
            <CheckCircle2 className="h-5 w-5 shrink-0" /> {notice}
          </div>
        )}

        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <p className="text-muted-foreground">
              Badge readiness, sponsor phones, synchronised leads and exports in one place.
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              The badge CSV contains first name, last name, job title, company and the hidden QR
              code for your converter.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button
              onClick={() =>
                void downloadAdminFile(
                  "/api/admin/lead-scanner/badges/export",
                  "swp-2027-badge-data.csv",
                )
              }
            >
              <QrCode className="h-4 w-4 mr-2" /> Export badge CSV
            </Button>
          </div>
        </div>

        {overview && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-slate-700">
            <strong>Scanner readiness-test QR:</strong>{" "}
            <code className="rounded bg-white px-2 py-1 font-mono font-bold select-all">
              {overview.testQrValue}
            </code>
            <span className="ml-2">
              Convert this separately. It is not an attendee and is never included in the badge CSV.
            </span>
          </div>
        )}

        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <Metric label="Unique leads" value={overview?.leadCount ?? 0} icon={Users} />
          <Metric label="Sponsor phones" value={overview?.deviceCount ?? 0} icon={Smartphone} />
          <Metric
            label="Ready phones"
            value={overview?.devices.filter((d) => d.status === "ready").length ?? 0}
            icon={CheckCircle2}
          />
          <Metric label="Badge ready" value={badgeReady} icon={QrCode} />
        </div>

        {overview && !overview.scannerWindow.eventEndAt && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
            Configure the event start and end time in Settings before scanning. The scanner fails
            closed until an end time exists.
          </div>
        )}

        <Card className="swp-card overflow-hidden">
          <div className="p-5 border-b flex items-center justify-between gap-4">
            <div>
              <h2 className="font-bold text-lg">Sponsor phones</h2>
              <p className="text-sm text-muted-foreground">
                Each operator has an independent device identity and can be revoked separately.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-3 text-left">Sponsor</th>
                  <th className="p-3 text-left">Operator</th>
                  <th className="p-3 text-left">Status</th>
                  <th className="p-3 text-left">Last seen</th>
                  <th className="p-3 text-left">Last synced</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overview?.devices.map((device) => {
                  const status = deviceStatus(device.status);
                  return (
                    <tr key={device.id}>
                      <td className="p-3 font-medium">{device.sponsorCompany}</td>
                      <td className="p-3">{device.operatorName}</td>
                      <td className="p-3">
                        <Badge className={status.className}>{status.label}</Badge>
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {formatDateTime(device.lastSeenAt)}
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {formatDateTime(device.lastSyncedAt)}
                      </td>
                      <td className="p-3 text-right">
                        {device.status !== "revoked" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working === `device:${device.id}`}
                            onClick={() => {
                              if (!window.confirm(`Revoke ${device.operatorName}'s scanner?`))
                                return;
                              void perform(
                                `device:${device.id}`,
                                () =>
                                  adminJson(`/api/admin/lead-scanner/devices/${device.id}/revoke`, {
                                    method: "POST",
                                    body: JSON.stringify({ reason: "Revoked by organiser" }),
                                  }),
                                `${device.operatorName}'s phone was revoked`,
                              );
                            }}
                          >
                            <ShieldOff className="h-4 w-4 mr-2" /> Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!overview?.devices.length && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">
                      No sponsor phones activated yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="swp-card overflow-hidden">
          <div className="p-5 border-b flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
            <div>
              <h2 className="font-bold text-lg">Synchronised leads</h2>
              <p className="text-sm text-muted-foreground">
                Exports include scan times, operators, ratings, notes and duplicate counts.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={sponsorId} onValueChange={setSponsorId}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="All sponsors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sponsors</SelectItem>
                  {sponsors.map(([id, company]) => (
                    <SelectItem key={id} value={String(id)}>
                      {company}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() =>
                  void downloadAdminFile(
                    `/api/admin/lead-scanner/leads/export?format=csv${exportQuery}`,
                    "swp-2027-leads.csv",
                  )
                }
              >
                <Download className="h-4 w-4 mr-2" /> CSV
              </Button>
              <Button
                onClick={() =>
                  void downloadAdminFile(
                    `/api/admin/lead-scanner/leads/export?format=xlsx${exportQuery}`,
                    "swp-2027-leads.xlsx",
                  )
                }
              >
                <Download className="h-4 w-4 mr-2" /> Excel
              </Button>
            </div>
          </div>
          <div className="p-4 border-b bg-slate-50">
            <div className="relative max-w-xl">
              <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9 bg-white"
                placeholder="Search lead or sponsor"
              />
            </div>
          </div>
          <div className="overflow-x-auto max-h-[34rem]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="p-3 text-left">Lead</th>
                  <th className="p-3 text-left">Sponsor</th>
                  <th className="p-3 text-left">Rating</th>
                  <th className="p-3 text-left">Scans</th>
                  <th className="p-3 text-left">Last scanned</th>
                  <th className="p-3 text-left">Latest note</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredLeads.map((lead) => (
                  <tr key={lead.id}>
                    <td className="p-3">
                      <p className="font-medium">{lead.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {lead.jobTitle}, {lead.company}
                      </p>
                      <p className="text-xs text-primary">{lead.workEmail}</p>
                    </td>
                    <td className="p-3">{lead.sponsorCompany}</td>
                    <td className="p-3">{lead.rating ? `${lead.rating}/5` : "Not set"}</td>
                    <td className="p-3">{lead.scanCount}</td>
                    <td className="p-3 text-muted-foreground">
                      {formatDateTime(lead.lastScannedAt)}
                    </td>
                    <td className="p-3 max-w-xs truncate">
                      {lead.notes.find((item) => item.note)?.note ?? "No note"}
                    </td>
                  </tr>
                ))}
                {!filteredLeads.length && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">
                      No leads in this view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="swp-card overflow-hidden">
          <div className="p-5 border-b">
            <h2 className="font-bold text-lg">Attendee badge readiness</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Existing attendees must have the lead-sharing notice confirmed before their QR value
              is included. Excluded and TBC attendees never resolve in the scanner.
            </p>
          </div>
          <div className="overflow-x-auto max-h-[42rem]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="p-3 text-left">Attendee</th>
                  <th className="p-3 text-left">Notice</th>
                  <th className="p-3 text-left">Lead sharing</th>
                  <th className="p-3 text-left">Badge</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {attendees.map((attendee) => (
                  <tr key={attendee.attendeeId}>
                    <td className="p-3">
                      <p className="font-medium">{attendee.name}</p>
                      <p className="text-xs text-muted-foreground">{attendee.company}</p>
                    </td>
                    <td className="p-3">
                      {attendee.leadSharingNoticeAt ? (
                        <Badge className="bg-emerald-100 text-emerald-800">Confirmed</Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-900">Required</Badge>
                      )}
                    </td>
                    <td className="p-3">
                      <Badge
                        className={
                          attendee.leadSharingExcluded
                            ? "bg-slate-200 text-slate-700"
                            : "bg-blue-50 text-primary"
                        }
                      >
                        {attendee.leadSharingExcluded ? "Excluded" : "Included"}
                      </Badge>
                    </td>
                    <td className="p-3">
                      {attendee.badgeActive
                        ? `Ready · version ${attendee.badgeVersion}`
                        : "Not issued"}
                    </td>
                    <td className="p-3">
                      <div className="flex justify-end flex-wrap gap-2">
                        {!attendee.leadSharingNoticeAt && !attendee.isTbc && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working === `notice:${attendee.attendeeId}`}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Confirm that ${attendee.name} received the badge-scanning notice?`,
                                )
                              )
                                return;
                              void perform(
                                `notice:${attendee.attendeeId}`,
                                () =>
                                  adminJson(
                                    `/api/admin/lead-scanner/attendees/${attendee.attendeeId}/sharing`,
                                    {
                                      method: "PATCH",
                                      body: JSON.stringify({ noticeConfirmed: true }),
                                    },
                                  ),
                                `Notice confirmed for ${attendee.name}`,
                              );
                            }}
                          >
                            Confirm notice
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={working === `sharing:${attendee.attendeeId}` || attendee.isTbc}
                          onClick={() =>
                            void perform(
                              `sharing:${attendee.attendeeId}`,
                              () =>
                                adminJson(
                                  `/api/admin/lead-scanner/attendees/${attendee.attendeeId}/sharing`,
                                  {
                                    method: "PATCH",
                                    body: JSON.stringify({
                                      excluded: !attendee.leadSharingExcluded,
                                    }),
                                  },
                                ),
                              `${attendee.name} ${attendee.leadSharingExcluded ? "included" : "excluded"}`,
                            )
                          }
                        >
                          {attendee.leadSharingExcluded ? "Include" : "Exclude"}
                        </Button>
                        {attendee.badgeVersion && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working === `rotate:${attendee.attendeeId}`}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Replace ${attendee.name}'s QR value? Their previous printed QR will stop working.`,
                                )
                              )
                                return;
                              void perform(
                                `rotate:${attendee.attendeeId}`,
                                () =>
                                  adminJson(
                                    `/api/admin/lead-scanner/attendees/${attendee.attendeeId}/badge/rotate`,
                                    { method: "POST", body: "{}" },
                                  ),
                                `${attendee.name}'s QR value was replaced`,
                              );
                            }}
                          >
                            <RotateCw className="h-4 w-4 mr-2" /> Rotate
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!attendees.length && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      No confirmed attendees found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AdminLayout>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Users;
}) {
  return (
    <Card className="p-5 swp-card">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase font-bold text-muted-foreground">{label}</p>
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <p className="text-3xl font-bold mt-2">{value}</p>
    </Card>
  );
}
