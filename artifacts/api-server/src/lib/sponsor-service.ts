import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  attendeesTable,
  bookingsTable,
  db,
  emailLogsTable,
  promoCodesTable,
  sponsorActivityTable,
  sponsorAssetsTable,
  sponsorContactsTable,
  sponsorDocumentAcknowledgementsTable,
  sponsorDocumentsTable,
  sponsorPresentersTable,
  sponsorPromoCodesTable,
  sponsorRedemptionsTable,
  sponsorSessionRevisionsTable,
  sponsorSessionsTable,
  sponsorsTable,
  sponsorTasksTable,
} from "@workspace/db";
import { formatSponsorAsset } from "./sponsor-assets";
import { issueSponsorAccessToken } from "../middleware/sponsor-auth";

export class SponsorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorConflictError";
  }
}

export class SponsorNotFoundError extends Error {
  constructor() {
    super("Sponsor not found");
    this.name = "SponsorNotFoundError";
  }
}

export function normalizeSponsorCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function suggestedSponsorCodes(company: string): { vip: string; public: string } {
  const base = normalizeSponsorCode(company);
  if (!base) throw new SponsorConflictError("The company name must contain a letter or number");
  return { vip: `${base}VIP`, public: base };
}

export function sponsorAccessUrl(sponsor: typeof sponsorsTable.$inferSelect): string {
  const base = (process.env.APP_BASE_URL ?? "https://register.swpsummit.com").replace(/\/$/, "");
  return `${base}/sponsor/access/${issueSponsorAccessToken(sponsor.id, sponsor.portalAccessVersion)}`;
}

export interface SponsorContactInput {
  role?: "primary" | "onsite" | "marketing" | "other";
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  email: string;
  phone?: string | null;
  isPrimary?: boolean;
}

export interface SponsorTaskInput {
  taskKey: string;
  label: string;
  required?: boolean;
  dueAt?: string | null;
  status?: "todo" | "submitted" | "completed" | "overdue" | "not_required";
}

export interface SponsorSessionEntitlementInput {
  type: "quickfire" | "keynote" | "other";
  entitlementLabel: string;
  headshotRequired?: boolean;
  takeawaysRequired?: boolean;
  slidesRequired?: boolean;
}

export interface SponsorUpsertInput {
  company: string;
  packageLabel: string;
  status?: "draft" | "confirmed" | "paused" | "completed" | "cancelled";
  confirmationDate?: string | null;
  notes?: string | null;
  vipAllocation: number;
  vipMaxPerBooking: number;
  staffAllocation: number;
  vipCode?: string;
  publicCode?: string;
  contacts?: SponsorContactInput[];
  tasks?: SponsorTaskInput[];
  sessions?: SponsorSessionEntitlementInput[];
}

const DEFAULT_TASKS: SponsorTaskInput[] = [
  { taskKey: "staff", label: "Sponsor staff", required: true },
  { taskKey: "sessions", label: "Session details", required: true },
  { taskKey: "speakers", label: "Speaker details", required: true },
  { taskKey: "assets", label: "Brand and content assets", required: true },
  { taskKey: "logistics", label: "Logistics", required: true },
  { taskKey: "onsite_contacts", label: "Onsite contacts", required: true },
  { taskKey: "slides", label: "Session slides", required: false },
  { taskKey: "community_social", label: "Community Social details", required: true },
];

function cleanInput(
  input: SponsorUpsertInput,
): SponsorUpsertInput & { vipCode: string; publicCode: string } {
  const company = input.company.trim();
  const packageLabel = input.packageLabel.trim();
  if (!company || !packageLabel)
    throw new SponsorConflictError("Company and package label are required");
  if (!Number.isInteger(input.vipAllocation) || input.vipAllocation < 0) {
    throw new SponsorConflictError("VIP allocation must be a whole number of zero or more");
  }
  if (!Number.isInteger(input.staffAllocation) || input.staffAllocation < 0) {
    throw new SponsorConflictError("Staff allocation must be a whole number of zero or more");
  }
  if (!Number.isInteger(input.vipMaxPerBooking) || input.vipMaxPerBooking < 1) {
    throw new SponsorConflictError("VIP maximum per booking must be at least one");
  }
  const suggestions = suggestedSponsorCodes(company);
  const vipCode = normalizeSponsorCode(input.vipCode || suggestions.vip);
  const publicCode = normalizeSponsorCode(input.publicCode || suggestions.public);
  if (!vipCode || !publicCode || vipCode === publicCode) {
    throw new SponsorConflictError(
      "VIP and public codes must be different and contain letters or numbers",
    );
  }
  return { ...input, company, packageLabel, vipCode, publicCode };
}

