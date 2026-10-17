import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Needs a running MongoDB (docker compose up -d). Each run uses its own throwaway database.
const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
let cookie = "";

const json = (body: unknown, method = "POST", extra: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});
const authed = (body?: unknown, method = "POST") =>
  body === undefined
    ? { method, headers: { cookie } }
    : json(body, method, { cookie });

const credentials = { name: "Ada", email: "ada@example.com", password: "correct horse" };
const sessionCookie = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
});

afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

beforeEach(async () => {
  await Promise.all([
    store.items.deleteMany({}),
    store.movements.deleteMany({}),
    store.users.deleteMany({}),
    store.sessions.deleteMany({}),
  ]);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
  const res = await app.request("/api/auth/register", json(credentials));
  cookie = sessionCookie(res);
});

describe("auth", () => {
  it("registers the first user as admin and sets an httpOnly session cookie", async () => {
    await store.users.deleteMany({});
    const res = await app.request("/api/auth/register", json(credentials));
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    const user = await res.json();
    expect(user).toMatchObject({ email: "ada@example.com", role: "admin" });
    expect(user).not.toHaveProperty("passwordHash");

    const second = await app.request(
      "/api/auth/register",
      json({ ...credentials, email: "bob@example.com" }),
    );
    expect((await second.json()).role).toBe("member");
  });

  it("rejects duplicate emails and weak passwords", async () => {
    const dupe = await app.request("/api/auth/register", json(credentials));
    expect(dupe.status).toBe(409);
    const weak = await app.request(
      "/api/auth/register",
      json({ ...credentials, email: "x@example.com", password: "short" }),
    );
    expect(weak.status).toBe(400);
  });

  it("logs in with the right password only, and logout kills the session", async () => {
    const bad = await app.request("/api/auth/login", json({ email: credentials.email, password: "nope" }));
    expect(bad.status).toBe(401);

    const ok = await app.request("/api/auth/login", json({ email: "ADA@example.com", password: credentials.password }));
    expect(ok.status).toBe(200);
    const c = sessionCookie(ok);
    expect((await app.request("/api/auth/me", { headers: { cookie: c } })).status).toBe(200);

    await app.request("/api/auth/logout", { method: "POST", headers: { cookie: c } });
    expect((await app.request("/api/auth/me", { headers: { cookie: c } })).status).toBe(401);
  });

  it("locks an email out after repeated failures", async () => {
    for (let i = 0; i < 10; i++) {
      await app.request("/api/auth/login", json({ email: credentials.email, password: "wrong" }));
    }
    const res = await app.request("/api/auth/login", json({ email: credentials.email, password: credentials.password }));
    expect(res.status).toBe(429);
  });

  it("closes registration when disabled, except for the first account", async () => {
    const closed = createApp(store, { allowRegistration: false, cookieSecure: false });
    const res = await closed.request("/api/auth/register", json({ ...credentials, email: "late@example.com" }));
    expect(res.status).toBe(403);
    expect(await (await closed.request("/api/auth/config")).json()).toEqual({ registrationOpen: false });

    await store.users.deleteMany({});
    expect(await (await closed.request("/api/auth/config")).json()).toEqual({ registrationOpen: true });
  });

  it("requires a session for inventory routes", async () => {
    expect((await app.request("/api/items")).status).toBe(401);
    expect((await app.request("/api/items", json({ sku: "A", name: "A" }))).status).toBe(401);
    expect((await app.request("/api/items", { headers: { cookie: "invintel_session=forged" } })).status).toBe(401);
  });
});

describe("items api", () => {
  const create = async (body: object) => app.request("/api/items", authed(body));

  it("creates an item, logs initial stock, and rejects duplicate SKUs", async () => {
    const res = await create({ sku: "A-1", name: "Widget", quantity: 5 });
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(item.quantity).toBe(5);

    const moves = await (await app.request(`/api/items/${item.id}/movements`, authed(undefined, "GET"))).json();
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(5);

    expect((await create({ sku: "A-1", name: "Other" })).status).toBe(409);
  });

  it("validates input and ids", async () => {
    expect((await create({ sku: "", name: "x" })).status).toBe(400);
    expect((await app.request("/api/items/not-an-id", authed(undefined, "GET"))).status).toBe(400);
  });

  it("adjusts stock and refuses to go negative", async () => {
    const item = await (await create({ sku: "B-1", name: "Bolt", quantity: 3 })).json();

    const ok = await app.request(`/api/items/${item.id}/adjust`, authed({ delta: -2, reason: "sold" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).quantity).toBe(1);

    const bad = await app.request(`/api/items/${item.id}/adjust`, authed({ delta: -5 }));
    expect(bad.status).toBe(422);
  });

  it("never oversells under concurrent removals", async () => {
    const item = await (await create({ sku: "R-1", name: "Race", quantity: 5 })).json();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.request(`/api/items/${item.id}/adjust`, authed({ delta: -1 }))),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    const after = await (await app.request(`/api/items/${item.id}`, authed(undefined, "GET"))).json();
    expect(after.quantity).toBe(0);
  });

  it("ignores quantity on PATCH, updates other fields, and deletes", async () => {
    const item = await (await create({ sku: "C-1", name: "Cog", quantity: 4 })).json();

    const patched = await (
      await app.request(`/api/items/${item.id}`, authed({ name: "Big Cog", quantity: 99 }, "PATCH"))
    ).json();
    expect(patched.name).toBe("Big Cog");
    expect(patched.quantity).toBe(4);

    expect((await app.request(`/api/items/${item.id}`, authed(undefined, "DELETE"))).status).toBe(204);
    expect((await app.request(`/api/items/${item.id}`, authed(undefined, "GET"))).status).toBe(404);
  });
});
