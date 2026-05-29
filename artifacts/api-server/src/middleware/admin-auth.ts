import { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import { getAdminPasswordEnv, getAdminTokenSecretEnv } from "../lib/env";
import { logger } from "../lib/logger";

const HMAC_SALT = "hrs-admin-token-v1";
const SIG_HEX_LEN = 64; // sha256 hex
const BLOCKED_PASSWORDS = new Set(["admin123", "admin", "password", "123456", "secret"]);

export const ADMIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The signing key for admin session tokens is intentionally separate from the
 * admin password: if it weren't, anyone who captured a single valid token
 * (`sig.exp`) could mount an *offline* dictionary attack on ADMIN_PASSWORD by
 * recomputing HMACs locally.
 *
 * Operators can set ADMIN_TOKEN_SECRET to a stable high-entropy string so
 * tokens survive process restarts. If unset, we generate a random 32-byte key
 * at startup — tokens then naturally expire on every restart, which is a
 * conservative default for an admin panel.
 */
let cachedSigningKey: Buffer | null = null;
function getSigningKey(): Buffer {
  if (cachedSigningKey) return cachedSigningKey;
  const fromEnv = getAdminTokenSecretEnv();
  if (fromEnv && fromEnv.length >= 32) {
    cachedSigningKey = Buffer.from(fromEnv, "utf8");
  } else {
    if (fromEnv) {
      logger.warn(
        "ADMIN_TOKEN_SECRET is set but shorter than 32 chars — ignoring and generating an ephemeral key",
      );
    } else {
      logger.warn(
        "ADMIN_TOKEN_SECRET is not set — generating an ephemeral admin token signing key (admin sessions will not survive process restarts). Set ADMIN_TOKEN_SECRET to a 32+ char random string to persist sessions.",
      );
    }
    cachedSigningKey = randomBytes(32);
  }
  return cachedSigningKey;
}

function hmacFor(expMs: number): string {
  return createHmac("sha256", getSigningKey()).update(`${HMAC_SALT}|${expMs}`).digest("hex");
}

/**
 * Issue a signed admin token of the form `<sigHex>.<expMs>`.
 * The signature is an HMAC-SHA256 over the salt + expiry keyed by a dedicated
 * server-side secret (see getSigningKey above) — never the password itself.
 */
export function issueAdminToken(
  _password: string,
  ttlMs: number = ADMIN_TOKEN_TTL_MS,
): {
  token: string;
  expiresAt: Date;
} {
  const expMs = Date.now() + ttlMs;
  const sig = hmacFor(expMs);
  return { token: `${sig}.${expMs}`, expiresAt: new Date(expMs) };
}

export function verifyAdminToken(
  token: string | undefined,
  _password: string,
): { valid: true } | { valid: false; reason: "missing" | "malformed" | "expired" | "bad_sig" } {
  if (!token) return { valid: false, reason: "missing" };
  const idx = token.lastIndexOf(".");
  if (idx <= 0 || idx === token.length - 1) return { valid: false, reason: "malformed" };
  const sig = token.slice(0, idx);
  const expStr = token.slice(idx + 1);
  // Strict signature shape: exactly 64 lowercase-hex chars for sha256.
  if (sig.length !== SIG_HEX_LEN || !/^[0-9a-f]+$/.test(sig)) {
    return { valid: false, reason: "malformed" };
  }
  const expMs = Number(expStr);
  if (!Number.isInteger(expMs) || expMs <= 0) return { valid: false, reason: "malformed" };
  if (Date.now() >= expMs) return { valid: false, reason: "expired" };

  const expectedSig = hmacFor(expMs);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length === 0 || a.length !== b.length) return { valid: false, reason: "bad_sig" };
  if (!timingSafeEqual(a, b)) return { valid: false, reason: "bad_sig" };
  return { valid: true };
}

/** Test-only: clears the cached signing key so unit tests can re-derive it. */
export function _resetSigningKeyForTests(): void {
  cachedSigningKey = null;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getAdminPassword(): string | null {
  const pw = getAdminPasswordEnv();
  if (!pw) return null;
  if (BLOCKED_PASSWORDS.has(pw)) return null;
  return pw;
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminPassword = getAdminPassword();

  if (!adminPassword) {
    res
      .status(503)
      .json({ error: "Admin authentication not configured — set a secure ADMIN_PASSWORD" });
    return;
  }

  const token = req.headers["x-admin-token"] as string | undefined;
  const result = verifyAdminToken(token, adminPassword);

  if (!result.valid) {
    if (result.reason === "expired") {
      res.status(401).json({ error: "Admin session expired — please log in again", expired: true });
    } else {
      res.status(401).json({ error: "Unauthorized — invalid admin token" });
    }
    return;
  }

  next();
}
