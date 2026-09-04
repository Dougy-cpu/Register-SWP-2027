import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, sponsorScannerDevicesTable, sponsorsTable } from "@workspace/db";

export interface ScannerDeviceSession {
  id: string;
  sponsorId: number;
  accessVersion: number;
  operatorName: string;
  rawToken: string;
}

export interface ScannerRequest extends Request {
  scannerDevice: ScannerDeviceSession;
}

export function scannerTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return /^[A-Za-z0-9_-]{40,200}$/.test(token) ? token : null;
}

export async function scannerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "This scanner has not been activated" });
    return;
  }
  const [record] = await db
    .select({
      id: sponsorScannerDevicesTable.id,
      sponsorId: sponsorScannerDevicesTable.sponsorId,
      accessVersion: sponsorScannerDevicesTable.accessVersion,
      operatorName: sponsorScannerDevicesTable.operatorName,
      revokedAt: sponsorScannerDevicesTable.revokedAt,
      sponsorAccessVersion: sponsorsTable.portalAccessVersion,
      sponsorStatus: sponsorsTable.status,
    })
    .from(sponsorScannerDevicesTable)
    .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorScannerDevicesTable.sponsorId))
    .where(
      and(
        eq(sponsorScannerDevicesTable.tokenHash, scannerTokenHash(token)),
        isNull(sponsorScannerDevicesTable.revokedAt),
      ),
    );
  if (
    !record ||
    record.revokedAt ||
    record.accessVersion !== record.sponsorAccessVersion ||
    !["confirmed", "completed"].includes(record.sponsorStatus)
  ) {
    res
      .status(401)
      .json({ error: "This scanner has been revoked or the sponsor link has changed" });
    return;
  }
  await db
    .update(sponsorScannerDevicesTable)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(sponsorScannerDevicesTable.id, record.id));
  (req as ScannerRequest).scannerDevice = {
    id: record.id,
    sponsorId: record.sponsorId,
    accessVersion: record.accessVersion,
    operatorName: record.operatorName,
    rawToken: token,
  };
  next();
}
