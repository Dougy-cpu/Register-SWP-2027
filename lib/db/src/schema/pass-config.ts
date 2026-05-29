import { pgTable, text, numeric, jsonb, timestamp } from "drizzle-orm/pg-core";

export const passConfigTable = pgTable("pass_config", {
  passType: text("pass_type").primaryKey(),
  currentPrice: numeric("current_price", { precision: 10, scale: 2 }).notNull().default("199"),
  originalPrice: numeric("original_price", { precision: 10, scale: 2 }).notNull().default("429"),
  pricingPeriodName: text("pricing_period_name").notNull().default("Early Bird"),
  benefits: jsonb("benefits").$type<string[]>().notNull().default([]),
  extraBenefits: jsonb("extra_benefits").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PassConfig = typeof passConfigTable.$inferSelect;
