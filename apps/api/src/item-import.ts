import { zValidator } from "@hono/zod-validator";
import {
  AUDIT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  decimalsSchema,
  formatQty,
  importInputSchema,
  itemInputSchema,
  itemUpdateSchema,
  objectIdSchema,
  parseQty,
  qtyErrorMessage,
  unitLabelSchema,
  uomOf,
  type AuditChange,
  type ImportBatch,
  type ImportChange,
  type ImportField,
  type ImportMode,
  type ImportResult,
  type ImportRow,
  type ImportUndoResult,
} from "@invintel/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, canonicalize, diffFields, itemEntity, recordAudit, summarizeChanges } from "./audit.js";
import { nextNumber } from "./counters.js";
import { parseCsv } from "./csv.js";
import { isDuplicateKey, type ImportBatchDoc, type ItemDoc, type LocationDoc, type Store } from "./db.js";
import { conflictMessage, findCodeConflict } from "./item-codes.js";
import { itemReferencedElsewhere } from "./item-quantities.js";
import { actorOf, deleteItem, itemSnapshot } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { postAdjustment } from "./stock-service.js";
import { unitCodeTaken } from "./units.js";

// Applying is one insert plus audit entry per item (about 19 ms each), so keep a single request well under a proxy timeout.
const MAX_ROWS = 1000;
const SAMPLE_ROWS = 4;

