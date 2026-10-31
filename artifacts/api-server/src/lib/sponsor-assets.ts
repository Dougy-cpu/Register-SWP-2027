import { isOfficePackage } from "./office-package";
import { Readable } from "node:stream";
import type { RequestHandler } from "express";
import multer from "multer";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Response } from "express";
import archiver from "archiver";
import { and, asc, eq, inArray, or, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  db,
  sponsorActivityTable,
  sponsorAssetsTable,
  sponsorDocumentsTable,
  sponsorPresentersTable,
  sponsorSessionsTable,
  sponsorTasksTable,
  type SponsorAsset,
} from "@workspace/db";
import { getSponsorObjectStorage, sponsorObjectKey, SponsorStorageError } from "./sponsor-storage";
import { logger } from "./logger";

export const SPONSOR_RASTER_MAX_BYTES = 10 * 1024 * 1024;
export const SPONSOR_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

export function sponsorFileUpload(maxFields: number): RequestHandler {
  const single = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SPONSOR_DOCUMENT_MAX_BYTES, files: 1, fields: maxFields },
  }).single("file");
  return (req, res, next) =>
    single(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: "This file is too large. Images can be up to 10 MB and documents up to 25 MB.",
          });
          return;
        }
        res.status(400).json({ error: "Choose one file and try the upload again." });
        return;
      }
      next(err);
    });
}

export class SponsorAssetConflict extends Error {}

const SAFE_RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".com",
  ".bat",
  ".cmd",
  ".js",
  ".mjs",
  ".cjs",
  ".msi",
  ".scr",
  ".ps1",
  ".sh",
  ".docm",
  ".dotm",
  ".pptm",
  ".potm",
  ".ppsm",
  ".xlsm",
  ".xlam",
]);

type AssetCategory = typeof sponsorAssetsTable.$inferInsert.category;

interface AllowedFile {
  mimeTypes: string[];
  maxBytes: number;
  signature: (buffer: Buffer) => boolean;
}

function begins(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((value, index) => buffer[index] === value);
}

const ALLOWED_FILES: Record<string, AllowedFile> = {
  ".png": {
    mimeTypes: ["image/png"],
    maxBytes: SPONSOR_RASTER_MAX_BYTES,
    signature: (b) => begins(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  ".jpg": {
    mimeTypes: ["image/jpeg"],
    maxBytes: SPONSOR_RASTER_MAX_BYTES,
    signature: (b) => begins(b, [0xff, 0xd8, 0xff]),
  },
  ".jpeg": {
    mimeTypes: ["image/jpeg"],
    maxBytes: SPONSOR_RASTER_MAX_BYTES,
    signature: (b) => begins(b, [0xff, 0xd8, 0xff]),
  },
  ".webp": {
    mimeTypes: ["image/webp"],
    maxBytes: SPONSOR_RASTER_MAX_BYTES,
    signature: (b) =>
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
  ".svg": {
    mimeTypes: ["image/svg+xml", "text/xml", "application/xml"],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) => {
      const sample = b.subarray(0, Math.min(b.length, 8192)).toString("utf8").toLowerCase();
      return sample.includes("<svg") && !sample.includes("<script") && !/\son\w+\s*=/.test(sample);
    },
  },
  ".eps": {
    mimeTypes: ["application/postscript", "application/eps", "application/octet-stream"],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) => b.subarray(0, 11).toString("ascii").startsWith("%!PS-Adobe"),
  },
  ".ai": {
    mimeTypes: [
      "application/postscript",
      "application/pdf",
      "application/illustrator",
      "application/octet-stream",
    ],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) =>
      b.subarray(0, 5).toString("ascii") === "%PDF-" ||
      b.subarray(0, 11).toString("ascii").startsWith("%!PS-Adobe"),
  },
  ".pdf": {
    mimeTypes: ["application/pdf"],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) => b.subarray(0, 5).toString("ascii") === "%PDF-",
  },
  ".pptx": {
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) => isOfficePackage(b, "ppt"),
  },
  ".docx": {
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) => isOfficePackage(b, "word"),
  },
};

