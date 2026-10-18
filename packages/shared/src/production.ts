import { z } from "zod";
// Not imported from ./index: index re-exports this file, and a cycle would hit a half-initialised module.
const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

// Phase 2 (production): work centers, BOMs, work orders, and the three floor actions that post to the ledger.
// Quantities are whole numbers in the item's base unit, like the rest of the stock model.

const qty = z.number().int().positive();
const pct = z.number().min(0).max(100);

// ---------- work centers ----------

const workCenterFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  /** Short scannable code like "WC-CORR1". Empty means none. */
  code: z.string().trim().max(40),
  description: z.string().trim().max(500),
  /** The production-area location where material is staged "at the machine". */
  locationId: objectIdSchema,
  active: z.boolean(),
};
export const workCenterInputSchema = z.object({
  ...workCenterFields,
  code: workCenterFields.code.default(""),
  description: workCenterFields.description.default(""),
  active: workCenterFields.active.default(true),
});
export type WorkCenterInput = z.infer<typeof workCenterInputSchema>;
export const workCenterUpdateSchema = z.object(workCenterFields).partial();
export type WorkCenterUpdate = z.infer<typeof workCenterUpdateSchema>;

export interface WorkCenter {
  id: string;
  name: string;
  code: string;
  description: string;
  locationId: string;
  locationPath: string;
  active: boolean;
  /** Work orders currently running here. */
  runningOrders: number;
  createdAt: string;
}

// ---------- BOMs ----------

export const bomInputLineSchema = z.object({
  itemId: objectIdSchema,
  /** Needed per `outputQuantity` of good output, before waste. */
  quantity: z.number().positive().max(1_000_000),
  /** Expected waste on this input, as a percentage of what's needed. */
  scrapPct: pct.default(0),
});
export type BomInputLine = z.infer<typeof bomInputLineSchema>;

export const bomInputSchema = z.object({
  outputItemId: objectIdSchema,
  /** The inputs make this many of the output item. */
  outputQuantity: qty.default(1),
  /** Share of started output expected to come out good (100 = no output loss). */
  yieldPct: z.number().min(1).max(100).default(100),
  inputs: z.array(bomInputLineSchema).min(1, "A BOM needs at least one input").max(100),
  note: z.string().trim().max(500).default(""),
});
export type BomInput = z.infer<typeof bomInputSchema>;

export const BOM_STATUSES = ["active", "retired"] as const;
export type BomStatus = (typeof BOM_STATUSES)[number];

export interface Bom extends BomInput {
  id: string;
  outputItemSku: string;
  outputItemName: string;
  /** Per output item; a new version retires the previous active one. */
  version: number;
  status: BomStatus;
  inputs: (BomInputLine & { itemSku: string; itemName: string })[];
  createdAt: string;
}

// ---------- work orders ----------

export const WORK_ORDER_STATUSES = ["planned", "released", "running", "done", "cancelled"] as const;
export const workOrderStatusSchema = z.enum(WORK_ORDER_STATUSES);
export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

export const workOrderInputSchema = z.object({
  /** The BOM version to build from. Pass outputItemId instead to use the item's active BOM. */
  bomId: objectIdSchema.optional(),
  outputItemId: objectIdSchema.optional(),
  quantity: qty,
  workCenterId: objectIdSchema,
  dueDate: z.string().date().nullable().default(null),
  note: z.string().trim().max(500).default(""),
}).refine((w) => w.bomId || w.outputItemId, { message: "Pick a BOM or an output item", path: ["bomId"] });
export type WorkOrderInput = z.infer<typeof workOrderInputSchema>;

export const workOrderActionSchema = z.object({ action: z.enum(["release", "complete", "cancel"]) });
export type WorkOrderAction = z.infer<typeof workOrderActionSchema>;

export interface WorkOrderRequirement {
  itemId: string;
  itemSku: string;
  itemName: string;
  /** Needed for the planned quantity, including expected scrap and yield. */
  expected: number;
}

export interface WorkOrder {
  id: string;
  number: string;
  status: WorkOrderStatus;
  bomId: string;
  bomVersion: number;
  outputItemId: string;
  outputItemSku: string;
  outputItemName: string;
  quantity: number;
  workCenterId: string;
  workCenterName: string;
  dueDate: string | null;
  note: string;
  requirements: WorkOrderRequirement[];
  /** Good output reported so far. */
  produced: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- floor actions ----------

/** Load material from stock onto the machine's staging location. */
export const loadInputSchema = z.object({
  itemId: objectIdSchema,
  fromLocationId: objectIdSchema,
  quantity: qty,
});
export type LoadInput = z.infer<typeof loadInputSchema>;

/**
 * Report usage at a roll change or end of run. `used` is consumed; `scrap` is wasted;
 * `remnant` goes back to stock (to `remnantLocationId`). Together they can't exceed what's at the machine.
 */
export const consumeInputSchema = z
  .object({
    itemId: objectIdSchema,
    used: z.number().int().min(0),
    scrap: z.number().int().min(0).default(0),
    remnant: z.number().int().min(0).default(0),
    remnantLocationId: objectIdSchema.optional(),
    reason: z.string().trim().max(200).default(""),
  })
  .refine((c) => c.used + c.scrap + c.remnant > 0, { message: "Report something: used, scrap or a remnant", path: ["used"] })
  .refine((c) => c.remnant === 0 || !!c.remnantLocationId, { message: "Pick where the remnant goes", path: ["remnantLocationId"] });
export type ConsumeInput = z.infer<typeof consumeInputSchema>;

/** Report good output (into stock at `toLocationId`) and scrapped output. */
export const outputInputSchema = z
  .object({
    good: z.number().int().min(0),
    scrap: z.number().int().min(0).default(0),
    toLocationId: objectIdSchema,
    reason: z.string().trim().max(200).default(""),
  })
  .refine((o) => o.good + o.scrap > 0, { message: "Report good or scrapped quantity", path: ["good"] });
export type OutputInput = z.infer<typeof outputInputSchema>;

export interface ProductionPosted {
  workOrder: WorkOrder;
  movementIds: string[];
}

// ---------- variance ----------

export interface VarianceLine {
  itemId: string;
  itemSku: string;
  itemName: string;
  expected: number;
  loaded: number;
  consumed: number;
  scrapped: number;
  /** Returned to stock from the machine. */
  remnant: number;
  /** Still at the machine (loaded - consumed - scrapped - remnant). */
  atMachine: number;
  /** consumed + scrapped - expected, for the output actually reported. Positive = used more than the BOM says. */
  variance: number;
  variancePct: number | null;
}

export interface WorkOrderVariance {
  workOrderId: string;
  number: string;
  status: WorkOrderStatus;
  /** Expected usage is scaled to good + scrapped output actually reported (or the plan if none yet). */
  basisQuantity: number;
  planned: number;
  good: number;
  scrapped: number;
  /** good / (good + scrapped), as a percentage. Null before any output. */
  yieldPct: number | null;
  expectedYieldPct: number;
  lines: VarianceLine[];
  /** Total of |variance| as a percentage of expected, across inputs. */
  worstVariancePct: number | null;
}

export interface VarianceSummaryRow {
  workOrderId: string;
  number: string;
  status: WorkOrderStatus;
  outputItemName: string;
  yieldPct: number | null;
  worstVariancePct: number | null;
}
