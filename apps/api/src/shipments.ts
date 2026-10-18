import { zValidator } from "@hono/zod-validator";
import { formatQty, objectIdSchema, shipmentInputSchema, shipmentReceiveSchema, uomOf, type Shipment, type ShipmentStatus } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import { isDuplicateKey, type ShipmentDoc, type Store } from "./db.js";
import { actorOf } from "./items.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { receiveAgainstOrder } from "./purchasing.js";
import { postAdjustment } from "./stock-service.js";

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);

/** What has arrived against each shipment line: live receipts tagged with the shipment that haven't been reversed. */
async function receivedBy(store: Store, ids: ObjectId[]) {
  const rows = await store.movements
    .aggregate<{ _id: { s: ObjectId; item: ObjectId }; qty: number }>([
      { $match: { shipmentId: { $in: ids }, type: "receive", reversedBy: { $exists: false } } },
      { $group: { _id: { s: "$shipmentId", item: "$itemId" }, qty: { $sum: "$delta" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [`${r._id.s.toHexString()}:${r._id.item.toHexString()}`, r.qty]));
}

async function present(store: Store, orgId: ObjectId, docs: ShipmentDoc[]): Promise<Shipment[]> {
  if (!docs.length) return [];
  const [items, suppliers, orders, received] = await Promise.all([
    store.items.find({ orgId, _id: { $in: docs.flatMap((d) => d.lines.map((l) => l.itemId)) } }).toArray(),
    store.suppliers.find({ orgId, _id: { $in: docs.map((d) => d.supplierId) } }, { projection: { name: 1 } }).toArray(),
    store.purchaseOrders.find({ orgId, _id: { $in: docs.flatMap((d) => (d.purchaseOrderId ? [d.purchaseOrderId] : [])) } }).toArray(),
    receivedBy(store, docs.map((d) => d._id)),
  ]);
  const item = new Map(items.map((i) => [i._id.toHexString(), i]));
  const sName = new Map(suppliers.map((s) => [s._id.toHexString(), s.name]));
  const po = new Map(orders.map((o) => [o._id.toHexString(), o]));
  return docs.map((d) => {
    const lines = d.lines.map((l) => {
      const it = item.get(l.itemId.toHexString());
      return { itemId: l.itemId.toHexString(), itemSku: it?.sku ?? "", itemName: it?.name ?? "Deleted item", uom: uomOf(it), quantity: l.quantity, supplierLot: l.supplierLot, received: received.get(`${d._id.toHexString()}:${l.itemId.toHexString()}`) ?? 0 };
    });
    const status: ShipmentStatus = d.status === "cancelled" ? "cancelled" : lines.every((l) => l.received >= l.quantity) ? "received" : lines.some((l) => l.received > 0) ? "partial" : "expected";
    const order = d.purchaseOrderId ? po.get(d.purchaseOrderId.toHexString()) : undefined;
    // What the supplier said that doesn't line up with the order we placed.
    const warnings: string[] = [];
    if (order) {
      for (const l of d.lines) {
        const it = item.get(l.itemId.toHexString());
        const pl = order.lines.find((x) => x.itemId.equals(l.itemId));
        const u = uomOf(it);
        if (!pl) warnings.push(`${it?.name ?? "An item"} isn't on ${order.number}.`);
        else if (l.quantity > pl.quantity) warnings.push(`${it?.name ?? "An item"}: ${formatQty(l.quantity, u)} shipped, ${formatQty(pl.quantity, u)} ordered.`);
      }
      if (order.state === "draft" || order.state === "cancelled") warnings.push(`${order.number} is ${order.state === "draft" ? "still a draft" : "cancelled"}.`);
    }
    return {
      id: d._id.toHexString(), number: d.number, status, supplierId: d.supplierId.toHexString(), supplierName: sName.get(d.supplierId.toHexString()) ?? "Deleted supplier",
      purchaseOrderId: d.purchaseOrderId?.toHexString() ?? null, purchaseOrderNumber: order?.number ?? null, reference: d.reference, shipDate: d.shipDate, expectedDate: d.expectedDate,
      carrier: d.carrier, tracking: d.tracking, lines, note: d.note, createdBy: d.createdBy.name, createdAt: d.createdAt.toISOString(), warnings,
    };
  });
}

/**
 * Shipments: an advance ship notice (ASN) from a supplier, what they say is on its way. Receiving against one
 * puts stock in through the ledger like any receipt, tagged with the shipment (and the purchase order, if it
 * has one), so the invoice match and the receiving record both see it. A shipment never changes stock by itself.
 */
export function createShipmentRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", async (c) => {
    const org = c.get("org");
    const q = z.object({ status: z.enum(["open", "expected", "partial", "received", "cancelled"]).optional(), supplierId: objectIdSchema.optional(), purchaseOrderId: objectIdSchema.optional() }).parse(c.req.query());
    const docs = await store.shipments.find({ orgId: org._id, ...(q.supplierId ? { supplierId: oid(q.supplierId) } : {}), ...(q.purchaseOrderId ? { purchaseOrderId: oid(q.purchaseOrderId) } : {}) }).sort({ createdAt: -1 }).limit(300).toArray();
    const all = await present(store, org._id, docs);
    return c.json(q.status ? all.filter((s) => (q.status === "open" ? s.status === "expected" || s.status === "partial" : s.status === q.status)) : all);
  });

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const d = await store.shipments.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    return d ? c.json((await present(store, org._id, [d]))[0]) : c.json({ error: "Shipment not found" }, 404);
  });

  r.post("/", zValidator("json", shipmentInputSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const input = c.req.valid("json");
    if (!(await store.suppliers.findOne({ _id: oid(input.supplierId), orgId: org._id }, { projection: { _id: 1 } }))) return c.json({ error: "Supplier not found" }, 404);
    if (input.purchaseOrderId && !(await store.purchaseOrders.findOne({ _id: oid(input.purchaseOrderId), orgId: org._id }, { projection: { _id: 1 } }))) return c.json({ error: "Purchase order not found" }, 404);
    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    if ((await store.items.countDocuments({ orgId: org._id, _id: { $in: itemIds.map(oid) } })) !== itemIds.length) return c.json({ error: "One of those items isn't in this organization" }, 404);
    if (itemIds.length !== input.lines.length) return c.json({ error: "List each item once" }, 400);
    const doc: ShipmentDoc = {
      _id: new ObjectId(), orgId: org._id, number: "", status: "expected", supplierId: oid(input.supplierId), purchaseOrderId: input.purchaseOrderId ? oid(input.purchaseOrderId) : null,
      reference: input.reference, referenceKey: input.reference.trim().toUpperCase(), shipDate: input.shipDate, expectedDate: input.expectedDate, carrier: input.carrier, tracking: input.tracking,
      lines: input.lines.map((l) => ({ itemId: oid(l.itemId), quantity: l.quantity, supplierLot: l.supplierLot })), note: input.note, createdBy: { id: oid(me.id), name: me.name }, createdAt: new Date(),
    };
    try {
      doc.number = await nextNumber(store, org._id, "shipment", "SHP-");
      await store.shipments.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: `A shipment with the reference "${input.reference}" is already recorded for this supplier` }, 409);
      throw e;
    }
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "shipment.created", entity: { type: "shipment", id: doc._id.toHexString(), label: doc.number },
      summary: `Recorded ${doc.number}: the supplier's shipment ${doc.reference} with ${doc.lines.length} ${doc.lines.length === 1 ? "line" : "lines"} expected`, refs: { shipmentId: doc._id.toHexString() },
    });
    return c.json((await present(store, org._id, [doc]))[0], 201);
  });

  r.post("/:id/cancel", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const doc = await store.shipments.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!doc) return c.json({ error: "Shipment not found" }, 404);
    const [shown] = await present(store, org._id, [doc]);
    if (shown!.status === "cancelled") return c.json({ error: "Already cancelled" }, 409);
    if (shown!.lines.some((l) => l.received > 0)) return c.json({ error: "Some of it has been received. Reverse those receipts first." }, 409);
    await store.shipments.updateOne({ _id: doc._id }, { $set: { status: "cancelled" } });
    await recordAudit(store, { orgId: org._id, actor: auditActor(c.get("user")), action: "shipment.cancelled", entity: { type: "shipment", id: doc._id.toHexString(), label: doc.number }, summary: `Cancelled ${doc.number} (${doc.reference})` });
    return c.json((await present(store, org._id, [{ ...doc, status: "cancelled" }]))[0]);
  });

  /** Receive what arrived against this shipment. Leave the lines out to receive everything still expected. */
  r.post("/:id/receive", zValidator("param", idParam), zValidator("json", shipmentReceiveSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const doc = await store.shipments.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!doc) return c.json({ error: "Shipment not found" }, 404);
    const [shown] = await present(store, org._id, [doc]);
    if (shown!.status === "cancelled") return c.json({ error: "This shipment was cancelled" }, 409);
    const input = c.req.valid("json");
    const onShipment = new Map(shown!.lines.map((l) => [l.itemId, l]));
    let lines: { itemId: string; quantity: number }[];
    if (input.lines) {
      for (const l of input.lines) if (!onShipment.has(l.itemId)) return c.json({ error: "One of those items isn't on this shipment" }, 400);
      if (new Set(input.lines.map((l) => l.itemId)).size !== input.lines.length) return c.json({ error: "List each item once" }, 400);
      lines = input.lines;
    } else {
      lines = shown!.lines.filter((l) => l.quantity > l.received).map((l) => ({ itemId: l.itemId, quantity: l.quantity - l.received }));
    }
    if (!lines.length) return c.json({ error: "Everything on this shipment has already been received" }, 409);
    const withLots = lines.map((l) => ({ ...l, supplierLot: onShipment.get(l.itemId)!.supplierLot }));

    let body: { movementIds?: string[]; error?: string; ncrs?: unknown[] };
    let status: number;
    if (doc.purchaseOrderId) {
      const po = await store.purchaseOrders.findOne({ _id: doc.purchaseOrderId, orgId: org._id });
      if (!po) return c.json({ error: "The purchase order can't be found" }, 404);
      if (po.state !== "ordered") return c.json({ error: po.state === "draft" ? "Place the purchase order before receiving against it" : `The purchase order is ${po.state}, so it can't be received against` }, 409);
      const res = await receiveAgainstOrder(store, org._id, me, po, { locationId: input.locationId, inspect: input.inspect, lines: withLots }, { shipmentId: doc._id });
      body = res.body as typeof body;
      status = res.status;
    } else {
      if (input.inspect) return c.json({ error: "Inspect-before-release needs a purchase order on the shipment" }, 400);
      if (!(await store.locations.findOne({ _id: oid(input.locationId), orgId: org._id }, { projection: { _id: 1 } }))) return c.json({ error: "Location not found" }, 404);
      const ids: ObjectId[] = [];
      status = 201;
      body = {};
      for (const l of withLots) {
        const res = await postAdjustment(store, org._id, actorOf(me), { itemId: oid(l.itemId), locationId: oid(input.locationId), delta: l.quantity, reason: `Received: ${doc.number}`, type: "receive", supplierLot: l.supplierLot });
        if (!res.ok) { status = res.status; body = { error: res.error }; break; }
        await store.movements.updateMany({ _id: { $in: res.movementIds } }, { $set: { shipmentId: doc._id } });
        ids.push(...res.movementIds);
      }
      if (status === 201) body = { movementIds: ids.map(String) };
    }
    if (status >= 400) return c.json(body as never, status as never);
    // Receipts made through the order are tagged with the order only; tag them with this shipment too.
    const [after] = await present(store, org._id, [doc]);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "shipment.received", entity: { type: "shipment", id: doc._id.toHexString(), label: doc.number },
      summary: `Received against ${doc.number} (${doc.reference}): ${withLots.length} ${withLots.length === 1 ? "line" : "lines"}, now ${after!.status}`, refs: { shipmentId: doc._id.toHexString(), movementIds: body.movementIds ?? [] },
    });
    return c.json({ shipment: after, movementIds: body.movementIds ?? [], ...(body.ncrs?.length ? { ncrs: body.ncrs } : {}) }, 201);
  });

  return r;
}
