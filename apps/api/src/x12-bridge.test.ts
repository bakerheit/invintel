import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import type { X12Profile } from "./x12.js";
import { acceptInbound, nextControl } from "./x12-bridge.js";
import { acknowledge, ackTo997, orderTo850, readX12 } from "./x12-maps.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  process.env.X12_TEST_SECRET = "x12-secret-123";
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `x${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* not json */ }
  return { status: res.status, body: json, text: t };
};

const CONFIG = { ourQual: "ZZ", ourId: "NWCORR", theirQual: "ZZ", theirId: "SUNRISEPM", version: "004010", transport: "loopback", secretEnv: "X12_TEST_SECRET" };

async function world(opts: { config?: Record<string, string>; unit?: string; qty?: number } = {}) {
  const owner = await signUp({ mode: "create", name: "Northwind Corrugated Co." });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call((who === "owner" ? owner : member).cookie, `${base}${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const item = (await post("/items", { sku: "LINER-T33", name: "Test liner 33 lb", unitCostCents: 42000, ...(opts.unit ? { unit: opts.unit } : {}) })).body.id as string;
  const supplier = (await post("/purchasing/suppliers", { name: "Sunrise Paper Mill", contact: "Sam" })).body.id as string;
  const partnerRes = await post("/b2b/partners", { name: "Sunrise Paper Mill", kind: "supplier", supplierId: supplier, bridge: "x12", mode: "test", bridgeConfig: opts.config ?? CONFIG });
  const partner = partnerRes.body;
  const po = (await post("/purchasing/orders", { supplierId: supplier, expectedDate: "2026-11-05", note: "East dock", lines: [{ itemId: item, quantity: opts.qty ?? 6, unitCostCents: 42000 }] })).body;
  await post(`/purchasing/orders/${po.id}/place`, {});
  const orgId = new ObjectId(owner.org.id);
  const send = () => post(`/b2b/orders/${po.id}/send`, {});
  const messages = async (q = "") => (await get(`/b2b/messages${q}`)).body as any[];
  const detail = async (id: string) => (await get(`/b2b/messages/${id}`)).body;
  const exchange = async () => (await get(`/b2b/orders/${po.id}`)).body;
  const partnerAnswers = (id: string, scenario: string, who: "owner" | "member" = "owner") => post(`/b2b/messages/${id}/test-partner`, { scenario }, who);
  const inbound = (text: string, secret: string | null = "x12-secret-123", pid = partner?.id) =>
    app.request(`/api/b2b/inbound/${pid}`, { method: "POST", headers: { "content-type": "text/plain", ...(secret ? { "x-invintel-secret": secret } : {}) }, body: text });
  return { owner, member, base, post, get, item, supplier, partner, partnerRes, po, orgId, send, messages, detail, exchange, partnerAnswers, inbound };
}

const sellerToBuyer: X12Profile = { senderQual: "ZZ", senderId: "SUNRISEPM", receiverQual: "ZZ", receiverId: "NWCORR", version: "004010", usage: "T" };
const NOW = new Date("2026-10-18T09:30:00Z");

describe("saving an X12 partner", () => {
  it("refuses settings that can't work, and says what is wrong", async () => {
    const w = await world({ config: { ...CONFIG, ourId: "" } });
    expect(w.partnerRes.status).toBe(422);
    expect(w.partnerRes.body.error).toMatch(/incomplete/i);
    const base = await world();
    expect(base.partnerRes.status).toBe(201);
    const bad = async (patch: object) => (await base.post(`/b2b/partners/${base.partner.id}`, patch, "owner", "PATCH")).status;
    expect(await bad({ bridgeConfig: { ...CONFIG, version: "003040" } })).toBe(422);
    expect(await bad({ bridgeConfig: { ...CONFIG, theirId: "A*B" } })).toBe(422);
    expect(await bad({ bridgeConfig: { ...CONFIG, transport: "as2" } })).toBe(422);
    expect(await bad({ bridgeConfig: { ...CONFIG, uomMap: "not json" } })).toBe(422);
    expect(await bad({ bridgeConfig: { ...CONFIG, uomMap: '{"bale":"b"}' } })).toBe(422);
    expect(await bad({ mode: "live" })).toBe(422); // the loopback partner can never be live
    expect(await bad({ bridgeConfig: { ...CONFIG, uomMap: '{"bale":"BL"}', version: "005010" } })).toBe(200);
  });
});

