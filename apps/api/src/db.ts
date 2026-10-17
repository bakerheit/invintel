import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";

export interface ItemDoc {
  _id: ObjectId;
  sku: string;
  name: string;
  description: string;
  category: string;
  location: string;
  quantity: number;
  reorderLevel: number;
  unitCostCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementDoc {
  _id: ObjectId;
  itemId: ObjectId;
  delta: number;
  reason: string;
  createdAt: Date;
}

export interface UserDoc {
  _id: ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: "admin" | "member";
  createdAt: Date;
}

export interface SessionDoc {
  _id: string; // sha256 of the cookie token
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

export interface Store {
  client: MongoClient;
  db: Db;
  items: Collection<ItemDoc>;
  movements: Collection<MovementDoc>;
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  close: () => Promise<void>;
}

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
    items: db.collection("items"),
    movements: db.collection("stock_movements"),
    users: db.collection("users"),
    sessions: db.collection("sessions"),
    close: () => client.close(),
  };
  await Promise.all([
    store.items.createIndex({ sku: 1 }, { unique: true }),
    store.movements.createIndex({ itemId: 1, createdAt: -1 }),
    store.users.createIndex({ email: 1 }, { unique: true }),
    store.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  return store;
}

export const isDuplicateKey = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e && e.code === 11000;
