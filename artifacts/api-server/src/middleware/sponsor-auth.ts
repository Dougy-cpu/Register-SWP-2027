import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, sponsorsTable } from "@workspace/db";
import { isProductionEnv } from "../lib/env";
import { logger } from "../lib/logger";

const ACCESS_SALT = "swp-sponsor-access-v1";
const SESSION_SALT = "swp-sponsor-session-v1";
const SESSION_COOKIE = "swp_sponsor_session";
const CSRF_COOKIE = "swp_sponsor_csrf";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SponsorSession {
  sponsorId: number;
  accessVersion: number;
  csrfToken: string;
}

export interface SponsorRequest extends Request {
  sponsorSession: SponsorSession;
}

let ephemeralSecret: Buffer | undefined;

function signingSecret(): Buffer {
  const configured = process.env.SPONSOR_TOKEN_SECRET ?? process.env.ADMIN_TOKEN_SECRET;
  if (configured && configured.length >= 32) return Buffer.from(configured, "utf8");
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32);
    logger.warn(
      "SPONSOR_TOKEN_SECRET is not configured; sponsor access links and sessions will be revoked on restart",
    );
  }
  return ephemeralSecret;
}

function signature(value: string, salt: string): string {
  return createHmac("sha256", signingSecret()).update(`${salt}|${value}`).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const values: Record<string, string> = {};
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index < 1) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    try {
      values[key] = decodeURIComponent(value);
    } catch {
      values[key] = value;
    }
  }
  return values;
}

export function issueSponsorAccessToken(sponsorId: number, accessVersion: number): string {
  const value = `${sponsorId}.${accessVersion}`;
  return `${value}.${signature(value, ACCESS_SALT)}`;
}

export function verifySponsorAccessToken(
  token: string,
): { sponsorId: number; accessVersion: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const sponsorId = Number(parts[0]);
  const accessVersion = Number(parts[1]);
  if (!Number.isInteger(sponsorId) || sponsorId < 1) return null;
  if (!Number.isInteger(accessVersion) || accessVersion < 1) return null;
  const value = `${sponsorId}.${accessVersion}`;
  return safeEqual(parts[2], signature(value, ACCESS_SALT)) ? { sponsorId, accessVersion } : null;
}

function issueSessionValue(sponsorId: number, accessVersion: number, csrfToken: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const value = `${sponsorId}.${accessVersion}.${expiresAt}.${csrfToken}`;
  return `${value}.${signature(value, SESSION_SALT)}`;
}

function verifySessionValue(value: string): SponsorSession | null {
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const sponsorId = Number(parts[0]);
  const accessVersion = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  const csrfToken = parts[3];
  if (!Number.isInteger(sponsorId) || sponsorId < 1) return null;
  if (!Number.isInteger(accessVersion) || accessVersion < 1) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(csrfToken)) return null;
  const unsigned = parts.slice(0, 4).join(".");
  if (!safeEqual(parts[4], signature(unsigned, SESSION_SALT))) return null;
  return { sponsorId, accessVersion, csrfToken };
}

export function setSponsorSessionCookie(
  res: Response,
  sponsorId: number,
  accessVersion: number,
): void {
  const csrfToken = randomBytes(24).toString("base64url");
  const secure = isProductionEnv();
  res.cookie(SESSION_COOKIE, issueSessionValue(sponsorId, accessVersion, csrfToken), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/api/sponsor",
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSponsorSessionCookies(res: Response): void {
  const secure = isProductionEnv();
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/api/sponsor",
  });
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, secure, sameSite: "lax", path: "/" });
}

export async function sponsorAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookies = parseCookies(req);
  const session = cookies[SESSION_COOKIE] ? verifySessionValue(cookies[SESSION_COOKIE]) : null;
  if (!session) {
    res.status(401).json({ error: "This sponsor workspace session has expired" });
    return;
  }

  const [sponsor] = await db
    .select({ accessVersion: sponsorsTable.portalAccessVersion, status: sponsorsTable.status })
    .from(sponsorsTable)
    .where(eq(sponsorsTable.id, session.sponsorId));

  if (
    !sponsor ||
    sponsor.accessVersion !== session.accessVersion ||
    !["confirmed", "completed"].includes(sponsor.status)
  ) {
    clearSponsorSessionCookies(res);
    res.status(401).json({ error: "This sponsor workspace link has been revoked or paused" });
    return;
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const supplied = req.headers["x-sponsor-csrf"];
    const csrfCookie = cookies[CSRF_COOKIE];
    if (
      typeof supplied !== "string" ||
      !csrfCookie ||
      !safeEqual(supplied, session.csrfToken) ||
      !safeEqual(csrfCookie, session.csrfToken)
    ) {
      res.status(403).json({ error: "Sponsor workspace security token is missing or invalid" });
      return;
    }
  }

  (req as SponsorRequest).sponsorSession = session;
  next();
}

export function _resetSponsorSecretForTests(): void {
  ephemeralSecret = undefined;
}
