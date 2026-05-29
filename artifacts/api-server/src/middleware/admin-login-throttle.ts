import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

interface FailureState {
  count: number;
  lockedUntil: number;
}

const FAILURE_LADDER_MS = [0, 0, 0, 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

const state = new Map<string, FailureState>();

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function gc(now: number) {
  if (state.size < 1024) return;
  for (const [ip, s] of state) {
    if (s.lockedUntil < now - STATE_TTL_MS) state.delete(ip);
  }
}

function backoffFor(failures: number): number {
  if (failures < FAILURE_LADDER_MS.length) return FAILURE_LADDER_MS[failures];
  return MAX_BACKOFF_MS;
}

export function adminLoginThrottle(req: Request, res: Response, next: NextFunction): void {
  const ip = clientIp(req);
  const now = Date.now();
  gc(now);

  const s = state.get(ip);
  if (s && s.lockedUntil > now) {
    const retryAfterSec = Math.ceil((s.lockedUntil - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    logger.warn(
      { ip, retryAfterSec, failures: s.count },
      "Admin login blocked — IP in cool-off after repeated failures",
    );
    res.status(429).json({
      error: "Too many failed admin login attempts. Please wait before trying again.",
      retryAfter: retryAfterSec,
    });
    return;
  }

  next();
}

export function recordAdminLoginFailure(req: Request): {
  failures: number;
  lockedForMs: number;
} {
  const ip = clientIp(req);
  const now = Date.now();
  const prev = state.get(ip);
  const count = (prev?.count ?? 0) + 1;
  const lockedForMs = backoffFor(count);
  state.set(ip, { count, lockedUntil: now + lockedForMs });
  return { failures: count, lockedForMs };
}

export function recordAdminLoginSuccess(req: Request): void {
  state.delete(clientIp(req));
}

export function _resetAdminLoginThrottleForTests(): void {
  state.clear();
}
