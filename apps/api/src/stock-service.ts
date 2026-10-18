import { ObjectId } from "mongodb";
import type { MovementType } from "@invintel/shared";
import { itemEntity, recordAudit } from "./audit.js";
import { isDuplicateKey, type MovementDoc, type Store } from "./db.js";

export const UNIT_TRACKED = "This item is tracked by unit (rolls, pallets). Receive, move or adjust the individual units instead.";

export interface Actor {
  userId: ObjectId;
  userName: string;
}

/** Stock in a quality hold area is managed from Quality, not by ordinary moves and adjustments. */
export const ON_HOLD_AREA = "That place is for stock on quality hold. Use Quality to hold or release stock.";

export type Failure = { ok: false; status: 404 | 409 | 422; error: string };
export type Posted = { ok: true; movementIds: ObjectId[] };

/**
 * Moves a stock row by `delta`. Removals are guarded in the filter so concurrent requests can't
 * take more than is there. Returns the new quantity, or null if there wasn't enough.
 */
export async function changeStock(
  store: Store,
  orgId: ObjectId,
  itemId: ObjectId,
  locationId: ObjectId,
  delta: number,
): Promise<number | null> {
  const update = { $inc: { quantity: delta }, $set: { updatedAt: new Date() } };
  if (delta < 0) {
    const row = await store.stock.findOneAndUpdate(
      { orgId, itemId, locationId, quantity: { $gte: -delta } },
      update,
      { returnDocument: "after" },
    );
    return row ? row.quantity : null;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await store.stock.findOneAndUpdate({ orgId, itemId, locationId }, update, {
        upsert: true,
        returnDocument: "after",
      });
      return row!.quantity;
    } catch (e) {
      // Two first-time adds racing to create the same row: the loser retries as a plain update.
      if (!isDuplicateKey(e) || attempt >= 2) throw e;
    }
  }
}

async function logMovement(
  store: Store,
  m: Omit<MovementDoc, "_id" | "createdAt" | "userName" | "userId"> & { actor: Actor; id?: ObjectId },
) {
  const { actor, id, ...rest } = m;
  const _id = id ?? new ObjectId();
  await store.movements.insertOne({
    ...rest,
    _id,
    userId: actor.userId,
    userName: actor.userName,
    createdAt: new Date(),
  });
  return _id;
}

export const quantityAt = async (store: Store, orgId: ObjectId, itemId: ObjectId, locationId: ObjectId) =>
  (await store.stock.findOne({ orgId, itemId, locationId }))?.quantity ?? 0;

/** Adds or removes stock at one location and records it. */
export async function postAdjustment(
  store: Store,
  orgId: ObjectId,
  actor: Actor,
  input: { itemId: ObjectId; locationId: ObjectId; delta: number; reason: string; type: Extract<MovementType, "adjust" | "receive">; supplierLot?: string; expiresOn?: string; sscc?: string; batchId?: ObjectId },
): Promise<Posted | Failure> {
  const { itemId, locationId, delta, reason, type, supplierLot, expiresOn, sscc, batchId } = input;
  const item = await store.items.findOne({ _id: itemId, orgId }, { projection: { name: 1, sku: 1, tracking: 1 } });
  if (!item) return { ok: false, status: 404, error: "Item not found" };
  if (item.tracking === "unit") return { ok: false, status: 409, error: UNIT_TRACKED };
  const location = await store.locations.findOne({ _id: locationId, orgId });
  if (!location) return { ok: false, status: 404, error: "Location not found" };
  if (location.type === "quarantine") return { ok: false, status: 409, error: ON_HOLD_AREA };

  if ((await changeStock(store, orgId, itemId, locationId, delta)) === null) {
    const have = await quantityAt(store, orgId, itemId, locationId);
    return { ok: false, status: 422, error: `Only ${have} in stock at ${location.name}` };
  }
  const id = await logMovement(store, { orgId, type, itemId, locationId, delta, reason, actor, ...(supplierLot ? { supplierLot } : {}), ...(expiresOn ? { expiresOn } : {}), ...(sscc ? { sscc } : {}), ...(batchId ? { batchId } : {}) });
  const amount = Math.abs(delta).toLocaleString("en-US");
  // "Received: PO 9" reads better as "Received 10 × X at Y (PO 9)".
  const detail = type === "receive" ? reason.replace(/^Received:?\s*/, "") : reason;
  const note = detail ? ` (${detail})` : "";
  await recordAudit(store, {
    orgId,
    actor: { id: actor.userId, name: actor.userName },
    action: type === "receive" ? "stock.received" : "stock.adjusted",
    entity: itemEntity(itemId, item),
    summary:
      type === "receive"
        ? `Received ${amount} × ${item.name} at ${location.name}${note}`
        : `${delta > 0 ? "Added" : "Removed"} ${amount} × ${item.name} at ${location.name}${note}`,
    snapshot: { delta, location: location.name, locationId: locationId.toHexString(), reason },
    refs: { movementIds: [id.toHexString()], itemId: itemId.toHexString(), locationId: locationId.toHexString() },
  });
  return { ok: true, movementIds: [id] };
}

