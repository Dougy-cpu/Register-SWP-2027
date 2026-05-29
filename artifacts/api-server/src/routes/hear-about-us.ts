import { Router, type IRouter } from "express";
import { eq, asc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { hearAboutUsOptionsTable, bookingsTable } from "@workspace/db";
import { adminAuth } from "../middleware/admin-auth";
import { logAdminAction } from "../lib/audit";

const router: IRouter = Router();

const DEFAULT_OPTIONS = [
  "LinkedIn",
  "Google / Search engine",
  "Email newsletter",
  "Word of mouth / Colleague",
  "Previous attendee",
  "Industry publication or press",
  "Podcast",
  "Social media",
  "Other",
];

async function seedDefaultsIfEmpty() {
  const existing = await db.select().from(hearAboutUsOptionsTable).limit(1);
  if (existing.length === 0) {
    await db
      .insert(hearAboutUsOptionsTable)
      .values(DEFAULT_OPTIONS.map((label, i) => ({ label, position: i })));
  }
}

// Public — used by checkout dropdown
router.get("/hear-about-us-options", async (_req, res): Promise<void> => {
  await seedDefaultsIfEmpty();
  const options = await db
    .select()
    .from(hearAboutUsOptionsTable)
    .orderBy(asc(hearAboutUsOptionsTable.position));
  res.json(options.map((o) => ({ id: o.id, label: o.label })));
});

// Admin — returns options with per-option response counts + analytics summary
router.get("/admin/hear-about-us-options", adminAuth, async (_req, res): Promise<void> => {
  await seedDefaultsIfEmpty();

  const options = await db
    .select()
    .from(hearAboutUsOptionsTable)
    .orderBy(asc(hearAboutUsOptionsTable.position));

  // Count how many non-null/non-empty bookings match each label
  const countRows = await db
    .select({
      label: bookingsTable.hearAboutUs,
      count: sql<number>`count(*)::int`,
    })
    .from(bookingsTable)
    .where(sql`${bookingsTable.hearAboutUs} is not null and ${bookingsTable.hearAboutUs} != ''`)
    .groupBy(bookingsTable.hearAboutUs);

  const countMap: Record<string, number> = {};
  for (const row of countRows) {
    if (row.label) countMap[row.label] = row.count;
  }

  // Total bookings that answered vs total bookings
  const [totalAnswered] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookingsTable)
    .where(sql`${bookingsTable.hearAboutUs} is not null and ${bookingsTable.hearAboutUs} != ''`);

  const [totalBookings] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bookingsTable);

  res.json({
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      position: o.position,
      responseCount: countMap[o.label] ?? 0,
    })),
    totalAnswered: totalAnswered?.count ?? 0,
    totalBookings: totalBookings?.count ?? 0,
  });
});

// Admin — add option
router.post("/admin/hear-about-us-options", adminAuth, async (req, res): Promise<void> => {
  const { label } = req.body;
  if (!label || typeof label !== "string" || !label.trim()) {
    res.status(400).json({ error: "label is required" });
    return;
  }

  // Position = max existing + 1
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${hearAboutUsOptionsTable.position}), -1)::int` })
    .from(hearAboutUsOptionsTable);

  const [created] = await db
    .insert(hearAboutUsOptionsTable)
    .values({ label: label.trim(), position: (maxRow?.max ?? -1) + 1 })
    .returning();

  await logAdminAction({
    type: "admin_hear_about_us_added",
    summary: `Added "How did you hear about us" option: ${created.label}`,
    after: { label: created.label, position: created.position },
    meta: { optionId: created.id },
  });

  res.status(201).json(created);
});

// Admin — delete option
router.delete("/admin/hear-about-us-options/:id", adminAuth, async (req, res): Promise<void> => {
  const idRaw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(idRaw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [prev] = await db
    .select()
    .from(hearAboutUsOptionsTable)
    .where(eq(hearAboutUsOptionsTable.id, id));
  await db.delete(hearAboutUsOptionsTable).where(eq(hearAboutUsOptionsTable.id, id));
  await logAdminAction({
    type: "admin_hear_about_us_deleted",
    summary: prev
      ? `Removed "How did you hear about us" option: ${prev.label}`
      : `Removed option #${id}`,
    before: prev ? { label: prev.label } : undefined,
    meta: { optionId: id },
  });
  res.json({ success: true });
});

// Admin — move option up or down (swap positions with neighbour)
router.put("/admin/hear-about-us-options/:id/move", adminAuth, async (req, res): Promise<void> => {
  const idRaw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(idRaw, 10);
  const { direction } = req.body as { direction: "up" | "down" };
  if (isNaN(id) || !["up", "down"].includes(direction)) {
    res.status(400).json({ error: "Invalid id or direction" });
    return;
  }

  const all = await db
    .select()
    .from(hearAboutUsOptionsTable)
    .orderBy(asc(hearAboutUsOptionsTable.position));

  const idx = all.findIndex((o) => o.id === id);
  if (idx === -1) {
    res.status(404).json({ error: "Option not found" });
    return;
  }

  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= all.length) {
    res.json({ success: true, options: all }); // already at boundary
    return;
  }

  const current = all[idx];
  const neighbour = all[swapIdx];

  await db
    .update(hearAboutUsOptionsTable)
    .set({ position: neighbour.position })
    .where(eq(hearAboutUsOptionsTable.id, current.id));
  await db
    .update(hearAboutUsOptionsTable)
    .set({ position: current.position })
    .where(eq(hearAboutUsOptionsTable.id, neighbour.id));

  const updated = await db
    .select()
    .from(hearAboutUsOptionsTable)
    .orderBy(asc(hearAboutUsOptionsTable.position));

  await logAdminAction({
    type: "admin_hear_about_us_moved",
    summary: `Moved option "${current.label}" ${direction}`,
    meta: { optionId: id, direction, swappedWithId: neighbour.id },
  });

  res.json({ success: true, options: updated });
});

export default router;
