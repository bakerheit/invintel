import { zValidator } from "@hono/zod-validator";
import { objectIdSchema, salesOrderInputSchema, salesOrderUpdateSchema, soConfirmInputSchema, soShipInputSchema, storedToNumber, uomOf, type SalesOrder, type SoShipResult } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, diffFields, recordAudit, summarizeChanges } from "./audit.js";
import { createApproval, isSoleApprover, ruleFor, toApproval } from "./approvals-core.js";
import type { SalesOrderDoc, Store } from "./db.js";
import { loadIncomingOrder, sendShipNotice } from "./exchange.js";
import { actorOf } from "./items.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { cancelOrder, checkOrderInput, closeOrder, confirmOrderDirect, createDraft, pickList, shipOrder, soEntity, toSalesOrders } from "./sales-core.js";

const idParam = z.object({ id: objectIdSchema });
const shipParam = z.object({ id: objectIdSchema, number: z.string().max(40) });
const oid = (s: string) => new ObjectId(s);

/**
 * Sales orders (INV-15): a customer's order, stock reserved when it is confirmed, shipped through the ledger, released on cancel.
 * Admins write and confirm orders (like purchase orders); anyone can pick and ship, which is what the dock does.
 */
export function createSalesRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  const present = async (d: SalesOrderDoc) => (await toSalesOrders(store, [d]))[0] as SalesOrder;
  const actorFor = (c: { get: (k: "user") => { id: string; name: string } }) => ({ id: oid(c.get("user").id), name: c.get("user").name });

  r.get("/orders", async (c) => {
    const orgId = c.get("org")._id;
    const status = c.req.query("status");
    const docs = await store.salesOrders.find({ orgId }).sort({ createdAt: -1 }).limit(300).toArray();
    const all = await toSalesOrders(store, docs);
    return c.json(status ? all.filter((o) => o.status === status) : all);
  });

  r.get("/orders/:id", zValidator("param", idParam), async (c) => {
    const doc = await store.salesOrders.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id });
    return doc ? c.json(await present(doc)) : c.json({ error: "Order not found" }, 404);
  });

  r.post("/orders", requireRole("admin"), zValidator("json", salesOrderInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const problem = await checkOrderInput(store, orgId, input);
    if (problem) return c.json({ error: problem }, 400);
    const made = await createDraft(store, orgId, auditActor(c.get("user")), input);
    if (!made.ok) return c.json({ error: made.error }, made.status);
    return c.json(await present(made.order), 201);
  });

  r.patch("/orders/:id", requireRole("admin"), zValidator("param", idParam), zValidator("json", salesOrderUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const _id = oid(c.req.valid("param").id);
    const patch = c.req.valid("json");
    const problem = await checkOrderInput(store, orgId, patch);
    if (problem) return c.json({ error: problem }, 400);
    const before = await store.salesOrders.findOne({ _id, orgId });
    if (!before) return c.json({ error: "Order not found" }, 404);
    if (before.state !== "draft") return c.json({ error: "Only a draft can be edited. Cancel this order and make a new one, or close it." }, 409);
    const partner = patch.customerPartnerId ? await store.tradingPartners.findOne({ _id: oid(patch.customerPartnerId), orgId }, { projection: { name: 1 } }) : null;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.customerPartnerId !== undefined) { set.customerPartnerId = partner?._id ?? null; if (partner) set.customerName = partner.name; }
    if (patch.customerName !== undefined && !partner) set.customerName = patch.customerName;
    for (const k of ["customerRef", "requestedDate", "note"] as const) if (patch[k] !== undefined) set[k] = patch[k];
    if (patch.lines) set.lines = patch.lines.map((l) => ({ itemId: oid(l.itemId), quantity: l.quantity, unitPriceCents: l.unitPriceCents }));
    const after = await store.salesOrders.findOneAndUpdate({ _id, orgId, state: "draft" }, { $set: set }, { returnDocument: "after" });
    if (!after) return c.json({ error: "That order was just confirmed or changed. Reload it." }, 409);
    if (!after.customerPartnerId && !after.customerName) {
      await store.salesOrders.updateOne({ _id }, { $set: { customerName: before.customerName, customerPartnerId: before.customerPartnerId } });
      return c.json({ error: "Say who the customer is" }, 400);
    }
    const changes = diffFields({ customerName: before.customerName, customerRef: before.customerRef, requestedDate: before.requestedDate, note: before.note }, { customerName: after.customerName, customerRef: after.customerRef, requestedDate: after.requestedDate, note: after.note });
    if (patch.lines) changes.push({ field: "lines", from: before.lines.length, to: after.lines.length });
    if (changes.length) await recordAudit(store, { orgId, actor: auditActor(c.get("user")), action: "sales_order.updated", entity: soEntity(after), summary: summarizeChanges(changes), changes });
    return c.json(await present(after));
  });

  /** Reserves the stock. A big order may need a second admin first (INV-7), then it waits as a request. */
  r.post("/orders/:id/confirm", requireRole("admin"), zValidator("param", idParam), zValidator("json", soConfirmInputSchema), async (c) => {
    const org = c.get("org");
    const orgId = org._id;
    const doc = await store.salesOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Order not found" }, 404);
    const { allowShortage } = c.req.valid("json");
    if (doc.state === "draft") {
      const view = await present(doc);
      if (ruleFor(org, "sales_order", view.totalCents, c.get("role"))) {
        const open = await store.approvals.findOne({ orgId, kind: "sales_order", status: "pending", "payload.orderId": doc._id });
        const asker = { ...c.get("user"), role: c.get("role") };
        const approval = open ?? (await createApproval(store, orgId, asker, {
          kind: "sales_order", valueCents: view.totalCents, payload: { orderId: doc._id, allowShortage },
          summary: `Confirm ${doc.number} for ${view.customer.name}: ${view.lines.length} line${view.lines.length === 1 ? "" : "s"}, $${(view.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
          subject: { type: "sales_order", id: doc._id.toHexString(), label: `${doc.number} (${view.customer.name})` },
        }));
        return c.json({ approvalRequired: true, approval: toApproval(approval, { id: asker.id, role: asker.role }, await isSoleApprover(store, orgId)) }, 202);
      }
    }
    const res = await confirmOrderDirect(store, orgId, actorFor(c), doc._id, { allowShortage });
    if (!res.ok) return c.json({ error: res.error, ...(res.shortages ? { shortages: res.shortages } : {}) }, res.status);
    return c.json(await present(res.order));
  });

  r.post("/orders/:id/cancel", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const res = await cancelOrder(store, c.get("org")._id, actorFor(c), oid(c.req.valid("param").id));
    return res.ok ? c.json(await present(res.order)) : c.json({ error: res.error }, res.status);
  });

  r.post("/orders/:id/close", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const res = await closeOrder(store, c.get("org")._id, actorFor(c), oid(c.req.valid("param").id));
    return res.ok ? c.json(await present(res.order)) : c.json({ error: res.error }, res.status);
  });

  /** What could fill what is left: places with stock and labelled units, nothing on hold. */
  r.get("/orders/:id/pick", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.salesOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Order not found" }, 404);
    return c.json(await pickList(store, orgId, doc));
  });

  /** Ships through the ledger, then tells the customer if the order came from the Exchange. Any member can ship. */
  r.post("/orders/:id/ship", zValidator("param", idParam), zValidator("json", soShipInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const res = await shipOrder(store, orgId, actorOf(c.get("user")), oid(c.req.valid("param").id), input);
    if (!res.ok) return c.json({ error: res.error, ...(res.partial ? { partial: true } : {}) }, res.status);
    const notice = await noticeFor(res.order, res.shipmentNumber, input.shippedDate, input.carrier, input.trackingNumber, res.lines, actorOf(c.get("user")));
    const body: SoShipResult = { order: await present(notice.order), shipmentNumber: res.shipmentNumber, movementIds: res.movementIds.map(String), notice: notice.state, ...(notice.error ? { noticeError: notice.error } : {}) };
    return c.json(body, 201);
  });

  /** Sends the ship notice again if it failed. */
  r.post("/orders/:id/shipments/:number/notice", requireRole("admin"), zValidator("param", shipParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.salesOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    const s = doc?.shipments.find((x) => x.number === c.req.valid("param").number);
    if (!doc || !s) return c.json({ error: "Shipment not found" }, 404);
    if (!doc.messageId) return c.json({ error: "This order didn't come from the Exchange, so there is no one to tell" }, 409);
    const notice = await noticeFor(doc, s.number, s.at.toISOString().slice(0, 10), s.carrier, s.trackingNumber, s.lines, actorOf(c.get("user")));
    return notice.state === "sent" ? c.json(await present(notice.order)) : c.json({ error: notice.error ?? "Could not send the notice" }, 409);
  });

  /** The ship notice for one shipment of an order that came in over the Exchange. The shipment stands even if the notice can't be sent. */
  async function noticeFor(doc: SalesOrderDoc, number: string, shippedDate: string | undefined, carrier: string | undefined, tracking: string | undefined, lines: { itemId: ObjectId; quantity: number }[], actor: { userId: ObjectId; userName: string }) {
    if (!doc.messageId) return { order: (await store.salesOrders.findOne({ _id: doc._id }))!, state: null as "sent" | "failed" | null, error: undefined as string | undefined };
    const orgId = doc.orgId;
    let state: "sent" | "failed" = "failed";
    let error: string | undefined;
    try {
      const got = await loadIncomingOrder(store, orgId, doc.messageId.toHexString());
      const items = await store.items.find({ _id: { $in: lines.map((l) => l.itemId) } }, { projection: { sku: 1, unit: 1, decimals: 1 } }).toArray();
      if (!got) error = "The customer's order message is gone";
      else {
        const res = await sendShipNotice(store, orgId, actor, got, {
          shipmentNumber: number, shippedDate, carrier, tracking, key: `ship-${doc.messageId.toHexString()}-${number}`,
          lines: lines.map((l) => { const i = items.find((x) => x._id.equals(l.itemId)); return { sku: i?.sku ?? "", quantity: storedToNumber(l.quantity, uomOf(i).decimals) }; }),
        });
        if (res.ok && res.message.state !== "failed") state = "sent";
        else error = res.ok ? (res.message.attempts.filter((a) => !a.ok).pop()?.error ?? "The notice could not be delivered") : res.error;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "The notice could not be sent";
    }
    const order = (await store.salesOrders.findOneAndUpdate({ _id: doc._id, "shipments.number": number }, { $set: { "shipments.$.notice": state } }, { returnDocument: "after" })) ?? doc;
    return { order, state, error };
  }

  return r;
}
