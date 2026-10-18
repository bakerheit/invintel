import { z } from "zod";

// INV-1: lot genealogy and mock recall. Follow a supplier lot (or a roll or pallet) forward to everything made from
// it and where that is now, or follow a finished unit or work order backward to the lots that went into it. The
// trace is read from the ledger: receipts (with supplier lot), what each work order loaded and used (by unit), and
// what it produced.

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

/** Exactly one of lot, unit (label code) or workOrder says where to start. */
export const traceQuerySchema = z
  .object({
    direction: z.enum(["forward", "backward"]).default("forward"),
    lot: z.string().trim().min(1).max(64).optional(),
    itemId: id.optional(),
    unit: z.string().trim().min(1).max(64).optional(),
    workOrder: z.string().trim().min(1).max(32).optional(),
  })
  .refine((q) => [q.lot, q.unit, q.workOrder].filter(Boolean).length === 1, { message: "Give a lot, a label or a work order (just one)" });
export type TraceQuery = z.input<typeof traceQuerySchema>;

export type TraceNodeKind = "lot" | "receipt" | "unit" | "work_order" | "output" | "inputs" | "shipment";

export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  label: string;
  detail: string;
  /** False where the link is inferred (material that isn't tracked by label): shown as "possible". */
  exact: boolean;
  /** Seen elsewhere in this trace, so not expanded again. */
  repeat?: boolean;
  children: TraceNode[];
}

export interface TraceAffectedRow {
  kind: "unit" | "quantity";
  /** The label code for a unit; null for plain quantities. */
  code: string | null;
  itemSku: string;
  itemName: string;
  lot: string;
  /** What is left on a unit, or how much a work order produced of a plain item. */
  quantity: number;
  status: string;
  location: string;
  /** The work order it was used in or made by (empty for the starting point). */
  via: string;
}

export interface TraceSummary {
  /** Labelled units in the result, and how much of them is still in stock (not used up). */
  units: number;
  stillInStock: number;
  workOrders: string[];
  purchaseOrders: string[];
  suppliers: string[];
  /** Customers who were shipped any of it (INV-15): who to call in a recall. */
  customers: string[];
  locations: { path: string; units: number; quantity: number }[];
  /** True when some links are inferred rather than exact (plain stock has no lot after receiving). */
  hasInferred: boolean;
}

export interface TraceResult {
  direction: "forward" | "backward";
  /** What was traced, in words. */
  query: string;
  tree: TraceNode[];
  affected: TraceAffectedRow[];
  summary: TraceSummary;
  notes: string[];
  tookMs: number;
}

export interface RecallDrill {
  id: string;
  at: string;
  by: string;
  direction: "forward" | "backward";
  query: string;
  tookMs: number;
  units: number;
  stillInStock: number;
  workOrders: number;
  locations: number;
  hasInferred: boolean;
}
