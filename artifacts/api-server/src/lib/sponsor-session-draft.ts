import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  sponsorSessionsTable,
  sponsorSessionRevisionsTable,
  sponsorPresentersTable,
  sponsorAssetsTable,
  sponsorTasksTable,
  sponsorActivityTable,
} from "@workspace/db";
import { SponsorPortalError, saveSessionPresenters } from "./sponsor-portal";
type SponsorTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SessionBody {
  expectedRevision?: number;
  title?: string;
  description?: string;
  takeaways?: string[];
  presenters?: Array<{
    id?: number;
    name?: string;
    jobTitle?: string;
    company?: string;
    biography?: string | null;
  }>;
}

function cleanSession(body: SessionBody) {
  const takeaways = Array.isArray(body.takeaways)
    ? body.takeaways
        .map((item) => String(item).trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const presenters = Array.isArray(body.presenters)
    ? body.presenters.map((presenter, index) => ({
        id: presenter.id,
        name: String(presenter.name ?? "").trim(),
        jobTitle: String(presenter.jobTitle ?? "").trim(),
        company: String(presenter.company ?? "").trim(),
        biography:
          String(presenter.biography ?? "")
            .trim()
            .slice(0, 2000) || null,
        displayOrder: index,
      }))
    : [];
  return {
    title:
      String(body.title ?? "")
        .trim()
        .slice(0, 250) || null,
    description:
      String(body.description ?? "")
        .trim()
        .slice(0, 1500) || null,
    takeaways,
    presenters,
  };
}

export async function saveSessionDraft(
  tx: SponsorTransaction,
  sponsorId: number,
  sessionId: number,
  body: SessionBody,
) {
  const [session] = await tx
    .select()
    .from(sponsorSessionsTable)
    .where(
      and(eq(sponsorSessionsTable.id, sessionId), eq(sponsorSessionsTable.sponsorId, sponsorId)),
    )
    .for("update");
  if (!session) throw new SponsorPortalError("Session entitlement not found", 404);
  const existingPresenters = await tx
    .select()
    .from(sponsorPresentersTable)
    .where(eq(sponsorPresentersTable.sessionId, sessionId))
    .orderBy(sponsorPresentersTable.displayOrder);
  if (
    body.presenters !== undefined &&
    (!Array.isArray(body.presenters) ||
      body.presenters.length > 20 ||
      body.presenters.some((person) => !person || typeof person !== "object"))
  ) {
    throw new SponsorPortalError("Check the speaker details and try again.");
  }
  const clean = cleanSession({
    title: session.title ?? "",
    description: session.description ?? "",
    takeaways: session.takeaways,
    presenters: existingPresenters,
    ...body,
  });
  const current = cleanSession({
    title: session.title ?? "",
    description: session.description ?? "",
    takeaways: session.takeaways,
    presenters: existingPresenters,
  });
  if (JSON.stringify(clean) === JSON.stringify(current))
    return { session, nextRevision: session.currentRevision, changed: false };
  if (body.expectedRevision !== undefined && body.expectedRevision !== session.currentRevision) {
    throw new SponsorPortalError(
      "This session was updated elsewhere. Your draft is still here; refresh the saved version before making further changes.",
      409,
    );
  }
  const nextRevision = session.currentRevision + 1;
  const nextStatus = "draft" as const;
  await saveSessionPresenters(tx, sessionId, clean.presenters);
  const presenters = await tx
    .select()
    .from(sponsorPresentersTable)
    .where(eq(sponsorPresentersTable.sessionId, sessionId))
    .orderBy(sponsorPresentersTable.displayOrder);
  const snapshot = {
    title: clean.title,
    description: clean.description,
    takeaways: clean.takeaways,
    presenters: presenters.map(({ id, name, jobTitle, company, biography, displayOrder }) => ({
      id,
      name,
      jobTitle,
      company,
      biography,
      displayOrder,
    })),
  };
  await tx
    .update(sponsorSessionsTable)
    .set({
      title: clean.title,
      description: clean.description,
      takeaways: clean.takeaways,
      currentRevision: nextRevision,
      status: nextStatus,
      approvedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(sponsorSessionsTable.id, sessionId));
  await tx.insert(sponsorSessionRevisionsTable).values({
    sessionId,
    revision: nextRevision,
    snapshot,
    actor: "sponsor",
  });
  if (session.status !== "draft" || session.currentRevision === 0)
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: "session_draft_started",
      actorType: "sponsor",
      data: { sessionId, revision: nextRevision, previousStatus: session.status, nextStatus },
    });
  await tx
    .update(sponsorTasksTable)
    .set({
      status: "todo",
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sponsorTasksTable.sponsorId, sponsorId),
        inArray(sponsorTasksTable.taskKey, ["sessions", "speakers"]),
        eq(sponsorTasksTable.required, true),
      ),
    );

  return {
    session: { ...session, ...snapshot, status: nextStatus, currentRevision: nextRevision },
    nextRevision,
    changed: true,
  };
}

export async function sessionSubmissionErrors(
  sessionId: number,
  connection: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<string[]> {
  const [session] = await connection
    .select()
    .from(sponsorSessionsTable)
    .where(eq(sponsorSessionsTable.id, sessionId));
  if (!session) return ["Session not found"];
  const [presenters, assets] = await Promise.all([
    connection
      .select()
      .from(sponsorPresentersTable)
      .where(eq(sponsorPresentersTable.sessionId, sessionId)),
    connection
      .select()
      .from(sponsorAssetsTable)
      .where(
        and(eq(sponsorAssetsTable.sessionId, sessionId), eq(sponsorAssetsTable.status, "active")),
      ),
  ]);
  const errors: string[] = [];
  if (!session.title) errors.push("Add a session title");
  if (!session.description) errors.push("Add a concise session description");
  if (!presenters.length || presenters.some((p) => !p.name || !p.jobTitle || !p.company)) {
    errors.push("Add complete presenter details");
  }
  if (session.takeawaysRequired && !session.takeaways.length)
    errors.push("Add at least one takeaway");
  if (
    session.headshotRequired &&
    presenters.some(
      (presenter) =>
        !assets.some(
          (asset) => asset.category === "headshot" && asset.presenterId === presenter.id,
        ),
    )
  ) {
    errors.push("Upload and link a headshot to each presenter");
  }
  // Final slides have their own checklist milestone and must not block programme review.
  return errors;
}
