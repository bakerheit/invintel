import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { AuditAction, AuditChange, AuditEntityType, LocationType, MovementType, OrgRole, WorkOrderStatus } from "@invintel/shared";

export interface UserDoc {
  _id: ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface SessionDoc {
  _id: string; // sha256 of the cookie token
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

export interface OrgDoc {
  _id: ObjectId;
  /** Production: variance over this percentage on a done work order needs sign-off. Absent or null means off. */
  varianceThresholdPct?: number | null;
  name: string;
  joinCode: string;
  createdBy: ObjectId;
  /** Absent means everything is on. */
  modules?: Partial<{ purchasing: boolean; production: boolean }>;
  /** Absent means nothing needs a second person. */
  /** Downtime: the pick-list and the hours a machine is meant to run each day. Defaults apply when absent. */
  /** Pick-lists for scrap and quality-hold reasons. Defaults apply when absent. */
  scrapReasons?: string[];
  holdReasons?: string[];
  downtimeReasons?: string[];
  scheduledHoursPerDay?: number;
  alertSettings?: { daysOfSupply: number; machineDownMinutes: number };
  approvalRules?: { kind: "adjustment" | "purchase_order"; thresholdCents: number; appliesTo: "members" | "everyone" }[];
  createdAt: Date;
}

export interface MembershipDoc {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  role: OrgRole;
  createdAt: Date;
}

export interface LocationDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  description: string;
  /** Older documents predate these three; readers must default them. */
  type?: LocationType;
  parentId?: ObjectId | null;
  code?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemDoc {
  _id: ObjectId;
  orgId: ObjectId;
  sku: string;
  name: string;
  description: string;
  category: string;
  reorderLevel: number;
  unitCostCents: number;
  /** Absent on items created before barcodes existed. */
  barcodes?: string[];
  /** Absent means "quantity". Unit-tracked items hold stock only as StockUnitDocs. */
  tracking?: "quantity" | "unit";
  /** How stored whole-number quantities read (see shared units.ts). Absent means each, 0 decimals. */
  unit?: string;
  decimals?: number;
  altUnits?: { name: string; factor: string }[];
  createdAt: Date;
  updatedAt: Date;
}

/** One applied CSV import, kept so it can be undone while nothing has built on it. */
export interface ImportBatchDoc {
  _id: ObjectId;
  orgId: ObjectId;
  /** IMP-0001, in order per organization. */
  number: string;
  at: Date;
  userId: ObjectId;
  userName: string;
  filename: string;
  mode: "create" | "update" | "upsert";
  /** Items this import made, with the ledger lines that put their opening stock in. */
  created: { itemId: ObjectId; sku: string; name: string; movementIds: ObjectId[] }[];
  /** Items this import changed: the fields as they were and as the import left them. */
  updated: { itemId: ObjectId; sku: string; name: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  undoneAt?: Date;
  undoneBy?: string;
}

/** How many units of one item sit in one location. Total quantity is the sum of these. */
export interface StockDoc {
  _id: ObjectId;
  orgId: ObjectId;
  itemId: ObjectId;
  locationId: ObjectId;
  quantity: number;
  updatedAt: Date;
}

/** One physical roll or pallet with its own label and remaining quantity. */
export interface StockUnitDoc {
  _id: ObjectId;
  orgId: ObjectId;
  itemId: ObjectId;
  code: string;
  lot: string;
  quantity: number;
  initialQuantity: number;
  locationId: ObjectId;
  status: "available" | "quarantined" | "consumed";
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementDoc {
  _id: ObjectId;
  orgId: ObjectId;
  /** The supplier's lot or batch number, on receipts that recorded one. */
  supplierLot?: string;
  /** Set on lines that belong to a quality hold; Activity won't reverse them (use the NCR). */
  ncrId?: ObjectId;
  /** The pick-list reason on scrap lines (and holds), so reports can group by it. */
  reasonCode?: string;
  /** The work order that caused this movement, if any. */
  workOrderId?: ObjectId;
  /** Set when the movement is about one specific roll or pallet. */
  unitId?: ObjectId;
  unitCode?: string;
  /** Absent on movements recorded before types existed. Use movementType() to read. */
  type?: MovementType;
  itemId: ObjectId;
  locationId: ObjectId;
  delta: number;
  reason: string;
  userId?: ObjectId;
  userName: string;
  transferId?: ObjectId;
  /** On a reversal: the movement it undoes. */
  reversalOf?: ObjectId;
  /** On an original: the reversal that undid it. */
  reversedBy?: ObjectId;
  /** Receipts made against a purchase order carry it, so arrivals can be read back from the ledger. */
  purchaseOrderId?: ObjectId;
  createdAt: Date;
}

export const movementType = (m: MovementDoc): MovementType =>
  m.type ?? (m.transferId ? "transfer" : m.reason === "Initial stock" ? "receive" : "adjust");

/**
 * Append-only history of everything that changes in an organization. Each event carries the hash
 * of the one before it, so editing or removing an event breaks the chain.
 */
export interface AuditEventDoc {
  _id: ObjectId;
  orgId: ObjectId;
  seq: number;
  at: Date;
  actor: { id: ObjectId | null; name: string };
  action: AuditAction;
  entity: { type: AuditEntityType; id: string; label: string };
  summary: string;
  changes?: AuditChange[];
  snapshot?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface WorkCenterDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  code: string;
  description: string;
  locationId: ObjectId;
  active: boolean;
  createdAt: Date;
}

export interface BomDoc {
  _id: ObjectId;
  orgId: ObjectId;
  outputItemId: ObjectId;
  outputQuantity: number;
  yieldPct: number;
  inputs: { itemId: ObjectId; quantity: number; scrapPct: number }[];
  note: string;
  version: number;
  status: "active" | "retired";
  createdAt: Date;
}

export interface WorkOrderDoc {
  _id: ObjectId;
  orgId: ObjectId;
  number: string;
  status: WorkOrderStatus;
  bomId: ObjectId;
  bomVersion: number;
  outputItemId: ObjectId;
  quantity: number;
  workCenterId: ObjectId;
  dueDate: string | null;
  note: string;
  /** Snapshot taken when the order was made, so a later BOM version can't change an open order. */
  requirements: { itemId: ObjectId; expected: number }[];
  approval?: { userId: ObjectId; userName: string; at: Date; note: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  contact: string;
  email: string;
  phone: string;
  notes: string;
  createdAt: Date;
}

export interface PurchaseOrderDoc {
  _id: ObjectId;
  orgId: ObjectId;
  number: string;
  /** Draft until placed. "closed" means done even if short. Arrival is read from the ledger, not stored here. */
  state: "draft" | "ordered" | "closed" | "cancelled";
  supplierId: ObjectId;
  expectedDate: string | null;
  note: string;
  /** Set for a few seconds while stock is being received, so a cancel or close can't slip in between the check and the posting. */
  receivingUntil?: Date;
  lines: { itemId: ObjectId; quantity: number; unitCostCents: number }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CountDoc {
  _id: ObjectId;
  orgId: ObjectId;
  number: string;
  status: "open" | "posted" | "cancelled";
  locationId: ObjectId;
  note: string;
  startedBy: { id: ObjectId; name: string };
  startedAt: Date;
  postedAt?: Date;
  lines: { itemId: ObjectId; counted: number; expectedAtPost?: number }[];
}

export interface ApprovalDoc {
  _id: ObjectId;
  orgId: ObjectId;
  number: string;
  kind: "adjustment" | "purchase_order";
  status: "pending" | "approved" | "rejected" | "cancelled" | "failed";
  summary: string;
  valueCents: number;
  /** What to do when approved. Kept as plain ids and numbers. */
  payload: { itemId?: ObjectId; locationId?: ObjectId; delta?: number; reason?: string; orderId?: ObjectId };
  subject: { type: "item" | "purchase_order"; id: string; label: string };
  requestedBy: { id: ObjectId; name: string };
  requestedAt: Date;
  decidedBy?: { id: ObjectId; name: string };
  decidedAt?: Date;
  note: string;
  failure?: string;
}

export interface DowntimeDoc {
  _id: ObjectId;
  orgId: ObjectId;
  workCenterId: ObjectId;
  reason: string;
  note: string;
  startedAt: Date;
  endedAt?: Date;
  /** True while the machine is down. Removed when it ends. A partial index needs a real field to match on. */
  open?: true;
  startedBy: { id: ObjectId; name: string };
  endedBy?: { id: ObjectId; name: string };
}

export interface AlertStateDoc {
  _id: ObjectId;
  orgId: ObjectId;
  key: string;
  state: "acknowledged" | "snoozed";
  until?: Date;
  by: { id: ObjectId; name: string };
  at: Date;
}

export interface NcrDoc {
  _id: ObjectId;
  orgId: ObjectId;
  number: string;
  status: "open" | "closed";
  source: "manual" | "receiving";
  itemId: ObjectId;
  unitId?: ObjectId;
  unitCode?: string;
  /** Where the stock was before the hold. */
  fromLocationId: ObjectId;
  /** Where it is held: the hold area for plain stock, the unit's own place for a labelled unit. */
  heldLocationId: ObjectId;
  quantity: number;
  remaining: number;
  supplierLot: string;
  purchaseOrderId?: ObjectId;
  reason: string;
  note: string;
  heldBy: { id: ObjectId; name: string };
  heldAt: Date;
  closedAt?: Date;
  dispositions: {
    type: "use" | "rework" | "scrap" | "return";
    quantity: number;
    toLocationId?: ObjectId;
    reason: string;
    note: string;
    by: { id: ObjectId; name: string };
    at: Date;
  }[];
}

export interface DrillDoc {
  _id: ObjectId;
  orgId: ObjectId;
  at: Date;
  by: { id: ObjectId; name: string };
  direction: "forward" | "backward";
  query: string;
  tookMs: number;
  units: number;
  stillInStock: number;
  workOrders: number;
  locations: number;
  hasInferred: boolean;
}

export interface TradingPartnerDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  kind: "supplier" | "customer";
  supplierId: ObjectId | null;
  identifiers: { scheme: string; value: string }[];
  bridge: string;
  bridgeConfig: Record<string, string>;
  mode: "test" | "live";
  enabled: boolean;
  contactEmail: string;
  note: string;
  createdAt: Date;
}

export interface B2BMessageDoc {
  _id: ObjectId;
  orgId: ObjectId;
  partnerId: ObjectId;
  direction: "out" | "in";
  docType: import("@invintel/shared").B2BDocType;
  state: import("@invintel/shared").B2BState;
  idempotencyKey: string;
  correlation: { poId?: string; poNumber?: string; invoiceId?: string; shipmentId?: string; partnerRef?: string; controlNumber?: string };
  /** The document exactly as carried. Never changed after it is written. */
  raw: { body: string; contentType: string; hash: string; bytes: number };
  providerMessageId?: string;
  attempts: { at: Date; ok: boolean; error: string; retryable: boolean }[];
  acks: { level: "transport" | "functional" | "business"; result: "accepted" | "rejected"; detail: string; at: Date }[];
  createdBy: { id: ObjectId; name: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface ExchangeIdentityDoc {
  _id: ObjectId;
  orgId: ObjectId;
  exchangeId: string;
  publicKey: string;
  /** Sealed with EXCHANGE_KEY_SECRET when that is set. */
  privateKey: string;
  baseUrl: string;
  createdAt: Date;
}

export interface PortalLinkDoc {
  _id: ObjectId;
  orgId: ObjectId;
  partnerId: ObjectId;
  poId: ObjectId;
  /** The message that carried the link; set once it exists. */
  messageId?: ObjectId;
  /** Only a hash is kept: the link itself exists in the sent document and the supplier's inbox. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface CapturedInvoiceDoc {
  _id: ObjectId;
  orgId: ObjectId;
  status: "captured" | "converted" | "discarded";
  partnerId: ObjectId;
  messageId: ObjectId;
  source: "email" | "upload" | "json" | "ubl" | "x12";
  from: string;
  subject: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  dueDate: string | null;
  poNumber: string;
  totalCents: number | null;
  taxCents: number;
  currency: string;
  lines: { description: string; quantity: string; unitPriceCents: number; lineTotalCents: number }[];
  confidence: Record<"invoiceNumber" | "invoiceDate" | "dueDate" | "poNumber" | "totalCents", "read" | "guess" | "entered" | "missing">;
  fileIds: ObjectId[];
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

/** An attachment kept with a captured invoice. Served only as a download, never rendered. */
export interface B2BFileDoc {
  _id: ObjectId;
  orgId: ObjectId;
  messageId: ObjectId;
  filename: string;
  contentType: string;
  data: import("mongodb").Binary;
  bytes: number;
  hash: string;
  createdAt: Date;
}

export interface Store {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  orgs: Collection<OrgDoc>;
  memberships: Collection<MembershipDoc>;
  locations: Collection<LocationDoc>;
  items: Collection<ItemDoc>;
  stock: Collection<StockDoc>;
  movements: Collection<MovementDoc>;
  audit: Collection<AuditEventDoc>;
  units: Collection<StockUnitDoc>;
  workCenters: Collection<WorkCenterDoc>;
  boms: Collection<BomDoc>;
  workOrders: Collection<WorkOrderDoc>;
  suppliers: Collection<SupplierDoc>;
  purchaseOrders: Collection<PurchaseOrderDoc>;
  counts: Collection<CountDoc>;
  approvals: Collection<ApprovalDoc>;
  downtime: Collection<DowntimeDoc>;
  alertStates: Collection<AlertStateDoc>;
  importBatches: Collection<ImportBatchDoc>;
  counters: Collection<{ _id: string; seq: number }>;
  ncrs: Collection<NcrDoc>;
  tradingPartners: Collection<TradingPartnerDoc>;
  exchangeIdentities: Collection<ExchangeIdentityDoc>;
  b2bMessages: Collection<B2BMessageDoc>;
  portalLinks: Collection<PortalLinkDoc>;
  capturedInvoices: Collection<CapturedInvoiceDoc>;
  b2bFiles: Collection<B2BFileDoc>;
  drills: Collection<DrillDoc>;
  close: () => Promise<void>;
}

// SKUs and location names are unique per organization, ignoring case.
const caseInsensitive = { locale: "en", strength: 2 } as const;

export async function connect(
  uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017",
  dbName = process.env.MONGODB_DB ?? "invintel",
): Promise<Store> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(dbName);
  const store: Store = {
    client,
    db,
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    orgs: db.collection("organizations"),
    memberships: db.collection("memberships"),
    locations: db.collection("locations"),
    items: db.collection("items"),
    stock: db.collection("stock"),
    movements: db.collection("stock_movements"),
    audit: db.collection("audit_events"),
    units: db.collection("stock_units"),
    workCenters: db.collection("work_centers"),
    boms: db.collection("boms"),
    workOrders: db.collection("work_orders"),
    suppliers: db.collection("suppliers"),
    purchaseOrders: db.collection("purchase_orders"),
    counts: db.collection("counts"),
    approvals: db.collection("approvals"),
    downtime: db.collection("downtime"),
    alertStates: db.collection("alert_states"),
    importBatches: db.collection("import_batches"),
    counters: db.collection("counters"),
    ncrs: db.collection("ncrs"),
    tradingPartners: db.collection("trading_partners"),
    exchangeIdentities: db.collection("exchange_identities"),
    b2bMessages: db.collection("b2b_messages"),
    portalLinks: db.collection("b2b_portal_links"),
    capturedInvoices: db.collection("captured_invoices"),
    b2bFiles: db.collection("b2b_files"),
    drills: db.collection("recall_drills"),
    close: () => client.close(),
  };

  // Before organizations existed SKUs were unique across the whole database.
  await store.items.dropIndex("sku_1").catch(() => {});
  // Location names used to be unique per org; with a hierarchy they're unique per parent.
  await store.locations.dropIndex("orgId_1_name_1").catch(() => {});

  await Promise.all([
    store.users.createIndex({ email: 1 }, { unique: true }),
    store.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    store.orgs.createIndex({ joinCode: 1 }, { unique: true }),
    store.memberships.createIndex({ orgId: 1, userId: 1 }, { unique: true }),
    store.memberships.createIndex({ userId: 1 }),
    store.locations.createIndex({ orgId: 1, parentId: 1, name: 1 }, { unique: true, collation: caseInsensitive }),
    // Codes are optional ("" means none), so only non-empty ones must be unique.
    store.locations.createIndex(
      { orgId: 1, code: 1 },
      { unique: true, collation: caseInsensitive, partialFilterExpression: { code: { $gt: "" } } },
    ),
    store.items.createIndex({ orgId: 1, sku: 1 }, { unique: true, collation: caseInsensitive }),
    // A barcode can only point at one item. Items without barcodes are left out of the index.
    store.items.createIndex(
      { orgId: 1, barcodes: 1 },
      { unique: true, collation: caseInsensitive, partialFilterExpression: { barcodes: { $type: "string" } } },
    ),
    store.stock.createIndex({ itemId: 1, locationId: 1 }, { unique: true }),
    store.stock.createIndex({ orgId: 1, locationId: 1 }),
    store.movements.createIndex({ itemId: 1, createdAt: -1 }),
    store.movements.createIndex({ orgId: 1, _id: -1 }),
    store.movements.createIndex({ transferId: 1 }, { sparse: true }),
    store.units.createIndex({ orgId: 1, code: 1 }, { unique: true, collation: caseInsensitive }),
    store.units.createIndex({ orgId: 1, itemId: 1, status: 1 }),
    store.units.createIndex({ orgId: 1, locationId: 1, status: 1 }),
    // seq is unique per org: that's what stops two simultaneous writers both claiming the same link.
    store.audit.createIndex({ orgId: 1, seq: 1 }, { unique: true }),
    store.audit.createIndex({ orgId: 1, "entity.type": 1, "entity.id": 1, seq: -1 }),
    store.audit.createIndex({ orgId: 1, action: 1, seq: -1 }),
    store.movements.createIndex({ workOrderId: 1 }, { sparse: true }),
    store.workCenters.createIndex({ orgId: 1, name: 1 }, { unique: true, collation: caseInsensitive }),
    store.workCenters.createIndex(
      { orgId: 1, code: 1 },
      { unique: true, collation: caseInsensitive, partialFilterExpression: { code: { $gt: "" } } },
    ),
    store.boms.createIndex({ orgId: 1, outputItemId: 1, version: 1 }, { unique: true }),
    store.workOrders.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.workOrders.createIndex({ orgId: 1, status: 1 }),
    store.ncrs.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.ncrs.createIndex({ orgId: 1, status: 1, heldAt: -1 }),
    store.ncrs.createIndex({ unitId: 1 }, { sparse: true }),
    store.tradingPartners.createIndex({ orgId: 1, name: 1 }, { unique: true, collation: caseInsensitive }),
    store.exchangeIdentities.createIndex({ orgId: 1 }, { unique: true }),
    store.exchangeIdentities.createIndex({ exchangeId: 1 }, { unique: true }),
    // The same key from the same partner in the same direction is the same document.
    store.b2bMessages.createIndex({ orgId: 1, partnerId: 1, direction: 1, idempotencyKey: 1 }, { unique: true }),
    store.b2bMessages.createIndex({ orgId: 1, createdAt: -1 }),
    store.b2bMessages.createIndex({ orgId: 1, "correlation.poId": 1 }, { sparse: true }),
    store.portalLinks.createIndex({ tokenHash: 1 }, { unique: true }),
    store.portalLinks.createIndex({ orgId: 1, poId: 1 }),
    store.capturedInvoices.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    store.capturedInvoices.createIndex({ orgId: 1, partnerId: 1, invoiceNumber: 1 }),
    store.b2bFiles.createIndex({ orgId: 1, messageId: 1 }),
    store.drills.createIndex({ orgId: 1, at: -1 }),
    // Trace lookups: lines of one work order, of one unit, and receipts by lot.
    store.movements.createIndex({ unitId: 1, createdAt: 1 }, { sparse: true }),
    store.movements.createIndex({ orgId: 1, supplierLot: 1 }, { sparse: true }),
    store.units.createIndex({ orgId: 1, lot: 1 }, { collation: caseInsensitive }),
    store.suppliers.createIndex({ orgId: 1, name: 1 }, { unique: true, collation: caseInsensitive }),
    store.purchaseOrders.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.purchaseOrders.createIndex({ orgId: 1, state: 1 }),
    store.counts.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.importBatches.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.importBatches.createIndex({ orgId: 1, at: -1 }),
    store.approvals.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.alertStates.createIndex({ orgId: 1, key: 1 }, { unique: true }),
    store.downtime.createIndex({ orgId: 1, workCenterId: 1, startedAt: -1 }),
    // One machine can only be down once at a time.
    store.downtime.createIndex({ orgId: 1, workCenterId: 1 }, { unique: true, partialFilterExpression: { open: true } }),
    store.approvals.createIndex({ orgId: 1, status: 1, requestedAt: -1 }),
    // One open count per location: two people counting the same shelf into different sheets is how counts go wrong.
    store.counts.createIndex({ orgId: 1, locationId: 1 }, { unique: true, partialFilterExpression: { status: "open" } }),
    store.movements.createIndex({ purchaseOrderId: 1 }, { sparse: true }),
  ]);
  return store;
}

export const isDuplicateKey = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && e.code === 11000;

/** Which unique field a duplicate-key error was about, e.g. "code" or "name". */
export const duplicateField = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const pattern = (e as { keyPattern?: Record<string, unknown> }).keyPattern;
  return pattern ? Object.keys(pattern).find((k) => k !== "orgId" && k !== "parentId") : undefined;
};
