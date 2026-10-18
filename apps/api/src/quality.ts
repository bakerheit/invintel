import { zValidator } from "@hono/zod-validator";
import { disposeInputSchema, holdInputSchema, objectIdSchema, type Ncr, type NcrSummary } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, itemEntity, recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import { isDuplicateKey, type LocationDoc, type NcrDoc, type Store } from "./db.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { holdReasonsOf, matchReason, scrapReasonsOf } from "./reasons.js";
import { changeStock, logMovement, type Actor, type Failure } from "./stock-service.js";
import { adjustUnit, moveUnit } from "./units.js";

// INV-2: quality hold and NCR. Plain stock is moved into a hold area (a location of type "quarantine"); a labelled
// roll or pallet keeps its place and gets status "quarantined". Either way it can't be used, moved or counted until
// someone decides: use, rework, scrap or return. Every stock change goes through the ledger and carries the NCR id.

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);

export const INSPECT_REASON = "Awaiting inspection";

/** The one hold area of an organization, made on first use. */
export async function ensureHoldLocation(store: Store, orgId: ObjectId): Promise<LocationDoc> {
  const existing = await store.locations.findOne({ orgId, type: "quarantine" }, { sort: { createdAt: 1 } });
  if (existing) return existing;
  const now = new Date();
  const doc: LocationDoc = {
    _id: new ObjectId(), orgId, name: "Quality hold", description: "Stock waiting for a quality decision. Managed from Quality.",
    type: "quarantine", parentId: null, code: "", createdAt: now, updatedAt: now,
  };
  try {
    await store.locations.insertOne(doc);
    return doc;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return (await store.locations.findOne({ orgId, type: "quarantine" }, { sort: { createdAt: 1 } })) ?? (await store.locations.findOne({ orgId, name: "Quality hold" }))!;
  }
}

export interface HoldRequest {
  reason: string;
  note: string;
  source: "manual" | "receiving";
  unitId?: string;
  itemId?: string;
  locationId?: string;
  quantity?: number;
  supplierLot?: string;
  purchaseOrderId?: ObjectId;
}

type HoldResult = { ok: true; ncr: NcrDoc; movementIds: ObjectId[] } | Failure;
const bad = (status: 404 | 409 | 422, error: string): Failure => ({ ok: false, status, error });

