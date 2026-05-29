import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const passInventoryTable = pgTable("pass_inventory", {
  id: serial("id").primaryKey(),
  passType: text("pass_type").notNull().unique(),
  remaining: integer("remaining"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PassInventory = typeof passInventoryTable.$inferSelect;
