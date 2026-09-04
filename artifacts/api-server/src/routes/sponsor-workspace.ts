import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import {
  attendeesTable,
  bookingsTable,
  db,
  sponsorActivityTable,
  sponsorAssetsTable,
  sponsorDocumentAcknowledgementsTable,
  sponsorDocumentsTable,
  sponsorSessionsTable,
  sponsorsTable,
  sponsorTasksTable,
} from "@workspace/db";
import {
  clearSponsorSessionCookies,
  setSponsorSessionCookie,
  sponsorAuth,
  type SponsorRequest,
  verifySponsorAccessToken,
} from "../middleware/sponsor-auth";
import { buildSponsorWorkspace, SponsorConflictError } from "../lib/sponsor-service";
import { requestAdditionalPasses } from "../lib/sponsor-pass-requests";
import {
  saveSessionDraft,
  sessionSubmissionErrors,
  type SessionBody,
} from "../lib/sponsor-session-draft";
import {
  createSponsorAsset,
  formatSponsorAsset,
  preflightSponsorAssets,
  recordSponsorStorageFailure,
  safeDownloadFilename,
  SponsorAssetValidationError,
  SPONSOR_DOCUMENT_MAX_BYTES,
} from "../lib/sponsor-assets";
import { getSponsorObjectStorage, SponsorStorageError } from "../lib/sponsor-storage";
import { sendSponsorInternalNotification, sendSponsorStaffWelcome } from "../lib/sponsor-email";
import { defaultOrderRef } from "../lib/order-reference";
import { syncBookingToSheets } from "../lib/google-sheets";
import { logger } from "../lib/logger";
import {
  completePreparationTask,
  reopenStaffPreparationTasks,
  saveOnsiteContact,
  SponsorPortalError,
} from "../lib/sponsor-portal";

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SPONSOR_DOCUMENT_MAX_BYTES, files: 1, fields: 10 },
});
const ACTIVE_BOOKING_STATUSES = ["paid", "invoiced"] as const;
const ASSET_CATEGORIES = [
  "logo",
  "headshot",
  "slides",
  "session_material",
  "logistics",
  "other",
] as const;

function idParam(value: string | string[] | undefined): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sponsorReq(req: Request): SponsorRequest {
  return req as SponsorRequest;
}

function csrfTokenFromCookie(req: Request): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const item of cookie.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === "swp_sponsor_csrf") return decodeURIComponent(rest.join("="));
  }
  return null;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof SponsorConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof SponsorPortalError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof SponsorAssetValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof SponsorStorageError) {
    res.status(503).json({
      error: "App Storage is temporarily unavailable. Your file was not marked complete.",
    });
    return;
  }
  const code = (error as { code?: string }).code;
  if (code === "23505" || code === "DUPLICATE_EMAIL") {
    res.status(409).json({ error: "That active work email is already registered" });
    return;
  }
  logger.error({ error }, "Sponsor workspace request failed");
  res.status(500).json({ error: "The sponsor workspace request could not be completed" });
}

router.post("/sponsor/access/:token", async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const decoded = verifySponsorAccessToken(token);
  if (!decoded) {
    res.status(401).json({ error: "This sponsor link is invalid or has been replaced" });
    return;
  }
  const [sponsor] = await db
    .select()
    .from(sponsorsTable)
    .where(eq(sponsorsTable.id, decoded.sponsorId));
  if (
    !sponsor ||
    sponsor.portalAccessVersion !== decoded.accessVersion ||
    !["confirmed", "completed"].includes(sponsor.status)
  ) {
    res.status(401).json({ error: "This sponsor link is invalid, paused or has been replaced" });
    return;
  }
  setSponsorSessionCookie(res, sponsor.id, sponsor.portalAccessVersion);
  await db.insert(sponsorActivityTable).values({
    sponsorId: sponsor.id,
    type: "access_exchanged",
    actorType: "sponsor",
    data: {},
  });
  res.status(204).end();
});

router.use("/sponsor", sponsorAuth);

router.post("/sponsor/logout", (req, res): void => {
  clearSponsorSessionCookies(res);
  res.status(204).end();
});

router.get("/sponsor/workspace", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  await db.insert(sponsorActivityTable).values({
    sponsorId,
    type: "portal_viewed",
    actorType: "sponsor",
    data: {},
  });
  const workspace = await buildSponsorWorkspace(sponsorId, false);
  res.json({ ...workspace, csrfToken: csrfTokenFromCookie(req) });
});

