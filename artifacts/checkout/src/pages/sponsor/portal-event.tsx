import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sponsorJson } from "@/lib/sponsor-api";
import type { SponsorAsset, SponsorContact, SponsorWorkspace } from "@/types/sponsor";
import { activeStaff } from "./portal-helpers";
import { EventDocument, InlineError, UploadField } from "./portal-ui";

const contactForm = (contact?: SponsorContact) => ({
  id: contact?.id,
  firstName: contact?.firstName ?? "",
  lastName: contact?.lastName ?? "",
  email: contact?.email ?? "",
  phone: contact?.phone ?? "",
  jobTitle: contact?.jobTitle ?? "",
});

export function PortalEvent({
  workspace,
  onRefresh,
  onUploaded,
  onEditSocial,
}: {
  workspace: SponsorWorkspace;
  onRefresh: () => Promise<void>;
  onUploaded: (asset: SponsorAsset) => void;
  onEditSocial: (bookingId: number) => void;
}) {
  const [contact, setContact] = useState(() =>
    contactForm(workspace.contacts.find((contact) => contact.role === "onsite")),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialError, setSocialError] = useState("");
  const primary = workspace.contacts.find(
    (contact) => contact.isPrimary || contact.role === "primary",
  );
  const files = workspace.assets.filter((asset) => asset.status === "active");
  const staff = activeStaff(workspace);
  const unanswered = staff.filter((person) => person.communitySocialAttending === null);
  const socialComplete = workspace.tasks.some(
    (task) => task.taskKey === "community_social" && task.status === "completed",
  );
  const socialTask = workspace.tasks.some(
    (task) => task.taskKey === "community_social" && task.required,
  );
  const saveContact = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await sponsorJson<SponsorContact>("/api/sponsor/onsite-contact", {
        method: "PUT",
        body: JSON.stringify(contact),
      });
      setContact(contactForm(saved));
      setNotice("Onsite contact confirmed.");
      await onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The onsite contact could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const confirmSocial = async () => {
    if (socialBusy || unanswered.length) return;
    setSocialBusy(true);
    setSocialError("");
    try {
      await sponsorJson("/api/sponsor/tasks/community_social/complete", {
        method: "POST",
        body: "{}",
      });
      await onRefresh();
    } catch (caught) {
      setSocialError(
        caught instanceof Error ? caught.message : "Your Social plans could not be confirmed.",
      );
    } finally {
      setSocialBusy(false);
    }
  };
  return (
    <section aria-labelledby="event-heading" className="space-y-6">
      <div>
        <h2 id="event-heading" className="text-2xl font-bold">
          Event details
        </h2>
        <p className="mt-2 text-muted-foreground">
          Your logo, contacts and arrangements for the day.
        </p>
      </div>
      <Card id="sponsor-logo" className="scroll-mt-40 space-y-4 p-5 sm:p-6">
        <div>
          <h3 className="text-lg font-semibold">Your company logo</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload the version you would like us to use. Speaker photos and slides belong in each
            session.
          </p>
        </div>
        <UploadField
          label="Upload your logo"
          category="logo"
          files={files.filter((asset) => asset.category === "logo")}
          onUploaded={onUploaded}
        />
      </Card>
      <Card id="onsite-contact" className="scroll-mt-40 p-5 sm:p-6">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveContact();
          }}
        >
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Your onsite contact</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Who should we contact on the day? Please include a phone number we can reach them
                on.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {workspace.contacts.length > 0 && (
                <div className="min-w-0 flex-1">
                  <Label htmlFor="onsite-existing">
                    Choose an existing contact or add someone new
                  </Label>
                  <select
                    id="onsite-existing"
                    className="mt-1 h-11 w-full rounded-md border bg-white px-3 text-sm"
                    value={contact.id ?? "new"}
                    onChange={(event) =>
                      setContact(
                        contactForm(
                          workspace.contacts.find(
                            (person) => String(person.id) === event.target.value,
                          ),
                        ),
                      )
                    }
                  >
                    <option value="new">Add a new contact</option>
                    {workspace.contacts.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.firstName} {person.lastName}
                        {person.isPrimary || person.role === "primary" ? " (main contact)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {primary && (
                <Button
                  variant="outline"
                  type="button"
                  className="min-h-11"
                  onClick={() => setContact(contactForm(primary))}
                >
                  Use main contact
                </Button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["firstName", "First name", "given-name"],
                  ["lastName", "Last name", "family-name"],
                  ["email", "Email", "email"],
                  ["phone", "Contact phone", "tel"],
                ] as const
              ).map(([field, label, complete]) => (
                <div key={field}>
                  <Label htmlFor={`onsite-${field}`}>{label}</Label>
                  <Input
                    id={`onsite-${field}`}
                    required
                    type={field === "email" ? "email" : field === "phone" ? "tel" : "text"}
                    autoComplete={complete}
                    minLength={field === "phone" ? 3 : 1}
                    maxLength={field === "email" ? 254 : field === "phone" ? 50 : 100}
                    value={contact[field]}
                    onChange={(event) => setContact({ ...contact, [field]: event.target.value })}
                  />
                </div>
              ))}
            </div>
            <InlineError message={error} />
            {notice && (
              <p role="status" className="text-sm text-emerald-800">
                {notice}
              </p>
            )}
            <Button type="submit" className="min-h-11">
              {busy ? "Saving…" : "Confirm onsite contact"}
            </Button>
            {workspace.contacts
              .filter((person) => person.role === "onsite" && person.id !== contact.id)
              .map((person) => (
                <p key={person.id} className="text-sm text-muted-foreground">
                  Also confirmed: {person.firstName} {person.lastName} · {person.phone}
                </p>
              ))}
          </fieldset>
        </form>
      </Card>
      <Card id="event-documents" className="scroll-mt-40 space-y-4 p-5 sm:p-6">
        <h3 className="text-lg font-semibold">Your event information</h3>
        <p className="text-sm text-muted-foreground">
          Read the documents below and confirm each required item.
        </p>
        {workspace.documents.map((document) => (
          <EventDocument
            key={`${document.id}-${document.acknowledgementVersion}`}
            document={document}
            available={files.some((asset) => asset.id === document.assetId)}
            onAcknowledged={onRefresh}
          />
        ))}
        {!workspace.documents.length && (
          <p className="rounded-lg bg-blue-50 p-4 text-sm text-muted-foreground">
            The event team will add your documents here. There is nothing to do yet.
          </p>
        )}
      </Card>
      <Card id="community-social" className="scroll-mt-40 space-y-4 p-5 sm:p-6">
        <h3 className="text-lg font-semibold">Community Social</h3>
        <p className="text-sm text-muted-foreground">
          Confirm whether each team member is joining us. Dietary details can be added with their
          staff registration.
        </p>
        {staff.map((person) => (
          <div
            key={person.bookingId}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div>
              <p className="font-medium">
                {person.firstName} {person.lastName}
              </p>
              <p className="text-sm text-muted-foreground">
                {person.communitySocialAttending === null
                  ? "Attendance to confirm"
                  : person.communitySocialAttending
                    ? "Attending"
                    : "Not attending"}
              </p>
            </div>
            <Button
              variant="outline"
              className="min-h-11"
              aria-label={`Update Social plans for ${person.firstName} ${person.lastName}`}
              onClick={() => onEditSocial(person.bookingId)}
            >
              Update plans
            </Button>
          </div>
        ))}
        {!staff.length && (
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-muted-foreground">
            No staff are registered yet. Add your team first, or confirm below if nobody will
            attend.
          </p>
        )}
        <InlineError message={socialError} />
        {socialTask &&
          (socialComplete && !unanswered.length ? (
            <p role="status" className="flex items-center gap-2 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4" />
              Social plans confirmed
            </p>
          ) : (
            <>
              <Button
                className="min-h-11"
                disabled={socialBusy || unanswered.length > 0}
                onClick={() => void confirmSocial()}
              >
                {socialBusy
                  ? "Saving…"
                  : staff.some((person) => person.communitySocialAttending)
                    ? "Confirm Social plans"
                    : "Confirm no one attending"}
              </Button>
              {unanswered.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Update the{" "}
                  {unanswered.length === 1
                    ? "unanswered attendance choice"
                    : `${unanswered.length} unanswered attendance choices`}{" "}
                  above before confirming.
                </p>
              )}
            </>
          ))}
      </Card>
      <details id="additional-materials" className="scroll-mt-40 rounded-xl border bg-white p-5">
        <summary className="cursor-pointer py-1 font-semibold">Other requested files</summary>
        <div className="mt-4">
          <UploadField
            label="Upload an additional file"
            category="other"
            files={files.filter(
              (asset) =>
                (asset.category === "other" || asset.category === "logistics") &&
                !workspace.documents.some((document) => document.assetId === asset.id),
            )}
            onUploaded={onUploaded}
          />
        </div>
      </details>
      {workspace.assets.some((asset) => asset.status === "missing") && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          An uploaded file is temporarily unavailable. Your task will remain open until a working
          file is available. Please upload its replacement or contact the event team.
        </p>
      )}
    </section>
  );
}