describe("sending an order as an 850", () => {
  it("sends X12 with a test indicator and a control number, no supplier page, and a new control number each time", async () => {
    const w = await world();
    const a = await w.send();
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ docType: "order", direction: "out", state: "delivered", contentType: "application/edi-x12", correlation: { poNumber: w.po.number, controlNumber: "1" } });
    const body = (await w.detail(a.body.id)).body as string;
    expect(body.startsWith("ISA*00*")).toBe(true);
    expect(body.split("\n")[0]).toContain("*000000001*0*T*>~");
    expect(body).toContain(`BEG*00*SA*${w.po.number}`);
    expect(body).toContain("PO1*1*6*EA*420.00**BP*LINER-T33");
    expect(body).toContain("DTM*002*20261105");
    expect(await w.exchange()).toMatchObject({ partner: { bridge: "x12", mode: "test" }, portalUrl: null, confirmed: false, lastMessage: { state: "delivered" } });
    const b = await w.send(); // a second send is a new revision: replace, with the next control number
    expect(b.status).toBe(201);
    expect(b.body.correlation.controlNumber).toBe("2");
    expect(((await w.detail(b.body.id)).body as string)).toContain(`BEG*05*SA*${w.po.number}`);
  });

  it("refuses an order X12 can't carry, with the reason, and sends nothing", async () => {
    const w = await world({ unit: "bale" });
    const res = await w.send();
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('The unit "bale" has no X12 unit code');
    expect(await w.messages()).toHaveLength(0);
    await w.post(`/b2b/partners/${w.partner.id}`, { bridgeConfig: { ...CONFIG, uomMap: '{"bale":"BL"}' } }, "owner", "PATCH");
    const ok = await w.send();
    expect(ok.status).toBe(201);
    expect(((await w.detail(ok.body.id)).body as string)).toContain("PO1*1*6*BL*420.00");
  });

  it("control numbers are unique per partner, count up, and wrap after 999999999", async () => {
    const w = await world();
    const pid = new ObjectId(w.partner.id);
    const got = await Promise.all(Array.from({ length: 8 }, () => nextControl(store, w.orgId, pid)));
    expect(new Set(got).size).toBe(8);
    expect(Math.min(...got)).toBe(1);
    expect(Math.max(...got)).toBe(8);
    await store.counters.updateOne({ _id: `${w.orgId.toHexString()}:x12:${w.partner.id}` }, { $set: { seq: 999_999_999 } });
    expect(await nextControl(store, w.orgId, pid)).toBe(1);
  });
});

