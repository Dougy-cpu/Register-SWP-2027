import { z } from "zod";
import { SCANNER_TEST_BADGES } from "./scanner-test-data";

// Deliberately separate from the real scanner database, credentials and sync queue.
export const REHEARSAL_STORAGE_KEY = "swp-scanner-rehearsal:v1";

export const practiceReps = ["Jamie", "Alex"] as const;
export type PracticeRep = (typeof practiceReps)[number];
export const rehearsalRepKey = REHEARSAL_STORAGE_KEY + ":rep";
const leadSchema = z.object({
  code: z.string().refine((code) => SCANNER_TEST_BADGES.some((badge) => badge.code === code)),
  rep: z.enum(practiceReps).optional(),
  source: z.enum(["camera", "image"]),
  capturedAt: z.string().datetime(),
  note: z.string().max(4000),
  rating: z.number().int().min(1).max(5).nullable(),
});
const rehearsalSchema = z.object({
  format: z.literal(1),
  leads: z
    .array(leadSchema)
    .max(8)
    .refine(
      (leads) =>
        new Set(leads.map((lead) => (lead.rep ?? practiceReps[0]) + ":" + lead.code)).size ===
        leads.length,
    ),
});
export type RehearsalLead = z.infer<typeof leadSchema>;

export function readRehearsal(): RehearsalLead[] {
  const raw = localStorage.getItem(REHEARSAL_STORAGE_KEY);
  if (!raw) return [];
  if (raw.length > 80000) throw new Error("Invalid rehearsal data");
  return rehearsalSchema.parse(JSON.parse(raw)).leads;
}

export function saveRehearsal(leads: RehearsalLead[]) {
  localStorage.setItem(
    REHEARSAL_STORAGE_KEY,
    JSON.stringify(rehearsalSchema.parse({ format: 1, leads })),
  );
}

export function clearRehearsal() {
  localStorage.removeItem(REHEARSAL_STORAGE_KEY);
}
