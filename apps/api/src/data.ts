import { zValidator } from "@hono/zod-validator";
import { importInputSchema, itemInputSchema, type ImportResult, type ImportRow } from "@invintel/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ObjectId } from "mongodb";
import { auditActor, itemEntity, recordAudit } from "./audit.js";
import { csvNumber, csvText, parseCsv } from "./csv.js";
import type { ItemDoc, LocationDoc, Store } from "./db.js";
import { conflictMessage, findCodeConflict } from "./item-codes.js";
import { loadItems } from "./item-queries.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { postAdjustment } from "./stock-service.js";

const MAX_ROWS = 5000;

/** Header names people actually use, mapped to our columns. */
const ALIASES: Record<string, string> = {
  sku: "sku", "item code": "sku", "part number": "sku", "part no": "sku", code: "sku",
  name: "name", item: "name", description: "name", "item name": "name",
  category: "category", group: "category", type: "category",
  notes: "description", details: "description",
  "reorder level": "reorder", "reorder point": "reorder", reorder: "reorder", "min stock": "reorder", min: "reorder",
  "unit cost": "cost", cost: "cost", price: "cost", "unit price": "cost",
  barcodes: "barcodes", barcode: "barcodes", upc: "barcodes", ean: "barcodes",
  location: "location", "location code": "location", bin: "location",
  quantity: "quantity", qty: "quantity", "on hand": "quantity", stock: "quantity",
};
const norm = (h: string) => h.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");