export class SponsorAssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorAssetValidationError";
  }
}

export function validateSponsorAssetFile(file: {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}): { extension: string; mimeType: string; checksumSha256: string } {
  const extension = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new SponsorAssetValidationError("Executable and macro-enabled files are not accepted");
  }
  const allowed = ALLOWED_FILES[extension];
  if (!allowed) {
    throw new SponsorAssetValidationError(
      "Accepted files are PNG, JPEG, WebP, SVG, EPS, AI, PDF, PPTX and DOCX",
    );
  }
  if (!allowed.mimeTypes.includes(file.mimetype.toLowerCase())) {
    throw new SponsorAssetValidationError(
      `The file content type (${file.mimetype || "unknown"}) does not match ${extension}`,
    );
  }
  if (file.size < 1 || file.buffer.length !== file.size) {
    throw new SponsorAssetValidationError("The uploaded file is empty or incomplete");
  }
  if (file.size > allowed.maxBytes) {
    const maxMb = Math.round(allowed.maxBytes / 1024 / 1024);
    throw new SponsorAssetValidationError(`${extension} files must be ${maxMb} MB or smaller`);
  }
  if (!allowed.signature(file.buffer)) {
    throw new SponsorAssetValidationError(
      "The file signature does not match its name and content type",
    );
  }
  return {
    extension,
    mimeType: file.mimetype.toLowerCase(),
    checksumSha256: createHash("sha256").update(file.buffer).digest("hex"),
  };
}

export function isSafeRasterPreview(mimeType: string): boolean {
  return SAFE_RASTER_MIMES.has(mimeType);
}

async function resolveSponsorAssetRelationships(input: {
  sponsorId: number;
  sessionId?: number | null;
  presenterId?: number | null;
}): Promise<{ sessionId: number | null; presenterId: number | null }> {
  let sessionId = input.sessionId ?? null;
  const presenterId = input.presenterId ?? null;
  if (sessionId !== null && (!Number.isInteger(sessionId) || sessionId < 1)) {
    throw new SponsorAssetValidationError("Choose a valid sponsor session");
  }
  if (presenterId !== null && (!Number.isInteger(presenterId) || presenterId < 1)) {
    throw new SponsorAssetValidationError("Choose a valid sponsor presenter");
  }

  if (sessionId !== null) {
    const [session] = await db
      .select({ id: sponsorSessionsTable.id })
      .from(sponsorSessionsTable)
      .where(
        and(
          eq(sponsorSessionsTable.id, sessionId),
          eq(sponsorSessionsTable.sponsorId, input.sponsorId),
        ),
      );
    if (!session) {
      throw new SponsorAssetValidationError("That session does not belong to this sponsor");
    }
  }

  if (presenterId !== null) {
    const [presenter] = await db
      .select({ sessionId: sponsorPresentersTable.sessionId })
      .from(sponsorPresentersTable)
      .innerJoin(
        sponsorSessionsTable,
        eq(sponsorSessionsTable.id, sponsorPresentersTable.sessionId),
      )
      .where(
        and(
          eq(sponsorPresentersTable.id, presenterId),
          eq(sponsorSessionsTable.sponsorId, input.sponsorId),
        ),
      );
    if (!presenter || (sessionId !== null && presenter.sessionId !== sessionId)) {
      throw new SponsorAssetValidationError(
        "That presenter does not belong to this sponsor session",
      );
    }
    sessionId ??= presenter.sessionId;
  }

  return { sessionId, presenterId };
}

export function formatSponsorAsset(asset: SponsorAsset, sponsorCompany?: string | null) {
  const { storageKey: _storageKey, ...publicMetadata } = asset;
  return {
    ...publicMetadata,
    sponsorCompany: sponsorCompany ?? null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    archivedAt: asset.archivedAt?.toISOString() ?? null,
    previewAvailable: isSafeRasterPreview(asset.mimeType),
  };
}

