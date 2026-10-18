import {
  lineValueCents, uomOf, type SalesOrder, type SalesOrderInput, type SalesOrderLine, type SoShipInput, type SoShipment, type SoShortage, type SoStatus, type PickLine,
} from "@invintel/shared";
import { ObjectId } from "mongodb";
import { recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import type { ItemDoc, SalesOrderDoc, Store } from "./db.js";
import { changeStock, logMovement, ON_HOLD_AREA, type Actor } from "./stock-service.js";
import { adjustUnit } from "./units.js";

// INV-15: sales orders and reservations.
//
// RESERVED IS DERIVED. For every confirmed order, what is ordered minus what has shipped, where "shipped" is read from the ledger
// (movements of type "ship" that point at the order and haven't been reversed). Nothing is counted separately, so a cancel, a
// close, a shipment and an undo in Activity all change availability by themselves and the numbers cannot drift.
//
//   available = on hand - on quality hold - reserved      (negative means over-promised)
//
// Confirming claims the order first (draft -> confirmed), then checks availability including itself; if it doesn't fit it puts
// the order back to draft. Two confirms racing for the same stock can both be refused, but never both succeed.

type Result<T> = ({ ok: true } & T) | { ok: false; status: 404 | 409 | 422; error: string; shortages?: SoShortage[] };
const oidOf = (s: string) => new ObjectId(s);
export const soEntity = (d: { _id: ObjectId; number: string }) => ({ type: "sales_order" as const, id: d._id.toHexString(), label: d.number });
const actorRef = (a: { userId: ObjectId | null; userName: string }) => ({ id: a.userId, name: a.userName });

// ---------- what has shipped, what is reserved, what is available ----------

/** Live shipments per order and item (reversed ones don't count). Key: "orderId:itemId". */
export async function shippedByOrder(store: Store, orderIds: ObjectId[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!orderIds.length) return out;
  const rows = await store.movements
    .aggregate<{ _id: { so: ObjectId; item: ObjectId }; qty: number }>([
      { $match: { salesOrderId: { $in: orderIds }, type: "ship", reversedBy: { $exists: false } } },
      { $group: { _id: { so: "$salesOrderId", item: "$itemId" }, qty: { $sum: { $multiply: ["$delta", -1] } } } },
    ])
    .toArray();
  for (const r of rows) out.set(`${r._id.so.toHexString()}:${r._id.item.toHexString()}`, r.qty);
  return out;
}

/** Promised and not yet shipped, per item, across every confirmed order. Key: itemId. */
export async function reservedByItem(store: Store, orgId: ObjectId): Promise<Map<string, number>> {
  const orders = await store.salesOrders.find({ orgId, state: "confirmed" }, { projection: { lines: 1 } }).toArray();
  const shipped = await shippedByOrder(store, orders.map((o) => o._id));
  const out = new Map<string, number>();
  for (const o of orders) {
    for (const l of o.lines) {
      const left = Math.max(0, l.quantity - (shipped.get(`${o._id.toHexString()}:${l.itemId.toHexString()}`) ?? 0));
      if (left > 0) out.set(l.itemId.toHexString(), (out.get(l.itemId.toHexString()) ?? 0) + left);
    }
  }
  return out;
}

/** Quantity on quality hold per item: stock at hold-area locations, plus held rolls and pallets that stayed where they were. */
export async function onHoldByItem(store: Store, orgId: ObjectId): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const holdLocs = (await store.locations.find({ orgId, type: "quarantine" }, { projection: { _id: 1 } }).toArray()).map((l) => l._id);
  const add = (id: ObjectId, n: number) => out.set(id.toHexString(), (out.get(id.toHexString()) ?? 0) + n);
  if (holdLocs.length) {
    for (const r of await store.stock.find({ orgId, locationId: { $in: holdLocs }, quantity: { $gt: 0 } }, { projection: { itemId: 1, quantity: 1 } }).toArray()) add(r.itemId, r.quantity);
  }
  for (const u of await store.units.find({ orgId, status: "quarantined", ...(holdLocs.length ? { locationId: { $nin: holdLocs } } : {}) }, { projection: { itemId: 1, quantity: 1 } }).toArray()) add(u.itemId, u.quantity);
  return out;
}

