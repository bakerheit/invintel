import { z } from "zod";

// INV-6: scrap and yield trends. Scrap is read from the ledger's "scrap" lines (production usage and output, and
// quality-hold decisions), grouped by the reason on the line, the work center of the work order, and the item.
// Value is quantity times the item's current unit cost. Yield is good output over good plus scrapped output.

export const scrapQuerySchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90, 180].includes(d), "Pick 7, 30, 90 or 180 days").default(30),
  workCenterId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
});
export type ScrapQuery = z.input<typeof scrapQuerySchema>;

/** Where a scrap line came from. */
export type ScrapSource = "usage" | "output" | "hold";

export interface ScrapReasonRow { reason: string; lines: number; valueCents: number }
export interface ScrapCenterRow {
  workCenterId: string | null;
  /** "Not on a work order" for scrap decided from quality hold. */
  name: string;
  scrapLines: number;
  valueCents: number;
  goodOutput: number;
  scrappedOutput: number;
  /** good / (good + scrapped output), 0 to 100; null when nothing was reported. */
  yieldPct: number | null;
}
export interface ScrapItemRow {
  itemId: string;
  sku: string;
  name: string;
  /** Scrapped quantity in the item's own unit. */
  quantity: number;
  valueCents: number;
  lines: number;
}
export interface ScrapTrendPoint {
  /** The day, or the Monday of the week. */
  label: string;
  valueCents: number;
  goodOutput: number;
  scrappedOutput: number;
  yieldPct: number | null;
}

export interface ScrapReport {
  windowDays: number;
  from: string;
  to: string;
  bucket: "day" | "week";
  totals: {
    valueCents: number;
    lines: number;
    goodOutput: number;
    scrappedOutput: number;
    yieldPct: number | null;
    /** Scrap with no reason picked: the share the lists can't explain. */
    noReasonValueCents: number;
  };
  bySource: { source: ScrapSource; valueCents: number; lines: number }[];
  byReason: ScrapReasonRow[];
  byWorkCenter: ScrapCenterRow[];
  byItem: ScrapItemRow[];
  trend: ScrapTrendPoint[];
}
