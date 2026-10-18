import {
  DEFAULT_INVOICE_SETTINGS,
  formatQty,
  lineValueCents,
  uomOf,
  type InvoiceSettings,
  type MatchFlag,
  type MatchLine,
  type MatchResult,
} from "@invintel/shared";
import { ObjectId } from "mongodb";
import type { InvoiceDoc, ItemDoc, OrgDoc, Store } from "./db.js";
import { receivedByOrder } from "./purchasing.js";

export const settingsOf = (org: Pick<OrgDoc, "invoiceSettings">): InvoiceSettings => ({ ...DEFAULT_INVOICE_SETTINGS, ...(org.invoiceSettings ?? {}) });

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What a set of lines comes to. Always worked out here, from the lines, never trusted from a client. */
export function totalsOf(lines: InvoiceDoc["lines"], freightCents: number, items: Map<string, Pick<ItemDoc, "decimals">>) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const decimals = l.itemId ? (items.get(l.itemId.toHexString())?.decimals ?? 0) : 0;
    subtotal += lineValueCents(l.quantity, l.unitPriceCents, decimals);
    tax += l.taxCents;
  }
  return { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax + freightCents };
}

type Candidate = Pick<InvoiceDoc, "supplierId" | "purchaseOrderId" | "invoiceKey" | "currency" | "lines" | "totalCents" | "statedTotalCents">;

/**
 * The three-way match: what the supplier billed, against what we ordered, against what actually arrived.
 * It only reads. A blocking flag means a person has to look and say why it's fine; an info flag is just worth knowing.
 * `self` is the invoice being checked (so it isn't compared with itself).
 */
