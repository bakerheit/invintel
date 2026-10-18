import {
  ARCHIVE_COLLECTIONS,
  addressSchema,
  canonicalInvoiceSchema,
  companyProfileSchema,
  docKindSchema,
  docTemplateOverrideSchema,
  docTemplateSchema,
  optionalAddressSchema,
  invoiceSettingsSchema,
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type ArchiveCollection,
  type ArchiveRestoreResult,
  type ArchiveSummary,
} from "@invintel/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Binary, ObjectId, type Collection, type Document } from "mongodb";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { auditActor, recordAudit } from "./audit.js";
import type { LocationDoc, OrgDoc, Store } from "./db.js";
import { readImage } from "./image.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { createHash } from "node:crypto";

/** Where each collection lives. Everything here is scoped by orgId. */
const SOURCES: Record<ArchiveCollection, (s: Store) => Collection<Document>> = {
  locations: (s) => s.locations as unknown as Collection<Document>,
  items: (s) => s.items as unknown as Collection<Document>,
  stock: (s) => s.stock as unknown as Collection<Document>,
  units: (s) => s.units as unknown as Collection<Document>,
  movements: (s) => s.movements as unknown as Collection<Document>,
  suppliers: (s) => s.suppliers as unknown as Collection<Document>,
  purchaseOrders: (s) => s.purchaseOrders as unknown as Collection<Document>,
  shipments: (s) => s.shipments as unknown as Collection<Document>,
  invoices: (s) => s.invoices as unknown as Collection<Document>,
  payments: (s) => s.payments as unknown as Collection<Document>,
  salesOrders: (s) => s.salesOrders as unknown as Collection<Document>,
  tradingPartners: (s) => s.tradingPartners as unknown as Collection<Document>,
  docLogos: (s) => s.docLogos as unknown as Collection<Document>,
  workCenters: (s) => s.workCenters as unknown as Collection<Document>,
  boms: (s) => s.boms as unknown as Collection<Document>,
  workOrders: (s) => s.workOrders as unknown as Collection<Document>,
  counts: (s) => s.counts as unknown as Collection<Document>,
  ncrs: (s) => s.ncrs as unknown as Collection<Document>,
  drills: (s) => s.drills as unknown as Collection<Document>,
  downtime: (s) => s.downtime as unknown as Collection<Document>,
  importBatches: (s) => s.importBatches as unknown as Collection<Document>,
};
const NAMES = Object.keys(ARCHIVE_COLLECTIONS) as ArchiveCollection[];

/**
 * What of a collection is exported. An Invintel-to-Invintel exchange partner is tied to this organization's signing identity, which is
 * not carried, so those partners are left out (an order from one of them keeps its customer's name and just loses the link).
 */
const EXPORT_FILTER: Partial<Record<ArchiveCollection, Document>> = { tradingPartners: { bridge: { $ne: "invintel" } } };

/**
 * Organization settings that travel with the archive. An allowlist, so a crafted archive can't set
 * the join code, the owner or anything else that isn't a plain preference. Each has a validator.
 */
const SETTINGS: Record<string, z.ZodType> = {
  varianceThresholdPct: z.number().min(0).max(1000).nullable(),
  modules: z.object({ purchasing: z.boolean().optional(), production: z.boolean().optional(), sales: z.boolean().optional() }).strict(),
  scrapReasons: z.array(z.string().max(100)).max(100),
  holdReasons: z.array(z.string().max(100)).max(100),
  downtimeReasons: z.array(z.string().max(100)).max(100),
  scheduledHoursPerDay: z.number().min(0).max(24),
  alertSettings: z.object({ daysOfSupply: z.number().min(0).max(10000), machineDownMinutes: z.number().min(0).max(100000) }).strict(),
  invoiceSettings: invoiceSettingsSchema,
  documentProfile: z.object({ company: companyProfileSchema, templates: z.partialRecord(docKindSchema, docTemplateSchema) }).strict(),
  approvalRules: z
    .array(z.object({ kind: z.enum(["adjustment", "purchase_order", "sales_order"]), thresholdCents: z.number().int().min(0).max(1_000_000_000), appliesTo: z.enum(["members", "everyone"]) }).strict())
    .max(10),
};