/** Put stock on hold and open the NCR for it. */
export async function openHold(store: Store, orgId: ObjectId, actor: Actor, req: HoldRequest): Promise<HoldResult> {
  const ncrId = new ObjectId();
  const now = new Date();
  const base = { _id: ncrId, orgId, status: "open" as const, source: req.source, reason: req.reason, note: req.note, heldBy: { id: actor.userId, name: actor.userName }, heldAt: now, dispositions: [] as NcrDoc["dispositions"] };
  let doc: NcrDoc;
  const movementIds: ObjectId[] = [];

  if (req.unitId) {
    const unit = await store.units.findOne({ _id: oid(req.unitId), orgId });
    if (!unit) return bad(404, "That roll or pallet isn't in the system");
    if (unit.status === "consumed") return bad(409, `${unit.code} has been used up`);
    if (unit.status === "quarantined") return bad(409, `${unit.code} is already on hold`);
    const claimed = await store.units.findOneAndUpdate({ _id: unit._id, orgId, status: "available" }, { $set: { status: "quarantined", updatedAt: now } }, { returnDocument: "after" });
    if (!claimed) return bad(409, `Someone else just changed ${unit.code}`);
    doc = {
      ...base, number: await nextNumber(store, orgId, "ncr", "NCR-"), itemId: unit.itemId, unitId: unit._id, unitCode: unit.code,
      fromLocationId: unit.locationId, heldLocationId: unit.locationId, quantity: unit.quantity, remaining: unit.quantity,
      supplierLot: req.supplierLot || unit.lot || "", ...(req.purchaseOrderId ? { purchaseOrderId: req.purchaseOrderId } : {}),
    };
  } else {
    if (!req.itemId || !req.locationId || !req.quantity) return bad(409, "Say which item, where it is and how many");
    const item = await store.items.findOne({ _id: oid(req.itemId), orgId }, { projection: { tracking: 1, name: 1, sku: 1 } });
    if (!item) return bad(404, "Item not found");
    if (item.tracking === "unit") return bad(409, "Scan the roll or pallet label: this item is tracked by unit");
    const from = await store.locations.findOne({ _id: oid(req.locationId), orgId });
    if (!from) return bad(404, "Location not found");
    if (from.type === "quarantine") return bad(409, "That stock is already on hold");
    const hold = await ensureHoldLocation(store, orgId);
    if ((await changeStock(store, orgId, item._id, from._id, -req.quantity)) === null) {
      const have = (await store.stock.findOne({ orgId, itemId: item._id, locationId: from._id }))?.quantity ?? 0;
      return bad(422, `Only ${have} of ${item.name} at ${from.name}`);
    }
    await changeStock(store, orgId, item._id, hold._id, req.quantity);
    doc = {
      ...base, number: await nextNumber(store, orgId, "ncr", "NCR-"), itemId: item._id, fromLocationId: from._id, heldLocationId: hold._id,
      quantity: req.quantity, remaining: req.quantity, supplierLot: req.supplierLot ?? "", ...(req.purchaseOrderId ? { purchaseOrderId: req.purchaseOrderId } : {}),
    };
    const transferId = new ObjectId();
    const note = `Quality hold ${doc.number}: ${req.reason}`;
    const common = { orgId, type: "transfer" as const, itemId: item._id, reason: note, transferId, ncrId, ...(doc.supplierLot ? { supplierLot: doc.supplierLot } : {}), actor };
    movementIds.push(await logMovement(store, { ...common, locationId: from._id, delta: -req.quantity }));
    movementIds.push(await logMovement(store, { ...common, locationId: hold._id, delta: req.quantity }));
  }

  await store.ncrs.insertOne(doc);
  const item = await store.items.findOne({ _id: doc.itemId, orgId }, { projection: { name: 1, sku: 1 } });
  await recordAudit(store, {
    orgId, actor: { id: actor.userId, name: actor.userName }, action: "ncr.opened", entity: { type: "ncr", id: ncrId.toHexString(), label: doc.number },
    summary: `Put ${doc.unitCode ?? `${doc.quantity.toLocaleString("en-US")} × ${item?.name ?? "item"}`} on quality hold (${doc.number}): ${req.reason}`,
    snapshot: { reason: req.reason, note: req.note, source: req.source, quantity: doc.quantity, supplierLot: doc.supplierLot, unit: doc.unitCode ?? null, item: item ? itemEntity(doc.itemId, item).label : null },
    refs: { movementIds: movementIds.map(String), itemId: doc.itemId.toHexString(), ...(doc.unitId ? { unitIds: [doc.unitId.toHexString()] } : {}) },
  });
  return { ok: true, ncr: doc, movementIds };
}

