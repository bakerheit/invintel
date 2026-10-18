import type { StockUnit } from "@invintel/shared";
import { ObjectId } from "mongodb";
import { itemEntity, recordAudit } from "./audit.js";
import { isDuplicateKey, type StockUnitDoc, type Store } from "./db.js";
import { findCodeConflict } from "./item-codes.js";
import { indexLocations, loadLocations } from "./locations.js";
import { changeStock, logMovement, type Actor, type Failure } from "./stock-service.js";

const ci = { locale: "en", strength: 2 } as const;

/** Next label number for this org: U-000001, U-000002, ... Never reused, even after units are consumed. */
async function nextCodes(store: Store, orgId: ObjectId, n: number): Promise<string[]> {
  const counter = await store.counters.findOneAndUpdate(
    { _id: `${orgId.toHexString()}:unit` },
    { $inc: { seq: n } },
    { upsert: true, returnDocument: "after" },
  );
  const last = counter!.seq;
  return Array.from({ length: n }, (_, i) => `U-${String(last - n + 1 + i).padStart(6, "0")}`);
}

/** Does any unit in this org already use one of these codes (ignoring case)? */
export const unitCodeTaken = async (store: Store, orgId: ObjectId, codes: string[]) =>
  codes.length ? store.units.findOne({ orgId, code: { $in: codes } }, { collation: ci, projection: { code: 1 } }) : null;

/** Turn unit documents into API shape, with item names and location paths attached. */
export async function presentUnits(store: Store, orgId: ObjectId, docs: StockUnitDoc[]): Promise<StockUnit[]> {
  const items = await store.items.find({ _id: { $in: [...new Set(docs.map((d) => d.itemId.toHexString()))].map((id) => new ObjectId(id)) } }, { projection: { sku: 1, name: 1 } }).toArray();
  const itemById = new Map(items.map((i) => [i._id.toHexString(), i]));
  const locations = indexLocations(await loadLocations(store, orgId));
  return docs.map((u) => ({
    id: u._id.toHexString(),
    code: u.code,
    itemId: u.itemId.toHexString(),
    itemSku: itemById.get(u.itemId.toHexString())?.sku ?? "",
    itemName: itemById.get(u.itemId.toHexString())?.name ?? "Deleted item",
    lot: u.lot,
    quantity: u.quantity,
    initialQuantity: u.initialQuantity,
    locationId: u.locationId.toHexString(),
    locationPath: locations.byId.has(u.locationId.toHexString()) ? locations.pathOf(u.locationId.toHexString()) : "Deleted location",
    status: u.status,
    createdAt: u.createdAt.toISOString(),
  }));
}

export type UnitsResult = { ok: true; units: StockUnitDoc[]; movementIds: ObjectId[] } | Failure;

const asAuditActor = (a: Actor) => ({ id: a.userId, name: a.userName });