/** Header names people actually use, mapped to our columns. */
const ALIASES: Record<string, ImportField> = {
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

/** Which column each field comes from, guessed from the header names. */
export function autoMap(headers: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {};
  // "description" is the product name in a file with no name column, but a column of its own when there is one (our own export).
  const hasName = headers.some((h) => ["name", "item", "item name"].includes(norm(h)));
  headers.forEach((h, i) => {
    const key = norm(h) === "description" && hasName ? "description" : ALIASES[norm(h)];
    if (key && mapping[key] === undefined) mapping[key] = i;
  });
  return mapping;
}

/** Dollars and cents text to cents, by string math (1.005 * 100 is 100.49999999999999 in floating point). */
const toCents = (raw: string): number | null => {
  const t = raw.replace(/[$,\s]/g, "");
  if (t === "") return 0;
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(t);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(4, "0"); // ten-thousandths, rounded half up to a cent
  return Number(m[1]) * 100 + Math.floor((Number(frac) + 50) / 100);
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Export puts an apostrophe in front of text a spreadsheet would run as a formula (= + - @). Take it off again. */
const unguard = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

type CreatePlan = { input: ReturnType<typeof itemInputSchema.parse>; stock: { location: LocationDoc; quantity: number }[]; line: number };
type UpdatePlan = { doc: ItemDoc; patch: Record<string, unknown>; changes: ImportChange[]; line: number };

export type Planned =
  | { error: string }
  | { result: ImportResult; creates: Map<string, CreatePlan>; updates: Map<string, UpdatePlan>; idx: ReturnType<typeof indexLocations> };

/** Reads the file and works out what an import would do, without writing anything. */
export async function planImport(store: Store, orgId: ObjectId, input: z.output<typeof importInputSchema>): Promise<Planned> {
  const { csv, mode } = input;
  const table = parseCsv(csv);
  if (table.length < 2) return { error: "The file needs a header row and at least one item." };
  if (table.length - 1 > MAX_ROWS) return { error: `Import at most ${MAX_ROWS} rows at a time.` };

  const headers = table[0]!;
  const mapping = input.mapping ?? autoMap(headers);
  const used = Object.entries(mapping).filter(([, v]) => v !== undefined) as [ImportField, number][];
  if (used.some(([, i]) => i >= headers.length)) return { error: "A column in the mapping isn't in the file." };
  const taken = used.map(([, i]) => i);
  if (new Set(taken).size !== taken.length) return { error: "Each column can be used for only one field." };
  // Not an error yet: the person is probably about to pick the column. Report what is missing alongside the headers.
  const needs: ImportField[] = [...(mapping.sku === undefined ? ["sku" as const] : []), ...(mapping.name === undefined && mode !== "update" ? ["name" as const] : [])];
  if (needs.length) {
    return {
      result: {
        dryRun: input.dryRun, rows: [], itemsToCreate: 0, itemsToUpdate: 0, stockLines: 0, units: 0, skipped: 0, errors: 0,
        headers, mapping, sample: table.slice(1, 1 + SAMPLE_ROWS), needs,
      },
      creates: new Map(), updates: new Map(), idx: indexLocations([]),
    };
  }

  const cell = (row: string[], key: ImportField) => (mapping[key] !== undefined ? unguard((row[mapping[key]!] ?? "").trim()) : "");

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

  const existing = new Map((await store.items.find({ orgId }).toArray()).map((i) => [i.sku.toLowerCase(), i]));
  const rows: ImportRow[] = [];
  const creates = new Map<string, CreatePlan>();
  const updates = new Map<string, UpdatePlan>();
  const skipped = new Set<string>();
  const failed = new Set<string>(); // SKUs whose defining line had a problem: their later lines can't stand alone

  for (let n = 1; n < table.length; n++) {
    const row = table[n]!;
    const line = n + 1;
    const sku = cell(row, "sku");
    const err = (message: string) => {
      rows.push({ line, sku, status: "error", message, cells: row });
      if (sku) failed.add(sku.toLowerCase());
    };
    if (row.every((x) => !x.trim())) continue;
    if (!sku) { err("Missing SKU"); continue; }
    const key = sku.toLowerCase();
    const doc = existing.get(key);

    // ---- a SKU that is already in the inventory ----
    if (doc) {
      if (mode === "create") {
        if (!skipped.has(key)) rows.push({ line, sku, status: "skip", message: "Already exists, left as it is" });
        skipped.add(key);
        continue;
      }
      if (updates.has(key) || skipped.has(key)) {
        rows.push({ line, sku, status: "skip", message: "Repeats an item above" });
        continue;
      }
      const planned = planUpdate(doc, row, cell);
      if ("error" in planned) { err(planned.error); continue; }
      if (!planned.changes.length) {
        rows.push({ line, sku, status: "skip", message: `No changes${cell(row, "quantity") ? " (import doesn't change stock of items that already exist)" : ""}` });
        skipped.add(key);
        continue;
      }
      updates.set(key, { doc, patch: planned.patch, changes: planned.changes, line });
      rows.push({
        line, sku, status: "update", changes: planned.changes,
        message: `Changes ${planned.changes.map((c) => c.field).join(", ")}${cell(row, "quantity") ? ". Stock isn't changed by import" : ""}`,
      });
      continue;
    }

    // ---- a new SKU ----
    if (mode === "update") {
      rows.push({ line, sku, status: "skip", message: "Not in your inventory, so there is nothing to update" });
      skipped.add(key);
      continue;
    }
    if (failed.has(key) && !creates.has(key)) { err("The first line for this SKU had a problem, so this line was skipped"); continue; }

    // How this item's quantities are written: from its unit and decimals columns, or from the line that defined it.
    const defined = creates.get(key)?.input;
    const unitText = cell(row, "unit");
    const decimalsText = cell(row, "decimals");
    if (!defined) {
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

    const plan = creates.get(key);
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
    creates.set(key, { input: parsed.data, stock: stock ? [stock] : [], line });
    rows.push({
      line, sku, status: "create",
      message: stock ? `New item with ${formatQty(stock.quantity, uom)} at ${idx.pathOf(stock.location._id.toHexString())}` : "New item, no stock",
    });
  }

  // Barcode clashes (with each other in the file, and with what's already there).
  const seenCodes = new Map<string, string>();
  const reject = (line: number, key: string, message: string) => {
    const row = rows.find((x) => x.line === line)!;
    const cells = table[line - 1];
    row.status = "error";
    row.message = message;
    delete row.changes;
    if (cells) row.cells = cells;
    creates.delete(key);
    updates.delete(key);
    failed.add(key);
  };
  const claims: { key: string; line: number; sku: string; codes: string[]; self?: ObjectId; checkSku: boolean }[] = [
    ...[...creates].map(([key, p]) => ({ key, line: p.line, sku: p.input.sku, codes: p.input.barcodes, checkSku: true })),
    ...[...updates].filter(([, u]) => Array.isArray(u.patch.barcodes)).map(([key, u]) => ({ key, line: u.line, sku: u.doc.sku, codes: u.patch.barcodes as string[], self: u.doc._id, checkSku: false })),
  ];
  for (const claim of claims) {
    const own = [...(claim.checkSku ? [claim.sku] : []), ...claim.codes].map((x) => x.toLowerCase());
    const dup = own.find((x) => seenCodes.has(x) && seenCodes.get(x) !== claim.key);
    if (dup) { reject(claim.line, claim.key, `"${dup}" is used by another item in this file`); continue; }
    if (await unitCodeTaken(store, orgId, [...(claim.checkSku ? [claim.sku] : []), ...claim.codes])) {
      reject(claim.line, claim.key, "That code is already printed on a roll or pallet label");
      continue;
    }
    const clash = (await findCodeConflict(store, orgId, claim.codes, { selfId: claim.self, against: ["sku", "barcodes"] }))
      ?? (claim.checkSku ? await findCodeConflict(store, orgId, [claim.sku], { against: ["barcodes"] }) : null);
    if (clash) { reject(claim.line, claim.key, conflictMessage(clash, claim.codes.includes(clash.code) ? "Barcode" : "SKU")); continue; }
    for (const x of own) seenCodes.set(x, claim.key);
  }

  const result: ImportResult = {
    dryRun: input.dryRun,
    rows: rows.sort((a, b) => a.line - b.line),
    itemsToCreate: creates.size,
    itemsToUpdate: updates.size,
    stockLines: [...creates.values()].reduce((s, p) => s + p.stock.length, 0),
    units: Math.round([...creates.values()].reduce((s, p) => s + p.stock.reduce((q, x) => q + x.quantity, 0) / 10 ** p.input.decimals, 0)),
    skipped: skipped.size,
    errors: rows.filter((x) => x.status === "error").length,
    headers,
    mapping,
    sample: table.slice(1, 1 + SAMPLE_ROWS),
  };
  return { result, creates, updates, idx };
}

const FIELD_NAMES: Record<string, string> = { ...AUDIT_FIELD_LABELS, reorderLevel: "reorder level", unitCostCents: "unit cost" };

/** What a row in the file would change on an item that already exists. Blank cells leave things alone. */
function planUpdate(
  doc: ItemDoc,
  row: string[],
  cell: (row: string[], key: ImportField) => string,
): { error: string } | { patch: Record<string, unknown>; changes: ImportChange[] } {
  const uom = uomOf(doc);
  const patch: Record<string, unknown> = {};
  const changes: ImportChange[] = [];
  const change = (field: keyof ItemDoc, from: string, to: string, value: unknown) => {
    patch[field] = value;
    changes.push({ field: FIELD_NAMES[field as string] ?? String(field), from: from || "none", to: to || "none" });
  };

  for (const field of ["name", "category", "description"] as const) {
    const text = cell(row, field);
    if (text !== "" && text !== doc[field]) change(field, String(doc[field] ?? ""), text, text);
  }

  const reorderText = cell(row, "reorder");
  if (reorderText !== "") {
    const r = parseQty(reorderText, uom.decimals);
    if (!r.ok) return { error: `Reorder level "${reorderText}": ${qtyErrorMessage(r.reason, uom)}` };
    if (r.stored !== doc.reorderLevel) change("reorderLevel", formatQty(doc.reorderLevel, uom), formatQty(r.stored, uom), r.stored);
  }

  const costText = cell(row, "cost");
  if (costText !== "") {
    const cents = toCents(costText);
    if (cents === null) return { error: `Unit cost "${costText}" isn't a number` };
    if (cents !== doc.unitCostCents) change("unitCostCents", dollars(doc.unitCostCents), dollars(cents), cents);
  }

  const barcodeText = cell(row, "barcodes");
  if (barcodeText !== "") {
    const codes = [...new Set(barcodeText.split(/[|;]/).map((b) => b.trim()).filter(Boolean))];
    const now = doc.barcodes ?? [];
    if ([...codes].sort().join("|") !== [...now].sort().join("|")) change("barcodes", now.join(" | "), codes.join(" | "), codes);
  }

  // Changing how an item is measured would silently rescale everything it has ever held.
  const unitText = cell(row, "unit");
  const decimalsText = cell(row, "decimals");
  if ((unitText !== "" && unitText !== uom.unit) || (decimalsText !== "" && decimalsText !== String(uom.decimals))) {
    return { error: `Unit and decimal places can't be changed by import (this item is in ${uom.unit}, ${uom.decimals} decimals)` };
  }

  const checked = itemUpdateSchema.safeParse(patch);
  if (!checked.success) return { error: checked.error.issues[0]?.message ?? "Invalid row" };
  return { patch: checked.data as Record<string, unknown>, changes };
}

const idParam = z.object({ id: objectIdSchema });

const toBatch = (b: ImportBatchDoc): ImportBatch => ({
  id: b._id.toHexString(),
  number: b.number,
  at: b.at.toISOString(),
  userName: b.userName,
  filename: b.filename,
  mode: b.mode,
  created: b.created.length,
  updated: b.updated.length,
  undoneAt: b.undoneAt?.toISOString() ?? null,
  undoneBy: b.undoneBy ?? null,
});

export function createImportRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  /**
   * Creates and/or updates items from a spreadsheet. The default only creates: existing SKUs are never changed, so
   * running the same file twice can't double anything. Rows that repeat a SKU add stock at another location. Send
   * dryRun first. An applied import is recorded as a batch and can be undone while nothing has built on it.
   */
  r.post("/items/import", requireRole("admin"), bodyLimit({ maxSize: 3 * 1024 * 1024, onError: (c) => c.json({ error: "That file is too big. Split it into smaller files." }, 413) }), zValidator("json", importInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const planned = await planImport(store, orgId, input);
    if ("error" in planned) return c.json({ error: planned.error }, 400);
    const { result, creates, updates } = planned;

    if (input.dryRun) return c.json(result);
    if (result.needs?.length) return c.json({ error: `Choose which column holds the ${result.needs.map((f) => IMPORT_FIELD_LABELS[f]).join(" and ")}.` }, 400);
    if (result.errors && input.onErrors === "stop") return c.json({ error: "Fix the rows marked as errors first, or choose to skip them. Nothing was imported.", ...result }, 422);

    const user = c.get("user");
    const actor = actorOf(user);
    const failRow = (line: number, message: string) => {
      const row = result.rows.find((x) => x.line === line);
      if (row) { row.status = "error"; row.message = message; }
      result.errors++;
    };
    const batch: ImportBatchDoc = {
      _id: new ObjectId(), orgId, number: "", at: new Date(), userId: actor.userId, userName: user.name,
      filename: input.filename, mode: input.mode, created: [], updated: [],
    };

    for (const p of creates.values()) {
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
        orgId, actor: auditActor(user), action: "item.created", entity: itemEntity(doc._id, doc),
        summary: `Created ${doc.name} (${doc.sku}) from a CSV import`,
        snapshot: itemSnapshot(doc),
      });
      const movementIds: ObjectId[] = [];
      for (const s of p.stock) {
        const posted = await postAdjustment(store, orgId, actor, { itemId: doc._id, locationId: s.location._id, delta: s.quantity, reason: "Imported from CSV", type: "receive" });
        if (posted.ok) movementIds.push(...posted.movementIds);
        else failRow(p.line, `Item created but its stock at ${s.location.name} wasn't: ${posted.error}`);
      }
      batch.created.push({ itemId: doc._id, sku: doc.sku, name: doc.name, movementIds });
    }

    for (const u of updates.values()) {
      // Only if nobody edited it since the preview, so an import can't overwrite a newer change.
      const before = await store.items.findOneAndUpdate({ _id: u.doc._id, orgId, updatedAt: u.doc.updatedAt }, { $set: { ...u.patch, updatedAt: new Date() } });
      if (!before) {
        failRow(u.line, "Changed by someone else while importing, left as it is");
        result.itemsToUpdate--;
        continue;
      }
      const snapshot = itemSnapshot(before);
      const changes = diffFields(snapshot, u.patch);
      await recordAudit(store, {
        orgId, actor: auditActor(user), action: "item.updated",
        entity: itemEntity(u.doc._id, { name: (u.patch.name as string | undefined) ?? before.name, sku: before.sku }),
        summary: `${summarizeChanges(changes)} (CSV import)`,
        changes,
      });
      batch.updated.push({
        itemId: u.doc._id, sku: before.sku, name: before.name,
        before: Object.fromEntries(Object.keys(u.patch).map((k) => [k, (snapshot as Record<string, unknown>)[k]])),
        after: u.patch,
      });
    }

    if (batch.created.length || batch.updated.length) {
      batch.number = await nextNumber(store, orgId, "import", "IMP-");
      await store.importBatches.insertOne(batch);
      await recordAudit(store, {
        orgId, actor: auditActor(user), action: "import.applied",
        entity: { type: "organization", id: orgId.toHexString(), label: `Import ${batch.number}` },
        summary: `Applied ${batch.number}${input.filename ? ` (${input.filename})` : ""}: ${batch.created.length} created, ${batch.updated.length} updated${result.errors ? `, ${result.errors} skipped with problems` : ""}`,
        refs: { importBatchId: batch._id.toHexString() },
      });
      result.batchId = batch._id.toHexString();
    }
    return c.json(result, 201);
  });

  r.get("/imports", requireRole("admin"), async (c) => {
    const docs = await store.importBatches.find({ orgId: c.get("org")._id }).sort({ at: -1 }).limit(20).toArray();
    return c.json(docs.map(toBatch));
  });

  /**
   * Takes an import back: new items are removed (their stock written off through the ledger) and changed
   * items go back to how they were. Only while nothing has built on it, and all or nothing.
   */
  r.post("/imports/:id/undo", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const _id = new ObjectId(c.req.valid("param").id);
    const batch = await store.importBatches.findOne({ _id, orgId });
    if (!batch) return c.json({ error: "Import not found" }, 404);
    if (batch.undoneAt) return c.json({ error: `${batch.number} has already been undone` }, 409);

    const problems: string[] = [];
    for (const made of batch.created) {
      const item = await store.items.findOne({ _id: made.itemId, orgId }, { projection: { _id: 1 } });
      if (!item) continue; // someone already removed it
      if ((await store.movements.countDocuments({ itemId: made.itemId })) !== made.movementIds.length) problems.push(`${made.sku}: its stock has moved or been counted since the import`);
      else if (await itemReferencedElsewhere(store, orgId, made.itemId)) problems.push(`${made.sku}: it is now on an order, recipe, count or roll`);
    }
    for (const changed of batch.updated) {
      const item = await store.items.findOne({ _id: changed.itemId, orgId });
      if (!item) { problems.push(`${changed.sku}: it has been deleted since the import`); continue; }
      const moved = Object.entries(changed.after).find(([field, value]) => canonicalize((item as unknown as Record<string, unknown>)[field] ?? null) !== canonicalize(value));
      if (moved) problems.push(`${changed.sku}: its ${FIELD_NAMES[moved[0]] ?? moved[0]} was changed again after the import`);
    }
    if (problems.length) return c.json({ error: `${batch.number} can't be undone: ${problems.length === 1 ? "one item has" : `${problems.length} items have`} been built on since.`, problems }, 409);

    const user = c.get("user");
    let restored = 0;
    for (const changed of batch.updated) {
      const item = (await store.items.findOneAndUpdate({ _id: changed.itemId, orgId }, { $set: { ...changed.before, updatedAt: new Date() } }))!;
      const changes: AuditChange[] = diffFields(itemSnapshot(item), changed.before);
      await recordAudit(store, {
        orgId, actor: auditActor(user), action: "item.updated", entity: itemEntity(changed.itemId, item),
        summary: `${summarizeChanges(changes)} (undoing ${batch.number})`, changes,
      });
      restored++;
    }
    let removed = 0;
    const stuck: string[] = [];
    for (const made of batch.created) {
      const res = await deleteItem(store, orgId, user, made.itemId, { writeOffReason: `Import ${batch.number} undone`, verb: `Removed (undoing ${batch.number}):` });
      if (res.ok) removed++;
      else if (res.status !== 404) stuck.push(`${made.sku}: ${res.error}`);
    }
    if (stuck.length) return c.json({ error: `Some of ${batch.number} could not be undone.`, problems: stuck }, 409);

    await store.importBatches.updateOne({ _id }, { $set: { undoneAt: new Date(), undoneBy: user.name } });
    await recordAudit(store, {
      orgId, actor: auditActor(user), action: "import.undone",
      entity: { type: "organization", id: orgId.toHexString(), label: `Import ${batch.number}` },
      summary: `Undid ${batch.number}: ${removed} ${removed === 1 ? "item" : "items"} removed, ${restored} restored`,
      refs: { importBatchId: _id.toHexString() },
    });
    const fresh = (await store.importBatches.findOne({ _id }))!;
    return c.json<ImportUndoResult>({ batch: toBatch(fresh), removed, restored });
  });

  return r;
}

export type { ImportMode };
export { IMPORT_FIELDS };
