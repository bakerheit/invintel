import { canonicalOrderSchema, formatQty, lineValueCents, type CanonicalOrder, type PurchaseOrder } from "@invintel/shared";
import type { DocContext } from "./doc-pdf.js";
import { plainContext, renderDocument } from "./doc-render.js";
import { textWidth } from "./pdf.js";

// Turns a purchase order into the canonical order document and into a PDF a supplier can read. Pure functions: nothing
// here touches the database, so X12 and other mappers can reuse the canonical order as their input.

const day = (iso: string) => iso.slice(0, 10);

/** Quantity as decimal text in the item's own unit, without the unit: 12500 on {kg, 3 decimals} -> "12.500". */
const qtyText = (stored: number, uom: { unit: string; decimals: number }) => formatQty(stored, uom, { unit: false, group: false });

export function buildCanonicalOrder(order: PurchaseOrder, opts: { buyerName: string; supplierContact?: string; supplierEmail?: string; portalUrl: string | null; revision?: number; now?: Date }): CanonicalOrder {
  return canonicalOrderSchema.parse({
    kind: "order",
    version: 1,
    poNumber: order.number,
    revision: opts.revision ?? 1,
    issuedAt: day((opts.now ?? new Date()).toISOString()),
    buyer: { name: opts.buyerName },
    supplier: { name: order.supplierName, contact: opts.supplierContact ?? "", email: opts.supplierEmail ?? "" },
    currency: "USD",
    expectedDate: order.expectedDate,
    note: order.note,
    lines: order.lines.map((l, i) => ({
      lineNo: i + 1,
      sku: l.itemSku,
      name: l.itemName,
      quantity: qtyText(l.quantity, l.uom),
      unit: l.uom.unit,
      unitPriceCents: l.unitCostCents,
      lineTotalCents: lineValueCents(l.quantity, l.unitCostCents, l.uom.decimals),
    })),
    totalCents: order.totalCents,
    portalUrl: opts.portalUrl,
  });
}

/** The purchase order as a PDF. With no context it is drawn on a plain letterhead (the buyer's name); the email bridge and the preview pass the organization's. */
export function renderOrderPdf(o: CanonicalOrder, ctx?: DocContext): Buffer {
  return renderDocument({ kind: "purchase_order", doc: o }, ctx ?? plainContext("purchase_order", o.buyer.name));
}

export { textWidth };
