import { zValidator } from "@hono/zod-validator";
import {
  adjustmentInputSchema,
  itemCreateSchema,
  itemUpdateSchema,
  objectIdSchema,
  transferInputSchema,
  type Item,
  type StockMovement,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
  isDuplicateKey,
  type ItemDoc,
  type MovementDoc,
  type Store,
  type StockDoc,
} from "./db.js";
import type { OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const byName = { locale: "en" } as const;

type ItemWithStock = ItemDoc & { stock: StockDoc[] };

const toItem = ({ _id, orgId: _orgId, stock, createdAt, updatedAt, ...rest }: ItemWithStock): Item => ({
  id: _id.toHexString(),
  ...rest,
  quantity: stock.reduce((sum, s) => sum + s.quantity, 0),
  stock: stock.map((s) => ({ locationId: s.locationId.toHexString(), quantity: s.quantity })),
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

const toMovement = (m: MovementDoc): StockMovement => ({
  id: m._id.toHexString(),
  itemId: m.itemId.toHexString(),
  locationId: m.locationId.toHexString(),
  delta: m.delta,
  reason: m.reason,
  userName: m.userName,
  ...(m.transferId ? { transferId: m.transferId.toHexString() } : {}),
  createdAt: m.createdAt.toISOString(),
});

export function createItemRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const loadItems = (orgId: ObjectId, itemId?: ObjectId) =>
    store.items
      .aggregate<ItemWithStock>(
        [
          { $match: itemId ? { orgId, _id: itemId } : { orgId } },
          { $sort: { name: 1 } },
          {
            $lookup: {
              from: "stock",
              localField: "_id",
              foreignField: "itemId",
              pipeline: [{ $match: { quantity: { $gt: 0 } } }],
              as: "stock",
            },
          },
        ],
        { collation: byName },
      )
      .toArray();

  const loadItem = async (orgId: ObjectId, itemId: ObjectId) => (await loadItems(orgId, itemId))[0];

  const hasLocation = async (orgId: ObjectId, locationId: ObjectId) =>
    !!(await store.locations.findOne({ _id: locationId, orgId }, { projection: { _id: 1 } }));

  /**
   * Moves a stock row by `delta`. Removals are guarded in the filter so concurrent requests can't
   * take more than is there. Returns the new quantity, or null if there wasn't enough.
   */
  async function changeStock(orgId: ObjectId, itemId: ObjectId, locationId: ObjectId, delta: number) {
    const update = { $inc: { quantity: delta }, $set: { updatedAt: new Date() } };
    if (delta < 0) {
      const row = await store.stock.findOneAndUpdate(
        { orgId, itemId, locationId, quantity: { $gte: -delta } },
        update,
        { returnDocument: "after" },
      );
      return row ? row.quantity : null;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const row = await store.stock.findOneAndUpdate({ orgId, itemId, locationId }, update, {
          upsert: true,
          returnDocument: "after",
        });
        return row!.quantity;
      } catch (e) {
        // Two first-time adds racing to create the same row: the loser retries as a plain update.
        if (!isDuplicateKey(e) || attempt >= 2) throw e;
      }
    }
  }

  const logMovement = (
    orgId: ObjectId,
    itemId: ObjectId,
    locationId: ObjectId,
    delta: number,
    reason: string,
    userName: string,
    transferId?: ObjectId,
  ) =>
    store.movements.insertOne({
      _id: new ObjectId(),
      orgId,
      itemId,
      locationId,
      delta,
      reason,
      userName,
      ...(transferId ? { transferId } : {}),
      createdAt: new Date(),
    });

  r.get("/", async (c) => c.json((await loadItems(c.get("org")._id)).map(toItem)));

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const item = await loadItem(c.get("org")._id, new ObjectId(c.req.valid("param").id));
    return item ? c.json(toItem(item)) : c.json({ error: "Item not found" }, 404);
  });

  r.post("/", zValidator("json", itemCreateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { initialStock, ...input } = c.req.valid("json");
    const locationId = initialStock && new ObjectId(initialStock.locationId);
    if (locationId && !(await hasLocation(orgId, locationId))) {
      return c.json({ error: "Location not found" }, 400);
    }
    const now = new Date();
    const doc: ItemDoc = { _id: new ObjectId(), orgId, ...input, createdAt: now, updatedAt: now };
    try {
      await store.items.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: `SKU "${input.sku}" already exists` }, 409);
      throw e;
    }
    if (initialStock && locationId) {
      await changeStock(orgId, doc._id, locationId, initialStock.quantity);
      await logMovement(orgId, doc._id, locationId, initialStock.quantity, "Initial stock", c.get("user").name);
    }
    return c.json(toItem((await loadItem(orgId, doc._id))!), 201);
  });

  r.patch("/:id", zValidator("param", idParam), zValidator("json", itemUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const _id = new ObjectId(c.req.valid("param").id);
    try {
      const updated = await store.items.findOneAndUpdate(
        { _id, orgId },
        { $set: { ...c.req.valid("json"), updatedAt: new Date() } },
      );
      if (!updated) return c.json({ error: "Item not found" }, 404);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: "SKU already exists" }, 409);
      throw e;
    }
    return c.json(toItem((await loadItem(orgId, _id))!));
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

  r.post(
    "/:id/adjust",
    zValidator("param", idParam),
    zValidator("json", adjustmentInputSchema),
    async (c) => {
      const orgId = c.get("org")._id;
      const itemId = new ObjectId(c.req.valid("param").id);
      const { locationId: rawLocation, delta, reason } = c.req.valid("json");
      const locationId = new ObjectId(rawLocation);

      if (!(await store.items.findOne({ _id: itemId, orgId }, { projection: { _id: 1 } }))) {
        return c.json({ error: "Item not found" }, 404);
      }
      const location = await store.locations.findOne({ _id: locationId, orgId });
      if (!location) return c.json({ error: "Location not found" }, 404);

      if ((await changeStock(orgId, itemId, locationId, delta)) === null) {
        const row = await store.stock.findOne({ orgId, itemId, locationId });
        return c.json({ error: `Only ${row?.quantity ?? 0} in stock at ${location.name}` }, 422);
      }
      await logMovement(orgId, itemId, locationId, delta, reason, c.get("user").name);
      return c.json(toItem((await loadItem(orgId, itemId))!));
    },
  );

  r.post(
    "/:id/transfer",
    zValidator("param", idParam),
    zValidator("json", transferInputSchema),
    async (c) => {
      const orgId = c.get("org")._id;
      const itemId = new ObjectId(c.req.valid("param").id);
      const input = c.req.valid("json");
      const from = new ObjectId(input.fromLocationId);
      const to = new ObjectId(input.toLocationId);

      if (!(await store.items.findOne({ _id: itemId, orgId }, { projection: { _id: 1 } }))) {
        return c.json({ error: "Item not found" }, 404);
      }
      const [fromLoc, toLoc] = await Promise.all([
        store.locations.findOne({ _id: from, orgId }),
        store.locations.findOne({ _id: to, orgId }),
      ]);
      if (!fromLoc || !toLoc) return c.json({ error: "Location not found" }, 404);

      if ((await changeStock(orgId, itemId, from, -input.quantity)) === null) {
        const row = await store.stock.findOne({ orgId, itemId, locationId: from });
        return c.json({ error: `Only ${row?.quantity ?? 0} in stock at ${fromLoc.name}` }, 422);
      }
      try {
        await changeStock(orgId, itemId, to, input.quantity);
      } catch (e) {
        await changeStock(orgId, itemId, from, input.quantity); // put it back
        throw e;
      }
      const transferId = new ObjectId();
      const reason = input.reason || `Transfer ${fromLoc.name} → ${toLoc.name}`;
      const who = c.get("user").name;
      await logMovement(orgId, itemId, from, -input.quantity, reason, who, transferId);
      await logMovement(orgId, itemId, to, input.quantity, reason, who, transferId);
      return c.json(toItem((await loadItem(orgId, itemId))!));
    },
  );

  return r;
}
