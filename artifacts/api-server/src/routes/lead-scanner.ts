import { randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { rateLimit } from "express-rate-limit";
import ExcelJS from "exceljs";
import { v4 as uuidv4 } from "uuid";
import {
  attendeeBadgesTable,
  attendeesTable,
  bookingsTable,
  db,
  sponsorLeadsTable,
  sponsorActivityTable,
  sponsorScannerDevicesTable,
  sponsorsTable,
} from "@workspace/db";
import { adminAuth } from "../middleware/admin-auth";
import { scannerAuth, scannerTokenHash, type ScannerRequest } from "../middleware/scanner-auth";
import { sponsorAuth, type SponsorRequest } from "../middleware/sponsor-auth";
import {
  addLeadAnnotation,
  badgeExportCsv,
  badgeExportRows,
  buildOfflineLeadPack,
  currentLeadPackVersion,
  ensureEligibleAttendeeBadges,
  generateBadgeCode,
  getScannerWindow,
  listLeadRows,
  MAX_SYNC_BATCH,
  SCANNER_TEST_CODE,
  scannerDeviceRateLimitKey,
  syncScannerBatch,
  type ScannerSyncAnnotation,
  type ScannerSyncScan,
} from "../lib/lead-scanner";
import { logAdminAction } from "../lib/audit";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const ACTIVE_BOOKING_STATUSES = ["paid", "invoiced"] as const;

function sponsorReq(req: Request): SponsorRequest {
  return req as SponsorRequest;
}

function scannerReq(req: Request): ScannerRequest {
  return req as ScannerRequest;
}

function idParam(value: string | string[] | undefined): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function textParam(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] : (value ?? ""));
}

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "The request could not be completed";
  if (
    message.includes("not found") ||
    message.includes("Add a note") ||
    message.includes("cannot contain")
  ) {
    res.status(message.includes("not found") ? 404 : 400).json({ error: message });
    return;
  }
  logger.error({ error }, "Lead scanner request failed");
  res.status(500).json({ error: "The lead scanner request could not be completed" });
}

const activationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `sponsor:${sponsorReq(req).sponsorSession.sponsorId}`,
  message: { error: "Too many scanner activations. Please wait and try again." },
});

const scannerDeviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => scannerDeviceRateLimitKey(scannerReq(req).scannerDevice.id),
  message: { error: "This scanner is sending requests too quickly. Please wait a moment." },
});

router.get("/sponsor/scanner/devices", sponsorAuth, async (req, res): Promise<void> => {
  const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
  const devices = await db
    .select({
      id: sponsorScannerDevicesTable.id,
      operatorName: sponsorScannerDevicesTable.operatorName,
      revokedAt: sponsorScannerDevicesTable.revokedAt,
      lastSyncedAt: sponsorScannerDevicesTable.lastSyncedAt,
      accessVersion: sponsorScannerDevicesTable.accessVersion,
      currentAccessVersion: sponsorsTable.portalAccessVersion,
    })
    .from(sponsorScannerDevicesTable)
    .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorScannerDevicesTable.sponsorId))
    .where(eq(sponsorScannerDevicesTable.sponsorId, sponsorId));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    devices: devices.map(({ accessVersion, currentAccessVersion, ...device }) => ({
      ...device,
      needsRefresh: accessVersion !== currentAccessVersion,
    })),
  });
});

