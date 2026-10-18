import { ObjectId } from "mongodb";
import type { MovementType } from "@invintel/shared";
import { isDuplicateKey, type MovementDoc, type Store } from "./db.js";

export interface Actor {
  userId: ObjectId;
  userName: string;
}

export type Failure = { ok: false; status: 404 | 422; error: string };
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
  input: { itemId: ObjectId; locationId: ObjectId; delta: number; reason: string; type: Extract<MovementType, "adjust" | "receive"> },
): Promise<Posted | Failure> {
  const { itemId, locationId, delta, reason, type } = input;
  if (!(await store.items.findOne({ _id: itemId, orgId }, { projection: { _id: 1 } }))) {
    return { ok: false, status: 404, error: "Item not found" };
  }
  const location = await store.locations.findOne({ _id: locationId, orgId });
  if (!location) return { ok: false, status: 404, error: "Location not found" };

  if ((await changeStock(store, orgId, itemId, locationId, delta)) === null) {
    const have = await quantityAt(store, orgId, itemId, locationId);
    return { ok: false, status: 422, error: `Only ${have} in stock at ${location.name}` };
  }
  const id = await logMovement(store, { orgId, type, itemId, locationId, delta, reason, actor });
  return { ok: true, movementIds: [id] };
}

/** Moves stock between two locations as a pair of linked movements. */
export async function postMove(
  store: Store,
  orgId: ObjectId,
  actor: Actor,
  input: { itemId: ObjectId; fromLocationId: ObjectId; toLocationId: ObjectId; quantity: number; reason: string },
): Promise<Posted | Failure> {
  const { itemId, fromLocationId: from, toLocationId: to, quantity, reason } = input;
  if (!(await store.items.findOne({ _id: itemId, orgId }, { projection: { _id: 1 } }))) {
    return { ok: false, status: 404, error: "Item not found" };
  }
  const [fromLoc, toLoc] = await Promise.all([
    store.locations.findOne({ _id: from, orgId }),
    store.locations.findOne({ _id: to, orgId }),
  ]);
  if (!fromLoc || !toLoc) return { ok: false, status: 404, error: "Location not found" };

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
  const out = await logMovement(store, { orgId, type: "transfer", itemId, locationId: from, delta: -quantity, reason: note, transferId, actor });
  const into = await logMovement(store, { orgId, type: "transfer", itemId, locationId: to, delta: quantity, reason: note, transferId, actor });
  return { ok: true, movementIds: [out, into] };
}

export { logMovement };
