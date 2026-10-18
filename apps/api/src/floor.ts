import { zValidator } from "@hono/zod-validator";
import {
  gtinVariants,
  moveInputSchema,
  receiveInputSchema,
  type LookupResult,
  type PostedDocument,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Store } from "./db.js";
import { loadItem, toItem } from "./item-queries.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations, toLocation } from "./locations.js";
import type { OrgEnv } from "./org-access.js";
import { postAdjustment, postMove } from "./stock-service.js";

const ci = { locale: "en", strength: 2 } as const;
const isObjectId = (s: string) => /^[0-9a-f]{24}$/i.test(s);

const lookupQuery = z.object({ code: z.string().trim().max(200).default("") });

/** Endpoints for plant-floor flows: scan a code, post a document, get ids back for undo. */
export function createFloorRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const posted = async (orgId: ObjectId, itemId: ObjectId, movementIds: ObjectId[]): Promise<PostedDocument> => ({
    item: toItem((await loadItem(store, orgId, itemId))!),
    movementIds: movementIds.map((id) => id.toHexString()),
  });

  r.post("/receipts", zValidator("json", receiveInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const itemId = new ObjectId(input.itemId);
    const result = await postAdjustment(store, orgId, actorOf(c.get("user")), {
      itemId,
      locationId: new ObjectId(input.locationId),
      delta: input.quantity,
      reason: input.reference ? `Received: ${input.reference}` : "Received",
      type: "receive",
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(await posted(orgId, itemId, result.movementIds), 201);
  });

  r.post("/moves", zValidator("json", moveInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const itemId = new ObjectId(input.itemId);
    const result = await postMove(store, orgId, actorOf(c.get("user")), {
      itemId,
      fromLocationId: new ObjectId(input.fromLocationId),
      toLocationId: new ObjectId(input.toLocationId),
      quantity: input.quantity,
      reason: input.reason,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(await posted(orgId, itemId, result.movementIds), 201);
  });

  /** Resolve whatever a scanner typed: an item SKU, a location code or name, or a raw id. */
  r.get("/lookup", zValidator("query", lookupQuery), async (c) => {
    const orgId = c.get("org")._id;
    const { code } = c.req.valid("query");
    const none: LookupResult = { kind: "none" };
    if (!code) return c.json(none);

    const locationResult = async (id: ObjectId): Promise<LookupResult | null> => {
      const docs = await loadLocations(store, orgId);
      const doc = docs.find((d) => d._id.equals(id));
      if (!doc) return null;
      return { kind: "location", location: toLocation(doc, indexLocations(docs).pathOf(id.toHexString())) };
    };

    // Exact match first; then other zero-padded forms of the same barcode number.
    const variants = gtinVariants(code);
    const item =
      (await store.items.findOne({ orgId, sku: code }, { collation: ci })) ??
      (variants.length > 1 ? await store.items.findOne({ orgId, sku: { $in: variants } }, { collation: ci }) : null) ??
      (isObjectId(code) ? await store.items.findOne({ orgId, _id: new ObjectId(code) }) : null);
    if (item) {
      const full = await loadItem(store, orgId, item._id);
      return c.json<LookupResult>({ kind: "item", item: toItem(full!) });
    }

    const location =
      (await store.locations.findOne({ orgId, code }, { collation: ci })) ??
      (isObjectId(code) ? await store.locations.findOne({ orgId, _id: new ObjectId(code) }) : null) ??
      (await store.locations.findOne({ orgId, name: code }, { collation: ci }));
    if (location) return c.json((await locationResult(location._id)) ?? none);

    return c.json(none);
  });

  return r;
}
