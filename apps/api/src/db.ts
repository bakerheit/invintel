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
  /** Invoice matching rules and the currency the books are kept in. Defaults apply when absent. */
  invoiceSettings?: { currency: string; priceTolerancePct: number; qtyTolerancePct: number; totalToleranceCents: number };
  approvalRules?: { kind: "adjustment" | "purchase_order" | "invoice" | "supplier_payment_details"; thresholdCents: number; appliesTo: "members" | "everyone" }[];
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
  /** Receipts made against a shipment (an advance ship notice) carry it too. */
  shipmentId?: ObjectId;
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
  /** Where this supplier is paid: the last four digits and a description, never a full account number. */
  paymentDetails?: { method: "bank_transfer" | "check" | "card" | "cash" | "other"; accountName: string; bankName: string; accountLast4: string; instructions: string };
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
  kind: "adjustment" | "purchase_order" | "invoice" | "supplier_payment_details";
  status: "pending" | "approved" | "rejected" | "cancelled" | "failed";
  summary: string;
  valueCents: number;
  /** What to do when approved. Kept as plain ids and numbers. */
  payload: { itemId?: ObjectId; locationId?: ObjectId; delta?: number; reason?: string; orderId?: ObjectId; invoiceId?: ObjectId; supplierId?: ObjectId; paymentDetails?: NonNullable<SupplierDoc["paymentDetails"]>; overrideReason?: string };
  subject: { type: "item" | "purchase_order" | "invoice" | "supplier"; id: string; label: string };
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

/** A key for other software. Only a hash of it is kept: the key itself is shown once, when it is made. */
export interface ApiKeyDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  scope: "read" | "write";
  /** The first characters of the secret part, used to find the key and to tell keys apart on screen. */
  prefix: string;
  /** SHA-256 of the whole key. The key is 256 random bits, so a fast hash is enough. */
  hash: string;
  createdBy: { id: ObjectId; name: string };
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}

