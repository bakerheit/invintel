import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Multi-line floor documents: receive and move several items as one document, with one undo.
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

/** Appends the GS1 check digit. */
const withCheck = (body: string) => {
  let sum = 0;
  [...body].reverse().forEach((ch, i) => { sum += Number(ch) * (i % 2 === 0 ? 3 : 1); });
  return body + String((10 - (sum % 10)) % 10);
};
const SSCC = withCheck("00614141123456789");
const BAD_SSCC = SSCC.slice(0, 17) + String((Number(SSCC[17]) + 1) % 10);

let n = 0;
const send = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* not json */ }
  return { status: res.status, body: json };
};
const signUp = async (organization: object, name = "Ada") => {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `fb${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
};

async function world() {
  const owner = await signUp({ mode: "create", name: "Floor Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const other = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Cy");
  const base = `/api/orgs/${owner.org.id}`;
  const orgId = new ObjectId(owner.org.id);
  const as = (who: { cookie: string }) => ({
    post: (p: string, b: unknown) => send(who.cookie, `${base}${p}`, b),
    get: (p: string) => send(who.cookie, `${base}${p}`),
  });
  const o = as(owner), m = as(member);
  const main = (await o.get("/locations")).body[0].id as string;
  const dock = (await o.post("/locations", { name: "Dock" })).body.id as string;
  const rack = (await o.post("/locations", { name: "Rack A" })).body.id as string;
  const mk = async (sku: string, extra: object = {}) => (await o.post("/items", { sku, name: `${sku} item`, ...extra })).body.id as string;
  const qty = async (itemId: string, locationId: string) => (await store.stock.findOne({ orgId, itemId: new ObjectId(itemId), locationId: new ObjectId(locationId) }))?.quantity ?? 0;
  const movementsOf = (batchId: string) => store.movements.find({ orgId, batchId: new ObjectId(batchId) }).toArray();
  return { owner, member, other, o, m, c: as(other), base, orgId, main, dock, rack, mk, qty, movementsOf };
}

describe("receiving several items as one document", () => {
  it("posts every line into the one place, keeps lot, expiry and pallet number, and answers with one batch id", async () => {
    const w = await world();
    const [a, b] = [await w.mk("KRAFT"), await w.mk("MEDIUM")];
    const res = await w.m.post("/receipts/batch", {
      locationId: w.dock, reference: "PO-0007",
      lines: [{ itemId: a, quantity: 24, supplierLot: "LOT7", expiresOn: "2027-06-30", sscc: SSCC }, { itemId: b, quantity: 5 }, { itemId: a, quantity: 6, supplierLot: "LOT8" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.lines.map((l: any) => [l.itemName, l.quantity])).toEqual([["KRAFT item", 24], ["MEDIUM item", 5], ["KRAFT item", 6]]);
    expect(res.body.movementIds).toHaveLength(3);
    expect(await w.qty(a, w.dock)).toBe(30);
    expect(await w.qty(b, w.dock)).toBe(5);
    const rows = await w.movementsOf(res.body.batchId);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.supplierLot === "LOT7")).toMatchObject({ type: "receive", delta: 24, expiresOn: "2027-06-30", sscc: SSCC, reason: `Received: PO-0007 · pallet ${SSCC}` });
    expect(rows.find((r) => r.itemId.toHexString() === b)).toMatchObject({ reason: "Received: PO-0007" });
    expect(rows.find((r) => r.supplierLot === "LOT8")!.expiresOn).toBeUndefined();
    // the lot, expiry and pallet are on the activity feed and the audit log gets a line per receipt
    const act = (await w.o.get(`/movements?itemId=${a}`)).body.entries as any[];
    expect(act.find((e) => e.supplierLot === "LOT7")).toMatchObject({ expiresOn: "2027-06-30", delta: 24 });
    expect(await store.audit.countDocuments({ orgId: w.orgId, action: "stock.received" })).toBe(3);
  });

  it("checks everything before posting anything, and says which line is wrong", async () => {
    const w = await world();
    const a = await w.mk("KRAFT");
    const roll = await w.mk("ROLL", { tracking: "unit" });
    const post = (b: object) => w.m.post("/receipts/batch", b);
    const gone = new ObjectId().toHexString();
    let r = await post({ locationId: w.dock, lines: [{ itemId: a, quantity: 5 }, { itemId: gone, quantity: 1 }] });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/^Line 2 .*Nothing was received/);
    r = await post({ locationId: w.dock, lines: [{ itemId: a, quantity: 5 }, { itemId: roll, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^Line 2 \(ROLL item\): This item is tracked by unit.*Nothing was received/);
    expect((await post({ locationId: gone, lines: [{ itemId: a, quantity: 5 }] })).status).toBe(404);
    for (const bad of [
      { locationId: w.dock, lines: [] },
      { locationId: w.dock, lines: [{ itemId: a, quantity: 0 }] },
      { locationId: w.dock, lines: [{ itemId: a, quantity: 1.5 }] },
      { locationId: w.dock, lines: [{ itemId: a, quantity: 1, expiresOn: "2027-02-30" }] },
      { locationId: w.dock, lines: [{ itemId: a, quantity: 1, expiresOn: "next year" }] },
      { locationId: w.dock, lines: [{ itemId: a, quantity: 1, sscc: BAD_SSCC }] }, // wrong check digit
      { locationId: w.dock, lines: [{ itemId: a, quantity: 1, sscc: "12345" }] },
      { locationId: w.dock, lines: Array.from({ length: 101 }, () => ({ itemId: a, quantity: 1 })) },
      { lines: [{ itemId: a, quantity: 1 }] },
    ]) expect((await post(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    expect(await w.qty(a, w.dock)).toBe(0);
    expect(await store.movements.countDocuments({ orgId: w.orgId })).toBe(0);
    // nobody outside the organization
    const outsider = await signUp({ mode: "create", name: "Elsewhere" });
    expect((await send(outsider.cookie, `${w.base}/receipts/batch`, { locationId: w.dock, lines: [{ itemId: a, quantity: 1 }] })).status).toBe(404);
  });

  it("won't receive into the quality hold area", async () => {
    const w = await world();
    const a = await w.mk("KRAFT");
    await w.m.post("/receipts", { itemId: a, locationId: w.main, quantity: 4, inspect: true }); // makes the hold area
    const hold = (await store.locations.findOne({ orgId: w.orgId, type: "quarantine" }))!._id.toHexString();
    const r = await w.m.post("/receipts/batch", { locationId: hold, lines: [{ itemId: a, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/quality hold/i);
  });

  it("inspect before release puts every line on its own hold, with its lot, and the batch then can't be undone from here", async () => {
    const w = await world();
    const [a, b] = [await w.mk("KRAFT"), await w.mk("MEDIUM")];
    const r = await w.m.post("/receipts/batch", { locationId: w.dock, reference: "PO-9", inspect: true, lines: [{ itemId: a, quantity: 10, supplierLot: "LA" }, { itemId: b, quantity: 3, supplierLot: "LB" }] });
    expect(r.status).toBe(201);
    expect(r.body.ncrs).toHaveLength(2);
    expect(await w.qty(a, w.dock)).toBe(0); // all of it moved to the hold area
    const ncrs = await store.ncrs.find({ orgId: w.orgId }).toArray();
    expect(ncrs.map((x) => [x.quantity, x.supplierLot]).sort()).toEqual([[10, "LA"], [3, "LB"]]);
    const undo = await w.m.post(`/batches/${r.body.batchId}/undo`, {});
    expect(undo.status).toBe(409);
    expect(undo.body.error).toMatch(/quality hold/i);
  });

  it("when a line fails after the checks, the earlier lines are taken back and nothing is left", async () => {
    const w = await world();
    const [a, b] = [await w.mk("KRAFT"), await w.mk("MEDIUM")];
    // The database fails on the second line's stock write, after the first line was posted.
    const real = store.stock.findOneAndUpdate.bind(store.stock);
    let calls = 0;
    (store.stock as any).findOneAndUpdate = (...args: any[]) => { if (++calls === 2) throw new Error("disk went away"); return (real as any)(...args); };
    try {
      const r = await app.request(`${w.base}/receipts/batch`, { method: "POST", headers: { cookie: w.member.cookie, "content-type": "application/json" }, body: JSON.stringify({ locationId: w.dock, lines: [{ itemId: a, quantity: 5 }, { itemId: b, quantity: 2 }] }) });
      expect(r.status).toBe(500);
    } finally {
      (store.stock as any).findOneAndUpdate = real;
    }
    // The first line had been posted before the failure: it was taken back, so a retry starts clean.
    expect(await w.qty(a, w.dock)).toBe(0);
    expect(await w.qty(b, w.dock)).toBe(0);
    expect((await store.movements.find({ orgId: w.orgId, type: "receive" }).toArray()).every((x) => x.reversedBy)).toBe(true);
  });

  it("a member can undo their own batch within the window, all of it at once; another member can't; an admin can; twice is refused", async () => {
    const w = await world();
    const [a, b] = [await w.mk("KRAFT"), await w.mk("MEDIUM")];
    const r = await w.m.post("/receipts/batch", { locationId: w.dock, lines: [{ itemId: a, quantity: 10, supplierLot: "L1" }, { itemId: b, quantity: 4 }] });
    expect((await w.c.post(`/batches/${r.body.batchId}/undo`, {})).status).toBe(403); // someone else's entries
    const undo = await w.m.post(`/batches/${r.body.batchId}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.reversedIds).toHaveLength(2);
    expect(await w.qty(a, w.dock)).toBe(0);
    expect(await w.qty(b, w.dock)).toBe(0);
    expect((await w.m.post(`/batches/${r.body.batchId}/undo`, {})).status).toBe(409);
    expect(await store.audit.countDocuments({ orgId: w.orgId, action: "stock.reversed" })).toBe(1);
    // too late for a member, fine for an admin
    const r2 = await w.m.post("/receipts/batch", { locationId: w.dock, lines: [{ itemId: a, quantity: 3 }] });
    await store.movements.updateMany({ orgId: w.orgId, batchId: new ObjectId(r2.body.batchId) }, { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    expect((await w.m.post(`/batches/${r2.body.batchId}/undo`, {})).status).toBe(403);
    expect((await w.o.post(`/batches/${r2.body.batchId}/undo`, {})).status).toBe(200);
    expect((await w.o.post(`/batches/${new ObjectId().toHexString()}/undo`, {})).status).toBe(404);
  });

  it("undo is refused, with the reason, when the stock has since been used", async () => {
    const w = await world();
    const [a, b] = [await w.mk("KRAFT"), await w.mk("MEDIUM")];
    const r = await w.m.post("/receipts/batch", { locationId: w.dock, lines: [{ itemId: a, quantity: 10 }, { itemId: b, quantity: 4 }] });
    await w.m.post("/moves", { itemId: a, fromLocationId: w.dock, toLocationId: w.rack, quantity: 8 });
    const undo = await w.m.post(`/batches/${r.body.batchId}/undo`, {});
    expect(undo.status).toBe(422);
    expect(undo.body.error).toMatch(/not enough stock left at Dock/);
    // nothing was half-undone
    expect(await w.qty(b, w.dock)).toBe(4);
    expect((await store.movements.find({ orgId: w.orgId, batchId: new ObjectId(r.body.batchId) }).toArray()).every((x) => !x.reversedBy)).toBe(true);
  });
});

