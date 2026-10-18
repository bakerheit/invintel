import { z } from "zod";

// The short pick-lists people choose from on the floor, so reports can group by them. Org-level, with defaults.
// Scrap reasons say why output or material was written off; hold reasons say why stock was put on quality hold.

export const DEFAULT_SCRAP_REASONS = ["Trim", "Setup", "Wrong size", "Damaged", "Machine fault", "Other"] as const;
export const DEFAULT_HOLD_REASONS = ["Awaiting inspection", "Damaged", "Failed inspection", "Wrong spec", "Contaminated", "Supplier issue", "Other"] as const;

const list = z
  .array(z.string().trim().min(1).max(60))
  .min(1)
  .max(20)
  .refine((r) => new Set(r.map((x) => x.toLowerCase())).size === r.length, "Each reason once");

/** Send either list or both; what you leave out is unchanged. */
export const reasonsUpdateSchema = z
  .object({ scrap: list.optional(), hold: list.optional() })
  .refine((r) => r.scrap || r.hold, "Send scrap, hold or both");
export type ReasonsUpdate = z.infer<typeof reasonsUpdateSchema>;

export interface Reasons {
  scrap: string[];
  hold: string[];
}