/** Numbering that must carry on after a restore, so the next PO or roll label can't repeat one that came back. */
const COUNTERS: { kind: string; collection: ArchiveCollection; field: string }[] = [
  { kind: "po", collection: "purchaseOrders", field: "number" },
  { kind: "so", collection: "salesOrders", field: "number" },
  { kind: "wo", collection: "workOrders", field: "number" },
  { kind: "count", collection: "counts", field: "number" },
  { kind: "ncr", collection: "ncrs", field: "number" },
  { kind: "import", collection: "importBatches", field: "number" },
  { kind: "invoice", collection: "invoices", field: "number" },
  { kind: "payment", collection: "payments", field: "number" },
  { kind: "shipment", collection: "shipments", field: "number" },
  { kind: "unit", collection: "units", field: "code" },
];

/** Numbering kept inside other documents: invoice numbers issued for shipments (INV-0001) live on the sales order's shipments. */
const NESTED_COUNTERS: { kind: string; collection: ArchiveCollection; values: (d: Document) => string[] }[] = [
  { kind: "inv", collection: "salesOrders", values: (d) => (Array.isArray(d.shipments) ? d.shipments.map((s: Document) => String(s?.invoiceNumber ?? "")) : []) },
];

/** Fields every document must have, so garbage can't get into a collection and break the screens that read it. */
const REQUIRED: Partial<Record<ArchiveCollection, Record<string, "string" | "number" | "boolean" | "id" | "array" | "object" | "date">>> = {
  locations: { name: "string", createdAt: "date", updatedAt: "date" },
  items: { sku: "string", name: "string", reorderLevel: "number", unitCostCents: "number", createdAt: "date", updatedAt: "date" },
  stock: { itemId: "id", locationId: "id", quantity: "number", updatedAt: "date" },
  units: { itemId: "id", locationId: "id", code: "string", quantity: "number", createdAt: "date", updatedAt: "date" },
  movements: { itemId: "id", locationId: "id", delta: "number", createdAt: "date" },
  suppliers: { name: "string", createdAt: "date" },
  purchaseOrders: { number: "string", supplierId: "id", lines: "array", createdAt: "date", updatedAt: "date" },
  shipments: { number: "string", supplierId: "id", lines: "array", createdAt: "date" },
  invoices: { number: "string", supplierId: "id", lines: "array", createdAt: "date", updatedAt: "date" },
  payments: { number: "string", supplierId: "id", allocations: "array", createdAt: "date" },
  salesOrders: { number: "string", state: "string", lines: "array", createdAt: "date", updatedAt: "date" },
  tradingPartners: { name: "string", kind: "string", bridge: "string", createdAt: "date" },
  docLogos: { contentType: "string", bytes: "object", createdAt: "date" },
  workCenters: { name: "string", locationId: "id", createdAt: "date" },
  boms: { outputItemId: "id", inputs: "array", createdAt: "date" },
  workOrders: { number: "string", bomId: "id", outputItemId: "id", workCenterId: "id", requirements: "array", createdAt: "date", updatedAt: "date" },
  counts: { number: "string", locationId: "id", lines: "array", startedAt: "date" },
  ncrs: { number: "string", itemId: "id", dispositions: "array", heldAt: "date" },
  drills: { at: "date" },
  downtime: { workCenterId: "id", startedAt: "date" },
  importBatches: { number: "string", created: "array", updated: "array", at: "date" },
};

// ---------------- plain JSON <-> Mongo values ----------------

const OID = /^[0-9a-f]{24}$/i;

/** ObjectIds become { $oid }, dates { $date }, so a file round-trips without guessing what a string was. */
export function toPlain(value: unknown): unknown {
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Binary) return { $binary: Buffer.from(value.buffer).toString("base64") };
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}

class ArchiveError extends Error {}

const MAX_DEPTH = 14;
const MAX_DOCS = 600_000;

