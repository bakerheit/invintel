import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Needs a running MongoDB (docker compose up -d). Each run uses its own throwaway database.
const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;

interface Req {
  method?: string;
  body?: unknown;
  cookie?: string;
}
const call = (path: string, { method, body, cookie }: Req = {}) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(cookie && { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const sessionCookie = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

interface Account {
  cookie: string;
  user: { id: string; email: string };
  org: { id: string; name: string; role: string; joinCode?: string };
}

let emailCounter = 0;
async function signUp(organization: object, name = "Ada"): Promise<Account> {
  const res = await call("/api/auth/register", {
    body: { name, email: `user${++emailCounter}@example.com`, password: "correct horse", organization },
  });
  expect(res.status).toBe(201);
  const { user, organization: org } = await res.json();
  return { cookie: sessionCookie(res), user, org };
}
const newOwner = (orgName = "Acme") => signUp({ mode: "create", name: orgName });
const newMember = (of: Account) => signUp({ mode: "join", joinCode: of.org.joinCode }, "Bob");

beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
});

afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

beforeEach(async () => {
  await Promise.all(
    [store.users, store.sessions, store.orgs, store.memberships, store.locations, store.items, store.stock, store.movements, store.audit].map(
      (c) => c.deleteMany({}),
    ),
  );
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});

