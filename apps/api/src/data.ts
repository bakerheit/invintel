import { zValidator } from "@hono/zod-validator";
import { decimalsSchema, formatQty, importInputSchema, itemInputSchema, parseQty, qtyErrorMessage, unitLabelSchema, uomOf, type ImportResult, type ImportRow } from "@invintel/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ObjectId } from "mongodb";
import { auditActor, itemEntity, recordAudit } from "./audit.js";
import { csvText, parseCsv } from "./csv.js";
import { isDuplicateKey, type ItemDoc, type LocationDoc, type Store } from "./db.js";
import { conflictMessage, findCodeConflict } from "./item-codes.js";
import { loadItems } from "./item-queries.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { postAdjustment } from "./stock-service.js";

// Applying is one insert plus audit entry per item (about 19 ms each), so keep a single request well under a proxy timeout.
const MAX_ROWS = 1000;

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
  unit: "unit", uom: "unit", "unit of measure": "unit",
  decimals: "decimals", "decimal places": "decimals",
};
const norm = (h: string) => h.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");

/** Dollars and cents text to cents, by string math (1.005 * 100 is 100.49999999999999 in floating point). */
const toCents = (raw: string): number | null => {
  const t = raw.replace(/[$,\s]/g, "");
  if (t === "") return 0;
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(t);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(4, "0"); // ten-thousandths, rounded half up to a cent
  return Number(m[1]) * 100 + Math.floor((Number(frac) + 50) / 100);
};

/** Export puts an apostrophe in front of text a spreadsheet would run as a formula (= + - @). Take it off again. */
const unguard = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

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
    // "description" is the product name in a file with no name column, but a column of its own when there is one (our own export).
    const hasName = table[0]!.some((h) => ["name", "item", "item name"].includes(norm(h)));
    table[0]!.forEach((h, i) => {
      const key = norm(h) === "description" && hasName ? "description" : ALIASES[norm(h)];
      if (key && !cols.has(key)) cols.set(key, i);
    });
    if (!cols.has("sku") || !cols.has("name")) return fail("Needs a SKU column and a name column in the first row.");
    const cell = (row: string[], key: string) => (cols.has(key) ? unguard((row[cols.get(key)!] ?? "").trim()) : "");

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

      // How this item's quantities are written: from its unit and decimals columns, or from the line that defined it.
      const defined = plans.get(key)?.input;
      const unitText = cell(row, "unit");
      const decimalsText = cell(row, "decimals");
      if (!defined && !existing.has(key)) {
        if (unitText && !unitLabelSchema.safeParse(unitText).success) { err(`Unit "${unitText}" isn't valid (1 to 16 characters)`); continue; }
        if (decimalsText && !(/^\d+$/.test(decimalsText) && decimalsSchema.safeParse(Number(decimalsText)).success)) { err(`Decimals "${decimalsText}" must be a whole number from 0 to 4`); continue; }
      }
      const uom = defined ? uomOf(defined) : uomOf({ unit: unitText || undefined, decimals: decimalsText === "" ? 0 : Number(decimalsText) });

      // Stock part (optional)
      let stock: { location: LocationDoc; quantity: number } | null = null;
      const qtyText = cell(row, "quantity");
      const locText = cell(row, "location");
      let qty = 0;
      if (qtyText !== "") {
        const q = parseQty(qtyText, uom.decimals);
        if (!q.ok) { err(`Quantity "${qtyText}": ${qtyErrorMessage(q.reason, uom)}`); continue; }
        qty = q.stored;
      }
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
          rows.push({ line, sku, status: "stock", message: `Adds ${formatQty(stock.quantity, uom)} at ${idx.pathOf(stock.location._id.toHexString())}` });
        } else rows.push({ line, sku, status: "skip", message: "Repeats an item defined above" });
        continue;
      }

      const cost = toCents(cell(row, "cost"));
      const reorderText = cell(row, "reorder");
      if (cost === null) { err(`Unit cost "${cell(row, "cost")}" isn't a number`); continue; }
      const reorder = reorderText === "" ? { ok: true as const, stored: 0 } : parseQty(reorderText, uom.decimals);
      if (!reorder.ok) { err(`Reorder level "${reorderText}": ${qtyErrorMessage(reorder.reason, uom)}`); continue; }
      const parsed = itemInputSchema.safeParse({
        sku, name: cell(row, "name"), category: cell(row, "category"), description: cell(row, "description"),
        reorderLevel: reorder.stored, unitCostCents: cost, unit: uom.unit, decimals: uom.decimals,
        barcodes: cell(row, "barcodes").split(/[|;]/).map((b) => b.trim()).filter(Boolean),
      });
      if (!parsed.success) { err(parsed.error.issues[0]?.message ?? "Invalid row"); continue; }
      plans.set(key, { input: parsed.data, stock: stock ? [stock] : [], line });
      rows.push({
        line, sku, status: "create",
        message: stock ? `New item with ${formatQty(stock.quantity, uom)} at ${idx.pathOf(stock.location._id.toHexString())}` : "New item, no stock",
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
      units: Math.round([...plans.values()].reduce((s, p) => s + p.stock.reduce((q, x) => q + x.quantity, 0) / 10 ** p.input.decimals, 0)),
      skipped: skipped.size,
      errors: rows.filter((x) => x.status === "error").length,
    };
    if (dryRun) return c.json(result);
    if (result.errors) return c.json({ error: "Fix the rows marked as errors first. Nothing was imported.", ...result }, 422);

    const actor = actorOf(c.get("user"));
    const failRow = (line: number, message: string) => {
      const row = result.rows.find((x) => x.line === line);
      if (row) { row.status = "error"; row.message = message; }
      result.errors++;
    };
    for (const p of plans.values()) {
      const now = new Date();
      const doc: ItemDoc = { _id: new ObjectId(), orgId, ...p.input, createdAt: now, updatedAt: now };
      try {
        await store.items.insertOne(doc);
      } catch (e) {
        // Someone created the same SKU or barcode while this ran. Report it; the rest carries on and a rerun is safe.
        failRow(p.line, isDuplicateKey(e) ? "Created by someone else while importing, left as it is" : "Couldn't be saved");
        result.itemsToCreate--;
        continue;
      }
      await recordAudit(store, {
        orgId, actor: auditActor(c.get("user")), action: "item.created", entity: itemEntity(doc._id, doc),
        summary: `Created ${doc.name} (${doc.sku}) from a CSV import`,
        snapshot: { sku: doc.sku, name: doc.name, description: doc.description, category: doc.category, reorderLevel: doc.reorderLevel, unitCostCents: doc.unitCostCents, barcodes: doc.barcodes ?? [], unit: doc.unit ?? "ea", decimals: doc.decimals ?? 0 },
      });
      for (const s of p.stock) {
        const posted = await postAdjustment(store, orgId, actor, { itemId: doc._id, locationId: s.location._id, delta: s.quantity, reason: "Imported from CSV", type: "receive" });
        if (!posted.ok) failRow(p.line, `Item created but its stock at ${s.location.name} wasn't: ${posted.error}`);
      }
    }
    return c.json(result, 201);
  });

  return r;
}
