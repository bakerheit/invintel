import { formatQty, lineValueCents, uomOf, type CanonicalInvoice, type CanonicalSalesConfirmation } from "@invintel/shared";
import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { getBridge, retryMessage, sendMessage, type Failure } from "./b2b-core.js";
import { nextNumber } from "./counters.js";
import type { B2BMessageDoc, SalesOrderDoc, Store } from "./db.js";
import { issuerName, loadDocContext } from "./doc-context.js";
import { sendDocs } from "./sales-core.js";
import { buildCanonical } from "./sales-notices.js";
import type { Actor } from "./stock-service.js";
import { nextControl, profileOut, setupOf } from "./x12-bridge.js";
import { invoiceTo810 } from "./x12-maps.js";
import { X12_CONTENT_TYPE } from "./x12.js";
import { companyProfileSchema } from "@invintel/shared";

// INV-17: the documents a sales order produces for a customer, as canonical documents (what is kept and sent) which the templates draw:
//   order confirmation   from the order            a PDF, or emailed
//   packing slip         from one shipment          a PDF, and attached to the ship notice email
//   invoice              from one shipment          numbered the first time it is asked for, then kept exactly as issued

const day = (d: Date) => d.toISOString().slice(0, 10);
const text = (n: number, u: { unit: string; decimals: number }) => formatQty(n, u, { unit: false, group: false });

export async function confirmationOf(store: Store, doc: SalesOrderDoc): Promise<CanonicalSalesConfirmation> {
  const [items, org, partner] = await Promise.all([
    store.items.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }, { projection: { sku: 1, name: 1, unit: 1, decimals: 1 } }).toArray(),
    store.orgs.findOne({ _id: doc.orgId }, { projection: { name: 1, documentProfile: 1 } }),
    doc.customerPartnerId ? store.tradingPartners.findOne({ _id: doc.customerPartnerId }, { projection: { name: 1 } }) : null,
  ]);
  const lines = doc.lines.map((l, i) => {
    const it = items.find((x) => x._id.equals(l.itemId));
    const u = uomOf(it);
    return { lineNo: i + 1, sku: it?.sku ?? "", name: it?.name ?? "", quantity: text(l.quantity, u), unit: u.unit, unitPriceCents: l.unitPriceCents, lineTotalCents: lineValueCents(l.quantity, l.unitPriceCents, u.decimals) };
  });
  return {
    kind: "sales_confirmation", version: 1, number: doc.number, issuedAt: day(doc.confirmedAt ?? doc.createdAt), customerName: partner?.name ?? doc.customerName, customerRef: doc.customerRef, ...(doc.billTo ? { billTo: doc.billTo } : {}), ...(doc.shipTo ? { shipTo: doc.shipTo } : {}),
    requestedDate: doc.requestedDate, note: doc.note, currency: "USD", lines, totalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0), shipper: issuerName(org),
  };
}

export async function packingSlipOf(store: Store, doc: SalesOrderDoc, number: string) {
  const s = doc.shipments.find((x) => x.number === number);
  if (!s) return null;
  return buildCanonical(store, doc, { number, shippedDate: s.shippedDate ?? day(s.at), carrier: s.carrier, trackingNumber: s.trackingNumber, lines: s.lines });
}

/** Tax on a subtotal at a rate in hundredths of a percent, to the cent, halves up. No floating point. */
export const taxOn = (subtotalCents: number, bps: number): number => Number((BigInt(subtotalCents) * BigInt(bps) * 2n + 10_000n) / 20_000n);

/**
 * The invoice for one shipment: what shipped, at the order's prices, plus the tax the letterhead says. Numbered (INV-0001...) and kept
 * exactly as issued the first time it is asked for; after that the same document comes back, so a later tax or terms change can't
 * rewrite an invoice that went out.
 */
export async function invoiceFor(store: Store, doc: SalesOrderDoc, number: string): Promise<{ ok: true; invoice: CanonicalInvoice; created: boolean } | Failure> {
  const s = doc.shipments.find((x) => x.number === number);
  if (!s) return { ok: false, status: 404, error: "Shipment not found" };
  if (s.invoice) return { ok: true, invoice: s.invoice as CanonicalInvoice, created: false };
  const [items, org] = await Promise.all([
    store.items.find({ _id: { $in: s.lines.map((l) => l.itemId) } }, { projection: { sku: 1, name: 1, unit: 1, decimals: 1 } }).toArray(),
    store.orgs.findOne({ _id: doc.orgId }, { projection: { name: 1, documentProfile: 1 } }),
  ]);
  const company = companyProfileSchema.parse(org?.documentProfile?.company ?? {});
  const lines = s.lines.map((l, i) => {
    const it = items.find((x) => x._id.equals(l.itemId));
    const u = uomOf(it);
    const price = doc.lines.find((x) => x.itemId.equals(l.itemId))?.unitPriceCents ?? 0;
    return { lineNo: i + 1, sku: it?.sku ?? "", name: it?.name ?? "", quantity: text(l.quantity, u), unit: u.unit, unitPriceCents: price, lineTotalCents: lineValueCents(l.quantity, price, u.decimals) };
  });
  const subtotal = lines.reduce((t, l) => t + l.lineTotalCents, 0);
  const tax = taxOn(subtotal, company.taxRateBps);
  const issued = new Date();
  const due = new Date(issued.getTime() + company.paymentTermsDays * 86_400_000);
  const invoiceNumber = await nextNumber(store, doc.orgId, "inv", "INV-");
  const invoice: CanonicalInvoice = {
    kind: "invoice", version: 1, invoiceNumber, invoiceDate: day(issued), dueDate: company.paymentTermsDays > 0 ? day(due) : null, poNumber: doc.customerRef || doc.number, currency: "USD", lines,
    taxCents: tax, totalCents: subtotal + tax, billTo: doc.customerName, ...(doc.billTo ? { billToAddress: doc.billTo } : {}), ...(doc.shipTo ? { shipToAddress: doc.shipTo } : {}), taxLabel: company.taxLabel, shipmentNo: number, shipper: issuerName(org),
  };
  // Only the first caller's invoice is kept; a caller who lost the race returns the winner's.
  const won = await store.salesOrders.findOneAndUpdate({ _id: doc._id, shipments: { $elemMatch: { number, invoice: { $exists: false } } } }, { $set: { "shipments.$[s].invoice": invoice, "shipments.$[s].invoiceNumber": invoiceNumber, "shipments.$[s].invoicedAt": issued } }, { arrayFilters: [{ "s.number": number }], returnDocument: "after" });
  if (won) return { ok: true, invoice, created: true };
  const now = await store.salesOrders.findOne({ _id: doc._id });
  const kept = now?.shipments.find((x) => x.number === number)?.invoice;
  return kept ? { ok: true, invoice: kept as CanonicalInvoice, created: false } : { ok: false, status: 409, error: "Couldn't issue the invoice. Try again." };
}

