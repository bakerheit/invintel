import { z } from "zod";
import { MAX_QTY, type Uom } from "./units.js";

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

export const COUNT_STATUSES = ["open", "posted", "cancelled"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const countStartSchema = z.object({
  locationId: id,
  note: z.string().trim().max(200).default(""),
});
export type CountStartInput = z.input<typeof countStartSchema>;

/** Counting one item sets what was found, not a change. Counting it again replaces the number. */
export const countLineSchema = z.object({
  itemId: id,
  counted: z.number().int().min(0).max(MAX_QTY),
});
export type CountLineInput = z.infer<typeof countLineSchema>;

export const countPostSchema = z.object({
  /** Items with stock here that nobody counted: leave alone (false) or treat as zero (true). */
  zeroUncounted: z.boolean().default(false),
});
export type CountPostInput = z.input<typeof countPostSchema>;

export interface CountLine {
  itemId: string;
  itemSku: string;
  itemName: string;
  /** How this item's whole-number quantities read. */
  uom: Uom;
  /** What the system says is at this location right now (or, once posted, what it said when posted). */
  expected: number;
  counted: number;
  /** counted - expected. Zero means it matched. */
  variance: number;
  /** Value of the variance at unit cost, in cents. */
  varianceCents: number;
}

export interface Count {
  id: string;
  number: string;
  status: CountStatus;
  locationId: string;
  locationPath: string;
  note: string;
  startedBy: string;
  startedAt: string;
  postedAt: string | null;
  lines: CountLine[];
  /** Items with stock here that haven't been counted. Posting with zeroUncounted writes these off. */
  uncounted: { itemId: string; itemSku: string; itemName: string; uom: Uom; expected: number }[];
  /** Totals across counted lines. */
  summary: { counted: number; matched: number; over: number; under: number; netUnits: number; netCents: number };
}

export interface CountListRow {
  id: string;
  number: string;
  status: CountStatus;
  locationPath: string;
  startedBy: string;
  startedAt: string;
  lines: number;
  variances: number;
}
