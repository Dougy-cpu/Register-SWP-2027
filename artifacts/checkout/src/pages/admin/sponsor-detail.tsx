import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import {
  Archive,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FileArchive,
  FileText,
  Image as ImageIcon,
  Mail,
  RefreshCw,
  RotateCcw,
  Send,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import AdminLayout from "@/components/layout/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, adminJson, downloadAdminFile } from "@/lib/admin-api";
import type {
  SponsorAsset,
  SponsorAssetCategory,
  SponsorContact,
  SponsorSession,
  SponsorStatus,
  SponsorTask,
  SponsorWorkspace,
} from "@/types/sponsor";

const CATEGORIES: Array<{ value: SponsorAssetCategory; label: string }> = [
  { value: "logo", label: "Logo" },
  { value: "headshot", label: "Headshot" },
  { value: "slides", label: "Slides" },
  { value: "session_material", label: "Session material" },
  { value: "logistics", label: "Logistics" },
  { value: "other", label: "Other" },
];

function formatDate(value?: string | null) {
  if (!value) return "Not set";
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusClass(status: string) {
  if (["confirmed", "approved", "completed", "active", "exported"].includes(status))
    return "bg-emerald-100 text-emerald-800";
  if (["draft", "submitted", "todo"].includes(status)) return "bg-amber-100 text-amber-800";
  if (["changes_requested", "overdue", "missing", "cancelled"].includes(status))
    return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function copy(text: string) {
  return navigator.clipboard.writeText(text);
}

function SecurePreview({ sponsorId, asset }: { sponsorId: number; asset: SponsorAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset.previewAvailable) return;
    let active = true;
    let objectUrl = "";
    adminFetch(`/api/admin/sponsors/${sponsorId}/assets/${asset.id}/download?preview=true`)
      .then((response) => (response.ok ? response.blob() : Promise.reject()))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id, asset.previewAvailable, sponsorId]);
  return url ? (
    <img src={url} alt="" className="h-12 w-12 rounded object-cover border bg-white" />
  ) : (
    <div className="h-12 w-12 rounded border bg-muted flex items-center justify-center">
      {asset.previewAvailable ? (
        <ImageIcon className="h-5 w-5 text-muted-foreground" />
      ) : (
        <FileText className="h-5 w-5 text-muted-foreground" />
      )}
    </div>
  );
}

type EditForm = {
  company: string;
  packageLabel: string;
  confirmationDate: string;
  notes: string;
  vipAllocation: string;
  vipMaxPerBooking: string;
  staffAllocation: string;
  vipCode: string;
  publicCode: string;
  status: SponsorStatus;
};

type SessionEntitlementDraft = {
  type: SponsorSession["type"];
  entitlementLabel: string;
  headshotRequired: boolean;
  takeawaysRequired: boolean;
  slidesRequired: boolean;
};

const EMPTY_SESSION_ENTITLEMENT: SessionEntitlementDraft = {
  type: "quickfire",
  entitlementLabel: "",
  headshotRequired: true,
  takeawaysRequired: true,
  slidesRequired: false,
};

export default function AdminSponsorDetail() {
  const params = useParams<{ sponsorId: string }>();
  const sponsorId = Number(params.sponsorId);
  const [workspace, setWorkspace] = useState<SponsorWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [contacts, setContacts] = useState<SponsorContact[]>([]);
  const [preview, setPreview] = useState<{
    to: string[];
    subject: string;
    html: string;
    previewHash: string;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [assetCategory, setAssetCategory] = useState<SponsorAssetCategory>("logo");
  const [assetSessionId, setAssetSessionId] = useState<string>("none");
  const [assetPresenterId, setAssetPresenterId] = useState<string>("none");
  const [logisticsDocumentTitle, setLogisticsDocumentTitle] = useState("");
  const [logisticsDocumentRequired, setLogisticsDocumentRequired] = useState(true);
  const [assetFilter, setAssetFilter] = useState<"all" | SponsorAssetCategory>("all");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [addingSession, setAddingSession] = useState(false);
  const [newSession, setNewSession] = useState<SessionEntitlementDraft>(EMPTY_SESSION_ENTITLEMENT);
  const assetInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminJson<SponsorWorkspace>(`/api/admin/sponsors/${sponsorId}`);
      setWorkspace(data);
      setContacts(data.contacts);
      setForm({
        company: data.company,
        packageLabel: data.packageLabel,
        confirmationDate: data.confirmationDate ?? "",
        notes: data.notes ?? "",
        vipAllocation: String(data.vipAllocation),
        vipMaxPerBooking: String(
          data.codes.find((code) => code.kind === "vip")?.maxPerBooking ?? 1,
        ),
        staffAllocation: String(data.staffAllocation),
        vipCode: data.vipCodeDraft ?? data.codes.find((code) => code.kind === "vip")?.code ?? "",
        publicCode:
          data.publicCodeDraft ?? data.codes.find((code) => code.kind === "public")?.code ?? "",
        status: data.status,
      });
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sponsor could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [sponsorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  };

  const save = async (statusOverride?: SponsorStatus) => {
    if (!form || !workspace) return;
    setSaving(true);
    setError("");
    try {
      const updated = await adminJson<SponsorWorkspace>(`/api/admin/sponsors/${sponsorId}`, {
        method: "PATCH",
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
          status: statusOverride ?? form.status,
          contacts,
          tasks: workspace.tasks.map((task) => ({
            taskKey: task.taskKey,
            label: task.label,
            required: task.required,
            dueAt: task.dueAt,
            status: task.status,
          })),
        }),
      });
      setWorkspace(updated);
      setForm((current) => (current ? { ...current, status: updated.status } : current));
      flash("Sponsor record saved");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sponsor could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const confirm = async () => {
    if (
      !window.confirm(
        "Confirm this sponsor and activate both Workforce promo codes? No welcome email will be sent.",
      )
    )
      return;
    try {
      const updated = await adminJson<SponsorWorkspace>(
        `/api/admin/sponsors/${sponsorId}/confirm`,
        { method: "POST", body: "{}" },
      );
      setWorkspace(updated);
      setForm((current) => (current ? { ...current, status: updated.status } : current));
      flash("Sponsor confirmed. Welcome email still requires review and Send.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sponsor could not be confirmed");
    }
  };

  const rotateAccess = async () => {
    if (
      !window.confirm(
        "Replace the private link? Existing links and signed-in sponsor sessions will stop working.",
      )
    )
      return;
    try {
      const result = await adminJson<{ accessUrl: string }>(
        `/api/admin/sponsors/${sponsorId}/access/rotate`,
        { method: "POST", body: "{}" },
      );
      setWorkspace((current) => (current ? { ...current, accessUrl: result.accessUrl } : current));
      flash("Private access link replaced");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Access could not be rotated");
    }
  };

  const openWelcomePreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await adminJson(`/api/admin/sponsors/${sponsorId}/welcome/preview`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Preview could not be created");
    } finally {
      setPreviewing(false);
    }
  };

  const sendWelcome = async () => {
    if (
      !preview ||
      !window.confirm(`Send this reviewed welcome email to ${preview.to.join(", ")}?`)
    )
      return;
    try {
      await adminJson(`/api/admin/sponsors/${sponsorId}/welcome/send`, {
        method: "POST",
        body: JSON.stringify({ expectedPreviewHash: preview.previewHash }),
      });
      setPreview(null);
      flash("Sponsor welcome email sent");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Email could not be sent");
    }
  };

  const reviewSession = async (
    session: SponsorSession,
    status: "approved" | "changes_requested",
    feedback?: string,
  ) => {
    try {
      await adminJson(`/api/admin/sponsors/${sponsorId}/sessions/${session.id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ status, feedback: feedback || null }),
      });
      flash(status === "approved" ? "Session approved" : "Changes requested");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be saved");
    }
  };

  const addSessionEntitlement = async () => {
    if (!newSession.entitlementLabel.trim()) {
      setError("Enter a label for the session entitlement");
      return;
    }
    setAddingSession(true);
    try {
      const updated = await adminJson<SponsorWorkspace>(
        `/api/admin/sponsors/${sponsorId}/sessions`,
        {
          method: "POST",
          body: JSON.stringify(newSession),
        },
      );
      setWorkspace(updated);
      setNewSession(EMPTY_SESSION_ENTITLEMENT);
      flash("Session entitlement added");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Session entitlement could not be added");
    } finally {
      setAddingSession(false);
    }
  };

  const saveSessionEntitlement = async (
    session: SponsorSession,
    input: SessionEntitlementDraft,
  ) => {
    try {
      const updated = await adminJson<SponsorWorkspace>(
        `/api/admin/sponsors/${sponsorId}/sessions/${session.id}/entitlement`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      setWorkspace(updated);
      flash("Session entitlement updated");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Session entitlement could not be updated",
      );
    }
  };

  const updateTask = async (task: SponsorTask, status: SponsorTask["status"]) => {
    try {
      await adminJson(`/api/admin/sponsors/${sponsorId}/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      flash(`${task.label} updated`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Deliverable status could not be saved");
    }
  };

  const uploadAsset = async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    body.append("category", assetCategory);
    if (assetSessionId !== "none") body.append("sessionId", assetSessionId);
    if (assetPresenterId !== "none") body.append("presenterId", assetPresenterId);
    if (assetCategory === "logistics") {
      body.append("documentTitle", logisticsDocumentTitle);
      body.append("required", String(logisticsDocumentRequired));
    }
    setUploading(true);
    try {
      const response = await adminFetch(`/api/admin/sponsors/${sponsorId}/assets`, {
        method: "POST",
        body,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Upload failed");
      flash(
        assetCategory === "logistics"
          ? "Logistics document uploaded for acknowledgement"
          : "File uploaded to App Storage",
      );
      setLogisticsDocumentTitle("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be uploaded");
    } finally {
      setUploading(false);
      if (assetInput.current) assetInput.current.value = "";
    }
  };

  const updateAssetStatus = async (asset: SponsorAsset, status: "active" | "archived") => {
    try {
      await adminJson(`/api/admin/sponsors/${sponsorId}/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      flash(status === "archived" ? "File version archived" : "File version restored");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be updated");
    }
  };

  const replaceAsset = async (asset: SponsorAsset, file: File) => {
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await adminFetch(
        `/api/admin/sponsors/${sponsorId}/assets/${asset.id}/replace`,
        { method: "POST", body },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Replacement failed");
      flash("New file version uploaded; previous version archived");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be replaced");
    }
  };

  const visibleAssets = useMemo(
    () =>
      (workspace?.assets ?? []).filter(
        (asset) => assetFilter === "all" || asset.category === assetFilter,
      ),
    [workspace?.assets, assetFilter],
  );
  const selectedAssetSession = workspace?.sessions.find(
    (session) => String(session.id) === assetSessionId,
  );

  if (loading && !workspace)
    return (
      <AdminLayout title="Sponsor">
        <div className="py-20 text-center text-muted-foreground">Loading sponsor workspace…</div>
      </AdminLayout>
    );
  if (!workspace || !form)
    return (
      <AdminLayout title="Sponsor">
        <div className="rounded-md border bg-white p-8 text-rose-700">
          {error || "Sponsor not found"}
        </div>
      </AdminLayout>
    );

  const completion = workspace.progressTotal
    ? (workspace.progressCompleted / workspace.progressTotal) * 100
    : 0;
  const vip = workspace.codes.find((code) => code.kind === "vip");
  const publicCode = workspace.codes.find((code) => code.kind === "public");

  return (
    <AdminLayout title={workspace.company}>
      <div className="space-y-6">
        <Link
          href="/admin/sponsors"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> All sponsors
        </Link>
        <div className="flex flex-col lg:flex-row gap-4 lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold">{workspace.company}</h2>
              <Badge className={statusClass(workspace.status)}>
                {workspace.status.replace("_", " ")}
              </Badge>
              {workspace.needsAttention > 0 && (
                <Badge className="bg-rose-100 text-rose-800">
                  {workspace.needsAttention} need attention
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1">{workspace.packageLabel}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {workspace.status === "draft" && (
              <Button onClick={confirm}>
                <CheckCircle2 className="h-4 w-4 mr-2" /> Confirm sponsor
              </Button>
            )}{" "}
            {workspace.status !== "draft" && (
              <Button variant="outline" onClick={openWelcomePreview} disabled={previewing}>
                <Mail className="h-4 w-4 mr-2" />{" "}
                {previewing ? "Preparing…" : "Review welcome email"}
              </Button>
            )}
            <Button onClick={() => save()} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
        {notice && (
          <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800 flex items-center gap-2">
            <Check className="h-4 w-4" />
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-sm text-rose-800 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="grid sm:grid-cols-4 gap-4">
          <Card className="p-4">
            <p className="text-xs uppercase font-bold text-muted-foreground">VIP passes</p>
            <p className="text-2xl font-bold mt-1">
              {workspace.vipUsed} / {workspace.vipAllocation}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs uppercase font-bold text-muted-foreground">Sponsor staff</p>
            <p className="text-2xl font-bold mt-1">
              {workspace.staffUsed} / {workspace.staffAllocation}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs uppercase font-bold text-muted-foreground">Deliverables</p>
            <p className="text-2xl font-bold mt-1">
              {workspace.progressCompleted} / {workspace.progressTotal}
            </p>
            <Progress value={completion} className="h-1.5 mt-2" />
          </Card>
          <Card className="p-4">
            <p className="text-xs uppercase font-bold text-muted-foreground">Files</p>
            <p className="text-2xl font-bold mt-1">
              {workspace.assets.filter((asset) => asset.status === "active").length}
            </p>
          </Card>
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="assets">Assets</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6 mt-6">
            <div className="grid xl:grid-cols-2 gap-6">
              <Card className="p-6 space-y-4">
                <h3 className="font-semibold">Agreement and allocations</h3>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <Label>Company</Label>
                    <Input
                      value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Package label</Label>
                    <Input
                      value={form.packageLabel}
                      onChange={(e) => setForm({ ...form, packageLabel: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Confirmation date</Label>
                    <Input
                      type="date"
                      value={form.confirmationDate}
                      onChange={(e) => setForm({ ...form, confirmationDate: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Status</Label>
                    <Select
                      value={form.status}
                      onValueChange={(value) =>
                        setForm({ ...form, status: value as SponsorStatus })
                      }
                      disabled={workspace.status === "draft"}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="confirmed">Confirmed</SelectItem>
                        <SelectItem value="paused">Paused</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>VIP allocation</Label>
                    <Input
                      type="number"
                      min="0"
                      value={form.vipAllocation}
                      onChange={(e) => setForm({ ...form, vipAllocation: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>VIP max per booking</Label>
                    <Input
                      type="number"
                      min="1"
                      value={form.vipMaxPerBooking}
                      onChange={(e) => setForm({ ...form, vipMaxPerBooking: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Staff allocation</Label>
                    <Input
                      type="number"
                      min="0"
                      value={form.staffAllocation}
                      onChange={(e) => setForm({ ...form, staffAllocation: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>Internal notes</Label>
                  <Textarea
                    rows={4}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>
              </Card>

              <Card className="p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Private workspace access</h3>
                  {workspace.accessUrl && (
                    <Button variant="outline" size="sm" onClick={rotateAccess}>
                      <RefreshCw className="h-4 w-4 mr-2" /> Replace link
                    </Button>
                  )}
                </div>
                {workspace.accessUrl ? (
                  <>
                    <div className="rounded-md border bg-muted/30 p-3 break-all text-sm">
                      {workspace.accessUrl}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => {
                        void copy(workspace.accessUrl!);
                        flash("Private link copied");
                      }}
                    >
                      <Clipboard className="h-4 w-4 mr-2" /> Copy private link
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The private workspace link is created when this draft is confirmed.
                  </p>
                )}
                <div className="pt-4 border-t">
                  <p className="text-sm font-medium">Welcome email</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {workspace.welcomeEmailSentAt
                      ? `Last sent ${formatDate(workspace.welcomeEmailSentAt)}`
                      : "Not sent. Confirmation never sends it automatically."}
                  </p>
                </div>
              </Card>
            </div>

            <div className="grid xl:grid-cols-2 gap-6">
              {[
                { label: "Private VIP", data: vip, copyText: workspace.invitationCopy.vip },
                {
                  label: "Public 20%",
                  data: publicCode,
                  copyText: workspace.invitationCopy.public,
                },
              ].map(({ label, data, copyText }) => (
                <Card key={label} className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold">{label}</h3>
                    {data && (
                      <Badge
                        className={
                          data.active
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-slate-100 text-slate-700"
                        }
                      >
                        {data.active ? "Active" : "Inactive"}
                      </Badge>
                    )}
                  </div>
                  {data ? (
                    <>
                      <div className="grid grid-cols-[1fr_auto] gap-2">
                        <Input value={data.code} readOnly className="font-mono font-bold" />
                        <Button variant="outline" onClick={() => void copy(data.code)}>
                          <Clipboard className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-[1fr_auto] gap-2">
                        <Input value={data.workforceUrl} readOnly />
                        <Button variant="outline" onClick={() => void copy(data.workforceUrl)}>
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="rounded-md bg-blue-50 border border-blue-100 p-3 text-sm">
                        {copyText}
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => {
                          void copy(copyText);
                          flash(`${label} invitation copy copied`);
                        }}
                      >
                        <Clipboard className="h-4 w-4 mr-2" /> Copy invitation wording
                      </Button>
                      <div className="pt-3 border-t">
                        <p className="text-sm font-semibold mb-2">
                          Registrations using this code ({data.redemptions.length})
                        </p>
                        {data.redemptions.length ? (
                          <div className="space-y-2 max-h-52 overflow-auto">
                            {data.redemptions.map((person) => (
                              <div
                                key={`${person.bookingId}-${person.firstName}`}
                                className="text-sm flex justify-between gap-4"
                              >
                                <span>
                                  <strong>
                                    {person.firstName} {person.lastName}
                                  </strong>
                                  <br />
                                  <span className="text-muted-foreground">
                                    {person.jobTitle}, {person.company}
                                  </span>
                                </span>
                                <span className="text-xs text-muted-foreground whitespace-nowrap">
                                  {formatDate(person.registeredAt)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">No registrations yet.</p>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Created on confirmation.</p>
                  )}
                </Card>
              ))}
            </div>

            <Card className="p-6">
              <h3 className="font-semibold mb-1">Deliverable tracker</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Statuses are visible to the sponsor immediately.
              </p>
              <div className="grid md:grid-cols-2 gap-3">
                {workspace.tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`rounded-md border p-3 flex items-center justify-between gap-4 ${task.status === "overdue" ? "bg-rose-50 border-rose-200" : ""}`}
                  >
                    <div>
                      <p className="text-sm font-medium">{task.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.dueAt ? `Due ${formatDate(task.dueAt)}` : "No deadline set"}
                      </p>
                    </div>
                    <Select
                      value={task.status}
                      onValueChange={(value) =>
                        void updateTask(task, value as SponsorTask["status"])
                      }
                    >
                      <SelectTrigger className="w-40 bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="todo">To do</SelectItem>
                        <SelectItem value="submitted">Submitted</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="overdue">Overdue</SelectItem>
                        <SelectItem value="not_required">Not required</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="people" className="space-y-6 mt-6">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-semibold">Sponsor contacts</h3>
                  <p className="text-sm text-muted-foreground">
                    Primary contacts receive the reviewed sponsor welcome email.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setContacts((current) => [
                      ...current,
                      {
                        role: "other",
                        firstName: "",
                        lastName: "",
                        jobTitle: null,
                        email: "",
                        phone: null,
                        isPrimary: false,
                      },
                    ])
                  }
                >
                  <Plus className="h-4 w-4 mr-2" /> Add contact
                </Button>
              </div>
              <div className="space-y-4">
                {contacts.map((contact, index) => (
                  <div key={contact.id ?? `new-${index}`} className="rounded-md border p-4">
                    <div className="flex justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">Contact {index + 1}</Badge>
                        {contact.isPrimary && (
                          <Badge className="bg-blue-100 text-blue-800">Primary</Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={contacts.length === 1}
                        onClick={() =>
                          setContacts((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div>
                        <Label>Role</Label>
                        <Select
                          value={contact.role}
                          onValueChange={(value) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      role: value as SponsorContact["role"],
                                      isPrimary: value === "primary" ? true : item.isPrimary,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="primary">Primary</SelectItem>
                            <SelectItem value="onsite">Onsite</SelectItem>
                            <SelectItem value="marketing">Marketing</SelectItem>
                            <SelectItem value="other">Other</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <label className="flex items-center gap-2 self-end h-10 text-sm">
                        <input
                          type="checkbox"
                          checked={contact.isPrimary}
                          onChange={(event) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      isPrimary: event.target.checked,
                                      role: event.target.checked ? "primary" : item.role,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />{" "}
                        Receives sponsor welcome
                      </label>
                      <div>
                        <Label>First name</Label>
                        <Input
                          value={contact.firstName}
                          onChange={(event) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, firstName: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label>Last name</Label>
                        <Input
                          value={contact.lastName}
                          onChange={(event) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, lastName: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label>Job title</Label>
                        <Input
                          value={contact.jobTitle ?? ""}
                          onChange={(event) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, jobTitle: event.target.value || null }
                                  : item,
                              ),
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label>Work email</Label>
                        <Input
                          type="email"
                          value={contact.email}
                          onChange={(event) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, email: event.target.value } : item,
                              ),
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label>Phone</Label>
                        <Input
                          value={contact.phone ?? ""}
                          onChange={(event) =>
                            setContacts((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, phone: event.target.value || null }
                                  : item,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                ))}
                {contacts.length === 0 && (
                  <p className="text-sm text-rose-700">
                    Add at least one primary contact before confirming.
                  </p>
                )}
              </div>
            </Card>
            <Card className="overflow-hidden">
              <div className="p-6 border-b">
                <h3 className="font-semibold">Sponsor staff ({workspace.staffUsed} active)</h3>
                <p className="text-sm text-muted-foreground">
                  These are included in attendance and Session Scheduler exports, but not paid
                  Business-pass revenue.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-3">Name</th>
                      <th className="text-left p-3">Role</th>
                      <th className="text-left p-3">Email</th>
                      <th className="text-left p-3">Community Social</th>
                      <th className="text-left p-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {workspace.staff.map((person) => (
                      <tr key={person.bookingId}>
                        <td className="p-3 font-medium">
                          {person.firstName} {person.lastName}
                        </td>
                        <td className="p-3">
                          {person.jobTitle}
                          <br />
                          <span className="text-muted-foreground">{person.company}</span>
                        </td>
                        <td className="p-3">{person.workEmail}</td>
                        <td className="p-3">
                          {person.communitySocialAttending === null
                            ? "Not answered"
                            : person.communitySocialAttending
                              ? "Attending"
                              : "Not attending"}
                        </td>
                        <td className="p-3">
                          <Badge className={statusClass(person.status)}>{person.status}</Badge>
                        </td>
                      </tr>
                    ))}
                    {workspace.staff.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-muted-foreground">
                          The sponsor has not registered staff yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="sessions" className="space-y-5 mt-6">
            <Card className="p-6 space-y-4">
              <div>
                <h3 className="font-semibold">Add session entitlement</h3>
                <p className="text-sm text-muted-foreground">
                  Add each Quickfire, keynote or other session agreed in the contract. Package names
                  never create these automatically.
                </p>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label>Session type</Label>
                  <Select
                    value={newSession.type}
                    onValueChange={(value) =>
                      setNewSession((current) => ({
                        ...current,
                        type: value as SponsorSession["type"],
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="quickfire">Quickfire</SelectItem>
                      <SelectItem value="keynote">Keynote</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Entitlement label</Label>
                  <Input
                    value={newSession.entitlementLabel}
                    onChange={(event) =>
                      setNewSession((current) => ({
                        ...current,
                        entitlementLabel: event.target.value,
                      }))
                    }
                    placeholder="e.g. 10-minute Quickfire"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-5 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={newSession.headshotRequired}
                    onChange={(event) =>
                      setNewSession((current) => ({
                        ...current,
                        headshotRequired: event.target.checked,
                      }))
                    }
                  />{" "}
                  Headshot required
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={newSession.takeawaysRequired}
                    onChange={(event) =>
                      setNewSession((current) => ({
                        ...current,
                        takeawaysRequired: event.target.checked,
                      }))
                    }
                  />{" "}
                  Takeaways required
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={newSession.slidesRequired}
                    onChange={(event) =>
                      setNewSession((current) => ({
                        ...current,
                        slidesRequired: event.target.checked,
                      }))
                    }
                  />{" "}
                  Slides required
                </label>
              </div>
              <Button onClick={() => void addSessionEntitlement()} disabled={addingSession}>
                <Plus className="h-4 w-4 mr-2" />
                {addingSession ? "Adding…" : "Add entitlement"}
              </Button>
            </Card>
            <div className="flex justify-end">
              <Button
                variant="outline"
                disabled={
                  !workspace.sessions.some((session) =>
                    ["approved", "exported"].includes(session.status),
                  )
                }
                onClick={() =>
                  void downloadAdminFile(
                    `/api/admin/sponsors/${sponsorId}/sessions/export.csv`,
                    `${workspace.company}-sessions.csv`,
                  )
                }
              >
                <Download className="h-4 w-4 mr-2" /> Export approved CSV
              </Button>
            </div>
            {workspace.sessions.map((session) => (
              <SessionReviewCard
                key={session.id}
                session={session}
                onReview={reviewSession}
                onEntitlementSave={saveSessionEntitlement}
                onNotice={flash}
              />
            ))}
            {!workspace.sessions.length && (
              <Card className="p-10 text-center text-muted-foreground">
                No session entitlement was entered for this sponsor.
              </Card>
            )}
          </TabsContent>

          <TabsContent value="assets" className="space-y-5 mt-6">
            <Card className="p-5 space-y-4">
              <div className="flex flex-col lg:flex-row gap-3 lg:items-end">
                <div>
                  <Label>Upload category</Label>
                  <Select
                    value={assetCategory}
                    onValueChange={(value) => setAssetCategory(value as SponsorAssetCategory)}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((category) => (
                        <SelectItem key={category.value} value={category.value}>
                          {category.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {workspace.sessions.length > 0 && (
                  <div>
                    <Label>Related session</Label>
                    <Select
                      value={assetSessionId}
                      onValueChange={(value) => {
                        setAssetSessionId(value);
                        setAssetPresenterId("none");
                      }}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">General sponsor file</SelectItem>
                        {workspace.sessions.map((session) => (
                          <SelectItem key={session.id} value={String(session.id)}>
                            {session.entitlementLabel}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {selectedAssetSession && selectedAssetSession.presenters.length > 0 && (
                  <div>
                    <Label>
                      Related presenter{assetCategory === "headshot" ? " (required)" : ""}
                    </Label>
                    <Select value={assetPresenterId} onValueChange={setAssetPresenterId}>
                      <SelectTrigger className="w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No specific presenter</SelectItem>
                        {selectedAssetSession.presenters
                          .filter((presenter) => presenter.id)
                          .map((presenter) => (
                            <SelectItem key={presenter.id} value={String(presenter.id)}>
                              {presenter.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <input
                    ref={assetInput}
                    type="file"
                    className="hidden"
                    accept=".png,.jpg,.jpeg,.webp,.svg,.eps,.ai,.pdf,.pptx,.docx"
                    onChange={(event) =>
                      event.target.files?.[0] && void uploadAsset(event.target.files[0])
                    }
                  />
                </div>
                <Button disabled={uploading} onClick={() => assetInput.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  {uploading ? "Uploading…" : "Choose file"}
                </Button>
                <div className="lg:ml-auto flex gap-2">
                  <Button
                    variant="outline"
                    disabled={!selectedAssets.length}
                    onClick={() =>
                      void downloadAdminFile(
                        `/api/admin/sponsors/${sponsorId}/assets/download.zip`,
                        `${workspace.company}-selected.zip`,
                        { method: "POST", body: JSON.stringify({ assetIds: selectedAssets }) },
                      )
                    }
                  >
                    <FileArchive className="h-4 w-4 mr-2" /> Download selected
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void downloadAdminFile(
                        `/api/admin/sponsors/${sponsorId}/assets/complete.zip`,
                        `${workspace.company}-complete.zip`,
                      )
                    }
                  >
                    <Download className="h-4 w-4 mr-2" /> Complete folder
                  </Button>
                </div>
              </div>
              {assetCategory === "logistics" && (
                <div className="rounded-md border bg-blue-50/50 p-4 grid md:grid-cols-[1fr_auto] gap-3 items-end">
                  <div>
                    <Label>Document title shown to sponsor</Label>
                    <Input
                      value={logisticsDocumentTitle}
                      onChange={(event) => setLogisticsDocumentTitle(event.target.value)}
                      placeholder="Defaults to the uploaded filename"
                    />
                  </div>
                  <label className="h-10 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={logisticsDocumentRequired}
                      onChange={(event) => setLogisticsDocumentRequired(event.target.checked)}
                    />{" "}
                    Sponsor must acknowledge this version
                  </label>
                </div>
              )}
            </Card>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                variant={assetFilter === "all" ? "default" : "outline"}
                onClick={() => setAssetFilter("all")}
              >
                All
              </Button>
              {CATEGORIES.map((category) => (
                <Button
                  key={category.value}
                  size="sm"
                  variant={assetFilter === category.value ? "default" : "outline"}
                  onClick={() => setAssetFilter(category.value)}
                >
                  {category.label}
                </Button>
              ))}
            </div>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-3 w-10"></th>
                      <th className="p-3 text-left">File</th>
                      <th className="p-3 text-left">Category</th>
                      <th className="p-3 text-left">Version</th>
                      <th className="p-3 text-left">Uploaded</th>
                      <th className="p-3 text-left">Status</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {visibleAssets.map((asset) => (
                      <tr key={asset.id}>
                        <td className="p-3">
                          <input
                            type="checkbox"
                            disabled={asset.status !== "active"}
                            checked={selectedAssets.includes(asset.id)}
                            onChange={(event) =>
                              setSelectedAssets((current) =>
                                event.target.checked
                                  ? [...current, asset.id]
                                  : current.filter((id) => id !== asset.id),
                              )
                            }
                          />
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-3">
                            <SecurePreview sponsorId={sponsorId} asset={asset} />
                            <div>
                              <p
                                className="font-medium max-w-[260px] truncate"
                                title={asset.originalName}
                              >
                                {asset.originalName}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {formatBytes(asset.byteSize)}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="p-3">{asset.category.replace("_", " ")}</td>
                        <td className="p-3">v{asset.version}</td>
                        <td className="p-3 whitespace-nowrap">{formatDate(asset.createdAt)}</td>
                        <td className="p-3">
                          <Badge className={statusClass(asset.status)}>{asset.status}</Badge>
                        </td>
                        <td className="p-3">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void downloadAdminFile(
                                  `/api/admin/sponsors/${sponsorId}/assets/${asset.id}/download`,
                                  asset.originalName,
                                )
                              }
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            {asset.status === "active" && (
                              <ReplaceFileButton
                                onFile={(file) => void replaceAsset(asset, file)}
                              />
                            )}
                            {asset.status === "active" ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void updateAssetStatus(asset, "archived")}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            ) : (
                              asset.status === "archived" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void updateAssetStatus(asset, "active")}
                                >
                                  <RotateCcw className="h-4 w-4" />
                                </Button>
                              )
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!visibleAssets.length && (
                      <tr>
                        <td colSpan={7} className="p-10 text-center text-muted-foreground">
                          No files in this view.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="activity" className="mt-6">
            <Card className="p-6">
              <div className="space-y-0">
                {(workspace.activity ?? []).map((activity, index) => (
                  <div key={activity.id} className="grid grid-cols-[18px_1fr] gap-3">
                    <div className="flex flex-col items-center">
                      <span className="h-2.5 w-2.5 rounded-full bg-primary mt-1.5" />
                      {index < (workspace.activity?.length ?? 0) - 1 && (
                        <span className="w-px flex-1 bg-border" />
                      )}
                    </div>
                    <div className="pb-5">
                      <p className="text-sm font-medium">{activity.type.replaceAll("_", " ")}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(activity.createdAt)} ·{" "}
                        {activity.actorLabel || activity.actorType}
                      </p>
                    </div>
                  </div>
                ))}
                {!workspace.activity?.length && (
                  <p className="text-muted-foreground">No sponsor activity yet.</p>
                )}
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-2xl overflow-hidden">
            <div className="p-5 border-b flex justify-between gap-4">
              <div>
                <h3 className="font-semibold">Review sponsor welcome</h3>
                <p className="text-sm text-muted-foreground">
                  To: {preview.to.join(", ")}
                  <br />
                  Subject: {preview.subject}
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPreview(null)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <iframe
              title="Sponsor welcome email preview"
              srcDoc={preview.html}
              className="w-full h-[62vh] bg-white"
              sandbox="allow-popups"
            />
            <div className="p-5 border-t flex justify-end gap-3">
              <Button variant="outline" onClick={() => setPreview(null)}>
                Close without sending
              </Button>
              <Button onClick={sendWelcome}>
                <Send className="h-4 w-4 mr-2" /> Send reviewed email
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function ReplaceFileButton({ onFile }: { onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept=".png,.jpg,.jpeg,.webp,.svg,.eps,.ai,.pdf,.pptx,.docx"
        onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])}
      />
      <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
        <RefreshCw className="h-4 w-4" />
      </Button>
    </>
  );
}

function SessionReviewCard({
  session,
  onReview,
  onEntitlementSave,
  onNotice,
}: {
  session: SponsorSession;
  onReview: (
    session: SponsorSession,
    status: "approved" | "changes_requested",
    feedback?: string,
  ) => Promise<void>;
  onEntitlementSave: (session: SponsorSession, input: SessionEntitlementDraft) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [feedback, setFeedback] = useState(session.feedback ?? "");
  const [entitlement, setEntitlement] = useState<SessionEntitlementDraft>({
    type: session.type,
    entitlementLabel: session.entitlementLabel,
    headshotRequired: session.headshotRequired,
    takeawaysRequired: session.takeawaysRequired,
    slidesRequired: session.slidesRequired,
  });
  const content = `${session.title ?? ""}\n\n${session.description ?? ""}\n\n${session.takeaways.map((item) => `• ${item}`).join("\n")}\n\n${session.presenters.map((presenter) => `${presenter.name}, ${presenter.jobTitle}, ${presenter.company}`).join("\n")}`;
  return (
    <Card className="p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-bold">
            {session.entitlementLabel}
          </p>
          <h3 className="text-lg font-semibold mt-1">{session.title || "Untitled session"}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={statusClass(session.status)}>{session.status.replace("_", " ")}</Badge>
          {session.exportOutdated && (
            <Badge className="bg-rose-100 text-rose-800">Export outdated</Badge>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-muted/20 p-4 space-y-3">
        <p className="text-sm font-semibold">Contract entitlement and requirements</p>
        <div className="grid md:grid-cols-[180px_1fr] gap-3">
          <Select
            value={entitlement.type}
            onValueChange={(value) =>
              setEntitlement((current) => ({ ...current, type: value as SponsorSession["type"] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quickfire">Quickfire</SelectItem>
              <SelectItem value="keynote">Keynote</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={entitlement.entitlementLabel}
            onChange={(event) =>
              setEntitlement((current) => ({ ...current, entitlementLabel: event.target.value }))
            }
          />
        </div>
        <div className="flex flex-wrap gap-5 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={entitlement.headshotRequired}
              onChange={(event) =>
                setEntitlement((current) => ({
                  ...current,
                  headshotRequired: event.target.checked,
                }))
              }
            />{" "}
            Headshot required
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={entitlement.takeawaysRequired}
              onChange={(event) =>
                setEntitlement((current) => ({
                  ...current,
                  takeawaysRequired: event.target.checked,
                }))
              }
            />{" "}
            Takeaways required
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={entitlement.slidesRequired}
              onChange={(event) =>
                setEntitlement((current) => ({ ...current, slidesRequired: event.target.checked }))
              }
            />{" "}
            Slides required
          </label>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!entitlement.entitlementLabel.trim()}
          onClick={() => void onEntitlementSave(session, entitlement)}
        >
          Save entitlement requirements
        </Button>
      </div>

      <p className="text-sm whitespace-pre-wrap">
        {session.description || "No description submitted."}
      </p>
      {session.takeaways.length > 0 && (
        <ul className="list-disc pl-5 text-sm space-y-1">
          {session.takeaways.map((takeaway) => (
            <li key={takeaway}>{takeaway}</li>
          ))}
        </ul>
      )}
      <div className="grid md:grid-cols-2 gap-3">
        {session.presenters.map((presenter) => (
          <div
            key={`${presenter.name}-${presenter.jobTitle}`}
            className="rounded-md border p-3 text-sm"
          >
            <strong>{presenter.name}</strong>
            <br />
            <span className="text-muted-foreground">
              {presenter.jobTitle}, {presenter.company}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void copy(content);
            onNotice("Approved-content copy copied");
          }}
        >
          <Clipboard className="h-4 w-4 mr-2" /> Copy content
        </Button>
        {session.status === "submitted" && (
          <Button size="sm" onClick={() => void onReview(session, "approved")}>
            <CheckCircle2 className="h-4 w-4 mr-2" /> Approve
          </Button>
        )}
      </div>
      {["submitted", "changes_requested"].includes(session.status) && (
        <div className="pt-4 border-t space-y-2">
          <Label>Feedback to sponsor</Label>
          <Textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Be specific about what needs changing"
          />
          <Button
            variant="outline"
            disabled={!feedback.trim()}
            onClick={() => void onReview(session, "changes_requested", feedback)}
          >
            Request changes
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Revision {session.currentRevision}
        {session.exportedRevision ? ` · exported revision ${session.exportedRevision}` : ""}
      </p>
    </Card>
  );
}