/** Moves stock between two locations as a pair of linked movements. */
export async function postMove(
  store: Store,
  orgId: ObjectId,
  actor: Actor,
  input: { itemId: ObjectId; fromLocationId: ObjectId; toLocationId: ObjectId; quantity: number; reason: string; batchId?: ObjectId },
): Promise<Posted | Failure> {
  const { itemId, fromLocationId: from, toLocationId: to, quantity, reason, batchId } = input;
  const item = await store.items.findOne({ _id: itemId, orgId }, { projection: { name: 1, sku: 1, tracking: 1 } });
  if (!item) return { ok: false, status: 404, error: "Item not found" };
  if (item.tracking === "unit") return { ok: false, status: 409, error: UNIT_TRACKED };
  const [fromLoc, toLoc] = await Promise.all([
    store.locations.findOne({ _id: from, orgId }),
    store.locations.findOne({ _id: to, orgId }),
  ]);
  if (!fromLoc || !toLoc) return { ok: false, status: 404, error: "Location not found" };
  if (fromLoc.type === "quarantine" || toLoc.type === "quarantine") return { ok: false, status: 409, error: ON_HOLD_AREA };

  if ((await changeStock(store, orgId, itemId, from, -quantity)) === null) {
    const have = await quantityAt(store, orgId, itemId, from);
    return { ok: false, status: 422, error: `Only ${have} in stock at ${fromLoc.name}` };
  }
  try {
    await changeStock(store, orgId, itemId, to, quantity);
  } catch (e) {
    await changeStock(store, orgId, itemId, from, quantity); // put it back
    throw e;
  }
  const transferId = new ObjectId();
  const note = reason || `Transfer ${fromLoc.name} → ${toLoc.name}`;
  const out = await logMovement(store, { orgId, type: "transfer", itemId, locationId: from, delta: -quantity, reason: note, transferId, actor, ...(batchId ? { batchId } : {}) });
  const into = await logMovement(store, { orgId, type: "transfer", itemId, locationId: to, delta: quantity, reason: note, transferId, actor, ...(batchId ? { batchId } : {}) });
  await recordAudit(store, {
    orgId,
    actor: { id: actor.userId, name: actor.userName },
    action: "stock.moved",
    entity: itemEntity(itemId, item),
    summary: `Moved ${quantity.toLocaleString("en-US")} × ${item.name} from ${fromLoc.name} to ${toLoc.name}${reason ? ` (${reason})` : ""}`,
    snapshot: { quantity, from: fromLoc.name, to: toLoc.name, fromId: from.toHexString(), toId: to.toHexString(), reason: note },
    refs: { movementIds: [out.toHexString(), into.toHexString()], itemId: itemId.toHexString(), transferId: transferId.toHexString() },
  });
  return { ok: true, movementIds: [out, into] };
}

export { logMovement };
