import { Router, type IRouter } from "express";
import { calculatePricing } from "../lib/pricing";
import { db } from "@workspace/db";
import { passInventoryTable, passConfigTable } from "@workspace/db";

const router: IRouter = Router();

router.post("/pricing/calculate", async (req, res): Promise<void> => {
  const { passType, quantity, promoCode } = req.body;

  if (!passType || quantity === undefined || quantity === null) {
    res.status(400).json({ error: "passType and quantity are required" });
    return;
  }

  // Reject non-positive / non-integer quantities at the boundary so the UI
  // gets a clean 400 instead of a generic 500 from calculatePricing's
  // internal guard. We use `Number()` (not `parseInt`) so a decimal like
  // "1.9" is rejected rather than silently truncated to 1. (Task #70.)
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    res.status(400).json({ error: "quantity must be a positive integer" });
    return;
  }

  try {
    const pricing = await calculatePricing(passType, qty, promoCode);
    res.json(pricing);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/passes/inventory", async (_req, res): Promise<void> => {
  const rows = await db.select().from(passInventoryTable);
  const result: Record<string, number | null> = { single: null, business: null };
  for (const row of rows) {
    result[row.passType] = row.remaining;
  }
  res.json(result);
});

router.get("/passes/config", async (_req, res): Promise<void> => {
  const rows = await db.select().from(passConfigTable);
  const result: Record<string, (typeof rows)[0] | null> = { single: null, business: null };
  for (const row of rows) {
    result[row.passType] = row;
  }
  res.json(result);
});

export default router;
