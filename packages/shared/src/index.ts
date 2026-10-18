import { z } from "zod";
import { altUnitsSchema, decimalsSchema, DEFAULT_UOM, unitLabelSchema, type Uom } from "./units.js";

// ---------- ids ----------

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

// ---------- organizations ----------

export const orgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const organizationNameSchema = z.string().trim().min(1, "Organization name is required").max(100);

export const organizationInputSchema = z.object({ name: organizationNameSchema });
export type OrganizationInput = z.infer<typeof organizationInputSchema>;

/** Join codes are 8 characters. People type them with spaces or dashes, so normalise first. */
export const joinCodeSchema = z
  .string()
  .transform((s) => s.replace(/[^a-z0-9]/gi, "").toUpperCase())
  .pipe(z.string().length(8, "Join codes are 8 characters"));

export const joinOrganizationInputSchema = z.object({ joinCode: joinCodeSchema });
export type JoinOrganizationInput = z.infer<typeof joinOrganizationInputSchema>;

/** What a user picks while registering: start a new organization or join an existing one. */
export const registrationOrganizationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), name: organizationNameSchema }),
  z.object({ mode: z.literal("join"), joinCode: joinCodeSchema }),
]);
export type RegistrationOrganization = z.infer<typeof registrationOrganizationSchema>;

/** Parts of the app an organization can switch off, so a small shop only sees what it uses. Everything is on by default. */
export const orgModulesSchema = z.object({ purchasing: z.boolean(), production: z.boolean() });
export type OrgModules = z.infer<typeof orgModulesSchema>;
export const orgModulesUpdateSchema = orgModulesSchema.partial().refine((m) => Object.keys(m).length > 0, "Nothing to change");
export const DEFAULT_MODULES: OrgModules = { purchasing: true, production: true };

export interface OrgSummary {
  id: string;
  name: string;
  /** The caller's role in this organization. */
  role: OrgRole;
  /** Only sent to owners and admins. */
  joinCode?: string;
  memberCount: number;
  modules: OrgModules;
  createdAt: string;
}

export interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

// ---------- auth ----------

export const registerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  organization: registrationOrganizationSchema,
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface RegisterResult {
  user: User;
  organization: OrgSummary;
}

// ---------- locations ----------

/** What a place is for. Drives floor workflows (receive into receiving, load from production, etc). */
export const locationTypeSchema = z.enum(["receiving", "storage", "wip", "production", "finished", "shipping", "quarantine"]);
export type LocationType = z.infer<typeof locationTypeSchema>;
export const LOCATION_TYPES = locationTypeSchema.options;

// Update schemas are built from these default-less fields. Zod 4 applies .default() inside
// .partial(), which would silently reset omitted fields on PATCH.
const locationFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500),
  type: locationTypeSchema,
  parentId: objectIdSchema.nullable(),
  /** Short scannable code like "A-01-03". Empty means none. */
  code: z.string().trim().max(40),
};

