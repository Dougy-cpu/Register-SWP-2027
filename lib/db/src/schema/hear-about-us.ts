import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const hearAboutUsOptionsTable = pgTable("hear_about_us_options", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type HearAboutUsOption = typeof hearAboutUsOptionsTable.$inferSelect;
