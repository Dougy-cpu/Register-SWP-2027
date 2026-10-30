import { writeFile } from "node:fs/promises";
import { db, emailTemplatesTable, pool } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { emailTemplateHash, planApprovedEmailUpgrade } from "../lib/approved-email-upgrade";

// Manual release step only. Never imported by startup, the build, or any scheduled job.
// Default is a read-only review. --apply requires an exclusive backup file path.
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backupArg = args.indexOf("--backup");
const backup = backupArg >= 0 ? args[backupArg + 1] : undefined;

try {
  if (
    args.some(
      (arg, i) =>
        !["--apply", "--backup"].includes(arg) && !(backupArg >= 0 && i === backupArg + 1),
    )
  )
    throw new Error("Usage: email-template-upgrade [--apply --backup /private/path/backup.json]");
  if (apply && (!backup || backup.startsWith("--")))
    throw new Error("--apply requires --backup with a new private backup filename.");
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(emailTemplatesTable)
      .where(inArray(emailTemplatesTable.type, ["confirmation", "welcome"]));
    const plan = planApprovedEmailUpgrade(rows);
    console.info(
      JSON.stringify(
        {
          mode: apply ? "apply" : "read-only",
          templates: plan.map(({ current, target }) => ({
            type: current.type,
            before: emailTemplateHash(current.htmlBody),
            after: emailTemplateHash(target.htmlBody),
            subject: target.subject,
          })),
        },
        null,
        2,
      ),
    );
    if (!apply || !plan.length) return;
    // Fail rather than overwriting an earlier backup. No booking or attendee data is read.
    await writeFile(
      backup!,
      JSON.stringify({ savedAt: new Date().toISOString(), templates: rows }, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    for (const { current, target } of plan) {
      const changed = await tx
        .update(emailTemplatesTable)
        .set({ ...target, updatedAt: new Date() })
        .where(
          and(
            eq(emailTemplatesTable.id, current.id),
            eq(emailTemplatesTable.htmlBody, current.htmlBody),
            eq(emailTemplatesTable.subject, current.subject),
          ),
        )
        .returning({ id: emailTemplatesTable.id });
      if (changed.length !== 1)
        throw new Error(
          "A template changed during the upgrade; both updates have been rolled back.",
        );
    }
    console.info("Both reviewed templates updated. No emails were sent or queued.");
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Email template upgrade failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
