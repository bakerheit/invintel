import { zValidator } from "@hono/zod-validator";
import {
  lineValueCents,
  uomOf,
  objectIdSchema,
  poFromSuggestionsSchema,
  poReceiveInputSchema,
  purchaseOrderInputSchema,
  purchaseOrderUpdateSchema,
  supplierInputSchema,
  suggestedOrderQty,
  supplierUpdateSchema,
  type PoReceiveResult,
  type PoStatus,
  type PurchaseOrder,
  type ReorderSuggestion,
  type Supplier,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, diffFields, recordAudit, summarizeChanges } from "./audit.js";
import { createApproval, isSoleApprover, ruleFor, toApproval } from "./approvals-core.js";
import { duplicateField, isDuplicateKey, type PurchaseOrderDoc, type Store, type SupplierDoc } from "./db.js";
import { nextNumber } from "./counters.js";
import { loadItems, positionOf } from "./item-queries.js";
import { actorOf } from "./items.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { INSPECT_REASON, openHold } from "./quality.js";
import { postAdjustment } from "./stock-service.js";

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);
const ci = { locale: "en", strength: 2 } as const;

/** What has arrived on each order and item: live receipts that point at the order and haven't been reversed. */
export async function receivedByOrder(store: Store, orderIds: ObjectId[]) {
  const rows = await store.movements
    .aggregate<{ _id: { po: ObjectId; item: ObjectId }; qty: number }>([
      { $match: { purchaseOrderId: { $in: orderIds }, type: "receive", reversedBy: { $exists: false } } },
      { $group: { _id: { po: "$purchaseOrderId", item: "$itemId" }, qty: { $sum: "$delta" } } },
    ])
    .toArray();
  const out = new Map<string, number>();
  for (const r of rows) out.set(`${r._id.po.toHexString()}:${r._id.item.toHexString()}`, r.qty);
  return out;
}

export async function toOrders(store: Store, docs: PurchaseOrderDoc[]): Promise<PurchaseOrder[]> {
  if (!docs.length) return [];
  const [suppliers, items, received] = await Promise.all([
    store.suppliers.find({ _id: { $in: docs.map((d) => d.supplierId) } }).toArray(),
    store.items.find({ _id: { $in: docs.flatMap((d) => d.lines.map((l) => l.itemId)) } }, { projection: { sku: 1, name: 1, unit: 1, decimals: 1 } }).toArray(),
    receivedByOrder(store, docs.map((d) => d._id)),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s._id.toHexString(), s.name]));
  const item = new Map(items.map((i) => [i._id.toHexString(), i]));
  return docs.map((d) => {
    const lines = d.lines.map((l) => ({
      itemId: l.itemId.toHexString(),
      itemSku: item.get(l.itemId.toHexString())?.sku ?? "",
      itemName: item.get(l.itemId.toHexString())?.name ?? "Deleted item",
      uom: uomOf(item.get(l.itemId.toHexString())),
      quantity: l.quantity,
      unitCostCents: l.unitCostCents,
      received: received.get(`${d._id.toHexString()}:${l.itemId.toHexString()}`) ?? 0,
    }));
    const orderedUnits = lines.reduce((s, l) => s + l.quantity, 0);
    const receivedUnits = lines.reduce((s, l) => s + l.received, 0);
    const complete = lines.every((l) => l.received >= l.quantity);
    let status: PoStatus;
    if (d.state === "draft" || d.state === "cancelled") status = d.state;
    else if (d.state === "closed" || complete) status = "received";
    else status = receivedUnits > 0 ? "partial" : "ordered";
    return {
      id: d._id.toHexString(),
      number: d.number,
      status,
      closedShort: d.state === "closed" && !complete,
      supplierId: d.supplierId.toHexString(),
      supplierName: supplierName.get(d.supplierId.toHexString()) ?? "Deleted supplier",
      expectedDate: d.expectedDate,
      note: d.note,
      lines,
      totalCents: lines.reduce((s, l) => s + lineValueCents(l.quantity, l.unitCostCents, item.get(l.itemId)?.decimals ?? 0), 0),
      orderedUnits,
      receivedUnits,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  });
}

