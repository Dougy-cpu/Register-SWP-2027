import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sponsorJson } from "@/lib/sponsor-api";
import type { SponsorAsset, SponsorSession } from "@/types/sponsor";
import {
  sessionDraft,
  sessionMissingItems,
  sessionName,
  sessionStatusLabel,
  type SessionDraft,
} from "./portal-helpers";
import { InlineError, UploadField } from "./portal-ui";

export const sessionDraftKey = (sponsorId: number, sessionId: number) =>
  `swp:sponsor:${sponsorId}:session:${sessionId}:draft`;

function initialEdit(session: SponsorSession, key: string) {
  const fallback = {
    draft: sessionDraft(session),
    baseRevision: session.currentRevision,
    modified: false,
  };
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      stored &&
      Number.isInteger(stored.baseRevision) &&
      typeof stored.draft?.title === "string" &&
      typeof stored.draft?.description === "string" &&
      Array.isArray(stored.draft.takeaways) &&
      stored.draft.takeaways.length === 3 &&
      stored.draft.takeaways.every((value: unknown) => typeof value === "string") &&
      Array.isArray(stored.draft.presenters) &&
      stored.draft.presenters.length > 0 &&
      stored.draft.presenters.length <= 20 &&
      stored.draft.presenters.every(
        (person: Record<string, unknown>) =>
          person && ["name", "jobTitle", "company"].every((key) => typeof person[key] === "string"),
      )
    ) {
      return {
        draft: stored.draft as SessionDraft,
        baseRevision: stored.baseRevision as number,
        modified: true,
      };
    }
  } catch {
    /* The in-memory editor and explicit Save draft remain available. */
  }
  return fallback;
}

