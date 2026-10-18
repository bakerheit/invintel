import { z } from "zod";
import { MAX_QTY, type Uom } from "./units.js";

// INV-15: sales orders. A customer's order, with stock RESERVED for it when it is confirmed, and shipped through the ledger.
// Reserved is derived, never stored: for every confirmed order, what is ordered minus what has been shipped (live shipments
// in the ledger that haven't been reversed). So a reversal in Activity or a cancel puts the stock back in reach by itself.

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Draft: being written, nothing reserved. Confirmed: stock is reserved. Partial / shipped follow from what has gone out. Closed: ended with some of it unshipped (the rest released). */
export const SO_STATUSES = ["draft", "confirmed", "partial", "shipped", "closed", "cancelled"] as const;
export type SoStatus = (typeof SO_STATUSES)[number];

export const soLineInputSchema = z.object({
  itemId: id,
  quantity: z.number().int().positive().max(MAX_QTY),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
});

const soFields = {
  /** A customer we trade with (a trading partner), or null for a customer who is just a name. */
  customerPartnerId: id.nullable(),
  customerName: z.string().trim().max(100),
  /** The customer's own order number. */
  customerRef: z.string().trim().max(80),
  requestedDate: day.nullable(),
  note: z.string().trim().max(1000),
  lines: z.array(soLineInputSchema).min(1, "Add at least one line").max(100),
};
export const salesOrderInputSchema = z
  .object({
    ...soFields,
    customerPartnerId: soFields.customerPartnerId.default(null),
    customerName: soFields.customerName.default(""),
    customerRef: soFields.customerRef.default(""),
    requestedDate: soFields.requestedDate.default(null),
    note: soFields.note.default(""),
  })
  .refine((o) => o.customerPartnerId !== null || o.customerName !== "", { message: "Say who the customer is", path: ["customerName"] });
export type SalesOrderInput = z.input<typeof salesOrderInputSchema>;
export const salesOrderUpdateSchema = z.object(soFields).partial();
export type SalesOrderUpdate = z.input<typeof salesOrderUpdateSchema>;

export const soConfirmInputSchema = z.object({
  /** Confirm even though there isn't enough available (a back-order): the order is promised and shows as short until stock arrives. */
  allowShortage: z.boolean().default(false),
});
export type SoConfirmInput = z.input<typeof soConfirmInputSchema>;

export const soShipInputSchema = z.object({
  shippedDate: day.optional(),
  carrier: z.string().trim().max(80).default(""),
  trackingNumber: z.string().trim().max(120).default(""),
  lines: z
    .array(
      z.object({
        itemId: id,
        /** Quantity items: how much, and from where. */
        quantity: z.number().int().positive().max(MAX_QTY).optional(),
        locationId: id.optional(),
        /** Items tracked by roll or pallet: the labelled units going out, whole. */
        unitIds: z.array(id).max(200).optional(),
      }),
    )
    .min(1, "Pick at least one line")
    .max(100),
});
export type SoShipInput = z.input<typeof soShipInputSchema>;

export interface SalesOrderLine {
  itemId: string;
  itemSku: string;
  itemName: string;
  uom: Uom;
  tracking: "quantity" | "unit";
  quantity: number;
  unitPriceCents: number;
  /** From the ledger: shipments against this order that haven't been reversed. */
  shipped: number;
  /** Held for this order right now: ordered minus shipped while the order is confirmed or partly shipped, else 0. */
  reserved: number;
  /** What the item has available now (on hand, not on hold, not reserved by any order). Negative: over-promised. */
  available: number;
}

export interface SoShipment {
  number: string;
  at: string;
  /** The date it left, as given when it was shipped. */
  shippedDate: string;
  by: string;
  carrier: string;
  trackingNumber: string;
  lines: { itemId: string; itemName: string; quantity: number; uom: Uom }[];
  /** True once every ledger line of it has been reversed in Activity. */
  reversed: boolean;
  /** Whether a ship notice went to the customer: "sent", "failed" (can be retried), or null when there is no one to send it to. */
  notice: "sent" | "failed" | null;
}

