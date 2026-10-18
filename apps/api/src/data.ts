import { formatQty, uomOf } from "@invintel/shared";
import { Hono } from "hono";
import { csvText } from "./csv.js";
import type { Store } from "./db.js";
import { createArchiveRoutes } from "./archive.js";
import { createImportRoutes } from "./item-import.js";
import { loadItems } from "./item-queries.js";
import { indexLocations, loadLocations } from "./locations.js";
import type { OrgEnv } from "./org-access.js";

export function createDataRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  /** One row per item and location, in the same shape the importer reads. */
  r.get("/items.csv", async (c) => {
    const orgId = c.get("org")._id;
    const [items, locations] = await Promise.all([loadItems(store, orgId), loadLocations(store, orgId)]);
    const idx = indexLocations(locations);
    const label = (id: string) => {
      const l = idx.byId.get(id);
      return l ? (l.code ? l.code : idx.pathOf(id)) : "";
    };
    const lines = ["sku,name,category,description,reorder_level,unit_cost,barcodes,location,quantity,unit,decimals"];
    for (const i of items) {
      // Quantities go out as people read them (12.500), with the unit and decimals in their own columns so a re-import reads them back exactly.
      const uom = uomOf(i);
      const plain = (n: number) => formatQty(n, uom, { unit: false, group: false });
      const base = [
        csvText(i.sku), csvText(i.name), csvText(i.category), csvText(i.description),
        plain(i.reorderLevel), (i.unitCostCents / 100).toFixed(2), csvText((i.barcodes ?? []).join("|")),
      ];
      const rows = i.stock.length ? i.stock : [null];
      for (const s of rows) {
        lines.push([...base, s ? csvText(label(s.locationId.toHexString())) : "", s ? plain(s.quantity) : "", csvText(uom.unit), String(uom.decimals)].join(","));
      }
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="invintel-items-${new Date().toISOString().slice(0, 10)}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${lines.join("\r\n")}\r\n`);
  });

  // Import v2 (column mapping, update mode, undo) lives in item-import.ts.
  r.route("/", createImportRoutes(store));
  // Full archive: download everything, restore into an empty organization (archive.ts).
  r.route("/", createArchiveRoutes(store));

  return r;
}
