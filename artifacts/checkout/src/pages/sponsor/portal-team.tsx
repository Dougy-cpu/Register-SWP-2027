import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clipboard, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sponsorJson } from "@/lib/sponsor-api";
import type { SponsorStaff, SponsorWorkspace } from "@/types/sponsor";
import { activeStaff } from "./portal-helpers";
import { InlineError } from "./portal-ui";

const emptyTeamMember = (company: string) => ({
  firstName: "",
  lastName: "",
  jobTitle: "",
  company,
  workEmail: "",
  phone: "",
  dietaryAccessibility: "",
  communitySocialAttending: "unanswered",
  communitySocialDietary: "",
  marketingConsent: false,
});

export function PortalTeam({
  workspace,
  onRefresh,
  editSocialBookingId,
}: {
  workspace: SponsorWorkspace;
  onRefresh: () => Promise<void>;
  editSocialBookingId?: number | null;
}) {
  const [form, setForm] = useState(() => emptyTeamMember(workspace.sponsor.company));
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(emptyTeamMember(workspace.sponsor.company)),
  );
  const [editing, setEditing] = useState<SponsorStaff | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [sameRequirements, setSameRequirements] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const currentStaff = activeStaff(workspace);
  const remaining = Math.max(0, workspace.sponsor.staffAllocation - currentStaff.length);
  const teamComplete = workspace.tasks.some(
    (task) => task.taskKey === "staff" && task.status === "completed",
  );
  const replacing = Boolean(
    editing && form.workEmail.trim().toLowerCase() !== editing.workEmail.toLowerCase(),
  );
  const unsaved = showForm && (JSON.stringify(form) !== baseline || sameRequirements);
  const openMember = (person: SponsorStaff, social = false) => {
    if (operation.current) return;
    if (showForm && editing?.bookingId === person.bookingId) {
      if (social) setShowPreferences(true);
      requestAnimationFrame(() =>
        document.getElementById("staff-form")?.scrollIntoView({ block: "start" }),
      );
      return;
    }
    if (unsaved && !window.confirm("Discard the unfinished team member form and open this person?"))
      return;
    setEditing(person);
    setShowForm(true);
    setShowPreferences(social);
    setSameRequirements(false);
    setError("");
    const nextForm = {
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
    };
    setForm(nextForm);
    setBaseline(JSON.stringify(nextForm));
    requestAnimationFrame(() =>
      document.getElementById("staff-form")?.scrollIntoView({ block: "start" }),
    );
  };
  useEffect(() => {
    if (!editSocialBookingId) return;
    const person = workspace.staff.find((person) => person.bookingId === editSocialBookingId);
    if (person) openMember(person, true);
    // A newly requested member opens once; background refreshes must not overwrite their draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSocialBookingId]);
  useEffect(() => {
    if (!unsaved) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [unsaved]);
  const save = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await sponsorJson(
        editing ? `/api/sponsor/staff/${editing.bookingId}` : "/api/sponsor/staff",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            ...form,
            communitySocialAttending:
              form.communitySocialAttending === "unanswered"
                ? null
                : form.communitySocialAttending === "yes",
            communitySocialDietary:
              form.communitySocialAttending === "yes"
                ? sameRequirements
                  ? form.dietaryAccessibility
                  : form.communitySocialDietary
                : "",
          }),
        },
      );
      setNotice(
        editing
          ? replacing
            ? "Replacement registered. The staff place has been updated."
            : "Team member updated."
          : "Team member registered.",
      );
      setEditing(null);
      setForm(emptyTeamMember(workspace.sponsor.company));
      setShowForm(false);
      await onRefresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The registration could not be confirmed.",
      );
    } finally {
      setBusy(false);
      operation.current = false;
    }
  };
  const cancel = async (person: SponsorStaff) => {
    if (
      operation.current ||
      !window.confirm(
        `Cancel ${person.firstName} ${person.lastName}'s place? This returns one staff pass to your allocation.`,
      )
    )
      return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await sponsorJson(`/api/sponsor/staff/${person.bookingId}`, { method: "DELETE" });
      setNotice("Place cancelled and returned to your allocation.");
      if (editing?.bookingId === person.bookingId) {
        setEditing(null);
        setShowForm(false);
      }
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The place could not be cancelled.");
    } finally {
      setBusy(false);
      operation.current = false;
    }
  };
  const complete = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await sponsorJson("/api/sponsor/tasks/staff/complete", { method: "POST", body: "{}" });
      setNotice("Your team list is confirmed. You can still update it later.");
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your team list could not be confirmed.");
    } finally {
      setBusy(false);
      operation.current = false;
    }
  };
  return (
    <section className="space-y-6" aria-labelledby="team-heading">
      <div>
        <h2 id="team-heading" className="text-2xl font-bold">
          Team & passes
        </h2>
        <p className="mt-2 text-muted-foreground">
          Register your colleagues and share your guest invitations.
        </p>
      </div>
      {!showForm && <InlineError message={error} />}
      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          {notice}
        </p>
      )}
      <Card id="team-roster" className="scroll-mt-40 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Your team</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {currentStaff.length} registered · {remaining} staff{" "}
              {remaining === 1 ? "place" : "places"} available
            </p>
          </div>
          <Button
            className="min-h-11"
            disabled={busy || remaining === 0 || showForm}
            onClick={() => {
              setEditing(null);
              setForm(emptyTeamMember(workspace.sponsor.company));
              setBaseline(JSON.stringify(emptyTeamMember(workspace.sponsor.company)));
              setShowForm(true);
              setShowPreferences(false);
              setSameRequirements(false);
              setError("");
              requestAnimationFrame(() =>
                document.getElementById("staff-form")?.scrollIntoView({ block: "start" }),
              );
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add team member
          </Button>
        </div>
        <div className="mt-5 space-y-3">
          {currentStaff.map((person) => (
            <div
              key={person.bookingId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
            >
              <div className="min-w-0">
                <p className="font-semibold">
                  {person.firstName} {person.lastName}
                </p>
                <p className="break-all text-sm text-muted-foreground">{person.workEmail}</p>
                <p className="text-sm text-muted-foreground">
                  {person.jobTitle} · {person.company}
                </p>
                <p className="mt-1 text-xs">
                  Social:{" "}
                  {person.communitySocialAttending === null
                    ? "To confirm"
                    : person.communitySocialAttending
                      ? "Attending"
                      : "Not attending"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => openMember(person)}
                >
                  Edit details
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void cancel(person)}
                >
                  Cancel place
                </Button>
              </div>
            </div>
          ))}
          {!currentStaff.length && (
            <p className="rounded-lg bg-slate-50 p-4 text-sm text-muted-foreground">
              No team members registered yet. Add each person who will be attending on your staff
              allocation.
            </p>
          )}
        </div>
        {workspace.tasks.some((task) => task.taskKey === "staff" && task.required) && (
          <div className="mt-5 border-t pt-4">
            {teamComplete ? (
              <p className="flex items-center gap-2 text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4" />
                Team list confirmed
              </p>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  Finished for now? Confirm your list without using every available place.
                </p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy || showForm}
                  onClick={() => void complete()}
                >
                  {currentStaff.length ? "Confirm team list" : "Confirm no staff attending"}
                </Button>
              </>
            )}
          </div>
        )}
        {workspace.staff.some((person) => !["paid", "invoiced"].includes(person.status)) && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer py-2">Previous registrations</summary>
            {workspace.staff
              .filter((person) => !["paid", "invoiced"].includes(person.status))
              .map((person) => (
                <p key={person.bookingId} className="py-2 text-muted-foreground">
                  {person.firstName} {person.lastName} ·{" "}
                  {person.status === "cancelled" ? "Cancelled" : "Inactive"}
                </p>
              ))}
          </details>
        )}
      </Card>
      {showForm && (
        <Card id="staff-form" className="scroll-mt-40 p-5 sm:p-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              <div className="flex flex-wrap justify-between gap-3">
                <h3 className="text-lg font-semibold">
                  {editing ? "Update team member" : "Add a team member"}
                </h3>
                {editing && (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => {
                      setForm(emptyTeamMember(workspace.sponsor.company));
                      setShowPreferences(false);
                      setSameRequirements(false);
                    }}
                  >
                    Replace this person
                  </Button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                These five details are required to register a staff place.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["firstName", "First name", "given-name"],
                    ["lastName", "Last name", "family-name"],
                    ["jobTitle", "Job title", "organization-title"],
                    ["company", "Company", "organization"],
                    ["workEmail", "Work email", "email"],
                  ] as const
                ).map(([field, label, complete]) => (
                  <div key={field}>
                    <Label htmlFor={`staff-${field}`}>{label}</Label>
                    <Input
                      id={`staff-${field}`}
                      type={field === "workEmail" ? "email" : "text"}
                      value={form[field]}
                      required
                      maxLength={field === "workEmail" ? 254 : 200}
                      autoComplete={complete}
                      onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                    />
                  </div>
                ))}
              </div>
              <details
                open={showPreferences}
                onToggle={(event) => setShowPreferences(event.currentTarget.open)}
                className="rounded-xl border p-4"
              >
                <summary className="cursor-pointer py-1 font-medium">
                  Social, dietary and accessibility details (optional)
                </summary>
                <div className="mt-4 space-y-4">
                  <div>
                    <Label htmlFor="staff-phone">Phone (optional)</Label>
                    <Input
                      id="staff-phone"
                      type="tel"
                      autoComplete="tel"
                      value={form.phone}
                      onChange={(event) => setForm({ ...form, phone: event.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="staff-requirements">
                      Dietary or accessibility requirements (optional)
                    </Label>
                    <Textarea
                      id="staff-requirements"
                      maxLength={2000}
                      value={form.dietaryAccessibility}
                      onChange={(event) =>
                        setForm({ ...form, dietaryAccessibility: event.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="staff-social">Will they attend the Community Social?</Label>
                    <select
                      id="staff-social"
                      className="mt-1 h-11 w-full rounded-md border bg-white px-3 text-sm"
                      value={form.communitySocialAttending}
                      onChange={(event) =>
                        setForm({ ...form, communitySocialAttending: event.target.value })
                      }
                    >
                      <option value="unanswered">I'll confirm later</option>
                      <option value="yes">Yes, attending</option>
                      <option value="no">Not attending</option>
                    </select>
                  </div>
                  {form.communitySocialAttending === "yes" && (
                    <div className="space-y-3">
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={sameRequirements}
                          onChange={(event) => setSameRequirements(event.target.checked)}
                        />
                        Use the same requirements for the Social
                      </label>
                      {!sameRequirements && (
                        <div>
                          <Label htmlFor="staff-social-dietary">
                            Social dietary requirements (optional)
                          </Label>
                          <Input
                            id="staff-social-dietary"
                            maxLength={2000}
                            value={form.communitySocialDietary}
                            onChange={(event) =>
                              setForm({ ...form, communitySocialDietary: event.target.value })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={form.marketingConsent}
                      onChange={(event) =>
                        setForm({ ...form, marketingConsent: event.target.checked })
                      }
                    />
                    This attendee personally asked to receive future event and marketing updates.
                    Leave unticked unless they supplied this consent.
                  </label>
                </div>
              </details>
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-muted-foreground">
                Badge scanning is optional. Sponsors who scan this person's badge can save their
                name, role, company and work email as a lead. They can ask the SWP Summit team to
                exclude their badge from scanning.
              </p>
              <p className="text-sm">
                {!editing || replacing
                  ? "Confirming registers this person immediately and sends their attendee welcome email. No invoice or receipt is issued."
                  : "Save to update this person's registration. Changing their email replaces the attendee and sends a welcome email to the new person."}
              </p>
              <InlineError message={error} />
              <div className="flex flex-wrap gap-3">
                <Button type="submit" className="min-h-11">
                  {busy
                    ? "Saving…"
                    : editing
                      ? replacing
                        ? "Confirm replacement"
                        : "Save team member"
                      : "Confirm registration"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    setShowForm(false);
                    setEditing(null);
                    setError("");
                  }}
                >
                  Cancel editing
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
      <Invitations workspace={workspace} />
      <PassRequest />
    </section>
  );
}

function Invitations({ workspace }: { workspace: SponsorWorkspace }) {
  const [notice, setNotice] = useState("");
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied. Ready to paste into your message.");
    } catch {
      setNotice("Copy is unavailable. Select the invitation text and copy it from here.");
    }
  };
  return (
    <div id="sponsor-invitations" className="scroll-mt-40 space-y-4">
      <h3 className="text-lg font-semibold">Invitations & discount codes</h3>
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {workspace.codes.map((code) => (
          <Card key={code.kind} className="min-w-0 space-y-4 p-5">
            <div>
              <h4 className="font-semibold">
                {code.kind === "vip" ? "Private VIP invitations" : "Public 20% discount"}
              </h4>
              <p className="mt-1 text-sm text-muted-foreground">
                {code.kind === "vip"
                  ? `${code.remaining ?? 0} complimentary Workforce passes remaining${code.maxPerBooking ? ` · up to ${code.maxPerBooking} per booking` : ""}. Share privately with your guests.`
                  : "Share in newsletters or social posts. Applies to Workforce passes."}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg bg-blue-50 p-3">
              <span className="break-all font-mono font-bold">{code.code}</span>
              <Button
                size="icon"
                className="h-11 w-11 shrink-0"
                variant="ghost"
                aria-label={`Copy ${code.kind === "vip" ? "VIP" : "public discount"} code`}
                disabled={!code.active}
                onClick={() => void copy(code.code)}
              >
                <Clipboard className="h-4 w-4" />
              </Button>
            </div>
            {!code.active && (
              <p className="text-sm text-amber-900">This code is currently paused.</p>
            )}
            <p className="break-words rounded-lg border p-3 text-sm">
              {workspace.invitationCopy[code.kind]}
            </p>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!code.active}
              onClick={() => void copy(workspace.invitationCopy[code.kind])}
            >
              <Clipboard className="mr-2 h-4 w-4" />
              Copy invitation
            </Button>
            <details className="border-t pt-3 text-sm">
              <summary className="cursor-pointer py-2">
                Registrations using this code ({code.redemptions.length})
              </summary>
              <p className="my-2 text-xs text-muted-foreground">
                Contact and payment details are kept private.
              </p>
              {code.redemptions.map((person) => (
                <div key={person.bookingId} className="border-t py-3">
                  <p className="font-medium">
                    {person.firstName} {person.lastName}
                  </p>
                  <p>
                    {person.jobTitle} · {person.company}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(person.registeredAt).toLocaleDateString("en-GB")}
                  </p>
                </div>
              ))}
              {!code.redemptions.length && (
                <p className="py-2 text-muted-foreground">No registrations yet.</p>
              )}
            </details>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PassRequest() {
  const [vip, setVip] = useState("0");
  const [staff, setStaff] = useState("0");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const valid =
    [Number(vip), Number(staff)].every((value) => Number.isInteger(value) && value >= 0) &&
    Number(vip) + Number(staff) > 0;
  return (
    <details className="rounded-xl border bg-white p-5">
      <summary className="cursor-pointer py-1 font-semibold">Need more passes?</summary>
      <form
        className="mt-4 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await sponsorJson("/api/sponsor/pass-requests", {
              method: "POST",
              body: JSON.stringify({
                requestedVip: Number(vip),
                requestedStaff: Number(staff),
                message,
              }),
            });
            setNotice(
              "Your request is with the event team. Your allocation will change once it is approved.",
            );
            setVip("0");
            setStaff("0");
            setMessage("");
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "The request could not be sent.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-muted-foreground">Tell us how many extra places you need.</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="request-vip">Extra VIP passes</Label>
            <Input
              id="request-vip"
              type="number"
              min={0}
              step={1}
              value={vip}
              onChange={(event) => setVip(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="request-staff">Extra staff passes</Label>
            <Input
              id="request-staff"
              type="number"
              min={0}
              step={1}
              value={staff}
              onChange={(event) => setStaff(event.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="request-message">Message (optional)</Label>
          <Textarea
            id="request-message"
            value={message}
            maxLength={2000}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <InlineError message={error} />
        {notice && (
          <p role="status" className="text-sm text-emerald-800">
            {notice}
          </p>
        )}
        <Button type="submit" className="min-h-11" disabled={busy || !valid}>
          {busy ? "Sending request…" : "Request passes"}
        </Button>
      </form>
    </details>
  );
}