/** Reads the tagged JSON back into Mongo values, refusing anything that could do more than store data. */
function fromPlain(value: unknown, mapId: (hex: string) => ObjectId, depth = 0, allowBinary = false): unknown {
  if (depth > MAX_DEPTH) throw new ArchiveError("The archive is nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArchiveError("The archive contains a number that isn't valid.");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => fromPlain(v, mapId, depth + 1, allowBinary));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "$oid") {
      if (typeof entries[0]![1] !== "string" || !OID.test(entries[0]![1])) throw new ArchiveError("The archive contains an id that isn't valid.");
      return mapId(entries[0]![1].toLowerCase());
    }
    if (entries.length === 1 && entries[0]![0] === "$binary") {
      // Raw bytes exist in one place only (the logo). Anywhere else they are a sign of a crafted file.
      const b64 = entries[0]![1];
      if (!allowBinary || typeof b64 !== "string" || b64.length > 600_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ArchiveError("The archive contains data that isn't valid.");
      return new Binary(Buffer.from(b64, "base64"));
    }
    if (entries.length === 1 && entries[0]![0] === "$date") {
      const d = new Date(String(entries[0]![1]));
      if (typeof entries[0]![1] !== "string" || Number.isNaN(d.getTime())) throw new ArchiveError("The archive contains a date that isn't valid.");
      return d;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      // Field names with $ or . are how operators and paths sneak into a query or update; no real document has them.
      if (k.startsWith("$") || k.includes(".") || k === "__proto__" || k === "constructor" || k === "prototype") throw new ArchiveError(`The archive contains a field name that isn't allowed ("${k}").`);
      out[k] = fromPlain(v, mapId, depth + 1, allowBinary);
    }
    return out;
  }
  throw new ArchiveError("The archive contains a value that isn't valid.");
}

// ---------------- export ----------------

const SETTING_KEYS = Object.keys(SETTINGS);

export async function buildArchive(store: Store, org: OrgDoc): Promise<{ archive: Record<string, unknown>; summary: ArchiveSummary }> {
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const name of NAMES) {
    const docs = await SOURCES[name](store).find({ orgId: org._id, ...(EXPORT_FILTER[name] ?? {}) }).sort({ _id: 1 }).toArray();
    counts[name] = docs.length;
    data[name] = docs.map(({ orgId: _orgId, ...rest }) => toPlain(rest));
  }
  const settings: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const v = (org as unknown as Record<string, unknown>)[key];
    if (v !== undefined) settings[key] = toPlain(v);
  }
  const summary: ArchiveSummary = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    organizationName: org.name,
    counts,
    settings: Object.keys(settings),
  };
  // X12 control numbers are counted per partner and must never be reused with the same partner, so the counts travel with the partners.
  const counters: Record<string, number> = {};
  const partnerIds = new Set((data.tradingPartners ?? []).map((p) => (p as { _id: { $oid: string } })._id.$oid));
  for (const row of await store.counters.find({ _id: { $regex: `^${org._id.toHexString()}:x12(tp)?:[0-9a-f]{24}$` } }).toArray()) {
    const [, kind, partner] = row._id.split(":");
    if (partnerIds.has(partner!)) counters[`${kind}:${partner}`] = row.seq;
  }
  return { archive: { ...summary, settings, counters, data }, summary };
}

// ---------------- restore ----------------

const archiveShape = z.object({
  format: z.literal(ARCHIVE_FORMAT, { error: "That file isn't an Invintel archive." }),
  version: z.number().int(),
  exportedAt: z.string().max(40),
  organizationName: z.string().max(200),
  settings: z.record(z.string(), z.unknown()).default({}),
  counters: z.record(z.string().regex(/^x12(tp)?:[0-9a-f]{24}$/), z.number().int().min(0).max(999_999_999)).default({}),
  data: z.record(z.string(), z.array(z.unknown())),
});

const typeOk = (v: unknown, t: "string" | "number" | "boolean" | "id" | "array" | "object" | "date") =>
  t === "date" ? v instanceof Date : t === "id" ? v instanceof ObjectId : t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId) : typeof v === t;

interface Prepared {
  summary: ArchiveSummary;
  docs: Record<ArchiveCollection, Document[]>;
  settings: Record<string, unknown>;
  /** X12 control numbers per (new) partner id, as the counter keys they belong under. */
  counters: Record<string, number>;
}