function primaryContactIsValid(contacts: SponsorContactInput[]): boolean {
  return contacts.some((contact) => contact.isPrimary || contact.role === "primary");
}

function validatedContacts(contacts: SponsorContactInput[]): SponsorContactInput[] {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const cleaned = contacts.map((contact) => ({
    ...contact,
    firstName: contact.firstName.trim(),
    lastName: contact.lastName.trim(),
    jobTitle: contact.jobTitle?.trim() || null,
    email: contact.email.trim().toLowerCase(),
    phone: contact.phone?.trim() || null,
  }));
  for (const contact of cleaned) {
    if (!contact.firstName || !contact.lastName || !emailPattern.test(contact.email)) {
      throw new SponsorConflictError(
        "Every sponsor contact needs a first name, last name and valid work email",
      );
    }
  }
  if (new Set(cleaned.map((contact) => contact.email)).size !== cleaned.length) {
    throw new SponsorConflictError("A sponsor contact email can only be entered once");
  }
  if (cleaned.length && !primaryContactIsValid(cleaned)) {
    return cleaned.map((contact, index) =>
      index === 0 ? { ...contact, isPrimary: true, role: "primary" as const } : contact,
    );
  }
  return cleaned;
}

async function insertContacts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sponsorId: number,
  contacts: SponsorContactInput[],
): Promise<void> {
  if (!contacts.length) return;
  const cleaned = validatedContacts(contacts);
  await tx.insert(sponsorContactsTable).values(
    cleaned.map((contact) => ({
      sponsorId,
      role: contact.role ?? (contact.isPrimary ? "primary" : "other"),
      firstName: contact.firstName,
      lastName: contact.lastName,
      jobTitle: contact.jobTitle,
      email: contact.email,
      phone: contact.phone,
      isPrimary: Boolean(contact.isPrimary || contact.role === "primary"),
    })),
  );
}

async function insertTasks(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sponsorId: number,
  tasks: SponsorTaskInput[],
): Promise<void> {
  const seen = new Set<string>();
  for (const task of tasks) {
    const taskKey = task.taskKey.trim();
    const label = task.label.trim();
    if (!taskKey || !label || seen.has(taskKey)) {
      throw new SponsorConflictError("Sponsor deliverables need a unique key and label");
    }
    seen.add(taskKey);
    const required = task.required ?? true;
    const dueAt = task.dueAt ? new Date(task.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      throw new SponsorConflictError(`The deadline for ${label} is not a valid date`);
    }
    const status = required ? (task.status ?? "todo") : "not_required";
    await tx
      .insert(sponsorTasksTable)
      .values({
        sponsorId,
        taskKey,
        label,
        required,
        dueAt,
        status,
        completedAt: status === "completed" ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [sponsorTasksTable.sponsorId, sponsorTasksTable.taskKey],
        set: { label, required, dueAt, status, updatedAt: new Date() },
      });
  }
}

async function insertSessionEntitlements(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sponsorId: number,
  sessions: SponsorSessionEntitlementInput[],
): Promise<void> {
  if (!sessions.length) return;
  const cleaned = sessions.map((session) => ({
    ...session,
    entitlementLabel: session.entitlementLabel.trim(),
  }));
  if (cleaned.some((session) => !session.entitlementLabel)) {
    throw new SponsorConflictError("Every session entitlement needs a label");
  }
  await tx.insert(sponsorSessionsTable).values(
    cleaned.map((session) => ({
      sponsorId,
      type: session.type,
      entitlementLabel: session.entitlementLabel.trim(),
      headshotRequired: session.headshotRequired ?? true,
      takeawaysRequired: session.takeawaysRequired ?? true,
      slidesRequired: session.slidesRequired ?? false,
    })),
  );
}

