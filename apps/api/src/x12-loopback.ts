import type { CanonicalOrder, CanonicalOrderResponse } from "@invintel/shared";
import type { ObjectId } from "mongodb";
import { storeInbound, type Failure } from "./b2b-core.js";
import type { B2BMessageDoc, Store } from "./db.js";
import type { Actor } from "./stock-service.js";
import { acceptInbound, nextControl, profileIn, setupOf, type X12Setup } from "./x12-bridge.js";
import { acknowledge, ackTo997, invoiceTo810, readX12, responseTo855, shipTo856, type MapOpts, type Written } from "./x12-maps.js";

// INV-14: the loopback test partner. A pretend supplier that lives inside Invintel: given an 850 we sent it, it answers the way
// a real supplier's system would, as X12 coming back through the same checks as anything from outside (ids, test indicator,
// envelope). It only ever works for TEST partners on the "loopback" transport, so nothing here can be mistaken for a real
// trading partner, and it uses nothing but the order it was sent.

export const SCENARIOS = ["acknowledge", "change", "reject", "syntax_error", "ship", "invoice"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_LABELS: Record<Scenario, string> = {
  acknowledge: "Receipt and accept", change: "Receipt and accept with changes", reject: "Receipt and reject", syntax_error: "Refuse the document (receipt says it was malformed)",
  ship: "Ship notice", invoice: "Invoice",
};

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function answerTo(order: CanonicalOrder, scenario: "acknowledge" | "change" | "reject", today: string): CanonicalOrderResponse {
  const base = { kind: "order_response" as const, version: 1 as const, poNumber: order.poNumber, poDate: order.issuedAt, issuedAt: today };
  if (scenario === "reject") {
    return { ...base, status: "rejected", note: "Out of stock (test partner).", lines: order.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, status: "rejected" as const, orderedQuantity: l.quantity, quantity: "0", unit: l.unit, promisedDate: null })) };
  }
  const lines = order.lines.map((l, i): CanonicalOrderResponse["lines"][number] => {
    if (scenario === "change" && i === 0) {
      const whole = /^\d+$/.test(l.quantity) ? Number(l.quantity) : 0;
      return { lineNo: l.lineNo, sku: l.sku, status: "changed", orderedQuantity: l.quantity, quantity: whole > 1 ? String(whole - 1) : l.quantity, unit: l.unit, promisedDate: addDays(order.expectedDate ?? today, 2) };
    }
    return { lineNo: l.lineNo, sku: l.sku, status: "accepted", orderedQuantity: l.quantity, quantity: l.quantity, unit: l.unit, promisedDate: order.expectedDate };
  });
  return { ...base, status: scenario === "change" ? "changed" : "accepted", note: scenario === "change" ? "Short on the first line (test partner)." : "", lines };
}

/**
 * Makes the test partner answer `messageId` (an order we sent it). Every document it produces goes through the same acceptance
 * as one posted from outside, is stored as received from the partner, and so triggers everything a real one would: the receipt
 * on our order, the business answer, the captured invoice, our own 997 back.
 */
export async function runTestPartner(store: Store, orgId: ObjectId, _actor: Actor, messageId: ObjectId, scenario: Scenario, now = new Date()): Promise<{ ok: true; replies: B2BMessageDoc[] } | Failure> {
  const sent = await store.b2bMessages.findOne({ _id: messageId, orgId });
  if (!sent || sent.direction !== "out") return { ok: false, status: 404, error: "Message not found" };
  if (sent.docType !== "order") return { ok: false, status: 409, error: "The test partner answers orders" };
  const partner = await store.tradingPartners.findOne({ _id: sent.partnerId, orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  if (partner.bridge !== "x12") return { ok: false, status: 409, error: "That partner doesn't use X12" };
  if (partner.mode !== "test") return { ok: false, status: 409, error: "The test partner only works for test partners" };
  if (!partner.enabled) return { ok: false, status: 409, error: `${partner.name} is switched off` };
  const s = setupOf(partner);
  if (!s.ok) return { ok: false, status: 409, error: s.error };
  if (s.setup.transport !== "loopback") return { ok: false, status: 409, error: "This partner isn't on the loopback transport" };
  if (sent.state === "failed" || sent.state === "queued") return { ok: false, status: 409, error: "That order was never delivered" };
  const read = readX12(sent.raw.body, { uomMap: s.setup.uomMap });
  if (!read.ok || read.doc.kind !== "order") return { ok: false, status: 409, error: "That message isn't a readable 850" };
  const order = read.doc.doc;
  const today = now.toISOString().slice(0, 10);
  const setup: X12Setup = s.setup;

  const opts = async (): Promise<MapOpts> => ({ profile: profileIn(setup), control: await nextControl(store, orgId, partner._id, "x12tp"), now, uomMap: setup.uomMap });
  const docs: { w: Written }[] = [];
  const receipt = scenario === "syntax_error" ? acknowledge(read.interchange, ["4"]) : acknowledge(read.interchange);
  docs.push({ w: ackTo997(receipt, await opts()) });
  if (scenario === "acknowledge" || scenario === "change" || scenario === "reject") docs.push({ w: responseTo855(answerTo(order, scenario, today), await opts()) });
  if (scenario === "ship") {
    const o = await opts();
    docs.push({
      w: shipTo856({
        kind: "despatch_advice", version: 1, shipmentNo: `TP-${o.control}`, poNumber: order.poNumber, shipDate: today, carrier: "Test Freight", trackingNumber: `TEST-${order.poNumber}-${o.control}`,
        lines: order.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, quantity: l.quantity, unit: l.unit })),
      }, o),
    });
  }
  if (scenario === "invoice") {
    const o = await opts();
    docs.push({
      w: invoiceTo810({
        kind: "invoice", version: 1, invoiceNumber: `TP-INV-${o.control}`, invoiceDate: today, dueDate: addDays(today, 30), poNumber: order.poNumber, currency: order.currency,
        lines: order.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, name: l.name, quantity: l.quantity, unit: l.unit, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents })),
        taxCents: 0, totalCents: order.totalCents,
      }, o),
    });
  }

  const replies: B2BMessageDoc[] = [];
  for (const { w } of docs) {
    if (!w.ok) return { ok: false, status: 409, error: `The test partner couldn't write its answer: ${w.errors.join("; ")}` };
    const accepted = acceptInbound(w.text, partner);
    if (!accepted.ok) return { ok: false, status: 409, error: `Our own checks refused the test partner's answer: ${accepted.error}` };
    const stored = await storeInbound(store, orgId, partner, { ...accepted, fromName: `${partner.name} (test partner)` });
    if (!stored.ok) return stored;
    replies.push(stored.message);
  }
  return { ok: true, replies };
}