router.put("/sponsor/onsite-contact", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  try {
    const contact = await saveOnsiteContact(sponsorId, req.body ?? {});
    await sendSponsorInternalNotification({
      sponsorId,
      category: "admin",
      event: "Onsite contact confirmed",
      summary: "The sponsor updated their event-day contact details.",
    });
    res.json(contact);
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/sponsor/tasks/:taskKey/complete", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  try {
    const key = String(req.params.taskKey);
    const result = await completePreparationTask(sponsorId, key);
    if (result.changed)
      await sendSponsorInternalNotification({
        sponsorId,
        category: "passes",
        event: key === "staff" ? "Sponsor team confirmed" : "Community Social details confirmed",
        summary: "The sponsor reviewed and confirmed their current team details.",
      });
    res.json(result.task);
  } catch (error) {
    handleError(res, error);
  }
});

interface StaffBody {
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  company?: string;
  workEmail?: string;
  phone?: string | null;
  dietaryAccessibility?: string | null;
  communitySocialAttending?: boolean | null;
  communitySocialDietary?: string | null;
  marketingConsent?: boolean;
}

function validateStaff(body: StaffBody) {
  const required = ["firstName", "lastName", "jobTitle", "company", "workEmail"] as const;
  for (const field of required) {
    if (!body[field]?.trim()) throw new Error(`${field} is required`);
  }
  const email = body.workEmail!.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Enter a valid work email address");
  return {
    firstName: body.firstName!.trim(),
    lastName: body.lastName!.trim(),
    jobTitle: body.jobTitle!.trim(),
    company: body.company!.trim(),
    workEmail: email,
    phone: body.phone?.trim() || null,
    dietaryAccessibility: body.dietaryAccessibility?.trim() || null,
    communitySocialAttending: body.communitySocialAttending ?? null,
    communitySocialDietary: body.communitySocialDietary?.trim() || null,
    gdprConsent: body.marketingConsent === true,
    gdprConsentAt: body.marketingConsent === true ? new Date() : null,
  };
}

async function emailAlreadyActive(
  normalisedEmail: string,
  excludeBookingId?: number,
): Promise<boolean> {
  const conditions = [
    sql`lower(${attendeesTable.workEmail}) = ${normalisedEmail}`,
    inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
  ];
  if (excludeBookingId) conditions.push(ne(bookingsTable.id, excludeBookingId));
  const [match] = await db
    .select({ id: attendeesTable.id })
    .from(attendeesTable)
    .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
    .where(and(...conditions))
    .limit(1);
  return Boolean(match);
}

type SponsorTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockAndAssertEmailAvailable(
  tx: SponsorTransaction,
  normalisedEmail: string,
  excludeBookingId?: number,
): Promise<void> {
  // A transaction-scoped advisory lock closes the race between two sponsor
  // portal requests that submit the same normalised email at the same time.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${normalisedEmail}))`);
  const conditions = [
    sql`lower(${attendeesTable.workEmail}) = ${normalisedEmail}`,
    inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
  ];
  if (excludeBookingId) conditions.push(ne(bookingsTable.id, excludeBookingId));
  const [duplicate] = await tx
    .select({ id: attendeesTable.id })
    .from(attendeesTable)
    .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
    .where(and(...conditions))
    .limit(1);
  if (duplicate) {
    throw Object.assign(new Error("That work email already has an active registration"), {
      code: "DUPLICATE_EMAIL",
    });
  }
}

