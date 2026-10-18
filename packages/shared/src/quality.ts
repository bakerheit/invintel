import { z } from "zod";

// INV-2: quality hold and NCR (non-conformance report). A hold takes stock out of use until someone decides what to
// do with it: use it, rework it, scrap it or return it to the supplier. Each hold is one NCR; each decision is a
// disposition on it, and the stock changes go through the ledger.

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

export const DISPOSITIONS = ["use", "rework", "scrap", "return"] as const;
export const dispositionSchema = z.enum(DISPOSITIONS);
export type DispositionType = z.infer<typeof dispositionSchema>;

export const DISPOSITION_LABELS: Record<DispositionType, string> = {
  use: "Use as is (release)",
  rework: "Rework (release after fixing)",
  scrap: "Scrap",
  return: "Return to supplier",
};

/**
 * Put stock on hold. A labelled roll or pallet is held by its unit; other items by item, place and quantity.
 */
export const holdInputSchema = z
  .object({
    reason: z.string().trim().min(1, "Pick a reason").max(60),
    note: z.string().trim().max(500).default(""),
    unitId: id.optional(),
    itemId: id.optional(),
    locationId: id.optional(),
    quantity: z.number().int().positive().max(1_000_000).optional(),
    /** The supplier's lot, for stock without a labelled unit. */
    supplierLot: z.string().trim().max(64).default(""),
  })
  .refine((h) => h.unitId || (h.itemId && h.locationId && h.quantity), {
    message: "Pick a roll or pallet, or an item with a place and a quantity",
    path: ["itemId"],
  });
export type HoldInput = z.input<typeof holdInputSchema>;

export const disposeInputSchema = z
  .object({
    type: dispositionSchema,
    /** How many of the held quantity. Leave out for all that is left (always all of a labelled unit). */
    quantity: z.number().int().positive().max(1_000_000).optional(),
    /** Where released or reworked stock goes; defaults to where it came from. */
    toLocationId: id.optional(),
    /** For scrap: a reason from the scrap list. */
    reason: z.string().trim().max(60).default(""),
    note: z.string().trim().max(500).default(""),
  })
  .refine((d) => d.type !== "scrap" || d.reason, { message: "Pick a scrap reason", path: ["reason"] });
export type DisposeInput = z.input<typeof disposeInputSchema>;

export const NCR_STATUSES = ["open", "closed"] as const;
export type NcrStatus = (typeof NCR_STATUSES)[number];

export interface NcrDisposition {
  type: DispositionType;
  quantity: number;
  toLocationPath: string | null;
  reason: string;
  note: string;
  by: string;
  at: string;
}

export interface Ncr {
  id: string;
  number: string;
  status: NcrStatus;
  /** "receiving" when the hold came from inspect-before-release at the dock. */
  source: "manual" | "receiving";
  itemId: string;
  itemSku: string;
  itemName: string;
  unitId: string | null;
  unitCode: string | null;
  /** Where it was before the hold. */
  fromLocationPath: string;
  /** Where it sits now (the hold area for plain stock; the same place for a labelled unit). */
  heldAtPath: string;
  quantity: number;
  remaining: number;
  supplierLot: string;
  purchaseOrderNumber: string | null;
  reason: string;
  note: string;
  heldBy: string;
  heldAt: string;
  closedAt: string | null;
  dispositions: NcrDisposition[];
}

export interface NcrSummary {
  open: number;
  /** Open holds by reason, biggest first. */
  byReason: { reason: string; count: number }[];
}