export interface Availability { onHand: number; onHold: number; reserved: number; available: number }

export async function availabilityOf(store: Store, orgId: ObjectId, itemIds: ObjectId[]): Promise<Map<string, Availability>> {
  const [stock, hold, reserved] = await Promise.all([
    store.stock.aggregate<{ _id: ObjectId; qty: number }>([{ $match: { orgId, itemId: { $in: itemIds } } }, { $group: { _id: "$itemId", qty: { $sum: "$quantity" } } }]).toArray(),
    onHoldByItem(store, orgId),
    reservedByItem(store, orgId),
  ]);
  const onHand = new Map(stock.map((s) => [s._id.toHexString(), s.qty]));
  return new Map(itemIds.map((id) => {
    const k = id.toHexString();
    const a = { onHand: onHand.get(k) ?? 0, onHold: hold.get(k) ?? 0, reserved: reserved.get(k) ?? 0 };
    return [k, { ...a, available: a.onHand - a.onHold - a.reserved }];
  }));
}

// ---------- presenting ----------

export function statusOf(d: Pick<SalesOrderDoc, "state" | "lines">, shipped: (itemId: ObjectId) => number): SoStatus {
  if (d.state !== "confirmed") return d.state;
  const total = d.lines.reduce((s, l) => s + shipped(l.itemId), 0);
  if (total === 0) return "confirmed";
  return d.lines.every((l) => shipped(l.itemId) >= l.quantity) ? "shipped" : "partial";
}

export async function toSalesOrders(store: Store, docs: SalesOrderDoc[]): Promise<SalesOrder[]> {
  if (!docs.length) return [];
  const orgId = docs[0]!.orgId;
  const itemIds = [...new Map(docs.flatMap((d) => d.lines.map((l) => [l.itemId.toHexString(), l.itemId] as const))).values()];
  const moveIds = docs.flatMap((d) => d.shipments.flatMap((s) => s.movementIds));
  const [items, shipped, avail, partners, moves] = await Promise.all([
    store.items.find({ _id: { $in: itemIds } }, { projection: { sku: 1, name: 1, unit: 1, decimals: 1, tracking: 1 } }).toArray(),
    shippedByOrder(store, docs.map((d) => d._id)),
    availabilityOf(store, orgId, itemIds),
    store.tradingPartners.find({ _id: { $in: docs.flatMap((d) => (d.customerPartnerId ? [d.customerPartnerId] : [])) } }, { projection: { name: 1 } }).toArray(),
    moveIds.length ? store.movements.find({ _id: { $in: moveIds } }, { projection: { reversedBy: 1 } }).toArray() : Promise.resolve([]),
  ]);
  const item = new Map(items.map((i) => [i._id.toHexString(), i]));
  const partnerName = new Map(partners.map((p) => [p._id.toHexString(), p.name]));
  const reversed = new Set(moves.filter((m) => m.reversedBy).map((m) => m._id.toHexString()));
  return docs.map((d) => {
    const sh = (itemId: ObjectId) => shipped.get(`${d._id.toHexString()}:${itemId.toHexString()}`) ?? 0;
    const status = statusOf(d, sh);
    const holding = d.state === "confirmed";
    const lines: SalesOrderLine[] = d.lines.map((l) => {
      const i = item.get(l.itemId.toHexString());
      return {
        itemId: l.itemId.toHexString(), itemSku: i?.sku ?? "", itemName: i?.name ?? "(deleted item)", uom: uomOf(i), tracking: i?.tracking ?? "quantity", quantity: l.quantity, unitPriceCents: l.unitPriceCents,
        shipped: sh(l.itemId), reserved: holding ? Math.max(0, l.quantity - sh(l.itemId)) : 0, available: avail.get(l.itemId.toHexString())?.available ?? 0,
      };
    });
    const shipments: SoShipment[] = d.shipments.map((s) => ({
      number: s.number, at: s.at.toISOString(), by: s.by.name, carrier: s.carrier, trackingNumber: s.trackingNumber, notice: s.notice,
      lines: s.lines.map((l) => ({ itemId: l.itemId.toHexString(), itemName: item.get(l.itemId.toHexString())?.name ?? "(deleted item)", quantity: l.quantity, uom: uomOf(item.get(l.itemId.toHexString())) })),
      reversed: s.movementIds.length > 0 && s.movementIds.every((m) => reversed.has(m.toHexString())),
    }));
    return {
      id: d._id.toHexString(), number: d.number, status, customer: { partnerId: d.customerPartnerId?.toHexString() ?? null, name: d.customerPartnerId ? (partnerName.get(d.customerPartnerId.toHexString()) ?? d.customerName) : d.customerName },
      customerRef: d.customerRef, source: d.source, messageId: d.messageId?.toHexString() ?? null, requestedDate: d.requestedDate, note: d.note, lines,
      totalCents: d.lines.reduce((s, l) => s + lineValueCents(l.quantity, l.unitPriceCents, uomOf(item.get(l.itemId.toHexString())).decimals), 0),
      short: holding && lines.some((l) => l.reserved > 0 && l.available < 0), shipments,
      confirmedAt: d.confirmedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
    };
  });
}

