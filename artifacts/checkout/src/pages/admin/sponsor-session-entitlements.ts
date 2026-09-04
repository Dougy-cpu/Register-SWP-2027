export const SPONSOR_SESSION_TYPES = ["quickfire", "keynote", "other"] as const;

export type SponsorSessionEntitlementType = (typeof SPONSOR_SESSION_TYPES)[number];

export interface SponsorSessionEntitlementDraft {
  clientId: string;
  type: SponsorSessionEntitlementType;
  entitlementLabel: string;
  headshotRequired: boolean;
  takeawaysRequired: boolean;
  slidesRequired: boolean;
}

export type SponsorSessionEntitlementPayload = Omit<SponsorSessionEntitlementDraft, "clientId">;

export function createSponsorSessionEntitlement(clientId: string): SponsorSessionEntitlementDraft {
  return {
    clientId,
    type: "quickfire",
    entitlementLabel: "",
    headshotRequired: true,
    takeawaysRequired: true,
    slidesRequired: false,
  };
}

export function updateSponsorSessionEntitlement(
  sessions: SponsorSessionEntitlementDraft[],
  clientId: string,
  patch: Partial<Omit<SponsorSessionEntitlementDraft, "clientId">>,
): SponsorSessionEntitlementDraft[] {
  return sessions.map((session) =>
    session.clientId === clientId ? { ...session, ...patch } : session,
  );
}

export function removeSponsorSessionEntitlement(
  sessions: SponsorSessionEntitlementDraft[],
  clientId: string,
): SponsorSessionEntitlementDraft[] {
  return sessions.filter((session) => session.clientId !== clientId);
}

export function sponsorSessionEntitlementError(
  sessions: SponsorSessionEntitlementDraft[],
): string | null {
  const invalidIndex = sessions.findIndex((session) => !session.entitlementLabel.trim());
  if (invalidIndex >= 0) {
    return `Enter an entitlement label for session ${invalidIndex + 1}.`;
  }
  const longIndex = sessions.findIndex((session) => session.entitlementLabel.trim().length > 250);
  if (longIndex >= 0) {
    return `Keep the entitlement label for session ${longIndex + 1} to 250 characters or fewer.`;
  }
  return null;
}

export function sponsorSessionPayload(
  sessions: SponsorSessionEntitlementDraft[],
): SponsorSessionEntitlementPayload[] {
  return sessions.map(({ clientId: _clientId, ...session }) => ({
    ...session,
    entitlementLabel: session.entitlementLabel.trim(),
  }));
}

export function sponsorSessionTaskRequirements(sessions: SponsorSessionEntitlementDraft[]): {
  sessionsRequired: boolean;
  slidesRequired: boolean;
} {
  return {
    sessionsRequired: sessions.length > 0,
    slidesRequired: sessions.some((session) => session.slidesRequired),
  };
}