router.post("/sponsor/staff", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  let staff;
  try {
    staff = validateStaff(req.body as StaffBody);
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : "Invalid staff details" });
    return;
  }
  try {
    if (await emailAlreadyActive(staff.workEmail)) {
      res.status(409).json({ error: "That work email already has an active registration" });
      return;
    }
    const created = await db.transaction(async (tx) => {
      await lockAndAssertEmailAvailable(tx, staff.workEmail);
      await tx.execute(sql`SELECT id FROM sponsors WHERE id = ${sponsorId} FOR UPDATE`);
      const [sponsor] = await tx
        .select()
        .from(sponsorsTable)
        .where(eq(sponsorsTable.id, sponsorId));
      if (!sponsor) throw new Error("Sponsor not found");
      const [usage] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(bookingsTable)
        .where(
          and(
            eq(bookingsTable.sponsorId, sponsorId),
            eq(bookingsTable.registrationSource, "sponsor_staff"),
            inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
          ),
        );
      if ((usage?.count ?? 0) >= sponsor.staffAllocation) {
        throw Object.assign(new Error("All sponsor staff places have been used"), {
          code: "ALLOCATION_FULL",
        });
      }
      const [booking] = await tx
        .insert(bookingsTable)
        .values({
          sessionToken: `sponsor-staff-${uuidv4()}`,
          status: "paid",
          passType: "business",
          attendeeType: "consultant_vendor",
          quantity: 1,
          subtotalAmount: "0",
          vatAmount: "0",
          totalAmount: "0",
          manualEntry: false,
          registrationSource: "sponsor_staff",
          sponsorId,
          currentStep: 5,
          billingCompany: sponsor.company,
          managementToken: uuidv4(),
          paidAt: new Date(),
        })
        .returning();
      await tx
        .update(bookingsTable)
        .set({ orderReference: defaultOrderRef(booking.id) })
        .where(eq(bookingsTable.id, booking.id));
      const [attendee] = await tx
        .insert(attendeesTable)
        .values({
          bookingId: booking.id,
          isLead: true,
          seatIndex: 0,
          ...staff,
        })
        .returning();
      await tx.insert(sponsorActivityTable).values({
        sponsorId,
        type: "staff_registered",
        actorType: "sponsor",
        actorLabel: `${staff.firstName} ${staff.lastName}`,
        data: { bookingId: booking.id, attendeeId: attendee.id },
      });
      await reopenStaffPreparationTasks(tx, sponsorId);
      return { booking, attendee, sponsor };
    });

    const welcomeSent = await sendSponsorStaffWelcome(
      sponsorId,
      created.booking.id,
      created.attendee.id,
    );
    const organiserNotified = await sendSponsorInternalNotification({
      sponsorId,
      category: "passes",
      event: "Sponsor staff registered",
      summary: `${staff.firstName} ${staff.lastName}, ${staff.jobTitle} at ${staff.company}, has been registered.`,
    });
    let sheetsSynced = false;
    try {
      await syncBookingToSheets(created.booking.id);
      sheetsSynced = true;
    } catch (error) {
      logger.error({ error, bookingId: created.booking.id }, "Sponsor staff sheet sync failed");
    }
    await db
      .update(bookingsTable)
      .set({
        confirmationEmailSent: welcomeSent,
        welcomeEmailsSent: welcomeSent,
        organiserNotified,
        sheetsSynced,
      })
      .where(eq(bookingsTable.id, created.booking.id));
    const workspace = await buildSponsorWorkspace(sponsorId, false);
    res.status(201).json(workspace.staff.find((item) => item.bookingId === created.booking.id));
  } catch (error) {
    if ((error as { code?: string }).code === "ALLOCATION_FULL") {
      res
        .status(409)
        .json({ error: "All sponsor staff places have been used. Request more passes if needed." });
      return;
    }
    handleError(res, error);
  }
});

router.patch("/sponsor/staff/:bookingId", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  const bookingId = idParam(req.params.bookingId);
  if (!bookingId) {
    res.status(400).json({ error: "Invalid staff registration" });
    return;
  }
  let staff;
  try {
    staff = validateStaff(req.body as StaffBody);
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : "Invalid staff details" });
    return;
  }
  const [existing] = await db
    .select({ booking: bookingsTable, attendee: attendeesTable })
    .from(bookingsTable)
    .innerJoin(attendeesTable, eq(attendeesTable.bookingId, bookingsTable.id))
    .where(
      and(
        eq(bookingsTable.id, bookingId),
        eq(bookingsTable.sponsorId, sponsorId),
        eq(bookingsTable.registrationSource, "sponsor_staff"),
      ),
    );
  if (!existing || !ACTIVE_BOOKING_STATUSES.includes(existing.booking.status as never)) {
    res.status(404).json({ error: "Active sponsor staff registration not found" });
    return;
  }
  if (await emailAlreadyActive(staff.workEmail, bookingId)) {
    res.status(409).json({ error: "That work email already has an active registration" });
    return;
  }
  await db.transaction(async (tx) => {
    await lockAndAssertEmailAvailable(tx, staff.workEmail, bookingId);
    await tx
      .update(attendeesTable)
      .set({
        ...staff,
        ...(existing.attendee.workEmail.toLowerCase() !== staff.workEmail
          ? { leadSharingNoticeAt: null }
          : {}),
      })
      .where(eq(attendeesTable.id, existing.attendee.id));
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type:
        existing.attendee.workEmail.toLowerCase() === staff.workEmail
          ? "staff_updated"
          : "staff_replaced",
      actorType: "sponsor",
      actorLabel: `${staff.firstName} ${staff.lastName}`,
      data: { bookingId, attendeeId: existing.attendee.id },
    });
    await reopenStaffPreparationTasks(tx, sponsorId);
  });
  if (existing.attendee.workEmail.toLowerCase() !== staff.workEmail) {
    const sent = await sendSponsorStaffWelcome(sponsorId, bookingId, existing.attendee.id);
    await db
      .update(bookingsTable)
      .set({ welcomeEmailsSent: sent })
      .where(eq(bookingsTable.id, bookingId));
  }
  await sendSponsorInternalNotification({
    sponsorId,
    category: "passes",
    event:
      existing.attendee.workEmail.toLowerCase() === staff.workEmail
        ? "Sponsor staff updated"
        : "Sponsor staff replaced",
    summary: `${staff.firstName} ${staff.lastName}'s sponsor staff details were saved.`,
  });
  const workspace = await buildSponsorWorkspace(sponsorId, false);
  res.json(workspace.staff.find((item) => item.bookingId === bookingId));
});