describe("auth and registration", () => {
  it("creates an organization at sign-up: owner role, join code, a default location, httpOnly cookie", async () => {
    const res = await call("/api/auth/register", {
      body: { name: "Ada", email: "ada@example.com", password: "correct horse", organization: { mode: "create", name: "Acme" } },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    const { user, organization } = await res.json();
    expect(user).not.toHaveProperty("passwordHash");
    expect(organization).toMatchObject({ name: "Acme", role: "owner", memberCount: 1 });
    expect(organization.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const locations = await (await call(`/api/orgs/${organization.id}/locations`, { cookie: sessionCookie(res) })).json();
    expect(locations.map((l: { name: string }) => l.name)).toEqual(["Main"]);
  });

  it("joins an existing organization with its code as a member, tolerating dashes and lowercase", async () => {
    const owner = await newOwner();
    const code = owner.org.joinCode!;
    const res = await call("/api/auth/register", {
      body: {
        name: "Bob",
        email: "bob@example.com",
        password: "correct horse",
        organization: { mode: "join", joinCode: `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase() },
      },
    });
    expect(res.status).toBe(201);
    const { organization } = await res.json();
    expect(organization).toMatchObject({ id: owner.org.id, role: "member", memberCount: 2 });
    expect(organization).not.toHaveProperty("joinCode");
  });

  it("rejects a bad join code without leaving an account behind", async () => {
    const res = await call("/api/auth/register", {
      body: { name: "Eve", email: "eve@example.com", password: "correct horse", organization: { mode: "join", joinCode: "ZZZZZZZZ" } },
    });
    expect(res.status).toBe(400);
    expect(await store.users.countDocuments()).toBe(0);
  });

  it("requires an organization choice and a strong enough password", async () => {
    const base = { name: "X", email: "x@example.com", password: "correct horse" };
    expect((await call("/api/auth/register", { body: base })).status).toBe(400);
    const weak = { ...base, password: "short", organization: { mode: "create", name: "A" } };
    expect((await call("/api/auth/register", { body: weak })).status).toBe(400);
  });

  it("rejects duplicate emails", async () => {
    const body = { name: "A", email: "dupe@example.com", password: "correct horse", organization: { mode: "create", name: "A" } };
    expect((await call("/api/auth/register", { body })).status).toBe(201);
    expect((await call("/api/auth/register", { body })).status).toBe(409);
  });

  it("logs in with the right password only, and logout kills the session", async () => {
    const a = await newOwner();
    const bad = await call("/api/auth/login", { body: { email: a.user.email, password: "nope" } });
    expect(bad.status).toBe(401);

    const ok = await call("/api/auth/login", { body: { email: a.user.email.toUpperCase(), password: "correct horse" } });
    expect(ok.status).toBe(200);
    const cookie = sessionCookie(ok);
    expect((await call("/api/auth/me", { cookie })).status).toBe(200);

    await call("/api/auth/logout", { method: "POST", cookie });
    expect((await call("/api/auth/me", { cookie })).status).toBe(401);
  });

  it("locks an email out after repeated failures", async () => {
    const a = await newOwner();
    for (let i = 0; i < 10; i++) {
      await call("/api/auth/login", { body: { email: a.user.email, password: "wrong" } });
    }
    const res = await call("/api/auth/login", { body: { email: a.user.email, password: "correct horse" } });
    expect(res.status).toBe(429);
  });

  it("closes registration when disabled, except for the first account", async () => {
    const closed = createApp(store, { allowRegistration: false, cookieSecure: false });
    const body = { name: "A", email: "late@example.com", password: "correct horse", organization: { mode: "create", name: "A" } };
    const open = await closed.request("/api/auth/config");
    expect(await open.json()).toEqual({ registrationOpen: true });
    expect(
      (await closed.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status,
    ).toBe(201);

    const res = await closed.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, email: "later@example.com" }),
    });
    expect(res.status).toBe(403);
    expect(await (await closed.request("/api/auth/config")).json()).toEqual({ registrationOpen: false });
  });

  it("requires a session everywhere else", async () => {
    const a = await newOwner();
    expect((await call("/api/orgs")).status).toBe(401);
    expect((await call(`/api/orgs/${a.org.id}/items`)).status).toBe(401);
    expect((await call("/api/orgs", { cookie: "invintel_session=forged" })).status).toBe(401);
  });
});

describe("organizations", () => {
  it("lets one user create more organizations and lists them all", async () => {
    const a = await newOwner("Acme");
    const created = await call("/api/orgs", { body: { name: "Side Project" }, cookie: a.cookie });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: "Side Project", role: "owner" });

    const list = await (await call("/api/orgs", { cookie: a.cookie })).json();
    expect(list.map((o: { name: string }) => o.name)).toEqual(["Acme", "Side Project"]);
  });

  it("lets a signed-in user join another organization by code, and is idempotent", async () => {
    const acme = await newOwner("Acme");
    const other = await newOwner("Other");

    const first = await call("/api/orgs/join", { body: { joinCode: acme.org.joinCode }, cookie: other.cookie });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id: acme.org.id, role: "member" });

    const again = await call("/api/orgs/join", { body: { joinCode: acme.org.joinCode }, cookie: other.cookie });
    expect(again.status).toBe(200);
    expect((await (await call("/api/orgs", { cookie: other.cookie })).json())).toHaveLength(2);

    // Joining your own org with its code must not demote you.
    const self = await call("/api/orgs/join", { body: { joinCode: acme.org.joinCode }, cookie: acme.cookie });
    expect((await self.json()).role).toBe("owner");
  });

  it("rejects wrong join codes and rate limits guessing", async () => {
    const a = await newOwner();
    const bad = await call("/api/orgs/join", { body: { joinCode: "ZZZZZZZZ" }, cookie: a.cookie });
    expect(bad.status).toBe(400);
    for (let i = 0; i < 10; i++) {
      await call("/api/orgs/join", { body: { joinCode: "ZZZZZZZZ" }, cookie: a.cookie });
    }
    expect((await call("/api/orgs/join", { body: { joinCode: "ZZZZZZZZ" }, cookie: a.cookie })).status).toBe(429);
  });

  it("hides organizations from non-members with a 404", async () => {
    const acme = await newOwner("Acme");
    const stranger = await newOwner("Elsewhere");
    expect((await call(`/api/orgs/${acme.org.id}`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call(`/api/orgs/${acme.org.id}/items`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call(`/api/orgs/${acme.org.id}/locations`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call("/api/orgs/not-an-id", { cookie: stranger.cookie })).status).toBe(404);
  });

  it("only shows the join code to admins, and only admins can rotate it or rename", async () => {
    const owner = await newOwner();
    const member = await newMember(owner);

    const asMember = await (await call(`/api/orgs/${owner.org.id}`, { cookie: member.cookie })).json();
    expect(asMember).not.toHaveProperty("joinCode");
    expect((await call(`/api/orgs/${owner.org.id}/join-code`, { method: "POST", cookie: member.cookie })).status).toBe(403);
    expect((await call(`/api/orgs/${owner.org.id}`, { method: "PATCH", body: { name: "Hax" }, cookie: member.cookie })).status).toBe(403);

    const rotated = await call(`/api/orgs/${owner.org.id}/join-code`, { method: "POST", cookie: owner.cookie });
    const { joinCode } = await rotated.json();
    expect(joinCode).not.toBe(owner.org.joinCode);
    const old = await call("/api/orgs/join", { body: { joinCode: owner.org.joinCode }, cookie: (await newOwner("Z")).cookie });
    expect(old.status).toBe(400);

    const renamed = await call(`/api/orgs/${owner.org.id}`, { method: "PATCH", body: { name: "Acme Inc" }, cookie: owner.cookie });
    expect((await renamed.json()).name).toBe("Acme Inc");
  });

  it("lists members with roles", async () => {
    const owner = await newOwner();
    await newMember(owner);
    const members = await (await call(`/api/orgs/${owner.org.id}/members`, { cookie: owner.cookie })).json();
    expect(members.map((m: { role: string }) => m.role)).toEqual(["owner", "member"]);
    expect(members[0]).not.toHaveProperty("passwordHash");
  });
});

describe("locations", () => {
  it("lets admins add, edit and delete; members can only read", async () => {
    const owner = await newOwner();
    const member = await newMember(owner);
    const base = `/api/orgs/${owner.org.id}/locations`;

    const made = await call(base, { body: { name: "Warehouse B", description: "Back lot" }, cookie: owner.cookie });
    expect(made.status).toBe(201);
    const loc = await made.json();

    expect((await call(base, { body: { name: "Nope" }, cookie: member.cookie })).status).toBe(403);
    expect((await call(`${base}/${loc.id}`, { method: "PATCH", body: { name: "x" }, cookie: member.cookie })).status).toBe(403);
    expect((await call(`${base}/${loc.id}`, { method: "DELETE", cookie: member.cookie })).status).toBe(403);
    expect((await call(base, { cookie: member.cookie })).status).toBe(200);

    const edited = await call(`${base}/${loc.id}`, { method: "PATCH", body: { name: "Warehouse C" }, cookie: owner.cookie });
    expect((await edited.json()).name).toBe("Warehouse C");
    expect((await call(`${base}/${loc.id}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(204);
  });

  it("rejects duplicate names per org, ignoring case, but allows them across orgs", async () => {
    const a = await newOwner("A");
    const b = await newOwner("B");
    const make = (acct: Account, name: string) =>
      call(`/api/orgs/${acct.org.id}/locations`, { body: { name }, cookie: acct.cookie });
    expect((await make(a, "main")).status).toBe(409); // "Main" already exists
    expect((await make(a, "Shed")).status).toBe(201);
    expect((await make(b, "Shed")).status).toBe(201);
  });

  it("won't delete a location that still holds stock", async () => {
    const a = await newOwner();
    const base = `/api/orgs/${a.org.id}`;
    const [main] = await (await call(`${base}/locations`, { cookie: a.cookie })).json();
    const item = await (
      await call(`${base}/items`, { body: { sku: "S-1", name: "Thing", initialStock: { locationId: main.id, quantity: 3 } }, cookie: a.cookie })
    ).json();

    const blocked = await call(`${base}/locations/${main.id}`, { method: "DELETE", cookie: a.cookie });
    expect(blocked.status).toBe(409);

    const counts = (await (await call(`${base}/locations`, { cookie: a.cookie })).json())[0];
    expect(counts).toMatchObject({ skuCount: 1, unitCount: 3 });

    await call(`${base}/items/${item.id}/adjust`, { body: { locationId: main.id, delta: -3 }, cookie: a.cookie });
    expect((await call(`${base}/locations/${main.id}`, { method: "DELETE", cookie: a.cookie })).status).toBe(204);
  });
});

describe("items and stock", () => {
  let owner: Account;
  let base: string;
  let main: { id: string };
  let shed: { id: string };

  const create = (body: object, who = owner) => call(`${base}/items`, { body, cookie: who.cookie });
  const adjust = (itemId: string, body: object, who = owner) =>
    call(`${base}/items/${itemId}/adjust`, { body, cookie: who.cookie });
  const get = async (itemId: string) => (await call(`${base}/items/${itemId}`, { cookie: owner.cookie })).json();

  beforeEach(async () => {
    owner = await newOwner();
    base = `/api/orgs/${owner.org.id}`;
    main = (await (await call(`${base}/locations`, { cookie: owner.cookie })).json())[0];
    shed = await (await call(`${base}/locations`, { body: { name: "Shed" }, cookie: owner.cookie })).json();
  });

  it("creates an item with initial stock at a location and logs who did it", async () => {
    const res = await create({ sku: "A-1", name: "Widget", initialStock: { locationId: main.id, quantity: 5 } });
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(item).toMatchObject({ quantity: 5, stock: [{ locationId: main.id, quantity: 5 }] });

    const moves = await (await call(`${base}/items/${item.id}/movements`, { cookie: owner.cookie })).json();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ delta: 5, locationId: main.id, userName: "Ada", reason: "Initial stock" });
  });

  it("creates an item with no stock, and refuses initial stock at a location from another org", async () => {
    const empty = await (await create({ sku: "E-1", name: "Empty" })).json();
    expect(empty).toMatchObject({ quantity: 0, stock: [] });

    const other = await newOwner("Other");
    const foreign = (await (await call(`/api/orgs/${other.org.id}/locations`, { cookie: other.cookie })).json())[0];
    const bad = await create({ sku: "F-1", name: "Foreign", initialStock: { locationId: foreign.id, quantity: 1 } });
    expect(bad.status).toBe(400);
  });

  it("keeps SKUs unique per org, ignoring case, but lets other orgs reuse them", async () => {
    expect((await create({ sku: "DUP", name: "One" })).status).toBe(201);
    expect((await create({ sku: "dup", name: "Two" })).status).toBe(409);
    const other = await newOwner("Other");
    const res = await call(`/api/orgs/${other.org.id}/items`, { body: { sku: "DUP", name: "Theirs" }, cookie: other.cookie });
    expect(res.status).toBe(201);
  });

  it("isolates inventory between orgs", async () => {
    const item = await (await create({ sku: "P-1", name: "Private" })).json();
    const other = await newOwner("Other");
    const list = await (await call(`/api/orgs/${other.org.id}/items`, { cookie: other.cookie })).json();
    expect(list).toEqual([]);
    // Right id, wrong org: must not leak or modify.
    const probe = `/api/orgs/${other.org.id}/items/${item.id}`;
    expect((await call(probe, { cookie: other.cookie })).status).toBe(404);
    expect((await call(probe, { method: "DELETE", cookie: other.cookie })).status).toBe(404);
    expect((await call(`${probe}/adjust`, { body: { locationId: main.id, delta: 1 }, cookie: other.cookie })).status).toBe(404);
  });

  it("adjusts stock per location and sums the total", async () => {
    const item = await (await create({ sku: "B-1", name: "Bolt" })).json();
    await adjust(item.id, { locationId: main.id, delta: 10, reason: "delivery" });
    const res = await adjust(item.id, { locationId: shed.id, delta: 4 });
    const after = await res.json();
    expect(after.quantity).toBe(14);
    expect(after.stock).toHaveLength(2);
    expect(after.stock).toEqual(
      expect.arrayContaining([
        { locationId: main.id, quantity: 10 },
        { locationId: shed.id, quantity: 4 },
      ]),
    );
  });

  it("refuses to take more than a location holds, even if other locations have plenty", async () => {
    const item = await (await create({ sku: "C-1", name: "Cog" })).json();
    await adjust(item.id, { locationId: main.id, delta: 10 });
    await adjust(item.id, { locationId: shed.id, delta: 2 });

    const bad = await adjust(item.id, { locationId: shed.id, delta: -5 });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/Only 2 in stock at Shed/);
    expect((await get(item.id)).quantity).toBe(12);
  });

  it("never oversells under concurrent removals", async () => {
    const item = await (await create({ sku: "R-1", name: "Race" })).json();
    await adjust(item.id, { locationId: main.id, delta: 5 });
    const results = await Promise.all(Array.from({ length: 10 }, () => adjust(item.id, { locationId: main.id, delta: -1 })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect((await get(item.id)).quantity).toBe(0);
  });

  it("doesn't lose units when first-time adds race to create the same stock row", async () => {
    const item = await (await create({ sku: "U-1", name: "Upsert" })).json();
    await Promise.all(Array.from({ length: 8 }, () => adjust(item.id, { locationId: shed.id, delta: 1 })));
    expect((await get(item.id)).quantity).toBe(8);
    expect(await store.stock.countDocuments({ locationId: { $exists: true } })).toBe(1);
  });

  it("transfers stock between locations and logs both sides", async () => {
    const item = await (await create({ sku: "T-1", name: "Move me", initialStock: { locationId: main.id, quantity: 6 } })).json();
    const res = await call(`${base}/items/${item.id}/transfer`, {
      body: { fromLocationId: main.id, toLocationId: shed.id, quantity: 4 },
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after.quantity).toBe(6);
    expect(after.stock).toEqual(
      expect.arrayContaining([
        { locationId: main.id, quantity: 2 },
        { locationId: shed.id, quantity: 4 },
      ]),
    );

    const moves = await (await call(`${base}/items/${item.id}/movements`, { cookie: owner.cookie })).json();
    const transfer = moves.filter((m: { transferId?: string }) => m.transferId);
    expect(transfer).toHaveLength(2);
    expect(transfer[0].transferId).toBe(transfer[1].transferId);
    expect(transfer.map((m: { delta: number }) => m.delta).sort()).toEqual([-4, 4]);
  });

  it("rejects transfers that are too big, point at the same place, or leave the org", async () => {
    const item = await (await create({ sku: "T-2", name: "Few", initialStock: { locationId: main.id, quantity: 2 } })).json();
    const transfer = (body: object) =>
      call(`${base}/items/${item.id}/transfer`, { body, cookie: owner.cookie });

    expect((await transfer({ fromLocationId: main.id, toLocationId: shed.id, quantity: 3 })).status).toBe(422);
    expect((await transfer({ fromLocationId: main.id, toLocationId: main.id, quantity: 1 })).status).toBe(400);
    const other = await newOwner("Other");
    const foreign = (await (await call(`/api/orgs/${other.org.id}/locations`, { cookie: other.cookie })).json())[0];
    expect((await transfer({ fromLocationId: main.id, toLocationId: foreign.id, quantity: 1 })).status).toBe(404);
    expect((await get(item.id)).quantity).toBe(2);
  });

  it("lets members manage inventory", async () => {
    const member = await newMember(owner);
    const made = await create({ sku: "M-1", name: "By member" }, member);
    expect(made.status).toBe(201);
    const item = await made.json();
    expect((await adjust(item.id, { locationId: main.id, delta: 2 }, member)).status).toBe(200);
  });

  it("ignores quantity on PATCH, updates other fields, and deletes while keeping the ledger", async () => {
    const item = await (await create({ sku: "D-1", name: "Cog", initialStock: { locationId: main.id, quantity: 4 } })).json();

    const patched = await (
      await call(`${base}/items/${item.id}`, { method: "PATCH", body: { name: "Big Cog", quantity: 99 }, cookie: owner.cookie })
    ).json();
    expect(patched).toMatchObject({ name: "Big Cog", quantity: 4 });

    expect((await call(`${base}/items/${item.id}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(204);
    expect((await call(`${base}/items/${item.id}`, { cookie: owner.cookie })).status).toBe(404);
    expect(await store.stock.countDocuments({ itemId: { $exists: true } })).toBe(0);
    // The ledger is kept: the receipt, plus a write-off that brings the item back to zero.
    const history = await store.movements.find({}).sort({ _id: 1 }).toArray();
    expect(history.map((m) => m.delta)).toEqual([4, -4]);
    expect(history[1]!.reason).toBe("Item deleted");
  });

  it("validates input and ids", async () => {
    expect((await create({ sku: "", name: "x" })).status).toBe(400);
    expect((await call(`${base}/items/not-an-id`, { cookie: owner.cookie })).status).toBe(400);
    expect((await create({ sku: "Z", name: "z", initialStock: { locationId: main.id, quantity: 0 } })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Phase 0: patch safety, location hierarchy, floor documents, activity ledger
// ---------------------------------------------------------------------------

describe("patch safety", () => {
  it("leaves fields you didn't send alone", async () => {
    const owner = await newOwner();
    const base = `/api/orgs/${owner.org.id}`;
    const item = await (
      await call(`${base}/items`, {
        body: { sku: "P-1", name: "Keep me", description: "desc", category: "Cat", reorderLevel: 7, unitCostCents: 250 },
        cookie: owner.cookie,
      })
    ).json();
    const patched = await (
      await call(`${base}/items/${item.id}`, { method: "PATCH", body: { name: "Renamed" }, cookie: owner.cookie })
    ).json();
    expect(patched).toMatchObject({ name: "Renamed", description: "desc", category: "Cat", reorderLevel: 7, unitCostCents: 250 });

    const loc = await (
      await call(`${base}/locations`, {
        body: { name: "Roll store", description: "Paper", type: "production", code: "RS-1" },
        cookie: owner.cookie,
      })
    ).json();
    const locPatched = await (
      await call(`${base}/locations/${loc.id}`, { method: "PATCH", body: { name: "Roll storage" }, cookie: owner.cookie })
    ).json();
    expect(locPatched).toMatchObject({ name: "Roll storage", description: "Paper", type: "production", code: "RS-1" });
  });
});

describe("location types and hierarchy", () => {
  let owner: Account;
  let base: string;
  const mk = (body: object, who = owner) => call(`${base}/locations`, { body, cookie: who.cookie });
  const list = async () => (await call(`${base}/locations`, { cookie: owner.cookie })).json();

  beforeEach(async () => {
    owner = await newOwner();
    base = `/api/orgs/${owner.org.id}`;
  });

  it("nests locations, reports full paths, and defaults the type", async () => {
    const plant = await (await mk({ name: "Plant 1" })).json();
    expect(plant).toMatchObject({ type: "storage", parentId: null, code: "", path: "Plant 1" });
    const rolls = await (await mk({ name: "Roll storage", type: "receiving", parentId: plant.id })).json();
    expect(rolls).toMatchObject({ type: "receiving", parentId: plant.id, path: "Plant 1 / Roll storage" });

    const paths = (await list()).map((l: { path: string }) => l.path);
    expect(paths).toEqual(["Main", "Plant 1", "Plant 1 / Roll storage"]);
  });

  it("treats older documents without type, parent or code as plain storage at the top level", async () => {
    await store.locations.insertOne({
      _id: new (await import("mongodb")).ObjectId(),
      orgId: new (await import("mongodb")).ObjectId(owner.org.id),
      name: "Legacy",
      description: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const legacy = (await list()).find((l: { name: string }) => l.name === "Legacy");
    expect(legacy).toMatchObject({ type: "storage", parentId: null, code: "", path: "Legacy" });
  });

  it("allows the same name under different parents but not twice under one", async () => {
    const a = await (await mk({ name: "Warehouse A" })).json();
    const b = await (await mk({ name: "Warehouse B" })).json();
    expect((await mk({ name: "Bin 1", parentId: a.id })).status).toBe(201);
    expect((await mk({ name: "Bin 1", parentId: b.id })).status).toBe(201);
    expect((await mk({ name: "bin 1", parentId: a.id })).status).toBe(409);
  });

  it("keeps codes unique per org, ignoring case, but lets many locations have none", async () => {
    expect((await mk({ name: "One", code: "A-01" })).status).toBe(201);
    expect((await mk({ name: "Two", code: "a-01" })).status).toBe(409);
    expect((await mk({ name: "Three" })).status).toBe(201);
    expect((await mk({ name: "Four" })).status).toBe(201);
    const other = await newOwner("Other");
    const res = await call(`/api/orgs/${other.org.id}/locations`, { body: { name: "One", code: "A-01" }, cookie: other.cookie });
    expect(res.status).toBe(201);
  });

  it("rejects parents from another org, cycles, and self-parenting", async () => {
    const other = await newOwner("Other");
    const foreign = (await (await call(`/api/orgs/${other.org.id}/locations`, { cookie: other.cookie })).json())[0];
    expect((await mk({ name: "Bad", parentId: foreign.id })).status).toBe(400);

    const top = await (await mk({ name: "Top" })).json();
    const mid = await (await mk({ name: "Mid", parentId: top.id })).json();
    const move = (id: string, parentId: string) =>
      call(`${base}/locations/${id}`, { method: "PATCH", body: { parentId }, cookie: owner.cookie });
    expect((await move(top.id, mid.id)).status).toBe(400); // into its own child
    expect((await move(top.id, top.id)).status).toBe(400); // into itself
    expect((await move(mid.id, top.id)).status).toBe(200); // no-op move is fine
  });

  it("limits nesting depth", async () => {
    let parentId: string | null = null;
    for (let depth = 1; depth <= 6; depth++) {
      const res = await mk({ name: `Level ${depth}`, parentId });
      expect(res.status).toBe(201);
      parentId = (await res.json()).id;
    }
    expect((await mk({ name: "Level 7", parentId })).status).toBe(400);
  });

  it("won't delete a location that has locations inside it", async () => {
    const parent = await (await mk({ name: "Parent" })).json();
    const child = await (await mk({ name: "Child", parentId: parent.id })).json();
    expect((await call(`${base}/locations/${parent.id}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(409);
    expect((await call(`${base}/locations/${child.id}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(204);
    expect((await call(`${base}/locations/${parent.id}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(204);
  });
});

describe("floor documents and lookup", () => {
  let owner: Account;
  let base: string;
  let main: { id: string };
  let shed: { id: string };
  let item: { id: string; sku: string };

  const post = (path: string, body: object, who = owner) => call(`${base}${path}`, { body, cookie: who.cookie });
  const lookup = async (code: string, who = owner, b = base) =>
    (await call(`${b}/lookup?code=${encodeURIComponent(code)}`, { cookie: who.cookie })).json();

  beforeEach(async () => {
    owner = await newOwner();
    base = `/api/orgs/${owner.org.id}`;
    main = (await (await call(`${base}/locations`, { cookie: owner.cookie })).json())[0];
    shed = await (await post("/locations", { name: "Shed", code: "SH-1" })).json();
    item = await (await post("/items", { sku: "Roll-100", name: "Kraft roll" })).json();
  });

  it("receives stock and returns movement ids for undo", async () => {
    const res = await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 12, reference: "PO 77" });
    expect(res.status).toBe(201);
    const doc = await res.json();
    expect(doc.item.quantity).toBe(12);
    expect(doc.movementIds).toHaveLength(1);

    const page = await (await call(`${base}/movements`, { cookie: owner.cookie })).json();
    expect(page.entries[0]).toMatchObject({ type: "receive", delta: 12, reason: "Received: PO 77", userName: "Ada" });
  });

  it("rejects receipts for unknown items or other orgs' locations", async () => {
    const other = await newOwner("Other");
    const foreign = (await (await call(`/api/orgs/${other.org.id}/locations`, { cookie: other.cookie })).json())[0];
    expect((await post("/receipts", { itemId: item.id, locationId: foreign.id, quantity: 1 })).status).toBe(404);
    expect((await post("/receipts", { itemId: "a".repeat(24), locationId: main.id, quantity: 1 })).status).toBe(404);
    expect((await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 0 })).status).toBe(400);
  });

  it("moves stock as two linked movements and refuses oversized or pointless moves", async () => {
    await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 10 });
    const res = await post("/moves", { itemId: item.id, fromLocationId: main.id, toLocationId: shed.id, quantity: 4 });
    expect(res.status).toBe(201);
    const doc = await res.json();
    expect(doc.movementIds).toHaveLength(2);
    expect(doc.item.stock).toEqual(
      expect.arrayContaining([
        { locationId: main.id, quantity: 6 },
        { locationId: shed.id, quantity: 4 },
      ]),
    );
    expect((await post("/moves", { itemId: item.id, fromLocationId: main.id, toLocationId: shed.id, quantity: 99 })).status).toBe(422);
    expect((await post("/moves", { itemId: item.id, fromLocationId: main.id, toLocationId: main.id, quantity: 1 })).status).toBe(400);
  });

  it("resolves scanned codes to items and locations", async () => {
    expect(await lookup("roll-100")).toMatchObject({ kind: "item", item: { id: item.id, sku: "Roll-100" } });
    expect(await lookup("sh-1")).toMatchObject({ kind: "location", location: { id: shed.id, path: "Shed" } });
    expect(await lookup("Main")).toMatchObject({ kind: "location", location: { id: main.id } });
    expect(await lookup(item.id)).toMatchObject({ kind: "item" });
    expect(await lookup(shed.id)).toMatchObject({ kind: "location" });
    expect(await lookup("nope")).toEqual({ kind: "none" });
    expect(await lookup("")).toEqual({ kind: "none" });
  });

  it("matches barcodes that differ only by leading zeros (UPC-A vs EAN-13 vs GTIN-14)", async () => {
    const upc = await (await post("/items", { sku: "036000291452", name: "Retail thing" })).json();
    // 12 digits as stored; 13 and 14 digits as different scanners report the same label.
    for (const scanned of ["036000291452", "0036000291452", "00036000291452"]) {
      expect(await lookup(scanned)).toMatchObject({ kind: "item", item: { id: upc.id } });
    }
    // Not the same number, so no match.
    expect(await lookup("036000291453")).toEqual({ kind: "none" });
    // And the other direction: SKU stored as 13 digits, scanned as 12.
    const ean = await (await post("/items", { sku: "0012345678905", name: "Stored as EAN" })).json();
    expect(await lookup("012345678905")).toMatchObject({ kind: "item", item: { id: ean.id } });
    // Short or non-numeric codes never get padded into something else.
    await post("/items", { sku: "123", name: "Short" });
    expect(await lookup("0123")).toEqual({ kind: "none" });
  });

  it("only resolves codes inside your own org", async () => {
    const other = await newOwner("Other");
    expect(await lookup("Roll-100", other, `/api/orgs/${other.org.id}`)).toEqual({ kind: "none" });
    expect(await lookup("SH-1", other, `/api/orgs/${other.org.id}`)).toEqual({ kind: "none" });
  });
});

describe("activity ledger", () => {
  let owner: Account;
  let member: Account;
  let base: string;
  let main: { id: string };
  let shed: { id: string };
  let item: { id: string };

  const post = (path: string, body: object, who = owner) => call(`${base}${path}`, { body, cookie: who.cookie });
  const activity = async (qs = "", who = owner) =>
    (await call(`${base}/movements${qs}`, { cookie: who.cookie })).json();
  const reverse = (id: string, who = owner, reason = "") =>
    call(`${base}/movements/${id}/reverse`, { body: { reason }, cookie: who.cookie });
  const qty = async (itemId = item.id) => (await (await call(`${base}/items/${itemId}`, { cookie: owner.cookie })).json()).quantity;

  beforeEach(async () => {
    owner = await newOwner();
    member = await newMember(owner);
    base = `/api/orgs/${owner.org.id}`;
    main = (await (await call(`${base}/locations`, { cookie: owner.cookie })).json())[0];
    shed = await (await post("/locations", { name: "Shed" })).json();
    item = await (await post("/items", { sku: "L-1", name: "Ledger thing" })).json();
  });

  it("lists newest first with item and location details, and derives types for old rows", async () => {
    await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 5 });
    await post(`/items/${item.id}/adjust`, { locationId: main.id, delta: -1, reason: "damaged" });
    // A row written before types existed.
    await store.movements.insertOne({
      _id: new (await import("mongodb")).ObjectId(),
      orgId: new (await import("mongodb")).ObjectId(owner.org.id),
      itemId: new (await import("mongodb")).ObjectId(item.id),
      locationId: new (await import("mongodb")).ObjectId(main.id),
      delta: 1,
      reason: "Initial stock",
      userName: "Old Timer",
      createdAt: new Date(),
    });
    const { entries } = await activity();
    // Newest first: the old row (derived as a receipt), then the adjustment, then the receipt.
    expect(entries.map((e: { type: string }) => e.type)).toEqual(["receive", "adjust", "receive"]);
    expect(entries[1]).toMatchObject({ itemSku: "L-1", itemName: "Ledger thing", locationName: "Main", locationPath: "Main", delta: -1, reason: "damaged" });
  });

  it("filters by type, item, location (including what's inside it), and search text", async () => {
    const aisle = await (await post("/locations", { name: "Aisle 1", parentId: shed.id })).json();
    const other = await (await post("/items", { sku: "Z-9", name: "Zebra part" })).json();
    await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 5 });
    await post("/receipts", { itemId: other.id, locationId: aisle.id, quantity: 3 });
    await post(`/items/${item.id}/adjust`, { locationId: main.id, delta: -1 });

    expect((await activity("?type=adjust")).entries).toHaveLength(1);
    expect((await activity(`?itemId=${other.id}`)).entries).toHaveLength(1);
    // Filtering by the parent location includes stock in its child.
    expect((await activity(`?locationId=${shed.id}`)).entries.map((e: { itemSku: string }) => e.itemSku)).toEqual(["Z-9"]);
    expect((await activity("?q=zebra")).entries).toHaveLength(1);
    expect((await activity("?q=l-1")).entries).toHaveLength(2);
    expect((await activity("?q=nothing-matches")).entries).toEqual([]);
  });

  it("pages through results without overlap", async () => {
    for (let i = 0; i < 5; i++) await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 1, reference: `r${i}` });
    const first = await activity("?limit=2");
    expect(first.entries).toHaveLength(2);
    expect(first.nextBefore).toBeTruthy();
    const second = await activity(`?limit=2&before=${first.nextBefore}`);
    const third = await activity(`?limit=2&before=${second.nextBefore}`);
    expect(third.nextBefore).toBeUndefined();
    const ids = [...first.entries, ...second.entries, ...third.entries].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.entries).toHaveLength(1);
  });

  it("reverses a receipt, records a reversal, and marks the original", async () => {
    const doc = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 8 })).json();
    const res = await reverse(doc.movementIds[0], owner, "wrong item");
    expect(res.status).toBe(200);
    expect(await qty()).toBe(0);

    const { entries } = await activity();
    expect(entries[0]).toMatchObject({ type: "reversal", delta: -8, reason: "Reversal: wrong item", canReverse: false });
    expect(entries[0].reversalOf).toBe(doc.movementIds[0]);
    expect(entries[1]).toMatchObject({ type: "receive", reversed: true, canReverse: false });

    expect((await reverse(doc.movementIds[0])).status).toBe(409); // already reversed
    expect((await reverse(entries[0].id)).status).toBe(409); // can't reverse a reversal
  });

  it("refuses to reverse a receipt whose stock has since been used, and leaves everything as it was", async () => {
    const doc = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 5 })).json();
    await post(`/items/${item.id}/adjust`, { locationId: main.id, delta: -3, reason: "used" });
    const res = await reverse(doc.movementIds[0]);
    expect(res.status).toBe(422);
    expect(await qty()).toBe(2);
    const { entries } = await activity();
    expect(entries.every((e: { reversed: boolean }) => !e.reversed)).toBe(true);
    // The claim was released, so it can still be reversed once the stock is back.
    await post(`/items/${item.id}/adjust`, { locationId: main.id, delta: 3 });
    expect((await reverse(doc.movementIds[0])).status).toBe(200);
  });

  it("reverses both halves of a transfer", async () => {
    await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 10 });
    const moved = await (await post("/moves", { itemId: item.id, fromLocationId: main.id, toLocationId: shed.id, quantity: 4 })).json();
    const res = await reverse(moved.movementIds[1]);
    expect(res.status).toBe(200);
    expect((await res.json()).movementIds).toHaveLength(2);
    const after = await (await call(`${base}/items/${item.id}`, { cookie: owner.cookie })).json();
    expect(after.stock).toEqual([{ locationId: main.id, quantity: 10 }]);
    expect((await activity("?type=reversal")).entries).toHaveLength(2);
  });

  it("lets members undo their own recent entries, but not other people's or old ones", async () => {
    const mine = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 2 }, member)).json();
    const theirs = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 3 }, owner)).json();

    const asMember = (await activity("", member)).entries as { id: string; canReverse: boolean }[];
    expect(asMember.find((e) => e.id === mine.movementIds[0])!.canReverse).toBe(true);
    expect(asMember.find((e) => e.id === theirs.movementIds[0])!.canReverse).toBe(false);
    expect((await reverse(theirs.movementIds[0], member)).status).toBe(403);
    expect((await reverse(mine.movementIds[0], member)).status).toBe(200);

    // Past the undo window only an admin can.
    const old = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 1 }, member)).json();
    await store.movements.updateOne(
      { _id: new (await import("mongodb")).ObjectId(old.movementIds[0]) },
      { $set: { createdAt: new Date(Date.now() - 20 * 60 * 1000) } },
    );
    expect((await reverse(old.movementIds[0], member)).status).toBe(403);
    expect((await reverse(old.movementIds[0], owner)).status).toBe(200);
  });

  it("only lets one of two simultaneous reversals through", async () => {
    const doc = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 4 })).json();
    const results = await Promise.all([reverse(doc.movementIds[0]), reverse(doc.movementIds[0])]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await qty()).toBe(0);
    expect(await store.movements.countDocuments({ type: "reversal" })).toBe(1);
  });

  it("keeps the ledger inside the org", async () => {
    const doc = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 4 })).json();
    const other = await newOwner("Other");
    const otherBase = `/api/orgs/${other.org.id}`;
    expect((await (await call(`${otherBase}/movements`, { cookie: other.cookie })).json()).entries).toEqual([]);
    const res = await call(`${otherBase}/movements/${doc.movementIds[0]}/reverse`, { body: {}, cookie: other.cookie });
    expect(res.status).toBe(404);
    expect(await qty()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Item barcodes
// ---------------------------------------------------------------------------

describe("item barcodes", () => {
  let owner: Account;
  let base: string;

  const post = (path: string, body: object, who = owner) => call(`${base}${path}`, { body, cookie: who.cookie });
  const patch = (id: string, body: object) => call(`${base}/items/${id}`, { method: "PATCH", body, cookie: owner.cookie });
  const lookup = async (code: string, who = owner, b = base) =>
    (await call(`${b}/lookup?code=${encodeURIComponent(code)}`, { cookie: who.cookie })).json();

  beforeEach(async () => {
    owner = await newOwner();
    base = `/api/orgs/${owner.org.id}`;
  });

  it("stores barcodes on an item, trims and de-duplicates them, and defaults to none", async () => {
    const plain = await (await post("/items", { sku: "NONE", name: "No codes" })).json();
    expect(plain.barcodes).toEqual([]);

    const item = await (await post("/items", { sku: "B-1", name: "Widget", barcodes: [" 5901234123457 ", "5901234123457", "CASE-24"] })).json();
    expect(item.barcodes).toEqual(["5901234123457", "CASE-24"]);
  });

  it("treats items from before barcodes existed as having none", async () => {
    const { ObjectId } = await import("mongodb");
    await store.items.insertOne({
      _id: new ObjectId(),
      orgId: new ObjectId(owner.org.id),
      sku: "LEGACY",
      name: "Old item",
      description: "",
      category: "",
      reorderLevel: 0,
      unitCostCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const items = await (await call(`${base}/items`, { cookie: owner.cookie })).json();
    expect(items.find((i: { sku: string }) => i.sku === "LEGACY").barcodes).toEqual([]);
    expect(await lookup("LEGACY")).toMatchObject({ kind: "item" });
  });

  it("finds an item by any of its barcodes, ignoring case and UPC/EAN zero padding", async () => {
    const item = await (await post("/items", { sku: "INT-7", name: "Retail", barcodes: ["036000291452", "Case-24"] })).json();
    for (const scanned of ["036000291452", "0036000291452", "00036000291452", "case-24", "CASE-24"]) {
      expect(await lookup(scanned)).toMatchObject({ kind: "item", item: { id: item.id } });
    }
    // The SKU still works too.
    expect(await lookup("int-7")).toMatchObject({ kind: "item", item: { id: item.id } });
    expect(await lookup("036000291453")).toEqual({ kind: "none" });
  });

  it("won't let one barcode point at two items", async () => {
    await post("/items", { sku: "A", name: "First thing", barcodes: ["5901234123457"] });
    const clash = await post("/items", { sku: "B", name: "Second thing", barcodes: ["5901234123457"] });
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toContain("First thing");
    // The same product number in another zero-padded form is still the same barcode.
    const padded = await post("/items", { sku: "C", name: "Third thing", barcodes: ["05901234123457"] });
    expect(padded.status).toBe(409);
    // Nothing was created by the failed attempts.
    expect(await store.items.countDocuments({ orgId: new (await import("mongodb")).ObjectId(owner.org.id) })).toBe(1);
  });

  it("won't let a barcode equal another item's SKU, or a SKU equal another item's barcode", async () => {
    await post("/items", { sku: "SKU-ONE", name: "Has a SKU" });
    await post("/items", { sku: "SKU-TWO", name: "Has a barcode", barcodes: ["12345670"] });
    expect((await post("/items", { sku: "SKU-THREE", name: "x", barcodes: ["sku-one"] })).status).toBe(409);
    expect((await post("/items", { sku: "12345670", name: "y" })).status).toBe(409);
  });

  it("allows the same barcode in different organizations", async () => {
    await post("/items", { sku: "A", name: "Mine", barcodes: ["5901234123457"] });
    const other = await newOwner("Other");
    const res = await call(`/api/orgs/${other.org.id}/items`, {
      body: { sku: "A", name: "Theirs", barcodes: ["5901234123457"] },
      cookie: other.cookie,
    });
    expect(res.status).toBe(201);
    expect(await lookup("5901234123457", other, `/api/orgs/${other.org.id}`)).toMatchObject({ kind: "item", item: { name: "Theirs" } });
  });

  it("lets only one of two simultaneous creates claim a barcode", async () => {
    const results = await Promise.all([
      post("/items", { sku: "R1", name: "Racer one", barcodes: ["RACE-1"] }),
      post("/items", { sku: "R2", name: "Racer two", barcodes: ["RACE-1"] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("updates barcodes on PATCH without disturbing them when they aren't sent", async () => {
    const item = await (await post("/items", { sku: "P-1", name: "Patchy", barcodes: ["AAA", "BBB"] })).json();
    expect((await (await patch(item.id, { name: "Renamed" })).json()).barcodes).toEqual(["AAA", "BBB"]);
    expect((await (await patch(item.id, { barcodes: ["BBB", "CCC"] })).json()).barcodes).toEqual(["BBB", "CCC"]);
    // Re-saving its own barcodes isn't a conflict with itself.
    expect((await patch(item.id, { barcodes: ["BBB", "CCC"] })).status).toBe(200);
    expect((await (await patch(item.id, { barcodes: [] })).json()).barcodes).toEqual([]);
    expect(await lookup("BBB")).toEqual({ kind: "none" });
  });

  it("rejects PATCHes that would steal another item's barcode, and too many barcodes", async () => {
    await post("/items", { sku: "OWNER", name: "Owner of AAA", barcodes: ["AAA"] });
    const other = await (await post("/items", { sku: "OTHER", name: "Other" })).json();
    const stolen = await patch(other.id, { barcodes: ["aaa"] });
    expect(stolen.status).toBe(409);
    expect((await stolen.json()).error).toContain("Owner of AAA");
    expect((await patch(other.id, { barcodes: Array.from({ length: 21 }, (_, i) => `C${i}`) })).status).toBe(400);
    expect((await patch(other.id, { sku: "AAA" })).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe("audit log", () => {
  let owner: Account;
  let member: Account;
  let base: string;
  let main: { id: string };

  const post = (path: string, body: object, who = owner) => call(`${base}${path}`, { body, cookie: who.cookie });
  const patch = (path: string, body: object, who = owner) => call(`${base}${path}`, { method: "PATCH", body, cookie: who.cookie });
  const del = (path: string, who = owner) => call(`${base}${path}`, { method: "DELETE", cookie: who.cookie });
  const audit = async (qs = "", who = owner) => (await call(`${base}/audit${qs}`, { cookie: who.cookie })).json();
  const events = async (qs = "") => (await audit(qs)).events as AuditShape[];
  const verify = async () => (await call(`${base}/audit/verify`, { cookie: owner.cookie })).json();
  const last = async () => (await events("?limit=1"))[0]!;

  type AuditShape = {
    id: string;
    seq: number;
    action: string;
    actor: { id: string | null; name: string };
    entity: { type: string; id: string; label: string };
    summary: string;
    changes?: { field: string; from: unknown; to: unknown }[];
    snapshot?: Record<string, unknown>;
    refs?: { movementIds?: string[] };
    prevHash: string;
    hash: string;
  };

  beforeEach(async () => {
    owner = await newOwner("Acme");
    member = await newMember(owner);
    base = `/api/orgs/${owner.org.id}`;
    main = (await (await call(`${base}/locations`, { cookie: owner.cookie })).json())[0];
  });

  it("starts the history with the organization and records who joined", async () => {
    const all = (await events()).reverse();
    expect(all.map((e) => e.action)).toEqual(["organization.created", "member.joined"]);
    expect(all[0]).toMatchObject({ seq: 1, actor: { name: "Ada" }, entity: { type: "organization", label: "Acme" } });
    expect(all[1]).toMatchObject({ seq: 2, actor: { name: "Bob" }, entity: { type: "member", label: "Bob" } });
    expect(all[1]!.summary).toContain("signed up with the join code");
  });

  it("records item creation, field-level edits, and ignores edits that change nothing", async () => {
    const item = await (await post("/items", { sku: "A-1", name: "Widget", unitCostCents: 100, barcodes: ["111"] })).json();
    expect(await last()).toMatchObject({
      action: "item.created",
      summary: "Created Widget (A-1)",
      entity: { type: "item", id: item.id, label: "Widget (A-1)" },
      snapshot: { sku: "A-1", name: "Widget", unitCostCents: 100, barcodes: ["111"] },
    });

    await patch(`/items/${item.id}`, { name: "Widget Pro", unitCostCents: 125, barcodes: ["111", "222"] }, member);
    const edit = await last();
    expect(edit.action).toBe("item.updated");
    expect(edit.actor.name).toBe("Bob");
    expect(edit.changes).toEqual([
      { field: "name", from: "Widget", to: "Widget Pro" },
      { field: "unitCostCents", from: 100, to: 125 },
      { field: "barcodes", from: ["111"], to: ["111", "222"] },
    ]);
    expect(edit.summary).toBe("Changed name from Widget to Widget Pro; changed unit cost from $1.00 to $1.25; changed barcodes from 111 to 111, 222");

    const before = (await events()).length;
    await patch(`/items/${item.id}`, { name: "Widget Pro", unitCostCents: 125 });
    expect((await events()).length).toBe(before);
  });

  it("records stock changes against the item, linked to their ledger entries", async () => {
    const item = await (await post("/items", { sku: "S-1", name: "Stocked" })).json();
    const shed = await (await post("/locations", { name: "Shed" })).json();

    const rec = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 10, reference: "PO 9" })).json();
    expect(await last()).toMatchObject({ action: "stock.received", summary: "Received 10 × Stocked at Main (PO 9)", refs: { movementIds: rec.movementIds } });

    await post(`/items/${item.id}/adjust`, { locationId: main.id, delta: -2, reason: "damaged" });
    expect((await last()).summary).toBe("Removed 2 × Stocked at Main (damaged)");

    const moved = await (await post("/moves", { itemId: item.id, fromLocationId: main.id, toLocationId: shed.id, quantity: 3 })).json();
    expect(await last()).toMatchObject({ action: "stock.moved", summary: "Moved 3 × Stocked from Main to Shed", refs: { movementIds: moved.movementIds } });

    await call(`${base}/movements/${moved.movementIds[0]}/reverse`, { body: { reason: "wrong shelf" }, cookie: owner.cookie });
    expect(await last()).toMatchObject({ action: "stock.reversed", summary: "Reversed the move of 3 × Stocked from Main to Shed: wrong shelf" });

    // All of it is on the item's own trail.
    const trail = await events(`?entityType=item&entityId=${item.id}`);
    expect(trail.map((e) => e.action).reverse()).toEqual(["item.created", "stock.received", "stock.adjusted", "stock.moved", "stock.reversed"]);
  });

  it("keeps the ledger and a snapshot when an item is deleted, and refuses to reverse its entries", async () => {
    const item = await (await post("/items", { sku: "D-1", name: "Doomed" })).json();
    const rec = await (await post("/receipts", { itemId: item.id, locationId: main.id, quantity: 7 })).json();
    expect((await del(`/items/${item.id}`)).status).toBe(204);

    const gone = await last();
    expect(gone).toMatchObject({ action: "item.deleted", summary: "Deleted Doomed (D-1) and wrote off 7 units" });
    expect(gone.snapshot).toMatchObject({ name: "Doomed", quantityWrittenOff: 7, stock: [{ location: "Main", quantity: 7 }] });

    // Ledger: receipt and write-off both survive and still name the item.
    const ledger = (await (await call(`${base}/movements`, { cookie: owner.cookie })).json()).entries;
    expect(ledger.map((e: { delta: number }) => e.delta)).toEqual([-7, 7]);
    expect(ledger[0].itemName).toBe("Doomed (deleted)");
    expect(ledger[0].reason).toBe("Item deleted");

    const res = await call(`${base}/movements/${rec.movementIds[0]}/reverse`, { body: {}, cookie: owner.cookie });
    expect(res.status).toBe(409);
    expect((await verify()).ledgerGaps).toBe(0);
  });

  it("records location changes using paths people recognise", async () => {
    const plant = await (await post("/locations", { name: "Plant 1" })).json();
    const rack = await (await post("/locations", { name: "Rack A", parentId: plant.id, type: "storage" })).json();
    expect(await last()).toMatchObject({ action: "location.created", summary: "Created location Plant 1 / Rack A" });

    await patch(`/locations/${rack.id}`, { name: "Rack B", type: "wip", parentId: null });
    const edit = await last();
    expect(edit.action).toBe("location.updated");
    expect(edit.changes).toEqual([
      { field: "name", from: "Rack A", to: "Rack B" },
      { field: "type", from: "storage", to: "wip" },
      { field: "parent", from: "Plant 1", to: "" },
    ]);

    await del(`/locations/${rack.id}`);
    expect(await last()).toMatchObject({ action: "location.deleted", summary: "Deleted location Rack B", snapshot: { name: "Rack B", type: "wip" } });
  });

  it("records org renames and join code changes without writing the codes down", async () => {
    await patch("", { name: "Acme Inc" });
    expect(await last()).toMatchObject({ action: "organization.renamed", changes: [{ field: "name", from: "Acme", to: "Acme Inc" }] });

    const before = owner.org.joinCode!;
    const rotated = await (await post("/join-code", {})).json();
    expect(await last()).toMatchObject({ action: "organization.join_code_rotated" });
    const everything = JSON.stringify(await events("?limit=200"));
    expect(everything).not.toContain(before);
    expect(everything).not.toContain(rotated.joinCode);
    expect(everything.toLowerCase()).not.toContain("passwordhash");
  });

  it("builds an unbroken hash chain, and every organization has its own", async () => {
    await post("/items", { sku: "C-1", name: "One" });
    await post("/items", { sku: "C-2", name: "Two" });
    const all = (await events("?limit=200")).reverse();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all[0]!.prevHash).toBe("0".repeat(64));
    all.slice(1).forEach((e, i) => expect(e.prevHash).toBe(all[i]!.hash));
    const v = await verify();
    expect(v).toMatchObject({ ok: true, checked: all.length, headSeq: all.length, headHash: all.at(-1)!.hash, ledgerGaps: 0 });

    const other = await newOwner("Other");
    const theirs = (await (await call(`/api/orgs/${other.org.id}/audit`, { cookie: other.cookie })).json()).events;
    expect(theirs).toHaveLength(1);
    expect(theirs[0].seq).toBe(1);
  });

  it("stays consistent when many changes happen at once", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post("/items", { sku: `P-${i}`, name: `Parallel ${i}` })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const all = (await events("?limit=200")).reverse();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all.filter((e) => e.action === "item.created")).toHaveLength(12);
    expect(await verify()).toMatchObject({ ok: true });
  });

  it("detects an event that was edited after the fact", async () => {
    await post("/items", { sku: "T-1", name: "Tampered" });
    const target = await last();
    await store.audit.updateOne({ orgId: new (await import("mongodb")).ObjectId(owner.org.id), seq: target.seq }, { $set: { summary: "Nothing to see here" } });
    const v = await verify();
    expect(v.ok).toBe(false);
    expect(v.problem).toMatchObject({ seq: target.seq });
    expect(v.problem.reason).toContain("changed after being recorded");
  });

  it("detects a changed actor, and an event deleted from the middle", async () => {
    const { ObjectId } = await import("mongodb");
    const orgId = new ObjectId(owner.org.id);
    await post("/items", { sku: "T-2", name: "Two" });
    await post("/items", { sku: "T-3", name: "Three" });
    expect(await verify()).toMatchObject({ ok: true });

    await store.audit.updateOne({ orgId, seq: 3 }, { $set: { "actor.name": "Someone Else" } });
    expect((await verify()).problem).toMatchObject({ seq: 3 });
    await store.audit.updateOne({ orgId, seq: 3 }, { $set: { "actor.name": "Ada" } });
    expect(await verify()).toMatchObject({ ok: true });

    await store.audit.deleteOne({ orgId, seq: 2 });
    const v = await verify();
    expect(v.ok).toBe(false);
    expect(v.problem).toMatchObject({ seq: 2, reason: "Event 2 is missing" });
  });

  it("notices ledger entries that were never audited", async () => {
    const { ObjectId } = await import("mongodb");
    const item = await (await post("/items", { sku: "G-1", name: "Gap" })).json();
    await store.movements.insertOne({
      _id: new ObjectId(),
      orgId: new ObjectId(owner.org.id),
      type: "adjust",
      itemId: new ObjectId(item.id),
      locationId: new ObjectId(main.id),
      delta: 5,
      reason: "Slipped in sideways",
      userName: "Mallory",
      createdAt: new Date(Date.now() + 1000),
    });
    expect(await verify()).toMatchObject({ ok: true, ledgerGaps: 1 });
  });

  it("is for admins only, and only for your own organization", async () => {
    expect((await call(`${base}/audit`, { cookie: member.cookie })).status).toBe(403);
    expect((await call(`${base}/audit/verify`, { cookie: member.cookie })).status).toBe(403);
    expect((await call(`${base}/audit/export`, { cookie: member.cookie })).status).toBe(403);
    const stranger = await newOwner("Elsewhere");
    expect((await call(`${base}/audit`, { cookie: stranger.cookie })).status).toBe(404);
  });

  it("filters by entity, action group, actor and text, and pages without overlap", async () => {
    const a = await (await post("/items", { sku: "F-1", name: "Findme" })).json();
    await post("/items", { sku: "F-2", name: "Other" });
    await post("/locations", { name: "Elsewhere" });
    await patch(`/items/${a.id}`, { name: "Findme Too" }, member);

    expect((await events(`?entityId=${a.id}`)).map((e) => e.action).reverse()).toEqual(["item.created", "item.updated"]);
    expect((await events("?action=location")).map((e) => e.action)).toEqual(["location.created"]);
    expect((await events("?action=item.updated")).length).toBe(1);
    expect((await events(`?actorId=${member.user.id}`)).map((e) => e.action).sort()).toEqual(["item.updated", "member.joined"]);
    expect((await events("?q=findme")).length).toBe(2);
    expect((await events("?entityType=organization")).length).toBe(1);

    const first = await audit("?limit=3");
    const second = await audit(`?limit=3&before=${first.nextBefore}`);
    const seen = [...first.events, ...second.events].map((e: AuditShape) => e.seq);
    expect(new Set(seen).size).toBe(seen.length);
    expect(Math.max(...second.events.map((e: AuditShape) => e.seq))).toBeLessThan(Math.min(...first.events.map((e: AuditShape) => e.seq)));
  });

  it("exports a CSV with one row per event and proper quoting", async () => {
    await post("/items", { sku: "X-1", name: 'Quote "this", please' });
    const res = await call(`${base}/audit/export`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("seq,time,actor,action,entity_type,entity_id,entity,summary,changes,refs,prev_hash,hash");
    expect(lines).toHaveLength(1 + (await events("?limit=200")).length);
    expect(text).toContain('"Created Quote ""this"", please (X-1)"');
  });
});
