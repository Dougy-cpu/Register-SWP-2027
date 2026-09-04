import { and, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { db, pool, sponsorActivityTable, sponsorsTable, sponsorTasksTable } from "@workspace/db";
import { sendSponsorInternalNotification } from "../lib/sponsor-email";
import { logger } from "../lib/logger";
import { buildSponsorWorkspace } from "../lib/sponsor-service";

function londonDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function runSponsorDeadlineCheck(now = new Date()): Promise<{
  checkedOn: string;
  overdueTaskIds: number[];
  sponsorIds: number[];
}> {
  const checkedOn = londonDate(now);
  const dueTasks = await db
    .select({ task: sponsorTasksTable, sponsor: sponsorsTable })
    .from(sponsorTasksTable)
    .innerJoin(sponsorsTable, eq(sponsorsTable.id, sponsorTasksTable.sponsorId))
    .where(
      and(
        eq(sponsorTasksTable.required, true),
        lte(sponsorTasksTable.dueAt, now),
        inArray(sponsorTasksTable.status, ["todo", "submitted", "overdue", "completed"]),
        inArray(sponsorsTable.status, ["confirmed", "completed"]),
        or(
          isNull(sponsorTasksTable.lastDeadlineCheckOn),
          ne(sponsorTasksTable.lastDeadlineCheckOn, checkedOn),
        ),
      ),
    );

  const overdueTaskIds: number[] = [];
  const grouped = new Map<number, Array<(typeof dueTasks)[number]>>();
  const workspaces = new Map<number, Awaited<ReturnType<typeof buildSponsorWorkspace>>>();
  for (const row of dueTasks) {
    if (!workspaces.has(row.sponsor.id))
      workspaces.set(row.sponsor.id, await buildSponsorWorkspace(row.sponsor.id, false));
    const current = workspaces.get(row.sponsor.id)?.tasks.find((task) => task.id === row.task.id);
    // Completed files and items awaiting the event team are not sponsor deadline failures.
    if (!current || !["todo", "overdue"].includes(current.status)) continue;
    const updated = await db
      .update(sponsorTasksTable)
      .set({ status: "overdue", lastDeadlineCheckOn: checkedOn, updatedAt: now })
      .where(
        and(
          eq(sponsorTasksTable.id, row.task.id),
          or(
            isNull(sponsorTasksTable.lastDeadlineCheckOn),
            ne(sponsorTasksTable.lastDeadlineCheckOn, checkedOn),
          ),
        ),
      )
      .returning({ id: sponsorTasksTable.id });
    if (!updated.length) continue;
    overdueTaskIds.push(row.task.id);
    const sponsorRows = grouped.get(row.sponsor.id) ?? [];
    sponsorRows.push(row);
    grouped.set(row.sponsor.id, sponsorRows);
  }

  for (const [sponsorId, rows] of grouped) {
    await db.insert(sponsorActivityTable).values({
      sponsorId,
      type: "deadline_check",
      actorType: "system",
      data: { checkedOn, overdueTaskIds: rows.map((row) => row.task.id) },
    });
    await sendSponsorInternalNotification({
      sponsorId,
      category: "deadlines",
      event: "Sponsor deadline needs attention",
      summary: `${rows.length} required ${rows.length === 1 ? "item is" : "items are"} overdue: ${rows.map((row) => row.task.label).join(", ")}. Sponsor reminders remain manual.`,
    });
  }

  return { checkedOn, overdueTaskIds, sponsorIds: [...grouped.keys()] };
}

async function main() {
  const result = await runSponsorDeadlineCheck();
  logger.info(result, "Sponsor deadline check completed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      logger.error({ error }, "Sponsor deadline check failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