export async function createSponsorDraft(input: SponsorUpsertInput) {
  const clean = cleanInput(input);
  if (input.status && input.status !== "draft") {
    throw new SponsorConflictError("New sponsors are created as drafts and confirmed separately");
  }
  const sponsor = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(sponsorsTable)
      .values({
        company: clean.company,
        packageLabel: clean.packageLabel,
        confirmationDate: clean.confirmationDate ?? null,
        notes: clean.notes?.trim() || null,
        vipAllocation: clean.vipAllocation,
        vipMaxPerBooking: clean.vipMaxPerBooking,
        staffAllocation: clean.staffAllocation,
        vipCodeDraft: clean.vipCode,
        publicCodeDraft: clean.publicCode,
      })
      .returning();
    await insertContacts(tx, created.id, clean.contacts ?? []);
    const defaultTasks = DEFAULT_TASKS.map((task) => {
      if (task.taskKey === "staff") return { ...task, required: clean.staffAllocation > 0 };
      if (["sessions", "speakers"].includes(task.taskKey)) {
        return { ...task, required: (clean.sessions?.length ?? 0) > 0 };
      }
      if (task.taskKey === "slides") {
        return {
          ...task,
          required: Boolean(clean.sessions?.some((session) => session.slidesRequired)),
        };
      }
      return task;
    });
    await insertTasks(tx, created.id, clean.tasks?.length ? clean.tasks : defaultTasks);
    await insertSessionEntitlements(tx, created.id, clean.sessions ?? []);
    await tx.insert(sponsorActivityTable).values({
      sponsorId: created.id,
      type: "sponsor_created",
      actorType: "admin",
      data: { status: "draft", company: created.company },
    });
    return created;
  });
  return buildSponsorWorkspace(sponsor.id, true);
}

export async function assertCodeAvailability(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  codes: string[],
  sponsorId?: number,
): Promise<void> {
  const collisions = await tx
    .select({ code: promoCodesTable.code, sponsorId: sponsorPromoCodesTable.sponsorId })
    .from(promoCodesTable)
    .leftJoin(sponsorPromoCodesTable, eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id))
    .where(inArray(sql<string>`upper(${promoCodesTable.code})`, codes));
  const blocked = collisions.filter((item) => item.sponsorId !== sponsorId);
  if (blocked.length) {
    throw new SponsorConflictError(
      `Promo code already exists: ${blocked.map((item) => item.code).join(", ")}. Choose a different code.`,
    );
  }
}

export async function confirmSponsor(sponsorId: number) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM sponsors WHERE id = ${sponsorId} FOR UPDATE`);
    const [sponsor] = await tx.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
    if (!sponsor) throw new SponsorNotFoundError();
    if (sponsor.status !== "draft") {
      throw new SponsorConflictError("Only a draft sponsor can be confirmed");
    }
    const contacts = await tx
      .select()
      .from(sponsorContactsTable)
      .where(eq(sponsorContactsTable.sponsorId, sponsorId));
    if (!primaryContactIsValid(contacts)) {
      throw new SponsorConflictError("Add a primary sponsor contact before confirming");
    }
    await assertCodeAvailability(tx, [sponsor.vipCodeDraft, sponsor.publicCodeDraft]);
    const [vip] = await tx
      .insert(promoCodesTable)
      .values({
        code: sponsor.vipCodeDraft,
        discountType: "complimentary",
        discountValue: "100",
        maxUses: sponsor.vipAllocation,
        applicablePassTypes: ["single"],
        maxQuantityPerBooking: sponsor.vipMaxPerBooking,
        description: `${sponsor.company} private VIP Workforce passes`,
        internalNote: `Sponsor VIP code for sponsor #${sponsor.id}`,
      })
      .returning();
    const [publicCode] = await tx
      .insert(promoCodesTable)
      .values({
        code: sponsor.publicCodeDraft,
        discountType: "percentage",
        discountValue: "20",
        maxUses: null,
        applicablePassTypes: ["single"],
        description: `20% off Workforce passes with ${sponsor.company}`,
        internalNote: `Public sponsor code for sponsor #${sponsor.id}; stacks after group discount`,
      })
      .returning();
    await tx.insert(sponsorPromoCodesTable).values([
      { sponsorId, promoCodeId: vip.id, kind: "vip" },
      { sponsorId, promoCodeId: publicCode.id, kind: "public" },
    ]);
    const now = new Date();
    await tx
      .update(sponsorsTable)
      .set({
        status: "confirmed",
        confirmedAt: now,
        confirmationDate: sponsor.confirmationDate ?? now.toISOString().slice(0, 10),
        updatedAt: now,
      })
      .where(eq(sponsorsTable.id, sponsorId));
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: "sponsor_confirmed",
      actorType: "admin",
      data: { vipCode: vip.code, publicCode: publicCode.code },
    });
  });
  return buildSponsorWorkspace(sponsorId, true);
}

