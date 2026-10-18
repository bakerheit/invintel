import type { ObjectId } from "mongodb";
import type { Store } from "./db.js";

/**
 * True if any quantity anywhere refers to this item: stock, rolls, ledger, orders, recipes,
 * work orders, counts or waiting approvals. Used to decide whether its decimal places can change.
 */
export async function itemHasQuantities(store: Store, orgId: ObjectId, itemId: ObjectId): Promise<boolean> {
  const hits = await Promise.all([
    store.movements.findOne({ itemId }, { projection: { _id: 1 } }),
    store.stock.findOne({ itemId }, { projection: { _id: 1 } }),
    store.units.findOne({ itemId }, { projection: { _id: 1 } }),
    store.purchaseOrders.findOne({ orgId, "lines.itemId": itemId }, { projection: { _id: 1 } }),
    store.boms.findOne({ orgId, $or: [{ outputItemId: itemId }, { "inputs.itemId": itemId }] }, { projection: { _id: 1 } }),
    store.workOrders.findOne({ orgId, $or: [{ outputItemId: itemId }, { "requirements.itemId": itemId }] }, { projection: { _id: 1 } }),
    store.counts.findOne({ orgId, "lines.itemId": itemId }, { projection: { _id: 1 } }),
    store.approvals.findOne({ orgId, "payload.itemId": itemId }, { projection: { _id: 1 } }),
  ]);
  return hits.some(Boolean);
}