const poEntity = (d: { _id: ObjectId; number: string }) => ({ type: "purchase_order" as const, id: d._id.toHexString(), label: d.number });
export const isOpen = (o: PurchaseOrder) => o.status === "ordered" || o.status === "partial";

/** Places a draft order without a request context. Used when an approval is granted. */
export async function placeOrderDirect(store: Store, orgId: ObjectId, orderId: ObjectId, user: { id: string; name: string }, via: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await store.purchaseOrders.findOneAndUpdate({ _id: orderId, orgId, state: "draft" }, { $set: { state: "ordered", updatedAt: new Date() } }, { returnDocument: "after" });
  if (!res) return { ok: false, error: "The order isn't a draft any more" };
  await recordAudit(store, { orgId, actor: auditActor(user), action: "purchase_order.ordered", entity: poEntity(res), summary: `Placed ${res.number} (${via})` });
  return { ok: true };
}

/**
 * Receives stock against an order the dock has in front of it. Used by the order's own receive button and by
 * receiving a shipment (an advance ship notice), which tags its receipts with the shipment as well.
 */
export async function receiveAgainstOrder(
  store: Store,
  orgId: ObjectId,
  user: { id: string; name: string },
  doc: PurchaseOrderDoc,
  input: z.output<typeof poReceiveInputSchema>,
  extra: { shipmentId?: ObjectId } = {},
): Promise<{ status: number; body: unknown }> {
    const onOrder = new Set(doc.lines.map((l) => l.itemId.toHexString()));
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (!onOrder.has(l.itemId)) return { status: 400 as number, body: { error: "One of those items isn't on this order" } };
      if (seen.has(l.itemId)) return { status: 400 as number, body: { error: "List each item once" } };
      seen.add(l.itemId);
    }
    // Check everything first: lines are posted one by one, so a failure halfway would leave a part-received
    // order that a retry then receives twice.
    if (!(await store.locations.findOne({ _id: oid(input.locationId), orgId }, { projection: { _id: 1 } }))) return { status: 404 as number, body: { error: "Location not found" } };
    if ((await store.items.countDocuments({ orgId, _id: { $in: input.lines.map((l) => oid(l.itemId)) } })) !== input.lines.length) {
      return { status: 404 as number, body: { error: "One of those items has been deleted. Nothing was received." } };
    }
    const [before] = await toOrders(store, [doc]);
    // Take the lease only if the order is still open, so a cancel that just won can't be followed by stock landing on it.
    const lease = await store.purchaseOrders.findOneAndUpdate({ _id: doc._id, state: "ordered" }, { $set: { receivingUntil: new Date(Date.now() + 30_000) } });
    if (!lease) return { status: 409 as number, body: { error: "This order was just changed. Reload it." } };
    const actor = actorOf(user);
    const movementIds: ObjectId[] = [];
    // The lines of this delivery are one document: undo from the floor takes all of it back.
    const batchId = new ObjectId();
    for (const l of input.lines) {
      const res = await postAdjustment(store, orgId, actor, { itemId: oid(l.itemId), locationId: oid(input.locationId), delta: l.quantity, reason: `Received: ${doc.number}`, type: "receive", supplierLot: l.supplierLot, ...(l.expiresOn ? { expiresOn: l.expiresOn } : {}), batchId });
      if (!res.ok) {
        // Lines before this one are already posted (and counted against the order); the caller is told.
        return { status: res.status as number, body: { error: res.error, partial: movementIds.length > 0 } };
      }
      await store.movements.updateMany({ _id: { $in: res.movementIds } }, { $set: { purchaseOrderId: doc._id, ...(extra.shipmentId ? { shipmentId: extra.shipmentId } : {}) } });
      movementIds.push(...res.movementIds);
    }
    // Inspect before release: each line goes straight on quality hold, tied to this order and its supplier lot.
    const ncrs: { id: string; number: string }[] = [];
    if (input.inspect) {
      for (const l of input.lines) {
        const hold = await openHold(store, orgId, actor, { reason: INSPECT_REASON, note: doc.number, source: "receiving", itemId: l.itemId, locationId: input.locationId, quantity: l.quantity, supplierLot: l.supplierLot, purchaseOrderId: doc._id });
        if (hold.ok) { ncrs.push({ id: hold.ncr._id.toHexString(), number: hold.ncr.number }); await store.movements.updateMany({ _id: { $in: hold.movementIds } }, { $set: { batchId } }); movementIds.push(...hold.movementIds); }
        else {
          await store.purchaseOrders.updateOne({ _id: doc._id }, { $unset: { receivingUntil: "" } });
          return { status: hold.status as number, body: { error: `Received, but a line could not be put on hold: ${hold.error}`, partial: true } };
        }
      }
    }
    await store.purchaseOrders.updateOne({ _id: doc._id }, { $unset: { receivingUntil: "" }, $set: { updatedAt: new Date() } });
    const [order] = await toOrders(store, [doc]);
    const overReceived = order!.lines.filter((l) => l.received > l.quantity).map((l) => ({ itemId: l.itemId, itemName: l.itemName, over: l.received - l.quantity }));
    await recordAudit(store, {
      orgId, actor: auditActor(user), action: "purchase_order.received", entity: poEntity(doc),
      summary: `Received ${input.lines.reduce((s, l) => s + l.quantity, 0).toLocaleString("en-US")} units against ${doc.number}${overReceived.length ? " (over-received)" : ""}`,
      refs: { movementIds: movementIds.map(String), status: order!.status, from: before!.status },
    });
    const result: PoReceiveResult = { order: order!, batchId: batchId.toHexString(), movementIds: movementIds.map(String), overReceived, ...(ncrs.length ? { ncrs } : {}) };
    return { status: 201, body: result };
}

