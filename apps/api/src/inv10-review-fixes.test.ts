import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { pickClientIp } from "./client-ip.js";
import { connect, type Store } from "./db.js";
import { validateWebhookUrl } from "./webhook-safety.js";
import { isSealed, openWebhookSecret, sealWebhookSecret } from "./webhook-secrets.js";
import { deliverDue } from "./webhooks.js";

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
  for (const k of ["INVINTEL_WEBHOOKS_ALLOW_PRIVATE", "INVINTEL_WEBHOOK_TIMEOUT_MS", "WEBHOOK_SECRET_KEY"]) delete process.env[k];
});

let n = 0;
const behind = (peer: string) => ({ incoming: { socket: { remoteAddress: peer } } });
/** A request as the server would see it: from `peer`, with whatever headers the sender chose. */
const send = async (theApp: ReturnType<typeof createApp>, path: string, init: RequestInit & { peer?: string } = {}): Promise<Response> => {
  const { peer = "127.0.0.1", ...rest } = init;
  return await theApp.request(path, rest, behind(peer));
};
const json = (body: unknown, headers: Record<string, string> = {}) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

async function signUp(organization: object, headers: Record<string, string> = {}) {
  const res = await send(app, "/api/auth/register", { method: "POST", ...json({ name: "Ada", email: `fx${++n}@example.com`, password: "correct horse", organization }, headers) });
  const b = await res.json();
  return { res, cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization as { id: string; joinCode: string }, email: `fx${n}@example.com` };
}

describe("1. the key path is for Bearer ivk_ keys only", () => {
  it("lets a cookie session through behind a proxy's Basic auth, and still takes keys", async () => {
    const u = await signUp({ mode: "create", name: "Acme" });
    const basic = `Basic ${Buffer.from("andrew:demo").toString("base64")}`;
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { headers: { cookie: u.cookie, authorization: basic } })).status).toBe(200);
    expect((await send(app, "/api/orgs", { headers: { cookie: u.cookie, authorization: basic } })).status).toBe(200);
    // Something else in the header that isn't one of our keys is not a key attempt either.
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { headers: { cookie: u.cookie, authorization: "Bearer some-other-token" } })).status).toBe(200);
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { headers: { cookie: u.cookie, authorization: "Token abc" } })).status).toBe(200);
    // No cookie: Basic alone is not a sign-in.
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { headers: { authorization: basic } })).status).toBe(401);
    // An ivk_ key still works, any case of the scheme, and a wrong one is refused even with a good cookie.
    const key = (await (await send(app, `/api/orgs/${u.org.id}/api-keys`, { method: "POST", ...json({ name: "k", scope: "read" }, { cookie: u.cookie }) })).json()).key as string;
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { headers: { authorization: `bearer   ${key}` } })).status).toBe(200);
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { headers: { cookie: u.cookie, authorization: `Bearer ${key.slice(0, -2)}xx` } })).status).toBe(401);
    // With both, the key decides: it can't do what a person can.
    expect((await send(app, `/api/orgs/${u.org.id}/members`, { headers: { cookie: u.cookie, authorization: `Bearer ${key}` } })).status).toBe(403);
  });
});

