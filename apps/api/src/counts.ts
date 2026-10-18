import { zValidator } from "@hono/zod-validator";
import { countLineSchema, countPostSchema, countStartSchema, objectIdSchema, type Count, type CountListRow } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import { isDuplicateKey, type CountDoc, type Store } from "./db.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import { requireRole, ROLE_RANK, type OrgEnv } from "./org-access.js";
import { postAdjustment } from "./stock-service.js";

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);

/**
 * Cycle counts. Anyone can count (walk a place, say what's there); an admin reviews the differences and
 * posts them. Posting writes ordinary adjustments through the ledger, so a bad count can be reversed.
 * Counts here are by quantity. Roll and pallet items are counted by their labels (not built yet), so they are skipped.
 */
export function createCountRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const qtyAt = async (orgId: ObjectId, locationId: ObjectId, itemIds?: ObjectId[]) => {
    const rows = await store.stock.find({ orgId, locationId, quantity: { $gt: 0 }, ...(itemIds ? { itemId: { $in: itemIds } } : {}) }).toArray();
    return new Map(rows.map((s) => [s.itemId.toHexString(), s.quantity]));
  };

  async function present(doc: CountDoc): Promise<Count> {
    const orgId = doc.orgId;
    const locations = indexLocations(await loadLocations(store, orgId));
    const posted = doc.status === "posted";
    const live = await qtyAt(orgId, doc.locationId);
    const items = await store.items.find({ orgId, _id: { $in: [...new Set([...doc.lines.map((l) => l.itemId.toHexString()), ...live.keys()])].map(oid) } }).toArray();
    const byId = new Map(items.map((i) => [i._id.toHexString(), i]));
    const lines = doc.lines.map((l) => {
      const item = byId.get(l.itemId.toHexString());
      const expected = posted ? (l.expectedAtPost ?? 0) : (live.get(l.itemId.toHexString()) ?? 0);
      const variance = l.counted - expected;
      return {
        itemId: l.itemId.toHexString(), itemSku: item?.sku ?? "", itemName: item?.name ?? "Deleted item",
        expected, counted: l.counted, variance, varianceCents: variance * (item?.unitCostCents ?? 0),
      };
    });
    const counted = new Set(doc.lines.map((l) => l.itemId.toHexString()));
    const uncounted = posted ? [] : [...live.entries()]
      .filter(([id]) => !counted.has(id) && byId.get(id)?.tracking !== "unit")
      .map(([id, expected]) => ({ itemId: id, itemSku: byId.get(id)?.sku ?? "", itemName: byId.get(id)?.name ?? "Deleted item", expected }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName, "en"));
    lines.sort((a, b) => Math.abs(b.varianceCents) - Math.abs(a.varianceCents) || a.itemName.localeCompare(b.itemName, "en"));
    return {
      id: doc._id.toHexString(), number: doc.number, status: doc.status, locationId: doc.locationId.toHexString(),
      locationPath: locations.byId.has(doc.locationId.toHexString()) ? locations.pathOf(doc.locationId.toHexString()) : "Deleted location",
      note: doc.note, startedBy: doc.startedBy.name, startedAt: doc.startedAt.toISOString(), postedAt: doc.postedAt?.toISOString() ?? null,
      lines, uncounted,
      summary: {
        counted: lines.length, matched: lines.filter((l) => l.variance === 0).length,
        over: lines.filter((l) => l.variance > 0).length, under: lines.filter((l) => l.variance < 0).length,
        netUnits: lines.reduce((s, l) => s + l.variance, 0), netCents: lines.reduce((s, l) => s + l.varianceCents, 0),
      },
    };
  }

  r.get("/", async (c) => {
    const docs = await store.counts.find({ orgId: c.get("org")._id }).sort({ startedAt: -1 }).limit(100).toArray();
    const locations = indexLocations(await loadLocations(store, c.get("org")._id));
    const rows: CountListRow[] = await Promise.all(docs.map(async (d) => {
      const full = d.status === "open" ? await present(d) : null;
      return {
        id: d._id.toHexString(), number: d.number, status: d.status,
        locationPath: locations.byId.has(d.locationId.toHexString()) ? locations.pathOf(d.locationId.toHexString()) : "Deleted location",
        startedBy: d.startedBy.name, startedAt: d.startedAt.toISOString(), lines: d.lines.length,
        variances: full ? full.summary.over + full.summary.under : d.lines.filter((l) => l.counted !== (l.expectedAtPost ?? l.counted)).length,
      };
    }));
    return c.json(rows);
  });

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const doc = await store.counts.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id });
    return doc ? c.json(await present(doc)) : c.json({ error: "Count not found" }, 404);
  });

  r.post("/", zValidator("json", countStartSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { locationId, note } = c.req.valid("json");
    const location = await store.locations.findOne({ _id: oid(locationId), orgId });
    if (!location) return c.json({ error: "Location not found" }, 404);
    const existing = await store.counts.findOne({ orgId, locationId: location._id, status: "open" });
    // Starting a count where one is already open just continues it: two people at one shelf share one sheet.
    if (existing) return c.json(await present(existing), 200);
    const doc: CountDoc = {
      _id: new ObjectId(), orgId, number: await nextNumber(store, orgId, "count", "CNT-"), status: "open", locationId: location._id, note,
      startedBy: { id: oid(c.get("user").id), name: c.get("user").name }, startedAt: new Date(), lines: [],
    };
    try {
      await store.counts.insertOne(doc);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const winner = await store.counts.findOne({ orgId, locationId: location._id, status: "open" });
      if (winner) return c.json(await present(winner), 200);
      throw e;
    }
    await recordAudit(store, { orgId, actor: auditActor(c.get("user")), action: "count.started", entity: { type: "count", id: doc._id.toHexString(), label: doc.number }, summary: `Started ${doc.number} at ${location.name}` });
    return c.json(await present(doc), 201);
  });

  r.put("/:id/lines", zValidator("param", idParam), zValidator("json", countLineSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { itemId, counted } = c.req.valid("json");
    const item = await store.items.findOne({ _id: oid(itemId), orgId });
    if (!item) return c.json({ error: "Item not found" }, 404);
    if (item.tracking === "unit") return c.json({ error: `${item.name} is counted by its roll or pallet labels, not by quantity.` }, 409);
    const _id = oid(c.req.valid("param").id);
    const doc = await store.counts.findOne({ _id, orgId });
    if (!doc) return c.json({ error: "Count not found" }, 404);
    if (doc.status !== "open") return c.json({ error: `This count is ${doc.status}` }, 409);
    // Replace the line if it exists, otherwise add it. Filtering on status keeps a posted count untouched.
    const replaced = await store.counts.updateOne({ _id, status: "open", "lines.itemId": item._id }, { $set: { "lines.$.counted": counted } });
    if (!replaced.matchedCount) {
      const added = await store.counts.updateOne({ _id, status: "open", "lines.itemId": { $ne: item._id } }, { $push: { lines: { itemId: item._id, counted } } });
      if (!added.matchedCount) return c.json({ error: "This count was just closed" }, 409);
    }
    return c.json(await present((await store.counts.findOne({ _id }))!));
  });

  r.delete("/:id/lines/:itemId", zValidator("param", z.object({ id: objectIdSchema, itemId: objectIdSchema })), async (c) => {
    const { id, itemId } = c.req.valid("param");
    const res = await store.counts.updateOne({ _id: oid(id), orgId: c.get("org")._id, status: "open" }, { $pull: { lines: { itemId: oid(itemId) } } });
    if (!res.matchedCount) return c.json({ error: "Count not found or already closed" }, 404);
    return c.json(await present((await store.counts.findOne({ _id: oid(id) }))!));
  });

  /** An admin reviews the differences and posts them. Each difference is an ordinary adjustment, so it can be reversed in Activity. */
  r.post("/:id/post", requireRole("admin"), zValidator("param", idParam), zValidator("json", countPostSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { zeroUncounted } = c.req.valid("json");
    const _id = oid(c.req.valid("param").id);
    // Claim it first, so two admins can't post the same count twice.
    const claimed = await store.counts.findOneAndUpdate({ _id, orgId, status: "open" }, { $set: { status: "posted", postedAt: new Date() } });
    if (!claimed) return c.json({ error: "That count isn't open" }, 409);
    const location = await store.locations.findOne({ _id: claimed.locationId });
    const view = await present({ ...claimed, status: "open" });
    const actor = actorOf(c.get("user"));
    const todo = [
      ...view.lines.filter((l) => l.variance !== 0).map((l) => ({ itemId: l.itemId, delta: l.variance, expected: l.expected, counted: l.counted })),
      ...(zeroUncounted ? view.uncounted.map((u) => ({ itemId: u.itemId, delta: -u.expected, expected: u.expected, counted: 0 })) : []),
    ];
    const failures: string[] = [];
    const movementIds: string[] = [];
    const lines: CountDoc["lines"] = view.lines.map((l) => ({ itemId: oid(l.itemId), counted: l.counted, expectedAtPost: l.expected }));
    if (zeroUncounted) for (const u of view.uncounted) lines.push({ itemId: oid(u.itemId), counted: 0, expectedAtPost: u.expected });
    for (const t of todo) {
      const res = await postAdjustment(store, orgId, actor, { itemId: oid(t.itemId), locationId: claimed.locationId, delta: t.delta, reason: `Count ${claimed.number}`, type: "adjust" });
      if (res.ok) movementIds.push(...res.movementIds.map(String));
      else failures.push(`${view.lines.find((l) => l.itemId === t.itemId)?.itemName ?? t.itemId}: ${res.error}`);
    }
    await store.counts.updateOne({ _id }, { $set: { lines } });
    const net = todo.reduce((s, t) => s + t.delta, 0);
    await recordAudit(store, {
      orgId, actor: auditActor(c.get("user")), action: "count.posted", entity: { type: "count", id: _id.toHexString(), label: claimed.number },
      summary: `Posted ${claimed.number} at ${location?.name ?? "a location"}: ${todo.length} ${todo.length === 1 ? "difference" : "differences"}, net ${net > 0 ? "+" : ""}${net.toLocaleString("en-US")} units${failures.length ? `, ${failures.length} failed` : ""}`,
      refs: { movementIds, countId: _id.toHexString() },
    });
    const out = await present((await store.counts.findOne({ _id }))!);
    return c.json({ count: out, adjustments: movementIds.length, failures }, failures.length ? 207 : 200);
  });

  r.post("/:id/cancel", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.counts.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Count not found" }, 404);
    const mine = doc.startedBy.id.toHexString() === c.get("user").id;
    if (!mine && ROLE_RANK[c.get("role")] < ROLE_RANK.admin) return c.json({ error: "Only an admin or whoever started it can cancel a count" }, 403);
    const res = await store.counts.findOneAndUpdate({ _id: doc._id, status: "open" }, { $set: { status: "cancelled" } }, { returnDocument: "after" });
    if (!res) return c.json({ error: "That count isn't open" }, 409);
    await recordAudit(store, { orgId, actor: auditActor(c.get("user")), action: "count.cancelled", entity: { type: "count", id: doc._id.toHexString(), label: doc.number }, summary: `Cancelled ${doc.number}` });
    return c.json(await present(res));
  });

  return r;
}