export function createPurchasingRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  async function checkLines(orgId: ObjectId, supplierId: string | undefined, lines: { itemId: string }[] | undefined) {
    if (supplierId && !(await store.suppliers.findOne({ _id: oid(supplierId), orgId }, { projection: { _id: 1 } }))) return "Supplier not found";
    if (lines) {
      const ids = [...new Set(lines.map((l) => l.itemId))];
      if (ids.length !== lines.length) return "Each item can be on an order only once. Raise the quantity instead.";
      if ((await store.items.countDocuments({ orgId, _id: { $in: ids.map(oid) } })) !== ids.length) return "One of those items doesn't exist";
    }
    return null;
  }

  // ---------- suppliers ----------

  const supplierView = (s: SupplierDoc, openOrders: number): Supplier => ({
    id: s._id.toHexString(), name: s.name, contact: s.contact, email: s.email, phone: s.phone, notes: s.notes, address: s.address ?? null, openOrders, createdAt: s.createdAt.toISOString(),
  });

  r.get("/suppliers", async (c) => {
    const orgId = c.get("org")._id;
    const [docs, orders] = await Promise.all([
      store.suppliers.find({ orgId }).collation(ci).sort({ name: 1 }).toArray(),
      store.purchaseOrders.find({ orgId, state: "ordered" }).toArray().then((d) => toOrders(store, d)),
    ]);
    const open = new Map<string, number>();
    for (const o of orders.filter(isOpen)) open.set(o.supplierId, (open.get(o.supplierId) ?? 0) + 1);
    return c.json(docs.map((s) => supplierView(s, open.get(s._id.toHexString()) ?? 0)));
  });

  r.post("/suppliers", requireRole("admin"), zValidator("json", supplierInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const doc: SupplierDoc = { _id: new ObjectId(), orgId, ...c.req.valid("json"), createdAt: new Date() };
    try {
      await store.suppliers.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: "A supplier with that name already exists" }, 409);
      throw e;
    }
    await recordAudit(store, {
      orgId, actor: auditActor(c.get("user")), action: "supplier.created",
      entity: { type: "supplier", id: doc._id.toHexString(), label: doc.name },
      summary: `Added supplier ${doc.name}`, snapshot: { name: doc.name, contact: doc.contact, email: doc.email, phone: doc.phone },
    });
    return c.json(supplierView(doc, 0), 201);
  });

  r.patch("/suppliers/:id", requireRole("admin"), zValidator("param", idParam), zValidator("json", supplierUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const _id = oid(c.req.valid("param").id);
    const patch = c.req.valid("json");
    let before: SupplierDoc | null;
    try {
      before = await store.suppliers.findOneAndUpdate({ _id, orgId }, { $set: patch });
    } catch (e) {
      if (isDuplicateKey(e) && duplicateField(e) === "name") return c.json({ error: "A supplier with that name already exists" }, 409);
      throw e;
    }
    if (!before) return c.json({ error: "Supplier not found" }, 404);
    const changes = diffFields({ name: before.name, contact: before.contact, email: before.email, phone: before.phone, notes: before.notes }, patch);
    if (changes.length) {
      await recordAudit(store, {
        orgId, actor: auditActor(c.get("user")), action: "supplier.updated",
        entity: { type: "supplier", id: _id.toHexString(), label: patch.name ?? before.name }, summary: summarizeChanges(changes), changes,
      });
    }
    const fresh = (await store.suppliers.findOne({ _id }))!;
    return c.json(supplierView(fresh, 0));
  });

  // ---------- reorder suggestions ----------

  r.get("/suggestions", async (c) => {
    const orgId = c.get("org")._id;
    const [items, openDocs] = await Promise.all([loadItems(store, orgId), store.purchaseOrders.find({ orgId, state: "ordered" }).toArray()]);
    const open = (await toOrders(store, openDocs)).filter(isOpen);
    const onOrder = new Map<string, number>();
    for (const o of open) for (const l of o.lines) onOrder.set(l.itemId, (onOrder.get(l.itemId) ?? 0) + Math.max(0, l.quantity - l.received));
    const out: ReorderSuggestion[] = [];
    for (const i of items) {
      // Judged on what is free to promise (INV-16): get back to twice the reorder level, or cover what is over-promised, counting what is already coming.
      const pos = positionOf(i);
      const coming = onOrder.get(i._id.toHexString()) ?? 0;
      const suggestedQuantity = suggestedOrderQty(pos, coming);
      if (suggestedQuantity === 0) continue;
      out.push({ itemId: i._id.toHexString(), sku: i.sku, name: i.name, uom: uomOf(i), quantity: pos.onHand, reserved: pos.reserved, available: pos.available, reorderLevel: i.reorderLevel, onOrder: coming, suggestedQuantity, unitCostCents: i.unitCostCents });
    }
    const urgency = (s: ReorderSuggestion) => (s.reorderLevel > 0 ? s.available / s.reorderLevel : s.available);
    out.sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name, "en"));
    return c.json(out);
  });

  // ---------- orders ----------

  const create = async (c: any, input: { supplierId: string; expectedDate: string | null; note: string; lines: { itemId: string; quantity: number; unitCostCents: number }[] }) => {
    const orgId = c.get("org")._id as ObjectId;
    const problem = await checkLines(orgId, input.supplierId, input.lines);
    if (problem) return c.json({ error: problem }, 400);
    const now = new Date();
    const doc: PurchaseOrderDoc = {
      _id: new ObjectId(), orgId, number: await nextNumber(store, orgId, "po", "PO-"), state: "draft", supplierId: oid(input.supplierId),
      expectedDate: input.expectedDate, note: input.note, lines: input.lines.map((l) => ({ itemId: oid(l.itemId), quantity: l.quantity, unitCostCents: l.unitCostCents })),
      createdAt: now, updatedAt: now,
    };
    await store.purchaseOrders.insertOne(doc);
    const [order] = await toOrders(store, [doc]);
    await recordAudit(store, {
      orgId, actor: auditActor(c.get("user")), action: "purchase_order.created", entity: poEntity(doc),
      summary: `Created ${doc.number} for ${order!.supplierName}: ${order!.orderedUnits.toLocaleString("en-US")} units, ${order!.lines.length} ${order!.lines.length === 1 ? "line" : "lines"}`,
      snapshot: { supplier: order!.supplierName, lines: order!.lines.map((l) => ({ sku: l.itemSku, quantity: l.quantity, unitCostCents: l.unitCostCents })), expectedDate: doc.expectedDate },
    });
    return c.json(order, 201);
  };

  r.get("/orders", async (c) => {
    const orgId = c.get("org")._id;
    const docs = await store.purchaseOrders.find({ orgId }).sort({ createdAt: -1 }).limit(200).toArray();
    return c.json(await toOrders(store, docs));
  });

  r.get("/orders/:id", zValidator("param", idParam), async (c) => {
    const doc = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id });
    return doc ? c.json((await toOrders(store, [doc]))[0]) : c.json({ error: "Order not found" }, 404);
  });

  r.post("/orders", requireRole("admin"), zValidator("json", purchaseOrderInputSchema), (c) => create(c, c.req.valid("json")));

  r.post("/orders/from-suggestions", requireRole("admin"), zValidator("json", poFromSuggestionsSchema), async (c) => {
    const { supplierId, itemIds } = c.req.valid("json");
    const orgId = c.get("org")._id;
    const items = await loadItems(store, orgId);
    const wanted = new Set(itemIds);
    const lines: { itemId: string; quantity: number; unitCostCents: number }[] = [];
    // Reuse the suggestion maths so what's shown on screen is what gets ordered.
    const openDocs = await store.purchaseOrders.find({ orgId, state: "ordered" }).toArray();
    const onOrder = new Map<string, number>();
    for (const o of (await toOrders(store, openDocs)).filter(isOpen)) for (const l of o.lines) onOrder.set(l.itemId, (onOrder.get(l.itemId) ?? 0) + Math.max(0, l.quantity - l.received));
    for (const i of items) {
      if (!wanted.has(i._id.toHexString())) continue;
      const qty = suggestedOrderQty(positionOf(i), onOrder.get(i._id.toHexString()) ?? 0); // exactly what the screen suggests
      if (qty > 0) lines.push({ itemId: i._id.toHexString(), quantity: qty, unitCostCents: i.unitCostCents });
    }
    if (!lines.length) return c.json({ error: "Nothing to order for those items" }, 400);
    return create(c, { supplierId, expectedDate: null, note: "Created from reorder suggestions", lines });
  });

  /** Drafts can be edited freely. Once placed, only the date and note can change. */
  r.patch("/orders/:id", requireRole("admin"), zValidator("param", idParam), zValidator("json", purchaseOrderUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Order not found" }, 404);
    const patch = c.req.valid("json");
    if (doc.state !== "draft" && (patch.lines || patch.supplierId)) return c.json({ error: "A placed order's lines and supplier can't change. Cancel it and make a new one." }, 409);
    if (doc.state === "closed" || doc.state === "cancelled") return c.json({ error: `A ${doc.state} order can't be edited` }, 409);
    const problem = await checkLines(orgId, patch.supplierId, patch.lines);
    if (problem) return c.json({ error: problem }, 400);
    const $set: Partial<PurchaseOrderDoc> = { updatedAt: new Date() };
    if (patch.supplierId) $set.supplierId = oid(patch.supplierId);
    if (patch.expectedDate !== undefined) $set.expectedDate = patch.expectedDate;
    if (patch.note !== undefined) $set.note = patch.note;
    if (patch.lines) $set.lines = patch.lines.map((l) => ({ itemId: oid(l.itemId), quantity: l.quantity, unitCostCents: l.unitCostCents }));
    await store.purchaseOrders.updateOne({ _id: doc._id }, { $set });
    const fresh = (await store.purchaseOrders.findOne({ _id: doc._id }))!;
    await recordAudit(store, {
      orgId, actor: auditActor(c.get("user")), action: "purchase_order.updated", entity: poEntity(doc),
      summary: `Edited ${doc.number}${patch.lines ? ` (${patch.lines.length} lines)` : ""}`,
      changes: [
        ...(patch.expectedDate !== undefined && patch.expectedDate !== doc.expectedDate ? [{ field: "expectedDate", from: doc.expectedDate, to: patch.expectedDate }] : []),
        ...(patch.note !== undefined && patch.note !== doc.note ? [{ field: "note", from: doc.note, to: patch.note }] : []),
      ],
    });
    return c.json((await toOrders(store, [fresh]))[0]);
  });

  async function transition(c: any, from: PurchaseOrderDoc["state"][], to: PurchaseOrderDoc["state"], action: "purchase_order.ordered" | "purchase_order.cancelled" | "purchase_order.closed", verb: string, extra?: (o: PurchaseOrder) => string | null) {
    const orgId = c.get("org")._id as ObjectId;
    const doc = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Order not found" }, 404);
    const [before] = await toOrders(store, [doc]);
    if (!from.includes(doc.state)) return c.json({ error: `A ${before!.status} order can't be ${verb}` }, 409);
    const refusal = extra?.(before!);
    if (refusal) return c.json({ error: refusal }, 409);
    // The state is part of the filter so two people clicking at once can't both win.
    // A receive in progress holds a short lease; cancelling or closing waits for it.
    const res = await store.purchaseOrders.findOneAndUpdate(
      { _id: doc._id, state: doc.state, $or: [{ receivingUntil: { $exists: false } }, { receivingUntil: { $lt: new Date() } }] },
      { $set: { state: to, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!res) return c.json({ error: "Someone is receiving against this order, or just changed it. Reload and try again." }, 409);
    const [after] = await toOrders(store, [res]);
    await recordAudit(store, { orgId, actor: auditActor(c.get("user")), action, entity: poEntity(doc), summary: `${verb[0]!.toUpperCase()}${verb.slice(1)} ${doc.number}`, refs: { status: after!.status } });
    return c.json(after);
  }

  r.post("/orders/:id/place", requireRole("admin"), zValidator("param", idParam), async (c) => {
    // A big order may need a second admin before it goes out. Then it waits as a request.
    const orgId = c.get("org")._id;
    const doc = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (doc?.state === "draft") {
      const [order] = await toOrders(store, [doc]);
      if (ruleFor(c.get("org"), "purchase_order", order!.totalCents, c.get("role"))) {
        const open = await store.approvals.findOne({ orgId, kind: "purchase_order", status: "pending", "payload.orderId": doc._id });
        const asker = { ...c.get("user"), role: c.get("role") };
        const approval = open ?? (await createApproval(store, orgId, asker, {
          kind: "purchase_order", valueCents: order!.totalCents, payload: { orderId: doc._id },
          summary: `Place ${doc.number} with ${order!.supplierName}: ${order!.orderedUnits.toLocaleString("en-US")} units, $${(order!.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
          subject: { type: "purchase_order", id: doc._id.toHexString(), label: `${doc.number} (${order!.supplierName})` },
        }));
        return c.json({ approvalRequired: true, approval: toApproval(approval, { id: asker.id, role: asker.role }, await isSoleApprover(store, orgId)) }, 202);
      }
    }
    return transition(c, ["draft"], "ordered", "purchase_order.ordered", "placed");
  });
  r.post("/orders/:id/cancel", requireRole("admin"), zValidator("param", idParam), (c) =>
    transition(c, ["draft", "ordered"], "cancelled", "purchase_order.cancelled", "cancelled", (o) => (o.receivedUnits > 0 ? "Some of it has been received. Close it short instead." : null)));
  r.post("/orders/:id/close", requireRole("admin"), zValidator("param", idParam), (c) =>
    transition(c, ["ordered"], "closed", "purchase_order.closed", "closed", (o) => (o.status === "received" ? "Everything has already arrived" : o.receivedUnits === 0 ? "Nothing has arrived. Cancel it instead." : null)));

  /** Any member can receive: this is what the dock does. Stock goes through the ledger like any other receipt. */
  r.post("/orders/:id/receive", zValidator("param", idParam), zValidator("json", poReceiveInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Order not found" }, 404);
    if (doc.state !== "ordered") return c.json({ error: doc.state === "draft" ? "Place the order before receiving against it" : `A ${doc.state} order can't be received` }, 409);
    const res = await receiveAgainstOrder(store, orgId, c.get("user"), doc, c.req.valid("json"));
    return c.json(res.body as never, res.status as never);
  });

  return r;
}