const toCents = (raw: string): number | null => {
  const t = raw.replace(/[$,\s]/g, "");
  if (t === "") return 0;
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

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
    const lines = ["sku,name,category,description,reorder_level,unit_cost,barcodes,location,quantity"];
    for (const i of items) {
      const base = [
        csvText(i.sku), csvText(i.name), csvText(i.category), csvText(i.description),
        csvNumber(i.reorderLevel), (i.unitCostCents / 100).toFixed(2), csvText((i.barcodes ?? []).join("|")),
      ];
      const rows = i.stock.length ? i.stock : [null];
      for (const s of rows) {
        lines.push([...base, s ? csvText(label(s.locationId.toHexString())) : "", s ? csvNumber(s.quantity) : ""].join(","));
      }
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="invintel-items-${new Date().toISOString().slice(0, 10)}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${lines.join("\r\n")}\r\n`);
  });

  /**
   * Creates new items (and their opening stock) from a spreadsheet. Existing SKUs are never changed, so running the
   * same file twice can't double anything. Rows that repeat a SKU add stock at another location. Send dryRun first.
   */
  r.post("/items/import", requireRole("admin"), bodyLimit({ maxSize: 3 * 1024 * 1024, onError: (c) => c.json({ error: "That file is too big. Split it into smaller files." }, 413) }), zValidator("json", importInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { csv, dryRun } = c.req.valid("json");
    const table = parseCsv(csv);
    const fail = (msg: string) => c.json({ error: msg }, 400);
    if (table.length < 2) return fail("The file needs a header row and at least one item.");
    if (table.length - 1 > MAX_ROWS) return fail(`Import at most ${MAX_ROWS} rows at a time.`);

    const cols = new Map<string, number>();
    table[0]!.forEach((h, i) => {
      const key = ALIASES[norm(h)];
      if (key && !cols.has(key)) cols.set(key, i);
    });
    if (!cols.has("sku") || !cols.has("name")) return fail("Needs a SKU column and a name column in the first row.");
    const cell = (row: string[], key: string) => (cols.has(key) ? (row[cols.get(key)!] ?? "").trim() : "");

    const locations = await loadLocations(store, orgId);
    const idx = indexLocations(locations);
    const byKey = new Map<string, LocationDoc[]>();
    const add = (k: string, l: LocationDoc) => {
      const key = k.trim().toLowerCase();
      if (key) byKey.set(key, [...(byKey.get(key) ?? []), l]);
    };
    for (const l of locations) {
      add(l.code ?? "", l);
      add(idx.pathOf(l._id.toHexString()), l);
      add(l.name, l);
    }
    const findLocation = (text: string): LocationDoc | string => {
      const hits = [...new Set(byKey.get(text.trim().toLowerCase()) ?? [])];
      if (hits.length === 1) return hits[0]!;
      return hits.length ? `"${text}" matches ${hits.length} locations: use its code or full path` : `No location called "${text}"`;
    };

    const existing = new Set((await store.items.find({ orgId }, { projection: { sku: 1 }, collation: { locale: "en", strength: 2 } }).toArray()).map((i) => i.sku.toLowerCase()));
    const rows: ImportRow[] = [];
    type Plan = { input: ReturnType<typeof itemInputSchema.parse>; stock: { location: LocationDoc; quantity: number }[]; line: number };
    const plans = new Map<string, Plan>();
    const skipped = new Set<string>();

    for (let n = 1; n < table.length; n++) {
      const row = table[n]!;
      const line = n + 1;
      const sku = cell(row, "sku");
      const err = (message: string) => rows.push({ line, sku, status: "error", message });
      if (row.every((x) => !x.trim())) continue;
      if (!sku) { err("Missing SKU"); continue; }
      const key = sku.toLowerCase();

      // Stock part (optional)
      let stock: { location: LocationDoc; quantity: number } | null = null;
      const qtyText = cell(row, "quantity");
      const locText = cell(row, "location");
      const qty = qtyText === "" ? 0 : /^\d+$/.test(qtyText) ? Number(qtyText) : Number.NaN;
      if (Number.isNaN(qty)) { err(`Quantity "${qtyText}" must be a whole number`); continue; }
      if (qty > 0) {
        if (!locText) { err("A quantity needs a location"); continue; }
        const loc = findLocation(locText);
        if (typeof loc === "string") { err(loc); continue; }
        stock = { location: loc, quantity: qty };
      }

      if (existing.has(key)) {
        if (!skipped.has(key)) rows.push({ line, sku, status: "skip", message: "Already exists, left as it is" });
        skipped.add(key);
        continue;
      }
      const plan = plans.get(key);
      if (plan) { // another stock line for an item defined earlier in the file
        if (stock) {
          plan.stock.push(stock);
          rows.push({ line, sku, status: "stock", message: `Adds ${stock.quantity.toLocaleString("en-US")} at ${idx.pathOf(stock.location._id.toHexString())}` });
        } else rows.push({ line, sku, status: "skip", message: "Repeats an item defined above" });
        continue;
      }

      const cost = toCents(cell(row, "cost"));
      const reorderText = cell(row, "reorder");
      if (cost === null) { err(`Unit cost "${cell(row, "cost")}" isn't a number`); continue; }
      if (reorderText && !/^\d+$/.test(reorderText)) { err(`Reorder level "${reorderText}" must be a whole number`); continue; }
      const parsed = itemInputSchema.safeParse({
        sku, name: cell(row, "name"), category: cell(row, "category"), description: cell(row, "description"),
        reorderLevel: Number(reorderText || 0), unitCostCents: cost,
        barcodes: cell(row, "barcodes").split(/[|;]/).map((b) => b.trim()).filter(Boolean),
      });
      if (!parsed.success) { err(parsed.error.issues[0]?.message ?? "Invalid row"); continue; }
      plans.set(key, { input: parsed.data, stock: stock ? [stock] : [], line });
      rows.push({
        line, sku, status: "create",
        message: stock ? `New item with ${stock.quantity.toLocaleString("en-US")} at ${idx.pathOf(stock.location._id.toHexString())}` : "New item, no stock",
      });
    }

    // Barcode clashes (with each other in the file, and with what's already there).
    const seenCodes = new Map<string, string>();
    for (const [key, p] of plans) {
      const bad = (message: string) => {
        const row = rows.find((x) => x.line === p.line)!;
        row.status = "error";
        row.message = message;
        plans.delete(key);
      };
      const dup = [p.input.sku, ...p.input.barcodes].map((x) => x.toLowerCase()).find((x) => seenCodes.has(x) && seenCodes.get(x) !== key);
      if (dup) { bad(`"${dup}" is used by another item in this file`); continue; }
      const clash = await findCodeConflict(store, orgId, p.input.barcodes, { against: ["sku", "barcodes"] })
        ?? await findCodeConflict(store, orgId, [p.input.sku], { against: ["barcodes"] });
      if (clash) { bad(conflictMessage(clash, p.input.barcodes.includes(clash.code) ? "Barcode" : "SKU")); continue; }
      for (const x of [p.input.sku, ...p.input.barcodes]) seenCodes.set(x.toLowerCase(), key);
    }

    const stockLines = [...plans.values()].reduce((s, p) => s + p.stock.length, 0);
    const result: ImportResult = {
      dryRun,
      rows: rows.sort((a, b) => a.line - b.line),
      itemsToCreate: plans.size,
      stockLines,
      units: [...plans.values()].reduce((s, p) => s + p.stock.reduce((q, x) => q + x.quantity, 0), 0),
      skipped: skipped.size,
      errors: rows.filter((x) => x.status === "error").length,
    };
    if (dryRun) return c.json(result);
    if (result.errors) return c.json({ error: "Fix the rows marked as errors first. Nothing was imported.", ...result }, 422);

    const actor = actorOf(c.get("user"));
    for (const p of plans.values()) {
      const now = new Date();
      const doc: ItemDoc = { _id: new ObjectId(), orgId, ...p.input, createdAt: now, updatedAt: now };
      await store.items.insertOne(doc);
      await recordAudit(store, {
        orgId, actor: auditActor(c.get("user")), action: "item.created", entity: itemEntity(doc._id, doc),
        summary: `Created ${doc.name} (${doc.sku}) from a CSV import`,
        snapshot: { sku: doc.sku, name: doc.name, description: doc.description, category: doc.category, reorderLevel: doc.reorderLevel, unitCostCents: doc.unitCostCents, barcodes: doc.barcodes ?? [] },
      });
      for (const s of p.stock) {
        await postAdjustment(store, orgId, actor, { itemId: doc._id, locationId: s.location._id, delta: s.quantity, reason: "Imported from CSV", type: "receive" });
      }
    }
    return c.json(result, 201);
  });

  return r;
}