export type SendResult = { ok: true; state: "sent" | "delivered"; alreadySent: boolean; messageId: string } | Failure;

/** Sends one of these documents to the customer's trading partner, once: the same document twice is the same message, a failed one is tried again. */
async function deliver(
  store: Store, orgId: ObjectId, actor: Actor, doc: SalesOrderDoc, docType: "order_response" | "invoice", key: string, body: string | { text: string; contentType: string; correlationExtra?: object }, label: string,
): Promise<SendResult> {
  if (!doc.customerPartnerId) return { ok: false, status: 409, error: `${label} can only be sent to a customer who is a trading partner. Download the PDF instead.` };
  const partner = await store.tradingPartners.findOne({ _id: doc.customerPartnerId, orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  const bridge = getBridge(partner.bridge);
  const supported = sendDocs(partner.bridge);
  if (!bridge?.carries.includes(docType) || (docType === "order_response" ? !supported.confirmation : !supported.invoice)) return { ok: false, status: 409, error: `${partner.name} is reached by ${partner.bridge}, which can't carry ${label.toLowerCase()}s. Download the PDF instead.` };
  const payload = typeof body === "string" ? { text: body, contentType: "application/json", correlationExtra: {} } : body;
  const res = await sendMessage(store, orgId, actor, partner._id, { docType, body: payload.text, contentType: payload.contentType, idempotencyKey: key, correlation: { poNumber: doc.customerRef || doc.number, partnerRef: doc.number, ...(payload.correlationExtra ?? {}) } });
  if (!res.ok) return res;
  let m: B2BMessageDoc = res.message;
  if (!res.created && m.state === "failed" && m.attempts[m.attempts.length - 1]?.retryable) {
    const again = await retryMessage(store, orgId, actor, m._id);
    if (!again.ok) return again;
    m = again.message;
  }
  if (m.state === "failed") return { ok: false, status: 409, error: m.attempts.filter((a) => !a.ok).pop()?.error ?? `${label} could not be delivered` };
  return { ok: true, state: m.state === "delivered" ? "delivered" : "sent", alreadySent: !res.created && res.message.state !== "failed", messageId: m._id.toHexString() };
}

export async function sendConfirmation(store: Store, orgId: ObjectId, actor: Actor, doc: SalesOrderDoc): Promise<SendResult> {
  const canonical = await confirmationOf(store, doc);
  const body = JSON.stringify(canonical);
  const key = `confirm:${doc._id.toHexString()}:${createHash("sha256").update(body).digest("hex").slice(0, 16)}`; // the same confirmation twice is one message; a changed order is a new one
  return deliver(store, orgId, actor, doc, "order_response", key, body, "An order confirmation");
}

export async function sendInvoice(store: Store, orgId: ObjectId, actor: Actor, doc: SalesOrderDoc, number: string): Promise<SendResult & { invoiceNumber?: string }> {
  const made = await invoiceFor(store, doc, number);
  if (!made.ok) return made;
  const inv = made.invoice;
  const partner = doc.customerPartnerId ? await store.tradingPartners.findOne({ _id: doc.customerPartnerId, orgId }) : null;
  const key = `invoice:${inv.invoiceNumber}`;
  if (partner?.bridge === "x12") {
    // An EDI customer gets an 810, not a PDF.
    const setup = setupOf(partner);
    if (!setup.ok) return { ok: false, status: 409, error: setup.error };
    const prior = await store.b2bMessages.findOne({ orgId, partnerId: partner._id, direction: "out", idempotencyKey: key });
    const control = prior ? 0 : await nextControl(store, orgId, partner._id);
    const w = prior ? { ok: true as const, text: prior.raw.body } : invoiceTo810(inv, { profile: profileOut(setup.setup), control, now: new Date(), uomMap: setup.setup.uomMap });
    if (!w.ok) return { ok: false, status: 422, error: `The invoice can't be written as an X12 810: ${w.errors.join("; ")}` };
    const sent = await deliver(store, orgId, actor, doc, "invoice", key, { text: w.text, contentType: X12_CONTENT_TYPE, correlationExtra: control ? { controlNumber: String(control) } : {} }, "An invoice");
    return sent.ok ? { ...sent, invoiceNumber: inv.invoiceNumber } : sent;
  }
  const sent = await deliver(store, orgId, actor, doc, "invoice", key, JSON.stringify(inv), "An invoice");
  return sent.ok ? { ...sent, invoiceNumber: inv.invoiceNumber } : sent;
}

export { loadDocContext };