router.delete("/sponsor/staff/:bookingId", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  const bookingId = idParam(req.params.bookingId);
  if (!bookingId) {
    res.status(400).json({ error: "Invalid staff registration" });
    return;
  }
  const cancelled = await db.transaction(async (tx) => {
    await tx
      .select({ id: sponsorsTable.id })
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId))
      .for("update");
    const [cancelled] = await tx
      .update(bookingsTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(bookingsTable.id, bookingId),
          eq(bookingsTable.sponsorId, sponsorId),
          eq(bookingsTable.registrationSource, "sponsor_staff"),
          inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
        ),
      )
      .returning();
    if (!cancelled) return null;
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: "staff_cancelled",
      actorType: "sponsor",
      data: { bookingId },
    });
    await reopenStaffPreparationTasks(tx, sponsorId);
    return cancelled;
  });
  if (!cancelled) {
    res.status(404).json({ error: "Active sponsor staff registration not found" });
    return;
  }
  await sendSponsorInternalNotification({
    sponsorId,
    category: "passes",
    event: "Sponsor staff cancelled",
    summary: `Sponsor staff booking ${cancelled.orderReference ?? `#${bookingId}`} was cancelled and the place was restored.`,
  });
  res.status(204).end();
});

router.post("/sponsor/pass-requests", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  try {
    const result = await requestAdditionalPasses(sponsorId, {
      requestedVip: Number(req.body.requestedVip ?? 0),
      requestedStaff: Number(req.body.requestedStaff ?? 0),
      message:
        typeof req.body.message === "string"
          ? req.body.message.trim().slice(0, 2000) || null
          : null,
    });
    if (result.created)
      await sendSponsorInternalNotification({
        sponsorId,
        category: "passes",
        event: "More passes requested",
        summary: `${result.request.requestedVip} extra VIP and ${result.request.requestedStaff} extra staff passes requested.`,
      });
    res.status(result.created ? 201 : 200).json(result.request);
  } catch (error) {
    handleError(res, error);
  }
});

