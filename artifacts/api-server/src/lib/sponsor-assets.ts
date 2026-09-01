import path from "node:path";
import { createHash } from "node:crypto";
import type { Response } from "express";
import archiver from "archiver";
import { and, asc, eq, inArray } from "drizzle-orm";
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

function isZip(buffer: Buffer): boolean {
  return begins(buffer, [0x50, 0x4b, 0x03, 0x04]);
}

function isSafeOoxml(buffer: Buffer, rootFolder: "ppt" | "word"): boolean {
  if (!isZip(buffer)) return false;
  // ZIP central-directory filenames are stored as plain bytes even when file
  // contents are compressed. Checking them prevents a renamed arbitrary ZIP,
  // a Word/PowerPoint type mismatch and embedded VBA from passing validation.
  const directory = buffer.toString("latin1").toLowerCase();
  return (
    directory.includes("[content_types].xml") &&
    directory.includes(`${rootFolder}/`) &&
    !directory.includes("vbaproject.bin")
  );
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
    signature: (b) => isSafeOoxml(b, "ppt"),
  },
  ".docx": {
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    maxBytes: SPONSOR_DOCUMENT_MAX_BYTES,
    signature: (b) => isSafeOoxml(b, "word"),
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
  const version = input.replaces ? input.replaces.version + 1 : 1;
  const storageKey = sponsorObjectKey(input.sponsorId, id, version);
  const storage = getSponsorObjectStorage();

  await storage.put(storageKey, input.file.buffer);
  try {
    return await db.transaction(async (tx) => {
      if (input.replaces) {
        await tx
          .update(sponsorAssetsTable)
          .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(sponsorAssetsTable.id, input.replaces.id),
              eq(sponsorAssetsTable.sponsorId, input.sponsorId),
            ),
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
          .set({ assetId: asset.id, acknowledgementVersion: version, updatedAt: new Date() })
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

export async function streamSponsorAssetsZip(
  res: Response,
  assets: SponsorAsset[],
  filename: string,
): Promise<boolean> {
  const missing = await preflightSponsorAssets(assets);
  if (missing.length) {
    res.status(409).json({
      error: `The download cannot start because ${missing.length} stored file${missing.length === 1 ? " is" : "s are"} missing. The issue is now shown in Needs attention.`,
      missingAssetIds: missing,
    });
    return false;
  }

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
  archive.on("warning", (error) => logger.warn({ error }, "Sponsor ZIP warning"));
  archive.on("error", (error) => {
    logger.error({ error }, "Sponsor ZIP stream failed");
    if (!res.headersSent) res.status(500).json({ error: "The ZIP download could not be created" });
    else res.destroy(error);
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
    archive.append(storage.stream(asset.storageKey), { name: entry });
  }
  await archive.finalize();
  return true;
}

export async function activeSponsorAssets(
  sponsorId: number,
  ids?: string[],
): Promise<SponsorAsset[]> {
  const filters = [
    eq(sponsorAssetsTable.sponsorId, sponsorId),
    eq(sponsorAssetsTable.status, "active"),
  ];
  if (ids?.length) filters.push(inArray(sponsorAssetsTable.id, ids));
  return db
    .select()
    .from(sponsorAssetsTable)
    .where(and(...filters))
    .orderBy(asc(sponsorAssetsTable.category), asc(sponsorAssetsTable.createdAt));
}
