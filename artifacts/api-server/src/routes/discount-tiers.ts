import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { discountTiersTable } from "@workspace/db";

const router: IRouter = Router();

function formatTier(t: typeof discountTiersTable.$inferSelect) {
  return {
    ...t,
    discountPercent: parseFloat(t.discountPercent.toString()),
  };
}

router.get("/discount-tiers", async (_req, res): Promise<void> => {
  const tiers = await db
    .select()
    .from(discountTiersTable)
    .orderBy(discountTiersTable.passType, discountTiersTable.minQuantity);

  res.json(tiers.map(formatTier));
});

export default router;