/** Receive one or more identical units: creates each unit, adds its quantity to the stock rows, and ledgers it. */
export async function receiveUnits(
  store: Store,
  orgId: ObjectId,
  actor: Actor,
  input: { itemId: ObjectId; locationId: ObjectId; quantity: number; count: number; lot: string; codes?: string[]; reference: string },
): Promise<UnitsResult> {
  const item = await store.items.findOne({ _id: input.itemId, orgId }, { projection: { name: 1, sku: 1, tracking: 1 } });
  if (!item) return { ok: false, status: 404, error: "Item not found" };
  if (item.tracking !== "unit") return { ok: false, status: 409, error: `${item.name} isn't tracked by unit. Receive it by quantity instead.` };
  const location = await store.locations.findOne({ _id: input.locationId, orgId });
  if (!location) return { ok: false, status: 404, error: "Location not found" };

  const codes = input.codes?.length ? input.codes : await nextCodes(store, orgId, input.count);
  if (new Set(codes.map((c) => c.toLowerCase())).size !== codes.length) return { ok: false, status: 409, error: "Two of those labels have the same code" };
  const taken = await unitCodeTaken(store, orgId, codes);
  if (taken) return { ok: false, status: 409, error: `Label ${taken.code} is already on another unit` };
  const clash = await findCodeConflict(store, orgId, codes, { against: ["sku", "barcodes"] });
  if (clash) return { ok: false, status: 409, error: `Label ${clash.code} is already used by ${clash.item.name}` };

  const now = new Date();
  const docs: StockUnitDoc[] = codes.map((code) => ({
    _id: new ObjectId(),
    orgId,
    itemId: input.itemId,
    code,
    lot: input.lot,
    quantity: input.quantity,
    initialQuantity: input.quantity,
    locationId: input.locationId,
    status: "available",
    createdAt: now,
    updatedAt: now,
  }));
  try {
    await store.units.insertMany(docs);
  } catch (e) {
    if (isDuplicateKey(e)) return { ok: false, status: 409, error: "One of those labels is already in use" };
    throw e;
  }

  const movementIds: ObjectId[] = [];
  for (const u of docs) {
    await changeStock(store, orgId, input.itemId, input.locationId, input.quantity);
    movementIds.push(
      await logMovement(store, {
        orgId,
        type: "receive",
        itemId: input.itemId,
        locationId: input.locationId,
        unitId: u._id,
        unitCode: u.code,
        delta: input.quantity,
        reason: input.reference ? `Received: ${input.reference}` : "Received",
        actor,
      }),
    );
  }
  await recordAudit(store, {
    orgId,
    actor: asAuditActor(actor),
    action: "stock.received",
    entity: itemEntity(input.itemId, item),
    summary: `Received ${input.count} × ${input.quantity.toLocaleString("en-US")} of ${item.name} at ${location.name}${input.reference ? ` (${input.reference})` : ""}`,
    snapshot: { units: codes, quantityEach: input.quantity, lot: input.lot, location: location.name },
    refs: { movementIds: movementIds.map((m) => m.toHexString()), unitIds: docs.map((d) => d._id.toHexString()), itemId: input.itemId.toHexString() },
  });
  return { ok: true, units: docs, movementIds };
}