/**
 * What the newer collections must look like beyond having the right fields: they feed documents, PDFs and EDI, so what is restored has
 * to be what the screens would have accepted. Returns the problem, or null. A logo is read again from its bytes (never trusted).
 */
function checkDoc(name: ArchiveCollection, doc: Document): string | null {
  const bad = (v: z.ZodType, x: unknown) => x !== undefined && x !== null && !v.safeParse(x).success;
  if (name === "suppliers" && bad(addressSchema, doc.address)) return "has an address that isn't valid";
  if (name === "tradingPartners") {
    if (bad(addressSchema, doc.billTo) || bad(addressSchema, doc.shipTo)) return "has an address that isn't valid";
    if (bad(z.partialRecord(docKindSchema, docTemplateOverrideSchema), doc.docTemplates)) return "has a document look that isn't valid";
  }
  if (name === "salesOrders") {
    if (bad(addressSchema, doc.billTo) || bad(addressSchema, doc.shipTo)) return "has an address that isn't valid";
    for (const s of Array.isArray(doc.shipments) ? doc.shipments : []) {
      if (s?.invoice !== undefined && !canonicalInvoiceSchema.safeParse(s.invoice).success) return "has an invoice that isn't valid";
      if (s?.invoiceNumber !== undefined && (typeof s.invoiceNumber !== "string" || s.invoiceNumber.length > 40)) return "has an invoice number that isn't valid";
    }
  }
  if (name === "docLogos") {
    const img = readImage(Buffer.from((doc.bytes as Binary).buffer));
    if (!img.ok) return `has a logo that isn't valid: ${img.error}`;
    const bytes = Buffer.from((doc.bytes as Binary).buffer);
    Object.assign(doc, { contentType: img.contentType, width: img.width, height: img.height, hash: createHash("sha256").update(bytes).digest("hex") });
  }
  return null;
}
void optionalAddressSchema;

/** Checks the whole archive and turns it into documents for the target organization. Writes nothing. */
function prepare(raw: unknown, orgId: ObjectId): Prepared {
  const parsed = archiveShape.safeParse(raw);
  if (!parsed.success) throw new ArchiveError(parsed.error.issues[0]?.message ?? "That file isn't an Invintel archive.");
  const a = parsed.data;
  if (a.version !== ARCHIVE_VERSION) throw new ArchiveError(`This archive is version ${a.version}; this server reads version ${ARCHIVE_VERSION}.`);
  const unknown = Object.keys(a.data).filter((k) => !(k in ARCHIVE_COLLECTIONS));
  if (unknown.length) throw new ArchiveError(`The archive has data this version doesn't know about (${unknown.join(", ")}). It may come from a newer version.`);
  const total = NAMES.reduce((s, n) => s + (a.data[n]?.length ?? 0), 0);
  if (total > MAX_DOCS) throw new ArchiveError(`The archive has too many records (${total.toLocaleString("en-US")}).`);

  // Every id that belongs to the archive gets a new one. Anything else (a user, a record from somewhere
  // else) gets a throwaway id, so a crafted file can't point at another organization's records.
  const ids = new Map<string, ObjectId>();
  const mapId = (hex: string) => {
    let id = ids.get(hex);
    if (!id) ids.set(hex, (id = new ObjectId()));
    return id;
  };

  const docs = {} as Record<ArchiveCollection, Document[]>;
  const counts: Record<string, number> = {};
  for (const name of NAMES) {
    const seen = new Set<string>();
    docs[name] = (a.data[name] ?? []).map((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArchiveError(`${ARCHIVE_COLLECTIONS[name]}: record ${i + 1} isn't an object.`);
      const oid = (raw as { _id?: { $oid?: unknown } })._id?.$oid;
      if (typeof oid !== "string" || !OID.test(oid)) throw new ArchiveError(`${ARCHIVE_COLLECTIONS[name]}: record ${i + 1} has no valid id.`);
      if (seen.has(oid.toLowerCase())) throw new ArchiveError(`${ARCHIVE_COLLECTIONS[name]}: the same record appears twice.`);
      seen.add(oid.toLowerCase());
      const doc = fromPlain(raw, mapId, 0, name === "docLogos") as Document;
      delete doc.orgId; // never taken from the file
      if (name === "invoices") {
        // A match snapshot names items by plain text ids and a request for approval isn't archived, so neither can be carried over.
        delete doc.match;
        delete doc.approvalId;
      }
      for (const [field, t] of Object.entries(REQUIRED[name] ?? {})) {
        if (!typeOk(doc[field], t)) throw new ArchiveError(`${ARCHIVE_COLLECTIONS[name]}: record ${i + 1} is missing "${field}" or has the wrong kind of value there.`);
      }
      const problem = checkDoc(name, doc);
      if (problem) throw new ArchiveError(`${ARCHIVE_COLLECTIONS[name]}: record ${i + 1} ${problem}.`);
      return { ...doc, orgId };
    });
    counts[name] = docs[name].length;
  }

  if (docs.docLogos.length > 1) throw new ArchiveError("The archive has more than one logo.");
  // Control numbers belong to partners that came with the archive; each moves to its partner's new id.
  const counters: Record<string, number> = {};
  const partnerOids = new Set((a.data.tradingPartners ?? []).map((p) => String((p as { _id?: { $oid?: string } })._id?.$oid ?? "").toLowerCase()));
  for (const [key, seq] of Object.entries(a.counters)) {
    const [kind, hex] = key.split(":") as [string, string];
    if (partnerOids.has(hex.toLowerCase())) counters[`${kind}:${mapId(hex.toLowerCase()).toHexString()}`] = seq;
  }

  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(a.settings)) {
    const check = SETTINGS[key];
    if (!check) throw new ArchiveError(`The archive has a setting this version doesn't know ("${key}").`);
    const ok = check.safeParse(value);
    if (!ok.success) throw new ArchiveError(`The setting "${key}" in the archive isn't valid.`);
    settings[key] = ok.data;
  }

  return {
    summary: { format: ARCHIVE_FORMAT, version: a.version, exportedAt: a.exportedAt, organizationName: a.organizationName, counts, settings: Object.keys(settings) },
    docs,
    settings,
    counters,
  };
}

