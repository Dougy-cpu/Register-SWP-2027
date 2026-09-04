import type { SponsorPresenter, SponsorSession, SponsorWorkspace } from "@/types/sponsor";

export type PortalSection = "home" | "team" | "sessions" | "event";
export interface PortalStep {
  key: string;
  title: string;
  detail: string;
  section: PortalSection;
  target?: string;
  sessionId?: number;
  dueAt: string | null;
  state: "todo" | "waiting" | "complete";
}

export function formatPortalDate(value?: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long" })
    : "";
}

export function sessionName(session: SponsorSession) {
  return session.entitlementLabel.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function sessionStatusLabel(session: SponsorSession) {
  return {
    draft: "To complete",
    submitted: "With the event team",
    changes_requested: "Changes requested",
    approved: "Approved",
    exported: "Approved",
  }[session.status];
}

export const activeStaff = (workspace: SponsorWorkspace) =>
  workspace.staff.filter((person) => ["paid", "invoiced"].includes(person.status));

export function preparationSteps(workspace: SponsorWorkspace): PortalStep[] {
  const steps: PortalStep[] = [];
  const staff = activeStaff(workspace);
  const activeFiles = workspace.assets.filter((asset) => asset.status === "active");
  const task = (key: string) =>
    workspace.tasks.find((item) => item.taskKey === key && item.required);
  const add = (
    key: string,
    title: string,
    detail: string,
    section: PortalSection,
    target: string,
    state: PortalStep["state"],
  ) => {
    const configured = task(key);
    if (configured)
      steps.push({ key, title, detail, section, target, state, dueAt: configured.dueAt });
  };
  add(
    "staff",
    staff.length ? "Review and confirm your team" : "Add your team",
    `${staff.length} of ${workspace.sponsor.staffAllocation} staff places registered. You do not have to use every place.`,
    "team",
    "team-roster",
    task("staff")?.status === "completed" ? "complete" : "todo",
  );
  add(
    "assets",
    "Upload your logo",
    "Add the logo you would like us to use for your sponsorship.",
    "event",
    "sponsor-logo",
    activeFiles.some((asset) => asset.category === "logo") ? "complete" : "todo",
  );
  add(
    "onsite_contacts",
    "Confirm your onsite contact",
    "Tell us who we can reach on the day, including their phone number.",
    "event",
    "onsite-contact",
    workspace.contacts.some(
      (contact) => contact.role === "onsite" && contact.phone && contact.firstName && contact.email,
    )
      ? "complete"
      : "todo",
  );
  const documents = workspace.documents.filter((document) => document.required);
  add(
    "logistics",
    "Read your event information",
    documents.length
      ? "Read the event documents and confirm you have seen them."
      : "The event team will add your documents here. There is nothing to do yet.",
    "event",
    "event-documents",
    !documents.length
      ? "waiting"
      : documents.every(
            (document) =>
              document.acknowledged && activeFiles.some((asset) => asset.id === document.assetId),
          )
        ? "complete"
        : "todo",
  );
  add(
    "community_social",
    "Confirm your Community Social plans",
    staff.some((person) => person.communitySocialAttending === null)
      ? "Choose attending or not attending for each team member, then confirm your plans."
      : "Review who is joining the Social. You can also confirm that nobody is attending.",
    "event",
    "community-social",
    task("community_social")?.status === "completed" &&
      !staff.some((person) => person.communitySocialAttending === null)
      ? "complete"
      : "todo",
  );
  if (!workspace.sessions.length && (task("sessions") || task("speakers") || task("slides"))) {
    steps.push({
      key: "session-setup",
      title: "Your speaking sessions",
      detail: "The event team will add your agreed speaking slots here.",
      section: "sessions",
      dueAt: null,
      state: "waiting",
    });
  }
  for (const session of workspace.sessions) {
    steps.push({
      key: `session-${session.id}`,
      title: `Complete your ${sessionName(session)}`,
      detail:
        session.feedback ||
        session.title ||
        "Add your session details, speaker information and photos in one place.",
      section: "sessions",
      sessionId: session.id,
      dueAt: task("sessions")?.dueAt ?? task("speakers")?.dueAt ?? null,
      state: ["approved", "exported"].includes(session.status)
        ? "complete"
        : session.status === "submitted"
          ? "waiting"
          : "todo",
    });
    if (session.slidesRequired)
      steps.push({
        key: `slides-${session.id}`,
        title: `Upload slides: ${sessionName(session)}`,
        detail: "Slides can follow later. They do not hold up review of your session details.",
        section: "sessions",
        sessionId: session.id,
        target: `session-${session.id}-slides`,
        dueAt: task("slides")?.dueAt ?? null,
        state: activeFiles.some(
          (asset) => asset.sessionId === session.id && asset.category === "slides",
        )
          ? "complete"
          : "todo",
      });
  }
  const known = new Set([
    "staff",
    "assets",
    "onsite_contacts",
    "logistics",
    "community_social",
    "sessions",
    "speakers",
    "slides",
  ]);
  for (const item of workspace.tasks.filter((item) => item.required && !known.has(item.taskKey))) {
    steps.push({
      key: item.taskKey,
      title: item.label,
      detail:
        "See your event information for the requested details, or contact the event team for guidance.",
      section: "event",
      target: "additional-materials",
      dueAt: item.dueAt,
      state: item.status === "completed" ? "complete" : "todo",
    });
  }
  return steps.sort(
    (a, b) =>
      (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) -
      (b.dueAt ? new Date(b.dueAt).getTime() : Infinity),
  );
}

export function sessionDraft(session: SponsorSession) {
  const presenters: Array<SponsorPresenter & { biography: string }> = session.presenters.length
    ? session.presenters.map((person) => ({ ...person, biography: person.biography ?? "" }))
    : [{ name: "", jobTitle: "", company: "", biography: "" }];
  return {
    title: session.title ?? "",
    description: session.description ?? "",
    takeaways: Array.from({ length: 3 }, (_, index) => session.takeaways[index] ?? ""),
    presenters,
  };
}
export type SessionDraft = ReturnType<typeof sessionDraft>;

export function sessionMissingItems(
  draft: SessionDraft,
  session: SponsorSession,
  assets: SponsorWorkspace["assets"],
) {
  const missing: string[] = [];
  if (!draft.title.trim()) missing.push("Add a session title");
  if (!draft.description.trim()) missing.push("Add a short description");
  if (session.takeawaysRequired && !draft.takeaways.some((value) => value.trim()))
    missing.push("Add at least one takeaway");
  if (
    draft.presenters.some(
      (person) => !person.name.trim() || !person.jobTitle.trim() || !person.company.trim(),
    )
  )
    missing.push("Complete each speaker's name, job title and company");
  if (
    session.headshotRequired &&
    draft.presenters.some(
      (person) =>
        !person.id ||
        !assets.some(
          (asset) =>
            asset.status === "active" &&
            asset.category === "headshot" &&
            asset.sessionId === session.id &&
            asset.presenterId === person.id,
        ),
    )
  )
    missing.push("Upload a photo for each speaker");
  return missing;
}