for (const action of ["recover", "restore"] as const) {
  router.post(
    `/sponsor/scanner/devices/:deviceId/${action}`,
    sponsorAuth,
    activationLimiter,
    async (req, res): Promise<void> => {
      const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
      const result = await db.transaction(async (tx) => {
        const [sponsor] = await tx
          .select()
          .from(sponsorsTable)
          .where(eq(sponsorsTable.id, sponsorId))
          .for("update");
        if (!sponsor || !["confirmed", "completed"].includes(sponsor.status))
          return { status: 403, error: "Sponsor access is paused" };
        const [device] = await tx
          .select()
          .from(sponsorScannerDevicesTable)
          .where(
            and(
              eq(sponsorScannerDevicesTable.id, textParam(req.params.deviceId)),
              eq(sponsorScannerDevicesTable.sponsorId, sponsorId),
            ),
          )
          .for("update");
        const suppliedToken = typeof req.body?.token === "string" ? req.body.token : "";
        if (
          !device ||
          (action === "recover" && scannerTokenHash(suppliedToken) !== device.tokenHash)
        )
          return {
            status: 404,
            error:
              "Open the scanner link for this sponsor. Saved leads stay with their original sponsor.",
          };
        if (action === "recover" && device.revokedAt)
          return {
            status: 403,
            error: "The organiser must restore this phone from Team & passes",
            code: "device_revoked",
          };
        // Refresh keeps the bearer and device ID, so a lost response can safely be retried.
        const token = action === "recover" ? suppliedToken : randomBytes(32).toString("base64url");
        await tx
          .update(sponsorScannerDevicesTable)
          .set({
            tokenHash: scannerTokenHash(token),
            accessVersion: sponsor.portalAccessVersion,
            revokedAt: null,
            revokedReason: null,
            updatedAt: new Date(),
          })
          .where(eq(sponsorScannerDevicesTable.id, device.id));
        if (action === "restore" || device.accessVersion !== sponsor.portalAccessVersion)
          await tx.insert(sponsorActivityTable).values({
            sponsorId,
            type: `scanner_${action}`,
            actorType: "sponsor",
            data: { deviceId: device.id },
          });
        return {
          status: 200,
          credential: {
            id: device.id,
            token,
            operatorName: device.operatorName,
            sponsorId,
            sponsorCompany: sponsor.company,
            testQrValue: SCANNER_TEST_CODE,
          },
        };
      });
      res.setHeader("Cache-Control", "no-store");
      res
        .status(result.status)
        .json(result.credential ?? { error: result.error, code: result.code });
    },
  );
}

router.post(
  "/sponsor/scanner/devices",
  sponsorAuth,
  activationLimiter,
  async (req, res): Promise<void> => {
    const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
    const operatorName =
      typeof req.body.operatorName === "string" ? req.body.operatorName.trim() : "";
    if (operatorName.length < 2 || operatorName.length > 200) {
      res.status(400).json({ error: "Enter the name of the person using this phone" });
      return;
    }
    const [sponsor] = await db
      .select({
        company: sponsorsTable.company,
        accessVersion: sponsorsTable.portalAccessVersion,
      })
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId));
    if (!sponsor) {
      res.status(404).json({ error: "Sponsor not found" });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const id = uuidv4();
    await db.insert(sponsorScannerDevicesTable).values({
      id,
      sponsorId,
      accessVersion: sponsor.accessVersion,
      tokenHash: scannerTokenHash(token),
      operatorName,
      userAgent: req.get("user-agent")?.slice(0, 1000) ?? null,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      id,
      token,
      operatorName,
      sponsorId,
      sponsorCompany: sponsor.company,
      testQrValue: SCANNER_TEST_CODE,
    });
  },
);