/** What stops an archive being restored here: only an organization with nothing in it can take one. */
async function blockedReason(store: Store, orgId: ObjectId): Promise<string | null> {
  const guards: [string, Collection<Document>][] = [
    ["items", store.items as unknown as Collection<Document>],
    ["ledger entries", store.movements as unknown as Collection<Document>],
    ["stock", store.stock as unknown as Collection<Document>],
    ["suppliers", store.suppliers as unknown as Collection<Document>],
    ["purchase orders", store.purchaseOrders as unknown as Collection<Document>],
    ["work centers", store.workCenters as unknown as Collection<Document>],
    ["recipes", store.boms as unknown as Collection<Document>],
    ["work orders", store.workOrders as unknown as Collection<Document>],
    ["counts", store.counts as unknown as Collection<Document>],
    ["approval requests", store.approvals as unknown as Collection<Document>],
    ["trading partners", store.tradingPartners as unknown as Collection<Document>],
    ["a document logo", store.docLogos as unknown as Collection<Document>],
  ];
  for (const [label, col] of guards) {
    if (await col.findOne({ orgId }, { projection: { _id: 1 } })) {
      return `This organization already has ${label}. An archive can only be restored into an organization with no data. Create a new organization (profile menu, "Create or join another") and restore there.`;
    }
  }
  return null;
}

const CHUNK = 1000;