export async function recordSponsorStorageFailure(input: {
  sponsorId: number;
  operation: string;
  error: unknown;
  actorType?: "admin" | "sponsor" | "system";
}): Promise<void> {
  const message =
    input.error instanceof Error ? input.error.message.slice(0, 500) : "Unknown App Storage error";
  await db.transaction(async (tx) => {
    await tx
      .insert(sponsorTasksTable)
      .values({
        sponsorId: input.sponsorId,
        taskKey: "storage_error",
        label: "File storage issue - retry the last file action",
        required: true,
        status: "overdue",
      })
      .onConflictDoUpdate({
        target: [sponsorTasksTable.sponsorId, sponsorTasksTable.taskKey],
        set: {
          label: "File storage issue - retry the last file action",
          required: true,
          status: "overdue",
          completedAt: null,
          updatedAt: new Date(),
        },
      });
    await tx.insert(sponsorActivityTable).values({
      sponsorId: input.sponsorId,
      type: "storage_error",
      actorType: input.actorType ?? "system",
      data: { operation: input.operation, message },
    });
  });
}

type AssetTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function assetFamily(conn: AssetTx | typeof db, sponsorId: number, assetId: string) {
  const result = await conn.execute<{
    id: string;
    version: number;
    status: SponsorAsset["status"];
  }>(sql`WITH RECURSIVE ancestors AS (
    SELECT id,replaces_asset_id FROM sponsor_assets WHERE id=${assetId} AND sponsor_id=${sponsorId}
    UNION SELECT p.id,p.replaces_asset_id FROM sponsor_assets p JOIN ancestors a ON a.replaces_asset_id=p.id WHERE p.sponsor_id=${sponsorId}
  ), family AS (
    SELECT s.id,s.version,s.status FROM sponsor_assets s JOIN ancestors a ON s.id=a.id WHERE a.replaces_asset_id IS NULL
    UNION SELECT s.id,s.version,s.status FROM sponsor_assets s JOIN family f ON s.replaces_asset_id=f.id WHERE s.sponsor_id=${sponsorId}
  ) SELECT id,version,status FROM family ORDER BY version DESC`);
  return result.rows;
}

export function currentSponsorAsset() {
  return or(
    eq(sponsorAssetsTable.status, "active"),
    and(eq(sponsorAssetsTable.status, "missing"), isNull(sponsorAssetsTable.archivedAt)),
  );
}

