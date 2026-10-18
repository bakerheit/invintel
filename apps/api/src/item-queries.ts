import { uomOf, type Item } from "@invintel/shared";
import type { ObjectId } from "mongodb";
import type { ItemDoc, StockDoc, Store } from "./db.js";
import { onHoldByItem, reservedByItem } from "./sales-core.js";

/** `reserved` and `onHold` are filled in by loadItems (INV-15): what sales orders have promised, and what sits on quality hold. */
export type ItemWithStock = ItemDoc & { stock: StockDoc[]; reserved?: number; onHold?: number };

const byName = { locale: "en" } as const;

export const toItem = ({ _id, orgId: _orgId, stock, reserved = 0, onHold = 0, createdAt, updatedAt, ...rest }: ItemWithStock): Item => ({
  id: _id.toHexString(),
  ...rest,
  barcodes: rest.barcodes ?? [],
  tracking: rest.tracking ?? "quantity",
  ...uomOf(rest),
  altUnits: rest.altUnits ?? [],
  quantity: stock.reduce((sum, s) => sum + s.quantity, 0),
  stock: stock.map((s) => ({ locationId: s.locationId.toHexString(), quantity: s.quantity })),
  reserved,
  available: stock.reduce((sum, s) => sum + s.quantity, 0) - onHold - reserved,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

/** Items with their per-location stock attached. Pass `itemId` for one item. */
export const loadItems = async (store: Store, orgId: ObjectId, itemId?: ObjectId): Promise<ItemWithStock[]> => {
  const [items, reserved, onHold] = await Promise.all([loadItemsRaw(store, orgId, itemId), reservedByItem(store, orgId), onHoldByItem(store, orgId)]);
  return items.map((i) => ({ ...i, reserved: reserved.get(i._id.toHexString()) ?? 0, onHold: onHold.get(i._id.toHexString()) ?? 0 }));
};

const loadItemsRaw = (store: Store, orgId: ObjectId, itemId?: ObjectId) =>
  store.items
    .aggregate<ItemWithStock>(
      [
        { $match: itemId ? { orgId, _id: itemId } : { orgId } },
        { $sort: { name: 1 } },
        {
          $lookup: {
            from: "stock",
            localField: "_id",
            foreignField: "itemId",
            pipeline: [{ $match: { quantity: { $gt: 0 } } }],
            as: "stock",
          },
        },
      ],
      { collation: byName },
    )
    .toArray();

export const loadItem = async (store: Store, orgId: ObjectId, itemId: ObjectId) =>
  (await loadItems(store, orgId, itemId))[0];
