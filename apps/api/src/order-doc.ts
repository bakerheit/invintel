import { canonicalOrderSchema, formatQty, lineValueCents, type CanonicalOrder, type PurchaseOrder } from "@invintel/shared";
import { PdfDoc, textWidth } from "./pdf.js";

// Turns a purchase order into the canonical order document and into a PDF a supplier can read. Pure functions: nothing
// here touches the database, so X12 and other mappers can reuse the canonical order as their input.

const day = (iso: string) => iso.slice(0, 10);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

const ROWS_PER_PAGE = 28;

export function renderOrderPdf(o: CanonicalOrder): Buffer {
  const pdf = new PdfDoc();
  const L = 48;
  const R = 547;
  const cols = { no: L, item: L + 26, qty: 380, price: 462, total: R };
  const header = () => {
    pdf.addPage();
    pdf.text(L, 60, "PURCHASE ORDER", { size: 20, bold: true });
    pdf.text(R, 60, o.poNumber, { size: 16, bold: true, align: "right" });
    pdf.text(R, 78, `Issued ${o.issuedAt}${o.revision > 1 ? `, revision ${o.revision}` : ""}`, { size: 9, align: "right" });
    pdf.line(L, 90, R, 90, 1);
  };
  header();
  let y = 112;
  pdf.text(L, y, "From (buyer)", { size: 8, bold: true });
  pdf.text(300, y, "To (supplier)", { size: 8, bold: true });
  y += 14;
  pdf.text(L, y, o.buyer.name, { size: 11, bold: true });
  pdf.text(300, y, o.supplier.name, { size: 11, bold: true });
  y += 14;
  if (o.supplier.contact) { pdf.text(300, y, o.supplier.contact, { size: 9 }); y += 12; }
  if (o.supplier.email) { pdf.text(300, y, o.supplier.email, { size: 9 }); y += 12; }
  y = Math.max(y, 150) + 4;
  if (o.expectedDate) { pdf.text(L, y, `Requested delivery date: ${o.expectedDate}`, { size: 10, bold: true }); y += 16; }
  if (o.note) {
    for (const line of pdf.wrap(o.note, R - L, 9)) { pdf.text(L, y, line, { size: 9 }); y += 12; }
    y += 4;
  }
  const tableHead = (yy: number) => {
    pdf.line(L, yy - 11, R, yy - 11, 0.8);
    pdf.text(cols.no, yy, "#", { size: 8, bold: true });
    pdf.text(cols.item, yy, "Item", { size: 8, bold: true });
    pdf.text(cols.qty, yy, "Quantity", { size: 8, bold: true, align: "right" });
    pdf.text(cols.price, yy, "Unit price", { size: 8, bold: true, align: "right" });
    pdf.text(cols.total, yy, "Amount", { size: 8, bold: true, align: "right" });
    pdf.line(L, yy + 5, R, yy + 5, 0.8);
    return yy + 20;
  };
  y = tableHead(y + 10);
  let onPage = 0;
  for (const l of o.lines) {
    if (onPage >= ROWS_PER_PAGE || y > 740) { header(); y = tableHead(112); onPage = 0; }
    const name = l.sku ? `${l.sku}  ${l.name}` : l.name;
    const fit = pdf.wrap(name, cols.qty - cols.item - 70, 9)[0] ?? name;
    pdf.text(cols.no, y, String(l.lineNo), { size: 9 });
    pdf.text(cols.item, y, fit.length < name.length ? `${fit.slice(0, Math.max(0, fit.length - 1))}…` : fit, { size: 9 });
    pdf.text(cols.qty, y, `${l.quantity} ${l.unit}`, { size: 9, align: "right" });
    pdf.text(cols.price, y, money(l.unitPriceCents), { size: 9, align: "right" });
    pdf.text(cols.total, y, money(l.lineTotalCents), { size: 9, align: "right" });
    y += 16;
    onPage++;
  }
  pdf.line(L, y - 6, R, y - 6, 0.8);
  pdf.text(cols.price, y + 8, "Total", { size: 10, bold: true, align: "right" });
  pdf.text(cols.total, y + 8, `${money(o.totalCents)} ${o.currency}`, { size: 11, bold: true, align: "right" });
  y += 40;
  if (o.portalUrl) {
    if (y > 740) { header(); y = 112; }
    pdf.text(L, y, "Please confirm this order, give a ship date and tracking here:", { size: 9, bold: true });
    pdf.text(L, y + 14, o.portalUrl.length * 9 * 0.52 > R - L ? `${o.portalUrl.slice(0, 90)}...` : o.portalUrl, { size: 9 });
    y += 34;
  }
  pdf.text(L, 805, `Purchase order ${o.poNumber} from ${o.buyer.name}. Generated by Invintel.`, { size: 7 });
  return pdf.toBuffer({ title: `Purchase order ${o.poNumber}`, author: o.buyer.name });
}

export { textWidth };
