import type { Item } from "@invintel/shared";
import type { ObjectId } from "mongodb";
import type { ItemDoc, StockDoc, Store } from "./db.js";

export type ItemWithStock = ItemDoc & { stock: StockDoc[] };

const byName = { locale: "en" } as const;

export const toItem = ({ _id, orgId: _orgId, stock, createdAt, updatedAt, ...rest }: ItemWithStock): Item => ({
  id: _id.toHexString(),
  ...rest,
  barcodes: rest.barcodes ?? [],
  quantity: stock.reduce((sum, s) => sum + s.quantity, 0),
  stock: stock.map((s) => ({ locationId: s.locationId.toHexString(), quantity: s.quantity })),
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

/** Items with their per-location stock attached. Pass `itemId` for one item. */
export const loadItems = (store: Store, orgId: ObjectId, itemId?: ObjectId) =>
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