router.patch("/sponsor/sessions/:sessionId", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId,
    sessionId = idParam(req.params.sessionId);
  if (!sessionId) {
    res.status(400).json({ error: "Invalid session" });
    return;
  }
  try {
    await db.transaction((tx) =>
      saveSessionDraft(tx, sponsorId, sessionId, (req.body ?? {}) as SessionBody),
    );
    // Saving a draft is intentionally quiet. Only explicit submission notifies reviewers.
    const workspace = await buildSponsorWorkspace(sponsorId, false);
    res.json(workspace.sessions.find((item) => item.id === sessionId));
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/sponsor/sessions/:sessionId/submit", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  const sessionId = idParam(req.params.sessionId);
  if (!sessionId) {
    res.status(400).json({ error: "Invalid session" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const visible = req.body ?? {};
      if (["title", "description", "takeaways", "presenters"].some((key) => key in visible)) {
        const saved = await saveSessionDraft(tx, sponsorId, sessionId, visible as SessionBody);
        // The rest of the transaction validates exactly this newly saved version.
        visible.expectedRevision = saved.nextRevision;
      }
      const [session] = await tx
        .select()
        .from(sponsorSessionsTable)
        .where(
          and(
            eq(sponsorSessionsTable.id, sessionId),
            eq(sponsorSessionsTable.sponsorId, sponsorId),
          ),
        )
        .for("update");
      if (!session) {
        throw new SponsorPortalError("Session entitlement not found", 404);
      }
      if (
        req.body?.expectedRevision !== undefined &&
        req.body.expectedRevision !== session.currentRevision
      ) {
        throw new SponsorPortalError(
          "This session was updated elsewhere. Refresh the saved version before submitting.",
          409,
        );
      }
      const errors = await sessionSubmissionErrors(sessionId, tx);
      if (errors.length) {
        throw new SponsorPortalError(errors.join(". "));
      }
      if (["submitted", "approved", "exported"].includes(session.status))
        return { updated: session, changed: false };
      const [updated] = await tx
        .update(sponsorSessionsTable)
        .set({
          status: "submitted",
          submittedAt: new Date(),
          feedback: null,
          updatedAt: new Date(),
        })
        .where(eq(sponsorSessionsTable.id, sessionId))
        .returning();
      await tx.insert(sponsorActivityTable).values({
        sponsorId,
        type: "session_submitted",
        actorType: "sponsor",
        data: { sessionId, revision: updated.currentRevision },
      });
      await tx
        .update(sponsorTasksTable)
        .set({ status: "submitted", completedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(sponsorTasksTable.sponsorId, sponsorId),
            inArray(sponsorTasksTable.taskKey, ["sessions", "speakers"]),
            eq(sponsorTasksTable.required, true),
          ),
        );
      return { updated, changed: true };
    });
    if (result.changed)
      await sendSponsorInternalNotification({
        sponsorId,
        category: "content",
        event: "Sponsor session submitted",
        summary: `${result.updated.entitlementLabel} revision ${result.updated.currentRevision} is ready for review.`,
      });
    const workspace = await buildSponsorWorkspace(sponsorId, false);
    res.json(workspace.sessions.find((item) => item.id === sessionId));
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/sponsor/assets", upload.single("file"), async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  if (!req.file) {
    res.status(400).json({ error: "Choose a file to upload" });
    return;
  }
  const category = String(req.body.category ?? "");
  if (!ASSET_CATEGORIES.includes(category as never)) {
    res.status(400).json({ error: "Choose a valid asset category" });
    return;
  }
  const sessionId = req.body.sessionId ? Number(req.body.sessionId) : null;
  const presenterId = req.body.presenterId ? Number(req.body.presenterId) : null;
  if (sessionId) {
    const [session] = await db
      .select({ id: sponsorSessionsTable.id })
      .from(sponsorSessionsTable)
      .where(
        and(eq(sponsorSessionsTable.id, sessionId), eq(sponsorSessionsTable.sponsorId, sponsorId)),
      );
    if (!session) {
      res.status(400).json({ error: "That session does not belong to this sponsor" });
      return;
    }
  }
  try {
    const asset = await createSponsorAsset({
      sponsorId,
      category: category as (typeof ASSET_CATEGORIES)[number],
      file: req.file,
      sessionId,
      presenterId,
      uploaderType: "sponsor",
    });
    await sendSponsorInternalNotification({
      sponsorId,
      category: "content",
      event: "Sponsor asset uploaded",
      summary: `${asset.originalName} was uploaded as ${asset.category}.`,
    });
    res.status(201).json(formatSponsorAsset(asset));
  } catch (error) {
    if (error instanceof SponsorStorageError) {
      await recordSponsorStorageFailure({
        sponsorId,
        operation: "sponsor_upload",
        error,
        actorType: "sponsor",
      }).catch((attentionError) =>
        logger.error({ attentionError, sponsorId }, "Could not record App Storage failure"),
      );
    }
    handleError(res, error);
  }
});

