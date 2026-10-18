import { zValidator } from "@hono/zod-validator";
import {
  movementTypeSchema,
  objectIdSchema,
  reverseInputSchema,
  type ActivityEntry,
  type ActivityPage,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { auditActor, itemEntity, recordAudit } from "./audit.js";
import { movementType, type MovementDoc, type Store } from "./db.js";
import { indexLocations, loadLocations } from "./locations.js";
import { ROLE_RANK, type OrgEnv } from "./org-access.js";
import { changeStock } from "./stock-service.js";

/** Members can take back their own mistakes for a short while. Anything else needs an admin. */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

const idParam = z.object({ id: objectIdSchema });
const listQuery = z.object({
  itemId: objectIdSchema.optional(),
  locationId: objectIdSchema.optional(),
  type: movementTypeSchema.optional(),
  q: z.string().trim().max(100).optional(),
  before: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createActivityRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const canReverse = (m: MovementDoc, role: keyof typeof ROLE_RANK, userId: string, now = Date.now()) => {
    if (movementType(m) === "reversal" || m.reversedBy) return false;
    if (ROLE_RANK[role] >= ROLE_RANK.admin) return true;
    return !!m.userId && m.userId.toHexString() === userId && now - m.createdAt.getTime() <= UNDO_WINDOW_MS;
  };

  r.get("/", zValidator("query", listQuery), async (c) => {
    const orgId = c.get("org")._id;
    const { itemId, locationId, type, q, before, limit } = c.req.valid("query");
    const user = c.get("user");

    const filter: Filter<MovementDoc> = { orgId };
    if (before) filter._id = { $lt: new ObjectId(before) };
    if (itemId) filter.itemId = new ObjectId(itemId);

    const locationDocs = await loadLocations(store, orgId);
    const locations = indexLocations(locationDocs);
    if (locationId) {
      // A parent location includes everything inside it.
      const ids = [locationId, ...locations.descendants(locationId)];
      filter.locationId = { $in: ids.map((id) => new ObjectId(id)) };
    }

    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      const matches = await store.items
        .find({ orgId, $or: [{ sku: rx }, { name: rx }] }, { projection: { _id: 1 } })
        .limit(500)
        .toArray();
      const ids = matches.map((i) => i._id);
      filter.itemId = itemId ? (ids.some((i) => i.equals(itemId)) ? new ObjectId(itemId) : { $in: [] }) : { $in: ids };
    }

    // Types are derived for old rows, so filter after reading. Page until we have enough.
    const wanted = limit + 1;
    const rows: MovementDoc[] = [];
    let cursor: ObjectId | undefined = before ? new ObjectId(before) : undefined;
    for (let guard = 0; rows.length < wanted && guard < 20; guard++) {
      const batchFilter: Filter<MovementDoc> = cursor ? { ...filter, _id: { $lt: cursor } } : filter;
      const batch = await store.movements.find(batchFilter).sort({ _id: -1 }).limit(wanted * 2).toArray();
      if (!batch.length) break;
      for (const m of batch) {
        if (!type || movementType(m) === type) rows.push(m);
        if (rows.length >= wanted) break;
      }
      cursor = batch[batch.length - 1]!._id;
      if (batch.length < wanted * 2) break;
    }

    const page = rows.slice(0, limit);
    const itemIds = [...new Set(page.map((m) => m.itemId.toHexString()))].map((id) => new ObjectId(id));
    const items = await store.items.find({ _id: { $in: itemIds } }, { projection: { sku: 1, name: 1 } }).toArray();
    const itemById = new Map<string, { sku: string; name: string }>(items.map((i) => [i._id.toHexString(), i]));

    // Deleted items and locations keep their names in the ledger: the audit log remembers them.
    const missingItems = itemIds.filter((id) => !itemById.has(id.toHexString())).map((id) => id.toHexString());
    if (missingItems.length) {
      for (const e of await store.audit.find({ orgId, action: "item.deleted", "entity.id": { $in: missingItems } }).toArray()) {
        itemById.set(e.entity.id, { sku: String(e.snapshot?.sku ?? ""), name: `${e.snapshot?.name ?? "Deleted item"} (deleted)` });
      }
    }
    const missingLocations = [...new Set(page.map((m) => m.locationId.toHexString()))].filter((id) => !locations.byId.has(id));
    const deletedLocation = new Map<string, string>();
    if (missingLocations.length) {
      for (const e of await store.audit.find({ orgId, action: "location.deleted", "entity.id": { $in: missingLocations } }).toArray()) {
        deletedLocation.set(e.entity.id, `${e.snapshot?.path ?? e.entity.label} (deleted)`);
      }
    }

    const entries: ActivityEntry[] = page.map((m) => {
      const item = itemById.get(m.itemId.toHexString());
      const loc = locations.byId.get(m.locationId.toHexString());
      return {
        id: m._id.toHexString(),
        type: movementType(m),
        ...(m.unitCode ? { unitCode: m.unitCode } : {}),
        itemId: m.itemId.toHexString(),
        itemSku: item?.sku ?? "",
        itemName: item?.name ?? "Deleted item",
        locationId: m.locationId.toHexString(),
        locationName: loc?.name ?? deletedLocation.get(m.locationId.toHexString()) ?? "Deleted location",
        locationPath: loc ? locations.pathOf(m.locationId.toHexString()) : (deletedLocation.get(m.locationId.toHexString()) ?? "Deleted location"),
        delta: m.delta,
        reason: m.reason,
        userName: m.userName,
        ...(m.transferId ? { transferId: m.transferId.toHexString() } : {}),
        ...(m.reversalOf ? { reversalOf: m.reversalOf.toHexString() } : {}),
        reversed: !!m.reversedBy,
        canReverse: canReverse(m, c.get("role"), user.id),
        createdAt: m.createdAt.toISOString(),
      };
    });

    const result: ActivityPage = {
      entries,
      ...(rows.length > limit ? { nextBefore: page[page.length - 1]!._id.toHexString() } : {}),
    };
    return c.json(result);
  });

  r.post("/:id/reverse", zValidator("param", idParam), zValidator("json", reverseInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const user = c.get("user");
    const { reason } = c.req.valid("json");

    const original = await store.movements.findOne({ _id: new ObjectId(c.req.valid("param").id), orgId });
    if (!original) return c.json({ error: "Entry not found" }, 404);
    if (movementType(original) === "reversal") {
      return c.json({ error: "A reversal can't be reversed. Record a new receipt or adjustment instead." }, 409);
    }
    if (original.reversedBy) return c.json({ error: "That entry has already been reversed" }, 409);
    if (original.unitId) {
      return c.json({ error: "Entries for a roll or pallet can't be reversed yet. Move it back or adjust what's left instead." }, 409);
    }
    const item = await store.items.findOne({ _id: original.itemId, orgId }, { projection: { name: 1, sku: 1 } });
    if (!item) {
      return c.json({ error: "That item has been deleted. Its history is kept, but entries can't be reversed any more." }, 409);
    }
    if (!canReverse(original, c.get("role"), user.id)) {
      return c.json({ error: "You can only undo your own entries from the last 15 minutes. Ask an admin." }, 403);
    }

    // Both halves of a transfer are undone together.
    const group = original.transferId
      ? await store.movements.find({ orgId, transferId: original.transferId, reversalOf: { $exists: false } }).toArray()
      : [original];
    if (group.some((m) => m.reversedBy)) return c.json({ error: "That entry has already been reversed" }, 409);

    const pairs = group.map((m) => ({ original: m, reversalId: new ObjectId() }));

    // 1. Claim each original so two people can't reverse the same entry at once.
    const claimed: typeof pairs = [];
    const release = () =>
      Promise.all(claimed.map((p) => store.movements.updateOne({ _id: p.original._id }, { $unset: { reversedBy: "" } })));
    for (const pair of pairs) {
      const res = await store.movements.updateOne(
        { _id: pair.original._id, reversedBy: { $exists: false } },
        { $set: { reversedBy: pair.reversalId } },
      );
      if (!res.matchedCount) {
        await release();
        return c.json({ error: "That entry has already been reversed" }, 409);
      }
      claimed.push(pair);
    }

    // 2. Undo the stock change. Removals first: they're the ones that can fail.
    const applied: typeof pairs = [];
    const unwind = () =>
      Promise.all(applied.map((p) => changeStock(store, orgId, p.original.itemId, p.original.locationId, p.original.delta)));
    try {
      const ordered = [...pairs].sort((a, b) => b.original.delta - a.original.delta);
      for (const pair of ordered) {
        const { itemId, locationId, delta } = pair.original;
        if ((await changeStock(store, orgId, itemId, locationId, -delta)) === null) {
          await unwind();
          await release();
          const loc = await store.locations.findOne({ _id: locationId });
          return c.json(
            { error: `Can't reverse this: not enough stock left at ${loc?.name ?? "that location"}. It may have been used or moved already.` },
            422,
          );
        }
        applied.push(pair);
      }
    } catch (e) {
      await unwind();
      await release();
      throw e;
    }

    // 3. Record the reversals.
    const now = new Date();
    await store.movements.insertMany(
      pairs.map(({ original: o, reversalId }) => ({
        _id: reversalId,
        orgId,
        type: "reversal" as const,
        itemId: o.itemId,
        locationId: o.locationId,
        delta: -o.delta,
        reason: reason ? `Reversal: ${reason}` : "Reversal",
        userId: new ObjectId(user.id),
        userName: user.name,
        reversalOf: o._id,
        createdAt: now,
      })),
    );

    const places = await store.locations.find({ _id: { $in: group.map((m) => m.locationId) } }).toArray();
    const placeName = (id: ObjectId) => places.find((l) => l._id.equals(id))?.name ?? "a deleted location";
    const amount = (n: number) => Math.abs(n).toLocaleString("en-US");
    const what =
      original.transferId && group.length === 2
        ? (() => {
            const out = group.find((m) => m.delta < 0)!;
            const into = group.find((m) => m.delta > 0)!;
            return `move of ${amount(into.delta)} × ${item.name} from ${placeName(out.locationId)} to ${placeName(into.locationId)}`;
          })()
        : movementType(original) === "receive"
          ? `receipt of ${amount(original.delta)} × ${item.name} at ${placeName(original.locationId)}`
          : `adjustment of ${original.delta > 0 ? "+" : "-"}${amount(original.delta)} × ${item.name} at ${placeName(original.locationId)}`;
    await recordAudit(store, {
      orgId,
      actor: auditActor(user),
      action: "stock.reversed",
      entity: itemEntity(original.itemId, item),
      summary: `Reversed the ${what}${reason ? `: ${reason}` : ""}`,
      snapshot: { reason },
      refs: {
        movementIds: pairs.map((p) => p.reversalId.toHexString()),
        reversedMovementIds: pairs.map((p) => p.original._id.toHexString()),
        itemId: original.itemId.toHexString(),
      },
    });
    return c.json({ reversedIds: pairs.map((p) => p.original._id.toHexString()), movementIds: pairs.map((p) => p.reversalId.toHexString()) });
  });

  return r;
}