/** Where to send events. The secret signs each delivery so the receiver can tell it is really from here. */
export interface WebhookDoc {
  _id: ObjectId;
  orgId: ObjectId;
  url: string;
  /** Event names, or ["*"] for every event a webhook can have. */
  events: string[];
  description: string;
  secret: string;
  enabled: boolean;
  /** Deliveries that gave up in a row. Reset by a success. Too many switches the webhook off. */
  failures: number;
  disabledReason?: string;
  createdBy: { id: ObjectId; name: string };
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryDoc {
  _id: ObjectId;
  orgId: ObjectId;
  webhookId: ObjectId;
  /** The audit event this tells about (or a fresh id for a test). The same across retries and across webhooks. */
  eventId: string;
  type: string;
  /** The exact bytes that are sent and signed. */
  body: string;
  status: "pending" | "delivered" | "retrying" | "failed";
  attempts: number;
  nextAttemptAt: Date | null;
  /** Held by a worker until then, so two workers don't send the same delivery. */
  leaseUntil?: Date;
  responseStatus?: number;
  error?: string;
  createdAt: Date;
  deliveredAt?: Date;
}

export interface InvoiceLineDoc {
  itemId: ObjectId | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxCents: number;
}

/** A bill from a supplier. Totals are worked out from the lines, never taken from the client. */
export interface InvoiceDoc {
  _id: ObjectId;
  orgId: ObjectId;
  /** INVC-0001, ours. */
  number: string;
  status: "draft" | "review" | "approved" | "paid" | "void";
  supplierId: ObjectId;
  purchaseOrderId: ObjectId | null;
  /** The supplier's own number. Unique per supplier among invoices that aren't void. */
  invoiceNumber: string;
  /** invoiceNumber, trimmed and upper-cased, for the duplicate check. */
  invoiceKey: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  lines: InvoiceLineDoc[];
  subtotalCents: number;
  taxCents: number;
  freightCents: number;
  totalCents: number;
  statedTotalCents: number | null;
  note: string;
  /** Paid so far, kept in step by payments (atomically), never recomputed from a guess. */
  paidCents: number;
  createdBy: { id: ObjectId; name: string };
  createdAt: Date;
  updatedAt: Date;
  approvedBy?: { id: ObjectId; name: string };
  approvedAt?: Date;
  overrideReason?: string;
  voidReason?: string;
  /** A waiting approval request for it (INV-7), if the organization's rules ask for one. */
  approvalId?: ObjectId;
  /** What the last match found. Kept so lists don't re-run it for every row, and so an approved invoice remembers what it was approved against. */
  match?: import("@invintel/shared").MatchResult;
}

export interface ShipmentDoc {
  _id: ObjectId;
  orgId: ObjectId;
  /** SHP-0001, ours. */
  number: string;
  status: "expected" | "cancelled";
  supplierId: ObjectId;
  purchaseOrderId: ObjectId | null;
  reference: string;
  /** reference, trimmed and upper-cased, unique per supplier. */
  referenceKey: string;
  shipDate: string | null;
  expectedDate: string | null;
  carrier: string;
  tracking: string;
  lines: { itemId: ObjectId; quantity: number; supplierLot: string }[];
  note: string;
  createdBy: { id: ObjectId; name: string };
  createdAt: Date;
}

export interface PaymentDoc {
  _id: ObjectId;
  orgId: ObjectId;
  /** PAY-0001, ours. */
  number: string;
  supplierId: ObjectId;
  method: "bank_transfer" | "check" | "card" | "cash" | "other";
  paidOn: string;
  reference: string;
  note: string;
  currency: string;
  amountCents: number;
  allocations: { invoiceId: ObjectId; amountCents: number }[];
  createdBy: { id: ObjectId; name: string };
  createdAt: Date;
  voidedAt?: Date;
  voidedBy?: { id: ObjectId; name: string };
  voidReason?: string;
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
  apiKeys: Collection<ApiKeyDoc>;
  invoices: Collection<InvoiceDoc>;
  shipments: Collection<ShipmentDoc>;
  payments: Collection<PaymentDoc>;
  webhooks: Collection<WebhookDoc>;
  webhookDeliveries: Collection<WebhookDeliveryDoc>;
  counters: Collection<{ _id: string; seq: number }>;
  ncrs: Collection<NcrDoc>;
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
    apiKeys: db.collection("api_keys"),
    invoices: db.collection("invoices"),
    shipments: db.collection("shipments"),
    payments: db.collection("payments"),
    webhooks: db.collection("webhooks"),
    webhookDeliveries: db.collection("webhook_deliveries"),
    counters: db.collection("counters"),
    ncrs: db.collection("ncrs"),
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
    store.invoices.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.invoices.createIndex({ orgId: 1, supplierId: 1, invoiceKey: 1 }),
    store.invoices.createIndex({ orgId: 1, purchaseOrderId: 1 }, { sparse: true }),
    store.invoices.createIndex({ orgId: 1, status: 1, dueDate: 1 }),
    store.shipments.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.shipments.createIndex({ orgId: 1, supplierId: 1, referenceKey: 1 }, { unique: true }),
    store.shipments.createIndex({ orgId: 1, purchaseOrderId: 1 }, { sparse: true }),
    store.payments.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    store.payments.createIndex({ orgId: 1, supplierId: 1, paidOn: -1 }),
    store.payments.createIndex({ "allocations.invoiceId": 1 }),
    store.movements.createIndex({ shipmentId: 1 }, { sparse: true }),
    store.apiKeys.createIndex({ prefix: 1 }),
    store.apiKeys.createIndex({ orgId: 1, createdAt: -1 }),
    store.webhooks.createIndex({ orgId: 1, enabled: 1 }),
    store.webhookDeliveries.createIndex({ webhookId: 1, createdAt: -1 }),
    store.webhookDeliveries.createIndex({ status: 1, nextAttemptAt: 1 }),
    // Old finished deliveries clear themselves after 30 days.
    store.webhookDeliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
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
