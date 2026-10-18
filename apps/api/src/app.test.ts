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
    [store.users, store.sessions, store.orgs, store.memberships, store.locations, store.items, store.stock, store.movements].map(
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

  it("ignores quantity on PATCH, updates other fields, and deletes with its history", async () => {
    const item = await (await create({ sku: "D-1", name: "Cog", initialStock: { locationId: main.id, quantity: 4 } })).json();

    const patched = await (
      await call(`${base}/items/${item.id}`, { method: "PATCH", body: { name: "Big Cog", quantity: 99 }, cookie: owner.cookie })
    ).json();
    expect(patched).toMatchObject({ name: "Big Cog", quantity: 4 });

    expect((await call(`${base}/items/${item.id}`, { method: "DELETE", cookie: owner.cookie })).status).toBe(204);
    expect((await call(`${base}/items/${item.id}`, { cookie: owner.cookie })).status).toBe(404);
    expect(await store.stock.countDocuments({ itemId: { $exists: true } })).toBe(0);
    expect(await store.movements.countDocuments()).toBe(0);
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
