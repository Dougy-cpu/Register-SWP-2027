import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { rateLimit } from "express-rate-limit";
import { db, sponsorScannerDevicesTable } from "@workspace/db";
import { sponsorAuth, type SponsorRequest } from "../middleware/sponsor-auth";
import { scannerTokenHash } from "../middleware/scanner-auth";
import {
  companyKey,
  companyForKey,
  scannerRoster,
  provisionRep,
  repSecrets,
  sameSecret,
} from "../lib/scanner-team";

export const scannerTeamAccess = Router();
scannerTeamAccess.use(["/sponsor/scanner/team", "/scanner-team"], (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});
const badAttempts = rateLimit({
  windowMs: 600_000,
  limit: 15,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many unsuccessful attempts. Use your personal link or try later." },
});
const perRep = rateLimit({
  windowMs: 600_000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => String(req.body?.repId ?? "").slice(0, 80),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many incorrect codes for this person. Use their personal link." },
});
scannerTeamAccess.get("/sponsor/scanner/team", sponsorAuth, async (req, res) => {
  const { sponsorId, accessVersion } = (req as SponsorRequest).sponsorSession;
  res.json({
    companyKey: companyKey(sponsorId, accessVersion),
    staff: await scannerRoster(sponsorId),
  });
});
scannerTeamAccess.post("/sponsor/scanner/team/:repId", sponsorAuth, async (req, res) => {
  const grant = await provisionRep(
    (req as SponsorRequest).sponsorSession.sponsorId,
    String(req.params.repId),
    req.body?.renew === true,
  );
  if (!grant) {
    res.status(409).json({
      error:
        "This rep is unavailable or their access needs renewing. Check their registration before renewing access.",
    });
    return;
  }
  res.json(grant);
});
scannerTeamAccess.post("/scanner-team/roster", badAttempts, async (req, res) => {
  const sponsor = await companyForKey(req.body?.companyKey);
  if (!sponsor) {
    res.status(403).json({
      error: "This team link is no longer valid. Ask your coordinator for the current link.",
    });
    return;
  }
  res.json({
    sponsorId: sponsor.id,
    sponsorCompany: sponsor.company,
    staff: await scannerRoster(sponsor.id),
  });
});
scannerTeamAccess.post("/scanner-team/access", badAttempts, perRep, async (req, res) => {
  const sponsor = await companyForKey(req.body?.companyKey);
  const refuse = () =>
    res.status(403).json({
      error: "Check your rep code or ask your coordinator for your personal scanner link.",
    });
  const { repId, pin } = req.body ?? {};
  if (!sponsor || typeof repId !== "string" || typeof pin !== "string" || !/^\d{8}$/.test(pin)) {
    refuse();
    return;
  }
  const member = (await scannerRoster(sponsor.id)).find((m) => m.id === repId);
  if (!member) {
    refuse();
    return;
  }
  const [d] = await db
    .select()
    .from(sponsorScannerDevicesTable)
    .where(
      and(
        eq(sponsorScannerDevicesTable.id, repId),
        eq(sponsorScannerDevicesTable.sponsorId, sponsor.id),
      ),
    );
  if (!d || d.revokedAt || d.accessVersion !== sponsor.version) {
    refuse();
    return;
  }
  const secret = repSecrets(d.id, d.accessVersion, d.activatedAt);
  if (!sameSecret(pin, secret.pin) || !sameSecret(scannerTokenHash(secret.token), d.tokenHash)) {
    refuse();
    return;
  }
  res.json({
    id: d.id,
    sponsorId: sponsor.id,
    sponsorCompany: sponsor.company,
    operatorName: member.name,
    token: secret.token,
  });
});
