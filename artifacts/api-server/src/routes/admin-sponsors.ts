import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import { and, asc, desc, eq, gte, ilike, inArray, lte } from "drizzle-orm";
import {
  db,
  sponsorActivityTable,
  sponsorAssetsTable,
  sponsorDocumentsTable,
  sponsorPresentersTable,
  sponsorSessionRevisionsTable,
  sponsorSessionsTable,
  sponsorTasksTable,
  sponsorsTable,
} from "@workspace/db";
import { adminAuth } from "../middleware/admin-auth";
import {
  buildSponsorWorkspace,
  confirmSponsor,
  createSponsorDraft,
  listSponsorSummaries,
  rotateSponsorAccess,
  SponsorConflictError,
  SponsorNotFoundError,
  type SponsorUpsertInput,
  updateSponsor,
} from "../lib/sponsor-service";
import {
  activeSponsorAssets,
  createSponsorAsset,
  formatSponsorAsset,
  isSafeRasterPreview,
  preflightSponsorAssets,
  recordSponsorStorageFailure,
  safeDownloadFilename,
  SponsorAssetValidationError,
  SPONSOR_DOCUMENT_MAX_BYTES,
  streamSponsorAssetsZip,
} from "../lib/sponsor-assets";
import { getSponsorObjectStorage, SponsorStorageError } from "../lib/sponsor-storage";
import {
  buildSponsorWelcomePreview,
  sendReviewedSponsorWelcome,
  sendSponsorInternalNotification,
} from "../lib/sponsor-email";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SPONSOR_DOCUMENT_MAX_BYTES, files: 1, fields: 12 },
});
const ASSET_CATEGORIES = [
  "logo",
  "headshot",
  "slides",
  "session_material",
  "logistics",
  "other",
] as const;
const SESSION_TYPES = ["quickfire", "keynote", "other"] as const;

router.use("/admin/sponsors", adminAuth);
router.use("/admin/sponsor-assets", adminAuth);

function idParam(value: string | string[] | undefined): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assetIdParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? "");
}

function sendRouteError(res: Response, error: unknown): void {
  if (error instanceof SponsorNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof SponsorAssetValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof SponsorConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof SponsorStorageError) {
    res
      .status(503)
      .json({ error: "App Storage is unavailable. The deliverable has not been marked complete." });
    return;
  }
  if ((error as { code?: string }).code === "23505") {
    res
      .status(409)
      .json({ error: "That company code or contact already exists. Choose a unique value." });
    return;
  }
  logger.error({ error }, "Sponsor admin request failed");
  res.status(500).json({ error: "The sponsor request could not be completed" });
}

function sessionEntitlementInput(body: Record<string, unknown>) {
  const type = String(body.type ?? "");
  const entitlementLabel = String(body.entitlementLabel ?? "")
    .trim()
    .slice(0, 250);
  if (!SESSION_TYPES.includes(type as (typeof SESSION_TYPES)[number]) || !entitlementLabel) {
    throw new SponsorConflictError("Choose a session type and enter an entitlement label");
  }
  return {
    type: type as (typeof SESSION_TYPES)[number],
    entitlementLabel,
    headshotRequired: body.headshotRequired !== false,
    takeawaysRequired: body.takeawaysRequired !== false,
    slidesRequired: body.slidesRequired === true,
  };
}

