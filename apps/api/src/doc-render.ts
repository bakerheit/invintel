import {
  DEFAULT_COMPANY, DOC_COLUMNS, defaultTemplate, type CanonicalInvoice, type CanonicalOrder, type CanonicalSalesConfirmation, type CanonicalShipNotice, type CompanyProfile, type DocKind, type DocTemplate,
} from "@invintel/shared";
import { renderDocPdf, type DocColumn, type DocContext, type DocSpec } from "./doc-pdf.js";
import type { PdfImage } from "./pdf.js";

// INV-17: what each document says, as pure functions from the canonical document (what is sent and kept) to a DocSpec. The layout and
// the look come from doc-pdf.ts and the template in force; nothing here touches the database.

export const money = (cents: number, currency = "USD") => `${currency === "USD" ? "$" : `${currency} `}${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RIGHT = new Set(["quantity", "unitPrice", "amount", "ordered", "shipped", "toDate"]);
const columnsOf = (kind: DocKind): DocColumn[] => DOC_COLUMNS[kind].map((c) => ({ key: c.key, header: c.label, align: RIGHT.has(c.key) ? "right" : "left" }));
const qty = (q: string, unit: string) => `${q} ${unit}`.trim();
const item = (sku: string, name: string) => name || sku;

export function purchaseOrderSpec(o: CanonicalOrder): DocSpec {
  return {
    number: o.poNumber,
    meta: [["Issued", o.issuedAt], ...(o.revision > 1 ? [["Revision", String(o.revision)] as [string, string]] : [])],
    parties: [{ heading: "To (supplier)", lines: [o.supplier.name, o.supplier.contact, o.supplier.email] }],
    facts: [["Requested delivery date", o.expectedDate ?? ""]],
    note: o.note,
    ...(o.portalUrl ? { link: { label: "Please confirm this order, give a ship date and tracking here (no account needed):", url: o.portalUrl } } : {}),
    columns: columnsOf("purchase_order"),
    rows: o.lines.map((l) => ({ sku: l.sku, description: l.name || l.sku, quantity: qty(l.quantity, l.unit), unitPrice: money(l.unitPriceCents, o.currency), amount: money(l.lineTotalCents, o.currency) })),
    totals: [{ label: "Total", value: `${money(o.totalCents, o.currency)} ${o.currency}`, strong: true }],
  };
}

export function salesConfirmationSpec(c: CanonicalSalesConfirmation): DocSpec {
  return {
    number: c.number,
    meta: [["Date", c.issuedAt]],
    parties: [{ heading: "Customer", lines: [c.customerName] }],
    facts: [["Your order number", c.customerRef], ["Wanted by", c.requestedDate ?? ""]],
    note: c.note,
    columns: columnsOf("sales_order"),
    rows: c.lines.map((l) => ({ sku: l.sku, description: l.name || l.sku, quantity: qty(l.quantity, l.unit), unitPrice: money(l.unitPriceCents, c.currency), amount: money(l.lineTotalCents, c.currency) })),
    totals: [{ label: "Total", value: `${money(c.totalCents, c.currency)} ${c.currency}`, strong: true }],
  };
}

export function packingSlipSpec(n: CanonicalShipNotice): DocSpec {
  return {
    number: n.shipmentNo,
    meta: [["Ship date", n.shipDate]],
    parties: [{ heading: "Ship to", lines: [n.customerName ?? ""] }],
    facts: [["Order number", n.poNumber], ["Carrier", n.carrier], ["Tracking number", n.trackingNumber]],
    columns: columnsOf("packing_slip"),
    rows: n.lines.map((l) => ({ sku: l.sku, description: item(l.sku, l.name ?? ""), ordered: l.orderedQuantity ? qty(l.orderedQuantity, l.unit) : "", shipped: qty(l.quantity, l.unit), toDate: l.shippedToDate ? qty(l.shippedToDate, l.unit) : "" })),
    totals: [],
  };
}

export function invoiceSpec(i: CanonicalInvoice): DocSpec {
  const subtotal = i.totalCents - i.taxCents;
  return {
    number: i.invoiceNumber,
    meta: [["Invoice date", i.invoiceDate], ...(i.dueDate ? [["Due", i.dueDate] as [string, string]] : [])],
    parties: [{ heading: "Bill to", lines: [i.billTo ?? ""] }],
    facts: [["Your order number", i.poNumber], ["Shipment", i.shipmentNo ?? ""]],
    columns: columnsOf("invoice"),
    rows: i.lines.map((l) => ({ sku: l.sku, description: l.name || l.sku, quantity: qty(l.quantity, l.unit), unitPrice: money(l.unitPriceCents, i.currency), amount: money(l.lineTotalCents, i.currency) })),
    totals: [
      ...(i.taxCents > 0 ? [{ label: "Subtotal", value: money(subtotal, i.currency) }, { label: i.taxLabel || "Tax", value: money(i.taxCents, i.currency) }] : []),
      { label: i.dueDate ? "Total due" : "Total", value: `${money(i.totalCents, i.currency)} ${i.currency}`, strong: true },
    ],
  };
}

export type DocData =
  | { kind: "purchase_order"; doc: CanonicalOrder }
  | { kind: "sales_order"; doc: CanonicalSalesConfirmation }
  | { kind: "packing_slip"; doc: CanonicalShipNotice }
  | { kind: "invoice"; doc: CanonicalInvoice };

export function specOf(d: DocData): DocSpec {
  switch (d.kind) {
    case "purchase_order": return purchaseOrderSpec(d.doc);
    case "sales_order": return salesConfirmationSpec(d.doc);
    case "packing_slip": return packingSlipSpec(d.doc);
    case "invoice": return invoiceSpec(d.doc);
  }
}

export const renderDocument = (d: DocData, ctx: DocContext): Buffer => renderDocPdf(specOf(d), ctx);

/** The look when nothing has been set up: the organization's name as the letterhead, the kind's own template, no logo. */
export function plainContext(kind: DocKind, name: string, extra: { company?: Partial<CompanyProfile>; template?: Partial<DocTemplate>; logo?: PdfImage | null } = {}): DocContext {
  return { kind, company: { ...DEFAULT_COMPANY, ...extra.company, name: extra.company?.name?.trim() || name }, template: { ...defaultTemplate(kind), ...extra.template }, logo: extra.logo ?? null };
}

// ---------- sample documents (fictional) for the live preview ----------

export function sampleDoc(kind: DocKind, company: { name: string; taxRateBps?: number; paymentTermsDays?: number; taxLabel?: string }): DocData {
  const lines = [
    { lineNo: 1, sku: "KRAFT-42", name: "Kraft liner 42 lb, 60 in roll", quantity: "6", unit: "roll", unitPriceCents: 48000, lineTotalCents: 288000 },
    { lineNo: 2, sku: "STARCH-50", name: "Corn starch 50 lb bag", quantity: "12", unit: "bag", unitPriceCents: 2800, lineTotalCents: 33600 },
    { lineNo: 3, sku: "INK-BLK", name: "Flexo ink, black, 5 gal", quantity: "4", unit: "ea", unitPriceCents: 9500, lineTotalCents: 38000 },
  ];
  const total = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const rate = company.taxRateBps ?? 0;
  const tax = Math.round((total * rate) / 10_000);
  switch (kind) {
    case "purchase_order":
      return { kind, doc: { kind: "order", version: 1, poNumber: "PO-0042", revision: 1, issuedAt: "2026-11-02", buyer: { name: company.name }, supplier: { name: "Sample Paper Mill", contact: "Sam Ortiz", email: "orders@samplemill.example" }, currency: "USD", expectedDate: "2026-11-20", note: "Deliver to dock 2. Call before arrival.", lines, totalCents: total, portalUrl: null } };
    case "sales_order":
      return { kind, doc: { kind: "sales_confirmation", version: 1, number: "SO-0108", issuedAt: "2026-11-02", customerName: "Sample Packaging Co.", customerRef: "BP-5521", requestedDate: "2026-11-24", note: "Pallets stretch-wrapped.", currency: "USD", lines, totalCents: total, shipper: company.name } };
    case "packing_slip":
      return { kind, doc: { kind: "despatch_advice", version: 1, shipmentNo: "SO-0108-1", poNumber: "BP-5521", shipDate: "2026-11-10", carrier: "Sample Freight", trackingNumber: "SMP-123456", shipper: company.name, customerName: "Sample Packaging Co.", lines: lines.map((l, i) => ({ lineNo: l.lineNo, sku: l.sku, name: l.name, quantity: i === 0 ? "4" : l.quantity, unit: l.unit, orderedQuantity: l.quantity, shippedToDate: i === 0 ? "4" : l.quantity })) } };
    case "invoice": {
      const terms = company.paymentTermsDays ?? 30;
      const due = new Date(Date.UTC(2026, 10, 10 + terms)).toISOString().slice(0, 10);
      return { kind, doc: { kind: "invoice", version: 1, invoiceNumber: "INV-0007", invoiceDate: "2026-11-10", dueDate: due, poNumber: "BP-5521", currency: "USD", lines, taxCents: tax, totalCents: total + tax, billTo: "Sample Packaging Co.", taxLabel: company.taxLabel || "Tax", shipmentNo: "SO-0108-1", shipper: company.name } };
    }
  }
}
