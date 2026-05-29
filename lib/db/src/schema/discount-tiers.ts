import { pgTable, serial, integer, numeric, text, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tierPassTypeEnum = pgEnum("tier_pass_type", ["single", "team", "business"]);

export const discountTiersTable = pgTable("discount_tiers", {
  id: serial("id").primaryKey(),
  passType: tierPassTypeEnum("pass_type").notNull(),
  minQuantity: integer("min_quantity").notNull(),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull(),
  label: text("label"),
});

export const insertDiscountTierSchema = createInsertSchema(discountTiersTable).omit({
  id: true,
});
export type InsertDiscountTier = z.infer<typeof insertDiscountTierSchema>;
export type DiscountTier = typeof discountTiersTable.$inferSelect;