async function refreshSessionTasks(sponsorId: number, resetContent = false): Promise<void> {
  const [sessions, tasks] = await Promise.all([
    db.select().from(sponsorSessionsTable).where(eq(sponsorSessionsTable.sponsorId, sponsorId)),
    db.select().from(sponsorTasksTable).where(eq(sponsorTasksTable.sponsorId, sponsorId)),
  ]);
  const definitions = [
    { taskKey: "sessions", label: "Session details", required: sessions.length > 0 },
    { taskKey: "speakers", label: "Speaker details", required: sessions.length > 0 },
    {
      taskKey: "slides",
      label: "Session slides",
      required: sessions.some((item) => item.slidesRequired),
    },
  ];
  for (const definition of definitions) {
    const existing = tasks.find((task) => task.taskKey === definition.taskKey);
    const status = definition.required
      ? resetContent || !existing || existing.status === "not_required"
        ? "todo"
        : existing.status
      : "not_required";
    if (existing) {
      await db
        .update(sponsorTasksTable)
        .set({
          required: definition.required,
          status,
          completedAt: status === "completed" ? existing.completedAt : null,
          updatedAt: new Date(),
        })
        .where(eq(sponsorTasksTable.id, existing.id));
    } else {
      await db.insert(sponsorTasksTable).values({
        sponsorId,
        taskKey: definition.taskKey,
        label: definition.label,
        required: definition.required,
        status,
      });
    }
  }
}

router.get("/admin/sponsors", async (req, res): Promise<void> => {
  const sponsors = await listSponsorSummaries({
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    search: typeof req.query.search === "string" ? req.query.search : undefined,
  });
  res.json({ sponsors });
});

