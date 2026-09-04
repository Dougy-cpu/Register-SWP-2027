import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  FileText,
  LogOut,
  Plus,
  QrCode,
  Send,
  Upload,
  Users,
  X,
} from "lucide-react";
import logoUrl from "@assets/swp-summit-logo.png";
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
import { sponsorFetch, sponsorJson } from "@/lib/sponsor-api";
import type {
  SponsorAssetCategory,
  SponsorPresenter,
  SponsorSession,
  SponsorStaff,
  SponsorWorkspace,
} from "@/types/sponsor";

function formatDate(value?: string | null) {
  if (!value) return "Not set";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function statusClass(status: string) {
  if (["active", "approved", "completed", "exported", "paid"].includes(status))
    return "bg-emerald-100 text-emerald-800";
  if (["submitted", "todo", "draft"].includes(status)) return "bg-amber-100 text-amber-800";
  if (["overdue", "changes_requested", "missing", "cancelled"].includes(status))
    return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function copy(text: string) {
  return navigator.clipboard.writeText(text);
}

type StaffForm = {
  firstName: string;
  lastName: string;
  jobTitle: string;
  company: string;
  workEmail: string;
  phone: string;
  dietaryAccessibility: string;
  communitySocialAttending: "unanswered" | "yes" | "no";
  communitySocialDietary: string;
  marketingConsent: boolean;
};

const EMPTY_STAFF: StaffForm = {
  firstName: "",
  lastName: "",
  jobTitle: "",
  company: "",
  workEmail: "",
  phone: "",
  dietaryAccessibility: "",
  communitySocialAttending: "unanswered",
  communitySocialDietary: "",
  marketingConsent: false,
};

export default function SponsorPortal() {
  const [, navigate] = useLocation();
  const [workspace, setWorkspace] = useState<SponsorWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showPassRequest, setShowPassRequest] = useState(false);
  const [staffForm, setStaffForm] = useState<StaffForm>(EMPTY_STAFF);
  const [editingStaff, setEditingStaff] = useState<SponsorStaff | null>(null);
  const [savingStaff, setSavingStaff] = useState(false);
  const [assetCategory, setAssetCategory] = useState<SponsorAssetCategory>("logo");
  const [assetSessionId, setAssetSessionId] = useState<string>("none");
  const [assetPresenterId, setAssetPresenterId] = useState<string>("none");
  const [uploading, setUploading] = useState(false);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await sponsorJson<SponsorWorkspace>("/api/sponsor/workspace");
      setWorkspace(data);
      setStaffForm((current) => ({ ...current, company: current.company || data.sponsor.company }));
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Your sponsor workspace could not be opened",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  };

  const logout = async () => {
    await sponsorFetch("/api/sponsor/logout", { method: "POST", body: "{}" });
    navigate("/");
  };

  const saveStaff = async () => {
    if (!workspace) return;
    setSavingStaff(true);
    setError("");
    try {
      const payload = {
        ...staffForm,
        communitySocialAttending:
          staffForm.communitySocialAttending === "unanswered"
            ? null
            : staffForm.communitySocialAttending === "yes",
      };
      await sponsorJson(
        editingStaff ? `/api/sponsor/staff/${editingStaff.bookingId}` : "/api/sponsor/staff",
        {
          method: editingStaff ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      flash(
        editingStaff
          ? "Staff details updated"
          : "Staff registration confirmed and welcome email queued",
      );
      setEditingStaff(null);
      setStaffForm({ ...EMPTY_STAFF, company: workspace.sponsor.company });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Staff registration could not be saved");
    } finally {
      setSavingStaff(false);
    }
  };

  const editStaff = (person: SponsorStaff) => {
    setEditingStaff(person);
    setStaffForm({
      firstName: person.firstName,
      lastName: person.lastName,
      jobTitle: person.jobTitle,
      company: person.company,
      workEmail: person.workEmail,
      phone: person.phone ?? "",
      dietaryAccessibility: person.dietaryAccessibility ?? "",
      communitySocialAttending:
        person.communitySocialAttending === null
          ? "unanswered"
          : person.communitySocialAttending
            ? "yes"
            : "no",
      communitySocialDietary: person.communitySocialDietary ?? "",
      marketingConsent: person.marketingConsent,
    });
    document.getElementById("staff-form")?.scrollIntoView({ behavior: "smooth" });
  };

  const cancelStaff = async (person: SponsorStaff) => {
    if (
      !window.confirm(
        `Cancel ${person.firstName} ${person.lastName}'s staff place? The place will return to your allocation.`,
      )
    )
      return;
    try {
      const response = await sponsorFetch(`/api/sponsor/staff/${person.bookingId}`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new Error((await response.json().catch(() => ({}))).error ?? "Cancellation failed");
      flash("Staff place cancelled and restored to your allocation");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Staff place could not be cancelled");
    }
  };

  const uploadAsset = async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    body.append("category", assetCategory);
    if (assetSessionId !== "none") body.append("sessionId", assetSessionId);
    if (assetPresenterId !== "none") body.append("presenterId", assetPresenterId);
    setUploading(true);
    setError("");
    try {
      const response = await sponsorFetch("/api/sponsor/assets", { method: "POST", body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Upload failed");
      flash("File uploaded safely");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be uploaded");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const replaceAsset = async (assetId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    setReplacingId(assetId);
    setError("");
    try {
      const response = await sponsorFetch(`/api/sponsor/assets/${assetId}/replace`, {
        method: "POST",
        body,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Replacement failed");
      flash("New file version uploaded; the previous version was archived");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "File could not be replaced");
    } finally {
      setReplacingId(null);
    }
  };

  const selectedAssetSession = workspace?.sessions.find(
    (session) => String(session.id) === assetSessionId,
  );

  if (loading && !workspace)
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="h-9 w-9 mx-auto border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="mt-4 text-muted-foreground">Opening sponsor workspace…</p>
        </div>
      </main>
    );
  if (!workspace)
    return (
      <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <Card className="max-w-lg p-8 text-center">
          <img src={logoUrl} alt="SWP Summit" className="h-20 w-auto mx-auto mb-5" />
          <h1 className="text-xl font-bold">Workspace unavailable</h1>
          <p className="text-muted-foreground mt-3">{error}</p>
          <p className="text-sm text-muted-foreground mt-4">
            Please use your private sponsor link again or ask the SWP Summit team for a new one.
          </p>
        </Card>
      </main>
    );

  const completion = workspace.progressTotal
    ? (workspace.progressCompleted / workspace.progressTotal) * 100
    : 0;
  const vip = workspace.codes.find((code) => code.kind === "vip");
  const publicCode = workspace.codes.find((code) => code.kind === "public");
  const activeStaff = workspace.staff.filter((person) =>
    ["paid", "invoiced"].includes(person.status),
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img src={logoUrl} alt="SWP Summit" className="h-12 w-auto" />
            <div className="hidden sm:block border-l pl-4">
              <p className="font-semibold">{workspace.sponsor.company}</p>
              <p className="text-xs text-muted-foreground">Sponsor workspace</p>
            </div>
          </div>
          <Button variant="ghost" onClick={logout}>
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <p className="text-sm font-semibold text-primary uppercase tracking-wide">
            {workspace.sponsor.packageLabel}
          </p>
          <h1 className="text-3xl font-bold mt-1">Welcome, {workspace.sponsor.company}</h1>
          <p className="text-muted-foreground mt-2">
            Manage your passes, people, session details, assets and event logistics here.
          </p>
        </div>
        {notice && (
          <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-emerald-800 flex items-center gap-2">
            <Check className="h-4 w-4" />
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-rose-800 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <button
            onClick={() => navigate("/sponsor/scanner")}
            className="swp-card rounded-2xl p-5 text-left flex items-center gap-4 transition-transform hover:-translate-y-0.5"
          >
            <span className="h-12 w-12 rounded-xl bg-blue-50 text-primary grid place-items-center shrink-0">
              <QrCode className="h-6 w-6" />
            </span>
            <span>
              <strong className="block text-lg">Scan badge</strong>
              <span className="text-sm text-muted-foreground">
                Open the scanner and capture leads. It keeps saving if the signal drops.
              </span>
            </span>
          </button>
          <button
            onClick={() => navigate("/sponsor/leads")}
            className="swp-card rounded-2xl p-5 text-left flex items-center gap-4 transition-transform hover:-translate-y-0.5"
          >
            <span className="h-12 w-12 rounded-xl bg-blue-50 text-primary grid place-items-center shrink-0">
              <Users className="h-6 w-6" />
            </span>
            <span>
              <strong className="block text-lg">Leads</strong>
              <span className="text-sm text-muted-foreground">
                Review, rate, add notes and export your synchronised leads.
              </span>
            </span>
          </button>
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          <Card className="p-5">
            <p className="text-xs font-bold uppercase text-muted-foreground">
              VIP Workforce passes
            </p>
            <p className="text-3xl font-bold mt-1">
              {workspace.vipUsed} / {workspace.vipAllocation}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {Math.max(0, workspace.vipAllocation - workspace.vipUsed)} remaining
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase text-muted-foreground">Sponsor staff</p>
            <p className="text-3xl font-bold mt-1">
              {workspace.staffUsed} / {workspace.staffAllocation}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {Math.max(0, workspace.staffAllocation - workspace.staffUsed)} places remaining
            </p>
          </Card>
          <Card className="p-5">
            <p className="text-xs font-bold uppercase text-muted-foreground">Overall progress</p>
            <p className="text-3xl font-bold mt-1">
              {workspace.progressCompleted} / {workspace.progressTotal}
            </p>
            <Progress value={completion} className="h-2 mt-3" />
          </Card>
        </div>

        <Tabs defaultValue="home">
          <TabsList className="h-auto flex-wrap justify-start bg-white border p-1">
            <TabsTrigger value="home">Home</TabsTrigger>
            <TabsTrigger value="staff">Staff</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="files">Files & logistics</TabsTrigger>
          </TabsList>

          <TabsContent value="home" className="space-y-6 mt-6">
            <div className="grid xl:grid-cols-2 gap-6">
              {[
                { label: "Private VIP invitations", data: vip, text: workspace.invitationCopy.vip },
                {
                  label: "Public 20% discount",
                  data: publicCode,
                  text: workspace.invitationCopy.public,
                },
              ].map(({ label, data, text }) => (
                <Card key={label} className="p-6 space-y-4">
                  <div className="flex justify-between">
                    <h2 className="font-semibold">{label}</h2>
                    {data && (
                      <Badge
                        className={
                          data.active
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-slate-100 text-slate-700"
                        }
                      >
                        {data.active ? "Active" : "Paused"}
                      </Badge>
                    )}
                  </div>
                  {data && (
                    <>
                      <div className="rounded-md bg-slate-50 border p-3 font-mono font-bold text-lg flex items-center justify-between gap-2">
                        <span>{data.code}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void copy(data.code);
                            flash("Code copied");
                          }}
                        >
                          <Clipboard className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="rounded-md bg-blue-50 border border-blue-100 p-3 text-sm">
                        {text}
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => {
                          void copy(text);
                          flash("Invitation wording copied");
                        }}
                      >
                        <Clipboard className="h-4 w-4 mr-2" /> Copy wording
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => window.open(data.workforceUrl, "_blank")}
                      >
                        <Send className="h-4 w-4 mr-2" /> Open registration link
                      </Button>
                      <div className="pt-3 border-t">
                        <p className="text-sm font-semibold">
                          Registrations ({data.redemptions.length})
                        </p>
                        <p className="text-xs text-muted-foreground mb-3">
                          Contact and payment details are kept private.
                        </p>
                        <div className="space-y-2 max-h-56 overflow-auto">
                          {data.redemptions.map((person) => (
                            <div
                              key={`${person.bookingId}-${person.firstName}`}
                              className="text-sm flex justify-between gap-3"
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
                          {!data.redemptions.length && (
                            <p className="text-sm text-muted-foreground">No registrations yet.</p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </Card>
              ))}
            </div>
            <Card className="p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Need more passes?</h2>
                  <p className="text-sm text-muted-foreground">
                    Send a request straight to the event team.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setShowPassRequest(true)}>
                  <Plus className="h-4 w-4 mr-2" /> Request more passes
                </Button>
              </div>
            </Card>
            <Card className="p-6">
              <h2 className="font-semibold mb-4">Your progress</h2>
              <div className="grid md:grid-cols-2 gap-3">
                {workspace.tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`rounded-md border p-4 flex justify-between gap-3 ${task.status === "overdue" ? "bg-rose-50 border-rose-200" : ""}`}
                  >
                    <div>
                      <p className="font-medium text-sm">{task.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.dueAt ? `Due ${formatDate(task.dueAt)}` : "No deadline set"}
                      </p>
                    </div>
                    <Badge className={statusClass(task.status)}>
                      {task.status.replace("_", " ")}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="staff" className="space-y-6 mt-6">
            <Card className="overflow-hidden">
              <div className="p-6 border-b">
                <h2 className="font-semibold">Your sponsor staff</h2>
                <p className="text-sm text-muted-foreground">
                  Each confirmed person receives their own attendee welcome email. Cancelling
                  returns the place to your allocation.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-3 text-left">Name</th>
                      <th className="p-3 text-left">Role</th>
                      <th className="p-3 text-left">Community Social</th>
                      <th className="p-3 text-left">Status</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {workspace.staff.map((person) => (
                      <tr key={person.bookingId}>
                        <td className="p-3 font-medium">
                          {person.firstName} {person.lastName}
                          <br />
                          <span className="text-xs text-muted-foreground">{person.workEmail}</span>
                        </td>
                        <td className="p-3">
                          {person.jobTitle}
                          <br />
                          <span className="text-muted-foreground">{person.company}</span>
                        </td>
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
                        <td className="p-3">
                          <div className="flex justify-end gap-2">
                            {["paid", "invoiced"].includes(person.status) && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => editStaff(person)}
                                >
                                  Edit or replace
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void cancelStaff(person)}
                                >
                                  Cancel
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!workspace.staff.length && (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-muted-foreground">
                          No staff registered yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card id="staff-form" className="p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-semibold">
                    {editingStaff ? "Edit or replace staff member" : "Register a staff member"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {Math.max(0, workspace.staffAllocation - activeStaff.length)} sponsor staff
                    places remain.
                  </p>
                </div>
                {editingStaff && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingStaff(null);
                      setStaffForm({ ...EMPTY_STAFF, company: workspace.sponsor.company });
                    }}
                  >
                    Cancel editing
                  </Button>
                )}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label>First name</Label>
                  <Input
                    value={staffForm.firstName}
                    onChange={(e) => setStaffForm({ ...staffForm, firstName: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Last name</Label>
                  <Input
                    value={staffForm.lastName}
                    onChange={(e) => setStaffForm({ ...staffForm, lastName: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Job title</Label>
                  <Input
                    value={staffForm.jobTitle}
                    onChange={(e) => setStaffForm({ ...staffForm, jobTitle: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Company</Label>
                  <Input
                    value={staffForm.company}
                    onChange={(e) => setStaffForm({ ...staffForm, company: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Work email</Label>
                  <Input
                    type="email"
                    value={staffForm.workEmail}
                    onChange={(e) => setStaffForm({ ...staffForm, workEmail: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Phone (optional)</Label>
                  <Input
                    value={staffForm.phone}
                    onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
                  />
                </div>
                <div className="md:col-span-2">
                  <Label>Dietary or accessibility information</Label>
                  <Textarea
                    value={staffForm.dietaryAccessibility}
                    onChange={(e) =>
                      setStaffForm({ ...staffForm, dietaryAccessibility: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label>Community Social</Label>
                  <Select
                    value={staffForm.communitySocialAttending}
                    onValueChange={(value) =>
                      setStaffForm({
                        ...staffForm,
                        communitySocialAttending: value as StaffForm["communitySocialAttending"],
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unanswered">Not answered yet</SelectItem>
                      <SelectItem value="yes">Attending</SelectItem>
                      <SelectItem value="no">Not attending</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Social dietary information</Label>
                  <Input
                    value={staffForm.communitySocialDietary}
                    onChange={(e) =>
                      setStaffForm({ ...staffForm, communitySocialDietary: e.target.value })
                    }
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={staffForm.marketingConsent}
                  onChange={(e) =>
                    setStaffForm({ ...staffForm, marketingConsent: e.target.checked })
                  }
                />
                <span>
                  This attendee has personally asked to receive future event and marketing updates.
                  Leave unticked unless they supplied this consent themselves.
                </span>
              </label>
              <div className="rounded-md bg-slate-50 border p-3 text-sm text-slate-700">
                <strong>Badge scanning notice:</strong> at the event, sponsors may scan this
                attendee's badge to save their name, job title, company and work email as a lead.
                Scanning is optional. The attendee can contact the SWP Summit team to have their
                badge excluded from sponsor scanning.
              </div>
              <div className="rounded-md bg-blue-50 border border-blue-100 p-3 text-sm">
                Please check the details before confirming. Confirmation creates the attendee place
                immediately and sends the attendee welcome email. There is no invoice or receipt.
              </div>
              <Button
                onClick={saveStaff}
                disabled={
                  savingStaff || (!editingStaff && activeStaff.length >= workspace.staffAllocation)
                }
              >
                <CheckCircle2 className="h-4 w-4 mr-2" />
                {savingStaff
                  ? "Saving…"
                  : editingStaff
                    ? "Save staff changes"
                    : "Confirm staff registration"}
              </Button>
            </Card>
          </TabsContent>

          <TabsContent value="sessions" className="space-y-6 mt-6">
            {workspace.sessions.map((session) => (
              <SponsorSessionForm
                key={`${session.id}-${session.currentRevision}-${session.status}`}
                session={session}
                onReload={load}
                onError={setError}
                onNotice={flash}
              />
            ))}
            {!workspace.sessions.length && (
              <Card className="p-10 text-center">
                <CalendarDays className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                <h2 className="font-semibold">No session submission needed</h2>
                <p className="text-sm text-muted-foreground">
                  There is no session entitlement recorded for this agreement.
                </p>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="files" className="space-y-6 mt-6">
            <Card className="p-6">
              <h2 className="font-semibold">Upload a deliverable</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Images up to 10 MB; SVG, EPS, AI, PDF, PPTX and DOCX up to 25 MB.
              </p>
              <div className="mt-5 flex flex-col md:flex-row gap-3 md:items-end">
                <div>
                  <Label>Category</Label>
                  <Select
                    value={assetCategory}
                    onValueChange={(value) => setAssetCategory(value as SponsorAssetCategory)}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="logo">Logo</SelectItem>
                      <SelectItem value="headshot">Headshot</SelectItem>
                      <SelectItem value="slides">Slides</SelectItem>
                      <SelectItem value="session_material">Session material</SelectItem>
                      <SelectItem value="logistics">Logistics</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
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
                      <SelectTrigger className="w-64">
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
                      Related presenter
                      {assetCategory === "headshot" ? " (required)" : " (optional)"}
                    </Label>
                    <Select value={assetPresenterId} onValueChange={setAssetPresenterId}>
                      <SelectTrigger className="w-64">
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
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept=".png,.jpg,.jpeg,.webp,.svg,.eps,.ai,.pdf,.pptx,.docx"
                  onChange={(event) =>
                    event.target.files?.[0] && void uploadAsset(event.target.files[0])
                  }
                />
                <Button disabled={uploading} onClick={() => fileInput.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  {uploading ? "Uploading…" : "Choose and upload file"}
                </Button>
              </div>
            </Card>
            <Card className="overflow-hidden">
              <div className="p-6 border-b">
                <h2 className="font-semibold">Uploaded files</h2>
              </div>
              <div className="divide-y">
                {workspace.assets
                  .filter((asset) => asset.status === "active")
                  .map((asset) => (
                    <div
                      key={asset.id}
                      className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-10 w-10 bg-muted rounded flex items-center justify-center">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{asset.originalName}</p>
                          <p className="text-xs text-muted-foreground">
                            {asset.category.replace("_", " ")} · version {asset.version} ·{" "}
                            {formatDate(asset.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <label className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
                          <Upload className="h-4 w-4 mr-2" />
                          {replacingId === asset.id ? "Replacing…" : "Replace"}
                          <input
                            type="file"
                            className="hidden"
                            disabled={replacingId !== null}
                            accept=".png,.jpg,.jpeg,.webp,.svg,.eps,.ai,.pdf,.pptx,.docx"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void replaceAsset(asset.id, file);
                              event.currentTarget.value = "";
                            }}
                          />
                        </label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            window.open(`/api/sponsor/assets/${asset.id}/download`, "_blank")
                          }
                        >
                          <Download className="h-4 w-4 mr-2" /> Download
                        </Button>
                      </div>
                    </div>
                  ))}
                {!workspace.assets.some((asset) => asset.status === "active") && (
                  <div className="p-8 text-center text-muted-foreground">
                    No files uploaded yet.
                  </div>
                )}
              </div>
            </Card>
            <Card className="p-6">
              <h2 className="font-semibold">Required logistics documents</h2>
              <div className="mt-4 space-y-3">
                {workspace.documents.map((document) => (
                  <DocumentRow
                    key={document.id}
                    document={document}
                    onReload={load}
                    onError={setError}
                    onNotice={flash}
                  />
                ))}
                {!workspace.documents.length && (
                  <p className="text-sm text-muted-foreground">
                    The event team has not added any required documents yet.
                  </p>
                )}
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
      {showPassRequest && (
        <PassRequestModal
          onClose={() => setShowPassRequest(false)}
          onSent={() => {
            setShowPassRequest(false);
            flash("Pass request sent to the event team");
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function SponsorSessionForm({
  session,
  onReload,
  onError,
  onNotice,
}: {
  session: SponsorSession;
  onReload: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const first = session.presenters[0] ?? { name: "", jobTitle: "", company: "", biography: "" };
  const [title, setTitle] = useState(session.title ?? "");
  const [description, setDescription] = useState(session.description ?? "");
  const [takeaways, setTakeaways] = useState([
    session.takeaways[0] ?? "",
    session.takeaways[1] ?? "",
    session.takeaways[2] ?? "",
  ]);
  const [presenter, setPresenter] = useState<SponsorPresenter>(first);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await sponsorJson(`/api/sponsor/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title,
          description,
          takeaways: takeaways.filter(Boolean),
          presenters: [presenter],
        }),
      });
      onNotice("Session draft saved");
      await onReload();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Session could not be saved");
    } finally {
      setSaving(false);
    }
  };
  const submit = async () => {
    try {
      await sponsorJson(`/api/sponsor/sessions/${session.id}/submit`, {
        method: "POST",
        body: "{}",
      });
      onNotice("Session submitted for review");
      await onReload();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Session could not be submitted");
    }
  };
  return (
    <Card className="p-6 space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <p className="text-xs uppercase font-bold text-primary">{session.entitlementLabel}</p>
          <h2 className="font-semibold mt-1">
            {session.type === "quickfire" ? "Quickfire submission" : "Session submission"}
          </h2>
        </div>
        <Badge className={statusClass(session.status)}>{session.status.replace("_", " ")}</Badge>
      </div>
      {session.feedback && (
        <div className="rounded-md bg-rose-50 border border-rose-200 p-4">
          <p className="font-semibold text-rose-900">Changes requested</p>
          <p className="text-sm text-rose-800 mt-1">{session.feedback}</p>
        </div>
      )}
      <div>
        <Label>Session title</Label>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={250} />
      </div>
      <div>
        <Label>Concise description</Label>
        <Textarea
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={1500}
        />
        <p className="text-xs text-muted-foreground text-right">{description.length} / 1500</p>
      </div>
      <div>
        <Label>Up to three takeaways</Label>
        <div className="space-y-2 mt-1">
          {takeaways.map((takeaway, index) => (
            <Input
              key={index}
              value={takeaway}
              onChange={(event) =>
                setTakeaways((current) =>
                  current.map((value, itemIndex) =>
                    itemIndex === index ? event.target.value : value,
                  ),
                )
              }
              placeholder={`Takeaway ${index + 1}`}
            />
          ))}
        </div>
      </div>
      <div className="border-t pt-5">
        <h3 className="font-semibold mb-3">Presenter</h3>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Name</Label>
            <Input
              value={presenter.name}
              onChange={(event) => setPresenter({ ...presenter, name: event.target.value })}
            />
          </div>
          <div>
            <Label>Job title</Label>
            <Input
              value={presenter.jobTitle}
              onChange={(event) => setPresenter({ ...presenter, jobTitle: event.target.value })}
            />
          </div>
          <div>
            <Label>Company</Label>
            <Input
              value={presenter.company}
              onChange={(event) => setPresenter({ ...presenter, company: event.target.value })}
            />
          </div>
          <div>
            <Label>Short biography (optional)</Label>
            <Input
              value={presenter.biography ?? ""}
              onChange={(event) => setPresenter({ ...presenter, biography: event.target.value })}
            />
          </div>
        </div>
      </div>
      <div className="rounded-md bg-slate-50 border p-3 text-sm">
        <strong>Required for submission:</strong> title, description, presenter details
        {session.takeawaysRequired ? ", at least one takeaway" : ""}
        {session.headshotRequired ? ", presenter headshot" : ""}
        {session.slidesRequired ? ", slides" : ""}. Upload files in Files & logistics and select
        this session.
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
        <Button
          onClick={submit}
          disabled={!["draft", "changes_requested"].includes(session.status)}
        >
          <Send className="h-4 w-4 mr-2" /> Submit for review
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Revision {session.currentRevision}
        {session.exportOutdated ? " · previous export is outdated" : ""}
      </p>
    </Card>
  );
}

function PassRequestModal({
  onClose,
  onSent,
  onError,
}: {
  onClose: () => void;
  onSent: () => void;
  onError: (message: string) => void;
}) {
  const [vip, setVip] = useState("0");
  const [staff, setStaff] = useState("0");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      await sponsorJson("/api/sponsor/pass-requests", {
        method: "POST",
        body: JSON.stringify({ requestedVip: Number(vip), requestedStaff: Number(staff), message }),
      });
      onSent();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Request could not be sent");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 p-4 flex items-center justify-center">
      <Card className="w-full max-w-lg p-6 space-y-5">
        <div className="flex justify-between">
          <div>
            <h2 className="font-semibold">Request more passes</h2>
            <p className="text-sm text-muted-foreground">The event team is notified immediately.</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Extra VIP passes</Label>
            <Input
              type="number"
              min="0"
              value={vip}
              onChange={(event) => setVip(event.target.value)}
            />
          </div>
          <div>
            <Label>Extra staff passes</Label>
            <Input
              type="number"
              min="0"
              value={staff}
              onChange={(event) => setStaff(event.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Message (optional)</Label>
          <Textarea value={message} onChange={(event) => setMessage(event.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending}>
            {sending ? "Sending…" : "Send request"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function DocumentRow({
  document,
  onReload,
  onError,
  onNotice,
}: {
  document: SponsorWorkspace["documents"][number];
  onReload: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const acknowledge = async () => {
    try {
      await sponsorJson(`/api/sponsor/documents/${document.id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ acknowledgedBy: name }),
      });
      onNotice("Document acknowledged");
      await onReload();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Acknowledgement could not be saved");
    }
  };
  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <p className="font-medium">{document.title}</p>
            {document.required && <Badge variant="outline">Required</Badge>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Version {document.acknowledgementVersion}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              window.open(`/api/sponsor/assets/${document.assetId}/download`, "_blank")
            }
          >
            <Download className="h-4 w-4 mr-2" /> Download
          </Button>
          {document.acknowledged ? (
            <Badge className="bg-emerald-100 text-emerald-800">
              <Check className="h-3 w-3 mr-1" /> Acknowledged by {document.acknowledgedBy}
            </Badge>
          ) : (
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                className="w-44"
              />
              <Button size="sm" disabled={name.trim().length < 2} onClick={acknowledge}>
                Acknowledge
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
