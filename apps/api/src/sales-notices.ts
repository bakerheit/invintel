import { formatQty, uomOf, type CanonicalShipNotice } from "@invintel/shared";
import type { ObjectId } from "mongodb";
import { getBridge, retryMessage, sendMessage, type Failure, type Sent } from "./b2b-core.js";
import type { B2BMessageDoc, SalesOrderDoc, Store } from "./db.js";
import { loadIncomingOrder, sendShipNotice } from "./exchange.js";
import type { Actor } from "./stock-service.js";
import { nextControl, profileOut, setupOf } from "./x12-bridge.js";
import { shipTo856 } from "./x12-maps.js";
import { X12_CONTENT_TYPE } from "./x12.js";

// INV-16: telling the customer a shipment has gone, over whatever way we trade with them. When Sales ships, the customer's trading
// partner decides how: an Invintel business gets the signed Exchange ship notice, an X12 partner gets an 856, an email partner gets an
// email, and any other bridge that can carry a ship notice gets the canonical document. A customer who is just a name gets nothing.
// A shipment stands whether or not the notice goes: the result says "sent", "failed" (can be sent again) or null (no one to tell).

export interface ShipmentForNotice {
  number: string;
  /** YYYY-MM-DD. */
  shippedDate: string;
  carrier: string;
  trackingNumber: string;
  lines: { itemId: ObjectId; quantity: number }[];
}

export type NoticeResult = { state: "sent" | "failed" | null; error?: string };

const failed = (error: string): NoticeResult => ({ state: "failed", error });
const lastError = (m: B2BMessageDoc) => m.attempts.filter((a) => !a.ok).pop()?.error ?? "The notice could not be delivered";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The key to send this shipment's notice under. The first time it is the shipment's own key, so it can never go out twice. If the last
 * try failed for a reason that retrying won't fix (a wrong address, a unit with no code), the cause has presumably been fixed since
 * and the notice goes out as a fresh message under the next key; a failure that may pass on its own is retried as the same message.
 */
async function keyFor(store: Store, orgId: ObjectId, partnerId: ObjectId, key: string): Promise<{ key: string; existing: B2BMessageDoc | null }> {
  const tries = await store.b2bMessages.find({ orgId, partnerId, direction: "out", idempotencyKey: { $regex: `^${escape(key)}(:r\\d+)?$` } }).sort({ createdAt: -1 }).toArray();
  const latest = tries[0] ?? null;
  if (latest && latest.state === "failed" && !latest.attempts[latest.attempts.length - 1]?.retryable) return { key: `${key}:r${tries.length + 1}`, existing: null };
  return { key: latest?.idempotencyKey ?? key, existing: latest };
}

/** A message we already wrote for this shipment is not written twice: a failed one that may work later is tried again, as the same message. */
async function settle(store: Store, orgId: ObjectId, actor: Actor, res: Sent | Failure): Promise<NoticeResult> {
  if (!res.ok) return failed(res.error);
  let m = res.message;
  if (!res.created && m.state === "failed" && m.attempts[m.attempts.length - 1]?.retryable) {
    const again = await retryMessage(store, orgId, actor, m._id);
    if (!again.ok) return failed(again.error);
    m = again.message;
  }
  return m.state === "failed" ? failed(lastError(m)) : { state: "sent" };
}

/** The ship notice as we mean it: the customer's own order number (ours when they gave none), what went, in the item's own unit. */
async function buildCanonical(store: Store, doc: SalesOrderDoc, s: ShipmentForNotice): Promise<CanonicalShipNotice & { shipper: string }> {
  const [items, org] = await Promise.all([
    store.items.find({ _id: { $in: s.lines.map((l) => l.itemId) } }, { projection: { sku: 1, unit: 1, decimals: 1 } }).toArray(),
    store.orgs.findOne({ _id: doc.orgId }, { projection: { name: 1 } }),
  ]);
  return {
    kind: "despatch_advice", version: 1, shipmentNo: s.number, poNumber: doc.customerRef || doc.number, shipDate: s.shippedDate, carrier: s.carrier, trackingNumber: s.trackingNumber,
    lines: s.lines.map((l) => {
      const i = items.find((x) => x._id.equals(l.itemId));
      const u = uomOf(i);
      return { lineNo: doc.lines.findIndex((x) => x.itemId.equals(l.itemId)) + 1, sku: i?.sku ?? "", quantity: formatQty(l.quantity, u, { unit: false, group: false }), unit: u.unit };
    }),
    shipper: org?.name ?? "",
  };
}

export async function sendShipmentNotice(store: Store, orgId: ObjectId, actor: Actor, doc: SalesOrderDoc, s: ShipmentForNotice): Promise<NoticeResult> {
  try {
    const partner = doc.customerPartnerId ? await store.tradingPartners.findOne({ _id: doc.customerPartnerId, orgId }) : null;
    if (!partner) return { state: null };
    const shipKey = `ship:${doc._id.toHexString()}:${s.number}`;

    if (partner.bridge === "invintel") {
      if (!doc.messageId) return { state: null }; // an Invintel customer's own order is what the notice answers
      const got = await loadIncomingOrder(store, orgId, doc.messageId.toHexString());
      if (!got) return failed("The customer's order message is gone");
      const items = await store.items.find({ _id: { $in: s.lines.map((l) => l.itemId) } }, { projection: { sku: 1, unit: 1, decimals: 1 } }).toArray();
      const res = await sendShipNotice(store, orgId, actor, got, {
        shipmentNumber: s.number, shippedDate: s.shippedDate, carrier: s.carrier, tracking: s.trackingNumber, key: `ship-${doc.messageId.toHexString()}-${s.number}`,
        lines: s.lines.map((l) => { const i = items.find((x) => x._id.equals(l.itemId)); return { sku: i?.sku ?? "", quantity: l.quantity / 10 ** uomOf(i).decimals }; }),
      });
      return settle(store, orgId, actor, res);
    }

    if (!getBridge(partner.bridge)?.carries.includes("despatch_advice")) return { state: null };
    const { key, existing } = await keyFor(store, orgId, partner._id, shipKey);
    const base = { docType: "despatch_advice" as const, idempotencyKey: key };
    const correlation = { poNumber: doc.customerRef || doc.number, partnerRef: s.number };
    const canonical = await buildCanonical(store, doc, s);

    if (partner.bridge === "x12") {
      if (existing) return settle(store, orgId, actor, { ok: true, message: existing, created: false });
      const x = setupOf(partner);
      if (!x.ok) return failed(x.error);
      const control = await nextControl(store, orgId, partner._id);
      const w = shipTo856(canonical, { profile: profileOut(x.setup), control, now: new Date(), uomMap: x.setup.uomMap });
      if (!w.ok) return failed(`Can't be written as an X12 856: ${w.errors.join("; ")}`);
      return settle(store, orgId, actor, await sendMessage(store, orgId, actor, partner._id, { ...base, body: w.text, contentType: X12_CONTENT_TYPE, correlation: { ...correlation, controlNumber: String(control) } }));
    }

    return settle(store, orgId, actor, await sendMessage(store, orgId, actor, partner._id, { ...base, body: JSON.stringify(canonical), contentType: "application/json", correlation }));
  } catch (e) {
    return failed(e instanceof Error ? e.message : "The notice could not be sent");
  }
}
