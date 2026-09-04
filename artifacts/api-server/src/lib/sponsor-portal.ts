import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  attendeesTable,
  bookingsTable,
  sponsorsTable,
  sponsorContactsTable,
  sponsorTasksTable,
  sponsorActivityTable,
  sponsorPresentersTable,
  sponsorAssetsTable,
} from "@workspace/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class SponsorPortalError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface PresenterInput {
  id?: number;
  name: string;
  jobTitle: string;
  company: string;
  biography: string | null;
  displayOrder: number;
}

export function planPresenterUpdates(existing: Array<{ id: number }>, incoming: PresenterInput[]) {
  const known = new Set(existing.map((person) => person.id));
  const claimed = new Set<number>();
  const values = incoming.map((person, index) => {
    // Older clients omitted IDs. Preserve their existing positions as well as new clients' IDs.
    const id = person.id ?? existing[index]?.id;
    if (id !== undefined && (!Number.isInteger(id) || !known.has(id) || claimed.has(id))) {
      throw new SponsorPortalError(
        "This speaker has changed. Refresh the session before saving.",
        409,
      );
    }
    if (id !== undefined) claimed.add(id);
    return { ...person, id };
  });
  return {
    values,
    removed: existing.filter((person) => !claimed.has(person.id)).map((person) => person.id),
  };
}

export async function saveSessionPresenters(
  tx: Transaction,
  sessionId: number,
  incoming: PresenterInput[],
) {
  const existing = await tx
    .select()
    .from(sponsorPresentersTable)
    .where(eq(sponsorPresentersTable.sessionId, sessionId))
    .orderBy(sponsorPresentersTable.displayOrder);
  const plan = planPresenterUpdates(existing, incoming);
  if (plan.removed.length) {
    const linked = await tx
      .select({ id: sponsorAssetsTable.id })
      .from(sponsorAssetsTable)
      .where(
        and(
          inArray(sponsorAssetsTable.presenterId, plan.removed),
          eq(sponsorAssetsTable.status, "active"),
        ),
      )
      .limit(1);
    if (linked.length)
      throw new SponsorPortalError(
        "This speaker has uploaded files. Ask the event team to reassign those files before removing the speaker.",
      );
    await tx
      .delete(sponsorPresentersTable)
      .where(
        and(
          eq(sponsorPresentersTable.sessionId, sessionId),
          inArray(sponsorPresentersTable.id, plan.removed),
        ),
      );
  }
  for (const person of plan.values) {
    const { id, ...fields } = person;
    if (id !== undefined) {
      await tx
        .update(sponsorPresentersTable)
        .set(fields)
        .where(
          and(eq(sponsorPresentersTable.sessionId, sessionId), eq(sponsorPresentersTable.id, id)),
        );
    } else {
      await tx.insert(sponsorPresentersTable).values({ ...fields, sessionId });
    }
  }
}

export function cleanOnsiteContact(body: Record<string, unknown>) {
  const value = (key: string, limit: number) =>
    typeof body[key] === "string" ? body[key].trim().slice(0, limit) : "";
  const firstName = value("firstName", 100);
  const lastName = value("lastName", 100);
  const email = value("email", 254).toLowerCase();
  const phone = value("phone", 50);
  if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.length < 3) {
    throw new SponsorPortalError(
      "Add a first name, last name, valid email and contact phone number.",
    );
  }
  if (body.id !== undefined && (!Number.isInteger(body.id) || Number(body.id) < 1)) {
    throw new SponsorPortalError("Choose a valid contact.");
  }
  return {
    id: body.id as number | undefined,
    firstName,
    lastName,
    email,
    phone,
    jobTitle: value("jobTitle", 200) || null,
  };
}

