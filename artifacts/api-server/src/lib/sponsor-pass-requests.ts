import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  sponsorsTable,
  sponsorPassRequestsTable,
  sponsorPromoCodesTable,
  promoCodesTable,
  sponsorActivityTable,
} from "@workspace/db";
import { SponsorConflictError, SponsorNotFoundError } from "./sponsor-service";

export async function requestAdditionalPasses(
  sponsorId: number,
  input: { requestedVip: number; requestedStaff: number; message: string | null },
) {
  if (
    ![input.requestedVip, input.requestedStaff].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 10000,
    ) ||
    input.requestedVip + input.requestedStaff < 1
  )
    throw new SponsorConflictError("Request between 1 and 10,000 additional passes");
  return db.transaction(async (tx) => {
    const [sponsor] = await tx
      .select()
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId))
      .for("update");
    if (!sponsor) throw new SponsorNotFoundError();
    if (!["confirmed", "completed"].includes(sponsor.status))
      throw new SponsorConflictError("This sponsor is not active");
    const [pending] = await tx
      .select()
      .from(sponsorPassRequestsTable)
      .where(
        and(
          eq(sponsorPassRequestsTable.sponsorId, sponsorId),
          eq(sponsorPassRequestsTable.status, "open"),
        ),
      )
      .orderBy(desc(sponsorPassRequestsTable.id));
    if (pending) {
      if (
        pending.requestedVip !== input.requestedVip ||
        pending.requestedStaff !== input.requestedStaff ||
        (pending.message ?? "") !== (input.message ?? "")
      )
        throw new SponsorConflictError(
          "Your earlier request is with the event team. Wait for its decision before requesting more passes.",
        );
      return { request: pending, created: false };
    }
    const [request] = await tx
      .insert(sponsorPassRequestsTable)
      .values({ sponsorId, ...input })
      .returning();
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: "passes_requested",
      actorType: "sponsor",
      data: { requestId: request.id, ...input },
    });
    return { request, created: true };
  });
}

export async function resolvePassRequest(
  sponsorId: number,
  requestId: number,
  decision: "approved" | "declined",
) {
  const status = decision === "approved" ? "resolved" : "declined";
  return db.transaction(async (tx) => {
    const [sponsor] = await tx
      .select()
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId))
      .for("update");
    if (!sponsor) throw new SponsorNotFoundError();
    const [request] = await tx
      .select()
      .from(sponsorPassRequestsTable)
      .where(
        and(
          eq(sponsorPassRequestsTable.id, requestId),
          eq(sponsorPassRequestsTable.sponsorId, sponsorId),
        ),
      )
      .for("update");
    if (!request) throw new SponsorNotFoundError();
    if (request.status === status) return { request, changed: false };
    if (request.status !== "open")
      throw new SponsorConflictError(
        "This request already has a different decision. Refresh its status.",
      );
    if (!["confirmed", "completed"].includes(sponsor.status))
      throw new SponsorConflictError("Reactivate this sponsor before resolving their request");
    if (decision === "approved") {
      const [vip] = await tx
        .select()
        .from(sponsorPromoCodesTable)
        .where(
          and(
            eq(sponsorPromoCodesTable.sponsorId, sponsorId),
            eq(sponsorPromoCodesTable.kind, "vip"),
          ),
        );
      if (!vip)
        throw new SponsorConflictError(
          "The sponsor's VIP code is missing. Resolve this before approving more passes.",
        );
      const vipAllocation = sponsor.vipAllocation + request.requestedVip;
      if (vipAllocation > 100000 || sponsor.staffAllocation + request.requestedStaff > 100000)
        throw new SponsorConflictError("The resulting allocation is too large");
      await tx
        .update(sponsorsTable)
        .set({
          vipAllocation,
          staffAllocation: sql`${sponsorsTable.staffAllocation} + ${request.requestedStaff}`,
          updatedAt: new Date(),
        })
        .where(eq(sponsorsTable.id, sponsorId));
      await tx
        .update(promoCodesTable)
        .set({ maxUses: vipAllocation, updatedAt: new Date() })
        .where(eq(promoCodesTable.id, vip.promoCodeId));
    }
    const [updated] = await tx
      .update(sponsorPassRequestsTable)
      .set({ status, resolvedAt: new Date() })
      .where(eq(sponsorPassRequestsTable.id, requestId))
      .returning();
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: "pass_request_resolved",
      actorType: "admin",
      data: {
        requestId,
        decision,
        requestedVip: request.requestedVip,
        requestedStaff: request.requestedStaff,
      },
    });
    return { request: updated, changed: true };
  });
}
