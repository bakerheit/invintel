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
import { duplicateField, isDuplicateKey, type LocationDoc, type Store } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const byName = { locale: "en" } as const;

/** Deep enough for site > area > aisle > rack > shelf > bin. */
const MAX_DEPTH = 6;

const parentOf = (l: LocationDoc) => l.parentId?.toHexString() ?? null;

/** Everything keyed by hex id for quick walks up and down the tree. */
export function indexLocations(docs: LocationDoc[]) {
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  const children = new Map<string, string[]>();
  for (const d of docs) {
    const p = parentOf(d);
    if (p) children.set(p, [...(children.get(p) ?? []), d._id.toHexString()]);
  }
  const pathOf = (id: string): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let cur: string | null = id; cur && !seen.has(cur); ) {
      seen.add(cur);
      const d = byId.get(cur);
      if (!d) break;
      names.unshift(d.name);
      cur = parentOf(d);
    }
    return names.join(" / ");
  };
  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      out.push(next);
      stack.push(...(children.get(next) ?? []));
    }
    return out;
  };
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let cur = byId.get(id); cur && parentOf(cur); cur = byId.get(parentOf(cur)!)) depth++;
    return depth + 1;
  };
  const heightOf = (id: string): number =>
    1 + Math.max(0, ...(children.get(id) ?? []).map((c) => heightOf(c)));
  return { byId, children, pathOf, descendants, depthOf, heightOf };
}

export const toLocation = (
  doc: LocationDoc,
  path: string,
  skuCount = 0,
  unitCount = 0,
): Location => ({
  id: doc._id.toHexString(),
  name: doc.name,
  description: doc.description,
  type: doc.type ?? "storage",
  parentId: parentOf(doc),
  code: doc.code ?? "",
  path,
  skuCount,
  unitCount,
  createdAt: doc.createdAt.toISOString(),
});

export const loadLocations = (store: Store, orgId: ObjectId) =>
  store.locations.find({ orgId }).collation(byName).toArray();

async function ownTotals(store: Store, orgId: ObjectId, locationId?: ObjectId) {
  const rows = await store.stock
    .aggregate<{ _id: ObjectId; skuCount: number; unitCount: number }>([
      { $match: { orgId, quantity: { $gt: 0 }, ...(locationId ? { locationId } : {}) } },
      { $group: { _id: "$locationId", skuCount: { $sum: 1 }, unitCount: { $sum: "$quantity" } } },
    ])
    .toArray();
  return new Map(rows.map((t) => [t._id.toHexString(), t]));
}

const duplicateMessage = (e: unknown) =>
  duplicateField(e) === "code"
    ? "Another location already uses that code"
    : "A location with that name already exists here";

export function createLocationRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", async (c) => {
    const orgId = c.get("org")._id;
    const [docs, totals] = await Promise.all([loadLocations(store, orgId), ownTotals(store, orgId)]);
    const { pathOf } = indexLocations(docs);
    const id = (d: LocationDoc) => d._id.toHexString();
    return c.json(
      docs
        .map((d) => toLocation(d, pathOf(id(d)), totals.get(id(d))?.skuCount, totals.get(id(d))?.unitCount))
        .sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  r.post("/", requireRole("admin"), zValidator("json", locationInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const parentId = input.parentId ? new ObjectId(input.parentId) : null;

    const docs = await loadLocations(store, orgId);
    const index = indexLocations(docs);
    if (input.parentId) {
      if (!index.byId.has(input.parentId)) return c.json({ error: "Parent location not found" }, 400);
      if (index.depthOf(input.parentId) >= MAX_DEPTH) {
        return c.json({ error: `Locations can only be nested ${MAX_DEPTH} levels deep` }, 400);
      }
    }
    const now = new Date();
    const doc: LocationDoc = {
      _id: new ObjectId(),
      orgId,
      name: input.name,
      description: input.description,
      type: input.type,
      parentId,
      code: input.code,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await store.locations.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: duplicateMessage(e) }, 409);
      throw e;
    }
    const withNew = indexLocations([...docs, doc]);
    return c.json(toLocation(doc, withNew.pathOf(doc._id.toHexString())), 201);
  });

  r.patch(
    "/:id",
    requireRole("admin"),
    zValidator("param", idParam),
    zValidator("json", locationUpdateSchema),
    async (c) => {
      const orgId = c.get("org")._id;
      const id = c.req.valid("param").id;
      const patch = c.req.valid("json");

      const docs = await loadLocations(store, orgId);
      const index = indexLocations(docs);
      if (!index.byId.has(id)) return c.json({ error: "Location not found" }, 404);

      const set: Partial<LocationDoc> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.type !== undefined) set.type = patch.type;
      if (patch.code !== undefined) set.code = patch.code;
      if (patch.parentId !== undefined) {
        if (patch.parentId) {
          if (!index.byId.has(patch.parentId)) return c.json({ error: "Parent location not found" }, 400);
          if (patch.parentId === id || index.descendants(id).includes(patch.parentId)) {
            return c.json({ error: "A location can't be moved inside itself" }, 400);
          }
          if (index.depthOf(patch.parentId) + index.heightOf(id) > MAX_DEPTH) {
            return c.json({ error: `Locations can only be nested ${MAX_DEPTH} levels deep` }, 400);
          }
        }
        set.parentId = patch.parentId ? new ObjectId(patch.parentId) : null;
      }

      try {
        const doc = await store.locations.findOneAndUpdate(
          { _id: new ObjectId(id), orgId },
          { $set: { ...set, updatedAt: new Date() } },
          { returnDocument: "after" },
        );
        if (!doc) return c.json({ error: "Location not found" }, 404);
        const fresh = indexLocations(docs.map((d) => (d._id.equals(doc._id) ? doc : d)));
        const totals = await ownTotals(store, orgId, doc._id);
        const t = totals.get(id);
        return c.json(toLocation(doc, fresh.pathOf(id), t?.skuCount, t?.unitCount));
      } catch (e) {
        if (isDuplicateKey(e)) return c.json({ error: duplicateMessage(e) }, 409);
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
    if (await store.locations.findOne({ orgId, parentId: _id }, { projection: { _id: 1 } })) {
      return c.json({ error: "Move or delete the locations inside this one first" }, 409);
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