export async function saveOnsiteContact(sponsorId: number, body: Record<string, unknown>) {
  const clean = cleanOnsiteContact(body);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: sponsorsTable.id })
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId))
      .for("update");
    const contacts = await tx
      .select()
      .from(sponsorContactsTable)
      .where(eq(sponsorContactsTable.sponsorId, sponsorId));
    const existing = clean.id
      ? contacts.find((contact) => contact.id === clean.id)
      : contacts.find((contact) => contact.email.toLowerCase() === clean.email);
    if (clean.id && !existing)
      throw new SponsorPortalError("That contact is not in your sponsor workspace.", 404);
    if (
      contacts.some(
        (contact) => contact.email.toLowerCase() === clean.email && contact.id !== existing?.id,
      )
    ) {
      throw new SponsorPortalError(
        "That email is already on another contact. Choose that contact to update it.",
        409,
      );
    }
    const { id: _id, ...fields } = clean;
    const values = {
      ...fields,
      role: "onsite" as const,
      isPrimary: Boolean(existing?.isPrimary || existing?.role === "primary"),
    };
    const [contact] = existing
      ? await tx
          .update(sponsorContactsTable)
          .set(values)
          .where(
            and(
              eq(sponsorContactsTable.sponsorId, sponsorId),
              eq(sponsorContactsTable.id, existing.id),
            ),
          )
          .returning()
      : await tx
          .insert(sponsorContactsTable)
          .values({ ...values, sponsorId })
          .returning();
    await tx
      .update(sponsorTasksTable)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(sponsorTasksTable.sponsorId, sponsorId),
          eq(sponsorTasksTable.taskKey, "onsite_contacts"),
          eq(sponsorTasksTable.required, true),
        ),
      );
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: "onsite_contact_updated",
      actorType: "sponsor",
      data: { contactId: contact.id },
    });
    return contact;
  });
}

export async function completePreparationTask(sponsorId: number, taskKey: string) {
  if (!["staff", "community_social"].includes(taskKey))
    throw new SponsorPortalError("That task cannot be confirmed here.", 404);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: sponsorsTable.id })
      .from(sponsorsTable)
      .where(eq(sponsorsTable.id, sponsorId))
      .for("update");
    const [task] = await tx
      .select()
      .from(sponsorTasksTable)
      .where(
        and(eq(sponsorTasksTable.sponsorId, sponsorId), eq(sponsorTasksTable.taskKey, taskKey)),
      )
      .for("update");
    if (!task) throw new SponsorPortalError("This task is not in your sponsor workspace.", 404);
    const staff = await tx
      .select({ attending: attendeesTable.communitySocialAttending })
      .from(attendeesTable)
      .innerJoin(bookingsTable, eq(attendeesTable.bookingId, bookingsTable.id))
      .where(
        and(
          eq(bookingsTable.sponsorId, sponsorId),
          eq(bookingsTable.registrationSource, "sponsor_staff"),
          inArray(bookingsTable.status, ["paid", "invoiced"]),
        ),
      );
    if (taskKey === "community_social" && staff.some((person) => person.attending === null)) {
      throw new SponsorPortalError("Choose attending or not attending for each team member first.");
    }
    if (task.status === "completed" || !task.required) return { task, changed: false };
    const [updated] = await tx
      .update(sponsorTasksTable)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(sponsorTasksTable.id, task.id))
      .returning();
    await tx.insert(sponsorActivityTable).values({
      sponsorId,
      type: `${taskKey}_confirmed`,
      actorType: "sponsor",
      data: {
        staffCount: staff.length,
        socialAttending: staff.filter((person) => person.attending).length,
      },
    });
    return { task: updated, changed: true };
  });
}

export async function reopenStaffPreparationTasks(
  connection: Transaction | typeof db,
  sponsorId: number,
) {
  await connection
    .update(sponsorTasksTable)
    .set({ status: "todo", completedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(sponsorTasksTable.sponsorId, sponsorId),
        inArray(sponsorTasksTable.taskKey, ["staff", "community_social"]),
        eq(sponsorTasksTable.required, true),
      ),
    );
}
