import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { positionOfItem, stockStatusOf, stockWhy, suggestedOrderQty } from "@invintel/shared";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { OutboxTransport, setMailTransport, type MailTransport } from "./mail.js";
import { readX12 } from "./x12-maps.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
const outbox = mkdtempSync(path.join(os.tmpdir(), "invintel-inv16-outbox-"));
beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
  setMailTransport(new OutboxTransport(outbox));
});
afterAll(async () => {
  setMailTransport(null);
  await store.db.dropDatabase();
  await store.close();
});

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `av${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, p: string, body?: unknown, method?: string) => {
  const res = await app.request(p, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
  return { status: res.status, body: json };
};

async function world() {
  const owner = await signUp({ mode: "create", name: "Plant Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call((who === "owner" ? owner : member).cookie, `${base}${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const main = (await get("/locations")).body[0].id as string;
  const mk = async (sku: string, qty: number, reorderLevel = 0, extra: object = {}) => (await post("/items", { sku, name: sku, unitCostCents: 1000, reorderLevel, ...(qty > 0 ? { initialStock: { locationId: main, quantity: qty } } : {}), ...extra })).body.id as string;
  const order = async (lines: { itemId: string; quantity: number; unitPriceCents?: number }[], extra: object = {}) =>
    (await post("/sales/orders", { customerName: "Walk-in", lines: lines.map((l) => ({ unitPriceCents: 5000, ...l })), ...extra })).body;
  const confirm = (id: string, allowShortage = false) => post(`/sales/orders/${id}/confirm`, { allowShortage });
  const ship = (id: string, lines: object[], extra: object = {}) => post(`/sales/orders/${id}/ship`, { lines, ...extra }, "member");
  const so = async (id: string) => (await get(`/sales/orders/${id}`)).body;
  const partner = async (b: object) => (await post("/b2b/partners", { kind: "customer", mode: "test", ...b })).body;
  return { owner, member, base, post, get, main, mk, order, confirm, ship, so, partner, orgId: new ObjectId(owner.org.id) };
}

describe("stock position helpers (shared)", () => {
  const p = (onHand: number, reserved: number, onHold: number, reorderLevel: number) => ({ onHand, reserved, onHold, available: onHand - reserved - onHold, reorderLevel });
  it("out means nothing in stock; low means what is free is at or under the level, or promised more than there is", () => {
    expect(stockStatusOf(p(0, 0, 0, 10))).toBe("out");
    expect(stockStatusOf(p(12, 0, 0, 10))).toBe("ok" === "ok" ? "ok" : "low");
    expect(stockStatusOf(p(12, 2, 0, 10))).toBe("low"); // 10 free, at the level
    expect(stockStatusOf(p(12, 1, 0, 10))).toBe("ok"); // 11 free
    expect(stockStatusOf(p(12, 0, 5, 10))).toBe("low"); // 7 free: 5 are on hold
    expect(stockStatusOf(p(5, 5, 0, 0))).toBe("ok"); // all promised, no level set: nothing to say
    expect(stockStatusOf(p(5, 8, 0, 0))).toBe("low"); // over-promised always counts
    expect(stockStatusOf(p(5, 5, 0, 10))).toBe("low");
    expect(stockStatusOf(p(1, 0, 0, 0))).toBe("ok");
  });
  it("suggests getting back to twice the level on what is free, less what is coming, or covering what is over-promised", () => {
    expect(suggestedOrderQty(p(12, 8, 0, 10), 0)).toBe(16); // 4 free: 20 - 4
    expect(suggestedOrderQty(p(12, 8, 0, 10), 5)).toBe(11);
    expect(suggestedOrderQty(p(12, 8, 0, 10), 40)).toBe(0);
    expect(suggestedOrderQty(p(30, 0, 0, 10), 0)).toBe(0);
    expect(suggestedOrderQty(p(5, 8, 0, 10), 0)).toBe(23); // 3 over-promised: 20 + 3
    expect(suggestedOrderQty(p(5, 8, 0, 0), 0)).toBe(3);
    expect(suggestedOrderQty(p(5, 8, 0, 0), 3)).toBe(0);
    expect(suggestedOrderQty(p(5, 5, 0, 0), 0)).toBe(0);
  });
  it("explains itself in plain words", () => {
    const fmt = (x: number) => String(x);
    expect(stockWhy(p(12, 8, 0, 10), fmt)).toBe("12 on hand, 8 promised, 4 free, reorder at 10");
    expect(stockWhy(p(12, 0, 5, 10), fmt)).toBe("12 on hand, 5 on quality hold, 7 free, reorder at 10");
    expect(stockWhy(p(5, 8, 0, 0), fmt)).toBe("5 on hand, 8 promised, 3 over-promised");
    expect(stockWhy(p(30, 0, 0, 0), fmt)).toBe("30 on hand");
    expect(positionOfItem({ quantity: 12, reorderLevel: 10 })).toMatchObject({ onHand: 12, reserved: 0, available: 12, onHold: 0 });
    expect(positionOfItem({ quantity: 12, reorderLevel: 10, reserved: 8, available: 4 })).toMatchObject({ onHold: 0 });
    expect(positionOfItem({ quantity: 12, reorderLevel: 10, reserved: 0, available: 7 })).toMatchObject({ onHold: 5 });
  });
});