async function apply(store: Store, orgId: ObjectId, p: Prepared): Promise<void> {
  // Only empty locations can exist here (nothing holds stock), so the archive's own replace them.
  const removedLocations = await store.locations.find({ orgId }).toArray();
  const touched: Collection<Document>[] = [];
  try {
    await store.locations.deleteMany({ orgId });
    for (const name of NAMES) {
      const docs = p.docs[name];
      if (!docs.length) continue;
      const col = SOURCES[name](store);
      touched.push(col);
      for (let i = 0; i < docs.length; i += CHUNK) await col.insertMany(docs.slice(i, i + CHUNK), { ordered: true });
    }
    if (Object.keys(p.settings).length) await store.orgs.updateOne({ _id: orgId }, { $set: p.settings });
    for (const c of COUNTERS) {
      const max = p.docs[c.collection].reduce((m, d) => {
        const n = Number(/(\d+)$/.exec(String(d[c.field] ?? ""))?.[1] ?? 0);
        return n > m ? n : m;
      }, 0);
      if (max > 0) await store.counters.updateOne({ _id: `${orgId.toHexString()}:${c.kind}` }, { $max: { seq: max } }, { upsert: true });
    }
    for (const c of NESTED_COUNTERS) {
      const max = p.docs[c.collection].flatMap(c.values).reduce((m, v) => Math.max(m, Number(/(\d+)$/.exec(v)?.[1] ?? 0)), 0);
      if (max > 0) await store.counters.updateOne({ _id: `${orgId.toHexString()}:${c.kind}` }, { $max: { seq: max } }, { upsert: true });
    }
    for (const [key, seq] of Object.entries(p.counters)) await store.counters.updateOne({ _id: `${orgId.toHexString()}:${key}` }, { $max: { seq } }, { upsert: true });
  } catch (e) {
    // Nothing is left half-restored: the organization was empty, so emptying it again is exactly the way back.
    for (const col of touched) await col.deleteMany({ orgId }).catch(() => {});
    await store.locations.deleteMany({ orgId }).catch(() => {});
    if (removedLocations.length) await store.locations.insertMany(removedLocations as LocationDoc[]).catch(() => {});
    throw e;
  }
}

export function createArchiveRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  /** Everything the organization has, as one JSON file. */
  r.get("/archive.json", requireRole("admin"), async (c) => {
    const org = c.get("org");
    const { archive, summary } = await buildArchive(store, org);
    const user = c.get("user");
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(user), action: "archive.exported",
      entity: { type: "organization", id: org._id.toHexString(), label: org.name },
      summary: `Downloaded a full archive (${Object.values(summary.counts).reduce((a, b) => a + b, 0).toLocaleString("en-US")} records)`,
      snapshot: { counts: summary.counts },
    });
    c.header("content-type", "application/json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="invintel-archive-${org.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "org"}-${new Date().toISOString().slice(0, 10)}.json"`);
    c.header("cache-control", "no-store");
    return c.body(JSON.stringify(archive));
  });

  /** Checks an archive (dryRun, the default) or restores it into this organization, which must be empty. Owner only. */
  r.post(
    "/archive/restore",
    bodyLimit({ maxSize: 96 * 1024 * 1024, onError: (c) => c.json({ error: "That archive is too big to restore through the browser." }, 413) }),
    zValidator("json", z.object({ archive: z.unknown(), dryRun: z.boolean().default(true) })),
    async (c) => {
      if (c.get("role") !== "owner") return c.json({ error: "Only the owner of the organization can restore an archive." }, 403);
      const org = c.get("org");
      const { archive, dryRun } = c.req.valid("json");

      let prepared: Prepared;
      try {
        prepared = prepare(archive, org._id);
      } catch (e) {
        if (e instanceof ArchiveError) return c.json({ error: e.message }, 400);
        throw e;
      }
      const blocked = await blockedReason(store, org._id);
      const result: ArchiveRestoreResult = { ...prepared.summary, dryRun, blocked };
      if (dryRun) return c.json(result);
      if (blocked) return c.json({ error: blocked, ...result }, 409);

      try {
        await apply(store, org._id, prepared);
      } catch (e) {
        console.error("archive restore failed", e);
        return c.json({ error: "The restore failed part way, so nothing was restored. Nothing in this organization has changed." }, 500);
      }
      await recordAudit(store, {
        orgId: org._id, actor: auditActor(c.get("user")), action: "archive.restored",
        entity: { type: "organization", id: org._id.toHexString(), label: org.name },
        summary: `Restored an archive from "${prepared.summary.organizationName}" (${prepared.summary.exportedAt.slice(0, 10)}): ${Object.values(prepared.summary.counts).reduce((a, b) => a + b, 0).toLocaleString("en-US")} records`,
        snapshot: { counts: prepared.summary.counts, settings: prepared.summary.settings },
      });
      return c.json(result, 201);
    },
  );

  return r;
}