/** Move a whole unit to another location. */
export async function moveUnit(
  store: Store,
  orgId: ObjectId,
  actor: Actor,
  unitId: ObjectId,
  toLocationId: ObjectId,
  reason: string,
): Promise<UnitsResult> {
  const unit = await store.units.findOne({ _id: unitId, orgId });
  if (!unit) return { ok: false, status: 404, error: "Unit not found" };
  if (unit.status === "consumed") return { ok: false, status: 409, error: `${unit.code} has been used up` };
  if (unit.locationId.equals(toLocationId)) return { ok: false, status: 409, error: "It's already there" };
  const [to, from, item] = await Promise.all([
    store.locations.findOne({ _id: toLocationId, orgId }),
    store.locations.findOne({ _id: unit.locationId, orgId }),
    store.items.findOne({ _id: unit.itemId, orgId }, { projection: { name: 1, sku: 1 } }),
  ]);
  if (!to) return { ok: false, status: 404, error: "Location not found" };
  if (!item) return { ok: false, status: 409, error: "That unit's item was deleted" };

  // Claim the unit first: if two people move it at once, only one finds it still at `from`.
  const claimed = await store.units.findOneAndUpdate(
    { _id: unitId, orgId, locationId: unit.locationId, status: { $ne: "consumed" } },
    { $set: { locationId: toLocationId, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!claimed) return { ok: false, status: 409, error: "Someone else just moved or used that unit" };

  await changeStock(store, orgId, unit.itemId, unit.locationId, -claimed.quantity);
  await changeStock(store, orgId, unit.itemId, toLocationId, claimed.quantity);

  const transferId = new ObjectId();
  const note = reason || `Moved ${unit.code} ${from?.name ?? "?"} → ${to.name}`;
  const out = await logMovement(store, { orgId, type: "transfer", itemId: unit.itemId, locationId: unit.locationId, unitId, unitCode: unit.code, delta: -claimed.quantity, reason: note, transferId, actor });
  const into = await logMovement(store, { orgId, type: "transfer", itemId: unit.itemId, locationId: toLocationId, unitId, unitCode: unit.code, delta: claimed.quantity, reason: note, transferId, actor });
  await recordAudit(store, {
    orgId,
    actor: asAuditActor(actor),
    action: "stock.moved",
    entity: itemEntity(unit.itemId, item),
    summary: `Moved ${unit.code} (${claimed.quantity.toLocaleString("en-US")} × ${item.name}) from ${from?.name ?? "?"} to ${to.name}`,
    snapshot: { unit: unit.code, quantity: claimed.quantity, from: from?.name, to: to.name, reason: note },
    refs: { movementIds: [out.toHexString(), into.toHexString()], unitIds: [unitId.toHexString()], itemId: unit.itemId.toHexString(), transferId: transferId.toHexString() },
  });
  return { ok: true, units: [claimed], movementIds: [out, into] };
}

/**
 * Change what's left on a unit: use some of it (negative) or correct it upwards. At zero the unit
 * is marked consumed. `type` lets other flows (counts, production) tag the ledger entry.
 */
export async function adjustUnit(
  store: Store,
  orgId: ObjectId,
  actor: Actor,
  unitId: ObjectId,
  delta: number,
  reason: string,
  type: "adjust" | "receive" = "adjust",
): Promise<UnitsResult> {
  const unit = await store.units.findOne({ _id: unitId, orgId });
  if (!unit) return { ok: false, status: 404, error: "Unit not found" };
  if (unit.status === "consumed") return { ok: false, status: 409, error: `${unit.code} has been used up` };
  const item = await store.items.findOne({ _id: unit.itemId, orgId }, { projection: { name: 1, sku: 1 } });
  if (!item) return { ok: false, status: 409, error: "That unit's item was deleted" };

  // The guard is in the filter so two people taking from the same roll can't both take the last of it.
  const after = await store.units.findOneAndUpdate(
    { _id: unitId, orgId, status: { $ne: "consumed" }, ...(delta < 0 ? { quantity: { $gte: -delta } } : {}) },
    { $inc: { quantity: delta }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!after) {
    const now = await store.units.findOne({ _id: unitId, orgId });
    return { ok: false, status: 422, error: `Only ${now?.quantity ?? 0} left on ${unit.code}` };
  }
  let result = after;
  if (after.quantity === 0) {
    result = (await store.units.findOneAndUpdate({ _id: unitId }, { $set: { status: "consumed" } }, { returnDocument: "after" })) ?? after;
  }
  await changeStock(store, orgId, unit.itemId, unit.locationId, delta);
  const id = await logMovement(store, { orgId, type, itemId: unit.itemId, locationId: unit.locationId, unitId, unitCode: unit.code, delta, reason, actor });
  const location = await store.locations.findOne({ _id: unit.locationId });
  await recordAudit(store, {
    orgId,
    actor: asAuditActor(actor),
    action: "stock.adjusted",
    entity: itemEntity(unit.itemId, item),
    summary: `${delta > 0 ? "Added" : "Took"} ${Math.abs(delta).toLocaleString("en-US")} ${delta > 0 ? "to" : "from"} ${unit.code} (${item.name}) at ${location?.name ?? "?"}${reason ? ` (${reason})` : ""}${result.status === "consumed" ? ". Now used up" : ""}`,
    snapshot: { unit: unit.code, delta, remaining: result.quantity, reason },
    refs: { movementIds: [id.toHexString()], unitIds: [unitId.toHexString()], itemId: unit.itemId.toHexString() },
  });
  return { ok: true, units: [result], movementIds: [id] };
}