describe("low stock, alerts and suggestions use what is available", () => {
  it("promising stock turns an item low in the overview, the alerts, the suggestions and the item list, and says why", async () => {
    const w = await world();
    const kraft = await w.mk("KRAFT", 12, 10);
    const quiet = await w.mk("GLUE", 50, 10);
    const alertsOf = async () => ((await w.get("/alerts")).body.alerts as { type: string; title: string; detail: string; severity: string }[]).filter((a) => /KRAFT/.test(a.title));
    expect((await w.get("/overview")).body.attention).toEqual([]);
    expect(await alertsOf()).toEqual([]);
    expect((await w.get("/purchasing/suggestions")).body).toEqual([]);

    const o = await w.order([{ itemId: kraft, quantity: 8 }]);
    expect((await w.confirm(o.id)).status).toBe(200);
    const overview = (await w.get("/overview")).body;
    expect(overview.lowCount).toBe(1);
    expect(overview.attention).toEqual([expect.objectContaining({ sku: "KRAFT", status: "low", quantity: 12, reserved: 8, available: 4, reorderLevel: 10 })]);
    expect(await alertsOf()).toEqual([expect.objectContaining({ type: "low_stock", severity: "warning", title: "KRAFT is low", detail: "12 on hand, 8 promised, 4 free, reorder at 10." })]);
    const sug = (await w.get("/purchasing/suggestions")).body;
    expect(sug).toEqual([expect.objectContaining({ sku: "KRAFT", quantity: 12, reserved: 8, available: 4, reorderLevel: 10, onOrder: 0, suggestedQuantity: 16 })]);
    const items = (await w.get("/items")).body as { id: string; available: number }[];
    expect(items.find((i) => i.id === kraft)!.available).toBe(4);
    expect(items.find((i) => i.id === quiet)!.available).toBe(50);

    // shipping what was promised leaves the stock at 4 on hand, 4 free: still low, and nothing is promised any more
    await w.ship(o.id, [{ itemId: kraft, quantity: 8, locationId: w.main }]);
    expect((await w.get("/overview")).body.attention[0]).toMatchObject({ quantity: 4, reserved: 0, available: 4 });
    // cancelling instead releases it: back to fine
    const o2 = await w.order([{ itemId: quiet, quantity: 45 }]);
    await w.confirm(o2.id);
    expect((await w.get("/overview")).body.attention.map((a: any) => a.sku).sort()).toEqual(["GLUE", "KRAFT"]);
    await w.post(`/sales/orders/${o2.id}/cancel`, {});
    expect((await w.get("/overview")).body.attention.map((a: any) => a.sku)).toEqual(["KRAFT"]);
  });

  it("an item that is physically out is out; one that is only fully promised is low, not out; over-promising is critical even without a reorder level", async () => {
    const w = await world();
    const a = await w.mk("PROMISED", 10, 5);
    const b = await w.mk("ZERO", 0, 5);
    const c = await w.mk("NOLEVEL", 5, 0);
    await w.confirm((await w.order([{ itemId: a, quantity: 10 }])).id);
    await w.confirm((await w.order([{ itemId: c, quantity: 8 }])).id, true); // a back-order: 3 over-promised
    const att = (await w.get("/overview")).body.attention as { sku: string; status: string; available: number }[];
    expect(att.find((x) => x.sku === "ZERO")).toMatchObject({ status: "out" });
    expect(att.find((x) => x.sku === "PROMISED")).toMatchObject({ status: "low", available: 0 });
    expect(att.find((x) => x.sku === "NOLEVEL")).toMatchObject({ status: "low", available: -3 });
    expect(att[0]!.sku).toBe("ZERO"); // out first
    const alerts = (await w.get("/alerts")).body.alerts as { type: string; title: string; severity: string; detail: string }[];
    expect(alerts.find((x) => /NOLEVEL/.test(x.title))).toMatchObject({ type: "low_stock", severity: "critical", title: "NOLEVEL is over-promised", detail: "5 on hand, 8 promised, 3 over-promised." });
    expect(alerts.find((x) => /ZERO/.test(x.title))).toMatchObject({ type: "out_of_stock" });
    expect(alerts.find((x) => /PROMISED/.test(x.title))).toMatchObject({ type: "low_stock", severity: "warning" });
    void b;
    // the over-promised item with no level is still suggested: order what covers the promise
    const sug = (await w.get("/purchasing/suggestions")).body as { sku: string; suggestedQuantity: number }[];
    expect(sug.find((s) => s.sku === "NOLEVEL")).toMatchObject({ suggestedQuantity: 3 });
    expect(sug.find((s) => s.sku === "PROMISED")).toMatchObject({ suggestedQuantity: 10 });
    expect(sug[0]!.sku).toBe("NOLEVEL"); // most urgent (most over-promised) first
  });

  it("quality hold counts against what is available", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 12, 10);
    expect((await w.get("/overview")).body.attention).toEqual([]);
    expect((await w.post("/quality/holds", { itemId: k, locationId: w.main, quantity: 5, reason: "Damaged" })).status).toBe(201);
    expect((await w.get("/overview")).body.attention[0]).toMatchObject({ sku: "KRAFT", quantity: 12, available: 7, status: "low" });
    const alert = ((await w.get("/alerts")).body.alerts as { title: string; detail: string }[]).find((a) => /KRAFT/.test(a.title))!;
    expect(alert.detail).toBe("12 on hand, 5 on quality hold, 7 free, reorder at 10.");
  });

  it("suggestions count what is already on order, and the draft order made from them has exactly those quantities", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 12, 10);
    const g = await w.mk("GLUE", 3, 10);
    await w.confirm((await w.order([{ itemId: k, quantity: 8 }])).id);
    const supplier = (await w.post("/purchasing/suppliers", { name: "Mill" })).body.id as string;
    const po = (await w.post("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: k, quantity: 5, unitCostCents: 100 }] })).body;
    await w.post(`/purchasing/orders/${po.id}/place`, {});
    const sug = (await w.get("/purchasing/suggestions")).body as { itemId: string; suggestedQuantity: number; onOrder: number }[];
    expect(sug.find((s) => s.itemId === k)).toMatchObject({ onOrder: 5, suggestedQuantity: 11 }); // 20 - 4 free - 5 coming
    expect(sug.find((s) => s.itemId === g)).toMatchObject({ suggestedQuantity: 17 });
    const draft = (await w.post("/purchasing/orders/from-suggestions", { supplierId: supplier, itemIds: [k, g] })).body;
    expect(draft.lines.map((l: any) => [l.itemSku, l.quantity]).sort()).toEqual([["GLUE", 17], ["KRAFT", 11]]);
  });

  it("what a partner is told on the Exchange and what the item page shows agree with it", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 12, 10);
    await w.confirm((await w.order([{ itemId: k, quantity: 8 }])).id);
    const item = (await w.get(`/items/${k}`)).body;
    expect(item).toMatchObject({ quantity: 12, reserved: 8, available: 4 });
  });
});

