import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { registerBridge, sendMessage, receiveMessage, recordAck, retryMessage, type Bridge } from "./b2b-core.js";
import { connect, type Store } from "./db.js";

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

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `b${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization, user: b.user };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
};

// A bridge we control: it can be told to fail, and verifies inbound requests by a shared header.
let failNext: { error: string; retryable: boolean } | null = null;
let sendCount = 0;
const testBridge: Bridge = {
  id: "testbridge",
  carries: ["order", "order_response", "invoice"],
  async send(m, partner) {
    sendCount++;
    if (failNext) { const f = failNext; failNext = null; return { ok: false, ...f }; }
    if (partner.bridgeConfig.endpoint === "boom") throw new Error("connection reset");
    return { ok: true, state: "sent", providerMessageId: `prov-${m.id}` };
  },
  async verifyInbound(req, partner) {
    if (req.headers["x-secret"] !== partner.bridgeConfig.secret) return { ok: false, error: "Bad signature" };
    const j = JSON.parse(req.body) as { docType: "order_response"; key: string; poNumber?: string };
    return { ok: true, docType: j.docType, body: req.body, idempotencyKey: j.key, correlation: { poNumber: j.poNumber } };
  },
};
registerBridge(testBridge);

async function world() {
  const owner = await signUp({ mode: "create", name: "Buyer Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call((who === "owner" ? owner : member).cookie, `${base}/b2b${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}/b2b${p}`);
  const partner = (await post("/partners", { name: "Acme Paper", kind: "supplier", bridge: "testbridge", bridgeConfig: { secret: "s3cret" }, identifiers: [{ scheme: "GLN", value: "0614141000012" }] })).body;
  const actor = { userId: new ObjectId(owner.user.id), userName: "Ada" };
  return { owner, member, base, post, get, partner, actor, orgId: new ObjectId(owner.org.id) };
}

describe("trading partners", () => {
  it("are admin-managed, validated against the bridges that exist, unique by name, and audited without settings values", async () => {
    const w = await world();
    expect(w.partner).toMatchObject({ name: "Acme Paper", mode: "test", enabled: true, bridge: "testbridge" });
    expect((await w.post("/partners", { name: "Nope", kind: "supplier", bridge: "testbridge" }, "member")).status).toBe(403);
    expect((await w.post("/partners", { name: "acme paper", kind: "supplier", bridge: "testbridge" })).status).toBe(409);
    expect((await w.post("/partners", { name: "X", kind: "supplier", bridge: "carrier-pigeon" })).status).toBe(422);
    expect((await w.post("/partners", { name: "X", kind: "friend", bridge: "loopback" })).status).toBe(400);
    expect((await w.post("/partners", { name: "X", kind: "supplier", bridge: "loopback", supplierId: "0".repeat(24) })).status).toBe(404);
    const patch = await w.post(`/partners/${w.partner.id}`, { mode: "live", bridgeConfig: { secret: "rotated-secret-value" } }, "owner", "PATCH");
    expect(patch.status).toBe(200);
    expect(patch.body.mode).toBe("live");
    expect((await w.post(`/partners/${w.partner.id}`, { bridge: "nope" }, "owner", "PATCH")).status).toBe(422);
    expect((await w.get("/partners", "member")).body).toHaveLength(1);
    const audits = await store.audit.find({ orgId: w.orgId, action: { $in: ["b2b.partner_created", "b2b.partner_updated"] } }).toArray();
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("rotated-secret-value"); // settings values never reach the audit log
    expect(JSON.stringify(audits)).not.toContain("s3cret");
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/b2b/partners`)).body).toEqual([]);
    expect((await call(other.cookie, `${w.base}/b2b/partners`)).status).toBe(404);
  });
  it("lists the bridges that are available", async () => {
    const w = await world();
    const bridges = (await w.get("/bridges", "member")).body as { id: string }[];
    expect(bridges.map((b) => b.id)).toEqual(expect.arrayContaining(["loopback", "testbridge"]));
  });
});

