import type { Item } from "@invintel/shared";

export type StockStatus = "ok" | "low" | "out";

/** Based on the item's total across locations. A reorder level of 0 means "don't track low stock". */
export const stockStatus = (item: Pick<Item, "quantity" | "reorderLevel">): StockStatus =>
  item.quantity <= 0 ? "out" : item.reorderLevel > 0 && item.quantity <= item.reorderLevel ? "low" : "ok";

export const needsAttention = (item: Pick<Item, "quantity" | "reorderLevel">) => stockStatus(item) !== "ok";