router.get("/sponsor/leads", sponsorAuth, async (req, res): Promise<void> => {
  try {
    const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
    res.json({ leads: await listLeadRows(sponsorId) });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/sponsor/leads/:leadId", sponsorAuth, async (req, res): Promise<void> => {
  try {
    const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
    const leadId = textParam(req.params.leadId);
    const operatorName = typeof req.body.operatorName === "string" ? req.body.operatorName : "";
    if (operatorName.trim().length < 2) {
      res.status(400).json({ error: "Enter your name before adding a rating or note" });
      return;
    }
    await addLeadAnnotation({
      sponsorId,
      leadId,
      operatorName,
      note: req.body.note,
      rating: req.body.rating,
    });
    const leads = await listLeadRows(sponsorId);
    res.json(leads.find((lead) => lead.id === leadId));
  } catch (error) {
    sendError(res, error);
  }
});

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function leadExportRows(leads: Awaited<ReturnType<typeof listLeadRows>>) {
  return leads.map((lead) => ({
    Sponsor: lead.sponsorCompany,
    Name: lead.name,
    "Job Title": lead.jobTitle,
    Company: lead.company,
    "Work Email": lead.workEmail,
    Rating: lead.rating ?? "",
    "First Scanned": lead.firstScannedAt ?? "",
    "Last Scanned": lead.lastScannedAt ?? "",
    "Scan Count": lead.scanCount,
    "Scanner Names": [...new Set(lead.scans.map((scan) => scan.operatorName))].join(" | "),
    Notes: lead.notes
      .filter((note) => note.note)
      .map((note) => `${note.createdAt} · ${note.operatorName}: ${note.note}`)
      .join(" | "),
  }));
}

async function sendLeadExport(
  res: Response,
  leads: Awaited<ReturnType<typeof listLeadRows>>,
  format: "csv" | "xlsx",
  filenameBase: string,
): Promise<void> {
  const rows = leadExportRows(leads);
  const headings = Object.keys(
    rows[0] ?? {
      Sponsor: "",
      Name: "",
      "Job Title": "",
      Company: "",
      "Work Email": "",
      Rating: "",
      "First Scanned": "",
      "Last Scanned": "",
      "Scan Count": "",
      "Scanner Names": "",
      Notes: "",
    },
  );
  if (format === "csv") {
    const csv = [
      headings.map(csvCell).join(","),
      ...rows.map((row) =>
        headings.map((heading) => csvCell(row[heading as keyof typeof row])).join(","),
      ),
    ].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    res.send(`\uFEFF${csv}\r\n`);
    return;
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SWP Summit 2027";
  const sheet = workbook.addWorksheet("Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = headings.map((header) => ({
    header,
    key: header,
    width: header === "Notes" ? 55 : Math.max(14, Math.min(30, header.length + 6)),
  }));
  rows.forEach((row) => sheet.addRow(row));
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(headings.length).letter}1` };
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF004EB9" } };
  });
  sheet.eachRow((row, index) => {
    if (index > 1) row.alignment = { vertical: "top", wrapText: true };
  });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
  res.send(Buffer.from(buffer));
}

router.get("/sponsor/leads/export", sponsorAuth, async (req, res): Promise<void> => {
  try {
    const sponsorId = sponsorReq(req).sponsorSession.sponsorId;
    const [sponsor] = await db
      .select({ company: sponsorsTable.company })
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId));
    const format = req.query.format === "csv" ? "csv" : "xlsx";
    await sendLeadExport(
      res,
      await listLeadRows(sponsorId),
      format,
      `swp-2027-${(sponsor?.company ?? "sponsor").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-leads`,
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.use("/scanner", scannerAuth, scannerDeviceLimiter);

router.use("/scanner", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.post("/scanner/lookup", async (req, res): Promise<void> => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
  if (!/^[0-9A-F]{12}$/.test(code)) {
    res.status(400).json({ error: "This is not an SWP badge" });
    return;
  }
  const [attendee] = await db
    .select({
      attendeeId: attendeesTable.id,
      firstName: attendeesTable.firstName,
      lastName: attendeesTable.lastName,
      jobTitle: attendeesTable.jobTitle,
      company: attendeesTable.company,
      workEmail: attendeesTable.workEmail,
    })
    .from(attendeeBadgesTable)
    .innerJoin(attendeesTable, eq(attendeesTable.id, attendeeBadgesTable.attendeeId))
    .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
    .where(
      and(
        eq(attendeeBadgesTable.code, code),
        eq(attendeeBadgesTable.active, true),
        inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]),
        eq(attendeesTable.isTbc, false),
        eq(attendeesTable.leadSharingExcluded, false),
        isNotNull(attendeesTable.leadSharingNoticeAt),
      ),
    );
  if (!attendee) {
    res.status(404).json({ error: "This badge cannot be added. Please ask the event team." });
    return;
  }
  res.json({ ...attendee, name: `${attendee.firstName} ${attendee.lastName}`.trim() });
});

router.get("/scanner/leads", async (req, res): Promise<void> => {
  res.json({ leads: await listLeadRows(scannerReq(req).scannerDevice.sponsorId) });
});

router.get("/scanner/leads/export", async (req, res): Promise<void> => {
  const leads = await listLeadRows(scannerReq(req).scannerDevice.sponsorId);
  if (!leads.length) {
    res.status(409).json({ error: "No confirmed leads to export yet" });
    return;
  }
  await sendLeadExport(
    res,
    leads,
    req.query.format === "csv" ? "csv" : "xlsx",
    "swp-2027-confirmed-leads",
  );
});

router.get("/scanner/bootstrap", async (req, res): Promise<void> => {
  try {
    const device = scannerReq(req).scannerDevice;
    const [record] = await db
      .select({
        packVersion: sponsorScannerDevicesTable.packVersion,
        cameraTested: sponsorScannerDevicesTable.cameraTested,
        qrTested: sponsorScannerDevicesTable.qrTested,
        storageTested: sponsorScannerDevicesTable.storageTested,
        offlineTested: sponsorScannerDevicesTable.offlineTested,
        syncTested: sponsorScannerDevicesTable.syncTested,
        lastSyncedAt: sponsorScannerDevicesTable.lastSyncedAt,
        sponsorCompany: sponsorsTable.company,
      })
      .from(sponsorScannerDevicesTable)
      .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorScannerDevicesTable.sponsorId))
      .where(eq(sponsorScannerDevicesTable.id, device.id));
    const currentPackVersion = await currentLeadPackVersion();
    const ready = Boolean(
      record?.cameraTested &&
      record.qrTested &&
      record.storageTested &&
      record.offlineTested &&
      record.syncTested &&
      record.packVersion === currentPackVersion,
    );
    res.json({
      device: {
        id: device.id,
        operatorName: device.operatorName,
        sponsorId: device.sponsorId,
        sponsorCompany: record?.sponsorCompany ?? "Sponsor",
        packVersion: record?.packVersion ?? null,
        currentPackVersion,
        cameraTested: record?.cameraTested ?? false,
        qrTested: record?.qrTested ?? false,
        storageTested: record?.storageTested ?? false,
        offlineTested: record?.offlineTested ?? false,
        syncTested: record?.syncTested ?? false,
        ready,
        outOfDate: Boolean(record?.packVersion && record.packVersion !== currentPackVersion),
        lastSyncedAt: record?.lastSyncedAt?.toISOString() ?? null,
      },
      scannerWindow: await getScannerWindow(),
      testQrValue: SCANNER_TEST_CODE,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/scanner/offline-pack", async (req, res): Promise<void> => {
  try {
    const device = scannerReq(req).scannerDevice;
    res.setHeader("Cache-Control", "no-store");
    res.json(await buildOfflineLeadPack(device));
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/scanner/readiness", async (req, res): Promise<void> => {
  try {
    const device = scannerReq(req).scannerDevice;
    const current = await currentLeadPackVersion();
    const requestedPackVersion =
      typeof req.body.packVersion === "string" ? req.body.packVersion : undefined;
    if (requestedPackVersion && requestedPackVersion !== current) {
      res.status(409).json({ error: "The attendee pack has changed. Download it again." });
      return;
    }
    const values: Partial<typeof sponsorScannerDevicesTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    for (const field of [
      "cameraTested",
      "qrTested",
      "storageTested",
      "offlineTested",
      "syncTested",
    ] as const) {
      if (typeof req.body[field] === "boolean") values[field] = req.body[field];
    }
    if (requestedPackVersion) values.packVersion = requestedPackVersion;
    await db
      .update(sponsorScannerDevicesTable)
      .set(values)
      .where(eq(sponsorScannerDevicesTable.id, device.id));
    res.json({ success: true, currentPackVersion: current });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/scanner/sync", async (req, res): Promise<void> => {
  try {
    const scans = Array.isArray(req.body.scans) ? (req.body.scans as ScannerSyncScan[]) : [];
    const annotations = Array.isArray(req.body.annotations)
      ? (req.body.annotations as ScannerSyncAnnotation[])
      : [];
    if (scans.length > MAX_SYNC_BATCH || annotations.length > MAX_SYNC_BATCH) {
      res.status(413).json({ error: `Send at most ${MAX_SYNC_BATCH} scans and notes per batch` });
      return;
    }
    const device = scannerReq(req).scannerDevice;
    res.json(await syncScannerBatch(device, scans, annotations));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/admin/lead-scanner/overview", adminAuth, async (_req, res): Promise<void> => {
  try {
    const [leadCount] = await db.select({ value: count() }).from(sponsorLeadsTable);
    const [deviceCount] = await db.select({ value: count() }).from(sponsorScannerDevicesTable);
    const [badgeCount] = await db.select({ value: count() }).from(attendeeBadgesTable);
    const currentPackVersion = await currentLeadPackVersion();
    const devices = await db
      .select({
        id: sponsorScannerDevicesTable.id,
        sponsorId: sponsorScannerDevicesTable.sponsorId,
        sponsorCompany: sponsorsTable.company,
        operatorName: sponsorScannerDevicesTable.operatorName,
        packVersion: sponsorScannerDevicesTable.packVersion,
        cameraTested: sponsorScannerDevicesTable.cameraTested,
        qrTested: sponsorScannerDevicesTable.qrTested,
        storageTested: sponsorScannerDevicesTable.storageTested,
        offlineTested: sponsorScannerDevicesTable.offlineTested,
        syncTested: sponsorScannerDevicesTable.syncTested,
        activatedAt: sponsorScannerDevicesTable.activatedAt,
        lastSeenAt: sponsorScannerDevicesTable.lastSeenAt,
        lastSyncedAt: sponsorScannerDevicesTable.lastSyncedAt,
        revokedAt: sponsorScannerDevicesTable.revokedAt,
      })
      .from(sponsorScannerDevicesTable)
      .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorScannerDevicesTable.sponsorId))
      .orderBy(desc(sponsorScannerDevicesTable.lastSeenAt));
    res.json({
      leadCount: Number(leadCount?.value ?? 0),
      deviceCount: Number(deviceCount?.value ?? 0),
      badgeCount: Number(badgeCount?.value ?? 0),
      currentPackVersion,
      testQrValue: SCANNER_TEST_CODE,
      scannerWindow: await getScannerWindow(),
      devices: devices.map((device) => {
        const tested =
          device.cameraTested &&
          device.qrTested &&
          device.storageTested &&
          device.offlineTested &&
          device.syncTested;
        const status = device.revokedAt
          ? "revoked"
          : device.packVersion && device.packVersion !== currentPackVersion
            ? "out_of_date"
            : tested && device.packVersion === currentPackVersion
              ? "ready"
              : "not_tested";
        return {
          ...device,
          status,
          activatedAt: device.activatedAt.toISOString(),
          lastSeenAt: device.lastSeenAt.toISOString(),
          lastSyncedAt: device.lastSyncedAt?.toISOString() ?? null,
          revokedAt: device.revokedAt?.toISOString() ?? null,
        };
      }),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/admin/lead-scanner/leads", adminAuth, async (req, res): Promise<void> => {
  try {
    const sponsorId = req.query.sponsorId ? Number(req.query.sponsorId) : undefined;
    if (sponsorId !== undefined && (!Number.isInteger(sponsorId) || sponsorId < 1)) {
      res.status(400).json({ error: "Invalid sponsor" });
      return;
    }
    res.json({ leads: await listLeadRows(sponsorId) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/admin/lead-scanner/leads/export", adminAuth, async (req, res): Promise<void> => {
  try {
    const sponsorId = req.query.sponsorId ? Number(req.query.sponsorId) : undefined;
    if (sponsorId !== undefined && (!Number.isInteger(sponsorId) || sponsorId < 1)) {
      res.status(400).json({ error: "Invalid sponsor" });
      return;
    }
    const format = req.query.format === "csv" ? "csv" : "xlsx";
    await sendLeadExport(
      res,
      await listLeadRows(sponsorId),
      format,
      sponsorId ? `swp-2027-sponsor-${sponsorId}-leads` : "swp-2027-all-sponsor-leads",
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  "/admin/lead-scanner/devices/:deviceId/revoke",
  adminAuth,
  async (req, res): Promise<void> => {
    try {
      const deviceId = textParam(req.params.deviceId);
      const updated = await db
        .update(sponsorScannerDevicesTable)
        .set({
          revokedAt: new Date(),
          revokedReason:
            typeof req.body.reason === "string"
              ? req.body.reason.trim().slice(0, 500) || "Revoked by organiser"
              : "Revoked by organiser",
          updatedAt: new Date(),
        })
        .where(eq(sponsorScannerDevicesTable.id, deviceId))
        .returning({
          id: sponsorScannerDevicesTable.id,
          operatorName: sponsorScannerDevicesTable.operatorName,
          sponsorId: sponsorScannerDevicesTable.sponsorId,
        });
      if (!updated.length) {
        res.status(404).json({ error: "Scanner device not found" });
        return;
      }
      await logAdminAction({
        type: "admin_scanner_device_revoked",
        summary: `Revoked scanner used by ${updated[0].operatorName}`,
        before: { revoked: false },
        after: { revoked: true },
        meta: { deviceId: updated[0].id, sponsorId: updated[0].sponsorId },
      });
      res.json({ success: true });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get("/admin/lead-scanner/attendees", adminAuth, async (_req, res): Promise<void> => {
  try {
    await ensureEligibleAttendeeBadges();
    const rows = await db
      .select({
        attendeeId: attendeesTable.id,
        firstName: attendeesTable.firstName,
        lastName: attendeesTable.lastName,
        company: attendeesTable.company,
        jobTitle: attendeesTable.jobTitle,
        workEmail: attendeesTable.workEmail,
        isTbc: attendeesTable.isTbc,
        leadSharingExcluded: attendeesTable.leadSharingExcluded,
        leadSharingNoticeAt: attendeesTable.leadSharingNoticeAt,
        bookingStatus: bookingsTable.status,
        badgeVersion: attendeeBadgesTable.version,
        badgeActive: attendeeBadgesTable.active,
      })
      .from(attendeesTable)
      .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
      .leftJoin(attendeeBadgesTable, eq(attendeeBadgesTable.attendeeId, attendeesTable.id))
      .where(inArray(bookingsTable.status, [...ACTIVE_BOOKING_STATUSES]))
      .orderBy(asc(attendeesTable.lastName), asc(attendeesTable.firstName));
    res.json({
      attendees: rows.map((row) => ({
        ...row,
        name: `${row.firstName} ${row.lastName}`.trim(),
        leadSharingNoticeAt: row.leadSharingNoticeAt?.toISOString() ?? null,
        badgeVersion: row.badgeVersion ?? null,
        badgeActive: row.badgeActive ?? false,
      })),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch(
  "/admin/lead-scanner/attendees/:attendeeId/sharing",
  adminAuth,
  async (req, res): Promise<void> => {
    try {
      const attendeeId = idParam(req.params.attendeeId);
      if (!attendeeId) {
        res.status(400).json({ error: "Invalid attendee" });
        return;
      }
      if (typeof req.body.excluded !== "boolean" && typeof req.body.noticeConfirmed !== "boolean") {
        res.status(400).json({ error: "Choose a lead-sharing setting to update" });
        return;
      }
      const [previous] = await db
        .select({
          id: attendeesTable.id,
          excluded: attendeesTable.leadSharingExcluded,
          noticeAt: attendeesTable.leadSharingNoticeAt,
        })
        .from(attendeesTable)
        .where(eq(attendeesTable.id, attendeeId));
      if (!previous) {
        res.status(404).json({ error: "Attendee not found" });
        return;
      }
      const changes: Partial<typeof attendeesTable.$inferInsert> = { updatedAt: new Date() };
      if (typeof req.body.excluded === "boolean") changes.leadSharingExcluded = req.body.excluded;
      if (typeof req.body.noticeConfirmed === "boolean") {
        changes.leadSharingNoticeAt = req.body.noticeConfirmed ? new Date() : null;
      }
      const updated = await db
        .update(attendeesTable)
        .set(changes)
        .where(eq(attendeesTable.id, attendeeId))
        .returning({
          id: attendeesTable.id,
          excluded: attendeesTable.leadSharingExcluded,
          noticeAt: attendeesTable.leadSharingNoticeAt,
        });
      if (!updated.length) {
        res.status(404).json({ error: "Attendee not found" });
        return;
      }
      const enabled = !updated[0].excluded && Boolean(updated[0].noticeAt);
      await db
        .update(attendeeBadgesTable)
        .set({ active: enabled, updatedAt: new Date() })
        .where(eq(attendeeBadgesTable.attendeeId, attendeeId));
      if (enabled) await ensureEligibleAttendeeBadges();
      await logAdminAction({
        type: "admin_attendee_lead_sharing_updated",
        attendeeId,
        summary: `Updated attendee #${attendeeId} lead-sharing controls`,
        before: {
          leadSharingExcluded: previous.excluded,
          leadSharingNoticeAt: previous.noticeAt?.toISOString() ?? null,
        },
        after: {
          leadSharingExcluded: updated[0].excluded,
          leadSharingNoticeAt: updated[0].noticeAt?.toISOString() ?? null,
        },
      });
      res.json({
        success: true,
        leadSharingExcluded: updated[0].excluded,
        leadSharingNoticeAt: updated[0].noticeAt?.toISOString() ?? null,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/admin/lead-scanner/attendees/:attendeeId/badge/rotate",
  adminAuth,
  async (req, res): Promise<void> => {
    try {
      const attendeeId = idParam(req.params.attendeeId);
      if (!attendeeId) {
        res.status(400).json({ error: "Invalid attendee" });
        return;
      }
      const [attendee] = await db
        .select({
          id: attendeesTable.id,
          isTbc: attendeesTable.isTbc,
          excluded: attendeesTable.leadSharingExcluded,
          noticeAt: attendeesTable.leadSharingNoticeAt,
          bookingStatus: bookingsTable.status,
        })
        .from(attendeesTable)
        .innerJoin(bookingsTable, eq(bookingsTable.id, attendeesTable.bookingId))
        .where(eq(attendeesTable.id, attendeeId));
      if (!attendee) {
        res.status(404).json({ error: "Attendee not found" });
        return;
      }
      const active =
        ACTIVE_BOOKING_STATUSES.includes(
          attendee.bookingStatus as (typeof ACTIVE_BOOKING_STATUSES)[number],
        ) &&
        !attendee.isTbc &&
        !attendee.excluded &&
        Boolean(attendee.noticeAt);
      let rotatedVersion: number | null = null;
      for (let attempt = 0; attempt < 5 && rotatedVersion === null; attempt += 1) {
        try {
          const changed = await db
            .insert(attendeeBadgesTable)
            .values({ attendeeId, code: generateBadgeCode(), active })
            .onConflictDoUpdate({
              target: attendeeBadgesTable.attendeeId,
              set: {
                code: generateBadgeCode(),
                version: sql`${attendeeBadgesTable.version} + 1`,
                active,
                rotatedAt: new Date(),
                updatedAt: new Date(),
              },
            })
            .returning({ version: attendeeBadgesTable.version });
          rotatedVersion = changed[0]?.version ?? null;
        } catch (error) {
          if ((error as { code?: string }).code !== "23505") throw error;
        }
      }
      if (rotatedVersion === null) {
        throw new Error("Could not allocate a unique replacement badge reference");
      }
      await logAdminAction({
        type: "admin_badge_rotated",
        attendeeId,
        summary: `Replaced the QR value for attendee #${attendeeId}`,
        after: { badgeVersion: rotatedVersion, active },
      });
      res.json({ success: true });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get("/admin/lead-scanner/badges/export", adminAuth, async (_req, res): Promise<void> => {
  try {
    const rows = await badgeExportRows();
    if (!rows.length) {
      res.status(409).json({
        error: "No badge-ready attendees were found. Confirm the lead-sharing notice first.",
      });
      return;
    }
    const csv = badgeExportCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="swp-2027-badge-data.csv"');
    res.send(`\uFEFF${csv}\r\n`);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