async function activeStaffCount(sponsorId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.sponsorId, sponsorId),
        eq(bookingsTable.registrationSource, "sponsor_staff"),
        inArray(bookingsTable.status, ["paid", "invoiced"]),
      ),
    );
  return row?.count ?? 0;
}

async function activeVipUnits(sponsorId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`coalesce(sum(${sponsorRedemptionsTable.units}), 0)::int` })
    .from(sponsorRedemptionsTable)
    .where(
      and(
        eq(sponsorRedemptionsTable.sponsorId, sponsorId),
        eq(sponsorRedemptionsTable.status, "reserved"),
      ),
    );
  return row?.count ?? 0;
}

export async function updateSponsor(sponsorId: number, input: SponsorUpsertInput) {
  const clean = cleanInput(input);
  const [existing] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
  if (!existing) throw new SponsorNotFoundError();
  if (existing.status === "draft" && input.status === "confirmed") {
    throw new SponsorConflictError(
      "Use Confirm sponsor so codes and the workspace are created together",
    );
  }
  if (existing.status !== "draft" && input.status === "draft") {
    throw new SponsorConflictError("A confirmed sponsor cannot be moved back to draft");
  }
  if (
    existing.status === "draft" &&
    input.status &&
    !["draft", "cancelled"].includes(input.status)
  ) {
    throw new SponsorConflictError("Confirm the draft before using this sponsor status");
  }
  const [staffUsed, vipUsed] = await Promise.all([
    activeStaffCount(sponsorId),
    activeVipUnits(sponsorId),
  ]);
  if (clean.staffAllocation < staffUsed) {
    throw new SponsorConflictError(
      `Staff allocation cannot be below ${staffUsed} active registrations`,
    );
  }
  if (clean.vipAllocation < vipUsed) {
    throw new SponsorConflictError(`VIP allocation cannot be below ${vipUsed} active passes`);
  }

  await db.transaction(async (tx) => {
    await assertCodeAvailability(tx, [clean.vipCode, clean.publicCode], sponsorId);
    const nextStatus = input.status ?? existing.status;
    const now = new Date();
    await tx
      .update(sponsorsTable)
      .set({
        company: clean.company,
        packageLabel: clean.packageLabel,
        status: nextStatus,
        confirmationDate: clean.confirmationDate ?? null,
        notes: clean.notes?.trim() || null,
        vipAllocation: clean.vipAllocation,
        vipMaxPerBooking: clean.vipMaxPerBooking,
        staffAllocation: clean.staffAllocation,
        vipCodeDraft: clean.vipCode,
        publicCodeDraft: clean.publicCode,
        pausedAt: nextStatus === "paused" ? now : null,
        cancelledAt: nextStatus === "cancelled" ? now : null,
        updatedAt: now,
      })
      .where(eq(sponsorsTable.id, sponsorId));

    const mappedCodes = await tx
      .select({ kind: sponsorPromoCodesTable.kind, promoId: promoCodesTable.id })
      .from(sponsorPromoCodesTable)
      .innerJoin(promoCodesTable, eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id))
      .where(eq(sponsorPromoCodesTable.sponsorId, sponsorId));
    const active = nextStatus !== "paused" && nextStatus !== "cancelled";
    for (const mapped of mappedCodes) {
      await tx
        .update(promoCodesTable)
        .set(
          mapped.kind === "vip"
            ? {
                code: clean.vipCode,
                maxUses: clean.vipAllocation,
                maxQuantityPerBooking: clean.vipMaxPerBooking,
                isActive: active,
                updatedAt: now,
              }
            : { code: clean.publicCode, isActive: active, updatedAt: now },
        )
        .where(eq(promoCodesTable.id, mapped.promoId));
    }

    if (clean.contacts) {
      await tx.delete(sponsorContactsTable).where(eq(sponsorContactsTable.sponsorId, sponsorId));
      await insertContacts(tx, sponsorId, clean.contacts);
    }
    if (clean.tasks) {
      await insertTasks(tx, sponsorId, clean.tasks);
    }
    if (clean.sessions && existing.status === "draft") {
      await tx.delete(sponsorSessionsTable).where(eq(sponsorSessionsTable.sponsorId, sponsorId));
      await insertSessionEntitlements(tx, sponsorId, clean.sessions);
    }
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: existing.status === nextStatus ? "sponsor_updated" : "sponsor_status_changed",
      actorType: "admin",
      data: { fromStatus: existing.status, toStatus: nextStatus },
    });
  });
  return buildSponsorWorkspace(sponsorId, true);
}

