import { LOCATION_TYPES, lineValueCents, stockStatusOf, uomOf, type AttentionItem, type LocationType, type Overview } from "@invintel/shared";
import { Hono } from "hono";
import type { Store } from "./db.js";
import { loadItems, positionOf } from "./item-queries.js";
import type { OrgEnv } from "./org-access.js";

const ATTENTION_LIMIT = 10;

export function createOverviewRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", async (c) => {
    const orgId = c.get("org")._id;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [items, locations, movements24h] = await Promise.all([
      loadItems(store, orgId),
      store.locations.find({ orgId }).toArray(),
      store.movements.countDocuments({ orgId, createdAt: { $gte: since } }),
    ]);

    const typeOf = new Map(locations.map((l) => [l._id.toHexString(), (l.type ?? "storage") as LocationType]));
    const totals = new Map<LocationType, { locations: number; units: number; valueCents: number }>(
      LOCATION_TYPES.map((t) => [t, { locations: 0, units: 0, valueCents: 0 }]),
    );
    for (const l of locations) totals.get((l.type ?? "storage") as LocationType)!.locations++;

    let units = 0;
    let valueCents = 0;
    const attention: (AttentionItem & { ratio: number })[] = [];
    for (const item of items) {
      const quantity = item.stock.reduce((sum, s) => sum + s.quantity, 0);
      // "Units" adds up across items, so it is in display units: 12.5 kg counts as 12.5, not 12,500.
      const shown = (n: number) => n / 10 ** (item.decimals ?? 0);
      units += shown(quantity);
      valueCents += lineValueCents(quantity, item.unitCostCents, item.decimals ?? 0);
      for (const s of item.stock) {
        const t = totals.get(typeOf.get(s.locationId.toHexString()) ?? "storage")!;
        t.units += shown(s.quantity);
        t.valueCents += lineValueCents(s.quantity, item.unitCostCents, item.decimals ?? 0);
      }
      const pos = positionOf(item);
      const state = stockStatusOf(pos);
      const status = state === "ok" ? null : state;
      if (status) {
        attention.push({
          id: item._id.toHexString(),
          sku: item.sku,
          name: item.name,
          uom: uomOf(item),
          quantity,
          reserved: pos.reserved,
          available: pos.available,
          reorderLevel: item.reorderLevel,
          status,
          // Sort key: how far down the reorder level the free stock is. Out of stock sorts first; over-promised next.
          ratio: status === "out" ? -Infinity : item.reorderLevel > 0 ? pos.available / item.reorderLevel : pos.available,
        });
      }
    }
    attention.sort((a, b) => a.ratio - b.ratio || a.name.localeCompare(b.name, "en"));

    const overview: Overview = {
      items: items.length,
      locations: locations.length,
      units: Math.round(units),
      valueCents,
      outCount: attention.filter((a) => a.status === "out").length,
      lowCount: attention.filter((a) => a.status === "low").length,
      attention: attention.slice(0, ATTENTION_LIMIT).map(({ ratio: _ratio, ...rest }) => rest),
      byType: LOCATION_TYPES.map((type) => ({ type, ...totals.get(type)!, units: Math.round(totals.get(type)!.units) })),
      movements24h,
      awaitingPutaway: Math.round(totals.get("receiving")!.units),
    };
    return c.json(overview);
  });

  return r;
}