export function PortalSession({
  sponsorId,
  session,
  assets,
  onSaved,
  onUploaded,
  onBack,
  onRefresh,
}: {
  sponsorId: number;
  session: SponsorSession;
  assets: SponsorAsset[];
  onSaved: (session: SponsorSession) => void;
  onUploaded: (asset: SponsorAsset) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const key = sessionDraftKey(sponsorId, session.id);
  const [edit, setEdit] = useState(() => initialEdit(session, key));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [storageProblem, setStorageProblem] = useState(false);
  const operation = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const busy = saving || uploading || submitting;
  const conflict = edit.modified && edit.baseRevision !== session.currentRevision;
  const draft = edit.draft;
  const missing = sessionMissingItems(draft, session, assets);
  const activeFiles = assets.filter(
    (asset) => asset.status === "active" && asset.sessionId === session.id,
  );
  useEffect(() => {
    if (!edit.modified && edit.baseRevision !== session.currentRevision)
      setEdit({
        draft: sessionDraft(session),
        baseRevision: session.currentRevision,
        modified: false,
      });
  }, [session, edit.modified, edit.baseRevision]);
  useEffect(() => {
    try {
      if (edit.modified)
        sessionStorage.setItem(
          key,
          JSON.stringify({ draft: edit.draft, baseRevision: edit.baseRevision }),
        );
      else sessionStorage.removeItem(key);
      setStorageProblem(false);
    } catch {
      setStorageProblem(true);
    }
  }, [key, edit]);
  useEffect(() => {
    if (!edit.modified) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [edit.modified]);
  const update = (next: SessionDraft) => {
    setEdit((current) => ({
      ...current,
      draft: next,
      modified: JSON.stringify(next) !== JSON.stringify(sessionDraft(session)),
    }));
    setNotice("");
  };
  const rememberSaved = (saved: SponsorSession) => {
    setEdit({ draft: sessionDraft(saved), baseRevision: saved.currentRevision, modified: false });
    onSaved(saved);
  };
  const save = async () => {
    if (conflict)
      throw new Error("A newer version is available. Review it before saving your draft.");
    if (!edit.modified && session.presenters.length) return session;
    setSaving(true);
    try {
      const saved = await sponsorJson<SponsorSession>(`/api/sponsor/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...draft,
          takeaways: draft.takeaways.filter((value) => value.trim()),
          expectedRevision: edit.baseRevision,
        }),
      });
      rememberSaved(saved);
      return saved;
    } finally {
      setSaving(false);
    }
  };
  const saveDraft = async () => {
    if (operation.current || busy) return;
    operation.current = true;
    setError("");
    try {
      await save();
      setNotice("Draft saved. You can come back to it later.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your draft could not be saved.");
    } finally {
      operation.current = false;
    }
  };
  const submit = async () => {
    if (busy || operation.current) return;
    setError("");
    setNotice("");
    if (missing.length) {
      setError(`Before submitting: ${missing.join("; ")}.`);
      return;
    }
    operation.current = true;
    setSubmitting(true);
    try {
      const saved = await save();
      setSaving(true);
      const submitted = await sponsorJson<SponsorSession>(
        `/api/sponsor/sessions/${session.id}/submit`,
        { method: "POST", body: JSON.stringify({ expectedRevision: saved.currentRevision }) },
      );
      rememberSaved(submitted);
      setNotice(
        "Your session is with the event team. We'll let you know if anything else is needed.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your session could not be submitted. Your draft is still here.",
      );
    } finally {
      setSaving(false);
      setSubmitting(false);
      operation.current = false;
    }
  };
  const prefix = `session-${session.id}`;
  return (
    <section aria-labelledby={`${prefix}-heading`} className="space-y-5">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 px-0"
        disabled={busy}
        onClick={onBack}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        All sessions
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-primary">Your speaking slot</p>
          <h2 id={`${prefix}-heading`} className="mt-1 text-2xl font-bold">
            {sessionName(session)}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Complete the details and speaker photos here. Slides can follow later.
          </p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-2 text-sm text-primary">
          {sessionStatusLabel(session)}
        </span>
      </div>
      {session.feedback && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="font-semibold">A note from the event team</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm">{session.feedback}</p>
        </div>
      )}
      {conflict && (
        <Card className="space-y-3 border-amber-300 p-4">
          <p role="alert">
            This session was updated elsewhere. Your unfinished draft is still here.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(JSON.stringify(draft, null, 2))
                  .then(() => setNotice("Your draft has been copied."))
                  .catch(() =>
                    setError("Copy is unavailable. Save your text before replacing this draft."),
                  );
              }}
            >
              Copy my draft
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (
                  window.confirm(
                    "Replace your unfinished edits with the latest saved session? Copy any text you want to keep first.",
                  )
                ) {
                  rememberSaved(session);
                  setError("");
                }
              }}
            >
              Use latest saved version
            </Button>
          </div>
        </Card>
      )}
      {storageProblem && edit.modified && (
        <p role="alert" className="text-sm text-amber-900">
          This browser cannot keep a local copy. Use Save draft before leaving this page.
        </p>
      )}
      <fieldset disabled={busy || conflict} className="min-w-0 space-y-5">
        <Card className="space-y-5 p-5 sm:p-6">
          <h3 className="text-lg font-semibold">Session details</h3>
          <p className="text-sm text-muted-foreground">
            Title, description and speaker details are required.
          </p>
          <div>
            <Label htmlFor={`${prefix}-title`}>Session title</Label>
            <Input
              id={`${prefix}-title`}
              value={draft.title}
              maxLength={250}
              onChange={(event) => update({ ...draft, title: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor={`${prefix}-description`}>Short description</Label>
            <Textarea
              id={`${prefix}-description`}
              rows={5}
              maxLength={1500}
              value={draft.description}
              onChange={(event) => update({ ...draft, description: event.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              What will the audience learn? {draft.description.length} / 1,500 characters
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-medium text-sm">
              Key takeaways {session.takeawaysRequired ? "(at least one)" : "(optional)"}
            </p>
            {draft.takeaways.map((takeaway, index) => (
              <div key={index}>
                <Label className="sr-only" htmlFor={`${prefix}-takeaway-${index}`}>
                  Takeaway {index + 1}
                </Label>
                <Input
                  id={`${prefix}-takeaway-${index}`}
                  placeholder={`Takeaway ${index + 1}`}
                  maxLength={300}
                  value={takeaway}
                  onChange={(event) =>
                    update({
                      ...draft,
                      takeaways: draft.takeaways.map((value, item) =>
                        item === index ? event.target.value : value,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>
        </Card>
        {draft.presenters.map((person, index) => (
          <Card key={index} className="space-y-5 p-5 sm:p-6">
            <h3 className="text-lg font-semibold">
              {draft.presenters.length > 1 ? `Speaker ${index + 1}` : "Your speaker"}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["name", "Full name"],
                  ["jobTitle", "Job title"],
                  ["company", "Company"],
                  ["biography", "Short biography (optional)"],
                ] as const
              ).map(([field, label]) => (
                <div key={field}>
                  <Label htmlFor={`${prefix}-speaker-${index}-${field}`}>{label}</Label>
                  <Input
                    id={`${prefix}-speaker-${index}-${field}`}
                    maxLength={field === "biography" ? 2000 : 200}
                    value={person[field] ?? ""}
                    onChange={(event) =>
                      update({
                        ...draft,
                        presenters: draft.presenters.map((value, personIndex) =>
                          personIndex === index ? { ...value, [field]: event.target.value } : value,
                        ),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <div>
              <h4 className="mb-2 text-sm font-semibold">
                Speaker photo {session.headshotRequired ? "(required)" : "(optional)"}
              </h4>
              {!person.name.trim() && (
                <p className="mb-2 text-sm text-muted-foreground">
                  Add the speaker's name above, then upload their photo.
                </p>
              )}
              <UploadField
                label="Upload speaker photo"
                category="headshot"
                disabled={!person.name.trim()}
                files={activeFiles.filter(
                  (asset) => asset.category === "headshot" && asset.presenterId === person.id,
                )}
                prepare={async () => {
                  const saved = await save();
                  const savedPerson = saved.presenters[index];
                  if (!savedPerson?.id)
                    throw new Error("Save the speaker's details before uploading their photo.");
                  return { sessionId: session.id, presenterId: savedPerson.id };
                }}
                onUploaded={onUploaded}
                onBusyChange={setUploading}
              />
            </div>
          </Card>
        ))}
        <Card className="space-y-4 p-5 sm:p-6">
          <h3 className="text-lg font-semibold">Send your session for review</h3>
          <InlineError message={error} />
          {notice && (
            <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
              {notice}
            </p>
          )}
          {error && (
            <Button type="button" variant="outline" onClick={() => void onRefresh()}>
              Refresh saved details
            </Button>
          )}
          {missing.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4" />
              Your session details are ready.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void saveDraft()}
            >
              Save draft
            </Button>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => void submit()}
              disabled={
                !edit.modified && ["submitted", "approved", "exported"].includes(session.status)
              }
            >
              {edit.modified && session.status !== "draft"
                ? "Send updated details"
                : "Submit for review"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {edit.modified
              ? "Your edits are kept in this browser tab. Submit includes everything you have entered."
              : "You can return to this session whenever you need to."}
          </p>
          {["approved", "exported"].includes(session.status) && (
            <p className="text-sm text-muted-foreground">
              Saving changes to approved details sends them back to the event team for review.
            </p>
          )}
        </Card>
        <Card id={`${prefix}-slides`} className="scroll-mt-40 space-y-4 p-5 sm:p-6">
          <h3 className="text-lg font-semibold">
            Presentation slides {session.slidesRequired ? "(required later)" : "(optional)"}
          </h3>
          <p className="text-sm text-muted-foreground">
            You can submit your session details before your slides are ready.
          </p>
          <UploadField
            label="Upload slides"
            category="slides"
            sessionId={session.id}
            files={activeFiles.filter((asset) => asset.category === "slides")}
            onUploaded={onUploaded}
            onBusyChange={setUploading}
          />
        </Card>
        <details className="rounded-xl border p-5">
          <summary className="cursor-pointer font-medium">
            Additional session material (optional)
          </summary>
          <div className="mt-4">
            <UploadField
              label="Upload session material"
              category="session_material"
              sessionId={session.id}
              files={activeFiles.filter((asset) => asset.category === "session_material")}
              onUploaded={onUploaded}
              onBusyChange={setUploading}
            />
          </div>
        </details>
      </fieldset>
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          Saving your changes…
        </p>
      )}
    </section>
  );
}
