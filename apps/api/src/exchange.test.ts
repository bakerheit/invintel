import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { generateKeyPair, signPayload, verifyPayload } from "./exchange-crypto.js";

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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `ex${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const inbox = async (raw: string) => { const r = await app.request("/api/exchange/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: raw }); return r.status; };

/** Two organizations on one server: a buyer with a placed purchase order, and a supplier who stocks the item. */
async function setup() {
  const buyer = await signUp({ mode: "create", name: "Northwind Boxes" }, "Bea");
  const seller = await signUp({ mode: "create", name: "Sunrise Paper" }, "Sol");
  const sellerMember = await signUp({ mode: "join", joinCode: seller.org.joinCode }, "Sam");
  const b = `/api/orgs/${buyer.org.id}`;
  const s = `/api/orgs/${seller.org.id}`;
  const connect = await call(buyer.cookie, `${b}/exchange/connect`, { invitation: (await call(seller.cookie, `${s}/exchange/invitation`)).body, kind: "supplier" });
  // Buyer: a supplier record, an item and a placed PO.
  const mainB = (await call(buyer.cookie, `${b}/locations`)).body[0].id as string;
  const itemB = (await call(buyer.cookie, `${b}/items`, { sku: "LINER-42", name: "Kraft liner 42", unitCostCents: 48000, initialStock: { locationId: mainB, quantity: 2 } })).body.id as string;
  const supB = (await call(buyer.cookie, `${b}/purchasing/suppliers`, { name: "Sunrise Paper" })).body.id as string;
  const po = (await call(buyer.cookie, `${b}/purchasing/orders`, { supplierId: supB, expectedDate: "2026-12-01", lines: [{ itemId: itemB, quantity: 10, unitCostCents: 47000 }] })).body;
  await call(buyer.cookie, `${b}/purchasing/orders/${po.id}/place`, {});
  // Seller: stock of the same SKU.
  const mainS = (await call(seller.cookie, `${s}/locations`)).body[0].id as string;
  await call(seller.cookie, `${s}/items`, { sku: "LINER-42", name: "Kraft liner 42 lb", unitCostCents: 30000, reorderLevel: 5, initialStock: { locationId: mainS, quantity: 40 } });
  const partnerAtBuyer = connect.body.partner.id as string;
  const partnerAtSeller = (await call(seller.cookie, `${s}/exchange/partners`)).body[0].id as string;
  return { buyer, seller, sellerMember, b, s, connect, po, partnerAtBuyer, partnerAtSeller, mainS };
}

describe("Invintel-to-Invintel exchange", () => {
  it("gives each organization a signing identity and connects two organizations on one server both ways", async () => {
    const { buyer, seller, b, s, connect } = await setup();
    const ia = (await call(buyer.cookie, `${b}/exchange/identity`)).body;
    const ib = (await call(seller.cookie, `${s}/exchange/identity`)).body;
    expect(ia.exchangeId).toMatch(/^ix_[0-9a-f]{16}$/);
    expect(ia.exchangeId).not.toBe(ib.exchangeId);
    expect((await call(buyer.cookie, `${b}/exchange/identity`)).body.exchangeId).toBe(ia.exchangeId); // stable
    expect(JSON.stringify(ia)).not.toContain("privateKey");
    expect(connect.status).toBe(201);
    expect(connect.body).toMatchObject({ connectedBack: true, partner: { name: "Sunrise Paper", kind: "supplier", exchangeId: ib.exchangeId, fingerprint: ib.fingerprint } });
    const back = (await call(seller.cookie, `${s}/exchange/partners`)).body;
    expect(back).toEqual([expect.objectContaining({ name: "Northwind Boxes", kind: "customer", exchangeId: ia.exchangeId, permissions: { shareStock: false, shareStockQuantities: false, shareOrderStatus: false } })]);
    // Connecting again changes nothing; your own invitation and a tampered one are refused.
    await call(buyer.cookie, `${b}/exchange/connect`, { invitation: (await call(seller.cookie, `${s}/exchange/invitation`)).body, kind: "supplier" });
    expect((await call(buyer.cookie, `${b}/exchange/partners`)).body).toHaveLength(1);
    expect((await call(buyer.cookie, `${b}/exchange/connect`, { invitation: (await call(buyer.cookie, `${b}/exchange/invitation`)).body, kind: "supplier" })).status).toBe(400);
    const other = generateKeyPair();
    const tampered = { ...(await call(seller.cookie, `${s}/exchange/invitation`)).body, publicKey: other.publicKey };
    expect((await call(buyer.cookie, `${b}/exchange/connect`, { invitation: tampered, kind: "supplier" })).status).toBe(400);
  });

  it("sends a purchase order, gets the supplier's answer and ship notice back, and keeps the whole story on the order", async () => {
    const { buyer, seller, sellerMember, b, s, po, partnerAtBuyer } = await setup();
    // A draft can't be sent; a placed order can, once.
    const sent = await call(buyer.cookie, `${b}/exchange/purchase-orders/${po.id}/send`, { partnerId: partnerAtBuyer });
    expect(sent.status).toBe(201);
    expect(sent.body.state).toBe("delivered");
    expect((await call(buyer.cookie, `${b}/exchange/purchase-orders/${po.id}/send`, { partnerId: partnerAtBuyer })).body).toMatchObject({ alreadySent: true });
    expect((await call(buyer.cookie, `${b}/b2b/messages?docType=order`)).body.length ?? 1).toBeGreaterThan(0);

    // The supplier sees it, with the buyer's numbers.
    const orders = (await call(seller.cookie, `${s}/exchange/orders`)).body;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ partner: "Northwind Boxes", order: { poNumber: po.number, requestedDate: "2026-12-01", lines: [{ sku: "LINER-42", quantity: 10, unitPriceCents: 47000 }] }, response: null, shipped: false });
    const mid = orders[0].messageId as string;

    // Only an admin answers; anyone can ship.
    expect((await call(sellerMember.cookie, `${s}/exchange/orders/${mid}/respond`, { status: "accepted" })).status).toBe(403);
    const answered = await call(seller.cookie, `${s}/exchange/orders/${mid}/respond`, { status: "accepted", promisedDate: "2026-11-20", note: "Ships Friday" });
    expect(answered.status).toBe(201);
    const ship = await call(sellerMember.cookie, `${s}/exchange/orders/${mid}/ship`, { carrier: "UPS Freight", tracking: "1Z999" });
    expect(ship.status).toBe(201);
    expect((await call(seller.cookie, `${s}/exchange/orders`)).body[0]).toMatchObject({ response: { status: "accepted", promisedDate: "2026-11-20" }, shipped: true });

    // The buyer's order message is acknowledged by the business answer, and the order's timeline shows all three documents.
    const tl = (await call(buyer.cookie, `${b}/exchange/purchase-orders/${po.id}/timeline`)).body;
    expect(tl.map((t: { docType: string; direction: string }) => `${t.direction}:${t.docType}`)).toEqual(["out:order", "in:order_response", "in:despatch_advice"]);
    expect(tl[0]).toMatchObject({ state: "acknowledged" });
    expect(tl[0].acks.at(-1)).toMatchObject({ level: "business", result: "accepted" });
    expect(tl[1].summary).toMatchObject({ status: "accepted", promisedDate: "2026-11-20" });
    expect(tl[2].summary).toMatchObject({ tracking: "1Z999", carrier: "UPS Freight" });
  });

  it("answers questions only as far as the partner has been allowed, and never reveals cost", async () => {
    const { buyer, seller, b, s, po, partnerAtBuyer, partnerAtSeller } = await setup();
    const ask = async (q: unknown) => {
      const r = await call(buyer.cookie, `${b}/exchange/ask`, { partnerId: partnerAtBuyer, question: q });
      expect(r.status).toBe(201);
      const list = (await call(buyer.cookie, `${b}/exchange/answers`)).body as { messageId: string; answer: { ok: boolean; reason?: string; stock?: Record<string, unknown>; order?: Record<string, unknown> } | null }[];
      return list.find((x) => x.messageId === r.body.messageId)!.answer;
    };
    // Default: nothing shared.
    expect(await ask({ kind: "stock", sku: "LINER-42" })).toMatchObject({ ok: false, reason: expect.stringContaining("don't share stock") });
    // Availability only.
    const perms = (shareStockQuantities: boolean, shareOrderStatus = false) => call(seller.cookie, `${s}/exchange/partners/${partnerAtSeller}/permissions`, { shareStock: true, shareStockQuantities, shareOrderStatus }, "PATCH");
    await perms(false);
    const a1 = await ask({ kind: "stock", sku: "liner-42" });
    expect(a1).toMatchObject({ ok: true, stock: { sku: "LINER-42", availability: "in_stock" } });
    expect(a1!.stock).not.toHaveProperty("quantity");
    expect(JSON.stringify(a1)).not.toContain("30000"); // the supplier's cost is never in an answer
    await perms(true);
    expect((await ask({ kind: "stock", sku: "LINER-42" }))!.stock).toMatchObject({ quantity: 40, unit: "ea" });
    expect(await ask({ kind: "stock", sku: "NOPE" })).toMatchObject({ ok: false, reason: "We don't carry that item." });
    // Order status needs its own switch and an order they actually have from us.
    expect(await ask({ kind: "order_status", poNumber: po.number })).toMatchObject({ ok: false, reason: expect.stringContaining("don't share order status") });
    await perms(true, true);
    expect(await ask({ kind: "order_status", poNumber: po.number })).toMatchObject({ ok: false, reason: expect.stringContaining("no order with that number") });
    await call(buyer.cookie, `${b}/exchange/purchase-orders/${po.id}/send`, { partnerId: partnerAtBuyer });
    expect((await ask({ kind: "order_status", poNumber: po.number }))!.order).toMatchObject({ status: "received", shipped: false });
    const mid = (await call(seller.cookie, `${s}/exchange/orders`)).body[0].messageId as string;
    await call(seller.cookie, `${s}/exchange/orders/${mid}/respond`, { status: "accepted", promisedDate: "2026-11-20" });
    expect((await ask({ kind: "order_status", poNumber: po.number }))!.order).toMatchObject({ status: "accepted", promisedDate: "2026-11-20" });
    await call(seller.cookie, `${s}/exchange/orders/${mid}/ship`, {});
    expect((await ask({ kind: "order_status", poNumber: po.number }))!.order).toMatchObject({ status: "shipped", shipped: true });
  });

  it("refuses forged, tampered, replayed, stale, misaddressed and out-of-role messages", async () => {
    const { buyer, seller, b, s, po, partnerAtBuyer } = await setup();
    await call(buyer.cookie, `${b}/exchange/purchase-orders/${po.id}/send`, { partnerId: partnerAtBuyer });
    const idA = await store.exchangeIdentities.findOne({ orgId: new ObjectId(buyer.org.id) });
    const idB = await store.exchangeIdentities.findOne({ orgId: new ObjectId(seller.org.id) });
    const stored = (await store.b2bMessages.findOne({ orgId: new ObjectId(seller.org.id), direction: "in", docType: "order" }))!;
    const countIn = () => store.b2bMessages.countDocuments({ orgId: new ObjectId(seller.org.id), direction: "in" });
    expect(await countIn()).toBe(1);

    // Replaying the exact message is recognised: accepted as received, stored once.
    expect(await inbox(stored.raw.body)).toBe(200);
    expect(await countIn()).toBe(1);

    const body = { poNumber: "PO-9", currency: "USD", requestedDate: null, note: "", lines: [{ sku: "LINER-42", quantity: 1, unit: "", description: "", unitPriceCents: 0 }] };
    const make = (over: Record<string, unknown>, key = idA!.privateKey) => {
      const unsigned = { protocol: "invintel-exchange/1", id: `m-${randomBytes(6).toString("hex")}`, type: "order", from: idA!.exchangeId, to: idB!.exchangeId, createdAt: new Date().toISOString(), body, ...over };
      return JSON.stringify({ ...unsigned, signature: signPayload(unsigned, key) });
    };
    expect(await inbox(make({}))).toBe(200); // a properly signed new order is fine
    expect(await countIn()).toBe(2);
    expect(await inbox(make({}, generateKeyPair().privateKey))).toBe(422); // signed with someone else's key
    const good = JSON.parse(make({ id: "tamper-1" })) as Record<string, unknown>;
    expect(await inbox(JSON.stringify({ ...good, body: { ...body, lines: [{ ...body.lines[0], quantity: 999 }] } }))).toBe(422); // changed after signing
    expect(await inbox(make({ createdAt: new Date(Date.now() - 3_600_000).toISOString() }))).toBe(422); // an hour old
    expect(await inbox(make({ to: "ix_0000000000000000" }))).toBe(422); // not addressed to anyone here
    expect(await inbox(make({ from: "ix_ffffffffffffffff" }))).toBe(422); // unknown sender
    expect(await inbox(make({ type: "order_response", body: { poNumber: "PO-9", status: "accepted" } }))).toBe(422); // the buyer is a customer: it can't answer an order
    expect(await inbox("not json")).toBe(422);
    expect(await countIn()).toBe(2);
    // A partner that has been switched off is refused too.
    await call(seller.cookie, `${s}/b2b/partners/${(await call(seller.cookie, `${s}/exchange/partners`)).body[0].id}`, { enabled: false }, "PATCH");
    expect(await inbox(make({}))).toBe(422);
  });

  it("keeps organizations apart and limits who can connect, send and answer", async () => {
    const { buyer, seller, sellerMember, b, s, po, partnerAtBuyer } = await setup();
    const stranger = await signUp({ mode: "create", name: "Elsewhere" });
    expect((await call(stranger.cookie, `${b}/exchange/identity`)).status).toBe(404);
    const inv = (await call(seller.cookie, `${s}/exchange/invitation`)).body;
    expect((await call(sellerMember.cookie, `${s}/exchange/connect`, { invitation: inv, kind: "customer" })).status).toBe(403);
    const buyerMember = await signUp({ mode: "join", joinCode: buyer.org.joinCode }, "Ben");
    expect((await call(buyerMember.cookie, `${b}/exchange/purchase-orders/${po.id}/send`, { partnerId: partnerAtBuyer })).status).toBe(403);
    // A partner that is a customer can't be sent a purchase order.
    const partnerForBuyerOnSellerSide = (await call(seller.cookie, `${s}/exchange/partners`)).body[0].id as string;
    const draft = (await call(seller.cookie, `${s}/purchasing/suppliers`, { name: "X" })).body.id as string;
    void draft;
    const sellerPo = (await call(seller.cookie, `${s}/purchasing/orders`, { supplierId: draft, lines: [{ itemId: (await call(seller.cookie, `${s}/items`)).body[0].id, quantity: 1, unitCostCents: 1 }] })).body.id as string;
    await call(seller.cookie, `${s}/purchasing/orders/${sellerPo}/place`, {});
    expect((await call(seller.cookie, `${s}/exchange/purchase-orders/${sellerPo}/send`, { partnerId: partnerForBuyerOnSellerSide })).status).toBe(409);
  });

  it("delivers to a partner on another server over HTTPS, signed, and treats failures sensibly", async () => {
    const buyer = await signUp({ mode: "create", name: "Far Buyer" });
    const b = `/api/orgs/${buyer.org.id}`;
    const mine = (await call(buyer.cookie, `${b}/exchange/identity`)).body;
    // A partner whose identity is on some other server (nobody here holds its key).
    const remoteKeys = generateKeyPair();
    const remote = { exchangeId: "ix_aaaaaaaaaaaaaaaa", publicKey: remoteKeys.publicKey, baseUrl: "https://far.example.test" };
    const partner = (await call(buyer.cookie, `${b}/b2b/partners`, { name: "Far Supplier", kind: "supplier", bridge: "invintel", bridgeConfig: { exchangeId: remote.exchangeId, publicKey: remote.publicKey, baseUrl: remote.baseUrl, shareStock: "0", shareStockQuantities: "0", shareOrderStatus: "0" } })).body.id as string;
    const realFetch = globalThis.fetch;
    const seen: { url: string; body: string }[] = [];
    let status = 200;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => { seen.push({ url: String(url), body: String(init?.body) }); return new Response("{}", { status }); }) as typeof fetch;
    try {
      const send = (key: string) => call(buyer.cookie, `${b}/b2b/partners/${partner}/messages`, { docType: "query", body: JSON.stringify({ kind: "stock", sku: "X" }), idempotencyKey: key });
      const ok = await send("k1");
      expect(ok.body.state).toBe("delivered");
      expect(seen[0]!.url).toBe("https://far.example.test/api/exchange/inbox");
      const env = JSON.parse(seen[0]!.body) as { signature: string; id: string; from: string; to: string; body: unknown };
      const { signature, ...unsigned } = env;
      expect(env).toMatchObject({ id: "k1", from: mine.exchangeId, to: remote.exchangeId });
      expect(verifyPayload(unsigned, signature, mine.publicKey)).toBe(true); // the buyer's real key signed it
      status = 503;
      const down = await send("k2");
      expect(down.body.state).toBe("failed");
      expect(down.body.attempts.at(-1)).toMatchObject({ ok: false, retryable: true });
      status = 422;
      const refused = await send("k3");
      expect(refused.body.attempts.at(-1)).toMatchObject({ ok: false, retryable: false });
      // Retrying a retryable failure re-sends the same envelope id once the partner is back.
      status = 200;
      const retry = await call(buyer.cookie, `${b}/b2b/messages/${down.body.id}/retry`, {});
      expect(retry.body.state).toBe("delivered");
      expect(JSON.parse(seen.at(-1)!.body).id).toBe("k2");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
