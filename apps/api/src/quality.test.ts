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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `q${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
};

async function shop() {
  const owner = await signUp({ mode: "create", name: "Plant" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const as = (who: "owner" | "member") => (who === "owner" ? owner : member).cookie;
  const get = (p: string, who: "owner" | "member" = "owner") => call(as(who), `${base}${p}`);
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call(as(who), `${base}${p}`, b, m);
  const main = (await get("/locations")).body[0].id as string;
  const shelf = (await post("/locations", { name: "Shelf B" })).body.id as string;
  const bolt = (await post("/items", { sku: "BOLT", name: "Bolt", initialStock: { locationId: main, quantity: 100 } })).body.id as string;
  const roll = (await post("/items", { sku: "ROLL", name: "Kraft roll", tracking: "unit" })).body.id as string;
  const stock = async (itemId: string, locationId: string) => ((await get(`/items/${itemId}`)).body.stock as { locationId: string; quantity: number }[]).find((s) => s.locationId === locationId)?.quantity ?? 0;
  const newUnit = async (quantity = 800, extra: object = {}) => (await post("/units", { itemId: roll, locationId: main, quantity, lot: "SUP-1", ...extra })).body.units[0] as { id: string; code: string };
  const holdArea = async () => (await store.locations.findOne({ orgId: new ObjectId(owner.org.id), type: "quarantine" }))?._id.toHexString() ?? "";
  return { owner, member, base, get, post, main, shelf, bolt, roll, stock, newUnit, holdArea };
}

describe("quality hold on plain stock", () => {
  it("moves the stock into the hold area, opens an NCR, and lets any member do it", async () => {
    const s = await shop();
    const res = await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 30, reason: "damaged", note: "Crushed pallet", supplierLot: "L-7" }, "member");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "NCR-0001", status: "open", quantity: 30, remaining: 30, reason: "Damaged", supplierLot: "L-7", fromLocationPath: "Main", heldAtPath: "Quality hold", heldBy: "Bob" });
    expect(await s.stock(s.bolt, s.main)).toBe(70);
    expect(await s.stock(s.bolt, await s.holdArea())).toBe(30);
    // the ledger has the pair, tagged with the NCR and the lot
    const lines = await store.movements.find({ ncrId: new ObjectId(res.body.id) }).toArray();
    expect(lines.map((l) => l.delta).sort((a, b) => a - b)).toEqual([-30, 30]);
    expect(lines.every((l) => l.supplierLot === "L-7")).toBe(true);
    expect((await store.audit.find({ action: "ncr.opened", orgId: new ObjectId(s.owner.org.id) }).toArray())).toHaveLength(1);
    expect((await s.get("/quality/summary")).body).toEqual({ open: 1, byReason: [{ reason: "Damaged", count: 1 }] });
  });

  it("refuses bad holds: more than is there, unknown reason, held stock again, unit-tracked items without a unit", async () => {
    const s = await shop();
    expect((await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 101, reason: "Damaged" })).status).toBe(422);
    expect((await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 5, reason: "Because" })).status).toBe(400);
    expect((await s.post("/quality/holds", { reason: "Damaged" })).status).toBe(400);
    expect((await s.post("/quality/holds", { itemId: s.roll, locationId: s.main, quantity: 5, reason: "Damaged" })).status).toBe(409);
    expect((await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 5, reason: "Damaged" })).status).toBe(201);
    expect((await s.post("/quality/holds", { itemId: s.bolt, locationId: await s.holdArea(), quantity: 1, reason: "Damaged" })).status).toBe(409);
    expect(await s.stock(s.bolt, s.main)).toBe(95);
  });

  it("keeps stock in the hold area out of ordinary moves, adjustments and Activity reversals", async () => {
    const s = await shop();
    const ncr = (await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 10, reason: "Damaged" })).body;
    const hold = await s.holdArea();
    expect((await s.post("/moves", { itemId: s.bolt, fromLocationId: hold, toLocationId: s.shelf, quantity: 1 })).status).toBe(409);
    expect((await s.post("/moves", { itemId: s.bolt, fromLocationId: s.main, toLocationId: hold, quantity: 1 })).status).toBe(409);
    expect((await s.post(`/items/${s.bolt}/adjust`, { locationId: hold, delta: -1 })).status).toBe(409);
    expect((await s.post("/receipts", { itemId: s.bolt, locationId: hold, quantity: 1 })).status).toBe(409);
    const line = (await store.movements.findOne({ ncrId: new ObjectId(ncr.id) }))!;
    expect((await s.post(`/movements/${line._id.toHexString()}/reverse`, {})).status).toBe(409);
    expect(await s.stock(s.bolt, hold)).toBe(10);
  });
});

describe("dispositions", () => {
  it("use and rework release stock to a place (default: where it came from), partly, closing when nothing is left", async () => {
    const s = await shop();
    const ncr = (await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 30, reason: "Failed inspection" })).body;
    const d = (b: object, who: "owner" | "member" = "owner") => s.post(`/quality/ncrs/${ncr.id}/dispose`, b, who);
    expect((await d({ type: "use" }, "member")).status).toBe(403);
    const first = await d({ type: "rework", quantity: 10, toLocationId: s.shelf, note: "Re-threaded" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "open", remaining: 20 });
    expect(first.body.dispositions[0]).toMatchObject({ type: "rework", quantity: 10, toLocationPath: "Shelf B", note: "Re-threaded", by: "Ada" });
    expect(await s.stock(s.bolt, s.shelf)).toBe(10);
    expect((await d({ type: "use", quantity: 21 })).status).toBe(422); // more than is left
    const last = await d({ type: "use" });
    expect(last.body).toMatchObject({ status: "closed", remaining: 0 });
    expect(await s.stock(s.bolt, s.main)).toBe(90); // 70 + 20 back
    expect(await s.stock(s.bolt, await s.holdArea())).toBe(0);
    expect((await d({ type: "use" })).status).toBe(409); // already closed
    expect((await s.post(`/quality/ncrs/${ncr.id}/dispose`, { type: "use", toLocationId: await s.holdArea() })).status).toBe(409);
  });

  it("scrap needs a reason from the scrap list and books a scrap line with that reason; return takes it out as an adjustment", async () => {
    const s = await shop();
    const a = (await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 20, reason: "Contaminated" })).body;
    const d = (id: string, b: object) => s.post(`/quality/ncrs/${id}/dispose`, b);
    expect((await d(a.id, { type: "scrap" })).status).toBe(400);
    expect((await d(a.id, { type: "scrap", reason: "Spite" })).status).toBe(400);
    const scrap = await d(a.id, { type: "scrap", quantity: 5, reason: "damaged" });
    expect(scrap.status).toBe(200);
    expect(scrap.body.dispositions[0]).toMatchObject({ type: "scrap", reason: "Damaged", quantity: 5 });
    const line = (await store.movements.findOne({ ncrId: new ObjectId(a.id), type: "scrap" }))!;
    expect(line).toMatchObject({ delta: -5, reasonCode: "Damaged" });
    const ret = await d(a.id, { type: "return", note: "RMA 55" });
    expect(ret.body).toMatchObject({ status: "closed" });
    expect(await s.stock(s.bolt, await s.holdArea())).toBe(0);
    expect(await s.stock(s.bolt, s.main)).toBe(80); // 100 - 20 held; nothing came back
    const types = (await store.movements.find({ ncrId: new ObjectId(a.id) }).toArray()).map((m) => m.type).sort();
    expect(types).toEqual(["adjust", "scrap", "transfer", "transfer"]);
    expect((await store.audit.find({ action: "ncr.dispositioned", orgId: new ObjectId(s.owner.org.id) }).toArray())).toHaveLength(2);
  });

  it("two people deciding the same hold at once can't take more than is on it", async () => {
    const s = await shop();
    const ncr = (await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 10, reason: "Damaged" })).body;
    const res = await Promise.all([1, 2, 3].map(() => s.post(`/quality/ncrs/${ncr.id}/dispose`, { type: "use", quantity: 6 })));
    expect(res.map((r) => r.status).filter((x) => x !== 200).every((x) => x === 409 || x === 422)).toBe(true);
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await s.stock(s.bolt, await s.holdArea())).toBe(4);
    expect(await s.stock(s.bolt, s.main)).toBe(96);
  });
});

describe("quality hold on labelled units", () => {
  it("holds a roll in place: it can't be used, moved or loaded until a decision", async () => {
    const s = await shop();
    const u = await s.newUnit(800);
    const ncr = (await s.post("/quality/holds", { unitId: u.id, reason: "Wrong spec" })).body;
    expect(ncr).toMatchObject({ unitCode: u.code, quantity: 800, remaining: 800, supplierLot: "SUP-1", heldAtPath: "Main" });
    expect((await s.get(`/units/${u.id}`)).body.status).toBe("quarantined");
    expect((await s.post(`/units/${u.id}/adjust`, { delta: -1 })).status).toBe(409);
    expect((await s.post(`/units/${u.id}/move`, { toLocationId: s.shelf })).status).toBe(409);
    expect((await s.post("/quality/holds", { unitId: u.id, reason: "Damaged" })).status).toBe(409); // already held
    // stock still counts it where it sits (it is physically there)
    expect(await s.stock(s.roll, s.main)).toBe(800);
  });

  it("release puts it back in use (optionally somewhere else); scrap and return use it up through the ledger", async () => {
    const s = await shop();
    const [a, b, c] = [await s.newUnit(100), await s.newUnit(200), await s.newUnit(300)];
    const hold = async (u: { id: string }) => (await s.post("/quality/holds", { unitId: u.id, reason: "Damaged" })).body;
    const [na, nb, nc] = [await hold(a), await hold(b), await hold(c)];
    const d = (n: { id: string }, body: object) => s.post(`/quality/ncrs/${n.id}/dispose`, body);

    expect((await d(na, { type: "use", toLocationId: s.shelf })).body).toMatchObject({ status: "closed" });
    expect((await s.get(`/units/${a.id}`)).body).toMatchObject({ status: "available", locationPath: "Shelf B", quantity: 100 });
    expect((await d(nb, { type: "scrap", reason: "Damaged" })).body.status).toBe("closed");
    expect((await s.get(`/units/${b.id}`)).body).toMatchObject({ status: "consumed", quantity: 0 });
    expect((await d(nc, { type: "return" })).body.status).toBe("closed");
    expect((await s.get(`/units/${c.id}`)).body.status).toBe("consumed");
    expect(await s.stock(s.roll, s.main)).toBe(0);
    expect(await s.stock(s.roll, s.shelf)).toBe(100);
    const scrapLine = (await store.movements.findOne({ ncrId: new ObjectId(nb.id), type: "scrap" }))!;
    expect(scrapLine).toMatchObject({ delta: -200, reasonCode: "Damaged", unitCode: b.code });
    // a unit is decided whole
    const e = await s.newUnit(50);
    const ne = await hold(e);
    expect((await d(ne, { type: "use", quantity: 10 })).status).toBe(422);
    // production refuses a held roll
    expect((await s.get(`/units/${e.id}`)).body.status).toBe("quarantined");
  });
});

describe("inspect before release at receiving", () => {
  it("floor receipts, purchase order receipts and unit receipts can go straight on hold", async () => {
    const s = await shop();
    // floor
    const floor = await s.post("/receipts", { itemId: s.bolt, locationId: s.main, quantity: 40, supplierLot: "FL-1", reference: "Delivery 5", inspect: true });
    expect(floor.status).toBe(201);
    expect(floor.body.ncrs).toHaveLength(1);
    expect(await s.stock(s.bolt, s.main)).toBe(100); // 100 + 40 received - 40 held
    expect(await s.stock(s.bolt, await s.holdArea())).toBe(40);
    // purchase order
    const supplier = (await s.post("/purchasing/suppliers", { name: "Acme Supply" })).body.id;
    const po = (await s.post("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: s.bolt, quantity: 25, unitCostCents: 5 }] })).body;
    await s.post(`/purchasing/orders/${po.id}/place`, {});
    const rec = await s.post(`/purchasing/orders/${po.id}/receive`, { locationId: s.main, inspect: true, lines: [{ itemId: s.bolt, quantity: 25, supplierLot: "PO-LOT" }] });
    expect(rec.status).toBe(201);
    expect(rec.body.ncrs).toHaveLength(1);
    expect(rec.body.order.receivedUnits).toBe(25); // it counts as received, and is on hold
    const poNcr = (await s.get(`/quality/ncrs/${rec.body.ncrs[0].id}`)).body;
    expect(poNcr).toMatchObject({ reason: "Awaiting inspection", source: "receiving", supplierLot: "PO-LOT", purchaseOrderNumber: po.number, quantity: 25 });
    // units
    const units = await s.post("/units", { itemId: s.roll, locationId: s.main, quantity: 500, count: 2, lot: "RL-3", inspect: true });
    expect(units.status).toBe(201);
    expect(units.body.ncrs).toHaveLength(2);
    expect(units.body.units.map((u: { status: string }) => u.status)).toEqual(["quarantined", "quarantined"]);
    // release one: "use as is" makes it available again
    expect((await s.post(`/quality/ncrs/${units.body.ncrs[0].id}/dispose`, { type: "use" })).body.status).toBe("closed");
    const open = (await s.get("/quality/ncrs?status=open")).body as { source: string }[];
    expect(open).toHaveLength(3); // floor, PO, and the roll not yet released
  });

  it("without the flag nothing is held", async () => {
    const s = await shop();
    const r = await s.post("/receipts", { itemId: s.bolt, locationId: s.main, quantity: 5 });
    expect(r.body.ncrs).toBeUndefined();
    expect((await s.get("/quality/summary")).body.open).toBe(0);
  });
});

describe("isolation and listing", () => {
  it("other organizations never see or touch a hold; the list filters by status", async () => {
    const s = await shop();
    const ncr = (await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 10, reason: "Damaged" })).body;
    const other = await signUp({ mode: "create", name: "Other" });
    const ob = `/api/orgs/${other.org.id}/quality`;
    expect((await call(other.cookie, `${ob}/ncrs/${ncr.id}`)).status).toBe(404);
    expect((await call(other.cookie, `${ob}/ncrs/${ncr.id}/dispose`, { type: "use" })).status).toBe(404);
    expect((await call(other.cookie, `${ob}/ncrs`)).body).toEqual([]);
    expect((await call(other.cookie, `/api/orgs/${s.owner.org.id}/quality/ncrs`)).status).toBe(404);
    await s.post(`/quality/ncrs/${ncr.id}/dispose`, { type: "use" });
    expect((await s.get("/quality/ncrs?status=open")).body).toHaveLength(0);
    expect((await s.get("/quality/ncrs?status=closed")).body).toHaveLength(1);
    expect((await s.get("/quality/ncrs?status=bogus")).status).toBe(400);
  });
});

describe("held stock and production", () => {
  it("a held roll can't be loaded onto a machine, and plain stock in the hold area can't be loaded either", async () => {
    const s = await shop();
    const mach = (await s.post("/locations", { name: "Press", type: "production" })).body.id as string;
    const box = (await s.post("/items", { sku: "BOX", name: "Box" })).body.id as string;
    const wc = (await s.post("/production/work-centers", { name: "Press 1", locationId: mach })).body.id as string;
    await s.post("/production/boms", { outputItemId: box, inputs: [{ itemId: s.roll, quantity: 1 }, { itemId: s.bolt, quantity: 1 }] });
    const wo = (await s.post("/production/work-orders", { outputItemId: box, quantity: 10, workCenterId: wc })).body;
    await s.post(`/production/work-orders/${wo.id}/action`, { action: "release" });
    const load = (b: object) => s.post(`/production/work-orders/${wo.id}/load`, b);

    const u = await s.newUnit(500);
    expect((await s.post("/quality/holds", { unitId: u.id, reason: "Damaged" })).status).toBe(201);
    const held = await load({ itemId: s.roll, unitId: u.id });
    expect(held.status).toBe(409);
    expect(held.body.error).toMatch(/hold|quarantine/i);
    expect((await s.get(`/units/${u.id}`)).body).toMatchObject({ status: "quarantined", locationPath: "Main" });

    await s.post("/quality/holds", { itemId: s.bolt, locationId: s.main, quantity: 20, reason: "Damaged" });
    const fromHold = await load({ itemId: s.bolt, fromLocationId: await s.holdArea(), quantity: 5 });
    expect(fromHold.status).toBe(422);
    expect(await s.stock(s.bolt, await s.holdArea())).toBe(20);
    expect(await s.stock(s.bolt, mach)).toBe(0);
    // released stock can be loaded again
    const ncr = (await s.get("/quality/ncrs?status=open")).body.find((n: { unitCode: string | null }) => n.unitCode);
    expect((await s.post(`/quality/ncrs/${ncr.id}/dispose`, { type: "use" })).status).toBe(200);
    expect((await load({ itemId: s.roll, unitId: u.id })).status).toBe(201);
  });
});