export async function matchInvoice(store: Store, org: OrgDoc, inv: Candidate, self?: ObjectId): Promise<MatchResult> {
  const settings = settingsOf(org);
  const flags: MatchFlag[] = [];
  const add = (code: MatchFlag["code"], severity: MatchFlag["severity"], message: string, line: number | null = null) => flags.push({ code, severity, line, message });

  // Billed twice: the same supplier invoice number, entered already.
  const dup = await store.invoices.findOne({ orgId: org._id, supplierId: inv.supplierId, invoiceKey: inv.invoiceKey, status: { $ne: "void" }, ...(self ? { _id: { $ne: self } } : {}) }, { projection: { number: 1 } });
  if (dup) add("duplicate", "block", `The supplier's invoice number was already entered as ${dup.number}. It may be billed twice.`);

  if (inv.currency !== settings.currency) add("currency", "block", `Billed in ${inv.currency}, but your books are in ${settings.currency}.`);
  if (inv.statedTotalCents !== null && Math.abs(inv.statedTotalCents - inv.totalCents) > settings.totalToleranceCents) {
    add("total_differs", "block", `The supplier's total is ${dollars(inv.statedTotalCents)}, but the lines add up to ${dollars(inv.totalCents)}.`);
  }

  const itemIds = [...new Set(inv.lines.flatMap((l) => (l.itemId ? [l.itemId.toHexString()] : [])))];
  const items = new Map((await store.items.find({ orgId: org._id, _id: { $in: itemIds.map((i) => new ObjectId(i)) } }).toArray()).map((i) => [i._id.toHexString(), i]));
  const lines: MatchLine[] = inv.lines.map((l, i) => ({
    line: i + 1, itemId: l.itemId?.toHexString() ?? null, orderedQuantity: null, orderedPriceCents: null, receivedQuantity: null, invoicedQuantity: l.quantity, invoicedElsewhere: 0,
  }));

  if (!inv.purchaseOrderId) {
    add("no_po", "warn", "No purchase order, so there is nothing to match the price and quantity against. A person has to check it.");
    return { status: "no_po", flags, lines, checkedAt: new Date().toISOString() };
  }

  const po = await store.purchaseOrders.findOne({ _id: inv.purchaseOrderId, orgId: org._id });
  if (!po) {
    add("po_not_open", "block", "The purchase order can't be found.");
    return { status: "flagged", flags, lines, checkedAt: new Date().toISOString() };
  }
  if (!po.supplierId.equals(inv.supplierId)) add("po_supplier", "block", `${po.number} is for a different supplier.`);
  if (po.state === "draft" || po.state === "cancelled") add("po_not_open", "block", `${po.number} is ${po.state === "draft" ? "still a draft, so nothing was ordered" : "cancelled"}.`);

  const received = await receivedByOrder(store, [po._id]);
  // Other invoices already approved against this order, so billing the same goods twice shows up. One still waiting
  // for a person doesn't count: it may be the wrong one, and approving it will re-run this check.
  const others = await store.invoices.find({ orgId: org._id, purchaseOrderId: po._id, status: { $in: ["approved", "paid"] }, ...(self ? { _id: { $ne: self } } : {}) }, { projection: { lines: 1 } }).toArray();
  const elsewhere = new Map<string, number>();
  for (const o of others) for (const l of o.lines) if (l.itemId) elsewhere.set(l.itemId.toHexString(), (elsewhere.get(l.itemId.toHexString()) ?? 0) + l.quantity);
  const billedHere = new Map<string, number>();
  for (const l of inv.lines) if (l.itemId) billedHere.set(l.itemId.toHexString(), (billedHere.get(l.itemId.toHexString()) ?? 0) + l.quantity);

  inv.lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.itemId) return; // freight, fees: nothing to match
    const key = l.itemId.toHexString();
    const item = items.get(key);
    const uom = uomOf(item);
    const name = item ? `${item.name} (${item.sku})` : "An item";
    const poLine = po.lines.find((x) => x.itemId.equals(l.itemId!));
    const row = lines[i]!;
    row.invoicedElsewhere = elsewhere.get(key) ?? 0;
    if (!poLine) {
      add("not_on_po", "block", `${name} isn't on ${po.number}.`, n);
      return;
    }
    const got = received.get(`${po._id.toHexString()}:${key}`) ?? 0;
    row.orderedQuantity = poLine.quantity;
    row.orderedPriceCents = poLine.unitCostCents;
    row.receivedQuantity = got;

    // Price: above the order's by more than the tolerance blocks; below is worth knowing.
    const allowed = (poLine.unitCostCents * settings.priceTolerancePct) / 100;
    const diff = l.unitPriceCents - poLine.unitCostCents;
    if (diff > allowed) {
      const pct = poLine.unitCostCents ? ` (+${((diff / poLine.unitCostCents) * 100).toFixed(1)}%)` : "";
      add("price_higher", "block", `${name}: billed ${dollars(l.unitPriceCents)} each, ordered at ${dollars(poLine.unitCostCents)}${pct}.`, n);
    } else if (-diff > allowed) {
      add("price_lower", "info", `${name}: billed ${dollars(l.unitPriceCents)} each, below the ordered ${dollars(poLine.unitCostCents)}.`, n);
    }

    // Quantity: billed against what actually arrived, across every invoice for this order line.
    const billed = (billedHere.get(key) ?? 0) + (elsewhere.get(key) ?? 0);
    if (got === 0) {
      add("not_received", "block", `${name}: billed ${formatQty(l.quantity, uom)}, but none has been received against ${po.number}.`, n);
    } else if (billed > got * (1 + settings.qtyTolerancePct / 100)) {
      add("over_billed", "block", `${name}: ${formatQty(billed, uom)} billed in total, ${formatQty(got, uom)} received.`, n);
    } else if (billed > poLine.quantity * (1 + settings.qtyTolerancePct / 100)) {
      add("over_ordered", "block", `${name}: ${formatQty(billed, uom)} billed in total, ${formatQty(poLine.quantity, uom)} ordered.`, n);
    }
  });

  // A line flagged twice for the same item would just repeat itself.
  const seen = new Set<string>();
  const unique = flags.filter((f) => {
    const k = `${f.code}:${f.line ?? ""}:${f.message}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { status: unique.some((f) => f.severity !== "info") ? "flagged" : "matched", flags: unique, lines, checkedAt: new Date().toISOString() };
}

/** Does this match need a person's say before the invoice can be paid? */
export const needsReview = (m: MatchResult) => m.status !== "matched";
export const blocks = (m: MatchResult) => m.flags.some((f) => f.severity === "block");