describe("moving several items to one place as one document", () => {
  it("moves each line from where it is to the one destination, as one batch", async () => {
    const w = await world();
    const [a, b] = [await w.mk("KRAFT", { initialStock: { locationId: w.main, quantity: 20 } }), await w.mk("MEDIUM", { initialStock: { locationId: w.dock, quantity: 9 } })];
    const r = await w.m.post("/moves/batch", { toLocationId: w.rack, reason: "Stage for line 2", lines: [{ itemId: a, fromLocationId: w.main, quantity: 5 }, { itemId: b, fromLocationId: w.dock, quantity: 9 }, { itemId: a, fromLocationId: w.main, quantity: 1 }] });
    expect(r.status).toBe(201);
    expect(r.body.movementIds).toHaveLength(6); // out and in for each
    expect(await w.qty(a, w.main)).toBe(14);
    expect(await w.qty(a, w.rack)).toBe(6);
    expect(await w.qty(b, w.dock)).toBe(0);
    expect(await w.qty(b, w.rack)).toBe(9);
    expect((await w.movementsOf(r.body.batchId)).every((x) => x.type === "transfer" && x.reason === "Stage for line 2")).toBe(true);
    // one undo puts all of it back
    const undo = await w.m.post(`/batches/${r.body.batchId}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.reversedIds).toHaveLength(6);
    expect(await w.qty(a, w.main)).toBe(20);
    expect(await w.qty(b, w.dock)).toBe(9);
    expect(await w.qty(a, w.rack)).toBe(0);
  });

  it("refuses the whole document before anything moves: too much in total, the same place, the hold area, a roll, a missing item", async () => {
    const w = await world();
    const a = await w.mk("KRAFT", { initialStock: { locationId: w.main, quantity: 10 } });
    const b = await w.mk("MEDIUM", { initialStock: { locationId: w.main, quantity: 10 } });
    const roll = await w.mk("ROLL", { tracking: "unit" });
    await w.m.post("/receipts", { itemId: b, locationId: w.main, quantity: 1, inspect: true });
    const hold = (await store.locations.findOne({ orgId: w.orgId, type: "quarantine" }))!._id.toHexString();
    const before = await store.movements.countDocuments({ orgId: w.orgId });
    const post = (b2: object) => w.m.post("/moves/batch", b2);
    // two lines that each fit but together don't
    let r = await post({ toLocationId: w.rack, lines: [{ itemId: a, fromLocationId: w.main, quantity: 6 }, { itemId: a, fromLocationId: w.main, quantity: 6 }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Only 10 of KRAFT item at .*this document takes 12.*Nothing was moved/);
    r = await post({ toLocationId: w.main, lines: [{ itemId: a, fromLocationId: w.main, quantity: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/already there/);
    r = await post({ toLocationId: hold, lines: [{ itemId: a, fromLocationId: w.main, quantity: 1 }] });
    expect(r.status).toBe(409);
    r = await post({ toLocationId: w.rack, lines: [{ itemId: a, fromLocationId: hold, quantity: 1 }] });
    expect(r.status).toBe(409);
    r = await post({ toLocationId: w.rack, lines: [{ itemId: roll, fromLocationId: w.main, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/ROLL item.*tracked by unit/);
    r = await post({ toLocationId: w.rack, lines: [{ itemId: new ObjectId().toHexString(), fromLocationId: w.main, quantity: 1 }] });
    expect(r.status).toBe(404);
    expect((await post({ toLocationId: w.rack, lines: [] })).status).toBe(400);
    expect((await post({ toLocationId: w.rack, lines: [{ itemId: a, fromLocationId: w.main, quantity: 0 }] })).status).toBe(400);
    expect((await post({ toLocationId: new ObjectId().toHexString(), lines: [{ itemId: a, fromLocationId: w.main, quantity: 1 }] })).status).toBe(404);
    expect(await store.movements.countDocuments({ orgId: w.orgId })).toBe(before);
    expect(await w.qty(a, w.main)).toBe(10);
  });
});

describe("receiving a purchase order's delivery", () => {
  it("lines carry the lot and expiry onto the receipt, and a bad date is refused", async () => {
    const w = await world();
    const a = await w.mk("KRAFT");
    const sup = (await w.o.post("/purchasing/suppliers", { name: "Mill" })).body.id;
    const po = (await w.o.post("/purchasing/orders", { supplierId: sup, lines: [{ itemId: a, quantity: 20, unitCostCents: 100 }] })).body;
    await w.o.post(`/purchasing/orders/${po.id}/place`, {});
    const bad = await w.m.post(`/purchasing/orders/${po.id}/receive`, { locationId: w.dock, lines: [{ itemId: a, quantity: 5, expiresOn: "2027-99-99" }] });
    expect(bad.status).toBe(400);
    const ok = await w.m.post(`/purchasing/orders/${po.id}/receive`, { locationId: w.dock, lines: [{ itemId: a, quantity: 12, supplierLot: "LOT-Z", expiresOn: "2027-03-31" }] });
    expect(ok.status).toBe(201);
    const row = await store.movements.findOne({ orgId: w.orgId, supplierLot: "LOT-Z" });
    expect(row).toMatchObject({ delta: 12, expiresOn: "2027-03-31", type: "receive" });
    expect(ok.body.order.lines[0].received).toBe(12);
    // the delivery is one document: one undo takes it back and the order goes back to what it was
    expect(ok.body.batchId).toMatch(/^[0-9a-f]{24}$/);
    expect((await w.m.post(`/batches/${ok.body.batchId}/undo`, {})).status).toBe(200);
    const after = (await w.o.get(`/purchasing/orders`)).body.find((x: any) => x.id === po.id);
    expect(after.lines[0].received).toBe(0);
    expect(after.status).toBe("ordered");
    expect(await w.qty(a, w.dock)).toBe(0);
  });
});

describe("a single receipt can carry an expiry too", () => {
  it("keeps it on the ledger line, and rejects a date that is not YYYY-MM-DD", async () => {
    const w = await world();
    const a = await w.mk("KRAFT");
    const r = await w.m.post("/receipts", { itemId: a, locationId: w.dock, quantity: 7, supplierLot: "TR-1", expiresOn: "2027-01-31" });
    expect(r.status).toBe(201);
    expect(await store.movements.findOne({ orgId: w.orgId, supplierLot: "TR-1" })).toMatchObject({ expiresOn: "2027-01-31" });
    expect((await w.m.post("/receipts", { itemId: a, locationId: w.dock, quantity: 1, expiresOn: "31/01/2027" })).status).toBe(400);
  });
});