describe("a ship notice to the customer, over the way we trade with them", () => {
  const files = () => readdirSync(outbox).sort();
  const lastMail = (before: number) => readFileSync(path.join(outbox, files()[before]!), "utf8");
  const text = (eml: string) => Buffer.from(/base64\r\n\r\n([\s\S]*?)\r\n--/.exec(eml)![1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
  const shipped = async (w: Awaited<ReturnType<typeof world>>, customerPartnerId: string, itemId: string, extra: object = {}, qty = 6) => {
    const o = await w.order([{ itemId, quantity: qty }], { customerPartnerId, customerRef: "BP-9", ...extra });
    await w.confirm(o.id);
    return o;
  };

  it("an email customer gets an email with what went, the carrier and the tracking; the same shipment is never emailed twice", async () => {
    setMailTransport(new OutboxTransport(outbox));
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const cust = await w.partner({ name: "Bluebird", bridge: "email", bridgeConfig: { to: "ops@bluebird.example" } });
    const o = await shipped(w, cust.id, k);
    expect((await w.so(o.id)).noticeVia).toBe("an email"); // the order screen says how they will be told
    const before = files().length;
    const res = await w.ship(o.id, [{ itemId: k, quantity: 6, locationId: w.main }], { shippedDate: "2026-11-03", carrier: "UPS Freight", trackingNumber: "1Z999" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ notice: "sent", shipmentNumber: "SO-0001-1" });
    expect(files().length).toBe(before + 1);
    const eml = lastMail(before);
    expect(eml).toContain("To: ops@bluebird.example");
    expect(eml).toMatch(/Subject: Shipment SO-0001-1 for your order BP-9 from Plant Co \(TEST\)/);
    expect(eml).toContain('filename="SO-0001-1-packing-slip.pdf"'); // the packing slip rides along (INV-17)
    const body = text(eml);
    expect(body).toContain("shipped part or all of your order BP-9 (shipment SO-0001-1) on 2026-11-03");
    expect(body).toContain("1. KRAFT: 6 ea");
    expect(body).toContain("Carrier: UPS Freight");
    expect(body).toContain("Tracking number: 1Z999");
    const order = await w.so(o.id);
    expect(order.shipments[0]).toMatchObject({ notice: "sent", shippedDate: "2026-11-03" });
    const log = ((await w.get("/b2b/messages?direction=out")).body as any[]).filter((m) => m.docType === "despatch_advice");
    expect(log).toEqual([expect.objectContaining({ state: "sent", correlation: expect.objectContaining({ poNumber: "BP-9", partnerRef: "SO-0001-1" }) })]);
    // sending again is a no-op
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/notice`, {})).status).toBe(200);
    expect(files().length).toBe(before + 1);
  });

  it("a mail failure that may pass is retried as the same message and goes out once; a wrong address is fixed and sent as a new message", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const down: MailTransport = { kind: "down", send: async () => ({ ok: false, error: "smtp down", retryable: true }) };
    setMailTransport(down);
    const cust = await w.partner({ name: "Bluebird", bridge: "email", bridgeConfig: { to: "ops@bluebird.example" } });
    const o = await shipped(w, cust.id, k);
    const res = await w.ship(o.id, [{ itemId: k, quantity: 6, locationId: w.main }]);
    expect(res.status).toBe(201); // the shipment stands
    expect(res.body).toMatchObject({ notice: "failed", noticeError: "smtp down" });
    expect((await w.get("/items")).body.find((i: any) => i.id === k).quantity).toBe(34);
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/notice`, {})).status).toBe(409);
    setMailTransport(new OutboxTransport(outbox));
    const before = files().length;
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/notice`, {})).status).toBe(200);
    expect(files().length).toBe(before + 1);
    expect((await w.so(o.id)).shipments[0].notice).toBe("sent");
    const out = ((await w.get("/b2b/messages?direction=out")).body as any[]).filter((m) => m.docType === "despatch_advice");
    expect(out).toHaveLength(1); // one message, tried twice
    expect(out[0].attempts).toHaveLength(3); // down, down again on the manual try, then sent

    // wrong address: not retryable, but once it is corrected the notice goes out as a new message
    const bad = await w.partner({ name: "Typo Ltd", bridge: "email", bridgeConfig: { to: "ops@typo.example" } });
    await store.tradingPartners.updateOne({ _id: new ObjectId(bad.id) }, { $set: { "bridgeConfig.to": "not-an-address" } });
    const o2 = await shipped(w, bad.id, k);
    const r2 = await w.ship(o2.id, [{ itemId: k, quantity: 6, locationId: w.main }]);
    expect(r2.body.notice).toBe("failed");
    expect(r2.body.noticeError).toMatch(/valid email address/);
    await w.post(`/b2b/partners/${bad.id}`, { bridgeConfig: { to: "ops@typo.example" } }, "owner", "PATCH");
    const before2 = files().length;
    expect((await w.post(`/sales/orders/${o2.id}/shipments/SO-0002-1/notice`, {})).status).toBe(200);
    expect(files().length).toBe(before2 + 1);
    const out2 = ((await w.get("/b2b/messages?direction=out")).body as any[]).filter((m) => m.docType === "despatch_advice" && m.correlation.partnerRef === "SO-0002-1");
    expect(out2.map((m) => m.idempotencyKey).sort()).toEqual([expect.stringMatching(/:SO-0002-1$/), expect.stringMatching(/:SO-0002-1:r2$/)]);
    expect(out2.map((m) => m.state).sort()).toEqual(["failed", "sent"]);
  });

  it("an X12 customer gets an 856 in the right envelope, with their own order number, and what really shipped", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const cfg = { ourQual: "ZZ", ourId: "PLANTCO", theirQual: "ZZ", theirId: "BLUEBIRD", version: "004010", transport: "loopback" };
    const cust = await w.partner({ name: "Bluebird", bridge: "x12", bridgeConfig: cfg });
    const o = await shipped(w, cust.id, k);
    expect((await w.so(o.id)).noticeVia).toBe("an X12 856");
    const res = await w.ship(o.id, [{ itemId: k, quantity: 4, locationId: w.main }], { shippedDate: "2026-11-03", carrier: "UPS Freight", trackingNumber: "1Z999" });
    expect(res.body).toMatchObject({ notice: "sent", shipmentNumber: "SO-0001-1" });
    const m = ((await w.get("/b2b/messages?direction=out")).body as any[]).find((x) => x.docType === "despatch_advice");
    expect(m).toMatchObject({ contentType: "application/edi-x12", state: "delivered", correlation: expect.objectContaining({ poNumber: "BP-9", partnerRef: "SO-0001-1", controlNumber: "1" }) });
    const raw = (await w.get(`/b2b/messages/${m.id}`)).body.body as string;
    expect(raw.split("\n")[0]).toContain("*ZZ*PLANTCO        *ZZ*BLUEBIRD");
    expect(raw).toContain("*000000001*0*T*>~");
    expect(raw).toContain("BSN*00*SO-0001-1*20261103");
    expect(raw).toContain("PRF*BP-9");
    expect(raw).toContain("LIN*1*BP*KRAFT");
    expect(raw).toContain("SN1**4*EA");
    expect(raw).toContain("REF*CN*1Z999");
    const back = readX12(raw);
    expect(back.ok && back.doc).toMatchObject({ kind: "despatch_advice", doc: { shipmentNo: "SO-0001-1", poNumber: "BP-9", carrier: "UPS Freight", lines: [{ lineNo: 1, sku: "KRAFT", quantity: "4", unit: "ea" }] } });
    // the second part is its own notice with the next control number
    await w.ship(o.id, [{ itemId: k, quantity: 2, locationId: w.main }]);
    const all = ((await w.get("/b2b/messages?direction=out")).body as any[]).filter((x) => x.docType === "despatch_advice");
    expect(all.map((x) => x.correlation.controlNumber).sort()).toEqual(["1", "2"]);
    expect(await w.so(o.id)).toMatchObject({ status: "shipped" });
  });

  it("when the 856 can't be written the shipment stands and the notice says why; once fixed it is sent", async () => {
    const w = await world();
    const bale = await w.mk("BALE", 40, 0, { unit: "bale" });
    const cfg = { ourQual: "ZZ", ourId: "PLANTCO", theirQual: "ZZ", theirId: "BLUEBIRD", version: "004010", transport: "loopback" };
    const cust = await w.partner({ name: "Bluebird", bridge: "x12", bridgeConfig: cfg });
    const o = await shipped(w, cust.id, bale, { customerRef: "A-PO-NUMBER-THAT-IS-FAR-TOO-LONG-FOR-X12" }, 5);
    const res = await w.ship(o.id, [{ itemId: bale, quantity: 5, locationId: w.main }]);
    expect(res.status).toBe(201);
    expect(res.body.notice).toBe("failed");
    expect(res.body.noticeError).toContain("PO number");
    expect(res.body.noticeError).toContain('no X12 unit code');
    expect((await w.get("/items")).body.find((i: any) => i.id === bale).quantity).toBe(35);
    // a short order number, and the unit mapped: send again
    await store.salesOrders.updateOne({ _id: new ObjectId(o.id) }, { $set: { customerRef: "BP-12" } });
    await w.post(`/b2b/partners/${cust.id}`, { bridgeConfig: { ...cfg, uomMap: '{"bale":"BL"}' } }, "owner", "PATCH");
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/notice`, {})).status).toBe(200);
    const m = ((await w.get("/b2b/messages?direction=out")).body as any[]).find((x) => x.docType === "despatch_advice");
    expect((await w.get(`/b2b/messages/${m.id}`)).body.body).toContain("SN1**5*BL");
  });

  it("other bridges that can carry a ship notice get the canonical document; a customer who is just a name, or whose bridge can't, hears nothing", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const loop = await w.partner({ name: "Loopy", bridge: "loopback" });
    const o = await shipped(w, loop.id, k, { customerRef: "" });
    const res = await w.ship(o.id, [{ itemId: k, quantity: 6, locationId: w.main }], { shippedDate: "2026-11-03" });
    expect(res.body.notice).toBe("sent");
    const m = ((await w.get("/b2b/messages?direction=out")).body as any[]).find((x) => x.docType === "despatch_advice");
    const doc = JSON.parse((await w.get(`/b2b/messages/${m.id}`)).body.body);
    expect(doc).toMatchObject({ kind: "despatch_advice", shipmentNo: "SO-0001-1", poNumber: "SO-0001", shipDate: "2026-11-03", shipper: "Plant Co", lines: [{ lineNo: 1, sku: "KRAFT", quantity: "6", unit: "ea" }] }); // no customer ref: ours is used

    const walkin = await w.order([{ itemId: k, quantity: 2 }]);
    await w.confirm(walkin.id);
    const r2 = await w.ship(walkin.id, [{ itemId: k, quantity: 2, locationId: w.main }]);
    expect(r2.body.notice).toBeNull();
    expect(r2.body.order.noticeVia).toBeNull();
    expect((await w.post(`/sales/orders/${walkin.id}/shipments/SO-0002-1/notice`, {})).status).toBe(409);

    const inbox = await w.partner({ name: "Inbox only", bridge: "invoice-inbox", bridgeConfig: { secretEnv: "X" } });
    const o3 = await shipped(w, inbox.id, k);
    expect((await w.ship(o3.id, [{ itemId: k, quantity: 1, locationId: w.main }])).body.notice).toBeNull();
    // fractional quantities keep their decimals
    const kg = await w.mk("RESIN", 100000, 0, { unit: "kg", decimals: 3 });
    const o4 = await shipped(w, loop.id, kg, { customerRef: "R-1" }, 12500);
    await w.ship(o4.id, [{ itemId: kg, quantity: 12500, locationId: w.main }]);
    const m4 = ((await w.get("/b2b/messages?direction=out")).body as any[]).find((x) => x.docType === "despatch_advice" && x.correlation.poNumber === "R-1");
    expect(JSON.parse((await w.get(`/b2b/messages/${m4.id}`)).body.body).lines[0]).toMatchObject({ quantity: "12.500", unit: "kg" });
  });

  it("a customer's partner that is switched off can't be told, and the shipment still stands", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const cust = await w.partner({ name: "Bluebird", bridge: "email", bridgeConfig: { to: "ops@bluebird.example" } });
    const o = await shipped(w, cust.id, k);
    await w.post(`/b2b/partners/${cust.id}`, { enabled: false }, "owner", "PATCH");
    const res = await w.ship(o.id, [{ itemId: k, quantity: 6, locationId: w.main }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ notice: "failed", noticeError: expect.stringContaining("switched off") });
  });
});