export async function setSponsorAssetStatus(asset: SponsorAsset, status: "archived" | "active") {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM sponsors WHERE id=${asset.sponsorId} FOR UPDATE`);
    const family = await assetFamily(tx, asset.sponsorId, asset.id);
    if (!family.some((row) => row.id === asset.id))
      throw new SponsorAssetConflict("Refresh the file list before changing this version.");
    const otherIds = family.filter((row) => row.id !== asset.id).map((row) => row.id);
    if (status === "active" && otherIds.length) {
      await tx
        .update(sponsorAssetsTable)
        .set({ status: "archived", archivedAt: new Date() })
        .where(and(inArray(sponsorAssetsTable.id, otherIds), currentSponsorAsset()));
      await tx
        .update(sponsorDocumentsTable)
        .set({
          assetId: asset.id,
          acknowledgementVersion: sql`${sponsorDocumentsTable.acknowledgementVersion}+1`,
        })
        .where(inArray(sponsorDocumentsTable.assetId, otherIds));
    }
    const [updated] = await tx
      .update(sponsorAssetsTable)
      .set({ status, archivedAt: status === "archived" ? new Date() : null })
      .where(eq(sponsorAssetsTable.id, asset.id))
      .returning();
    await tx.insert(sponsorActivityTable).values({
      sponsorId: asset.sponsorId,
      type: status === "archived" ? "asset_archived" : "asset_restored",
      actorType: "admin",
      data: { assetId: asset.id },
    });
    return updated;
  });
}

export async function createSponsorAsset(input: {
  sponsorId: number;
  category: AssetCategory;
  file: Express.Multer.File;
  sessionId?: number | null;
  presenterId?: number | null;
  uploaderType: "admin" | "sponsor";
  uploaderLabel?: string | null;
  replaces?: SponsorAsset | null;
}): Promise<SponsorAsset> {
  const validated = validateSponsorAssetFile(input.file);
  const relationships = input.replaces
    ? {
        sessionId: input.sessionId ?? input.replaces.sessionId,
        presenterId: input.presenterId ?? input.replaces.presenterId,
      }
    : await resolveSponsorAssetRelationships(input);
  if (input.replaces) {
    await resolveSponsorAssetRelationships({ sponsorId: input.sponsorId, ...relationships });
  }
  const id = uuidv4();
  const previous = input.replaces ? await assetFamily(db, input.sponsorId, input.replaces.id) : [];
  const version = previous.length ? previous[0].version + 1 : 1;
  const storageKey = sponsorObjectKey(input.sponsorId, id, version);
  const storage = getSponsorObjectStorage();

  await storage.put(storageKey, input.file.buffer);
  try {
    return await db.transaction(async (tx) => {
      if (input.replaces) {
        await tx.execute(sql`SELECT id FROM sponsors WHERE id=${input.sponsorId} FOR UPDATE`);
        const current = await assetFamily(tx, input.sponsorId, input.replaces.id);
        if (!current.length || current[0].version + 1 !== version)
          throw new SponsorAssetConflict(
            "A newer file version exists. Refresh the file list and try again.",
          );
        const [archived] = await tx
          .update(sponsorAssetsTable)
          .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(sponsorAssetsTable.id, input.replaces.id),
              eq(sponsorAssetsTable.sponsorId, input.sponsorId),
              currentSponsorAsset(),
            ),
          )
          .returning({ id: sponsorAssetsTable.id });
        if (!archived)
          throw new SponsorAssetConflict(
            "This file version has already changed. Refresh the file list before replacing it.",
          );
      }
      const [asset] = await tx
        .insert(sponsorAssetsTable)
        .values({
          id,
          sponsorId: input.sponsorId,
          sessionId: relationships.sessionId,
          presenterId: relationships.presenterId,
          category: input.category,
          originalName: input.file.originalname,
          mimeType: validated.mimeType,
          byteSize: input.file.size,
          checksumSha256: validated.checksumSha256,
          storageKey,
          version,
          replacesAssetId: input.replaces?.id ?? null,
          uploaderType: input.uploaderType,
          uploaderLabel: input.uploaderLabel ?? null,
        })
        .returning();
      await tx.insert(sponsorActivityTable).values({
        sponsorId: input.sponsorId,
        type: input.replaces ? "asset_replaced" : "asset_uploaded",
        actorType: input.uploaderType,
        actorLabel: input.uploaderLabel,
        data: {
          assetId: asset.id,
          category: asset.category,
          filename: asset.originalName,
          version: asset.version,
          replacedAssetId: input.replaces?.id ?? null,
        },
      });
      const taskKeys = new Set<string>(["assets"]);
      if (asset.category === "slides") taskKeys.add("slides");
      if (asset.category === "logistics") taskKeys.add("logistics");
      if (asset.category === "headshot") taskKeys.add("speakers");
      await tx
        .update(sponsorTasksTable)
        .set({ status: "submitted", completedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(sponsorTasksTable.sponsorId, input.sponsorId),
            inArray(sponsorTasksTable.taskKey, [...taskKeys]),
            inArray(sponsorTasksTable.status, ["todo", "overdue"]),
          ),
        );
      await tx
        .delete(sponsorTasksTable)
        .where(
          and(
            eq(sponsorTasksTable.sponsorId, input.sponsorId),
            eq(sponsorTasksTable.taskKey, "storage_error"),
          ),
        );
      if (input.replaces?.category === "logistics") {
        await tx
          .update(sponsorDocumentsTable)
          .set({
            assetId: asset.id,
            acknowledgementVersion: sql`${sponsorDocumentsTable.acknowledgementVersion}+1`,
            updatedAt: new Date(),
          })
          .where(eq(sponsorDocumentsTable.assetId, input.replaces.id));
      }
      return asset;
    });
  } catch (error) {
    await storage
      .delete(storageKey)
      .catch((deleteError) =>
        logger.error({ deleteError, storageKey }, "Could not remove orphaned sponsor upload"),
      );
    throw error;
  }
}

export function safeDownloadFilename(filename: string): string {
  const basename = path
    .basename(filename)
    .replace(/[\r\n"\\/:*?<>|]/g, "_")
    .trim();
  return basename || "download";
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function manifestCsv(
  assets: SponsorAsset[],
  sessions: Map<number, { label: string; status: string }>,
  presenters: Map<number, string>,
): string {
  const header = [
    "asset_id",
    "sponsor_id",
    "category",
    "filename",
    "version",
    "byte_size",
    "mime_type",
    "checksum_sha256",
    "status",
    "submission_status",
    "uploaded_at",
    "session_id",
    "session_title",
    "presenter_id",
    "presenter_name",
  ];
  const rows = assets.map((asset) =>
    [
      asset.id,
      asset.sponsorId,
      asset.category,
      asset.originalName,
      asset.version,
      asset.byteSize,
      asset.mimeType,
      asset.checksumSha256,
      asset.status,
      asset.sessionId ? (sessions.get(asset.sessionId)?.status ?? "") : "",
      asset.createdAt.toISOString(),
      asset.sessionId,
      asset.sessionId ? (sessions.get(asset.sessionId)?.label ?? "") : "",
      asset.presenterId,
      asset.presenterId ? (presenters.get(asset.presenterId) ?? "") : "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.map(csvCell).join(",")}\r\n${rows.join("\r\n")}\r\n`;
}

