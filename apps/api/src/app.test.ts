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