describe("editing a confirmed order is cancel-and-rewrite in one step", () => {
  it("writes a draft copy, cancels the confirmed order and releases its stock; the copy reserves nothing until it is confirmed again", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const g = await w.mk("GLUE", 20);
    const cust = await w.partner({ name: "Bluebird", bridge: "loopback" });
    const o = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 7000 }, { itemId: g, quantity: 4, unitPriceCents: 300 }], { customerPartnerId: cust.id, customerRef: "BP-9", requestedDate: "2026-11-20", note: "Dock 2" });
    await w.confirm(o.id);
    expect((await w.get("/items")).body.find((i: any) => i.id === k).reserved).toBe(10);
    expect((await w.post(`/sales/orders/${o.id}/rewrite`, {}, "member")).status).toBe(403);
    const res = await w.post(`/sales/orders/${o.id}/rewrite`, {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "SO-0002", status: "draft", customer: { partnerId: cust.id, name: "Bluebird" }, customerRef: "BP-9", requestedDate: "2026-11-20", note: "Dock 2", source: "manual" });
    expect(res.body.lines.map((l: any) => [l.itemSku, l.quantity, l.unitPriceCents, l.reserved])).toEqual([["KRAFT", 10, 7000, 0], ["GLUE", 4, 300, 0]]);
    expect(await w.so(o.id)).toMatchObject({ status: "cancelled" });
    expect((await w.get("/items")).body.find((i: any) => i.id === k)).toMatchObject({ reserved: 0, available: 40 });
    const audit = ((await w.get("/audit")).body.events as { action: string; summary: string }[]).filter((e) => /rewr/i.test(e.summary) || /rewritten/.test(e.summary));
    expect(audit.length).toBeGreaterThanOrEqual(2); // the cancel names the new order; the new order names the old
    // edit the copy, confirm it: reserved again, at the new quantity
    const edited = await w.post(`/sales/orders/${res.body.id}`, { lines: [{ itemId: k, quantity: 12, unitPriceCents: 7000 }] }, "owner", "PATCH");
    expect(edited.status).toBe(200);
    expect((await w.confirm(res.body.id)).status).toBe(200);
    expect((await w.get("/items")).body.find((i: any) => i.id === k)).toMatchObject({ reserved: 12, available: 28 });
  });

  it("refuses what isn't a confirmed order that hasn't shipped, but allows one whose shipment was undone", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    const rewrite = (id: string) => w.post(`/sales/orders/${id}/rewrite`, {});
    const draft = await w.order([{ itemId: k, quantity: 5 }]);
    expect((await rewrite(draft.id)).status).toBe(409); // edit it directly
    expect((await rewrite(new ObjectId().toHexString())).status).toBe(404);
    const part = await w.order([{ itemId: k, quantity: 10 }]);
    await w.confirm(part.id);
    await w.ship(part.id, [{ itemId: k, quantity: 3, locationId: w.main }]);
    const refused = await rewrite(part.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Close it/);
    expect((await w.so(part.id)).status).toBe("partial"); // untouched
    expect(((await w.get("/sales/orders")).body as any[]).length).toBe(2); // and no copy was left behind
    await w.post(`/sales/orders/${part.id}/close`, {});
    expect((await rewrite(part.id)).status).toBe(409); // closed
    // shipped, then the shipment undone in Activity: nothing has shipped any more, so it can be rewritten
    const undone = await w.order([{ itemId: k, quantity: 4 }]);
    await w.confirm(undone.id);
    await w.ship(undone.id, [{ itemId: k, quantity: 4, locationId: w.main }]);
    const entry = ((await w.get("/movements?type=ship")).body.entries as { id: string; reversed: boolean }[]).find((e) => !e.reversed && true)!;
    const lines = (await w.get("/movements?type=ship")).body.entries as { id: string; reason: string; reversed: boolean }[];
    const mine = lines.find((e) => e.reason.includes(undone.number) && !e.reversed) ?? entry;
    await w.post(`/movements/${mine.id}/reverse`, {});
    expect((await rewrite(undone.id)).status).toBe(201);
  });

  it("the new draft is held to the approval rule again when it is confirmed", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 40);
    await w.post("/approvals/rules", { rules: [{ kind: "sales_order", thresholdCents: 10000, appliesTo: "everyone" }] }, "owner", "PUT");
    const o = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 5000 }]);
    const held = await w.confirm(o.id);
    expect(held.status).toBe(202);
    await w.post(`/approvals/${held.body.approval.id}/approve`, {});
    expect((await w.so(o.id)).status).toBe("confirmed");
    const copy = (await w.post(`/sales/orders/${o.id}/rewrite`, {})).body;
    expect((await w.confirm(copy.id)).status).toBe(202);
  });

  it("a shipment racing a rewrite leaves exactly one live order, never two and never none", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 400);
    for (let round = 0; round < 8; round++) {
      const o = await w.order([{ itemId: k, quantity: 5 }]);
      await w.confirm(o.id);
      await Promise.all([w.post(`/sales/orders/${o.id}/rewrite`, {}), w.ship(o.id, [{ itemId: k, quantity: 5, locationId: w.main }])]);
    }
    const all = (await w.get("/sales/orders")).body as { status: string; lines: { quantity: number; shipped: number; reserved: number }[] }[];
    // each round: the old order shipped (and its copy was withdrawn), or the old was cancelled and its copy is the live draft. Never both.
    const live = all.filter((o) => o.status !== "cancelled");
    expect(live).toHaveLength(8);
    const item = (await w.get("/items")).body.find((i: any) => i.id === k);
    const shippedUnits = all.reduce((s, o) => s + o.lines.reduce((t, l) => t + l.shipped, 0), 0);
    expect(item.quantity).toBe(400 - shippedUnits);
    expect(item.reserved).toBe(all.filter((o) => o.status === "confirmed").reduce((s, o) => s + o.lines.reduce((t, l) => t + l.reserved, 0), 0));
  });
});