router.post("/admin/sponsors", async (req, res): Promise<void> => {
  try {
    const workspace = await createSponsorDraft(req.body as SponsorUpsertInput);
    await sendSponsorInternalNotification({
      sponsorId: workspace.id,
      category: "admin",
      event: "Sponsor draft created",
      summary: `${workspace.company} was added as a draft sponsor. No welcome email was sent.`,
    });
    res.status(201).json(workspace);
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.get("/admin/sponsors/:sponsorId", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  try {
    res.json(await buildSponsorWorkspace(sponsorId, true));
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.patch("/admin/sponsors/:sponsorId", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  try {
    const workspace = await updateSponsor(sponsorId, req.body as SponsorUpsertInput);
    await sendSponsorInternalNotification({
      sponsorId,
      category: "admin",
      event: "Sponsor record updated",
      summary: `${workspace.company} sponsor details, allocations or status were updated.`,
    });
    res.json(workspace);
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.post("/admin/sponsors/:sponsorId/confirm", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  try {
    const workspace = await confirmSponsor(sponsorId);
    await sendSponsorInternalNotification({
      sponsorId,
      category: "admin",
      event: "Sponsor confirmed",
      summary: `${workspace.company} was confirmed and its private VIP and public 20% Workforce codes were activated. The welcome email still requires review and explicit Send.`,
    });
    res.json(workspace);
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.post("/admin/sponsors/:sponsorId/access/rotate", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  try {
    const accessUrl = await rotateSponsorAccess(sponsorId);
    await sendSponsorInternalNotification({
      sponsorId,
      category: "admin",
      event: "Sponsor access rotated",
      summary:
        "Previous sponsor links and active sessions were revoked. A new link is available in admin.",
    });
    res.json({ accessUrl });
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.get("/admin/sponsors/:sponsorId/welcome/preview", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  try {
    res.json(await buildSponsorWelcomePreview(sponsorId));
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.post("/admin/sponsors/:sponsorId/welcome/send", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  const expectedPreviewHash = String(req.body.expectedPreviewHash ?? "");
  if (!sponsorId || !/^[a-f0-9]{64}$/.test(expectedPreviewHash)) {
    res.status(400).json({ error: "Preview the current email before sending" });
    return;
  }
  try {
    const sent = await sendReviewedSponsorWelcome(sponsorId, expectedPreviewHash);
    if (sent) {
      await sendSponsorInternalNotification({
        sponsorId,
        category: "admin",
        event: "Sponsor welcome sent",
        summary: "The explicitly reviewed sponsor welcome email was accepted for delivery.",
      });
    }
    res.status(sent ? 200 : 502).json({ sent });
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.patch("/admin/sponsors/:sponsorId/tasks/:taskId", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  const taskId = idParam(req.params.taskId);
  const status = String(req.body.status ?? "");
  if (
    !sponsorId ||
    !taskId ||
    !["todo", "submitted", "completed", "overdue", "not_required"].includes(status)
  ) {
    res.status(400).json({ error: "Choose a valid deliverable status" });
    return;
  }
  const [updated] = await db
    .update(sponsorTasksTable)
    .set({
      status: status as (typeof sponsorTasksTable.$inferInsert)["status"],
      required: status !== "not_required",
      completedAt: status === "completed" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(eq(sponsorTasksTable.id, taskId), eq(sponsorTasksTable.sponsorId, sponsorId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Deliverable not found" });
    return;
  }
  await db.insert(sponsorActivityTable).values({
    sponsorId,
    type: "task_status_changed",
    actorType: "admin",
    data: { taskId, taskKey: updated.taskKey, status },
  });
  await sendSponsorInternalNotification({
    sponsorId,
    category: "content",
    event: "Sponsor deliverable status updated",
    summary: `${updated.label} was marked ${status.replace("_", " ")}.`,
  });
  res.json({
    ...updated,
    dueAt: updated.dueAt?.toISOString() ?? null,
    completedAt: updated.completedAt?.toISOString() ?? null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
});

router.post("/admin/sponsors/:sponsorId/sessions", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  try {
    const [sponsor] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
    if (!sponsor) throw new SponsorNotFoundError();
    if (sponsor.status === "cancelled") {
      throw new SponsorConflictError(
        "A cancelled sponsor cannot receive a new session entitlement",
      );
    }
    const input = sessionEntitlementInput(req.body as Record<string, unknown>);
    const [created] = await db
      .insert(sponsorSessionsTable)
      .values({ sponsorId, ...input })
      .returning();
    await refreshSessionTasks(sponsorId, true);
    await db.insert(sponsorActivityTable).values({
      sponsorId,
      type: "session_entitlement_added",
      actorType: "admin",
      data: {
        sessionId: created.id,
        type: created.type,
        entitlementLabel: created.entitlementLabel,
      },
    });
    await sendSponsorInternalNotification({
      sponsorId,
      category: "content",
      event: "Sponsor session entitlement added",
      summary: `${created.entitlementLabel} was added to the sponsor workspace.`,
    });
    res.status(201).json(await buildSponsorWorkspace(sponsorId, true));
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.patch(
  "/admin/sponsors/:sponsorId/sessions/:sessionId/entitlement",
  async (req, res): Promise<void> => {
    const sponsorId = idParam(req.params.sponsorId);
    const sessionId = idParam(req.params.sessionId);
    if (!sponsorId || !sessionId) {
      res.status(400).json({ error: "Invalid sponsor session" });
      return;
    }
    try {
      const [existing] = await db
        .select()
        .from(sponsorSessionsTable)
        .where(
          and(
            eq(sponsorSessionsTable.id, sessionId),
            eq(sponsorSessionsTable.sponsorId, sponsorId),
          ),
        );
      if (!existing) throw new SponsorNotFoundError();
      const input = sessionEntitlementInput(req.body as Record<string, unknown>);
      const changed =
        existing.type !== input.type ||
        existing.entitlementLabel !== input.entitlementLabel ||
        existing.headshotRequired !== input.headshotRequired ||
        existing.takeawaysRequired !== input.takeawaysRequired ||
        existing.slidesRequired !== input.slidesRequired;
      if (changed) {
        const nextRevision = existing.currentRevision > 0 ? existing.currentRevision + 1 : 0;
        const nextStatus = ["approved", "exported"].includes(existing.status)
          ? "submitted"
          : existing.status;
        const presenters = await db
          .select()
          .from(sponsorPresentersTable)
          .where(eq(sponsorPresentersTable.sessionId, sessionId));
        await db.transaction(async (tx) => {
          await tx
            .update(sponsorSessionsTable)
            .set({
              ...input,
              status: nextStatus as (typeof sponsorSessionsTable.$inferInsert)["status"],
              currentRevision: nextRevision,
              approvedAt: nextStatus === "submitted" ? null : existing.approvedAt,
              updatedAt: new Date(),
            })
            .where(eq(sponsorSessionsTable.id, sessionId));
          if (nextRevision > existing.currentRevision) {
            await tx.insert(sponsorSessionRevisionsTable).values({
              sessionId,
              revision: nextRevision,
              actor: "admin_entitlement",
              snapshot: {
                ...input,
                title: existing.title,
                description: existing.description,
                takeaways: existing.takeaways,
                presenters: presenters.map(
                  ({ name, jobTitle, company, biography, displayOrder }) => ({
                    name,
                    jobTitle,
                    company,
                    biography,
                    displayOrder,
                  }),
                ),
              },
            });
          }
          await tx.insert(sponsorActivityTable).values({
            sponsorId,
            type: "session_entitlement_updated",
            actorType: "admin",
            data: {
              sessionId,
              previousRevision: existing.currentRevision,
              currentRevision: nextRevision,
            },
          });
        });
        await refreshSessionTasks(sponsorId, false);
        await sendSponsorInternalNotification({
          sponsorId,
          category: "content",
          event: "Sponsor session entitlement updated",
          summary: `${input.entitlementLabel} requirements were updated.`,
        });
      }
      res.json(await buildSponsorWorkspace(sponsorId, true));
    } catch (error) {
      sendRouteError(res, error);
    }
  },
);

router.patch(
  "/admin/sponsors/:sponsorId/sessions/:sessionId/review",
  async (req, res): Promise<void> => {
    const sponsorId = idParam(req.params.sponsorId);
    const sessionId = idParam(req.params.sessionId);
    const status = String(req.body.status ?? "");
    const feedback =
      typeof req.body.feedback === "string" ? req.body.feedback.trim().slice(0, 5000) : null;
    if (!sponsorId || !sessionId || !["changes_requested", "approved"].includes(status)) {
      res.status(400).json({ error: "Choose Approve or Changes requested" });
      return;
    }
    if (status === "changes_requested" && !feedback) {
      res.status(400).json({ error: "Explain the changes needed" });
      return;
    }
    const [session] = await db
      .select()
      .from(sponsorSessionsTable)
      .where(
        and(eq(sponsorSessionsTable.id, sessionId), eq(sponsorSessionsTable.sponsorId, sponsorId)),
      );
    if (!session || !["submitted", "changes_requested"].includes(session.status)) {
      res.status(409).json({ error: "Only a submitted session can be reviewed" });
      return;
    }
    const [updated] = await db
      .update(sponsorSessionsTable)
      .set({
        status: status as "changes_requested" | "approved",
        feedback,
        approvedAt: status === "approved" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(sponsorSessionsTable.id, sessionId))
      .returning();
    const allSessions = await db
      .select({ status: sponsorSessionsTable.status })
      .from(sponsorSessionsTable)
      .where(eq(sponsorSessionsTable.sponsorId, sponsorId));
    const contentComplete =
      status === "approved" &&
      allSessions.every((item) => ["approved", "exported"].includes(item.status));
    await db
      .update(sponsorTasksTable)
      .set({
        status: contentComplete ? "completed" : "submitted",
        completedAt: contentComplete ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sponsorTasksTable.sponsorId, sponsorId),
          inArray(sponsorTasksTable.taskKey, ["sessions", "speakers"]),
        ),
      );
    await db.insert(sponsorActivityTable).values({
      sponsorId,
      type: status === "approved" ? "session_approved" : "session_changes_requested",
      actorType: "admin",
      data: { sessionId, revision: session.currentRevision, feedback },
    });
    await sendSponsorInternalNotification({
      sponsorId,
      category: "content",
      event:
        status === "approved" ? "Sponsor session approved" : "Sponsor session changes requested",
      summary: `${session.entitlementLabel} revision ${session.currentRevision} was ${status === "approved" ? "approved" : "returned with feedback"}.`,
    });
    res.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      approvedAt: updated.approvedAt?.toISOString() ?? null,
    });
  },
);

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

router.get("/admin/sponsors/:sponsorId/sessions/export.csv", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  const sessions = await db
    .select()
    .from(sponsorSessionsTable)
    .where(
      and(
        eq(sponsorSessionsTable.sponsorId, sponsorId),
        inArray(sponsorSessionsTable.status, ["approved", "exported"]),
      ),
    )
    .orderBy(asc(sponsorSessionsTable.id));
  if (!sessions.length) {
    res.status(409).json({ error: "There are no approved sessions to export" });
    return;
  }
  const rows: string[] = [];
  for (const session of sessions) {
    const presenters = await db
      .select()
      .from(sponsorPresentersTable)
      .where(eq(sponsorPresentersTable.sessionId, session.id))
      .orderBy(asc(sponsorPresentersTable.displayOrder));
    rows.push(
      [
        session.id,
        session.type,
        session.entitlementLabel,
        session.title,
        session.description,
        session.takeaways.join(" | "),
        presenters.map((p) => p.name).join(" | "),
        presenters.map((p) => p.jobTitle).join(" | "),
        presenters.map((p) => p.company).join(" | "),
        session.currentRevision,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const header = [
    "session_id",
    "type",
    "entitlement",
    "title",
    "description",
    "takeaways",
    "presenter_names",
    "presenter_job_titles",
    "presenter_companies",
    "revision",
  ];
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const session of sessions) {
      await tx
        .update(sponsorSessionsTable)
        .set({
          status: "exported",
          exportedAt: now,
          exportedRevision: session.currentRevision,
          updatedAt: now,
        })
        .where(eq(sponsorSessionsTable.id, session.id));
      await tx.insert(sponsorActivityTable).values({
        sponsorId,
        type: "session_exported",
        actorType: "admin",
        data: { sessionId: session.id, revision: session.currentRevision },
      });
    }
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="sponsor-${sponsorId}-sessions.csv"`);
  res.send(`${header.map(csvCell).join(",")}\r\n${rows.join("\r\n")}\r\n`);
});

router.get("/admin/sponsors/:sponsorId/assets", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  const conditions = [eq(sponsorAssetsTable.sponsorId, sponsorId)];
  if (
    typeof req.query.category === "string" &&
    ASSET_CATEGORIES.includes(req.query.category as never)
  ) {
    conditions.push(eq(sponsorAssetsTable.category, req.query.category as never));
  }
  if (
    typeof req.query.status === "string" &&
    ["active", "archived", "missing"].includes(req.query.status)
  ) {
    conditions.push(eq(sponsorAssetsTable.status, req.query.status as never));
  }
  let assets = await db
    .select()
    .from(sponsorAssetsTable)
    .where(and(...conditions))
    .orderBy(desc(sponsorAssetsTable.createdAt));
  if (req.query.verify === "true") {
    await preflightSponsorAssets(assets.filter((asset) => asset.status === "active"));
    assets = await db
      .select()
      .from(sponsorAssetsTable)
      .where(and(...conditions))
      .orderBy(desc(sponsorAssetsTable.createdAt));
  }
  res.json({ assets: assets.map((asset) => formatSponsorAsset(asset)) });
});

router.post(
  "/admin/sponsors/:sponsorId/assets",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const sponsorId = idParam(req.params.sponsorId);
    const category = String(req.body.category ?? "");
    if (!sponsorId || !req.file || !ASSET_CATEGORIES.includes(category as never)) {
      res.status(400).json({ error: "Sponsor, category and file are required" });
      return;
    }
    try {
      const asset = await createSponsorAsset({
        sponsorId,
        category: category as (typeof ASSET_CATEGORIES)[number],
        file: req.file,
        sessionId: req.body.sessionId ? Number(req.body.sessionId) : null,
        presenterId: req.body.presenterId ? Number(req.body.presenterId) : null,
        uploaderType: "admin",
      });
      if (asset.category === "logistics" && typeof req.body.documentTitle === "string") {
        await db.insert(sponsorDocumentsTable).values({
          sponsorId,
          assetId: asset.id,
          title: req.body.documentTitle.trim() || asset.originalName,
          required: req.body.required !== "false",
          acknowledgementVersion: asset.version,
        });
      }
      await sendSponsorInternalNotification({
        sponsorId,
        category: "content",
        event: "Sponsor asset uploaded by admin",
        summary: `${asset.originalName} was uploaded as ${asset.category}.`,
      });
      res.status(201).json(formatSponsorAsset(asset));
    } catch (error) {
      if (error instanceof SponsorStorageError) {
        await recordSponsorStorageFailure({
          sponsorId,
          operation: "admin_upload",
          error,
          actorType: "admin",
        }).catch((attentionError) =>
          logger.error({ attentionError, sponsorId }, "Could not record App Storage failure"),
        );
      }
      sendRouteError(res, error);
    }
  },
);

router.post(
  "/admin/sponsors/:sponsorId/assets/:assetId/replace",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const sponsorId = idParam(req.params.sponsorId);
    const assetId = assetIdParam(req.params.assetId);
    if (!sponsorId || !req.file) {
      res.status(400).json({ error: "Sponsor and replacement file are required" });
      return;
    }
    const [existing] = await db
      .select()
      .from(sponsorAssetsTable)
      .where(and(eq(sponsorAssetsTable.id, assetId), eq(sponsorAssetsTable.sponsorId, sponsorId)));
    if (!existing) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    try {
      const replacement = await createSponsorAsset({
        sponsorId,
        category: existing.category,
        file: req.file,
        uploaderType: "admin",
        replaces: existing,
      });
      await sendSponsorInternalNotification({
        sponsorId,
        category: "content",
        event: "Sponsor asset replaced",
        summary: `${existing.originalName} was replaced by version ${replacement.version}. Any logistics acknowledgement was reset.`,
      });
      res.status(201).json(formatSponsorAsset(replacement));
    } catch (error) {
      if (error instanceof SponsorStorageError) {
        await recordSponsorStorageFailure({
          sponsorId,
          operation: "admin_replace",
          error,
          actorType: "admin",
        }).catch((attentionError) =>
          logger.error({ attentionError, sponsorId }, "Could not record App Storage failure"),
        );
      }
      sendRouteError(res, error);
    }
  },
);

router.patch("/admin/sponsors/:sponsorId/assets/:assetId", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  const assetId = assetIdParam(req.params.assetId);
  const status = String(req.body.status ?? "");
  if (!sponsorId || !["active", "archived"].includes(status)) {
    res.status(400).json({ error: "Choose active or archived" });
    return;
  }
  const [existing] = await db
    .select()
    .from(sponsorAssetsTable)
    .where(and(eq(sponsorAssetsTable.id, assetId), eq(sponsorAssetsTable.sponsorId, sponsorId)));
  if (!existing) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  if (status === "active") {
    const missing = await preflightSponsorAssets([existing]);
    if (missing.length) {
      res.status(409).json({
        error: "This version cannot be restored because its App Storage object is missing",
      });
      return;
    }
  }
  const [updated] = await db
    .update(sponsorAssetsTable)
    .set({
      status: status as "active" | "archived",
      archivedAt: status === "archived" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(sponsorAssetsTable.id, assetId))
    .returning();
  await db.insert(sponsorActivityTable).values({
    sponsorId,
    type: status === "archived" ? "asset_archived" : "asset_restored",
    actorType: "admin",
    data: { assetId },
  });
  await sendSponsorInternalNotification({
    sponsorId,
    category: "content",
    event: status === "archived" ? "Sponsor asset archived" : "Sponsor asset restored",
    summary: `${existing.originalName} version ${existing.version} was ${status}.`,
  });
  res.json(formatSponsorAsset(updated));
});

router.get(
  "/admin/sponsors/:sponsorId/assets/:assetId/download",
  async (req, res): Promise<void> => {
    const sponsorId = idParam(req.params.sponsorId);
    const assetId = assetIdParam(req.params.assetId);
    if (!sponsorId) {
      res.status(400).json({ error: "Invalid sponsor" });
      return;
    }
    const [asset] = await db
      .select()
      .from(sponsorAssetsTable)
      .where(and(eq(sponsorAssetsTable.id, assetId), eq(sponsorAssetsTable.sponsorId, sponsorId)));
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    const missing = await preflightSponsorAssets([asset]);
    if (missing.length) {
      res
        .status(409)
        .json({ error: "This file is missing from App Storage and is now in Needs attention" });
      return;
    }
    const preview = req.query.preview === "true" && isSafeRasterPreview(asset.mimeType);
    res.setHeader("Content-Type", preview ? asset.mimeType : "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `${preview ? "inline" : "attachment"}; filename="${safeDownloadFilename(asset.originalName)}"`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    await db.insert(sponsorActivityTable).values({
      sponsorId,
      type: preview ? "asset_previewed" : "asset_downloaded",
      actorType: "admin",
      data: { assetId },
    });
    getSponsorObjectStorage()
      .stream(asset.storageKey)
      .on("error", (error) => res.destroy(error))
      .pipe(res);
  },
);

async function logZipDownload(
  sponsorIds: number[],
  type: string,
  assetCount: number,
): Promise<void> {
  if (!sponsorIds.length) return;
  await db.insert(sponsorActivityTable).values(
    sponsorIds.map((sponsorId) => ({
      sponsorId,
      type,
      actorType: "admin",
      data: { assetCount },
    })),
  );
}

router.post("/admin/sponsors/:sponsorId/assets/download.zip", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  const ids: string[] = Array.isArray(req.body.assetIds)
    ? [
        ...new Set<string>(
          (req.body.assetIds as unknown[]).map((value) => String(value)).filter(Boolean),
        ),
      ]
    : [];
  if (!sponsorId || !ids.length) {
    res.status(400).json({ error: "Select at least one file" });
    return;
  }
  const assets = await activeSponsorAssets(sponsorId, ids);
  if (assets.length !== ids.length) {
    res
      .status(409)
      .json({ error: "One or more selected files are archived, missing or from another sponsor" });
    return;
  }
  const started = await streamSponsorAssetsZip(res, assets, `sponsor-${sponsorId}-selected.zip`);
  if (started) await logZipDownload([sponsorId], "assets_zip_downloaded", assets.length);
});

router.get("/admin/sponsors/:sponsorId/assets/complete.zip", async (req, res): Promise<void> => {
  const sponsorId = idParam(req.params.sponsorId);
  if (!sponsorId) {
    res.status(400).json({ error: "Invalid sponsor" });
    return;
  }
  const [sponsor] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
  if (!sponsor) {
    res.status(404).json({ error: "Sponsor not found" });
    return;
  }
  const assets = await activeSponsorAssets(sponsorId);
  const started = await streamSponsorAssetsZip(
    res,
    assets,
    `${safeDownloadFilename(sponsor.company)}-sponsor-assets.zip`,
  );
  if (started) await logZipDownload([sponsorId], "complete_folder_downloaded", assets.length);
});

router.get("/admin/sponsor-assets", async (req, res): Promise<void> => {
  const conditions = [];
  if (req.query.sponsorId) {
    const sponsorId = Number(req.query.sponsorId);
    if (Number.isInteger(sponsorId)) conditions.push(eq(sponsorAssetsTable.sponsorId, sponsorId));
  }
  if (
    typeof req.query.category === "string" &&
    ASSET_CATEGORIES.includes(req.query.category as never)
  ) {
    conditions.push(eq(sponsorAssetsTable.category, req.query.category as never));
  }
  if (
    typeof req.query.status === "string" &&
    ["active", "archived", "missing"].includes(req.query.status)
  ) {
    conditions.push(eq(sponsorAssetsTable.status, req.query.status as never));
  }
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    conditions.push(ilike(sponsorAssetsTable.originalName, `%${req.query.search.trim()}%`));
  }
  if (typeof req.query.from === "string")
    conditions.push(gte(sponsorAssetsTable.createdAt, new Date(req.query.from)));
  if (typeof req.query.to === "string") {
    const to = new Date(req.query.to);
    to.setDate(to.getDate() + 1);
    conditions.push(lte(sponsorAssetsTable.createdAt, to));
  }
  let rows = await db
    .select({ asset: sponsorAssetsTable, company: sponsorsTable.company })
    .from(sponsorAssetsTable)
    .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorAssetsTable.sponsorId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sponsorAssetsTable.createdAt));
  if (req.query.verify === "true") {
    await preflightSponsorAssets(
      rows.map((row) => row.asset).filter((asset) => asset.status === "active"),
    );
    rows = await db
      .select({ asset: sponsorAssetsTable, company: sponsorsTable.company })
      .from(sponsorAssetsTable)
      .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorAssetsTable.sponsorId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(sponsorAssetsTable.createdAt));
  }
  res.json({ assets: rows.map((row) => formatSponsorAsset(row.asset, row.company)) });
});

router.post("/admin/sponsor-assets/backup-plan", async (req, res): Promise<void> => {
  const requested = Number(req.body.maxBytesPerZip ?? 500 * 1024 * 1024);
  const maxBytes = Number.isFinite(requested)
    ? Math.max(10 * 1024 * 1024, Math.min(requested, 1024 * 1024 * 1024))
    : 500 * 1024 * 1024;
  const assets = await db
    .select()
    .from(sponsorAssetsTable)
    .where(eq(sponsorAssetsTable.status, "active"))
    .orderBy(asc(sponsorAssetsTable.sponsorId), asc(sponsorAssetsTable.createdAt));
  const batches: Array<{ sponsorIds: number[]; assetIds: string[]; byteSize: number }> = [];
  let current = { sponsorIds: [] as number[], assetIds: [] as string[], byteSize: 0 };
  for (const asset of assets) {
    if (current.assetIds.length && current.byteSize + asset.byteSize > maxBytes) {
      batches.push(current);
      current = { sponsorIds: [], assetIds: [], byteSize: 0 };
    }
    if (!current.sponsorIds.includes(asset.sponsorId)) current.sponsorIds.push(asset.sponsorId);
    current.assetIds.push(asset.id);
    current.byteSize += asset.byteSize;
  }
  if (current.assetIds.length) batches.push(current);
  res.json({ maxBytesPerZip: maxBytes, batches });
});

router.post("/admin/sponsor-assets/backup.zip", async (req, res): Promise<void> => {
  const assetIds: string[] = Array.isArray(req.body.assetIds)
    ? [
        ...new Set<string>(
          (req.body.assetIds as unknown[]).map((value) => String(value)).filter(Boolean),
        ),
      ]
    : [];
  if (!assetIds.length) {
    res.status(400).json({ error: "Choose a backup batch first" });
    return;
  }
  const assets = await db
    .select()
    .from(sponsorAssetsTable)
    .where(and(inArray(sponsorAssetsTable.id, assetIds), eq(sponsorAssetsTable.status, "active")))
    .orderBy(asc(sponsorAssetsTable.sponsorId), asc(sponsorAssetsTable.createdAt));
  if (assets.length !== assetIds.length) {
    res.status(409).json({ error: "One or more backup files changed; refresh the backup plan" });
    return;
  }
  const sponsorIds = [...new Set(assets.map((asset) => asset.sponsorId))];
  const started = await streamSponsorAssetsZip(
    res,
    assets,
    `swp-sponsor-backup-${new Date().toISOString().slice(0, 10)}.zip`,
  );
  if (started) await logZipDownload(sponsorIds, "backup_zip_downloaded", assets.length);
});

export default router;