export async function preflightSponsorAssets(assets: SponsorAsset[]): Promise<string[]> {
  const storage = getSponsorObjectStorage();
  const missing: string[] = [];
  for (const asset of assets) {
    let exists: boolean;
    try {
      exists = await storage.exists(asset.storageKey);
    } catch (error) {
      const sponsorIds = [...new Set(assets.map((item) => item.sponsorId))];
      await Promise.allSettled(
        sponsorIds.map((sponsorId) =>
          recordSponsorStorageFailure({
            sponsorId,
            operation: "preflight",
            error,
          }),
        ),
      );
      throw new SponsorStorageError(
        error instanceof Error ? error.message : "App Storage could not be reached",
        "preflight",
        asset.storageKey,
      );
    }
    if (!exists) missing.push(asset.id);
  }
  if (missing.length) {
    await db
      .update(sponsorAssetsTable)
      .set({ status: "missing", updatedAt: new Date() })
      .where(inArray(sponsorAssetsTable.id, missing));
  }
  return missing;
}

export async function sponsorDownloadsAvailable(res: Response, assets: SponsorAsset[]) {
  try {
    const missing = await preflightSponsorAssets(assets);
    if (!missing.length) return true;
    res.status(409).json({
      error:
        "The download cannot start because a stored file is missing. Replace it or check Needs attention.",
      missingAssetIds: missing,
    });
  } catch (error) {
    if (!(error instanceof SponsorStorageError)) throw error;
    res.status(503).json({
      error: "File storage could not be reached. Retry the download or check Needs attention.",
    });
  }
  return false;
}