describe("2. limits are per visitor, not per proxy", () => {
  it("only believes X-Real-IP from the machine itself", () => {
    expect(pickClientIp("127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
    expect(pickClientIp("::1", "203.0.113.9")).toBe("203.0.113.9");
    expect(pickClientIp("::ffff:127.0.0.1", "2001:db8::7")).toBe("2001:db8::7");
    expect(pickClientIp("127.0.0.1", " 203.0.113.9 ")).toBe("203.0.113.9");
    expect(pickClientIp("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(pickClientIp("127.0.0.1", "not an address")).toBe("127.0.0.1");
    expect(pickClientIp("127.0.0.1", "203.0.113.9, 10.0.0.1")).toBe("127.0.0.1"); // a list isn't an address
    expect(pickClientIp("198.51.100.4", "203.0.113.9")).toBe("198.51.100.4"); // typed by the sender: ignored
    expect(pickClientIp("10.0.0.5", "203.0.113.9")).toBe("10.0.0.5");
    expect(pickClientIp(undefined, "203.0.113.9")).toBe("unknown");
  });

  it("one visitor guessing keys doesn't lock out another behind the same proxy", async () => {
    const u = await signUp({ mode: "create", name: "Acme" });
    const key = (await (await send(app, `/api/orgs/${u.org.id}/api-keys`, { method: "POST", ...json({ name: "k", scope: "read" }, { cookie: u.cookie }) })).json()).key as string;
    const items = (bearer: string, ip: string, peer = "127.0.0.1") => send(app, `/api/orgs/${u.org.id}/items`, { peer, headers: { authorization: `Bearer ${bearer}`, "x-real-ip": ip } });
    const wrong = `ivk_${"z".repeat(43)}`;
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await items(wrong, "203.0.113.9")).status);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    expect((await items(key, "203.0.113.9")).status).toBe(429); // the guesser waits, even with a right key
    expect((await items(key, "198.51.100.7")).status).toBe(200); // everyone else is untouched
  });

  it("a visitor can't dodge the limit by making up X-Real-IP, or lock out someone else by naming them", async () => {
    const u = await signUp({ mode: "create", name: "Acme" });
    const wrong = `ivk_${"y".repeat(43)}`;
    // From a real outside address the header means nothing, so changing it doesn't help.
    const dodge: number[] = [];
    for (let i = 0; i < 22; i++) dodge.push((await send(app, `/api/orgs/${u.org.id}/items`, { peer: "203.0.113.50", headers: { authorization: `Bearer ${wrong}`, "x-real-ip": `10.9.${i}.1` } })).status);
    expect(dodge.slice(20)).toEqual([429, 429]);
    // And naming someone else's address from outside doesn't count against them.
    const key = (await (await send(app, `/api/orgs/${u.org.id}/api-keys`, { method: "POST", ...json({ name: "k", scope: "read" }, { cookie: u.cookie }) })).json()).key as string;
    expect((await send(app, `/api/orgs/${u.org.id}/items`, { peer: "198.51.100.9", headers: { authorization: `Bearer ${key}`, "x-real-ip": "203.0.113.50" } })).status).toBe(200);
  });

  it("wrong join codes are counted per visitor", async () => {
    const attempt = (ip: string) => send(app, "/api/auth/register", { method: "POST", ...json({ name: "X", email: `jj${++n}@example.com`, password: "correct horse", organization: { mode: "join", joinCode: "ZZZZZZZZ" } }, { "x-real-ip": ip }) });
    const results: number[] = [];
    for (let i = 0; i < 12; i++) results.push((await attempt("203.0.113.20")).status);
    expect(results.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(results.slice(10)).toEqual([429, 429]);
    expect((await attempt("203.0.113.21")).status).toBe(400); // someone else, same proxy: still just a wrong code
  });

  it("sign-in is limited per address across emails, as well as per email", async () => {
    const real = await signUp({ mode: "create", name: "Real" });
    const login = (email: string, password: string, ip: string) => send(app, "/api/auth/login", { method: "POST", ...json({ email, password }, { "x-real-ip": ip }) });
    // Many different emails from one address (password guessing across accounts).
    const out: number[] = [];
    for (let i = 0; i < 32; i++) out.push((await login(`nobody${i}-${n}@example.com`, "wrong password", "203.0.113.30")).status);
    expect(out.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(out.slice(30)).toEqual([429, 429]);
    expect((await login(real.email, "correct horse", "203.0.113.30")).status).toBe(429); // that address waits
    expect((await login(real.email, "correct horse", "203.0.113.31")).status).toBe(200); // another visitor signs in fine
    // The per-email limit still holds from anywhere.
    const target = await signUp({ mode: "create", name: "Target" });
    for (let i = 0; i < 10; i++) expect((await login(target.email, "wrong", `198.51.100.${i + 1}`)).status).toBe(401);
    expect((await login(target.email, "correct horse", "198.51.100.200")).status).toBe(429);
  });
});

describe("3, 4, 5. webhooks", () => {
  interface Hit { headers: http.IncomingHttpHeaders; body: string }
  async function receiver(handler?: (hit: Hit, res: http.ServerResponse) => void) {
    const hits: Hit[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const hit = { headers: req.headers, body: Buffer.concat(chunks).toString() };
        hits.push(hit);
        if (handler) handler(hit, res);
        else res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
  }
  const org = async () => {
    const u = await signUp({ mode: "create", name: "Hooks" });
    const call = (path: string, body?: unknown, method?: string) =>
      send(app, `/api/orgs/${u.org.id}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), ...(body === undefined ? { headers: { cookie: u.cookie } } : json(body, { cookie: u.cookie })) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    return { u, call };
  };
  const verify = (secret: string, hit: Hit) => {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(hit.headers["x-invintel-signature"]));
    return !!m && createHmac("sha256", secret).update(`${m[1]}.${hit.body}`).digest("hex") === m[2];
  };

  it("3: a receiver that trickles an answer is cut off at a hard deadline", async () => {
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    process.env.INVINTEL_WEBHOOK_TIMEOUT_MS = "500";
    // Sends a byte every 100 ms for as long as it can: the connection is never idle.
    const trickle = await receiver((_hit, res) => {
      res.writeHead(200);
      const t = setInterval(() => res.write("x"), 100);
      res.on("close", () => clearInterval(t));
    });
    const { call } = await org();
    const hook = (await call("/webhooks", { url: trickle.url, events: ["item.created"] })).body;
    await call("/items", { sku: "T1", name: "T1" });
    const t0 = Date.now();
    await deliverDue(store);
    expect(Date.now() - t0).toBeLessThan(3000);
    const d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!;
    expect(d.status).toBe("retrying");
    expect(d.error).toMatch(/No answer within/);
    await trickle.close();
  }, 20_000);

  it("3: and so is one that accepts the request and never answers, or sends headers then goes quiet", async () => {
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    process.env.INVINTEL_WEBHOOK_TIMEOUT_MS = "400";
    const quiet = await receiver((_hit, res) => { res.writeHead(200, { "content-length": "100" }); res.write("part"); });
    const { call } = await org();
    const hook = (await call("/webhooks", { url: quiet.url, events: ["item.created"] })).body;
    await call("/items", { sku: "Q1", name: "Q1" });
    const t0 = Date.now();
    await deliverDue(store);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await store.webhookDeliveries.findOne({ webhookId: new ObjectId(hook.id) }))!.status).toBe("retrying");
    await quiet.close();
  }, 20_000);

  it("4: secrets are encrypted at rest when the server has a key, and still sign correctly", async () => {
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    process.env.WEBHOOK_SECRET_KEY = "a long random server secret";
    const rx = await receiver();
    const { call } = await org();
    const made = (await call("/webhooks", { url: rx.url, events: ["item.created"] })).body;
    expect(made.secret).toMatch(/^whsec_/);
    const row = (await store.webhooks.findOne({ _id: new ObjectId(made.id) }))!;
    expect(isSealed(row.secret)).toBe(true);
    expect(row.secret).not.toContain(made.secret);
    expect(row.secret).not.toContain("whsec_");
    expect(openWebhookSecret(row.secret)).toBe(made.secret);
    await call("/items", { sku: "E1", name: "E1" });
    await deliverDue(store);
    expect(rx.hits).toHaveLength(1);
    expect(verify(made.secret, rx.hits[0]!)).toBe(true);
    // Rotating stores the new one sealed too, and the old signature no longer matches.
    const rotated = (await call(`/webhooks/${made.id}/rotate-secret`, {})).body;
    expect(isSealed((await store.webhooks.findOne({ _id: new ObjectId(made.id) }))!.secret)).toBe(true);
    await call(`/webhooks/${made.id}/test`, {});
    expect(verify(rotated.secret, rx.hits[1]!)).toBe(true);
    expect(verify(made.secret, rx.hits[1]!)).toBe(false);
    // The secret is never in what the list returns.
    expect(JSON.stringify((await call("/webhooks")).body)).not.toContain("whsec_");
    await rx.close();
  });

  it("4: secrets from before encryption was switched on are encrypted when next used", async () => {
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    const rx = await receiver();
    const { call } = await org();
    const made = (await call("/webhooks", { url: rx.url, events: ["item.created"] })).body; // no key: stored as it is
    expect(isSealed((await store.webhooks.findOne({ _id: new ObjectId(made.id) }))!.secret)).toBe(false);
    await call("/items", { sku: "L1", name: "L1" });
    await deliverDue(store); // still no key: still plain, still works
    expect(verify(made.secret, rx.hits[0]!)).toBe(true);
    expect(isSealed((await store.webhooks.findOne({ _id: new ObjectId(made.id) }))!.secret)).toBe(false);

    process.env.WEBHOOK_SECRET_KEY = "now we have a key";
    await call("/items", { sku: "L2", name: "L2" });
    await deliverDue(store);
    expect(verify(made.secret, rx.hits[1]!)).toBe(true); // same secret, receiver notices nothing
    const after = (await store.webhooks.findOne({ _id: new ObjectId(made.id) }))!;
    expect(isSealed(after.secret)).toBe(true);
    expect(openWebhookSecret(after.secret)).toBe(made.secret);
    await rx.close();
  });

  it("4: a missing or wrong key fails the delivery plainly, sends nothing, and doesn't blame the receiver", async () => {
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    process.env.WEBHOOK_SECRET_KEY = "key one";
    const rx = await receiver();
    const { call } = await org();
    const made = (await call("/webhooks", { url: rx.url, events: ["item.created"] })).body;
    await call("/items", { sku: "K1", name: "K1" });
    delete process.env.WEBHOOK_SECRET_KEY;
    await deliverDue(store);
    let d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(made.id) }))!;
    expect(d).toMatchObject({ status: "failed" });
    expect(d.error).toMatch(/WEBHOOK_SECRET_KEY isn't set/);
    process.env.WEBHOOK_SECRET_KEY = "key two";
    await call("/items", { sku: "K2", name: "K2" });
    await deliverDue(store);
    d = (await store.webhookDeliveries.find({ webhookId: new ObjectId(made.id) }).sort({ createdAt: -1 }).toArray())[0]!;
    expect(d.error).toMatch(/different key/);
    expect(rx.hits).toHaveLength(0);
    expect((await store.webhooks.findOne({ _id: new ObjectId(made.id) }))).toMatchObject({ enabled: true, failures: 0 });
    // Put the right key back and a retry gets through.
    process.env.WEBHOOK_SECRET_KEY = "key one";
    const failed = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(made.id) }))!;
    const retried = await call(`/webhooks/${made.id}/deliveries/${failed._id.toHexString()}/retry`, {});
    expect(retried.body.status).toBe("delivered");
    await rx.close();
  });

  it("4: sealing round-trips and refuses tampering", () => {
    const sealed = sealWebhookSecret("whsec_abc", "k");
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(openWebhookSecret(sealed, "k")).toBe("whsec_abc");
    expect(sealWebhookSecret("whsec_abc", "k")).not.toBe(sealed); // fresh IV each time
    expect(() => openWebhookSecret(sealed, "other")).toThrow(/different key/);
    expect(() => openWebhookSecret(sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "k")).toThrow();
    expect(sealWebhookSecret("whsec_abc", undefined)).toBe("whsec_abc");
    expect(openWebhookSecret("whsec_abc", undefined)).toBe("whsec_abc");
    expect(() => openWebhookSecret(sealed, undefined)).toThrow(/isn't set/);
  });

  it("5: only port 443 and 8443 unless the development switch is on", async () => {
    for (const ok of ["https://hooks.example.com/a", "https://hooks.example.com:443/a", "https://hooks.example.com:8443/a", "https://8.8.8.8:8443/a"]) expect(validateWebhookUrl(ok).ok, ok).toBe(true);
    for (const bad of ["https://hooks.example.com:8080/a", "https://hooks.example.com:22/a", "https://hooks.example.com:6379/a", "https://hooks.example.com:80/a", "https://hooks.example.com:65535/a", "https://8.8.8.8:25/a"]) {
      const r = validateWebhookUrl(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/port 443 or 8443/);
    }
    const { call } = await org();
    expect((await call("/webhooks", { url: "https://hooks.example.com:8080/a", events: ["*"] })).status).toBe(400);
    expect((await call("/webhooks", { url: "https://hooks.example.com:8443/a", events: ["*"] })).status).toBe(201);
    // A saved webhook on another port is also refused at delivery time.
    const sneaky = (await call("/webhooks", { url: "https://hooks.example.com/a", events: ["item.created"] })).body;
    await store.webhooks.updateOne({ _id: new ObjectId(sneaky.id) }, { $set: { url: "https://8.8.8.8:25/a" } });
    await call("/items", { sku: "P1", name: "P1" });
    await deliverDue(store);
    const d = (await store.webhookDeliveries.findOne({ webhookId: new ObjectId(sneaky.id) }))!;
    expect(d.status).toBe("failed");
    expect(d.error).toMatch(/port 443 or 8443/);
    // The switch lifts it, for local development.
    process.env.INVINTEL_WEBHOOKS_ALLOW_PRIVATE = "true";
    expect(validateWebhookUrl("http://127.0.0.1:9911/a").ok).toBe(true);
  });
});

describe("6. keys expire in a year unless told otherwise", () => {
  it("defaults to 365 days, honours a choice, and 'never' has to be asked for", async () => {
    const u = await signUp({ mode: "create", name: "Keys" });
    const make = async (body: object) => (await send(app, `/api/orgs/${u.org.id}/api-keys`, { method: "POST", ...json(body, { cookie: u.cookie }) })).json();
    const def = await make({ name: "default", scope: "read" });
    const days = (new Date(def.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
    expect((await make({ name: "short", scope: "write", expiresInDays: 30 })).expiresAt).toBeTruthy();
    expect((await make({ name: "forever", scope: "read", expiresInDays: null })).expiresAt).toBeNull();
    expect((await send(app, `/api/orgs/${u.org.id}/api-keys`, { method: "POST", ...json({ name: "x", scope: "read", expiresInDays: 0 }, { cookie: u.cookie }) })).status).toBe(400);
    expect((await send(app, `/api/orgs/${u.org.id}/api-keys`, { method: "POST", ...json({ name: "x", scope: "read", expiresInDays: 9999 }, { cookie: u.cookie }) })).status).toBe(400);
  });
});