// ---------- writing an order ----------

export type OrderInput = Omit<SalesOrderInput, "lines"> & { lines: { itemId: string; quantity: number; unitPriceCents: number }[] };

/** Checks the customer and the lines; returns what a draft needs, or the reason it can't be made. */
export async function checkOrderInput(store: Store, orgId: ObjectId, input: { customerPartnerId?: string | null; lines?: { itemId: string }[] }): Promise<string | null> {
  if (input.customerPartnerId && !(await store.tradingPartners.findOne({ _id: oidOf(input.customerPartnerId), orgId, kind: "customer" }, { projection: { _id: 1 } }))) return "That customer isn't one of your trading partners";
  if (input.lines) {
    const ids = [...new Set(input.lines.map((l) => l.itemId))];
    if (ids.length !== input.lines.length) return "Each item can be on an order only once. Raise the quantity instead.";
    if ((await store.items.countDocuments({ orgId, _id: { $in: ids.map(oidOf) } })) !== ids.length) return "One of those items doesn't exist";
  }
  return null;
}

export async function createDraft(
  store: Store, orgId: ObjectId, actor: { id: ObjectId | null; name: string },
  input: OrderInput, extra: { source?: "manual" | "exchange"; messageId?: ObjectId } = {},
): Promise<Result<{ order: SalesOrderDoc }>> {
  const partner = input.customerPartnerId ? await store.tradingPartners.findOne({ _id: oidOf(input.customerPartnerId), orgId }, { projection: { name: 1 } }) : null;
  const now = new Date();
  const doc: SalesOrderDoc = {
    _id: new ObjectId(), orgId, number: await nextNumber(store, orgId, "so", "SO-"), state: "draft", customerPartnerId: partner?._id ?? null, customerName: partner?.name ?? input.customerName ?? "",
    customerRef: input.customerRef ?? "", source: extra.source ?? "manual", ...(extra.messageId ? { messageId: extra.messageId } : {}), requestedDate: input.requestedDate ?? null, note: input.note ?? "",
    lines: input.lines.map((l) => ({ itemId: oidOf(l.itemId), quantity: l.quantity, unitPriceCents: l.unitPriceCents })), shipments: [], createdBy: actor, createdAt: now, updatedAt: now,
  };
  try {
    await store.salesOrders.insertOne(doc);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return { ok: false, status: 409, error: "That order has already been made into a sales order" };
    throw e;
  }
  await recordAudit(store, {
    orgId, actor, action: "sales_order.created", entity: soEntity(doc),
    summary: `Created ${doc.number} for ${doc.customerName}${doc.customerRef ? ` (their ref ${doc.customerRef})` : ""}${extra.source === "exchange" ? " from an incoming order" : ""}: ${doc.lines.length} line${doc.lines.length === 1 ? "" : "s"}`,
    snapshot: { customer: doc.customerName, customerRef: doc.customerRef, source: doc.source, lines: doc.lines.map((l) => ({ itemId: l.itemId.toHexString(), quantity: l.quantity, unitPriceCents: l.unitPriceCents })) },
  });
  return { ok: true, order: doc };
}

// ---------- confirm, cancel, close ----------