export const locationInputSchema = z.object({
  ...locationFields,
  description: locationFields.description.default(""),
  type: locationFields.type.default("storage"),
  parentId: locationFields.parentId.default(null),
  code: locationFields.code.default(""),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const locationUpdateSchema = z.object(locationFields).partial();
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

export interface Location {
  id: string;
  name: string;
  description: string;
  type: LocationType;
  parentId: string | null;
  code: string;
  /** Ancestors and this location, e.g. "Plant 1 / Roll storage / A-01". */
  path: string;
  /** Distinct items with stock in this location itself (not its children). */
  skuCount: number;
  /** Total units in this location itself. */
  unitCount: number;
  createdAt: string;
}

// ---------- items and stock ----------

/** A code printed on the product or its packaging. Separate from the SKU, which is ours. */
export const barcodeSchema = z.string().trim().min(1).max(64);

const itemFields = {
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  category: z.string().trim().max(100),
  reorderLevel: z.number().int().min(0),
  unitCostCents: z.number().int().min(0),
  /** "unit" items (rolls, pallets) are held as individually labelled units with their own remaining quantity. */
  tracking: z.enum(["quantity", "unit"]),
  /**
   * How the stored whole-number quantities read: 12500 with unit "kg" and 3 decimals is 12.500 kg.
   * Decimals are fixed once an item has any stock or history (see units.ts).
   */
  unit: unitLabelSchema,
  decimals: decimalsSchema,
  /** Other units this item is bought or counted in (case = 12 each). Used to convert at receiving. */
  altUnits: altUnitsSchema,
  /** Product barcodes that identify this item when scanned. An item can have several (each, case, pallet). */
  barcodes: z.array(barcodeSchema).max(20).transform((codes) => [...new Set(codes)]),
};

export const itemInputSchema = z.object({
  ...itemFields,
  description: itemFields.description.default(""),
  category: itemFields.category.default(""),
  reorderLevel: itemFields.reorderLevel.default(0),
  unitCostCents: itemFields.unitCostCents.default(0),
  barcodes: itemFields.barcodes.default([]),
  tracking: itemFields.tracking.default("quantity"),
  unit: itemFields.unit.default(DEFAULT_UOM.unit),
  decimals: itemFields.decimals.default(DEFAULT_UOM.decimals),
  altUnits: itemFields.altUnits.default([]),
});
export type ItemInput = z.infer<typeof itemInputSchema>;

export const itemCreateSchema = itemInputSchema.extend({
  initialStock: z
    .object({ locationId: objectIdSchema, quantity: z.number().int().positive() })
    .optional(),
});
export type ItemCreate = z.infer<typeof itemCreateSchema>;

export const itemUpdateSchema = z.object(itemFields).partial();
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;

export interface StockLevel {
  locationId: string;
  quantity: number;
}

export interface Item extends ItemInput {
  id: string;
  /** Total across all locations. */
  quantity: number;
  /** Only locations that hold stock. */
  stock: StockLevel[];
  createdAt: string;
  updatedAt: string;
}

export const adjustmentInputSchema = z.object({
  locationId: objectIdSchema,
  delta: z.number().int().refine((n) => n !== 0, "Change must not be 0"),
  reason: z.string().trim().max(200).default(""),
});
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

export const transferInputSchema = z
  .object({
    fromLocationId: objectIdSchema,
    toLocationId: objectIdSchema,
    quantity: z.number().int().positive(),
    reason: z.string().trim().max(200).default(""),
  })
  .refine((t) => t.fromLocationId !== t.toLocationId, {
    message: "Pick two different locations",
    path: ["toLocationId"],
  });
export type TransferInput = z.infer<typeof transferInputSchema>;

export const movementTypeSchema = z.enum(["receive", "adjust", "transfer", "reversal", "load", "consume", "produce", "scrap"]);
export type MovementType = z.infer<typeof movementTypeSchema>;
export const MOVEMENT_TYPES = movementTypeSchema.options;

export interface StockMovement {
  id: string;
  type: MovementType;
  itemId: string;
  locationId: string;
  delta: number;
  reason: string;
  /** Name of whoever made the change, as it was at the time. */
  userName: string;
  /** Set on both halves of a transfer. */
  transferId?: string;
  createdAt: string;
}

// ---------- floor documents ----------

export const receiveInputSchema = z.object({
  itemId: objectIdSchema,
  locationId: objectIdSchema,
  quantity: z.number().int().positive(),
  /** Free text: PO number, delivery note, supplier. */
  reference: z.string().trim().max(200).default(""),
  /** The supplier's lot or batch number from the label, kept on the ledger line for traceability. */
  supplierLot: z.string().trim().max(64).default(""),
  /** Inspect before release: the received stock goes straight on quality hold ("Awaiting inspection"). */
  inspect: z.boolean().default(false),
});
export type ReceiveInput = z.infer<typeof receiveInputSchema>;

export const moveInputSchema = z
  .object({
    itemId: objectIdSchema,
    fromLocationId: objectIdSchema,
    toLocationId: objectIdSchema,
    quantity: z.number().int().positive(),
    reason: z.string().trim().max(200).default(""),
  })
  .refine((m) => m.fromLocationId !== m.toLocationId, {
    message: "Pick two different locations",
    path: ["toLocationId"],
  });
export type MoveInput = z.infer<typeof moveInputSchema>;

/** Result of posting a floor document. Ids let the client offer "undo". */
export interface PostedDocument {
  item: Item;
  movementIds: string[];
  /** Holds opened by "inspect before release". */
  ncrs?: { id: string; number: string }[];
}

/** What a scanned code resolved to. Items match by SKU; locations by code or name. */
export type LookupResult =
  | { kind: "item"; item: Item }
  | { kind: "location"; location: Location }
  | { kind: "unit"; unit: StockUnit }
  | { kind: "none" };

// ---------- activity (the ledger) ----------

export interface ActivityEntry {
  id: string;
  /** The roll or pallet this entry is about, for unit-tracked items. */
  unitCode?: string;
  type: MovementType;
  itemId: string;
  itemSku: string;
  itemName: string;
  /** How this item's whole-number quantities read. */
  uom: Uom;
  locationId: string;
  locationName: string;
  locationPath: string;
  delta: number;
  reason: string;
  userName: string;
  /** The supplier's lot number, when the receipt recorded one. */
  supplierLot?: string;
  /** Set on both halves of a transfer. */
  transferId?: string;
  /** Set on a reversal: the movement it undoes. */
  reversalOf?: string;
  /** Set on an original that has been reversed. */
  reversed: boolean;
  /** Whether the current user may reverse this entry right now. */
  canReverse: boolean;
  createdAt: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /** Pass as `before` to get the next page. Absent when there is no more. */
  nextBefore?: string;
}

export const reverseInputSchema = z.object({
  reason: z.string().trim().max(200).default(""),
});
export type ReverseInput = z.infer<typeof reverseInputSchema>;

/**
 * UPC-A (12 digits), EAN-13 and GTIN-14 are one numbering system padded with different numbers of
 * leading zeros, and scanners disagree about which form to report (browsers' native detector
 * says 12 digits for UPC-A, ZXing says 13). Returns the forms that mean the same product.
 * Anything that isn't 8-14 digits is returned as is.
 */
export function gtinVariants(code: string): string[] {
  if (!/^\d{8,14}$/.test(code)) return [code];
  const stripped = code.replace(/^0+/, "");
  const forms = new Set([code]);
  for (const length of [12, 13, 14]) {
    if (stripped.length <= length) forms.add(stripped.padStart(length, "0"));
  }
  return [...forms];
}

// ---------- audit log ----------

export const AUDIT_ENTITY_TYPES = ["item", "location", "organization", "member", "ncr", "work_center", "bom", "work_order", "supplier", "purchase_order", "count", "approval", "alert"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  "item.created",
  "item.updated",
  "item.deleted",
  "location.created",
  "location.updated",
  "location.deleted",
  "organization.created",
  "organization.renamed",
  "organization.modules_changed",
  "organization.join_code_rotated",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "member.left",
  "count.started",
  "count.posted",
  "count.cancelled",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.cancelled",
  "approval.rules_changed",
  "downtime.started",
  "downtime.ended",
  "downtime.settings_changed",
  "reasons.changed",
  "traceability.drill",
  "ncr.opened",
  "ncr.dispositioned",
  "alert.acknowledged",
  "alert.snoozed",
  "alert.reopened",
  "alert.settings_changed",
  "supplier.created",
  "supplier.updated",
  "purchase_order.created",
  "purchase_order.updated",
  "purchase_order.ordered",
  "purchase_order.received",
  "purchase_order.cancelled",
  "purchase_order.closed",
  "stock.received",
  "stock.adjusted",
  "stock.moved",
  "stock.reversed",
  "work_center.created",
  "work_center.updated",
  "bom.created",
  "work_order.created",
  "work_order.released",
  "work_order.completed",
  "work_order.cancelled",
  "work_order.approved",
  "production.settings_changed",
  "production.loaded",
  "production.consumed",
  "production.output",
  "import.applied",
  "import.undone",
  "archive.exported",
  "archive.restored",
  "api_key.created",
  "api_key.revoked",
  "webhook.created",
  "webhook.updated",
  "webhook.deleted",
  "webhook.secret_rotated",
  "webhook.disabled",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEvent {
  id: string;
  /** Position in this organization's chain, starting at 1 with no gaps. */
  seq: number;
  at: string;
  actor: { id: string | null; name: string };
  action: AuditAction;
  entity: { type: AuditEntityType; id: string; label: string };
  /** One line a person can read: "Changed unit cost from $1.00 to $1.25". */
  summary: string;
  changes?: AuditChange[];
  /** Full state at creation or deletion. */
  snapshot?: Record<string, unknown>;
  /** Links to related records, e.g. the ledger entries behind a stock event. */
  refs?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Pass as `before` to get older events. Absent when there are none. */
  nextBefore?: number;
}

export interface AuditVerification {
  ok: boolean;
  /** Events checked. */
  checked: number;
  headSeq: number;
  /** Fingerprint of the whole history so far. Record it somewhere else to detect truncation later. */
  headHash: string;
  /** Where the chain first stops adding up, if it does. */
  problem?: { seq: number; reason: string };
  /** Ledger entries made after the audit log began that no audit event refers to. */
  ledgerGaps: number;
}

/** Friendly names for fields that show up in audit diffs. */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  sku: "SKU",
  name: "name",
  description: "description",
  category: "category",
  reorderLevel: "reorder level",
  unitCostCents: "unit cost",
  barcodes: "barcodes",
  unit: "unit of measure",
  decimals: "decimal places",
  altUnits: "other units",
  type: "type",
  code: "code",
  parent: "location it's inside",
};

/** One value from an audit diff, as text. Used for both the stored summaries and the screen. */
export function formatAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (field === "unitCostCents" && typeof value === "number") return `$${(value / 100).toFixed(2)}`;
  if (field === "altUnits" && Array.isArray(value)) {
    return value.length ? value.map((u: { name?: string; factor?: string }) => `${u.name} = ${u.factor}`).join(", ") : "none";
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

// ---------- overview ----------

export type AttentionStatus = "out" | "low";

/** An item that needs reordering or moving: out of stock, or at/under its reorder level. */
export interface AttentionItem {
  id: string;
  sku: string;
  name: string;
  /** How this item's whole-number quantities read. */
  uom: Uom;
  quantity: number;
  reorderLevel: number;
  status: AttentionStatus;
}

export interface TypeTotal {
  type: LocationType;
  locations: number;
  units: number;
  valueCents: number;
}

/** The "what needs attention" summary on the Overview page. */
export interface Overview {
  items: number;
  locations: number;
  units: number;
  valueCents: number;
  outCount: number;
  lowCount: number;
  /** Out of stock first, then lowest relative to the reorder level. Capped at 10. */
  attention: AttentionItem[];
  /** Stock in each kind of place, so the plant can see how much is in receiving, at machines, and so on. */
  byType: TypeTotal[];
  /** Entries in the last 24 hours. */
  movements24h: number;
  /** Stock sitting in receiving locations: arrived but not yet put away. */
  awaitingPutaway: number;
}

// ---------- member management ----------

/** Owners can't be demoted or created here: an organization has exactly the owner it was started with. */
export const memberRoleInputSchema = z.object({ role: z.enum(["admin", "member"]) });
export type MemberRoleInput = z.infer<typeof memberRoleInputSchema>;

// ---------- CSV import ----------

/** The columns an import understands. A file's columns are matched to these by header name, or by the person's own mapping. */
export const IMPORT_FIELDS = ["sku", "name", "category", "description", "reorder", "cost", "barcodes", "location", "quantity", "unit", "decimals"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  sku: "SKU",
  name: "Name",
  category: "Category",
  description: "Notes",
  reorder: "Reorder level",
  cost: "Unit cost",
  barcodes: "Barcodes",
  location: "Location",
  quantity: "Quantity",
  unit: "Unit of measure",
  decimals: "Decimal places",
};

/** create: only new SKUs. update: only change SKUs that exist. upsert: both. Stock is only ever set up for new items. */
export const importModeSchema = z.enum(["create", "update", "upsert"]);
export type ImportMode = z.infer<typeof importModeSchema>;

export type ImportRowStatus = "create" | "update" | "stock" | "skip" | "error";

export interface ImportChange {
  field: string;
  from: string;
  to: string;
}

export interface ImportRow {
  /** 1-based line in the file, counting the header as line 1. */
  line: number;
  sku: string;
  status: ImportRowStatus;
  message: string;
  /** For updates: what would change, field by field. */
  changes?: ImportChange[];
  /** The row as it was in the file, kept on error rows so they can be fixed and re-uploaded. */
  cells?: string[];
}

export interface ImportResult {
  /** True when nothing was written: this is the preview. */
  dryRun: boolean;
  rows: ImportRow[];
  itemsToCreate: number;
  itemsToUpdate: number;
  stockLines: number;
  units: number;
  skipped: number;
  errors: number;
  /** The file's header row. */
  headers: string[];
  /** Which column (0-based) each field was read from. Only fields that were found. */
  mapping: Partial<Record<ImportField, number>>;
  /** The first few rows of the file, so a mapping can be checked by eye. */
  sample: string[][];
  /** Fields the import can't go on without that no column is mapped to yet (SKU, and name when creating). */
  needs?: ImportField[];
  /** Set once applied: the batch that can be undone. */
  batchId?: string;
}

export const importInputSchema = z.object({
  csv: z.string().max(2_000_000),
  dryRun: z.boolean().default(true),
  mode: importModeSchema.default("create"),
  /** Column for each field. Leave out to match by header name. Anything not listed is not read. */
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(500)).optional(),
  /** stop: any problem row blocks everything. skip: import the good rows and report the rest. */
  onErrors: z.enum(["stop", "skip"]).default("stop"),
  /** Shown in the import history. */
  filename: z.string().trim().max(200).default(""),
});
export type ImportInput = z.input<typeof importInputSchema>;

export interface ImportBatch {
  id: string;
  number: string;
  at: string;
  userName: string;
  filename: string;
  mode: ImportMode;
  created: number;
  updated: number;
  /** Set once undone. */
  undoneAt: string | null;
  undoneBy: string | null;
}

export interface ImportUndoResult {
  batch: ImportBatch;
  /** Items removed (they were created by the import). */
  removed: number;
  /** Items put back the way they were. */
  restored: number;
}

// ---------- stock units (rolls, pallets) ----------

export const unitStatusSchema = z.enum(["available", "quarantined", "consumed"]);
export type UnitStatus = z.infer<typeof unitStatusSchema>;

export interface StockUnit {
  id: string;
  /** What's printed on the label and read by a scanner. */
  code: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  /** How this item's whole-number quantities read (kg with 3 decimals, each with 0). */
  uom: Uom;
  lot: string;
  /** What's left. Shrinks as the unit is used. */
  quantity: number;
  initialQuantity: number;
  locationId: string;
  locationPath: string;
  status: UnitStatus;
  createdAt: string;
}

export const receiveUnitsInputSchema = z
  .object({
    itemId: objectIdSchema,
    locationId: objectIdSchema,
    /** Quantity in each unit (e.g. kg on a roll). */
    quantity: z.number().int().positive(),
    /** How many identical units arrived. */
    count: z.number().int().min(1).max(200).default(1),
    lot: z.string().trim().max(64).default(""),
    /** Pre-printed labels to use, one per unit. Otherwise codes are generated. */
    codes: z.array(z.string().trim().min(1).max(64)).max(200).optional(),
    reference: z.string().trim().max(200).default(""),
    /** Inspect before release: every unit received goes straight on quality hold. */
    inspect: z.boolean().default(false),
  })
  .refine((v) => !v.codes || v.codes.length === v.count, { message: "Give one code per unit", path: ["codes"] });
export type ReceiveUnitsInput = z.infer<typeof receiveUnitsInputSchema>;

export const moveUnitInputSchema = z.object({
  toLocationId: objectIdSchema,
  reason: z.string().trim().max(200).default(""),
});
export type MoveUnitInput = z.infer<typeof moveUnitInputSchema>;

export const adjustUnitInputSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, "Change must not be 0"),
  reason: z.string().trim().max(200).default(""),
});
export type AdjustUnitInput = z.infer<typeof adjustUnitInputSchema>;

export interface UnitsPage {
  units: StockUnit[];
  nextBefore?: string;
}

export interface UnitsPosted {
  units: StockUnit[];
  movementIds: string[];
  ncrs?: { id: string; number: string }[];
}
export * from "./production.js";
export * from "./quality.js";
export * from "./reasons.js";
export * from "./traceability.js";
export * from "./scrap.js";
export * from "./purchasing.js";
export * from "./counts.js";
export * from "./reports.js";
export * from "./approvals.js";
export * from "./downtime.js";
export * from "./alerts.js";
export * from "./units.js";
export * from "./archive.js";
export * from "./integrations.js";
