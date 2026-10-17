import { zValidator } from "@hono/zod-validator";
import {
  adjustmentInputSchema,
  itemInputSchema,
  itemUpdateSchema,
  type Item,
  type StockMovement,
} from "@invintel/shared";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { createAuth, type AuthEnv, type AuthOptions } from "./auth.js";
import { isDuplicateKey, type ItemDoc, type MovementDoc, type Store } from "./db.js";

const idParam = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id") });

const toItem = ({ _id, createdAt, updatedAt, ...rest }: ItemDoc): Item => ({
  id: _id.toHexString(),
  ...rest,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

const toMovement = (m: MovementDoc): StockMovement => ({
  id: m._id.toHexString(),
  itemId: m.itemId.toHexString(),
  delta: m.delta,
  reason: m.reason,
  createdAt: m.createdAt.toISOString(),
});

export function createApp(store: Store, authOptions: AuthOptions) {
  const app = new Hono();
  const auth = createAuth(store, authOptions);

  app.use("*", logger());
  // No CORS: the web app talks to the API same-origin (Vite proxies /api in dev).

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", auth.routes);

  const api = new Hono<AuthEnv>();
  api.use("*", auth.requireAuth);

  api.get("/items", async (c) => {
    const docs = await store.items.find().sort({ name: 1 }).toArray();
    return c.json(docs.map(toItem));
  });

  api.get("/items/:id", zValidator("param", idParam), async (c) => {
    const doc = await store.items.findOne({ _id: new ObjectId(c.req.valid("param").id) });
    return doc ? c.json(toItem(doc)) : c.json({ error: "Item not found" }, 404);
  });

  api.post("/items", zValidator("json", itemInputSchema), async (c) => {
    const input = c.req.valid("json");
    const now = new Date();
    const doc: ItemDoc = { _id: new ObjectId(), ...input, createdAt: now, updatedAt: now };
    try {
      await store.items.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: `SKU "${input.sku}" already exists` }, 409);
      throw e;
    }
    if (doc.quantity !== 0) {
      await store.movements.insertOne({
        _id: new ObjectId(),
        itemId: doc._id,
        delta: doc.quantity,
        reason: "Initial stock",
        createdAt: now,
      });
    }
    return c.json(toItem(doc), 201);
  });

  api.patch(
    "/items/:id",
    zValidator("param", idParam),
    zValidator("json", itemUpdateSchema),
    async (c) => {
      // Quantity only changes through stock adjustments so history stays accurate.
      const { quantity: _ignored, ...patch } = c.req.valid("json");
      try {
        const updated = await store.items.findOneAndUpdate(
          { _id: new ObjectId(c.req.valid("param").id) },
          { $set: { ...patch, updatedAt: new Date() } },
          { returnDocument: "after" },
        );
        return updated ? c.json(toItem(updated)) : c.json({ error: "Item not found" }, 404);
      } catch (e) {
        if (isDuplicateKey(e)) return c.json({ error: "SKU already exists" }, 409);
        throw e;
      }
    },
  );

  api.delete("/items/:id", zValidator("param", idParam), async (c) => {
    const _id = new ObjectId(c.req.valid("param").id);
    const { deletedCount } = await store.items.deleteOne({ _id });
    if (!deletedCount) return c.json({ error: "Item not found" }, 404);
    await store.movements.deleteMany({ itemId: _id });
    return c.body(null, 204);
  });

  api.get("/items/:id/movements", zValidator("param", idParam), async (c) => {
    const docs = await store.movements
      .find({ itemId: new ObjectId(c.req.valid("param").id) })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    return c.json(docs.map(toMovement));
  });

  api.post(
    "/items/:id/adjust",
    zValidator("param", idParam),
    zValidator("json", adjustmentInputSchema),
    async (c) => {
      const _id = new ObjectId(c.req.valid("param").id);
      const { delta, reason } = c.req.valid("json");
      // The quantity guard lives in the filter so concurrent removals can't oversell.
      const updated = await store.items.findOneAndUpdate(
        delta < 0 ? { _id, quantity: { $gte: -delta } } : { _id },
        { $inc: { quantity: delta }, $set: { updatedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (!updated) {
        const existing = await store.items.findOne({ _id }, { projection: { quantity: 1 } });
        return existing
          ? c.json({ error: `Only ${existing.quantity} in stock` }, 422)
          : c.json({ error: "Item not found" }, 404);
      }
      await store.movements.insertOne({
        _id: new ObjectId(),
        itemId: _id,
        delta,
        reason,
        createdAt: new Date(),
      });
      return c.json(toItem(updated));
    },
  );

  app.route("/api", api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
