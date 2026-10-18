import { LOCATION_TYPES, type AttentionItem, type LocationType, type Overview } from "@invintel/shared";
import { Hono } from "hono";
import type { Store } from "./db.js";
import { loadItems } from "./item-queries.js";
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
      units += quantity;
      valueCents += quantity * item.unitCostCents;
      for (const s of item.stock) {
        const t = totals.get(typeOf.get(s.locationId.toHexString()) ?? "storage")!;
        t.units += s.quantity;
        t.valueCents += s.quantity * item.unitCostCents;
      }
      const status = quantity <= 0 ? "out" : item.reorderLevel > 0 && quantity <= item.reorderLevel ? "low" : null;
      if (status) {
        attention.push({
          id: item._id.toHexString(),
          sku: item.sku,
          name: item.name,
          quantity,
          reorderLevel: item.reorderLevel,
          status,
          // Sort key: how far down the reorder level it is. Out of stock is 0.
          ratio: item.reorderLevel > 0 ? quantity / item.reorderLevel : quantity,
        });
      }
    }
    attention.sort((a, b) => a.ratio - b.ratio || a.name.localeCompare(b.name, "en"));

    const overview: Overview = {
      items: items.length,
      locations: locations.length,
      units,
      valueCents,
      outCount: attention.filter((a) => a.status === "out").length,
      lowCount: attention.filter((a) => a.status === "low").length,
      attention: attention.slice(0, ATTENTION_LIMIT).map(({ ratio: _ratio, ...rest }) => rest),
      byType: LOCATION_TYPES.map((type) => ({ type, ...totals.get(type)! })),
      movements24h,
      awaitingPutaway: totals.get("receiving")!.units,
    };
    return c.json(overview);
  });

  return r;
}
