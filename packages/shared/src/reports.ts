// Read-only reports over what the ledger and counts already record.
import type { Uom } from "./units.js";

export interface AgingRow {
  itemId: string;
  sku: string;
  name: string;
  locationId: string;
  locationPath: string;
  /** How this item's whole-number quantities read. */
  uom: Uom;
  quantity: number;
  valueCents: number;
  /** When stock last moved at this place (any ledger line), or when the stock row last changed if nothing is recorded. */
  lastMovementAt: string;
  daysSince: number;
  /** Used as an input or an output on an active BOM, so it is probably wanted soon. */
  onActiveBom: boolean;
  bucket: string;
}

export interface AgingBucket {
  label: string;
  /** Inclusive lower bound in days. */
  fromDays: number;
  /** Inclusive upper bound, or null for "and older". */
  toDays: number | null;
  rows: number;
  units: number;
  valueCents: number;
}

export interface AgingReport {
  asOf: string;
  rows: AgingRow[];
  buckets: AgingBucket[];
  totalValueCents: number;
  /** Value that hasn't moved in more than 180 days. */
  idleValueCents: number;
}

export interface LocationAccuracy {
  locationId: string;
  locationPath: string;
  counts: number;
  linesCounted: number;
  linesMatched: number;
  /** Matched lines as a share of lines counted (0 to 100). */
  accuracyPct: number;
  /** Sum of absolute differences, in units and in money at current unit cost. */
  absVarianceUnits: number;
  absVarianceCents: number;
  netVarianceCents: number;
  lastPostedAt: string | null;
}

export interface ItemAccuracy {
  itemId: string;
  sku: string;
  name: string;
  linesCounted: number;
  linesMissed: number;
  absVarianceUnits: number;
  absVarianceCents: number;
}

export interface CountAccuracyReport {
  asOf: string;
  postedCounts: number;
  linesCounted: number;
  accuracyPct: number | null;
  byLocation: LocationAccuracy[];
  /** The items that miss the most, by money. */
  worstItems: ItemAccuracy[];
  /** One point per month for the last six months. */
  byMonth: { month: string; linesCounted: number; accuracyPct: number | null }[];
}

export type AbcClass = "A" | "B" | "C";
export type CountDueStatus = "overdue" | "due-soon" | "ok" | "never-counted";

export interface CountScheduleRow {
  locationId: string;
  locationPath: string;
  /** The most important class of stock in this place decides how often it is counted. */
  abc: AbcClass;
  intervalDays: number;
  stockValueCents: number;
  lastCountedAt: string | null;
  dueAt: string | null;
  /** Positive when overdue. */
  daysOverdue: number | null;
  status: CountDueStatus;
  /** Someone is counting here now. */
  openCountId: string | null;
}

export interface CountScheduleReport {
  asOf: string;
  /** Days between counts for each class. A items hold most of the value, so they're counted most often. */
  intervals: Record<AbcClass, number>;
  /** Share of total stock value each class covers. */
  classShare: Record<AbcClass, number>;
  classItems: Record<AbcClass, number>;
  rows: CountScheduleRow[];
}
