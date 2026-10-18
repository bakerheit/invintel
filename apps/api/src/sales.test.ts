import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `so${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const shelf = (await post("/locations", { name: "Shelf 2" })).body.id as string;
  const kraft = (await post("/items", { sku: "KRAFT", name: "Kraft roll", unitCostCents: 48000, initialStock: { locationId: main, quantity: 40 } })).body.id as string;
  const glue = (await post("/items", { sku: "GLUE", name: "Glue", unitCostCents: 250, initialStock: { locationId: main, quantity: 20 } })).body.id as string;
  const customer = (await post("/b2b/partners", { name: "Acme Boxes", kind: "customer", bridge: "loopback", mode: "test" })).body.id as string;
  const order = async (lines: { itemId: string; quantity: number; unitPriceCents?: number }[], extra: object = {}) =>
    (await post("/sales/orders", { customerName: "Walk-in", lines: lines.map((l) => ({ unitPriceCents: 50000, ...l })), ...extra })).body;
  const item = async (id: string) => (await get(`/items/${id}`)).body;
  const so = async (id: string) => (await get(`/sales/orders/${id}`)).body;
  const confirm = (id: string, allowShortage = false) => post(`/sales/orders/${id}/confirm`, { allowShortage });
  const ship = (id: string, lines: object[], who: "owner" | "member" = "member", extra: object = {}) => post(`/sales/orders/${id}/ship`, { lines, ...extra }, who);
  return { owner, member, base, post, get, main, shelf, kraft, glue, customer, order, item, so, confirm, ship };
}

describe("sales orders: writing, roles, validation", () => {
  it("an admin writes drafts, anyone reads, and a draft reserves nothing", async () => {
    const w = await world();
    expect((await w.post("/sales/orders", { customerName: "X", lines: [{ itemId: w.kraft, quantity: 1, unitPriceCents: 1 }] }, "member")).status).toBe(403);
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }], { customerRef: "PO-77", requestedDate: "2026-11-20", note: "Dock 2" });
    expect(o).toMatchObject({ number: "SO-0001", status: "draft", source: "manual", customer: { partnerId: null, name: "Walk-in" }, customerRef: "PO-77", requestedDate: "2026-11-20", totalCents: 500000 });
    expect(o.lines[0]).toMatchObject({ itemSku: "KRAFT", quantity: 10, shipped: 0, reserved: 0, available: 40 });
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 40, reserved: 0, available: 40 });
    expect((await w.get("/sales/orders", "member")).body).toHaveLength(1);
    expect((await w.get(`/sales/orders/${o.id}`, "member")).status).toBe(200);
    expect((await w.get(`/sales/orders/${new ObjectId().toHexString()}`)).status).toBe(404);
    expect((await w.get("/sales/orders?status=confirmed")).body).toHaveLength(0);
  });

  it("refuses an order with no customer, no lines, a repeated or unknown item, or a customer who isn't a customer partner", async () => {
    const w = await world();
    const bad = async (b: object) => (await w.post("/sales/orders", b)).status;
    const line = { itemId: w.kraft, quantity: 1, unitPriceCents: 1 };
    expect(await bad({ lines: [line] })).toBe(400); // who is the customer?
    expect(await bad({ customerName: "X", lines: [] })).toBe(400);
    expect(await bad({ customerName: "X", lines: [line, line] })).toBe(400);
    expect(await bad({ customerName: "X", lines: [{ ...line, itemId: new ObjectId().toHexString() }] })).toBe(400);
    expect(await bad({ customerName: "X", lines: [{ ...line, quantity: 0 }] })).toBe(400);
    expect(await bad({ customerName: "X", lines: [{ ...line, quantity: 1.5 }] })).toBe(400);
    expect(await bad({ customerPartnerId: new ObjectId().toHexString(), lines: [line] })).toBe(400);
    const supplier = (await w.post("/b2b/partners", { name: "Some Mill", kind: "supplier", bridge: "loopback", mode: "test" })).body.id;
    expect(await bad({ customerPartnerId: supplier, lines: [line] })).toBe(400);
    const ok = await w.post("/sales/orders", { customerPartnerId: w.customer, lines: [line] });
    expect(ok.status).toBe(201);
    expect(ok.body.customer).toMatchObject({ partnerId: w.customer, name: "Acme Boxes" });
  });

  it("edits a draft only, audits the change, and never lets a confirmed order be rewritten", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    const edited = await w.post(`/sales/orders/${o.id}`, { customerRef: "R-1", lines: [{ itemId: w.kraft, quantity: 12, unitPriceCents: 40000 }] }, "owner", "PATCH");
    expect(edited.body).toMatchObject({ customerRef: "R-1", totalCents: 480000 });
    expect((await w.post(`/sales/orders/${o.id}`, { note: "x" }, "member", "PATCH")).status).toBe(403);
    await w.confirm(o.id);
    expect((await w.post(`/sales/orders/${o.id}`, { note: "late" }, "owner", "PATCH")).status).toBe(409);
    const audit = (await w.get("/audit")).body.events.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["sales_order.created", "sales_order.updated", "sales_order.confirmed"]));
  });

  it("is invisible to other organizations", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 5 }]);
    const other = await signUp({ mode: "create", name: "Elsewhere" });
    const ob = `/api/orgs/${other.org.id}`;
    expect((await call(other.cookie, `${ob}/sales/orders/${o.id}`)).status).toBe(404);
    expect((await call(other.cookie, `${ob}/sales/orders/${o.id}/confirm`, {})).status).toBe(404);
    expect((await call(other.cookie, `${ob}/sales/orders/${o.id}/ship`, { lines: [{ itemId: w.kraft, quantity: 1, locationId: w.main }] })).status).toBe(404);
    expect((await call(other.cookie, `${ob}/sales/orders`)).body).toEqual([]);
    expect((await call(other.cookie, `/api/orgs/${w.base.split("/").pop()}/sales/orders`)).status).toBe(404);
  });
});

describe("reserving stock", () => {
  it("confirming reserves, available = on hand - reserved, and a cancel releases", async () => {
    const w = await world();
    const a = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    const res = await w.confirm(a.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "confirmed" });
    expect((await store.salesOrders.findOne({ _id: new ObjectId(a.id) }))?.confirmingUntil).toBeUndefined(); // a finished confirm leaves no guard behind
    expect(res.body.lines[0]).toMatchObject({ reserved: 10, available: 30 });
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 40, reserved: 10, available: 30 });
    const list = (await w.get("/items")).body as { id: string; reserved: number; available: number }[];
    expect(list.find((i) => i.id === w.kraft)).toMatchObject({ reserved: 10, available: 30 });
    expect(list.find((i) => i.id === w.glue)).toMatchObject({ reserved: 0, available: 20 });
    expect((await w.post(`/sales/orders/${a.id}/cancel`, {})).body.status).toBe("cancelled");
    expect(await w.item(w.kraft)).toMatchObject({ reserved: 0, available: 40 });
    expect((await w.confirm(a.id)).status).toBe(409); // a cancelled order is over
  });

  it("refuses to promise what isn't there, says what is short, and leaves the order a draft; a back-order is allowed on purpose", async () => {
    const w = await world();
    await w.confirm((await w.order([{ itemId: w.kraft, quantity: 30 }])).id);
    const b = await w.order([{ itemId: w.kraft, quantity: 20 }, { itemId: w.glue, quantity: 5 }]);
    const refused = await w.confirm(b.id);
    expect(refused.status).toBe(409);
    expect(refused.body.shortages).toEqual([expect.objectContaining({ itemSku: "KRAFT", needed: 20, available: 10 })]);
    expect(refused.body.error).toContain("KRAFT");
    expect((await w.so(b.id)).status).toBe("draft");
    expect(await w.item(w.glue)).toMatchObject({ reserved: 0 }); // nothing of it was held, not even the glue that was fine
    const forced = await w.confirm(b.id, true);
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ status: "confirmed", short: true });
    expect(await w.item(w.kraft)).toMatchObject({ reserved: 50, available: -10 }); // over-promised, and shown as such
  });

  it("two confirms racing for the same stock never both succeed", async () => {
    const w = await world();
    for (let round = 0; round < 6; round++) {
      const a = await w.order([{ itemId: w.glue, quantity: 15 }]);
      const b = await w.order([{ itemId: w.glue, quantity: 15 }]);
      const [x, y] = await Promise.all([w.confirm(a.id), w.confirm(b.id)]);
      expect([x.status, y.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
      expect((await w.item(w.glue)).available).toBeGreaterThanOrEqual(0);
      // whoever lost can be confirmed after the winner goes away
      await w.post(`/sales/orders/${a.id}/cancel`, {});
      await w.post(`/sales/orders/${b.id}/cancel`, {});
      expect(await w.item(w.glue)).toMatchObject({ reserved: 0, available: 20 });
    }
  });

  it("stock on quality hold is not available to promise", async () => {
    const w = await world();
    expect((await w.post("/quality/holds", { itemId: w.kraft, locationId: w.main, quantity: 8, reason: "Damaged" })).status).toBe(201);
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 40, reserved: 0, available: 32 });
    const o = await w.order([{ itemId: w.kraft, quantity: 33 }]);
    const refused = await w.confirm(o.id);
    expect(refused.status).toBe(409);
    expect(refused.body.shortages[0]).toMatchObject({ needed: 33, available: 32 });
    expect((await w.confirm((await w.order([{ itemId: w.kraft, quantity: 32 }])).id)).status).toBe(200);
  });

  it("a switched-off Sales module refuses its API", async () => {
    const w = await world();
    await w.post("/modules", { sales: false }, "owner", "PATCH");
    expect((await w.get("/sales/orders")).status).toBe(403);
    await w.post("/modules", { sales: true }, "owner", "PATCH");
    expect((await w.get("/sales/orders")).status).toBe(200);
  });
});

describe("approvals for big orders", () => {
  it("a rule holds the confirmation for a second look, reserves only once it is approved, and a rejection leaves it a draft", async () => {
    const w = await world();
    await w.post("/approvals/rules", { rules: [{ kind: "sales_order", thresholdCents: 100000, appliesTo: "everyone" }] }, "owner", "PUT");
    const small = await w.order([{ itemId: w.glue, quantity: 1, unitPriceCents: 500 }]);
    expect((await w.confirm(small.id)).status).toBe(200); // under the threshold
    const big = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    const held = await w.confirm(big.id);
    expect(held.status).toBe(202);
    expect(held.body).toMatchObject({ approvalRequired: true, approval: { kind: "sales_order", status: "pending", valueCents: 500000, subject: { type: "sales_order", id: big.id } } });
    expect((await w.so(big.id)).status).toBe("draft");
    expect(await w.item(w.kraft)).toMatchObject({ reserved: 0 });
    expect((await w.confirm(big.id)).body.approval.id).toBe(held.body.approval.id); // asking again doesn't ask twice
    const ok = await w.post(`/approvals/${held.body.approval.id}/approve`, {});
    expect(ok.status).toBe(200);
    expect((await w.so(big.id)).status).toBe("confirmed");
    expect(await w.item(w.kraft)).toMatchObject({ reserved: 10, available: 30 });
    // a second big order is rejected: it stays a draft
    const big2 = await w.order([{ itemId: w.kraft, quantity: 5 }]);
    const held2 = await w.confirm(big2.id);
    expect((await w.post(`/approvals/${held2.body.approval.id}/reject`, { note: "Credit check first" })).status).toBe(200);
    expect((await w.so(big2.id)).status).toBe("draft");
    // approved, but the stock is gone by then: the request fails and says why, nothing is reserved
    const big3 = await w.order([{ itemId: w.kraft, quantity: 20 }]);
    const held3 = await w.confirm(big3.id);
    await w.post(`/locations`, { name: "x" });
    await w.post(`/items/${w.kraft}/adjust`, { locationId: w.main, delta: -25, reason: "Damaged in the yard" });
    const failed = await w.post(`/approvals/${held3.body.approval.id}/approve`, {});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ status: "failed" });
    expect(failed.body.failure).toContain("Not enough available");
    expect((await w.so(big3.id)).status).toBe("draft");
  });
});

describe("shipping through the ledger", () => {
  it("ships in parts: stock leaves, the reservation shrinks, the order goes partial then shipped, and the ledger and audit say so", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }, { itemId: w.glue, quantity: 4 }]);
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 1, locationId: w.main }])).status).toBe(409); // not confirmed yet
    await w.confirm(o.id);
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 6, locationId: w.main }], "member", { carrier: "UPS", trackingNumber: "1Z1" })).status).toBe(201);
    let s = await w.so(o.id);
    expect(s.status).toBe("partial");
    expect(s.lines.find((l: any) => l.itemSku === "KRAFT")).toMatchObject({ shipped: 6, reserved: 4 });
    expect(s.shipments).toEqual([expect.objectContaining({ number: "SO-0001-1", carrier: "UPS", trackingNumber: "1Z1", reversed: false, notice: null })]);
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 34, reserved: 4, available: 30 });
    const res = await w.ship(o.id, [{ itemId: w.kraft, quantity: 4, locationId: w.main }, { itemId: w.glue, quantity: 4, locationId: w.main }]);
    expect(res.status).toBe(201);
    expect(res.body.shipmentNumber).toBe("SO-0001-2");
    s = await w.so(o.id);
    expect(s.status).toBe("shipped");
    expect(s.lines.every((l: any) => l.reserved === 0 && l.shipped === l.quantity)).toBe(true);
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 30, reserved: 0, available: 30 });
    const ledger = (await w.get("/movements?type=ship")).body.entries as { type: string; delta: number; reason: string }[];
    expect(ledger).toHaveLength(3);
    expect(ledger.every((e) => e.type === "ship" && e.delta < 0 && e.reason.startsWith("Shipped: SO-0001"))).toBe(true);
    const audit = (await w.get("/audit")).body.events as { action: string; summary: string }[];
    expect(audit.filter((e) => e.action === "sales_order.shipped").map((e) => e.summary)).toEqual([expect.stringContaining("SO-0001-2"), expect.stringContaining("SO-0001-1")]);
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 1, locationId: w.main }])).status).toBe(409); // already shipped in full
  });

  it("refuses over-shipping, shipping from a place without the stock, an item not on the order, a repeated line, and an unknown place", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    await w.confirm(o.id);
    const err = async (lines: object[]) => (await w.ship(o.id, lines)).status;
    expect(await err([{ itemId: w.kraft, quantity: 11, locationId: w.main }])).toBe(422);
    expect(await err([{ itemId: w.kraft, quantity: 1, locationId: w.shelf }])).toBe(422);
    expect(await err([{ itemId: w.glue, quantity: 1, locationId: w.main }])).toBe(409);
    expect(await err([{ itemId: w.kraft, quantity: 1, locationId: w.main }, { itemId: w.kraft, quantity: 1, locationId: w.main }])).toBe(409);
    expect(await err([{ itemId: w.kraft, quantity: 1, locationId: new ObjectId().toHexString() }])).toBe(404);
    expect(await err([{ itemId: w.kraft, locationId: w.main }])).toBe(422);
    expect(await err([{ itemId: w.kraft, quantity: 1 }])).toBe(422);
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 40 }); // nothing moved
    expect((await w.get("/movements?type=ship")).body.entries).toHaveLength(0);
  });

  it("refuses to ship from a quality hold area, and shipping a line the stock can't cover posts nothing for any line", async () => {
    const w = await world();
    await w.post("/quality/holds", { itemId: w.kraft, locationId: w.main, quantity: 5, reason: "Damaged" });
    const hold = ((await w.get("/locations")).body as { id: string; type: string }[]).find((l) => l.type === "quarantine")!;
    const o = await w.order([{ itemId: w.kraft, quantity: 5 }, { itemId: w.glue, quantity: 5 }]);
    await w.confirm(o.id);
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 5, locationId: hold.id }])).status).toBe(409);
    // Glue is fine, kraft asks for more than the place holds: all or nothing, nothing posted
    await w.post(`/items/${w.kraft}/adjust`, { locationId: w.main, delta: -33, reason: "test" });
    const mixed = await w.ship(o.id, [{ itemId: w.glue, quantity: 5, locationId: w.main }, { itemId: w.kraft, quantity: 5, locationId: w.main }]);
    expect(mixed.status).toBe(422);
    expect(await w.item(w.glue)).toMatchObject({ quantity: 20 });
    expect((await w.get("/movements?type=ship")).body.entries).toHaveLength(0);
  });

  it("two people shipping the same order at once can't ship the same stock twice", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    await w.confirm(o.id);
    const line = [{ itemId: w.kraft, quantity: 10, locationId: w.main }];
    const results = await Promise.all([w.ship(o.id, line), w.ship(o.id, line, "owner"), w.ship(o.id, line)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 30 });
    expect((await w.so(o.id)).status).toBe("shipped");
  });

  it("nothing is shipped, cancelled or closed in the moment a confirmation is still being checked against stock", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    await w.confirm(o.id);
    await store.salesOrders.updateOne({ _id: new ObjectId(o.id) }, { $set: { confirmingUntil: new Date(Date.now() + 60_000) } });
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 1, locationId: w.main }])).status).toBe(409);
    expect((await w.post(`/sales/orders/${o.id}/cancel`, {})).status).toBe(409);
    await store.salesOrders.updateOne({ _id: new ObjectId(o.id) }, { $set: { confirmingUntil: new Date(Date.now() - 1000) } }); // a stale guard doesn't block anything
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 1, locationId: w.main }])).status).toBe(201);
    const fresh = await store.salesOrders.findOne({ _id: new ObjectId(o.id) });
    expect(fresh?.confirmingUntil).toBeDefined(); // (set by the test; a real confirm always clears it)
  });

  it("undoing a shipment in Activity puts the stock back and the reservation returns with it", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    await w.confirm(o.id);
    await w.ship(o.id, [{ itemId: w.kraft, quantity: 10, locationId: w.main }]);
    expect((await w.so(o.id)).status).toBe("shipped");
    const entry = ((await w.get("/movements?type=ship")).body.entries as { id: string }[])[0]!;
    expect((await w.post(`/movements/${entry.id}/reverse`, { reason: "Wrong pallet" })).status).toBe(200);
    const s = await w.so(o.id);
    expect(s.status).toBe("confirmed");
    expect(s.lines[0]).toMatchObject({ shipped: 0, reserved: 10 });
    expect(s.shipments[0]).toMatchObject({ reversed: true });
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 40, reserved: 10, available: 30 });
    // and it can be shipped again
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 10, locationId: w.main }])).status).toBe(201);
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 30, reserved: 0 });
  });

  it("closing a part-shipped order releases the rest; cancelling one that has shipped is refused; a shipped order can't be closed", async () => {
    const w = await world();
    const o = await w.order([{ itemId: w.kraft, quantity: 10 }]);
    await w.confirm(o.id);
    expect((await w.post(`/sales/orders/${o.id}/close`, {})).status).toBe(409); // nothing has shipped: cancel instead
    await w.ship(o.id, [{ itemId: w.kraft, quantity: 4, locationId: w.main }]);
    expect((await w.post(`/sales/orders/${o.id}/cancel`, {})).status).toBe(409);
    expect((await w.post(`/sales/orders/${o.id}/close`, {}, "member")).status).toBe(403);
    const closed = await w.post(`/sales/orders/${o.id}/close`, {});
    expect(closed.body).toMatchObject({ status: "closed" });
    expect(closed.body.lines[0]).toMatchObject({ shipped: 4, reserved: 0 });
    expect(await w.item(w.kraft)).toMatchObject({ quantity: 36, reserved: 0, available: 36 });
    expect((await w.ship(o.id, [{ itemId: w.kraft, quantity: 1, locationId: w.main }])).status).toBe(409);
    const full = await w.order([{ itemId: w.glue, quantity: 2 }]);
    await w.confirm(full.id);
    await w.ship(full.id, [{ itemId: w.glue, quantity: 2, locationId: w.main }]);
    expect((await w.post(`/sales/orders/${full.id}/close`, {})).status).toBe(409);
  });

  it("lists what could fill each line, leaving out anything on hold", async () => {
    const w = await world();
    await w.post(`/items/${w.kraft}/transfer`, { fromLocationId: w.main, toLocationId: w.shelf, quantity: 15 });
    await w.post("/quality/holds", { itemId: w.kraft, locationId: w.main, quantity: 5, reason: "Damaged" });
    const o = await w.order([{ itemId: w.kraft, quantity: 20 }]);
    await w.confirm(o.id);
    const pick = (await w.get(`/sales/orders/${o.id}/pick`, "member")).body;
    expect(pick).toHaveLength(1);
    expect(pick[0]).toMatchObject({ itemSku: "KRAFT", remaining: 20, tracking: "quantity" });
    expect(pick[0].locations.map((l: any) => [l.locationName, l.quantity])).toEqual([["Main", 20], ["Shelf 2", 15]]);
  });
});

describe("rolls and pallets", () => {
  async function rollWorld() {
    const w = await world();
    const roll = (await w.post("/items", { sku: "ROLL", name: "Kraft roll (tracked)", unitCostCents: 100, tracking: "unit", unit: "kg", decimals: 0 })).body.id as string;
    const mk = async (quantity: number, lot: string) => ((await w.post("/units", { itemId: roll, locationId: w.main, quantity, lot })).body.units[0] as { id: string; code: string });
    return { ...w, roll, mk };
  }

  it("ships whole labelled units, which then can't be shipped or used again, and shows the lot's way out in the ledger", async () => {
    const w = await rollWorld();
    const a = await w.mk(800, "MILL-1");
    const b = await w.mk(800, "MILL-2");
    const c = await w.mk(500, "MILL-3");
    const o = await w.order([{ itemId: w.roll, quantity: 1600 }]);
    expect(await w.item(w.roll)).toMatchObject({ quantity: 2100, available: 2100 });
    await w.confirm(o.id);
    expect(await w.item(w.roll)).toMatchObject({ reserved: 1600, available: 500 });
    const pick = (await w.get(`/sales/orders/${o.id}/pick`)).body[0];
    expect(pick.units.map((u: any) => u.code)).toEqual([a.code, b.code, c.code]); // oldest first
    expect(pick.locations).toEqual([]);
    expect((await w.ship(o.id, [{ itemId: w.roll, quantity: 800, locationId: w.main }])).status).toBe(422); // units, not a quantity
    expect((await w.ship(o.id, [{ itemId: w.roll, unitIds: [a.id, c.id, b.id] }])).status).toBe(422); // 2100 is more than the 1600 left
    expect((await w.ship(o.id, [{ itemId: w.roll, unitIds: [a.id, a.id] }])).status).toBe(422);
    expect((await w.ship(o.id, [{ itemId: w.roll, unitIds: [new ObjectId().toHexString()] }])).status).toBe(404);
    expect((await w.ship(o.id, [{ itemId: w.roll, unitIds: [a.id, b.id] }])).status).toBe(201);
    expect(await w.item(w.roll)).toMatchObject({ quantity: 500, reserved: 0, available: 500 });
    const entries = (await w.get("/movements?type=ship")).body.entries as { unitCode?: string; delta: number }[];
    expect(entries.map((e) => [e.unitCode, e.delta]).sort()).toEqual([[a.code, -800], [b.code, -800]].sort());
    const again = await w.order([{ itemId: w.roll, quantity: 800 }]);
    await w.confirm(again.id, true);
    expect((await w.ship(again.id, [{ itemId: w.roll, unitIds: [a.id] }])).status).toBe(409); // already used up
    expect((await w.post(`/movements/${entries.length ? ((await w.get("/movements?type=ship")).body.entries[0].id as string) : ""}/reverse`, {})).status).toBe(409); // roll entries can't be undone, as everywhere else
  });

  it("won't ship a unit on quality hold, or one that belongs to another item", async () => {
    const w = await rollWorld();
    const a = await w.mk(800, "MILL-1");
    const b = await w.mk(800, "MILL-2");
    await w.post("/quality/holds", { unitId: a.id, reason: "Damaged" });
    expect(await w.item(w.roll)).toMatchObject({ quantity: 1600, available: 800 }); // the held roll is not for sale
    const o = await w.order([{ itemId: w.roll, quantity: 800 }]);
    expect((await w.confirm(o.id)).status).toBe(200);
    const held = await w.ship(o.id, [{ itemId: w.roll, unitIds: [a.id] }]);
    expect(held.status).toBe(409);
    expect(held.body.error).toMatch(/quality hold/);
    const pick = (await w.get(`/sales/orders/${o.id}/pick`)).body[0];
    expect(pick.units.map((u: any) => u.code)).toEqual([b.code]);
    const other = (await w.post("/items", { sku: "ROLL2", name: "Other roll", unitCostCents: 1, tracking: "unit" })).body.id;
    const u2 = ((await w.post("/units", { itemId: other, locationId: w.main, quantity: 800 })).body.units[0]) as { id: string };
    expect((await w.ship(o.id, [{ itemId: w.roll, unitIds: [u2.id] }])).status).toBe(404);
    expect((await w.ship(o.id, [{ itemId: w.roll, unitIds: [b.id] }])).status).toBe(201);
  });
});

describe("recall: where a shipped roll went", () => {
  it("the forward trace of a lot reaches the customer the roll or pallet was shipped to", async () => {
    const w = await world();
    const roll = (await w.post("/items", { sku: "PAL", name: "Pallet of boxes", unitCostCents: 100, tracking: "unit" })).body.id as string;
    const mk = async (lot: string) => ((await w.post("/units", { itemId: roll, locationId: w.main, quantity: 50, lot })).body.units[0] as { id: string; code: string });
    const a = await mk("RUN-7");
    const b = await mk("RUN-7");
    const o = await w.post("/sales/orders", { customerName: "Bluebird Packaging", customerRef: "BP-9", lines: [{ itemId: roll, quantity: 50, unitPriceCents: 900 }] });
    await w.confirm(o.body.id);
    await w.ship(o.body.id, [{ itemId: roll, unitIds: [a.id] }]);
    const trace = (await w.get("/traceability/trace?lot=RUN-7")).body;
    expect(trace.summary.customers).toEqual(["Bluebird Packaging"]);
    const unitA = trace.tree.flatMap((n: any) => [n, ...n.children]).find((n: any) => n.kind === "unit" && n.label.startsWith(a.code));
    expect(unitA.detail).toContain("shipped to Bluebird Packaging");
    expect(unitA.children).toEqual([expect.objectContaining({ kind: "shipment", label: "Shipped to Bluebird Packaging", detail: expect.stringContaining("their order BP-9") })]);
    const rows = trace.affected as { code: string; status: string; location: string }[];
    expect(rows.find((r) => r.code === a.code)).toMatchObject({ status: "shipped", location: "Shipped to Bluebird Packaging" });
    expect(rows.find((r) => r.code === b.code)).toMatchObject({ status: "available" }); // the other pallet is still here
  });
});

describe("reservation arithmetic holds under any sequence of actions", () => {
  it("keeps reserved, available and on hand consistent through random confirms, ships, undos, cancels and closes", async () => {
    const w = await world();
    let seed = 20261018;
    const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
    const items = [w.kraft, w.glue];
    const start: Record<string, number> = { [w.kraft]: 40, [w.glue]: 20 };
    const orders: string[] = [];
    for (let i = 0; i < 4; i++) {
      const lines = items.filter(() => rnd(3) > 0).map((itemId) => ({ itemId, quantity: 1 + rnd(25) }));
      if (!lines.length) lines.push({ itemId: w.kraft, quantity: 5 });
      orders.push((await w.order(lines)).id);
    }
    const check = async (step: string) => {
      const all = (await w.get("/sales/orders")).body as any[];
      const listed = (await w.get("/items")).body as any[];
      for (const id of items) {
        const it = listed.find((x) => x.id === id);
        let reserved = 0;
        let shipped = 0;
        for (const o of all) for (const l of o.lines.filter((l: any) => l.itemId === id)) {
          if (o.status === "confirmed" || o.status === "partial") reserved += l.quantity - l.shipped;
          expect(l.shipped, `${step}: ${o.number} shipped more than ordered`).toBeLessThanOrEqual(l.quantity);
          expect(l.reserved, `${step}: line reservation`).toBe(o.status === "confirmed" || o.status === "partial" || o.status === "shipped" ? (o.status === "shipped" ? 0 : l.quantity - l.shipped) : 0);
          shipped += l.shipped;
        }
        expect(it.reserved, `${step}: reserved`).toBe(reserved);
        expect(it.quantity, `${step}: on hand = start - shipped`).toBe(start[id]! - shipped);
        expect(it.available, `${step}: available`).toBe(it.quantity - reserved);
        expect(it.quantity, `${step}: never negative`).toBeGreaterThanOrEqual(0);
      }
    };
    await check("start");
    for (let step = 0; step < 70; step++) {
      const id = orders[rnd(orders.length)]!;
      const o = await w.so(id);
      const op = rnd(6);
      const label = `step ${step} op ${op} on ${o.number} (${o.status})`;
      if (op === 0) await w.confirm(id, rnd(3) === 0);
      else if (op === 1 || op === 2) {
        const open = o.lines.filter((l: any) => l.quantity - l.shipped > 0);
        if (open.length) {
          const l = open[rnd(open.length)];
          const left = l.quantity - l.shipped;
          await w.ship(id, [{ itemId: l.itemId, quantity: 1 + rnd(left), locationId: w.main }]);
        }
      } else if (op === 3) await w.post(`/sales/orders/${id}/cancel`, {});
      else if (op === 4) await w.post(`/sales/orders/${id}/close`, {});
      else {
        const live = ((await w.get("/movements?type=ship")).body.entries as { id: string; reversed: boolean }[]).filter((e) => !e.reversed);
        if (live.length) await w.post(`/movements/${live[rnd(live.length)]!.id}/reverse`, {});
      }
      await check(label);
    }
  });
});

describe("answering an order from a customer (Exchange)", () => {
  async function exchangeWorld(opts: { sellerStock?: number } = {}) {
    const buyer = await signUp({ mode: "create", name: "Northwind Boxes" }, "Bea");
    const seller = await signUp({ mode: "create", name: "Sunrise Paper" }, "Sol");
    const sellerMember = await signUp({ mode: "join", joinCode: seller.org.joinCode }, "Sam");
    const b = `/api/orgs/${buyer.org.id}`;
    const s = `/api/orgs/${seller.org.id}`;
    const connect = await call(buyer.cookie, `${b}/exchange/connect`, { invitation: (await call(seller.cookie, `${s}/exchange/invitation`)).body, kind: "supplier" });
    const mainB = (await call(buyer.cookie, `${b}/locations`)).body[0].id as string;
    const itemB = (await call(buyer.cookie, `${b}/items`, { sku: "LINER-42", name: "Kraft liner 42", unitCostCents: 48000, initialStock: { locationId: mainB, quantity: 2 } })).body.id as string;
    const supB = (await call(buyer.cookie, `${b}/purchasing/suppliers`, { name: "Sunrise Paper" })).body.id as string;
    const mainS = (await call(seller.cookie, `${s}/locations`)).body[0].id as string;
    const itemS = (await call(seller.cookie, `${s}/items`, { sku: "LINER-42", name: "Kraft liner 42 lb", unitCostCents: 30000, initialStock: { locationId: mainS, quantity: opts.sellerStock ?? 40 } })).body.id as string;
    const partnerAtBuyer = connect.body.partner.id as string;
    const placeOrder = async (lines: { quantity: number; itemId?: string }[]) => {
      const po = (await call(buyer.cookie, `${b}/purchasing/orders`, { supplierId: supB, expectedDate: "2026-12-01", note: "Dock 2", lines: lines.map((l) => ({ itemId: l.itemId ?? itemB, quantity: l.quantity, unitCostCents: 47000 })) })).body;
      await call(buyer.cookie, `${b}/purchasing/orders/${po.id}/place`, {});
      await call(buyer.cookie, `${b}/exchange/purchase-orders/${po.id}/send`, { partnerId: partnerAtBuyer });
      return po;
    };
    const incoming = async () => (await call(seller.cookie, `${s}/exchange/orders`)).body as any[];
    const respond = (mid: string, body: object = { status: "accepted", promisedDate: "2026-11-20" }, who = seller) => call(who.cookie, `${s}/exchange/orders/${mid}/respond`, body);
    const sellerItem = async () => (await call(seller.cookie, `${s}/items/${itemS}`)).body;
    const out = async (docType: string) => ((await call(seller.cookie, `${s}/b2b/messages?direction=out`)).body as any[]).filter((m) => m.docType === docType);
    return { buyer, seller, sellerMember, b, s, mainS, itemS, itemB, placeOrder, incoming, respond, sellerItem, out, partnerAtBuyer };
  }

  it("accepting makes a sales order that reserves the stock, once, and the answer goes out only after that", async () => {
    const x = await exchangeWorld();
    const po = await x.placeOrder([{ quantity: 10 }]);
    const [inc] = await x.incoming();
    expect(inc.salesOrder).toBeNull();
    const r = await x.respond(inc.messageId);
    expect(r.status).toBe(201);
    expect(r.body.salesOrder).toMatchObject({ number: "SO-0001" });
    const [after] = await x.incoming();
    expect(after.salesOrder).toMatchObject({ number: "SO-0001", state: "confirmed" });
    const sos = (await call(x.seller.cookie, `${x.s}/sales/orders`)).body;
    expect(sos).toHaveLength(1);
    expect(sos[0]).toMatchObject({ status: "confirmed", source: "exchange", customerRef: po.number, customer: { name: "Northwind Boxes" }, requestedDate: "2026-12-01", note: "Dock 2", totalCents: 470000, lines: [expect.objectContaining({ itemSku: "LINER-42", quantity: 10, unitPriceCents: 47000, reserved: 10 })] });
    expect(sos[0].customer.partnerId).toBeTruthy();
    expect(await x.sellerItem()).toMatchObject({ quantity: 40, reserved: 10, available: 30 });
    // answering again (or changing the date) is the same order, never a second reservation
    expect((await x.respond(inc.messageId, { status: "changed", promisedDate: "2026-11-25" })).status).toBe(201);
    expect((await call(x.seller.cookie, `${x.s}/sales/orders`)).body).toHaveLength(1);
    expect(await x.sellerItem()).toMatchObject({ reserved: 10 });
  });

  it("refuses to accept more than can be promised, says what is short, keeps the draft, and sends no answer; a back-order goes through when asked", async () => {
    const x = await exchangeWorld({ sellerStock: 8 });
    await x.placeOrder([{ quantity: 10 }]);
    const [inc] = await x.incoming();
    const r = await x.respond(inc.messageId);
    expect(r.status).toBe(409);
    expect(r.body.shortages).toEqual([expect.objectContaining({ itemSku: "LINER-42", needed: 10, available: 8 })]);
    expect(r.body.salesOrder).toMatchObject({ number: "SO-0001" });
    expect(await x.out("order_response")).toHaveLength(0);
    expect((await call(x.seller.cookie, `${x.s}/sales/orders`)).body[0]).toMatchObject({ status: "draft" });
    expect(await x.sellerItem()).toMatchObject({ reserved: 0 });
    const forced = await x.respond(inc.messageId, { status: "accepted", promisedDate: "2026-12-10", backorder: true });
    expect(forced.status).toBe(201);
    expect(await x.out("order_response")).toHaveLength(1);
    expect((await call(x.seller.cookie, `${x.s}/sales/orders`)).body).toHaveLength(1);
    expect(await x.sellerItem()).toMatchObject({ reserved: 10, available: -2 });
  });

  it("refuses an order it can't map exactly (unknown SKU, wrong unit, too many decimals) and makes nothing", async () => {
    const x = await exchangeWorld();
    await x.placeOrder([{ quantity: 3 }]);
    const [inc] = await x.incoming();
    // The buyer's item is called something we don't carry.
    await store.b2bMessages.updateOne({ _id: new ObjectId(inc.messageId) }, { $set: { "raw.body": (await store.b2bMessages.findOne({ _id: new ObjectId(inc.messageId) }))!.raw.body.replace(/"sku":"LINER-42"/g, '"sku":"NOPE-1"') } });
    const r = await x.respond(inc.messageId);
    expect(r.status).toBe(422);
    expect(r.body.error).toContain("we don't carry NOPE-1");
    expect((await call(x.seller.cookie, `${x.s}/sales/orders`)).body).toEqual([]);
    expect(await x.out("order_response")).toHaveLength(0);
    // wrong unit
    await store.b2bMessages.updateOne({ _id: new ObjectId(inc.messageId) }, { $set: { "raw.body": (await store.b2bMessages.findOne({ _id: new ObjectId(inc.messageId) }))!.raw.body.replace(/"sku":"NOPE-1"/g, '"sku":"LINER-42"').replace(/"unit":"ea"/g, '"unit":"kg"') } });
    expect((await x.respond(inc.messageId)).body.error).toContain("we count it in ea");
    // a rejection needs no stock and no mapping
    expect((await x.respond(inc.messageId, { status: "rejected", note: "Can't make that" })).status).toBe(201);
    expect((await call(x.seller.cookie, `${x.s}/sales/orders`)).body).toEqual([]);
  });

  it("rejecting an order we had accepted releases the stock; once part of it has shipped, the shipped part stays shipped", async () => {
    const x = await exchangeWorld();
    await x.placeOrder([{ quantity: 10 }]);
    const [inc] = await x.incoming();
    await x.respond(inc.messageId);
    expect(await x.sellerItem()).toMatchObject({ reserved: 10 });
    expect((await x.respond(inc.messageId, { status: "rejected", note: "Changed our mind" })).status).toBe(201);
    expect(await x.sellerItem()).toMatchObject({ reserved: 0, available: 40 });
    expect((await call(x.seller.cookie, `${x.s}/sales/orders`)).body[0]).toMatchObject({ status: "cancelled" });
    // a second order, part shipped, then rejected: it stays as it is
    await x.placeOrder([{ quantity: 6 }]);
    const inc2 = (await x.incoming()).find((i) => i.salesOrder === null)!;
    await x.respond(inc2.messageId);
    const so2 = (await x.incoming()).find((i) => i.messageId === inc2.messageId).salesOrder.id;
    await call(x.sellerMember.cookie, `${x.s}/sales/orders/${so2}/ship`, { lines: [{ itemId: x.itemS, quantity: 2, locationId: x.mainS }] });
    await x.respond(inc2.messageId, { status: "rejected", note: "Too late" });
    expect((await call(x.seller.cookie, `${x.s}/sales/orders/${so2}`)).body).toMatchObject({ status: "partial" });
  });

  it("ships from Sales: stock out through the ledger, and a ship notice for each shipment with what really went; a failed notice can be sent again", async () => {
    const x = await exchangeWorld();
    const po = await x.placeOrder([{ quantity: 10 }]);
    const [inc] = await x.incoming();
    await x.respond(inc.messageId);
    const so = (await x.incoming())[0].salesOrder.id as string;
    const first = await call(x.sellerMember.cookie, `${x.s}/sales/orders/${so}/ship`, { shippedDate: "2026-11-18", carrier: "UPS Freight", trackingNumber: "1Z999", lines: [{ itemId: x.itemS, quantity: 6, locationId: x.mainS }] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ shipmentNumber: "SO-0001-1", notice: "sent" });
    // Give the notice a moment: it was sent in-process, so the buyer already has it.
    const tl = (await call(x.buyer.cookie, `${x.b}/exchange/purchase-orders/${po.id}/timeline`)).body as any[];
    expect(tl.map((t) => `${t.direction}:${t.docType}`)).toEqual(["out:order", "in:order_response", "in:despatch_advice"]);
    expect(tl[2].summary).toMatchObject({ shipmentNumber: "SO-0001-1", shippedDate: "2026-11-18", carrier: "UPS Freight", tracking: "1Z999", lines: [{ sku: "LINER-42", quantity: 6 }] });
    // the rest ships later: a second notice, for the second part only
    const second = await call(x.sellerMember.cookie, `${x.s}/sales/orders/${so}/ship`, { lines: [{ itemId: x.itemS, quantity: 4, locationId: x.mainS }] });
    expect(second.body).toMatchObject({ shipmentNumber: "SO-0001-2", notice: "sent" });
    const notices = ((await call(x.buyer.cookie, `${x.b}/b2b/messages`)).body as any[]).filter((m) => m.docType === "despatch_advice").length;
    expect(notices).toBe(2);
    expect(await x.sellerItem()).toMatchObject({ quantity: 30, reserved: 0 });
    expect((await call(x.seller.cookie, `${x.s}/exchange/orders`)).body[0]).toMatchObject({ shipped: true, salesOrder: { number: "SO-0001" } });

    // A notice that can't be delivered doesn't undo the shipment, says so, and can be retried.
    const y = await exchangeWorld();
    await y.placeOrder([{ quantity: 5 }]);
    const [inc2] = await y.incoming();
    await y.respond(inc2.messageId);
    const so2 = (await y.incoming())[0].salesOrder.id as string;
    const partner = (await call(y.seller.cookie, `${y.s}/exchange/partners`)).body[0].id as string;
    await store.tradingPartners.updateOne({ _id: new ObjectId(partner) }, { $set: { enabled: false } });
    const lost = await call(y.sellerMember.cookie, `${y.s}/sales/orders/${so2}/ship`, { lines: [{ itemId: y.itemS, quantity: 5, locationId: y.mainS }] });
    expect(lost.status).toBe(201);
    expect(lost.body).toMatchObject({ notice: "failed", noticeError: expect.stringContaining("switched off") });
    expect((await y.sellerItem()).quantity).toBe(35);
    expect((await call(y.seller.cookie, `${y.s}/sales/orders/${so2}`)).body.shipments[0]).toMatchObject({ notice: "failed" });
    expect((await call(y.sellerMember.cookie, `${y.s}/sales/orders/${so2}/shipments/SO-0001-1/notice`, {})).status).toBe(403);
    expect((await call(y.seller.cookie, `${y.s}/sales/orders/${so2}/shipments/SO-0001-1/notice`, {})).status).toBe(409); // still switched off
    await store.tradingPartners.updateOne({ _id: new ObjectId(partner) }, { $set: { enabled: true } });
    const retried = await call(y.seller.cookie, `${y.s}/sales/orders/${so2}/shipments/SO-0001-1/notice`, {});
    expect(retried.status).toBe(200);
    expect(retried.body.shipments[0]).toMatchObject({ notice: "sent" });
    expect(((await call(y.buyer.cookie, `${y.b}/b2b/messages`)).body as any[]).filter((m) => m.docType === "despatch_advice")).toHaveLength(1);
  });

  it("a rule can hold the acceptance for approval: the customer hears nothing and nothing is reserved until it is approved", async () => {
    const x = await exchangeWorld();
    await call(x.seller.cookie, `${x.s}/approvals/rules`, { rules: [{ kind: "sales_order", thresholdCents: 100000, appliesTo: "everyone" }] }, "PUT");
    await x.placeOrder([{ quantity: 10 }]); // $4,700.00
    const [inc] = await x.incoming();
    const r = await x.respond(inc.messageId, { status: "accepted", promisedDate: "2026-11-22", note: "Ships Friday" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ approvalRequired: true, approval: { kind: "sales_order", status: "pending" }, salesOrder: { number: "SO-0001" } });
    expect(await x.out("order_response")).toHaveLength(0);
    expect(await x.sellerItem()).toMatchObject({ reserved: 0 });
    const again = await x.respond(inc.messageId, { status: "accepted", promisedDate: "2026-11-22", note: "Ships Friday" });
    expect(again.body.approval.id).toBe(r.body.approval.id);
    expect((await call(x.seller.cookie, `${x.s}/approvals/${r.body.approval.id}/approve`, {})).status).toBe(200);
    expect(await x.sellerItem()).toMatchObject({ reserved: 10 });
    const sent = await x.out("order_response");
    expect(sent).toHaveLength(1);
    expect((await call(x.seller.cookie, `${x.s}/exchange/orders`)).body[0]).toMatchObject({ response: { status: "accepted", promisedDate: "2026-11-22" }, salesOrder: { state: "confirmed" } });
    // refused by the approver: it stays a draft, no answer, nothing reserved
    await x.placeOrder([{ quantity: 5 }]);
    const inc2 = (await x.incoming()).find((i) => i.salesOrder === null)!;
    const held = await x.respond(inc2.messageId);
    await call(x.seller.cookie, `${x.s}/approvals/${held.body.approval.id}/reject`, { note: "Credit hold" });
    expect(await x.out("order_response")).toHaveLength(1);
    expect(await x.sellerItem()).toMatchObject({ reserved: 10 });
  });

  it("what a partner is told about stock is what can still be promised", async () => {
    const x = await exchangeWorld();
    const partnerAtSeller = (await call(x.seller.cookie, `${x.s}/exchange/partners`)).body[0].id as string;
    await call(x.seller.cookie, `${x.s}/exchange/partners/${partnerAtSeller}/permissions`, { shareStock: true, shareStockQuantities: true, shareOrderStatus: false }, "PATCH");
    const ask = async () => {
      const r = await call(x.buyer.cookie, `${x.b}/exchange/ask`, { partnerId: x.partnerAtBuyer, question: { kind: "stock", sku: "LINER-42" } });
      return ((await call(x.buyer.cookie, `${x.b}/exchange/answers`)).body as any[]).find((a) => a.messageId === r.body.messageId).answer;
    };
    expect((await ask()).stock).toMatchObject({ quantity: 40, availability: "in_stock" });
    await x.placeOrder([{ quantity: 25 }]);
    await x.respond((await x.incoming())[0].messageId);
    expect((await ask()).stock).toMatchObject({ quantity: 15 });
    await x.placeOrder([{ quantity: 15 }]);
    await x.respond((await x.incoming()).find((i) => i.salesOrder === null)!.messageId);
    expect((await ask()).stock).toMatchObject({ quantity: 0, availability: "out" });
  });

  it("with Sales switched off the Exchange behaves as before: answers and ship notices without stock", async () => {
    const x = await exchangeWorld();
    await call(x.seller.cookie, `${x.s}/modules`, { sales: false }, "PATCH");
    await x.placeOrder([{ quantity: 10 }]);
    const [inc] = await x.incoming();
    const r = await x.respond(inc.messageId);
    expect(r.status).toBe(201);
    expect(r.body.salesOrder).toBeUndefined();
    expect((await call(x.sellerMember.cookie, `${x.s}/exchange/orders/${inc.messageId}/ship`, { carrier: "UPS" })).status).toBe(201);
    expect(await x.sellerItem()).toMatchObject({ quantity: 40, reserved: 0 });
  });
});
