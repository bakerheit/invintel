import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Needs a running MongoDB (docker compose up -d). Each run uses its own throwaway database.
const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;

const call = (path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) =>
  app.request(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { ...(opts.body !== undefined && { "content-type": "application/json" }), ...(opts.cookie && { cookie: opts.cookie }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

let n = 0;
async function newOwner(orgName = "Acme") {
  const res = await call("/api/auth/register", {
    body: { name: "Ada", email: `units${++n}@example.com`, password: "correct horse", organization: { mode: "create", name: orgName } },
  });
  expect(res.status).toBe(201);
  const { organization } = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: organization as { id: string } };
}

beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});
beforeEach(async () => {
  await Promise.all(
    [store.users, store.sessions, store.orgs, store.memberships, store.locations, store.items, store.stock, store.movements, store.audit, store.units, store.counters].map(
      (c) => c.deleteMany({}),
    ),
  );
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});

describe("stock units (rolls and pallets)", () => {
  let owner: Awaited<ReturnType<typeof newOwner>>;
  let base: string;
  let main: { id: string };
  let shed: { id: string };
  let roll: { id: string };

  const post = (path: string, body: object) => call(`${base}${path}`, { body, cookie: owner.cookie });
  const get = async (path: string) => (await call(`${base}${path}`, { cookie: owner.cookie })).json();
  const receive = (body: object = {}) => post("/units", { itemId: roll.id, locationId: main.id, quantity: 800, ...body });
  const item = () => get(`/items/${roll.id}`);

  beforeEach(async () => {
    owner = await newOwner();
    base = `/api/orgs/${owner.org.id}`;
    main = (await get("/locations"))[0];
    shed = await (await post("/locations", { name: "Shed" })).json();
    roll = await (await post("/items", { sku: "KRAFT-42", name: "Kraft roll", tracking: "unit" })).json();
  });

  it("holds unit-tracked items only as units, and refuses quantity operations", async () => {
    expect(roll).toMatchObject({ tracking: "unit", quantity: 0 });
    const qty = { itemId: roll.id, locationId: main.id, quantity: 5 };
    expect((await post("/receipts", qty)).status).toBe(409);
    expect((await post("/moves", { itemId: roll.id, fromLocationId: main.id, toLocationId: shed.id, quantity: 1 })).status).toBe(409);
    expect((await post(`/items/${roll.id}/adjust`, { locationId: main.id, delta: 1 })).status).toBe(409);
    expect((await post("/items", { sku: "R2", name: "R2", tracking: "unit", initialStock: { locationId: main.id, quantity: 3 } })).status).toBe(400);
    // And the reverse: quantity items can't take units.
    const plain = await (await post("/items", { sku: "BOLT", name: "Bolt" })).json();
    expect((await post("/units", { itemId: plain.id, locationId: main.id, quantity: 5 })).status).toBe(409);
  });

  it("receives several units at once with generated labels, keeping totals, ledger and audit in step", async () => {
    const res = await receive({ count: 3, lot: "L-77", reference: "PO 5" });
    expect(res.status).toBe(201);
    const { units, movementIds } = await res.json();
    expect(units.map((u: { code: string }) => u.code)).toEqual(["U-000001", "U-000002", "U-000003"]);
    expect(units[0]).toMatchObject({ itemName: "Kraft roll", lot: "L-77", quantity: 800, initialQuantity: 800, status: "available", locationPath: "Main" });
    expect(movementIds).toHaveLength(3);

    const after = await item();
    expect(after.quantity).toBe(2400);
    expect(after.stock).toEqual([{ locationId: main.id, quantity: 2400 }]);

    const ledger = (await get("/movements")).entries;
    expect(ledger.slice(0, 3).map((e: { unitCode: string }) => e.unitCode).sort()).toEqual(["U-000001", "U-000002", "U-000003"]);

    const audit = await get("/audit");
    expect(audit.events[0]).toMatchObject({ action: "stock.received", summary: "Received 3 × 800 of Kraft roll at Main (PO 5)" });
    expect(await get("/audit/verify")).toMatchObject({ ok: true, ledgerGaps: 0 });

    // Numbers keep counting up and are never reused.
    const more = (await (await receive()).json()).units;
    expect(more[0].code).toBe("U-000004");
  });

  it("accepts pre-printed labels, and refuses duplicates or labels that collide with other codes", async () => {
    const ok = await receive({ count: 2, codes: ["PAL-A", "PAL-B"] });
    expect((await ok.json()).units.map((u: { code: string }) => u.code)).toEqual(["PAL-A", "PAL-B"]);
    expect((await receive({ codes: ["pal-a"] })).status).toBe(409); // already on a unit, ignoring case
    expect((await receive({ count: 2, codes: ["X1", "x1"] })).status).toBe(409); // twice in one request
    expect((await receive({ count: 2, codes: ["ONLY-ONE"] })).status).toBe(400); // wrong number of labels
    expect((await receive({ codes: ["KRAFT-42"] })).status).toBe(409); // equals an item's SKU
    // A later item can't take a SKU that's already a roll label.
    expect((await post("/items", { sku: "PAL-B", name: "Clash" })).status).toBe(409);
    expect((await post("/items", { sku: "OK-1", name: "Fine", barcodes: ["pal-a"] })).status).toBe(409);
  });

  it("finds a unit by scanning its label, ignoring case, only within its own org", async () => {
    const { units } = await (await receive({ codes: ["RL-9"] })).json();
    expect(await get("/lookup?code=rl-9")).toMatchObject({ kind: "unit", unit: { id: units[0].id, code: "RL-9", itemName: "Kraft roll", quantity: 800 } });
    const other = await newOwner("Other");
    const res = await call(`/api/orgs/${other.org.id}/lookup?code=RL-9`, { cookie: other.cookie });
    expect(await res.json()).toEqual({ kind: "none" });
  });

  it("moves a unit with whatever is left on it, and keeps location totals right", async () => {
    const { units } = await (await receive({ count: 2 })).json();
    await post(`/units/${units[0].id}/adjust`, { delta: -300, reason: "used" });
    const res = await post(`/units/${units[0].id}/move`, { toLocationId: shed.id });
    expect(res.status).toBe(200);
    const moved = (await res.json()).units[0];
    expect(moved).toMatchObject({ locationId: shed.id, locationPath: "Shed", quantity: 500 });

    const after = await item();
    expect(after.stock).toEqual(expect.arrayContaining([{ locationId: main.id, quantity: 800 }, { locationId: shed.id, quantity: 500 }]));
    expect(after.quantity).toBe(1300);

    const ledger = (await get(`/movements?type=transfer`)).entries;
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e: { unitCode: string }) => e.unitCode === units[0].code)).toBe(true);
    expect((await get("/audit/verify")).ok).toBe(true);
    expect((await post(`/units/${units[0].id}/move`, { toLocationId: shed.id })).status).toBe(409); // already there
  });

  it("lets only one of two simultaneous moves of the same unit through", async () => {
    const { units } = await (await receive()).json();
    const out = await Promise.all([post(`/units/${units[0].id}/move`, { toLocationId: shed.id }), post(`/units/${units[0].id}/move`, { toLocationId: shed.id })]);
    expect(out.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await item()).stock).toEqual([{ locationId: shed.id, quantity: 800 }]);
  });

  it("takes quantity off a unit, refuses to overdraw it, and retires it at zero", async () => {
    const { units } = await (await receive()).json();
    const id = units[0].id;
    const taken = (await (await post(`/units/${id}/adjust`, { delta: -300, reason: "loaded to corrugator" })).json()).units[0];
    expect(taken.quantity).toBe(500);
    expect((await item()).quantity).toBe(500);

    const over = await post(`/units/${id}/adjust`, { delta: -501 });
    expect(over.status).toBe(422);
    expect((await over.json()).error).toContain("Only 500 left");

    const last = (await (await post(`/units/${id}/adjust`, { delta: -500 })).json()).units[0];
    expect(last).toMatchObject({ quantity: 0, status: "consumed" });
    expect((await item()).quantity).toBe(0);
    expect((await post(`/units/${id}/adjust`, { delta: -1 })).status).toBe(409);
    expect((await post(`/units/${id}/move`, { toLocationId: shed.id })).status).toBe(409);
  });

  it("never lets simultaneous takers draw more than a unit holds", async () => {
    const { units } = await (await receive({ quantity: 500 })).json();
    const out = await Promise.all(Array.from({ length: 10 }, () => post(`/units/${units[0].id}/adjust`, { delta: -100 })));
    expect(out.filter((r) => r.status === 200)).toHaveLength(5);
    expect((await item()).quantity).toBe(0);
  });

  it("lists units with filters, descendants and paging", async () => {
    const aisle = await (await post("/locations", { name: "Aisle", parentId: shed.id })).json();
    await receive({ count: 2, lot: "A" });
    await post("/units", { itemId: roll.id, locationId: aisle.id, quantity: 100, lot: "B" });
    const all = await get("/units");
    expect(all.units).toHaveLength(3);
    expect((await get(`/units?locationId=${shed.id}`)).units).toHaveLength(1); // includes the aisle inside it
    expect((await get("/units?q=b")).units.map((u: { lot: string }) => u.lot)).toEqual(["B"]);
    const first = await get("/units?limit=2");
    const second = await get(`/units?limit=2&before=${first.nextBefore}`);
    expect([...first.units, ...second.units].map((u: { id: string }) => u.id).sort()).toEqual(all.units.map((u: { id: string }) => u.id).sort());
    expect((await get(`/units?ids=${all.units[0].id},${all.units[1].id}`)).units).toHaveLength(2);
    await post(`/units/${all.units[0].id}/adjust`, { delta: -all.units[0].quantity });
    expect((await get("/units?status=consumed")).units).toHaveLength(1);
  });

  it("lets other flows tag unit ledger lines with a type, a work order and one shared group", async () => {
    const { ObjectId } = await import("mongodb");
    const { adjustUnit, moveUnit } = await import("./units.js");
    const { units } = await (await receive()).json();
    const unitId = new ObjectId(units[0].id);
    const orgId = new ObjectId(owner.org.id);
    const actor = { userId: new ObjectId(), userName: "Production" };
    const workOrderId = new ObjectId();
    const group = new ObjectId();

    const moved = await moveUnit(store, orgId, actor, unitId, new ObjectId(shed.id), "load to corrugator", { workOrderId, transferId: group });
    const used = await adjustUnit(store, orgId, actor, unitId, -100, "run 1", { workOrderId, transferId: group, type: "adjust" });
    expect(moved.ok && used.ok).toBe(true);

    const lines = await store.movements.find({ workOrderId }).toArray();
    expect(lines).toHaveLength(3); // out, in, and the usage
    expect(new Set(lines.map((l) => l.transferId?.toHexString()))).toEqual(new Set([group.toHexString()]));
    expect(lines.every((l) => l.unitCode === units[0].code)).toBe(true);
    expect((await item()).stock).toEqual([{ locationId: shed.id, quantity: 700 }]);
  });

  it("won't reverse a unit's ledger entry, and won't switch tracking while stock exists", async () => {
    const { movementIds } = await (await receive()).json();
    const res = await call(`${base}/movements/${movementIds[0]}/reverse`, { body: {}, cookie: owner.cookie });
    expect(res.status).toBe(409);

    const patch = (body: object) => call(`${base}/items/${roll.id}`, { method: "PATCH", body, cookie: owner.cookie });
    expect((await patch({ tracking: "quantity" })).status).toBe(409);
    const empty = await (await post("/items", { sku: "E-1", name: "Empty" })).json();
    const ok = await call(`${base}/items/${empty.id}`, { method: "PATCH", body: { tracking: "unit" }, cookie: owner.cookie });
    expect((await ok.json()).tracking).toBe("unit");
  });
});