export function createQualityRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  async function present(orgId: ObjectId, docs: NcrDoc[]): Promise<Ncr[]> {
    if (!docs.length) return [];
    const [items, locs, pos] = await Promise.all([
      store.items.find({ _id: { $in: [...new Set(docs.map((d) => d.itemId.toHexString()))].map(oid) } }, { projection: { sku: 1, name: 1 } }).toArray(),
      loadLocations(store, orgId).then(indexLocations),
      store.purchaseOrders.find({ _id: { $in: docs.flatMap((d) => (d.purchaseOrderId ? [d.purchaseOrderId] : [])) } }, { projection: { number: 1 } }).toArray(),
    ]);
    const item = new Map(items.map((i) => [i._id.toHexString(), i]));
    const po = new Map(pos.map((p) => [p._id.toHexString(), p.number]));
    const path = (id: ObjectId) => (locs.byId.has(id.toHexString()) ? locs.pathOf(id.toHexString()) : "Deleted location");
    return docs.map((d) => ({
      id: d._id.toHexString(), number: d.number, status: d.status, source: d.source,
      itemId: d.itemId.toHexString(), itemSku: item.get(d.itemId.toHexString())?.sku ?? "", itemName: item.get(d.itemId.toHexString())?.name ?? "Deleted item",
      unitId: d.unitId?.toHexString() ?? null, unitCode: d.unitCode ?? null,
      fromLocationPath: path(d.fromLocationId), heldAtPath: path(d.heldLocationId),
      quantity: d.quantity, remaining: d.remaining, supplierLot: d.supplierLot,
      purchaseOrderNumber: d.purchaseOrderId ? (po.get(d.purchaseOrderId.toHexString()) ?? null) : null,
      reason: d.reason, note: d.note, heldBy: d.heldBy.name, heldAt: d.heldAt.toISOString(), closedAt: d.closedAt?.toISOString() ?? null,
      dispositions: d.dispositions.map((x) => ({
        type: x.type, quantity: x.quantity, toLocationPath: x.toLocationId ? path(x.toLocationId) : null, reason: x.reason, note: x.note, by: x.by.name, at: x.at.toISOString(),
      })),
    }));
  }

  r.get("/ncrs", zValidator("query", z.object({ status: z.enum(["open", "closed", "all"]).default("all") })), async (c) => {
    const orgId = c.get("org")._id;
    const { status } = c.req.valid("query");
    const docs = await store.ncrs.find({ orgId, ...(status === "all" ? {} : { status }) }).sort({ heldAt: -1 }).limit(200).toArray();
    return c.json(await present(orgId, docs));
  });

  r.get("/summary", async (c) => {
    const orgId = c.get("org")._id;
    const rows = await store.ncrs.aggregate<{ _id: string; n: number }>([{ $match: { orgId, status: "open" } }, { $group: { _id: "$reason", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    return c.json<NcrSummary>({ open: rows.reduce((s, x) => s + x.n, 0), byReason: rows.map((x) => ({ reason: x._id, count: x.n })) });
  });

  r.get("/ncrs/:id", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.ncrs.findOne({ _id: oid(c.req.valid("param").id), orgId });
    return doc ? c.json((await present(orgId, [doc]))[0]) : c.json({ error: "Not found" }, 404);
  });

  /** Anyone can stop something being used. Only an admin decides what happens to it. */
  r.post("/holds", zValidator("json", holdInputSchema), async (c) => {
    const org = c.get("org");
    const input = c.req.valid("json");
    const reason = matchReason(holdReasonsOf(org), input.reason);
    if (!reason) return c.json({ error: "Pick a reason from the list" }, 400);
    const res = await openHold(store, org._id, actorOf(c.get("user")), {
      reason, note: input.note, source: "manual", unitId: input.unitId, itemId: input.itemId, locationId: input.locationId, quantity: input.quantity, supplierLot: input.supplierLot,
    });
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json((await present(org._id, [res.ncr]))[0], 201);
  });

  r.post("/ncrs/:id/dispose", requireRole("admin"), zValidator("param", idParam), zValidator("json", disposeInputSchema), async (c) => {
    const org = c.get("org");
    const orgId = org._id;
    const input = c.req.valid("json");
    const ncr = await store.ncrs.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!ncr) return c.json({ error: "Not found" }, 404);
    if (ncr.status !== "open") return c.json({ error: `${ncr.number} is already closed` }, 409);
    const scrapReason = input.type === "scrap" ? matchReason(scrapReasonsOf(org), input.reason) : null;
    if (input.type === "scrap" && !scrapReason) return c.json({ error: "Pick a scrap reason from the list" }, 400);
    const q = ncr.unitId ? ncr.remaining : (input.quantity ?? ncr.remaining);
    if (ncr.unitId && input.quantity !== undefined && input.quantity !== ncr.remaining) return c.json({ error: `A labelled unit is decided whole: all ${ncr.remaining}` }, 422);
    if (q > ncr.remaining) return c.json({ error: `Only ${ncr.remaining} is left on hold` }, 422);
    let dest: LocationDoc | null = null;
    if (input.type === "use" || input.type === "rework") {
      dest = await store.locations.findOne({ _id: input.toLocationId ? oid(input.toLocationId) : ncr.fromLocationId, orgId });
      if (!dest) return c.json({ error: "Location not found" }, 404);
      if (dest.type === "quarantine") return c.json({ error: "Pick a place outside the hold area" }, 422);
    }

    // Claim the quantity first so two people deciding at once can't both take it.
    const claimed = await store.ncrs.findOneAndUpdate({ _id: ncr._id, orgId, status: "open", remaining: { $gte: q } }, { $inc: { remaining: -q } }, { returnDocument: "after" });
    if (!claimed) return c.json({ error: "Someone else just decided this. Reload it." }, 409);
    const giveBack = () => store.ncrs.updateOne({ _id: ncr._id }, { $inc: { remaining: q } });
    const actor: Actor = actorOf(c.get("user"));
    const group = new ObjectId();
    const movementIds: ObjectId[] = [];
    const label = `${ncr.number}`;
    const reasonCode = scrapReason ?? undefined;
    let revert: (() => Promise<unknown>) | null = null;

    try {
      if (ncr.unitId) {
        const unit = await store.units.findOne({ _id: ncr.unitId, orgId });
        if (!unit || unit.status !== "quarantined") { await giveBack(); return c.json({ error: "That unit is no longer on hold" }, 409); }
        if (input.type === "use" || input.type === "rework") {
          await store.units.updateOne({ _id: unit._id }, { $set: { status: "available", updatedAt: new Date() } });
          revert = () => store.units.updateOne({ _id: unit._id }, { $set: { status: "quarantined" } });
          if (dest && !dest._id.equals(unit.locationId)) {
            const mv = await moveUnit(store, orgId, actor, unit._id, dest._id, `Released from ${label}`, { type: "transfer", ncrId: ncr._id, transferId: group, viaQuality: true });
            if (!mv.ok) { await revert(); await giveBack(); return c.json({ error: mv.error }, mv.status); }
            movementIds.push(...mv.movementIds);
          }
        } else {
          const res = await adjustUnit(store, orgId, actor, unit._id, -unit.quantity, input.type === "scrap" ? `Scrapped (${label}): ${scrapReason}` : `Returned to supplier (${label})`, {
            type: input.type === "scrap" ? "scrap" : "adjust", ncrId: ncr._id, transferId: group, viaQuality: true, ...(reasonCode ? { reasonCode } : {}),
          });
          if (!res.ok) { await giveBack(); return c.json({ error: res.error }, res.status); }
          movementIds.push(...res.movementIds);
        }
      } else {
        const held = ncr.heldLocationId;
        if ((await changeStock(store, orgId, ncr.itemId, held, -q)) === null) { await giveBack(); return c.json({ error: "That stock is no longer in the hold area" }, 409); }
        const common = { orgId, itemId: ncr.itemId, transferId: group, ncrId: ncr._id, ...(ncr.supplierLot ? { supplierLot: ncr.supplierLot } : {}), actor };
        if (dest) {
          await changeStock(store, orgId, ncr.itemId, dest._id, q);
          const note = `Released from ${label} (${input.type})`;
          movementIds.push(await logMovement(store, { ...common, type: "transfer", locationId: held, delta: -q, reason: note }));
          movementIds.push(await logMovement(store, { ...common, type: "transfer", locationId: dest._id, delta: q, reason: note }));
        } else {
          movementIds.push(await logMovement(store, {
            ...common, type: input.type === "scrap" ? "scrap" : "adjust", locationId: held, delta: -q,
            reason: input.type === "scrap" ? `Scrapped (${label}): ${scrapReason}` : `Returned to supplier (${label})`, ...(reasonCode ? { reasonCode } : {}),
          }));
        }
      }
    } catch (e) {
      await giveBack();
      throw e;
    }

    const me = c.get("user");
    const set: Partial<NcrDoc> = claimed.remaining === 0 ? { status: "closed", closedAt: new Date() } : {};
    const updated = await store.ncrs.findOneAndUpdate(
      { _id: ncr._id },
      {
        $push: { dispositions: { type: input.type, quantity: q, ...(dest ? { toLocationId: dest._id } : {}), reason: scrapReason ?? "", note: input.note, by: { id: oid(me.id), name: me.name }, at: new Date() } },
        ...(Object.keys(set).length ? { $set: set } : {}),
      },
      { returnDocument: "after" },
    );
    await recordAudit(store, {
      orgId, actor: auditActor(me), action: "ncr.dispositioned", entity: { type: "ncr", id: ncr._id.toHexString(), label: ncr.number },
      summary: `${label}: ${input.type} ${q.toLocaleString("en-US")}${ncr.unitCode ? ` (${ncr.unitCode})` : ""}${scrapReason ? `, reason ${scrapReason}` : ""}${claimed.remaining === 0 ? ". Closed" : `. ${claimed.remaining.toLocaleString("en-US")} still on hold`}`,
      snapshot: { type: input.type, quantity: q, reason: scrapReason ?? "", note: input.note, toLocation: dest?.name ?? null },
      refs: { movementIds: movementIds.map(String) },
    });
    return c.json((await present(orgId, [updated!]))[0]);
  });

  return r;
}
