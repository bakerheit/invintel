import { zValidator } from "@hono/zod-validator";
import {
  adjustmentInputSchema,
  itemCreateSchema,
  itemUpdateSchema,
  objectIdSchema,
  transferInputSchema,
  type StockMovement,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { duplicateField, isDuplicateKey, movementType, type ItemDoc, type MovementDoc, type Store } from "./db.js";
import { conflictMessage, findCodeConflict } from "./item-codes.js";
import { loadItem, loadItems, toItem } from "./item-queries.js";
import type { OrgEnv } from "./org-access.js";
import { postAdjustment, postMove, type Actor } from "./stock-service.js";

const idParam = z.object({ id: objectIdSchema });

const toMovement = (m: MovementDoc): StockMovement => ({
  id: m._id.toHexString(),
  type: movementType(m),
  itemId: m.itemId.toHexString(),
  locationId: m.locationId.toHexString(),
  delta: m.delta,
  reason: m.reason,
  userName: m.userName,
  ...(m.transferId ? { transferId: m.transferId.toHexString() } : {}),
  createdAt: m.createdAt.toISOString(),
});

export const actorOf = (user: { id: string; name: string }): Actor => ({
  userId: new ObjectId(user.id),
  userName: user.name,
});

export function createItemRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", async (c) => c.json((await loadItems(store, c.get("org")._id)).map(toItem)));

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const item = await loadItem(store, c.get("org")._id, new ObjectId(c.req.valid("param").id));
    return item ? c.json(toItem(item)) : c.json({ error: "Item not found" }, 404);
  });

  r.post("/", zValidator("json", itemCreateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { initialStock, ...input } = c.req.valid("json");
    const locationId = initialStock && new ObjectId(initialStock.locationId);
    if (
      locationId &&
      !(await store.locations.findOne({ _id: locationId, orgId }, { projection: { _id: 1 } }))
    ) {
      return c.json({ error: "Location not found" }, 400);
    }
    const barcodeClash = await findCodeConflict(store, orgId, input.barcodes, { against: ["sku", "barcodes"] });
    if (barcodeClash) return c.json({ error: conflictMessage(barcodeClash, "Barcode") }, 409);
    const skuClash = await findCodeConflict(store, orgId, [input.sku], { against: ["barcodes"] });
    if (skuClash) return c.json({ error: conflictMessage(skuClash, "SKU") }, 409);

    const now = new Date();
    const doc: ItemDoc = { _id: new ObjectId(), orgId, ...input, createdAt: now, updatedAt: now };
    try {
      await store.items.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) {
        return c.json({ error: duplicateField(e) === "barcodes" ? "One of those barcodes is already in use" : `SKU "${input.sku}" already exists` }, 409);
      }
      throw e;
    }
    if (initialStock && locationId) {
      await postAdjustment(store, orgId, actorOf(c.get("user")), {
        itemId: doc._id,
        locationId,
        delta: initialStock.quantity,
        reason: "Initial stock",
        type: "receive",
      });
    }
    return c.json(toItem((await loadItem(store, orgId, doc._id))!), 201);
  });

  r.patch("/:id", zValidator("param", idParam), zValidator("json", itemUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const _id = new ObjectId(c.req.valid("param").id);
    const patch = c.req.valid("json");
    if (patch.barcodes) {
      const clash = await findCodeConflict(store, orgId, patch.barcodes, { selfId: _id, against: ["sku", "barcodes"] });
      if (clash) return c.json({ error: conflictMessage(clash, "Barcode") }, 409);
    }
    if (patch.sku) {
      const clash = await findCodeConflict(store, orgId, [patch.sku], { selfId: _id, against: ["barcodes"] });
      if (clash) return c.json({ error: conflictMessage(clash, "SKU") }, 409);
    }
    try {
      const updated = await store.items.findOneAndUpdate({ _id, orgId }, { $set: { ...patch, updatedAt: new Date() } });
      if (!updated) return c.json({ error: "Item not found" }, 404);
    } catch (e) {
      if (isDuplicateKey(e)) {
        return c.json({ error: duplicateField(e) === "barcodes" ? "One of those barcodes is already in use" : "SKU already exists" }, 409);
      }
      throw e;
    }
    return c.json(toItem((await loadItem(store, orgId, _id))!));
  });

  r.delete("/:id", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const _id = new ObjectId(c.req.valid("param").id);
    const { deletedCount } = await store.items.deleteOne({ _id, orgId });
    if (!deletedCount) return c.json({ error: "Item not found" }, 404);
    await Promise.all([store.stock.deleteMany({ itemId: _id }), store.movements.deleteMany({ itemId: _id })]);
    return c.body(null, 204);
  });

  r.get("/:id/movements", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const itemId = new ObjectId(c.req.valid("param").id);
    const docs = await store.movements.find({ orgId, itemId }).sort({ createdAt: -1, _id: -1 }).toArray();
    return c.json(docs.map(toMovement));
  });

  r.post("/:id/adjust", zValidator("param", idParam), zValidator("json", adjustmentInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const itemId = new ObjectId(c.req.valid("param").id);
    const { locationId, delta, reason } = c.req.valid("json");
    const result = await postAdjustment(store, orgId, actorOf(c.get("user")), {
      itemId,
      locationId: new ObjectId(locationId),
      delta,
      reason,
      type: "adjust",
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(toItem((await loadItem(store, orgId, itemId))!));
  });

  r.post("/:id/transfer", zValidator("param", idParam), zValidator("json", transferInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const itemId = new ObjectId(c.req.valid("param").id);
    const input = c.req.valid("json");
    const result = await postMove(store, orgId, actorOf(c.get("user")), {
      itemId,
      fromLocationId: new ObjectId(input.fromLocationId),
      toLocationId: new ObjectId(input.toLocationId),
      quantity: input.quantity,
      reason: input.reason,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(toItem((await loadItem(store, orgId, itemId))!));
  });

  return r;
}
