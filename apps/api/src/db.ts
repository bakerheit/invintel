import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { OrgRole } from "@invintel/shared";

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

export interface MovementDoc {
  _id: ObjectId;
  orgId: ObjectId;
  itemId: ObjectId;
  locationId: ObjectId;
  delta: number;
  reason: string;
  userName: string;
  transferId?: ObjectId;
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
    close: () => client.close(),
  };

  // Before organizations existed SKUs were unique across the whole database.
  await store.items.dropIndex("sku_1").catch(() => {});

  await Promise.all([
    store.users.createIndex({ email: 1 }, { unique: true }),
    store.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    store.orgs.createIndex({ joinCode: 1 }, { unique: true }),
    store.memberships.createIndex({ orgId: 1, userId: 1 }, { unique: true }),
    store.memberships.createIndex({ userId: 1 }),
    store.locations.createIndex({ orgId: 1, name: 1 }, { unique: true, collation: caseInsensitive }),
    store.items.createIndex({ orgId: 1, sku: 1 }, { unique: true, collation: caseInsensitive }),
    store.stock.createIndex({ itemId: 1, locationId: 1 }, { unique: true }),
    store.stock.createIndex({ orgId: 1, locationId: 1 }),
    store.movements.createIndex({ itemId: 1, createdAt: -1 }),
  ]);
  return store;
}

export const isDuplicateKey = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && e.code === 11000;