describe("sending", () => {
  it("writes the message, hands it to the bridge, records the result, keeps the raw document and audits it", async () => {
    const w = await world();
    const res = await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: '{"po":"PO-0001"}', correlation: { poNumber: "PO-0001" }, idempotencyKey: "po-1-v1" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ direction: "out", state: "sent", docType: "order", partnerName: "Acme Paper", idempotencyKey: "po-1-v1", correlation: { poNumber: "PO-0001" }, createdBy: "Ada" });
    expect(res.body.providerMessageId).toMatch(/^prov-/);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0].ok).toBe(true);
    const detail = (await w.get(`/messages/${res.body.id}`)).body;
    expect(detail.body).toBe('{"po":"PO-0001"}');
    expect(detail.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.rawBytes).toBe(16);
    expect((await store.audit.find({ action: "b2b.message_sent", orgId: w.orgId }).toArray())).toHaveLength(1);
    expect((await w.get("/messages?direction=out&state=sent", "member")).body).toHaveLength(1);
    expect((await w.get("/messages?state=failed")).body).toHaveLength(0);
    expect((await w.get("/messages?state=bogus")).status).toBe(400);
  });

  it("the same idempotency key never makes a second message or a second send, even at the same time", async () => {
    const w = await world();
    sendCount = 0;
    const body = { docType: "order", body: "{}", idempotencyKey: "same-key" };
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => w.post(`/partners/${w.partner.id}/messages`, body)));
    const ids = new Set([a!.body.id, b!.body.id, c!.body.id]);
    expect(ids.size).toBe(1);
    expect((await store.b2bMessages.countDocuments({ orgId: w.orgId, idempotencyKey: "same-key" }))).toBe(1);
    expect(sendCount).toBeLessThanOrEqual(1 + 0); // the bridge saw it once
    const again = await w.post(`/partners/${w.partner.id}/messages`, body);
    expect(again.status).toBe(200); // existing message returned, not created
    expect(sendCount).toBe(1);
  });

  it("refuses what can't be sent: unknown or switched-off partner, a document the bridge doesn't carry, admin only", async () => {
    const w = await world();
    expect((await w.post(`/partners/${"0".repeat(24)}/messages`, { docType: "order", body: "{}" })).status).toBe(404);
    expect((await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: "{}" }, "member")).status).toBe(403);
    expect((await w.post(`/partners/${w.partner.id}/messages`, { docType: "banana", body: "{}" })).status).toBe(400);
    const carry = await w.post(`/partners/${w.partner.id}/messages`, { docType: "despatch_advice", body: "{}" });
    expect(carry.status).toBe(201);
    expect(carry.body.state).toBe("failed"); // the bridge doesn't carry ship notices: recorded as failed, not retryable
    expect(carry.body.attempts[0]).toMatchObject({ ok: false, retryable: false });
    expect((await w.post(`/messages/${carry.body.id}/retry`, {})).status).toBe(409);
    await w.post(`/partners/${w.partner.id}`, { enabled: false }, "owner", "PATCH");
    expect((await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: "{}" })).status).toBe(409);
  });

  it("a failed send can be retried as the same message if the failure was temporary, and the attempts are kept", async () => {
    const w = await world();
    failNext = { error: "timeout talking to the provider", retryable: true };
    const sent = await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: '{"po":"PO-2"}', idempotencyKey: "po-2" });
    expect(sent.body.state).toBe("failed");
    expect(sent.body.attempts).toEqual([expect.objectContaining({ ok: false, error: "timeout talking to the provider", retryable: true })]);
    expect((await store.audit.find({ action: "b2b.message_failed", orgId: w.orgId }).toArray())).toHaveLength(1);
    expect((await w.post(`/messages/${sent.body.id}/retry`, {}, "member")).status).toBe(403);
    const retried = await w.post(`/messages/${sent.body.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ id: sent.body.id, state: "sent", idempotencyKey: "po-2" });
    expect(retried.body.attempts.map((a: { ok: boolean }) => a.ok)).toEqual([false, true]);
    expect((await w.post(`/messages/${sent.body.id}/retry`, {})).status).toBe(409); // already sent
  });

  it("a bridge that throws is a retryable failure, not a crash; a permanent failure is not retried", async () => {
    const w = await world();
    const boom = (await w.post("/partners", { name: "Boom Ltd", kind: "supplier", bridge: "testbridge", bridgeConfig: { endpoint: "boom", secret: "x" } })).body;
    const m = await w.post(`/partners/${boom.id}/messages`, { docType: "invoice", body: "{}" });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ state: "failed" });
    expect(m.body.attempts[0]).toMatchObject({ error: "connection reset", retryable: true });
    failNext = { error: "Partner rejected our credentials", retryable: false };
    const p = await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: "{}" });
    expect(p.body.state).toBe("failed");
    const retry = await w.post(`/messages/${p.body.id}/retry`, {});
    expect(retry.status).toBe(409);
    expect(retry.body.error).toMatch(/won't help/);
  });
});

describe("acknowledgements and the state machine", () => {
  it("a business acknowledgement moves a sent message to acknowledged or rejected, and only forward", async () => {
    const w = await world();
    const sent = (await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: "{}" })).body;
    expect((await w.post(`/messages/${sent.id}/ack`, { level: "transport", result: "accepted" }, "member")).status).toBe(403);
    const transport = await w.post(`/messages/${sent.id}/ack`, { level: "transport", result: "accepted", detail: "MDN received" });
    expect(transport.body.state).toBe("delivered");
    expect(transport.body.acks).toHaveLength(1);
    const business = await w.post(`/messages/${sent.id}/ack`, { level: "business", result: "accepted", detail: "Confirmed by phone" });
    expect(business.body.state).toBe("acknowledged");
    expect(business.body.acks.map((a: { level: string }) => a.level)).toEqual(["transport", "business"]);
    // terminal: nothing moves it again
    expect((await w.post(`/messages/${sent.id}/ack`, { level: "business", result: "rejected" })).status).toBe(409);
    expect((await w.post(`/messages/${sent.id}/ack`, { level: "transport", result: "accepted" })).status).toBe(409);
    // a rejection at any level rejects
    const second = (await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: "{}" })).body;
    expect((await w.post(`/messages/${second.id}/ack`, { level: "functional", result: "rejected", detail: "Segment missing" })).body.state).toBe("rejected");
    expect((await store.audit.find({ action: "b2b.message_acknowledged", orgId: w.orgId }).toArray()).length).toBe(3);
  });

  it("a queued or failed message can't be acknowledged; unknown messages are 404", async () => {
    const w = await world();
    failNext = { error: "down", retryable: true };
    const failed = (await w.post(`/partners/${w.partner.id}/messages`, { docType: "order", body: "{}" })).body;
    expect((await w.post(`/messages/${failed.id}/ack`, { level: "business", result: "accepted" })).status).toBe(409);
    expect((await w.post(`/messages/${"0".repeat(24)}/ack`, { level: "business", result: "accepted" })).status).toBe(404);
    expect((await w.get(`/messages/${"0".repeat(24)}`)).status).toBe(404);
  });
});

describe("receiving", () => {
  const inbound = (partnerId: string, body: unknown, secret = "s3cret") =>
    app.request(`/api/b2b/inbound/${partnerId}`, { method: "POST", headers: { "x-secret": secret, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("stores a verified document once, answers duplicates without storing them again, and audits it", async () => {
    const w = await world();
    const doc = { docType: "order_response", key: "ack-77", poNumber: "PO-0001" };
    const first = await inbound(w.partner.id, doc);
    expect(first.status).toBe(201);
    const second = await inbound(w.partner.id, doc);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    const list = (await w.get("/messages?direction=in")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ direction: "in", state: "received", docType: "order_response", correlation: { poNumber: "PO-0001" }, partnerName: "Acme Paper" });
    expect((await store.audit.find({ action: "b2b.message_received", orgId: w.orgId }).toArray())).toHaveLength(1);
    // our decision on what we received
    const ok = await w.post(`/messages/${list[0].id}/ack`, { level: "business", result: "accepted" });
    expect(ok.body.state).toBe("acknowledged");
  });

  it("refuses what the bridge can't verify, without storing anything or saying why to a stranger", async () => {
    const w = await world();
    const bad = await inbound(w.partner.id, { docType: "order_response", key: "k1" }, "wrong-secret");
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "Not accepted" });
    expect((await inbound("0".repeat(24), { docType: "order_response", key: "k" })).status).toBe(404);
    expect((await inbound("not-an-id", { docType: "order_response", key: "k" })).status).toBe(404);
    // a document type the bridge doesn't carry
    const wrong = await inbound(w.partner.id, { docType: "despatch_advice", key: "k2" });
    expect(wrong.status).toBe(422);
    await w.post(`/partners/${w.partner.id}`, { enabled: false }, "owner", "PATCH");
    expect((await inbound(w.partner.id, { docType: "order_response", key: "k3" })).status).toBe(404); // switched off looks like unknown
    expect(await store.b2bMessages.countDocuments({ orgId: w.orgId, direction: "in" })).toBe(0);
  });

  it("limits the size of what a partner can post", async () => {
    const w = await world();
    const big = await app.request(`/api/b2b/inbound/${w.partner.id}`, { method: "POST", headers: { "x-secret": "s3cret", "content-type": "application/json" }, body: JSON.stringify({ docType: "order_response", key: "big", pad: "x".repeat(2_200_000) }) });
    expect(big.status).toBe(413);
  });
});

describe("the service interface directly (what other bridges and flows call)", () => {
  it("sendMessage, receiveMessage, retryMessage and recordAck work without HTTP and the loopback bridge answers like a partner", async () => {
    const w = await world();
    const lb = (await w.post("/partners", { name: "Loopback Co", kind: "customer", bridge: "loopback" })).body;
    const sent = await sendMessage(store, w.orgId, w.actor, new ObjectId(lb.id), { docType: "invoice", body: "<Invoice/>", contentType: "application/xml", idempotencyKey: "inv-1" });
    expect(sent.ok && sent.message.state).toBe("delivered");
    expect(sent.ok && sent.created).toBe(true);
    const got = await receiveMessage(store, w.orgId, new ObjectId(lb.id), { headers: {}, body: JSON.stringify({ docType: "order", key: "in-1" }) });
    expect(got.ok && got.message.state).toBe("received");
    expect((await receiveMessage(store, w.orgId, new ObjectId(lb.id), { headers: {}, body: "not json" })).ok).toBe(false);
    const ack = await recordAck(store, w.orgId, sent.ok ? sent.message._id : new ObjectId(), { level: "business", result: "accepted" });
    expect(ack.ok && ack.message.state).toBe("acknowledged");
    expect((await retryMessage(store, w.orgId, w.actor, sent.ok ? sent.message._id : new ObjectId())).ok).toBe(false);
    // another organization's partner id is just "not found"
    const other = await signUp({ mode: "create", name: "Other" });
    const foreign = await sendMessage(store, new ObjectId(other.org.id), w.actor, new ObjectId(lb.id), { docType: "order", body: "{}" });
    expect(foreign).toMatchObject({ ok: false, status: 404 });
  });
});
