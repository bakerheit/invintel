import { zValidator } from "@hono/zod-validator";
import {
  locationInputSchema,
  locationUpdateSchema,
  objectIdSchema,
  type Location,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { isDuplicateKey, type LocationDoc, type Store } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const byName = { locale: "en" } as const;

const toLocation = (doc: LocationDoc, skuCount = 0, unitCount = 0): Location => ({
  id: doc._id.toHexString(),
  name: doc.name,
  description: doc.description,
  skuCount,
  unitCount,
  createdAt: doc.createdAt.toISOString(),
});

export function createLocationRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", async (c) => {
    const orgId = c.get("org")._id;
    const [locations, totals] = await Promise.all([
      store.locations.find({ orgId }).collation(byName).sort({ name: 1 }).toArray(),
      store.stock
        .aggregate<{ _id: ObjectId; skuCount: number; unitCount: number }>([
          { $match: { orgId, quantity: { $gt: 0 } } },
          { $group: { _id: "$locationId", skuCount: { $sum: 1 }, unitCount: { $sum: "$quantity" } } },
        ])
        .toArray(),
    ]);
    const totalsById = new Map(totals.map((t) => [t._id.toHexString(), t]));
    return c.json(
      locations.map((l) => {
        const t = totalsById.get(l._id.toHexString());
        return toLocation(l, t?.skuCount, t?.unitCount);
      }),
    );
  });

  r.post("/", requireRole("admin"), zValidator("json", locationInputSchema), async (c) => {
    const now = new Date();
    const doc: LocationDoc = {
      _id: new ObjectId(),
      orgId: c.get("org")._id,
      ...c.req.valid("json"),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await store.locations.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: `A location named "${doc.name}" already exists` }, 409);
      throw e;
    }
    return c.json(toLocation(doc), 201);
  });

  r.patch(
    "/:id",
    requireRole("admin"),
    zValidator("param", idParam),
    zValidator("json", locationUpdateSchema),
    async (c) => {
      const orgId = c.get("org")._id;
      const _id = new ObjectId(c.req.valid("param").id);
      try {
        const doc = await store.locations.findOneAndUpdate(
          { _id, orgId },
          { $set: { ...c.req.valid("json"), updatedAt: new Date() } },
          { returnDocument: "after" },
        );
        if (!doc) return c.json({ error: "Location not found" }, 404);
        const [t] = await store.stock
          .aggregate<{ skuCount: number; unitCount: number }>([
            { $match: { orgId, locationId: _id, quantity: { $gt: 0 } } },
            { $group: { _id: null, skuCount: { $sum: 1 }, unitCount: { $sum: "$quantity" } } },
          ])
          .toArray();
        return c.json(toLocation(doc, t?.skuCount, t?.unitCount));
      } catch (e) {
        if (isDuplicateKey(e)) return c.json({ error: "A location with that name already exists" }, 409);
        throw e;
      }
    },
  );

  r.delete("/:id", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const _id = new ObjectId(c.req.valid("param").id);
    if (!(await store.locations.findOne({ _id, orgId }, { projection: { _id: 1 } }))) {
      return c.json({ error: "Location not found" }, 404);
    }
    if (await store.stock.findOne({ orgId, locationId: _id, quantity: { $gt: 0 } }, { projection: { _id: 1 } })) {
      return c.json({ error: "Move or remove the stock in this location before deleting it" }, 409);
    }
    await store.locations.deleteOne({ _id, orgId });
    await store.stock.deleteMany({ orgId, locationId: _id });
    return c.body(null, 204);
  });

  return r;
}
