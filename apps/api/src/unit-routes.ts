import { zValidator } from "@hono/zod-validator";
import {
  adjustUnitInputSchema,
  moveUnitInputSchema,
  objectIdSchema,
  receiveUnitsInputSchema,
  unitStatusSchema,
  type UnitsPage,
  type UnitsPosted,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import type { StockUnitDoc, Store } from "./db.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import type { OrgEnv } from "./org-access.js";
import { INSPECT_REASON, openHold } from "./quality.js";
import { adjustUnit, moveUnit, presentUnits, receiveUnits, type UnitsResult } from "./units.js";

const idParam = z.object({ id: objectIdSchema });
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listQuery = z.object({
  itemId: objectIdSchema.optional(),
  locationId: objectIdSchema.optional(),
  status: unitStatusSchema.optional(),
  /** Matches the label code or the lot number. */
  q: z.string().trim().max(64).optional(),
  /** Several ids at once, comma separated. Used to print a chosen set of labels. */
  ids: z.string().max(4000).optional(),
  before: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Rolls and pallets: individually labelled stock with its own remaining quantity. */
export function createUnitRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const respond = async (orgId: ObjectId, result: UnitsResult): Promise<{ body: UnitsPosted } | { error: string; status: 404 | 409 | 422 }> => {
    if (!result.ok) return { error: result.error, status: result.status };
    return { body: { units: await presentUnits(store, orgId, result.units), movementIds: result.movementIds.map((m) => m.toHexString()) } };
  };

  r.get("/", zValidator("query", listQuery), async (c) => {
    const orgId = c.get("org")._id;
    const { itemId, locationId, status, q, ids, before, limit } = c.req.valid("query");
    const filter: Filter<StockUnitDoc> = { orgId };
    if (itemId) filter.itemId = new ObjectId(itemId);
    if (status) filter.status = status;
    if (before) filter._id = { $lt: new ObjectId(before) };
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ code: rx }, { lot: rx }];
    }
    if (ids) {
      const wanted = ids.split(",").filter((i) => /^[0-9a-f]{24}$/i.test(i)).map((i) => new ObjectId(i));
      filter._id = filter._id ? { ...(filter._id as object), $in: wanted } : { $in: wanted };
    }
    if (locationId) {
      // A parent location includes everything inside it.
      const index = indexLocations(await loadLocations(store, orgId));
      filter.locationId = { $in: [locationId, ...index.descendants(locationId)].map((id) => new ObjectId(id)) };
    }
    const docs = await store.units.find(filter).sort({ _id: -1 }).limit(limit + 1).toArray();
    const page: UnitsPage = {
      units: await presentUnits(store, orgId, docs.slice(0, limit)),
      ...(docs.length > limit ? { nextBefore: docs[limit - 1]!._id.toHexString() } : {}),
    };
    return c.json(page);
  });

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.units.findOne({ _id: new ObjectId(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Unit not found" }, 404);
    return c.json((await presentUnits(store, orgId, [doc]))[0]);
  });

  r.post("/", zValidator("json", receiveUnitsInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const out = await respond(
      orgId,
      await receiveUnits(store, orgId, actorOf(c.get("user")), {
        ...input,
        itemId: new ObjectId(input.itemId),
        locationId: new ObjectId(input.locationId),
      }),
    );
    if ("error" in out) return c.json({ error: out.error }, out.status);
    if (input.inspect) {
      const ncrs: { id: string; number: string }[] = [];
      for (const u of out.body.units) {
        const hold = await openHold(store, orgId, actorOf(c.get("user")), { reason: INSPECT_REASON, note: input.reference, source: "receiving", unitId: u.id });
        if (!hold.ok) return c.json({ error: `Received, but ${u.code} could not be put on hold: ${hold.error}` }, hold.status);
        ncrs.push({ id: hold.ncr._id.toHexString(), number: hold.ncr.number });
      }
      // The unit documents above were read before the hold; show them as held.
      const held = await presentUnits(store, orgId, await store.units.find({ _id: { $in: out.body.units.map((u) => new ObjectId(u.id)) } }).toArray());
      return c.json({ ...out.body, units: held, ncrs }, 201);
    }
    return c.json(out.body, 201);
  });

  r.post("/:id/move", zValidator("param", idParam), zValidator("json", moveUnitInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { toLocationId, reason } = c.req.valid("json");
    const out = await respond(
      orgId,
      await moveUnit(store, orgId, actorOf(c.get("user")), new ObjectId(c.req.valid("param").id), new ObjectId(toLocationId), reason),
    );
    return "error" in out ? c.json({ error: out.error }, out.status) : c.json(out.body);
  });

  r.post("/:id/adjust", zValidator("param", idParam), zValidator("json", adjustUnitInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { delta, reason } = c.req.valid("json");
    const out = await respond(
      orgId,
      await adjustUnit(store, orgId, actorOf(c.get("user")), new ObjectId(c.req.valid("param").id), delta, reason),
    );
    return "error" in out ? c.json({ error: out.error }, out.status) : c.json(out.body);
  });

  return r;
}