describe("the test partner answers", () => {
  it("receipt and accept: a 997 and an 855 arrive, our order is acknowledged, we return a 997 for the 855", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    const res = await w.partnerAnswers(sent.id, "acknowledge");
    expect(res.status).toBe(201);
    expect(res.body.map((m: any) => m.docType)).toEqual(["functional_ack", "order_response"]);
    const order = await w.detail(sent.id);
    expect(order.state).toBe("acknowledged");
    expect(order.acks.map((a: any) => `${a.level}:${a.result}`)).toEqual(["functional:accepted", "business:accepted"]);
    const log = await w.messages();
    const ours = log.filter((m) => m.direction === "out" && m.docType === "functional_ack");
    expect(ours).toHaveLength(1); // our receipt for their 855 (not for their 997: a receipt is never itself acknowledged)
    expect(ours[0]).toMatchObject({ state: "delivered", contentType: "application/edi-x12", correlation: { poNumber: w.po.number } });
    expect(log.find((m) => m.docType === "order_response")).toMatchObject({ direction: "in", state: "received", correlation: { poNumber: w.po.number } });
    expect(await w.exchange()).toMatchObject({ confirmed: true, rejected: false, promisedDate: "2026-11-05" });
    // the same answer posted again is a new control number, so a new message; the settled order is not disturbed
    expect((await w.partnerAnswers(sent.id, "acknowledge")).status).toBe(201);
    expect((await w.detail(sent.id)).state).toBe("acknowledged");
  });

  it("accept with changes shows what changed on the order", async () => {
    const w = await world({ qty: 6 });
    const sent = (await w.send()).body;
    await w.partnerAnswers(sent.id, "change");
    const ex = await w.exchange();
    expect(ex.confirmed).toBe(true);
    expect(ex.promisedDate).toBe("2026-11-07");
    expect(ex.note).toContain("Changed: line 1: 6 -> 5 by 2026-11-07");
    expect((await w.detail(sent.id)).acks.at(-1).detail).toContain("Accepted with changes");
  });

  it("reject: the order is marked rejected", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    await w.partnerAnswers(sent.id, "reject");
    expect(await w.exchange()).toMatchObject({ confirmed: false, rejected: true, note: "Out of stock (test partner)." });
    expect((await w.detail(sent.id)).state).toBe("rejected");
  });

  it("a receipt that says the document was malformed rejects our message and says why; no 855 follows", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    const res = await w.partnerAnswers(sent.id, "syntax_error");
    expect(res.body.map((m: any) => m.docType)).toEqual(["functional_ack"]);
    const order = await w.detail(sent.id);
    expect(order.state).toBe("rejected");
    expect(order.acks[0]).toMatchObject({ level: "functional", result: "rejected" });
    expect(order.acks[0].detail).toContain("Number of segments doesn't match the SE count");
  });

  it("ship notice: date, carrier and tracking reach the order; we return a receipt", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    const res = await w.partnerAnswers(sent.id, "ship");
    expect(res.body.map((m: any) => m.docType)).toEqual(["functional_ack", "despatch_advice"]);
    const ex = await w.exchange();
    expect(ex.shipDate).toBe(new Date().toISOString().slice(0, 10));
    expect(ex.carrier).toBe("Test Freight");
    expect(ex.trackingNumber).toMatch(/^TEST-PO-\d+-\d+$/);
    expect((await w.messages("?direction=out")).filter((m) => m.docType === "functional_ack")).toHaveLength(1);
    expect((await w.messages()).find((m) => m.docType === "despatch_advice")).toMatchObject({ correlation: { poNumber: w.po.number, partnerRef: expect.stringMatching(/^TP-/) } });
  });

  it("invoice: an 810 becomes a captured invoice read exactly, matched to the order, and never a payable", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    await w.partnerAnswers(sent.id, "invoice");
    const list = (await w.get("/b2b/invoices", "member")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "captured", source: "x12", poNumber: w.po.number, totalCents: 252000, partnerName: "Sunrise Paper Mill" });
    expect(list[0].invoiceNumber).toMatch(/^TP-INV-\d+$/);
    expect(list[0].confidence).toMatchObject({ invoiceNumber: "read", totalCents: "read", dueDate: "read" });
    expect(list[0].lines).toEqual([expect.objectContaining({ description: "Test liner 33 lb", quantity: "6", unitPriceCents: 42000, lineTotalCents: 252000 })]);
    expect(list[0].match.order).toMatchObject({ number: w.po.number, totalCents: 252000 });
    expect(await store.db.collection("invoices").countDocuments({})).toBe(0);
  });

  it("only answers what it should", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    expect((await w.partnerAnswers(sent.id, "acknowledge", "member")).status).toBe(403);
    expect((await w.partnerAnswers(sent.id, "dance")).status).toBe(400);
    expect((await w.partnerAnswers(new ObjectId().toHexString(), "acknowledge")).status).toBe(404);
    // someone else's organization can't reach it
    const other = await signUp({ mode: "create", name: "Elsewhere" });
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/b2b/messages/${sent.id}/test-partner`, { scenario: "acknowledge" })).status).toBe(404);
    // a live partner, a switched-off partner, a partner on another bridge, and an answer to an answer
    const received = (await w.partnerAnswers(sent.id, "acknowledge")).body[1];
    expect((await w.partnerAnswers(received.id, "acknowledge")).status).toBe(404); // an inbound message isn't an order we sent
    await store.tradingPartners.updateOne({ _id: new ObjectId(w.partner.id) }, { $set: { mode: "live" } });
    expect((await w.partnerAnswers(sent.id, "acknowledge")).body.error).toMatch(/only works for test partners/);
    await store.tradingPartners.updateOne({ _id: new ObjectId(w.partner.id) }, { $set: { mode: "test", enabled: false } });
    expect((await w.partnerAnswers(sent.id, "acknowledge")).status).toBe(409);
    await store.tradingPartners.updateOne({ _id: new ObjectId(w.partner.id) }, { $set: { enabled: true, bridge: "loopback" } });
    expect((await w.partnerAnswers(sent.id, "acknowledge")).body.error).toMatch(/doesn't use X12/);
  });

  it("will not answer an order that was never delivered", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    await store.b2bMessages.updateOne({ _id: new ObjectId(sent.id) }, { $set: { state: "failed" } });
    expect((await w.partnerAnswers(sent.id, "acknowledge")).body.error).toMatch(/never delivered/);
  });
});

describe("documents posted to us over HTTP", () => {
  const theirReceiptFor = async (w: Awaited<ReturnType<typeof world>>, sentId: string, control: number, codes: string[] = []) => {
    const body = (await w.detail(sentId)).body as string;
    const r = readX12(body);
    if (!r.ok) throw new Error("setup");
    const x = ackTo997(acknowledge(r.interchange, codes), { profile: sellerToBuyer, control, now: NOW });
    if (!x.ok) throw new Error(x.errors.join(";"));
    return x.text;
  };

  it("a partner's 997 posted with the secret is matched to what we sent by its control number", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    expect((await w.detail(sent.id)).acks).toHaveLength(0);
    const res = await w.inbound(await theirReceiptFor(w, sent.id, 700));
    expect(res.status).toBe(201);
    const order = await w.detail(sent.id);
    expect(order.acks).toEqual([expect.objectContaining({ level: "functional", result: "accepted" })]);
    expect(order.state).toBe("delivered");
    // a receipt is never answered with a receipt
    expect((await w.messages("?direction=out")).filter((m) => m.docType === "functional_ack")).toHaveLength(0);
  });

  it("a 997 for something we never sent is stored and changes nothing", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    const text = (await theirReceiptFor(w, sent.id, 701)).replace(/AK1\*PO\*1\b/, "AK1*PO*424242");
    expect((await w.inbound(text)).status).toBe(201);
    expect((await w.detail(sent.id)).acks).toHaveLength(0);
  });

  it("a customer's 850 is stored as a received order and answered with a 997; the same one again is a duplicate", async () => {
    const w = await world();
    const o = { kind: "order" as const, version: 1 as const, poNumber: "CUST-77", revision: 1, issuedAt: "2026-10-18", buyer: { name: "Sunrise Paper Mill" }, supplier: { name: "Northwind Corrugated Co.", contact: "", email: "" }, currency: "USD", expectedDate: null, note: "", lines: [{ lineNo: 1, sku: "BOX-1", name: "Box", quantity: "10", unit: "ea", unitPriceCents: 100, lineTotalCents: 1000 }], totalCents: 1000, portalUrl: null };
    const x850 = orderTo850(o, { profile: sellerToBuyer, control: 900, now: NOW });
    if (!x850.ok) throw new Error("setup");
    const first = await w.inbound(x850.text);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ duplicate: false });
    expect((await w.messages("?direction=in")).find((m) => m.docType === "order")).toMatchObject({ state: "received", correlation: { poNumber: "CUST-77" } });
    expect((await w.messages("?direction=out")).filter((m) => m.docType === "functional_ack")).toHaveLength(1);
    const again = await w.inbound(x850.text);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect((await w.messages("?direction=out")).filter((m) => m.docType === "functional_ack")).toHaveLength(1); // no second receipt
  });

  it("the partner's setting can switch receipts off", async () => {
    const w = await world({ config: { ...CONFIG, ack997: "off" } });
    const sent = (await w.send()).body;
    await w.partnerAnswers(sent.id, "acknowledge");
    expect((await w.messages("?direction=out")).filter((m) => m.docType === "functional_ack")).toHaveLength(0);
  });

  it("refuses everything that isn't clearly from this partner, in test mode, with the secret: one plain answer, nothing stored", async () => {
    const w = await world();
    const o = { kind: "order" as const, version: 1 as const, poNumber: "CUST-78", revision: 1, issuedAt: "2026-10-18", buyer: { name: "S" }, supplier: { name: "N", contact: "", email: "" }, currency: "USD", expectedDate: null, note: "", lines: [{ lineNo: 1, sku: "BOX-1", name: "Box", quantity: "10", unit: "ea", unitPriceCents: 100, lineTotalCents: 1000 }], totalCents: 1000, portalUrl: null };
    const make = (profile = sellerToBuyer, control = 910) => {
      const x = orderTo850(o, { profile, control, now: NOW });
      if (!x.ok) throw new Error("setup");
      return x.text;
    };
    const good = make();
    expect((await w.inbound(good, null)).status).toBe(422);
    expect((await w.inbound(good, "wrong")).status).toBe(422);
    expect((await w.inbound(make({ ...sellerToBuyer, senderId: "SOMEONEELSE" }, 911))).status).toBe(422);
    expect((await w.inbound(make({ ...sellerToBuyer, receiverId: "NOTUS" }, 912))).status).toBe(422);
    expect((await w.inbound(make({ ...sellerToBuyer, usage: "P" }, 913))).status).toBe(422); // production traffic to a test partner
    expect((await w.inbound(good.replace(/SE\*\d+/, "SE*3"))).status).toBe(422);
    expect((await w.inbound("not x12 at all")).status).toBe(422);
    expect((await w.inbound(good, "x12-secret-123", new ObjectId().toHexString())).status).toBe(404);
    expect((await w.inbound(good, "x12-secret-123", "nope")).status).toBe(404);
    expect(await w.messages("?direction=in")).toHaveLength(0);
    const detail = await (await w.inbound(good, "wrong")).json();
    expect(JSON.stringify(detail)).toBe('{"error":"Not accepted"}'); // the refusal says nothing about why
    expect((await w.inbound(good)).status).toBe(201);
  });

  it("without a secret set up for the partner, nothing is accepted", async () => {
    const { secretEnv: _drop, ...noSecret } = CONFIG;
    const w = await world({ config: noSecret });
    expect((await w.inbound("ISA", "anything")).status).toBe(422);
    delete process.env.X12_TEST_SECRET;
    const w2 = await world();
    expect((await w2.inbound("ISA", "x12-secret-123")).status).toBe(422);
    process.env.X12_TEST_SECRET = "x12-secret-123";
  });

  it("a live partner needs production documents and refuses test ones", async () => {
    const w = await world();
    const partner = (await store.tradingPartners.findOne({ _id: new ObjectId(w.partner.id) }))!;
    const live = { ...partner, mode: "live" as const, bridgeConfig: { ...partner.bridgeConfig, transport: "" } };
    const o = readX12(((await w.detail((await w.send()).body.id)).body as string));
    if (!o.ok || o.doc.kind !== "order") throw new Error("setup");
    const prod = orderTo850(o.doc.doc, { profile: { ...sellerToBuyer, usage: "P" }, control: 920, now: NOW });
    const test = orderTo850(o.doc.doc, { profile: sellerToBuyer, control: 921, now: NOW });
    if (!prod.ok || !test.ok) throw new Error("setup");
    expect(acceptInbound(prod.text, live)).toMatchObject({ ok: true, docType: "order" });
    expect(acceptInbound(test.text, live)).toMatchObject({ ok: false, error: "A test document sent to a live partner" });
  });
});

describe("audit and the log", () => {
  it("everything is in the log and the audit trail, and a member can read the log but not the X12 text", async () => {
    const w = await world();
    const sent = (await w.send()).body;
    await w.partnerAnswers(sent.id, "acknowledge");
    const audit = (await w.get("/audit")).body;
    const actions = (audit.events as { action: string }[]).map((e) => e.action);
    expect(actions).toContain("b2b.message_sent");
    expect(actions).toContain("b2b.message_received");
    expect(actions).toContain("b2b.message_acknowledged");
    const log = (await w.get("/b2b/messages", "member")).body as any[];
    expect(log.length).toBe(4); // 850 out, 997 in, 855 in, 997 out
    expect((await w.get(`/b2b/messages/${sent.id}`, "member")).body.body).toBe("");
  });
});
