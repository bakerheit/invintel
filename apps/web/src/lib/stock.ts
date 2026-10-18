import { positionOfItem, stockStatusOf, type Item, type StockStatus } from "@invintel/shared";

export type { StockStatus };
type Basis = Pick<Item, "quantity" | "reorderLevel" | "reserved" | "available">;

/**
 * Judged on what is free to promise (INV-16), not on what is physically there: stock that is promised to a customer or on quality
 * hold isn't stock you have. A reorder level of 0 means "don't track low stock", but being promised more than there is always counts.
 */
export const stockStatus = (item: Basis): StockStatus => stockStatusOf(positionOfItem(item));

export const needsAttention = (item: Basis) => stockStatus(item) !== "ok";