router.post(
  "/sponsor/assets/:assetId/replace",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
    const assetId = Array.isArray(req.params.assetId) ? req.params.assetId[0] : req.params.assetId;
    if (!req.file) {
      res.status(400).json({ error: "Choose a replacement file" });
      return;
    }
    const [existing] = await db
      .select()
      .from(sponsorAssetsTable)
      .where(
        and(
          eq(sponsorAssetsTable.id, assetId),
          eq(sponsorAssetsTable.sponsorId, sponsorId),
          eq(sponsorAssetsTable.status, "active"),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Active file version not found" });
      return;
    }
    try {
      const replacement = await createSponsorAsset({
        sponsorId,
        category: existing.category,
        file: req.file,
        uploaderType: "sponsor",
        replaces: existing,
      });
      await sendSponsorInternalNotification({
        sponsorId,
        category: "content",
        event: "Sponsor asset replaced",
        summary: `${existing.originalName} was replaced by version ${replacement.version}. Any required acknowledgement was reset.`,
      });
      res.status(201).json(formatSponsorAsset(replacement));
    } catch (error) {
      if (error instanceof SponsorStorageError) {
        await recordSponsorStorageFailure({
          sponsorId,
          operation: "sponsor_replace",
          error,
          actorType: "sponsor",
        }).catch((attentionError) =>
          logger.error({ attentionError, sponsorId }, "Could not record App Storage failure"),
        );
      }
      handleError(res, error);
    }
  },
);

router.get("/sponsor/assets/:assetId/download", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  const assetId = Array.isArray(req.params.assetId) ? req.params.assetId[0] : req.params.assetId;
  const [asset] = await db
    .select()
    .from(sponsorAssetsTable)
    .where(and(eq(sponsorAssetsTable.id, assetId), eq(sponsorAssetsTable.sponsorId, sponsorId)));
  if (!asset) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const missing = await preflightSponsorAssets([asset]);
  if (missing.length) {
    res.status(409).json({
      error:
        "This file is missing from App Storage. The event team has been notified in Needs attention.",
    });
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeDownloadFilename(asset.originalName)}"`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  await db.insert(sponsorActivityTable).values({
    sponsorId,
    type: "asset_downloaded",
    actorType: "sponsor",
    data: { assetId: asset.id },
  });
  getSponsorObjectStorage()
    .stream(asset.storageKey)
    .on("error", (error) => res.destroy(error))
    .pipe(res);
});

router.post("/sponsor/documents/:documentId/acknowledge", async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  const documentId = idParam(req.params.documentId);
  const acknowledgedBy = String(req.body.acknowledgedBy ?? "")
    .trim()
    .slice(0, 200);
  if (!documentId || acknowledgedBy.length < 2) {
    res.status(400).json({ error: "Enter the name of the person acknowledging this document" });
    return;
  }
  const [document] = await db
    .select()
    .from(sponsorDocumentsTable)
    .where(
      and(eq(sponsorDocumentsTable.id, documentId), eq(sponsorDocumentsTable.sponsorId, sponsorId)),
    );
  if (!document) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const inserted = await db
    .insert(sponsorDocumentAcknowledgementsTable)
    .values({
      documentId,
      version: document.acknowledgementVersion,
      acknowledgedBy,
    })
    .onConflictDoNothing()
    .returning();
  await db.insert(sponsorActivityTable).values({
    sponsorId,
    type: "document_acknowledged",
    actorType: "sponsor",
    actorLabel: acknowledgedBy,
    data: { documentId, version: document.acknowledgementVersion },
  });
  const requiredDocuments = await db
    .select()
    .from(sponsorDocumentsTable)
    .where(
      and(eq(sponsorDocumentsTable.sponsorId, sponsorId), eq(sponsorDocumentsTable.required, true)),
    );
  let allAcknowledged = requiredDocuments.length > 0;
  for (const requiredDocument of requiredDocuments) {
    const [acknowledgement] = await db
      .select({ id: sponsorDocumentAcknowledgementsTable.id })
      .from(sponsorDocumentAcknowledgementsTable)
      .where(
        and(
          eq(sponsorDocumentAcknowledgementsTable.documentId, requiredDocument.id),
          eq(sponsorDocumentAcknowledgementsTable.version, requiredDocument.acknowledgementVersion),
        ),
      );
    if (!acknowledgement) {
      allAcknowledged = false;
      break;
    }
  }
  if (allAcknowledged) {
    await db
      .update(sponsorTasksTable)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(sponsorTasksTable.sponsorId, sponsorId), eq(sponsorTasksTable.taskKey, "logistics")),
      );
  }
  await sendSponsorInternalNotification({
    sponsorId,
    category: "content",
    event: "Logistics document acknowledged",
    summary: `${document.title} version ${document.acknowledgementVersion} was acknowledged by ${acknowledgedBy}.`,
  });
  res.status(201).json(inserted[0] ?? { alreadyAcknowledged: true });
});

export default router;