/** Reserves stock for a draft order. Without allowShortage, an order that doesn't fit is refused and stays a draft. */
export async function confirmOrderDirect(
  store: Store, orgId: ObjectId, actor: { id: ObjectId | null; name: string }, orderId: ObjectId, opts: { allowShortage?: boolean; via?: string } = {},
): Promise<Result<{ order: SalesOrderDoc }>> {
  const now = new Date();
  const claimed = await store.salesOrders.findOneAndUpdate({ _id: orderId, orgId, state: "draft" }, { $set: { state: "confirmed", confirmedAt: now, updatedAt: now, confirmingUntil: new Date(now.getTime() + 15_000) } }, { returnDocument: "after" });
  if (!claimed) {
    const cur = await store.salesOrders.findOne({ _id: orderId, orgId }, { projection: { state: 1 } });
    return cur ? { ok: false, status: 409, error: `That order is ${cur.state}, not a draft` } : { ok: false, status: 404, error: "Order not found" };
  }
  const avail = await availabilityOf(store, orgId, claimed.lines.map((l) => l.itemId));
  const short = claimed.lines.flatMap((l) => {
    const a = avail.get(l.itemId.toHexString())!;
    return a.available < 0 ? [{ l, free: a.available + l.quantity }] : [];
  });
  if (short.length && !opts.allowShortage) {
    await store.salesOrders.updateOne({ _id: orderId, state: "confirmed" }, { $set: { state: "draft", updatedAt: new Date() }, $unset: { confirmedAt: "", confirmingUntil: "" } });
    const items = await store.items.find({ _id: { $in: short.map((s) => s.l.itemId) } }, { projection: { sku: 1, name: 1, unit: 1, decimals: 1 } }).toArray();
    const by = new Map(items.map((i) => [i._id.toHexString(), i]));
    const shortages: SoShortage[] = short.map(({ l, free }) => {
      const i = by.get(l.itemId.toHexString());
      return { itemId: l.itemId.toHexString(), itemSku: i?.sku ?? "", itemName: i?.name ?? "", uom: uomOf(i), needed: l.quantity, available: Math.max(0, free) };
    });
    return { ok: false, status: 409, error: `Not enough available to promise: ${shortages.map((s) => `${s.itemSku || s.itemName} (need ${s.needed}, ${s.available} available)`).join(", ")}`, shortages };
  }
  await store.salesOrders.updateOne({ _id: orderId }, { $unset: { confirmingUntil: "" } });
  await recordAudit(store, {
    orgId, actor, action: "sales_order.confirmed", entity: soEntity(claimed),
    summary: `Confirmed ${claimed.number} and reserved its stock${short.length ? ` (short on ${short.length} line${short.length === 1 ? "" : "s"}: back-order)` : ""}${opts.via ? ` (${opts.via})` : ""}`,
    snapshot: { customer: claimed.customerName, backorder: short.length > 0 },
  });
  return { ok: true, order: claimed };
}

export async function cancelOrder(store: Store, orgId: ObjectId, actor: { id: ObjectId | null; name: string }, orderId: ObjectId, why = ""): Promise<Result<{ order: SalesOrderDoc }>> {
  const doc = await store.salesOrders.findOne({ _id: orderId, orgId });
  if (!doc) return { ok: false, status: 404, error: "Order not found" };
  if (doc.state !== "draft" && doc.state !== "confirmed") return { ok: false, status: 409, error: `A ${doc.state} order can't be cancelled` };
  const shipped = (await shippedByOrder(store, [doc._id])).size;
  if (shipped > 0) return { ok: false, status: 409, error: "Some of it has shipped. Close it instead: that ends the order and releases what is left." };
  const res = await store.salesOrders.findOneAndUpdate({ _id: orderId, orgId, state: doc.state, shippingUntil: { $not: { $gt: new Date() } }, confirmingUntil: { $not: { $gt: new Date() } } }, { $set: { state: "cancelled", updatedAt: new Date() } }, { returnDocument: "after" });
  if (!res) return { ok: false, status: 409, error: "Someone is shipping this order, or just changed it. Reload and try again." };
  await recordAudit(store, { orgId, actor, action: "sales_order.cancelled", entity: soEntity(res), summary: `Cancelled ${res.number}${doc.state === "confirmed" ? " and released its stock" : ""}${why ? ` (${why})` : ""}` });
  return { ok: true, order: res };
}

