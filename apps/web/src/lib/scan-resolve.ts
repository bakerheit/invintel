import { scanKind, uomOf, type Gs1Label, type Item, type Location, type LookupResult, type StockUnit } from "@invintel/shared";
import { api } from "@/lib/api";
import type { ScanFacts } from "@/lib/scan-session";

/** What one scan turned out to be, in the terms the multi-scan screens work in. */
export type Scanned =
  | { kind: "error"; error: string; unknownCode?: string }
  /** An item, with whatever a GS1 label added (lot, expiry, count, pallet). A plain barcode adds nothing. */
  | { kind: "item"; item: Item; facts: ScanFacts; label?: Gs1Label }
  /** A pallet label that names no product (an SSCC alone): keep the number for the next item scanned. */
  | { kind: "pallet"; sscc: string }
  | { kind: "location"; location: Location }
  | { kind: "unit"; unit: StockUnit };

/**
 * Turns whatever the scanner (or a person) entered into an item, place or roll. A GS1 label is read for its product,
 * lot, expiry and count; a label that is plainly GS1 but doesn't read is refused with the reason, never looked up as if
 * it were a SKU. A bare string of digits that happens to read as a label is used as a label only when nothing in the
 * system has that exact code.
 */
export async function interpretScan(orgId: string, code: string): Promise<Scanned> {
  const kind = scanKind(code);
  if (kind.kind === "bad") return { kind: "error", error: kind.error };

  const asScanned = (found: LookupResult): Scanned => {
    if (found.kind === "none") return { kind: "error", error: `Nothing matches "${code}"`, unknownCode: code };
    if (found.kind === "item") return { kind: "item", item: found.item, facts: {} };
    if (found.kind === "location") return { kind: "location", location: found.location };
    return { kind: "unit", unit: found.unit };
  };
  if (kind.kind === "plain") return asScanned(await api.lookup(orgId, code));

  if (kind.kind === "bare") {
    // Something in the system with exactly this code wins.
    const exact = await api.lookup(orgId, code);
    if (exact.kind !== "none") return asScanned(exact);
  }

  const label = kind.label;
  if (!label.gtin) {
    if (label.sscc) return { kind: "pallet", sscc: label.sscc };
    return { kind: "error", error: "That label has no product on it. Scan the item's own barcode." };
  }
  const found = await api.lookup(orgId, label.gtin);
  if (found.kind !== "item") return { kind: "error", error: `No item has the product code ${label.gtin}. Add it, or scan its SKU.`, unknownCode: label.gtin };
  const item = found.item;
  const facts: ScanFacts = {};
  if (label.lot) facts.lot = label.lot;
  if (label.expiry) facts.expiresOn = label.expiry;
  if (label.sscc) facts.sscc = label.sscc;
  // A label's count is a count of whole trade items; it only means something for items counted in whole units.
  if (label.quantity !== undefined && uomOf(item).decimals === 0) facts.qty = label.quantity;
  return { kind: "item", item, facts, label };
}
