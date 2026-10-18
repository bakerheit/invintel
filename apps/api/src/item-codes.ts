import { gtinVariants } from "@invintel/shared";
import type { ObjectId } from "mongodb";
import type { ItemDoc, Store } from "./db.js";

const ci = { locale: "en", strength: 2 } as const;

export interface CodeConflict {
  code: string;
  item: Pick<ItemDoc, "name" | "sku">;
}

/**
 * Finds another item that already answers to one of these codes, so a scan never has two
 * possible meanings. UPC-A, EAN-13 and GTIN-14 forms of the same number count as the same code.
 * `against` says whether to look at other items' SKUs, their barcodes, or both.
 */
export async function findCodeConflict(
  store: Store,
  orgId: ObjectId,
  codes: string[],
  options: { selfId?: ObjectId; against: ("sku" | "barcodes")[] },
): Promise<CodeConflict | null> {
  for (const code of codes) {
    const variants = gtinVariants(code);
    const item = await store.items.findOne(
      {
        orgId,
        ...(options.selfId ? { _id: { $ne: options.selfId } } : {}),
        $or: options.against.map((field) => ({ [field]: { $in: variants } })),
      },
      { collation: ci, projection: { name: 1, sku: 1 } },
    );
    if (item) return { code, item };
  }
  return null;
}

export const conflictMessage = (c: CodeConflict, what: "Barcode" | "SKU") =>
  `${what} "${c.code}" is already used by ${c.item.name} (${c.item.sku})`;