/** Ends a part-shipped order: what is left is released. */
export async function closeOrder(store: Store, orgId: ObjectId, actor: { id: ObjectId | null; name: string }, orderId: ObjectId): Promise<Result<{ order: SalesOrderDoc }>> {
  const doc = await store.salesOrders.findOne({ _id: orderId, orgId });
  if (!doc) return { ok: false, status: 404, error: "Order not found" };
  if (doc.state !== "confirmed") return { ok: false, status: 409, error: doc.state === "draft" ? "Confirm it first, or cancel it" : `A ${doc.state} order can't be closed` };
  const shipped = await shippedByOrder(store, [doc._id]);
  if (shipped.size === 0) return { ok: false, status: 409, error: "Nothing has shipped. Cancel it instead." };
  if (doc.lines.every((l) => (shipped.get(`${doc._id.toHexString()}:${l.itemId.toHexString()}`) ?? 0) >= l.quantity)) return { ok: false, status: 409, error: "Everything has already shipped" };
  const res = await store.salesOrders.findOneAndUpdate({ _id: orderId, orgId, state: "confirmed", shippingUntil: { $not: { $gt: new Date() } }, confirmingUntil: { $not: { $gt: new Date() } } }, { $set: { state: "closed", updatedAt: new Date() } }, { returnDocument: "after" });
  if (!res) return { ok: false, status: 409, error: "Someone is shipping this order, or just changed it. Reload and try again." };
  await recordAudit(store, { orgId, actor, action: "sales_order.closed", entity: soEntity(res), summary: `Closed ${res.number} short and released what was left` });
  return { ok: true, order: res };
}

// ---------- picking and shipping ----------

/** What could fill what is left on each line: places with stock (not on hold) or labelled units (not on hold), the ones to take first at the top. */
export async function pickList(store: Store, orgId: ObjectId, doc: SalesOrderDoc): Promise<PickLine[]> {
  const shipped = await shippedByOrder(store, [doc._id]);
  const [items, locs] = await Promise.all([
    store.items.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }, { projection: { sku: 1, name: 1, unit: 1, decimals: 1, tracking: 1 } }).toArray(),
    store.locations.find({ orgId }, { projection: { name: 1, type: 1 } }).toArray(),
  ]);
  const loc = new Map(locs.map((l) => [l._id.toHexString(), l]));
  const out: PickLine[] = [];
  for (const l of doc.lines) {
    const remaining = Math.max(0, l.quantity - (shipped.get(`${doc._id.toHexString()}:${l.itemId.toHexString()}`) ?? 0));
    if (remaining === 0) continue;
    const i = items.find((x) => x._id.equals(l.itemId));
    const tracking = i?.tracking ?? "quantity";
    const base = { itemId: l.itemId.toHexString(), itemSku: i?.sku ?? "", itemName: i?.name ?? "", uom: uomOf(i), tracking, remaining };
    if (tracking === "unit") {
      const units = await store.units.find({ orgId, itemId: l.itemId, status: "available", quantity: { $gt: 0 } }).sort({ createdAt: 1 }).limit(200).toArray();
      out.push({ ...base, locations: [], units: units.filter((u) => loc.get(u.locationId.toHexString())?.type !== "quarantine").map((u) => ({ unitId: u._id.toHexString(), code: u.code, lot: u.lot, quantity: u.quantity, locationName: loc.get(u.locationId.toHexString())?.name ?? "" })) });
    } else {
      const rows = await store.stock.find({ orgId, itemId: l.itemId, quantity: { $gt: 0 } }).toArray();
      out.push({ ...base, locations: rows.filter((r) => loc.get(r.locationId.toHexString())?.type !== "quarantine").sort((a, b) => b.quantity - a.quantity).map((r) => ({ locationId: r.locationId.toHexString(), locationName: loc.get(r.locationId.toHexString())?.name ?? "", quantity: r.quantity })), units: [] });
    }
  }
  return out;
}