export async function streamSponsorAssetsZip(
  res: Response,
  assets: SponsorAsset[],
  filename: string,
): Promise<boolean> {
  if (!(await sponsorDownloadsAvailable(res, assets))) return false;

  const archive = archiver("zip", { zlib: { level: 6 } });
  const storage = getSponsorObjectStorage();
  const sessionIds = [
    ...new Set(assets.map((asset) => asset.sessionId).filter((id): id is number => id !== null)),
  ];
  const presenterIds = [
    ...new Set(assets.map((asset) => asset.presenterId).filter((id): id is number => id !== null)),
  ];
  const [sessionRows, presenterRows] = await Promise.all([
    sessionIds.length
      ? db
          .select({
            id: sponsorSessionsTable.id,
            title: sponsorSessionsTable.title,
            entitlementLabel: sponsorSessionsTable.entitlementLabel,
            status: sponsorSessionsTable.status,
          })
          .from(sponsorSessionsTable)
          .where(inArray(sponsorSessionsTable.id, sessionIds))
      : Promise.resolve([]),
    presenterIds.length
      ? db
          .select({ id: sponsorPresentersTable.id, name: sponsorPresentersTable.name })
          .from(sponsorPresentersTable)
          .where(inArray(sponsorPresentersTable.id, presenterIds))
      : Promise.resolve([]),
  ]);
  const sessions = new Map(
    sessionRows.map((session) => [
      session.id,
      { label: session.title || session.entitlementLabel, status: session.status },
    ]),
  );
  const presenters = new Map(presenterRows.map((presenter) => [presenter.id, presenter.name]));
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeDownloadFilename(filename)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  const sources = new Set<Readable>();
  let failing = false;
  let settle!: (success: boolean) => void;
  const completed = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  function abortStreams() {
    archive.unpipe(res);
    for (const source of sources) source.destroy();
    archive.abort();
    archive.destroy();
  }
  async function fail(error: Error, sponsorIds: number[]) {
    if (failing) return;
    failing = true;
    abortStreams();
    logger.error({ error }, "Sponsor ZIP stream failed");
    await Promise.allSettled(
      sponsorIds.map((sponsorId) =>
        recordSponsorStorageFailure({ sponsorId, operation: "zip_download", error }),
      ),
    );
    if (!res.headersSent && !res.destroyed) {
      res.removeHeader("Content-Disposition");
      res
        .status(503)
        .type("application/json")
        .json({ error: "The folder download failed. Retry it or check Needs attention." });
    } else if (!res.destroyed) res.destroy();
    settle(false);
  }
  const allSponsors = [...new Set(assets.map((asset) => asset.sponsorId))];
  archive.on("warning", (error) => void fail(error, allSponsors));
  archive.on("error", (error) => void fail(error, allSponsors));
  res.once("finish", () => {
    if (!failing) settle(true);
  });
  res.once("close", () => {
    if (!res.writableFinished && !failing) {
      failing = true;
      abortStreams();
      settle(false);
    }
  });
  archive.pipe(res);
  archive.append(manifestCsv(assets, sessions, presenters), { name: "manifest.csv" });
  const names = new Set<string>();
  const multipleSponsors = new Set(assets.map((asset) => asset.sponsorId)).size > 1;
  for (const asset of assets) {
    const base = safeDownloadFilename(asset.originalName);
    const prefix = multipleSponsors ? `sponsor-${asset.sponsorId}/` : "";
    let entry = `${prefix}${asset.category}/${base}`;
    if (names.has(entry)) {
      entry = `${prefix}${asset.category}/v${asset.version}-${asset.id.slice(0, 8)}-${base}`;
    }
    names.add(entry);
    // Open one object when the archiver consumes it. Source errors do not
    // automatically propagate through Node's pipe() into the archive.
    const source = Readable.from(
      (async function* () {
        yield* storage.stream(asset.storageKey);
      })(),
    );
    sources.add(source);
    source.once("close", () => sources.delete(source));
    source.once("error", (error) => void fail(error, [asset.sponsorId]));
    archive.append(source, { name: entry });
  }
  void archive.finalize().catch((error) => fail(error, allSponsors));
  return completed;
}

export async function activeSponsorAssets(
  sponsorId: number,
  ids?: string[],
  includeMissing = false,
): Promise<SponsorAsset[]> {
  const filters = [
    eq(sponsorAssetsTable.sponsorId, sponsorId),
    includeMissing ? currentSponsorAsset() : eq(sponsorAssetsTable.status, "active"),
  ];
  if (ids?.length) filters.push(inArray(sponsorAssetsTable.id, ids));
  return db
    .select()
    .from(sponsorAssetsTable)
    .where(and(...filters))
    .orderBy(asc(sponsorAssetsTable.category), asc(sponsorAssetsTable.createdAt));
}