export interface SalesOrder {
  id: string;
  number: string;
  status: SoStatus;
  customer: { partnerId: string | null; name: string };
  customerRef: string;
  /** How the customer is told when a shipment goes (INV-16): by the Exchange, an X12 856, an email, or another document bridge. Null: they aren't. */
  noticeVia: "the Exchange" | "an X12 856" | "an email" | "a message" | null;
  /** "exchange" for an order that arrived from a customer over the Exchange. */
  source: "manual" | "exchange";
  /** The incoming message it was made from, for an exchange order. */
  messageId: string | null;
  requestedDate: string | null;
  note: string;
  lines: SalesOrderLine[];
  totalCents: number;
  /** Stock that can't be promised in full right now (confirmed lines where available is below zero). */
  short: boolean;
  shipments: SoShipment[];
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What to pick for the remaining quantity of one line: the places or labelled units that can fill it (nothing on hold). */
export interface PickLine {
  itemId: string;
  itemSku: string;
  itemName: string;
  uom: Uom;
  tracking: "quantity" | "unit";
  remaining: number;
  /** Quantity items: places with stock, most first. */
  locations: { locationId: string; locationName: string; quantity: number }[];
  /** Unit-tracked items: labelled units, oldest first. */
  units: { unitId: string; code: string; lot: string; quantity: number; locationName: string }[];
}

/** What the order screen shows after a shipment. */
export interface SoShipResult {
  order: SalesOrder;
  shipmentNumber: string;
  movementIds: string[];
  notice: "sent" | "failed" | null;
  noticeError?: string;
}

/** What a failed confirm says: which items don't have enough available. */
export interface SoShortage {
  itemId: string;
  itemSku: string;
  itemName: string;
  uom: Uom;
  needed: number;
  available: number;
}

// ---------- low stock is judged on what is available (INV-16) ----------

export type StockStatus = "ok" | "low" | "out";

export interface StockPosition {
  /** Physically in stock, everywhere (including what is on quality hold). */
  onHand: number;
  /** Promised to customers on confirmed sales orders. */
  reserved: number;
  /** On quality hold: not for sale. */
  onHold: number;
  /** onHand - onHold - reserved. Negative: promised more than there is. */
  available: number;
  reorderLevel: number;
}

/** Reads the position off an item as the API sends it (reserved/available are absent on older responses: then nothing is promised). */
export function positionOfItem(i: { quantity: number; reserved?: number; available?: number; reorderLevel: number }): StockPosition {
  const reserved = i.reserved ?? 0;
  const available = i.available ?? i.quantity - reserved;
  return { onHand: i.quantity, reserved, onHold: Math.max(0, i.quantity - reserved - available), available, reorderLevel: i.reorderLevel };
}

/**
 * Out: nothing physically in stock. Low: what is free to promise is at or under the reorder level (a level of 0 means "don't track low stock",
 * but being promised more than there is always counts). Reorder levels judge available, not on hand: stock that is already spoken for
 * or held back is not stock you have.
 */
export function stockStatusOf(p: StockPosition): StockStatus {
  if (p.onHand <= 0) return "out";
  if (p.available < 0) return "low";
  return p.reorderLevel > 0 && p.available <= p.reorderLevel ? "low" : "ok";
}

/** What to order: enough to get back to twice the reorder level (or to cover what is promised, with no level set), less what is already coming. */
export function suggestedOrderQty(p: StockPosition, onOrder: number): number {
  if (p.reorderLevel > 0) return p.available > p.reorderLevel ? 0 : Math.max(0, p.reorderLevel * 2 - p.available - onOrder);
  return p.available < 0 ? Math.max(0, -p.available - onOrder) : 0;
}

/** "12 on hand, 8 promised, 4 free, reorder at 10": the reason a status is what it is. `fmt` formats a stored quantity in the item's unit. */
export function stockWhy(p: StockPosition, fmt: (n: number) => string): string {
  const parts = [`${fmt(p.onHand)} on hand`];
  if (p.reserved > 0) parts.push(`${fmt(p.reserved)} promised`);
  if (p.onHold > 0) parts.push(`${fmt(p.onHold)} on quality hold`);
  if (p.reserved > 0 || p.onHold > 0) parts.push(p.available < 0 ? `${fmt(-p.available)} over-promised` : `${fmt(p.available)} free`);
  if (p.reorderLevel > 0) parts.push(`reorder at ${fmt(p.reorderLevel)}`);
  return parts.join(", ");
}