export type ShipOutcome = { ok: true; order: SalesOrderDoc; shipmentNumber: string; movementIds: ObjectId[]; lines: { itemId: ObjectId; quantity: number }[] };

/**
 * Takes stock out through the ledger for a confirmed order: plain items from a place, rolls and pallets as whole labelled units.
 * Everything is checked before anything is posted. Holds, over-shipping and a second shipper at the same time are refused.
 */
export async function shipOrder(
  store: Store, orgId: ObjectId, actor: Actor, orderId: ObjectId, input: SoShipInput & { carrier?: string; trackingNumber?: string },
): Promise<Result<ShipOutcome> & { partial?: boolean }> {
  const doc = await store.salesOrders.findOne({ _id: orderId, orgId });
  if (!doc) return { ok: false, status: 404, error: "Order not found" };
  if (doc.state !== "confirmed") return { ok: false, status: 409, error: doc.state === "draft" ? "Confirm the order before shipping it" : `A ${doc.state} order can't be shipped` };
  const lease = await store.salesOrders.findOneAndUpdate(
    { _id: doc._id, orgId, state: "confirmed", shippingUntil: { $not: { $gt: new Date() } }, confirmingUntil: { $not: { $gt: new Date() } } },
    { $set: { shippingUntil: new Date(Date.now() + 30_000) } },
    { returnDocument: "after" },
  );
  if (!lease) return { ok: false, status: 409, error: "Someone is shipping this order, or just changed it. Reload and try again." };
  const release = () => store.salesOrders.updateOne({ _id: doc._id }, { $unset: { shippingUntil: "" } });
  const failBefore = async <T extends { ok: false; status: 404 | 409 | 422; error: string }>(r: T) => { await release(); return r; };

  const shipped = await shippedByOrder(store, [doc._id]);
  const onOrder = new Map(doc.lines.map((l) => [l.itemId.toHexString(), l]));
  const seen = new Set<string>();
  type Step = { kind: "qty"; itemId: ObjectId; locationId: ObjectId; quantity: number } | { kind: "unit"; itemId: ObjectId; unitId: ObjectId; code: string; quantity: number };
  const steps: Step[] = [];
  const itemDocs = new Map((await store.items.find({ _id: { $in: doc.lines.map((l) => l.itemId) } }, { projection: { sku: 1, name: 1, tracking: 1 } }).toArray()).map((i) => [i._id.toHexString(), i as Pick<ItemDoc, "_id" | "sku" | "name" | "tracking">]));
  const need = new Map<string, number>(); // item:location -> quantity, to check stock before posting anything

  for (const l of input.lines) {
    const line = onOrder.get(l.itemId);
    const item = itemDocs.get(l.itemId);
    if (!line || !item) return failBefore({ ok: false, status: 409, error: "One of those items isn't on this order" });
    if (seen.has(l.itemId)) return failBefore({ ok: false, status: 409, error: "List each item once" });
    seen.add(l.itemId);
    const remaining = line.quantity - (shipped.get(`${doc._id.toHexString()}:${l.itemId}`) ?? 0);
    if (remaining <= 0) return failBefore({ ok: false, status: 409, error: `${item.name} has already shipped in full` });
    if (item.tracking === "unit") {
      if (!l.unitIds?.length) return failBefore({ ok: false, status: 422, error: `${item.name} is tracked by roll or pallet: choose the labelled units that are going out` });
      if (new Set(l.unitIds).size !== l.unitIds.length) return failBefore({ ok: false, status: 422, error: "A unit is listed twice" });
      let total = 0;
      for (const uid of l.unitIds) {
        const u = await store.units.findOne({ _id: oidOf(uid), orgId });
        if (!u || !u.itemId.equals(line.itemId)) return failBefore({ ok: false, status: 404, error: "One of those units isn't this item" });
        if (u.status === "consumed") return failBefore({ ok: false, status: 409, error: `${u.code} has been used up` });
        if (u.status === "quarantined") return failBefore({ ok: false, status: 409, error: `${u.code} is on quality hold and can't ship until it is released` });
        const where = await store.locations.findOne({ _id: u.locationId, orgId }, { projection: { type: 1 } });
        if (where?.type === "quarantine") return failBefore({ ok: false, status: 409, error: ON_HOLD_AREA });
        total += u.quantity;
        steps.push({ kind: "unit", itemId: line.itemId, unitId: u._id, code: u.code, quantity: u.quantity });
      }
      if (total > remaining) return failBefore({ ok: false, status: 422, error: `${item.name}: those units add up to ${total}, but only ${remaining} is left to ship. Whole units only.` });
    } else {
      if (!l.quantity || !l.locationId) return failBefore({ ok: false, status: 422, error: `${item.name}: say how much and from where` });
      if (l.quantity > remaining) return failBefore({ ok: false, status: 422, error: `${item.name}: only ${remaining} is left to ship on this order` });
      const where = await store.locations.findOne({ _id: oidOf(l.locationId), orgId }, { projection: { type: 1, name: 1 } });
      if (!where) return failBefore({ ok: false, status: 404, error: "Location not found" });
      if (where.type === "quarantine") return failBefore({ ok: false, status: 409, error: ON_HOLD_AREA });
      const have = (await store.stock.findOne({ orgId, itemId: line.itemId, locationId: where._id }))?.quantity ?? 0;
      if (have < l.quantity) return failBefore({ ok: false, status: 422, error: `${item.name}: only ${have} in stock at ${where.name}` });
      need.set(`${l.itemId}:${l.locationId}`, l.quantity);
      steps.push({ kind: "qty", itemId: line.itemId, locationId: where._id, quantity: l.quantity });
    }
  }

  const number = `${doc.number}-${doc.shipments.length + 1}`;
  const reason = `Shipped: ${doc.number}${doc.customerName ? ` to ${doc.customerName}` : ""}`;
  const movementIds: ObjectId[] = [];
  const shippedLines = new Map<string, number>();
  let failure: { status: 404 | 409 | 422; error: string } | null = null;
  for (const s of steps) {
    if (s.kind === "qty") {
      if ((await changeStock(store, orgId, s.itemId, s.locationId, -s.quantity)) === null) { failure = { status: 422, error: "Stock at that place changed while shipping. Reload and try again." }; break; }
      movementIds.push(await logMovement(store, { orgId, type: "ship", itemId: s.itemId, locationId: s.locationId, delta: -s.quantity, reason, salesOrderId: doc._id, actor }));
    } else {
      const r = await adjustUnit(store, orgId, actor, s.unitId, -s.quantity, reason, { type: "ship" });
      if (!r.ok) { failure = { status: r.status as 404 | 409 | 422, error: r.error }; break; }
      await store.movements.updateMany({ _id: { $in: r.movementIds } }, { $set: { salesOrderId: doc._id } });
      movementIds.push(...r.movementIds);
    }
    shippedLines.set(s.itemId.toHexString(), (shippedLines.get(s.itemId.toHexString()) ?? 0) + s.quantity);
  }
  const lines = [...shippedLines].map(([k, quantity]) => ({ itemId: oidOf(k), quantity }));
  if (!movementIds.length) { await release(); return { ok: false, ...(failure ?? { status: 409 as const, error: "Nothing to ship" }) }; }

  const now = new Date();
  const updated = await store.salesOrders.findOneAndUpdate(
    { _id: doc._id },
    { $push: { shipments: { number, at: now, by: actorRef(actor), carrier: input.carrier ?? "", trackingNumber: input.trackingNumber ?? "", movementIds, lines, notice: null } }, $unset: { shippingUntil: "" }, $set: { updatedAt: now } },
    { returnDocument: "after" },
  );
  await recordAudit(store, {
    orgId, actor: { id: actor.userId, name: actor.userName }, action: "sales_order.shipped", entity: soEntity(doc),
    summary: `Shipped ${number} for ${doc.number}: ${lines.length} line${lines.length === 1 ? "" : "s"}${input.trackingNumber ? ` (tracking ${input.trackingNumber})` : ""}${failure ? ` (stopped early: ${failure.error})` : ""}`,
    refs: { movementIds: movementIds.map(String), shipment: number },
  });
  if (failure) return { ok: false, ...failure, partial: true };
  void need;
  return { ok: true, order: updated!, shipmentNumber: number, movementIds, lines };
}
