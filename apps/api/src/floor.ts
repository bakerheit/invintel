import { zValidator } from "@hono/zod-validator";
import {
  gtinVariants,
  moveBatchSchema,
  moveInputSchema,
  objectIdSchema,
  receiveBatchSchema,
  receiveInputSchema,
  type LookupResult,
  type PostedBatch,
  type PostedDocument,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { canReverse, reverseGroup } from "./activity.js";
import { auditActor, itemEntity, recordAudit } from "./audit.js";
import { movementType, type MovementDoc, type Store } from "./db.js";
import { loadItem, toItem } from "./item-queries.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations, toLocation } from "./locations.js";
import type { OrgEnv } from "./org-access.js";
import { ON_HOLD_AREA, postAdjustment, postMove, UNIT_TRACKED } from "./stock-service.js";
import { INSPECT_REASON, openHold } from "./quality.js";
import { presentUnits } from "./units.js";

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
      supplierLot: input.supplierLot,
      ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    if (input.inspect) {
      // Inspect before release: what just arrived goes straight on quality hold.
      const hold = await openHold(store, orgId, actorOf(c.get("user")), {
        reason: INSPECT_REASON, note: input.reference, source: "receiving", itemId: input.itemId, locationId: input.locationId, quantity: input.quantity, supplierLot: input.supplierLot,
      });
      if (!hold.ok) return c.json({ error: `Received, but it could not be put on hold: ${hold.error}` }, hold.status);
      return c.json({ ...(await posted(orgId, itemId, [...result.movementIds, ...hold.movementIds])), ncrs: [{ id: hold.ncr._id.toHexString(), number: hold.ncr.number }] }, 201);
    }
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

  /** Takes back lines already posted in a batch that then failed, so a failed document leaves nothing behind. */
  const rollback = async (orgId: ObjectId, user: { id: string; name: string }, movementIds: ObjectId[]) => {
    if (!movementIds.length) return true;
    const docs = await store.movements.find({ _id: { $in: movementIds }, orgId }).toArray();
    return (await reverseGroup(store, orgId, user, docs, "Document failed part way")).ok;
  };

  const lineNo = (i: number, name: string) => `Line ${i + 1} (${name})`;

  /** Several items into one place as one document. Everything is checked first; if a line still fails, the ones before it are taken back. */
  r.post("/receipts/batch", zValidator("json", receiveBatchSchema), async (c) => {
    const orgId = c.get("org")._id;
    const user = c.get("user");
    const input = c.req.valid("json");
    const actor = actorOf(user);

    const location = await store.locations.findOne({ _id: new ObjectId(input.locationId), orgId });
    if (!location) return c.json({ error: "Location not found" }, 404);
    if (location.type === "quarantine") return c.json({ error: ON_HOLD_AREA }, 409);
    const ids = [...new Set(input.lines.map((l) => l.itemId))];
    const items = await store.items.find({ orgId, _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { name: 1, sku: 1, tracking: 1 } }).toArray();
    const byId = new Map(items.map((i) => [i._id.toHexString(), i]));
    for (const [i, l] of input.lines.entries()) {
      const item = byId.get(l.itemId);
      if (!item) return c.json({ error: `${lineNo(i, "unknown item")}: that item doesn't exist. Nothing was received.` }, 404);
      if (item.tracking === "unit") return c.json({ error: `${lineNo(i, item.name)}: ${UNIT_TRACKED} Nothing was received.` }, 409);
    }

    const batchId = new ObjectId();
    const posted: ObjectId[] = [];
    const lines: PostedBatch["lines"] = [];
    try {
      for (const [i, l] of input.lines.entries()) {
        const item = byId.get(l.itemId)!;
        const parts = [input.reference, l.sscc ? `pallet ${l.sscc}` : ""].filter(Boolean);
        const res = await postAdjustment(store, orgId, actor, {
          itemId: item._id, locationId: location._id, delta: l.quantity, type: "receive", reason: parts.length ? `Received: ${parts.join(" · ")}` : "Received",
          supplierLot: l.supplierLot, ...(l.expiresOn ? { expiresOn: l.expiresOn } : {}), ...(l.sscc ? { sscc: l.sscc } : {}), batchId,
        });
        if (!res.ok) {
          const undone = await rollback(orgId, { id: user.id, name: user.name }, posted);
          return c.json({ error: undone ? `${lineNo(i, item.name)}: ${res.error}. Nothing was received.` : `${lineNo(i, item.name)}: ${res.error}. Earlier lines were received and could not be taken back: check Activity.` }, res.status);
        }
        posted.push(...res.movementIds);
        lines.push({ itemId: l.itemId, itemName: item.name, quantity: l.quantity, movementIds: res.movementIds.map(String) });
      }
    } catch (e) {
      // The database failed part way: take back what was posted, so the document is all or nothing.
      await rollback(orgId, { id: user.id, name: user.name }, posted);
      throw e;
    }

    const ncrs: { id: string; number: string }[] = [];
    if (input.inspect) {
      // Inspect before release: each line goes on quality hold on its own, with its own lot, so they can be decided separately.
      for (const [i, l] of input.lines.entries()) {
        const hold = await openHold(store, orgId, actor, { reason: INSPECT_REASON, note: input.reference, source: "receiving", itemId: l.itemId, locationId: input.locationId, quantity: l.quantity, supplierLot: l.supplierLot });
        if (!hold.ok) return c.json({ error: `Received, but ${lineNo(i, byId.get(l.itemId)!.name)} could not be put on hold: ${hold.error}. Look in Activity and Quality before receiving again.`, partial: true }, hold.status);
        ncrs.push({ id: hold.ncr._id.toHexString(), number: hold.ncr.number });
        await store.movements.updateMany({ _id: { $in: hold.movementIds } }, { $set: { batchId } }); // so undo sees the hold and says so
        posted.push(...hold.movementIds);
        lines[i]!.movementIds.push(...hold.movementIds.map(String));
      }
    }
    const result: PostedBatch = { batchId: batchId.toHexString(), lines, movementIds: posted.map(String), ...(ncrs.length ? { ncrs } : {}) };
    return c.json(result, 201);
  });

  /** Several items to one place as one document. */
  r.post("/moves/batch", zValidator("json", moveBatchSchema), async (c) => {
    const orgId = c.get("org")._id;
    const user = c.get("user");
    const input = c.req.valid("json");
    const actor = actorOf(user);
    const to = await store.locations.findOne({ _id: new ObjectId(input.toLocationId), orgId });
    if (!to) return c.json({ error: "Location not found" }, 404);
    if (to.type === "quarantine") return c.json({ error: ON_HOLD_AREA }, 409);

    const ids = [...new Set(input.lines.map((l) => l.itemId))];
    const items = await store.items.find({ orgId, _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { name: 1, sku: 1, tracking: 1 } }).toArray();
    const byId = new Map(items.map((i) => [i._id.toHexString(), i]));
    // What each (item, from-place) must hold for the whole document, so a shortage is reported before anything moves.
    const need = new Map<string, number>();
    for (const [i, l] of input.lines.entries()) {
      const item = byId.get(l.itemId);
      if (!item) return c.json({ error: `${lineNo(i, "unknown item")}: that item doesn't exist. Nothing was moved.` }, 404);
      if (item.tracking === "unit") return c.json({ error: `${lineNo(i, item.name)}: ${UNIT_TRACKED} Nothing was moved.` }, 409);
      if (l.fromLocationId === input.toLocationId) return c.json({ error: `${lineNo(i, item.name)}: it is already there. Nothing was moved.` }, 422);
      need.set(`${l.itemId}:${l.fromLocationId}`, (need.get(`${l.itemId}:${l.fromLocationId}`) ?? 0) + l.quantity);
    }
    const fromIds = [...new Set(input.lines.map((l) => l.fromLocationId))];
    const froms = await store.locations.find({ orgId, _id: { $in: fromIds.map((id) => new ObjectId(id)) } }).toArray();
    const fromById = new Map(froms.map((l) => [l._id.toHexString(), l]));
    for (const [i, l] of input.lines.entries()) {
      const from = fromById.get(l.fromLocationId);
      const name = byId.get(l.itemId)!.name;
      if (!from) return c.json({ error: `${lineNo(i, name)}: the place it comes from doesn't exist. Nothing was moved.` }, 404);
      if (from.type === "quarantine") return c.json({ error: `${lineNo(i, name)}: ${ON_HOLD_AREA} Nothing was moved.` }, 409);
    }
    for (const [key, qty] of need) {
      const [itemId, fromId] = key.split(":") as [string, string];
      const have = (await store.stock.findOne({ orgId, itemId: new ObjectId(itemId), locationId: new ObjectId(fromId) }))?.quantity ?? 0;
      if (have < qty) return c.json({ error: `Only ${have.toLocaleString("en-US")} of ${byId.get(itemId)!.name} at ${fromById.get(fromId)!.name}, and this document takes ${qty.toLocaleString("en-US")}. Nothing was moved.` }, 422);
    }

    const batchId = new ObjectId();
    const posted: ObjectId[] = [];
    const lines: PostedBatch["lines"] = [];
    try {
      for (const [i, l] of input.lines.entries()) {
        const item = byId.get(l.itemId)!;
        const res = await postMove(store, orgId, actor, { itemId: item._id, fromLocationId: new ObjectId(l.fromLocationId), toLocationId: to._id, quantity: l.quantity, reason: input.reason, batchId });
        if (!res.ok) {
          const undone = await rollback(orgId, { id: user.id, name: user.name }, posted);
          return c.json({ error: undone ? `${lineNo(i, item.name)}: ${res.error}. Nothing was moved.` : `${lineNo(i, item.name)}: ${res.error}. Earlier lines were moved and could not be taken back: check Activity.` }, res.status);
        }
        posted.push(...res.movementIds);
        lines.push({ itemId: l.itemId, itemName: item.name, quantity: l.quantity, movementIds: res.movementIds.map(String) });
      }
    } catch (e) {
      await rollback(orgId, { id: user.id, name: user.name }, posted);
      throw e;
    }
    const result: PostedBatch = { batchId: batchId.toHexString(), lines, movementIds: posted.map(String) };
    return c.json(result, 201);
  });

  /** Undo a whole batch document at once, under the same rules as undoing a single entry. */
  r.post("/batches/:id/undo", zValidator("param", z.object({ id: objectIdSchema })), async (c) => {
    const orgId = c.get("org")._id;
    const user = c.get("user");
    const rows = await store.movements.find({ orgId, batchId: new ObjectId(c.req.valid("param").id) }).toArray();
    const originals = rows.filter((m: MovementDoc) => movementType(m) !== "reversal");
    if (!originals.length) return c.json({ error: "Nothing found to undo" }, 404);
    if (originals.some((m) => m.reversedBy)) return c.json({ error: "That has already been undone" }, 409);
    if (originals.some((m) => m.ncrId)) return c.json({ error: "Part of it is on quality hold. Decide it from Quality instead." }, 409);
    if (originals.some((m) => !canReverse(m, c.get("role"), user.id))) return c.json({ error: "You can only undo your own entries from the last 15 minutes. Ask an admin." }, 403);
    const reversed = await reverseGroup(store, orgId, { id: user.id, name: user.name }, originals, "Undone from the floor");
    if (!reversed.ok) return c.json({ error: reversed.error }, reversed.status);
    const first = (await store.items.findOne({ _id: originals[0]!.itemId, orgId }, { projection: { name: 1, sku: 1 } }))!;
    const kind = movementType(originals[0]!) === "receive" ? "receipt" : "move";
    await recordAudit(store, {
      orgId, actor: auditActor(user), action: "stock.reversed", entity: itemEntity(originals[0]!.itemId, first),
      summary: `Undid a ${kind} of ${new Set(originals.map((m) => m.itemId.toHexString())).size} item${new Set(originals.map((m) => m.itemId.toHexString())).size === 1 ? "" : "s"} (${first.name}${originals.some((m) => !m.itemId.equals(originals[0]!.itemId)) ? " and others" : ""})`,
      refs: { movementIds: reversed.pairs.map((p) => p.reversalId.toHexString()), reversedMovementIds: reversed.pairs.map((p) => p.original._id.toHexString()) },
    });
    return c.json({ reversedIds: reversed.pairs.map((p) => p.original._id.toHexString()), movementIds: reversed.pairs.map((p) => p.reversalId.toHexString()) });
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

    // A roll or pallet label.
    const unit = await store.units.findOne({ orgId, code }, { collation: ci });
    if (unit) return c.json<LookupResult>({ kind: "unit", unit: (await presentUnits(store, orgId, [unit]))[0]! });

    // An exact SKU or barcode wins; then other zero-padded forms of the same barcode number.
    const variants = gtinVariants(code);
    const byCode = (codes: string[]) =>
      store.items.findOne({ orgId, $or: [{ sku: { $in: codes } }, { barcodes: { $in: codes } }] }, { collation: ci });
    const item =
      (await byCode([code])) ??
      (variants.length > 1 ? await byCode(variants) : null) ??
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
