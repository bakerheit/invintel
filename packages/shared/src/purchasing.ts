import { z } from "zod";
import { MAX_QTY } from "./units.js";

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

// ---------- suppliers ----------

const supplierFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  contact: z.string().trim().max(200),
  email: z.string().trim().max(200),
  phone: z.string().trim().max(40),
  notes: z.string().trim().max(1000),
};
export const supplierInputSchema = z.object({
  ...supplierFields,
  contact: supplierFields.contact.default(""),
  email: supplierFields.email.default(""),
  phone: supplierFields.phone.default(""),
  notes: supplierFields.notes.default(""),
});
export type SupplierInput = z.input<typeof supplierInputSchema>;
export const supplierUpdateSchema = z.object(supplierFields).partial();

export interface Supplier {
  id: string;
  name: string;
  contact: string;
  email: string;
  phone: string;
  notes: string;
  /** Orders that are placed and not yet fully received. */
  openOrders: number;
  createdAt: string;
}

// ---------- purchase orders ----------

/** Draft: still being written. Ordered: sent to the supplier. Partial / received follow from what has arrived. */
export const PO_STATUSES = ["draft", "ordered", "partial", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const poLineInputSchema = z.object({
  itemId: id,
  quantity: z.number().int().positive().max(MAX_QTY),
  unitCostCents: z.number().int().min(0).max(100_000_000),
});

const poFields = {
  supplierId: id,
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable(),
  note: z.string().trim().max(1000),
  lines: z.array(poLineInputSchema).min(1, "Add at least one line").max(100),
};
export const purchaseOrderInputSchema = z.object({
  ...poFields,
  expectedDate: poFields.expectedDate.default(null),
  note: poFields.note.default(""),
});
export type PurchaseOrderInput = z.input<typeof purchaseOrderInputSchema>;
export const purchaseOrderUpdateSchema = z.object(poFields).partial();

export interface PurchaseOrderLine {
  itemId: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  unitCostCents: number;
  /** From the ledger: receipts against this order that haven't been reversed. */
  received: number;
}

export interface PurchaseOrder {
  id: string;
  number: string;
  status: PoStatus;
  /** Set when an order was closed with some lines short. */
  closedShort: boolean;
  supplierId: string;
  supplierName: string;
  expectedDate: string | null;
  note: string;
  lines: PurchaseOrderLine[];
  totalCents: number;
  orderedUnits: number;
  receivedUnits: number;
  createdAt: string;
  updatedAt: string;
}

export const poReceiveInputSchema = z.object({
  locationId: id,
  lines: z.array(z.object({ itemId: id, quantity: z.number().int().positive().max(MAX_QTY) })).min(1).max(100),
});
export type PoReceiveInput = z.input<typeof poReceiveInputSchema>;

export interface PoReceiveResult {
  order: PurchaseOrder;
  movementIds: string[];
  /** Lines that now have more than was ordered. Allowed (suppliers over-ship), but flagged. */
  overReceived: { itemId: string; itemName: string; over: number }[];
}

/** An item that is at or under its reorder level, with how much to order to get back to twice the level. */
export interface ReorderSuggestion {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  reorderLevel: number;
  /** Already on open purchase orders and not yet received. */
  onOrder: number;
  suggestedQuantity: number;
  unitCostCents: number;
}

export const poFromSuggestionsSchema = z.object({
  supplierId: id,
  itemIds: z.array(id).min(1).max(100),
});
