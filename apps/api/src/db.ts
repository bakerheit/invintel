import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { AuditAction, AuditChange, AuditEntityType, LocationType, MovementType, OrgRole } from "@invintel/shared";

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
  name: string;
  joinCode: string;
  createdBy: ObjectId;
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
  createdAt: Date;
  updatedAt: Date;
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
  counters: Collection<{ _id: string; seq: number }>;
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
    counters: db.collection("counters"),
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
