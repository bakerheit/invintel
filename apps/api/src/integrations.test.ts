import { createHmac, randomBytes } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { MAX_ATTEMPTS, MAX_FAILURES, RETRY_DELAYS, deliverDue, sign, startWebhookWorker } from "./webhooks.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});
afterEach(() => {
  delete process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE;
  delete process.env.INVINTEL_WEBHOOK_TIMEOUT_MS;
  vi.restoreAllMocks();
});

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `ig${++n}@example.com`, password: "correct horse", organization }),
  });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization as { id: string; joinCode: string } };
}

type Auth = { cookie: string } | { bearer: string };
function client(auth: Auth, orgId: string, theApp = app) {
  const base = `/api/orgs/${orgId}`;
  const headers = (body: boolean): Record<string, string> => ({
    ...("cookie" in auth ? { cookie: auth.cookie } : { authorization: `Bearer ${auth.bearer}` }),
    ...(body ? { "content-type": "application/json" } : {}),
  });
  const raw = (path: string, body?: unknown, method?: string) =>
    theApp.request(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await raw(path, body, method);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { base, raw, json };
}

/** An org with an owner, a location and two items. */
async function world() {
  const owner = await signUp({ mode: "create", name: "Acme" });
  const admin = client({ cookie: owner.cookie }, owner.org.id);
  const main = (await admin.json("/locations")).body[0].id as string;
  const bolt = (await admin.json("/items", { sku: "BOLT", name: "Bolt", initialStock: { locationId: main, quantity: 50 } })).body.id as string;
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const mem = client({ cookie: member.cookie }, owner.org.id);
  const makeKey = async (scope: "read" | "write", extra: object = {}) => (await admin.json("/api-keys", { name: `${scope} key`, scope, ...extra })).body as { id: string; key: string; prefix: string };
  return { owner, admin, mem, main, bolt, orgId: owner.org.id, makeKey };
}

describe("API keys", () => {
  it("are made by admins, shown once, and only their hash is kept", async () => {
    const w = await world();
    const made = await w.admin.json("/api-keys", { name: "Shopify sync", scope: "write", expiresInDays: 90 });
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^ivk_[A-Za-z0-9_-]{43}$/);
    expect(made.body).toMatchObject({ name: "Shopify sync", scope: "write", lastUsedAt: null, revokedAt: null });
    expect(new Date(made.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(made.body.prefix).toBe(`${made.body.key.slice(0, 12)}…`);

    const list = (await w.admin.json("/api-keys")).body;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(made.body.key);
    expect(JSON.stringify(list)).not.toContain("hash");
    const stored = (await store.apiKeys.findOne({ _id: new ObjectId(made.body.id) }))!;
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(made.body.key); // nowhere in the record
    const events = (await w.admin.json("/audit")).body.events as { action: string; summary: string }[];
    const created = events.find((e) => e.action === "api_key.created")!;
    expect(created.summary).toContain("Shopify sync");
    expect(JSON.stringify(events)).not.toContain(made.body.key);

    expect((await w.mem.json("/api-keys")).status).toBe(403);
    expect((await w.mem.json("/api-keys", { name: "x", scope: "read" })).status).toBe(403);
    expect((await w.admin.json("/api-keys", { name: "", scope: "read" })).status).toBe(400);
    expect((await w.admin.json("/api-keys", { name: "x", scope: "admin" })).status).toBe(400);
  });

  it("let a read key look things up and nothing else", async () => {
    const w = await world();
    const k = await w.makeKey("read");
    const key = client({ bearer: k.key }, w.orgId);
    expect((await key.json("/items")).body).toHaveLength(1);
    expect((await key.json(`/items/${w.bolt}`)).status).toBe(200);
    expect((await key.json("/locations")).status).toBe(200);
    expect((await key.json("/overview")).status).toBe(200);
    expect((await key.json("/movements")).status).toBe(200);
    expect((await key.json("/purchasing/orders")).status).toBe(200);
    for (const [path, body, method] of [
      ["/items", { sku: "X", name: "X" }, "POST"],
      [`/items/${w.bolt}/adjust`, { locationId: w.main, delta: 1 }, "POST"],
      [`/items/${w.bolt}`, { name: "Renamed" }, "PATCH"],
      ["/receipts", { itemId: w.bolt, locationId: w.main, quantity: 1 }, "POST"],
    ] as const) {
      expect((await key.json(path, body, method)).status, `${method} ${path}`).toBe(403);
    }
    expect((await w.admin.json(`/items/${w.bolt}`)).body.quantity).toBe(50);
  });

  it("let a write key do everyday work, named in the ledger, but never delete or administer", async () => {
    const w = await world();
    const k = await w.makeKey("write");
    const key = client({ bearer: k.key }, w.orgId);
    expect((await key.json("/items", { sku: "NUT", name: "Nut" })).status).toBe(201);
    expect((await key.json(`/items/${w.bolt}/adjust`, { locationId: w.main, delta: -5, reason: "sync" })).status).toBe(200);
    expect((await key.json("/receipts", { itemId: w.bolt, locationId: w.main, quantity: 10 })).status).toBe(201);
    expect((await key.json(`/items/${w.bolt}`, { name: "Bolt M8" }, "PATCH")).status).toBe(200);
    expect((await w.admin.json(`/items/${w.bolt}`)).body).toMatchObject({ name: "Bolt M8", quantity: 55 });
    const ledger = (await w.admin.json("/movements?limit=10")).body.entries as { userName: string; reason: string }[];
    expect(ledger.some((e) => e.userName === `API key: ${k.key ? "write key" : ""}` && e.reason === "sync")).toBe(true);

    // Never: deleting, administering, importing, restoring, listing people, the audit log, keys, webhooks.
    for (const [path, body, method] of [
      [`/items/${w.bolt}`, undefined, "DELETE"],
      ["/members", undefined, "GET"],
      ["/audit", undefined, "GET"],
      ["/api-keys", undefined, "GET"],
      ["/api-keys", { name: "mine", scope: "write" }, "POST"],
      ["/webhooks", undefined, "GET"],
      ["/data/archive.json", undefined, "GET"],
      ["/data/items.csv", undefined, "GET"],
      ["/data/items/import", { csv: "sku,name\nA,B", dryRun: false }, "POST"],
      ["/data/archive/restore", { archive: {}, dryRun: true }, "POST"],
      ["/join-code", {}, "POST"],
      ["/modules", { production: false }, "PATCH"],
      ["/locations", { name: "New" }, "POST"],
      ["/", undefined, "GET"],
      ["/approvals", undefined, "GET"],
      ["/settings", undefined, "GET"],
    ] as const) {
      expect((await key.json(path, body, method)).status, `${method} ${path}`).toBe(403);
    }
    expect((await w.admin.json("/items")).body).toHaveLength(2);
  });

  it("belong to one organization and can't list or create organizations", async () => {
    const a = await world();
    const b = await world();
    const k = await a.makeKey("write");
    const res = await app.request(`/api/orgs/${b.orgId}/items`, { headers: { authorization: `Bearer ${k.key}` } });
    expect(res.status).toBe(404);
    expect((await app.request("/api/orgs", { headers: { authorization: `Bearer ${k.key}` } })).status).toBe(403);
    expect((await app.request("/api/orgs", { method: "POST", headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Mine" }) })).status).toBe(403);
    expect((await app.request("/api/auth/me", { headers: { authorization: `Bearer ${k.key}` } })).status).toBe(401);
  });

  it("stop at once when revoked or expired, and wrong keys look like no key", async () => {
    const w = await world();
    const k = await w.makeKey("read");
    const key = client({ bearer: k.key }, w.orgId);
    expect((await key.json("/items")).status).toBe(200);
    const stored = (await store.apiKeys.findOne({ _id: new ObjectId(k.id) }))!;
    expect(stored.lastUsedAt).toBeTruthy();

    const revoked = await w.admin.json(`/api-keys/${k.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).toBeTruthy();
    expect((await key.json("/items")).status).toBe(401);
    expect((await w.admin.json(`/api-keys/${k.id}/revoke`, {})).status).toBe(404); // already
    expect(((await w.admin.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "api_key.revoked")).toBe(true);

    const old = await w.makeKey("read");
    await store.apiKeys.updateOne({ _id: new ObjectId(old.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await client({ bearer: old.key }, w.orgId).json("/items")).status).toBe(401);

    const live = await w.makeKey("read");
    const flipped = `${live.key.slice(0, -1)}${live.key.endsWith("A") ? "B" : "A"}`;
    for (const bearer of [flipped, "ivk_" + "x".repeat(43), "nope", "ivk_short", `${live.key} extra`]) {
      const res = await client({ bearer }, w.orgId).json("/items");
      expect(res.status, bearer).toBe(401);
      expect(res.body).toEqual({ error: "Not signed in" });
    }
    expect((await app.request(`/api/orgs/${w.orgId}/items`, { headers: { authorization: `Basic ${live.key}` } })).status).toBe(401);
    expect((await client({ bearer: live.key }, w.orgId).json("/items")).status).toBe(200);
  });

  it("slow down a key that asks too much, and an address that guesses keys", async () => {
    const fast = createApp(store, { allowRegistration: true, cookieSecure: false, apiKeyRatePerMinute: 5 });
    const w = await world();
    const k = await w.makeKey("read");
    const key = client({ bearer: k.key }, w.orgId, fast);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await key.json("/items")).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    expect((await key.json("/items")).headers.get("retry-after")).toBeTruthy();

    const strict = createApp(store, { allowRegistration: true, cookieSecure: false });
    const wrong = client({ bearer: "ivk_" + "z".repeat(43) }, w.orgId, strict);
    const results: number[] = [];
    for (let i = 0; i < 22; i++) results.push((await wrong.json("/items")).status);
    expect(results.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(results.slice(20)).toEqual([429, 429]);
    // Once locked, even the right key from that address waits.
    expect((await client({ bearer: k.key }, w.orgId, strict).json("/items")).status).toBe(429);
  });

  it("go through the approval rules like the member they act as", async () => {
    const w = await world();
    await w.admin.json("/approvals/rules", { rules: [{ kind: "adjustment", thresholdCents: 1, appliesTo: "members" }] }, "PUT").catch(() => {});
    const k = await w.makeKey("write");
    // Give the item a cost so an adjustment has a value, then set a rule that applies to members.
    await w.admin.json(`/items/${w.bolt}`, { unitCostCents: 500 }, "PATCH");
    await store.orgs.updateOne({ _id: new ObjectId(w.orgId) }, { $set: { approvalRules: [{ kind: "adjustment", thresholdCents: 100, appliesTo: "members" }] } });
    const res = await client({ bearer: k.key }, w.orgId).json(`/items/${w.bolt}/adjust`, { locationId: w.main, delta: -10 });
    expect(res.status).toBe(202);
    expect(res.body.approvalRequired).toBe(true);
    expect((await w.admin.json(`/items/${w.bolt}`)).body.quantity).toBe(50); // nothing changed until a person approves
  });
});

// ---------------- webhooks ----------------

interface Hit { headers: http.IncomingHttpHeaders; body: string }
async function receiver(handler?: (hit: Hit, res: http.ServerResponse, count: number) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = { headers: req.headers, body: Buffer.concat(chunks).toString() };
      hits.push(hit);
      if (handler) handler(hit, res, hits.length);
      else res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { url, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const allowLocal = () => { process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true"; };
const verify = (secret: string, hit: Hit) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers["x-invintel-signature"]));
  return !!m && createHmac("sha256", secret).update(`${m[1]}.${hit.body}`).digest("hex") === m[2];
};
const hookState = async (id: string) => (await store.webhooks.findOne({ _id: new ObjectId(id) }))!;

describe("webhooks: setting up", () => {
  it("are managed by admins; the secret is shown once", async () => {
    const w = await world();
    const made = await w.admin.json("/webhooks", { url: "https://hooks.example.com/invintel", events: ["item.created", "stock.adjusted"], description: "ERP" });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    expect(made.body).toMatchObject({ enabled: true, events: ["item.created", "stock.adjusted"], description: "ERP", lastDelivery: null });
    expect(JSON.stringify((await w.admin.json("/webhooks")).body)).not.toContain(made.body.secret);
    expect(((await w.admin.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "webhook.created")).toBe(true);

    expect((await w.mem.json("/webhooks")).status).toBe(403);
    expect((await w.mem.json("/webhooks", { url: "https://x.example.com/", events: ["*"] })).status).toBe(403);
    expect((await w.admin.json("/webhooks", { url: "https://x.example.com/", events: [] })).status).toBe(400);
    expect((await w.admin.json("/webhooks", { url: "https://x.example.com/", events: ["member.removed"] })).status).toBe(400); // not a public event
    expect((await w.admin.json("/webhooks", { url: "https://x.example.com/", events: ["*", "item.created"] })).body.events).toEqual(["*"]);
  });

  it("refuse private and unsafe addresses when they are saved", async () => {
    const w = await world();
    for (const url of ["http://example.com/hook", "https://localhost/hook", "https://127.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/", "https://[::1]/", "https://[::ffff:7f00:1]/", "https://2130706433/", "https://user:pw@example.com/", "not a url", "ftp://example.com/"]) {
      const res = await w.admin.json("/webhooks", { url, events: ["*"] });
      expect(res.status, url).toBe(400);
      expect(res.body.error.length, url).toBeGreaterThan(10);
    }
    expect(await w.admin.json("/webhooks")).toMatchObject({ body: [] });
    const ok = await w.admin.json("/webhooks", { url: "https://hooks.example.com/a", events: ["*"] });
    expect((await w.admin.json(`/webhooks/${ok.body.id}`, { url: "https://169.254.169.254/" }, "PATCH")).status).toBe(400);
    expect((await w.admin.json(`/webhooks/${ok.body.id}`, { url: "https://hooks.example.com/b" }, "PATCH")).status).toBe(200);
  });

  it("are per organization", async () => {
    const a = await world();
    const b = await world();
    const hook = (await a.admin.json("/webhooks", { url: "https://hooks.example.com/a", events: ["*"] })).body;
    expect((await b.admin.json(`/webhooks/${hook.id}`, { enabled: false }, "PATCH")).status).toBe(404);
    expect((await b.admin.json(`/webhooks/${hook.id}/test`, {})).status).toBe(404);
    expect((await b.admin.json(`/webhooks/${hook.id}`, undefined, "DELETE")).status).toBe(404);
    expect((await b.admin.json("/webhooks")).body).toEqual([]);
  });
});

describe("webhooks: delivering", () => {
  it("send a signed event for what happened, once, with no snapshots", async () => {
    allowLocal();
    const rx = await receiver();
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: rx.url, events: ["item.created", "stock.adjusted"] })).body;

    await w.admin.json("/items", { sku: "NUT", name: "Nut", unitCostCents: 9 });
    await w.admin.json(`/items/${w.bolt}/adjust`, { locationId: w.main, delta: -3, reason: "Used" });
    await w.admin.json("/locations", { name: "Dock" }); // not an event a webhook can have
    expect(await deliverDue(store)).toBe(2);
    expect(rx.hits).toHaveLength(2);

    const first = rx.hits[0]!;
    expect(verify(hook.secret, first)).toBe(true);
    expect(verify("whsec_wrong", first)).toBe(false);
    expect(first.headers["content-type"]).toBe("application/json");
    expect(first.headers["x-invintel-event"]).toBe("item.created");
    expect(first.headers["user-agent"]).toBe("Invintel-Webhooks/1");
    const event = JSON.parse(first.body);
    expect(event).toMatchObject({ type: "item.created", organizationId: w.orgId, actor: { name: "Ada" }, entity: { type: "item", label: "Nut (NUT)" } });
    expect(event.id).toBe(first.headers["x-invintel-event-id"]);
    expect(event).not.toHaveProperty("snapshot");
    expect(JSON.parse(rx.hits[1]!.body).type).toBe("stock.adjusted");

    const log = (await w.admin.json(`/webhooks/${hook.id}/deliveries`)).body as { status: string; attempts: number; responseStatus: number }[];
    expect(log.map((d) => [d.status, d.attempts, d.responseStatus])).toEqual([["delivered", 1, 200], ["delivered", 1, 200]]);
    expect(await deliverDue(store)).toBe(0); // nothing is sent twice
    expect((await w.admin.json("/webhooks")).body[0].lastDelivery).toMatchObject({ status: "delivered" });
    await rx.close();
  });

  it("only send what was asked for, never admin events, and nothing when switched off", async () => {
    allowLocal();
    const rx = await receiver();
    const w = await world();
    const all = (await w.admin.json("/webhooks", { url: rx.url, events: ["*"] })).body;
    await w.admin.json("/api-keys", { name: "k", scope: "read" }); // an audit event that is not public
    await w.admin.json("/members", undefined);
    await deliverDue(store);
    expect(rx.hits).toHaveLength(0);

    await w.admin.json(`/webhooks/${all.id}`, { enabled: false }, "PATCH");
    await w.admin.json("/items", { sku: "N1", name: "N1" });
    expect(await deliverDue(store)).toBe(0);
    expect(rx.hits).toHaveLength(0);
    await w.admin.json(`/webhooks/${all.id}`, { enabled: true }, "PATCH");
    await w.admin.json("/items", { sku: "N2", name: "N2" });
    await deliverDue(store);
    expect(rx.hits.map((h) => JSON.parse(h.body).entity.label)).toEqual(["N2 (N2)"]);
    await rx.close();
  });

  it("try again later when the receiver fails, with the same event id, and stop trying after the last attempt", async () => {
    allowLocal();
    const rx = await receiver((_hit, res, count) => res.writeHead(count < 3 ? 503 : 200).end());
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: rx.url, events: ["item.created"] })).body;
    await w.admin.json("/items", { sku: "R1", name: "R1" });

    const start = Date.now();
    await deliverDue(store); // attempt 1: 503
    let d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!;
    expect(d).toMatchObject({ status: "retrying", attempts: 1, responseStatus: 503 });
    expect(d.error).toMatch(/503/);
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(start + RETRY_DELAYS[0]! * 1000 - 50);
    expect(await deliverDue(store)).toBe(0); // not due yet
    await deliverDue(store, { now: new Date(start + 61_000) }); // attempt 2: 503
    await deliverDue(store, { now: new Date(start + 61_000 + 301_000) }); // attempt 3: 200
    d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!;
    expect(d).toMatchObject({ status: "delivered", attempts: 3, responseStatus: 200 });
    expect(new Set(rx.hits.map((h) => h.headers["x-invintel-event-id"])).size).toBe(1);
    expect(new Set(rx.hits.map((h) => h.body)).size).toBe(1); // the same bytes each time
    expect(new Set(rx.hits.map((h) => h.headers["x-invintel-delivery"])).size).toBe(1);
    await rx.close();

    const dead = await receiver((_hit, res) => res.writeHead(500).end("no"));
    await w.admin.json(`/webhooks/${hook.id}`, { url: dead.url }, "PATCH");
    await w.admin.json("/items", { sku: "R2", name: "R2" });
    let clock = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { clock += 7 * 3600_000; await deliverDue(store, { now: new Date(clock) }); }
    const failed = (await store.webhookDeliveries.find({ webhookId: new ObjectId(hook.id), status: "failed" }).toArray())[0]!;
    expect(failed.attempts).toBe(MAX_ATTEMPTS);
    expect(dead.hits).toHaveLength(MAX_ATTEMPTS);
    expect(failed.nextAttemptAt).toBeNull();
    expect((await hookState(hook.id)).failures).toBe(1);
    // A failed delivery can be tried again by hand.
    const retried = await w.admin.json(`/webhooks/${hook.id}/deliveries/${failed._id.toHexString()}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: "retrying", attempts: 1 });
    await dead.close();
  });

  it("switch a webhook off after too many deliveries give up in a row, and say so", async () => {
    allowLocal();
    const rx = await receiver((_hit, res) => res.writeHead(500).end());
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: rx.url, events: ["item.created"] })).body;
    for (let i = 0; i < MAX_FAILURES; i++) await w.admin.json("/items", { sku: `F${i}`, name: `F${i}` });
    let clock = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { clock += 7 * 3600_000; await deliverDue(store, { now: new Date(clock), limit: 500 }); }
    const state = await hookState(hook.id);
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toMatch(/10 deliveries in a row/);
    const shown = (await w.admin.json("/webhooks")).body[0];
    expect(shown).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/Switched off/) });
    expect(((await w.admin.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "webhook.disabled")).toBe(true);
    // Switching it on again starts clean.
    const again = await w.admin.json(`/webhooks/${hook.id}`, { enabled: true }, "PATCH");
    expect(again.body).toMatchObject({ enabled: true, disabledReason: null });
    expect((await hookState(hook.id)).failures).toBe(0);
    await rx.close();
  }, 30_000);

  it("never follow a redirect", async () => {
    allowLocal();
    const target = await receiver();
    const bouncer = await receiver((_hit, res) => res.writeHead(302, { location: target.url }).end());
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: bouncer.url, events: ["item.created"] })).body;
    await w.admin.json("/items", { sku: "B1", name: "B1" });
    await deliverDue(store);
    expect(bouncer.hits).toHaveLength(1);
    expect(target.hits).toHaveLength(0);
    const d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!;
    expect(d).toMatchObject({ status: "retrying", responseStatus: 302 });
    expect(d.error).toMatch(/redirects aren't followed/);
    await bouncer.close();
    await target.close();
  });

  it("give up on a receiver that doesn't answer, and don't read an endless answer", async () => {
    allowLocal();
    process.env.INVINTEL_WEBHOOK_TIMEOUT_MS = "300";
    const slow = await receiver(() => { /* never answers */ });
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: slow.url, events: ["item.created"] })).body;
    await w.admin.json("/items", { sku: "S1", name: "S1" });
    const t0 = Date.now();
    await deliverDue(store);
    expect(Date.now() - t0).toBeLessThan(3000);
    const d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!;
    expect(d.status).toBe("retrying");
    expect(d.error).toMatch(/No answer within/);
    await slow.close();

    const big = await receiver((_hit, res) => { res.writeHead(200); res.end("x".repeat(5_000_000)); });
    await w.admin.json(`/webhooks/${hook.id}`, { url: big.url }, "PATCH");
    await deliverDue(store, { now: new Date(Date.now() + 61_000) });
    expect((await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!.status).toBe("delivered");
    await big.close();
  });

  it("never connect to a private address, even if one slipped in or a name changed where it points", async () => {
    const rx = await receiver();
    const w = await world();
    // The policy is on while the webhook is saved (so the local receiver can be used)...
    allowLocal();
    const hook = (await w.admin.json("/webhooks", { url: rx.url, events: ["item.created"] })).body;
    await w.admin.json("/items", { sku: "P1", name: "P1" });
    // ...and off when it is delivered, as in production.
    delete process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE;
    await deliverDue(store);
    expect(rx.hits).toHaveLength(0);
    const d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!;
    expect(d.status).toBe("failed"); // gives up at once: waiting won't make it public
    expect(d.attempts).toBe(1);
    expect(d.error).toMatch(/https|private|reserved/);

    // A public-looking name that resolves to a private address at connect time.
    const port = new URL(rx.url).port;
    await store.webhooks.updateOne({ _id: new ObjectId(hook.id) }, { $set: { url: `https://rebind.example.test:${port}/hook`, enabled: true, failures: 0 } });
    vi.spyOn(dns, "lookup").mockImplementation(((host: string, opts: unknown, cb: (...a: unknown[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never);
    await w.admin.json("/items", { sku: "P2", name: "P2" });
    await deliverDue(store);
    const latest = (await store.webhookDeliveries.find({ webhookId: new ObjectId(hook.id) }).sort({ createdAt: -1 }).toArray())[0]!;
    expect(latest.status).toBe("failed");
    expect(latest.error).toMatch(/private address/);
    expect(rx.hits).toHaveLength(0);
    await rx.close();
  });

  it("let an admin send a test, even to a switched-off webhook, and rotate the secret", async () => {
    allowLocal();
    const rx = await receiver();
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: rx.url, events: ["item.created"] })).body;
    await w.admin.json(`/webhooks/${hook.id}`, { enabled: false }, "PATCH");
    const test = await w.admin.json(`/webhooks/${hook.id}/test`, {});
    expect(test.body).toMatchObject({ type: "webhook.test", status: "delivered", responseStatus: 200 });
    expect(verify(hook.secret, rx.hits[0]!)).toBe(true);
    expect(JSON.parse(rx.hits[0]!.body)).toMatchObject({ type: "webhook.test", summary: expect.stringMatching(/test from Invintel/) });
    expect(await store.webhookDeliveries.countDocuments({ webhookId: new ObjectId(hook.id) })).toBe(1);

    const rotated = await w.admin.json(`/webhooks/${hook.id}/rotate-secret`, {});
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(hook.secret);
    await w.admin.json(`/webhooks/${hook.id}/test`, {});
    expect(verify(rotated.body.secret, rx.hits[1]!)).toBe(true);
    expect(verify(hook.secret, rx.hits[1]!)).toBe(false);
    expect(((await w.admin.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "webhook.secret_rotated")).toBe(true);
    await rx.close();
  });

  it("removing a webhook removes its log, and members can't read it", async () => {
    allowLocal();
    const rx = await receiver();
    const w = await world();
    const hook = (await w.admin.json("/webhooks", { url: rx.url, events: ["*"] })).body;
    await w.admin.json(`/webhooks/${hook.id}/test`, {});
    expect((await w.mem.json(`/webhooks/${hook.id}/deliveries`)).status).toBe(403);
    expect((await w.admin.json(`/webhooks/${hook.id}`, undefined, "DELETE")).status).toBe(204);
    expect(await store.webhookDeliveries.countDocuments({ webhookId: new ObjectId(hook.id) })).toBe(0);
    expect((await w.admin.json("/webhooks")).body).toEqual([]);
    await rx.close();
  });

  it("two workers at once never send the same delivery twice", async () => {
    allowLocal();
    const rx = await receiver();
    const w = await world();
    await w.admin.json("/webhooks", { url: rx.url, events: ["item.created"] });
    for (let i = 0; i < 12; i++) await w.admin.json("/items", { sku: `C${i}`, name: `C${i}` });
    const [a, b] = await Promise.all([deliverDue(store), deliverDue(store)]);
    expect(a + b).toBe(12);
    const ids = rx.hits.map((h) => h.headers["x-invintel-delivery"]);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    await rx.close();
  });

  it("run on their own when the worker is started", async () => {
    allowLocal();
    const rx = await receiver();
    const w = await world();
    await w.admin.json("/webhooks", { url: rx.url, events: ["item.created"] });
    const stop = startWebhookWorker(store, 25);
    await w.admin.json("/items", { sku: "W1", name: "W1" });
    for (let i = 0; i < 40 && !rx.hits.length; i++) await new Promise((r) => setTimeout(r, 25));
    stop();
    expect(rx.hits).toHaveLength(1);
    await rx.close();
  });
});

describe("signatures", () => {
  it("are HMAC-SHA256 of the time and the body", () => {
    const s = sign("whsec_x", '{"a":1}', 1700000000);
    expect(s).toBe(`t=1700000000,v1=${createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex")}`);
    expect(sign("whsec_y", '{"a":1}', 1700000000)).not.toBe(s);
    expect(sign("whsec_x", '{"a":2}', 1700000000)).not.toBe(s);
    expect(sign("whsec_x", '{"a":1}', 1700000001)).not.toBe(s);
  });
});