export async function rotateSponsorAccess(sponsorId: number): Promise<string> {
  const [sponsor] = await db
    .update(sponsorsTable)
    .set({
      portalAccessVersion: sql`${sponsorsTable.portalAccessVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sponsorsTable.id, sponsorId))
    .returning();
  if (!sponsor) throw new SponsorNotFoundError();
  await db.insert(sponsorActivityTable).values({
    sponsorId,
    type: "access_rotated",
    actorType: "admin",
    data: { accessVersion: sponsor.portalAccessVersion },
  });
  return sponsorAccessUrl(sponsor);
}

function formatStaffRow(row: {
  booking: typeof bookingsTable.$inferSelect;
  attendee: typeof attendeesTable.$inferSelect;
}) {
  return {
    bookingId: row.booking.id,
    attendeeId: row.attendee.id,
    firstName: row.attendee.firstName,
    lastName: row.attendee.lastName,
    jobTitle: row.attendee.jobTitle,
    company: row.attendee.company,
    workEmail: row.attendee.workEmail,
    phone: row.attendee.phone,
    dietaryAccessibility: row.attendee.dietaryAccessibility,
    communitySocialAttending: row.attendee.communitySocialAttending,
    communitySocialDietary: row.attendee.communitySocialDietary,
    marketingConsent: row.attendee.gdprConsent,
    status: row.booking.status,
    registeredAt: row.booking.createdAt.toISOString(),
  };
}

async function loadCodeViews(sponsorId: number) {
  const mappings = await db
    .select({ kind: sponsorPromoCodesTable.kind, promo: promoCodesTable })
    .from(sponsorPromoCodesTable)
    .innerJoin(promoCodesTable, eq(sponsorPromoCodesTable.promoCodeId, promoCodesTable.id))
    .where(eq(sponsorPromoCodesTable.sponsorId, sponsorId));
  const result = [];
  const base = (process.env.APP_BASE_URL ?? "https://register.swpsummit.com").replace(/\/$/, "");
  for (const mapping of mappings) {
    const bookings = await db
      .select({ booking: bookingsTable, attendee: attendeesTable })
      .from(bookingsTable)
      .innerJoin(attendeesTable, eq(attendeesTable.bookingId, bookingsTable.id))
      .where(
        and(
          eq(bookingsTable.promoCode, mapping.promo.code),
          inArray(bookingsTable.status, ["paid", "invoiced"]),
        ),
      )
      .orderBy(desc(bookingsTable.createdAt));
    result.push({
      kind: mapping.kind,
      code: mapping.promo.code,
      active: mapping.promo.isActive,
      workforceUrl: `${base}/?pass=single&promo=${encodeURIComponent(mapping.promo.code)}`,
      allocation: mapping.kind === "vip" ? mapping.promo.maxUses : null,
      used: mapping.promo.usedCount,
      remaining:
        mapping.kind === "vip" && mapping.promo.maxUses !== null
          ? Math.max(0, mapping.promo.maxUses - mapping.promo.usedCount)
          : null,
      maxPerBooking: mapping.kind === "vip" ? mapping.promo.maxQuantityPerBooking : null,
      discountPercent:
        mapping.kind === "public" ? Number(mapping.promo.discountValue.toString()) : null,
      redemptions: bookings.map((row) => ({
        bookingId: row.booking.id,
        firstName: row.attendee.firstName,
        lastName: row.attendee.lastName,
        company: row.attendee.company,
        jobTitle: row.attendee.jobTitle,
        registeredAt: row.booking.createdAt.toISOString(),
      })),
    });
  }
  return result;
}

async function loadSessions(sponsorId: number) {
  const sessions = await db
    .select()
    .from(sponsorSessionsTable)
    .where(eq(sponsorSessionsTable.sponsorId, sponsorId))
    .orderBy(asc(sponsorSessionsTable.id));
  return Promise.all(
    sessions.map(async (session) => {
      const [presenters, revisions] = await Promise.all([
        db
          .select()
          .from(sponsorPresentersTable)
          .where(eq(sponsorPresentersTable.sessionId, session.id))
          .orderBy(asc(sponsorPresentersTable.displayOrder)),
        db
          .select()
          .from(sponsorSessionRevisionsTable)
          .where(eq(sponsorSessionRevisionsTable.sessionId, session.id))
          .orderBy(desc(sponsorSessionRevisionsTable.revision)),
      ]);
      return {
        ...session,
        submittedAt: session.submittedAt?.toISOString() ?? null,
        approvedAt: session.approvedAt?.toISOString() ?? null,
        exportedAt: session.exportedAt?.toISOString() ?? null,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        exportOutdated:
          session.exportedRevision !== null && session.exportedRevision !== session.currentRevision,
        presenters: presenters.map((presenter) => ({
          ...presenter,
          createdAt: presenter.createdAt.toISOString(),
          updatedAt: presenter.updatedAt.toISOString(),
        })),
        revisions: revisions.map((revision) => ({
          revision: revision.revision,
          actor: revision.actor,
          createdAt: revision.createdAt.toISOString(),
        })),
      };
    }),
  );
}

export async function buildSponsorWorkspace(sponsorId: number, admin: boolean) {
  const [sponsor] = await db.select().from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
  if (!sponsor) throw new SponsorNotFoundError();
  const [
    contacts,
    codes,
    staffRows,
    tasks,
    sessions,
    assets,
    documents,
    activity,
    failedEmailCount,
  ] = await Promise.all([
    db
      .select()
      .from(sponsorContactsTable)
      .where(eq(sponsorContactsTable.sponsorId, sponsorId))
      .orderBy(desc(sponsorContactsTable.isPrimary), asc(sponsorContactsTable.id)),
    loadCodeViews(sponsorId),
    db
      .select({ booking: bookingsTable, attendee: attendeesTable })
      .from(bookingsTable)
      .innerJoin(attendeesTable, eq(attendeesTable.bookingId, bookingsTable.id))
      .where(
        and(
          eq(bookingsTable.sponsorId, sponsorId),
          eq(bookingsTable.registrationSource, "sponsor_staff"),
        ),
      )
      .orderBy(desc(bookingsTable.createdAt)),
    db
      .select()
      .from(sponsorTasksTable)
      .where(eq(sponsorTasksTable.sponsorId, sponsorId))
      .orderBy(asc(sponsorTasksTable.id)),
    loadSessions(sponsorId),
    db
      .select()
      .from(sponsorAssetsTable)
      .where(eq(sponsorAssetsTable.sponsorId, sponsorId))
      .orderBy(desc(sponsorAssetsTable.createdAt)),
    db
      .select()
      .from(sponsorDocumentsTable)
      .where(eq(sponsorDocumentsTable.sponsorId, sponsorId))
      .orderBy(asc(sponsorDocumentsTable.id)),
    admin
      ? db
          .select()
          .from(sponsorActivityTable)
          .where(eq(sponsorActivityTable.sponsorId, sponsorId))
          .orderBy(desc(sponsorActivityTable.createdAt))
          .limit(250)
      : Promise.resolve([]),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailLogsTable)
      .where(and(eq(emailLogsTable.sponsorId, sponsorId), eq(emailLogsTable.status, "failed"))),
  ]);
  const activeStaff = staffRows.filter((row) => ["paid", "invoiced"].includes(row.booking.status));
  const vipCode = codes.find((code) => code.kind === "vip");
  const requiredTasks = tasks.filter((task) => task.required);
  const completeTasks = requiredTasks.filter((task) => task.status === "completed");
  const needsAttention =
    tasks.filter((task) => task.status === "overdue").length +
    sessions.filter((session) => session.status === "changes_requested").length +
    assets.filter((asset) => asset.status === "missing").length +
    (failedEmailCount[0]?.count ?? 0);
  const summary = {
    id: sponsor.id,
    company: sponsor.company,
    packageLabel: sponsor.packageLabel,
    status: sponsor.status,
    confirmationDate: sponsor.confirmationDate,
    vipAllocation: sponsor.vipAllocation,
    vipUsed: vipCode?.used ?? 0,
    staffAllocation: sponsor.staffAllocation,
    staffUsed: activeStaff.length,
    progressCompleted: completeTasks.length,
    progressTotal: requiredTasks.length,
    needsAttention,
    updatedAt: sponsor.updatedAt.toISOString(),
  };
  const invitationCopy = {
    vip: vipCode
      ? `You are invited to join us at SWP Summit 2027 with a complimentary Workforce Pass. Register here: ${vipCode.workforceUrl}`
      : "Your private VIP invitation will be available once the sponsor is confirmed.",
    public: codes.find((code) => code.kind === "public")
      ? `Join us at SWP Summit 2027 and use code ${codes.find((code) => code.kind === "public")?.code} for 20% off Workforce Passes: ${codes.find((code) => code.kind === "public")?.workforceUrl}`
      : "Your public discount copy will be available once the sponsor is confirmed.",
  };
  const common = {
    sponsor: summary,
    contacts: contacts.map((contact) => ({
      ...contact,
      createdAt: contact.createdAt.toISOString(),
      updatedAt: contact.updatedAt.toISOString(),
    })),
    codes,
    staff: staffRows.map(formatStaffRow),
    tasks: tasks.map((task) => ({
      ...task,
      dueAt: task.dueAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
    sessions,
    assets: assets.map((asset) => formatSponsorAsset(asset, sponsor.company)),
    documents: await Promise.all(
      documents.map(async (document) => {
        const [acknowledgement] = await db
          .select()
          .from(sponsorDocumentAcknowledgementsTable)
          .where(
            and(
              eq(sponsorDocumentAcknowledgementsTable.documentId, document.id),
              eq(sponsorDocumentAcknowledgementsTable.version, document.acknowledgementVersion),
            ),
          );
        return {
          ...document,
          acknowledged: Boolean(acknowledgement),
          acknowledgedBy: acknowledgement?.acknowledgedBy ?? null,
          acknowledgedAt: acknowledgement?.acknowledgedAt.toISOString() ?? null,
          createdAt: document.createdAt.toISOString(),
          updatedAt: document.updatedAt.toISOString(),
        };
      }),
    ),
    invitationCopy,
  };
  if (!admin) return { ...summary, ...common };
  return {
    ...summary,
    ...common,
    notes: sponsor.notes,
    vipCodeDraft: sponsor.vipCodeDraft,
    publicCodeDraft: sponsor.publicCodeDraft,
    accessUrl: ["confirmed", "completed"].includes(sponsor.status)
      ? sponsorAccessUrl(sponsor)
      : null,
    welcomeEmailSentAt: sponsor.welcomeEmailSentAt?.toISOString() ?? null,
    activity: activity.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}

export async function listSponsorSummaries(filters: { status?: string; search?: string }) {
  const conditions = [];
  if (filters.status) conditions.push(eq(sponsorsTable.status, filters.status as never));
  if (filters.search) {
    conditions.push(
      sql`lower(${sponsorsTable.company}) like ${`%${filters.search.toLowerCase()}%`}`,
    );
  }
  const sponsors = await db
    .select({ id: sponsorsTable.id })
    .from(sponsorsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sponsorsTable.updatedAt));
  const workspaces = await Promise.all(sponsors.map(({ id }) => buildSponsorWorkspace(id, true)));
  return workspaces.map((workspace) => ({
    id: workspace.id,
    company: workspace.company,
    packageLabel: workspace.packageLabel,
    status: workspace.status,
    confirmationDate: workspace.confirmationDate,
    vipAllocation: workspace.vipAllocation,
    vipUsed: workspace.vipUsed,
    staffAllocation: workspace.staffAllocation,
    staffUsed: workspace.staffUsed,
    progressCompleted: workspace.progressCompleted,
    progressTotal: workspace.progressTotal,
    needsAttention: workspace.needsAttention,
    updatedAt: workspace.updatedAt,
  }));
}
