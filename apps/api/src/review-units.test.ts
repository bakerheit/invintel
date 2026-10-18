import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Adversarial tests for stock units (rolls and pallets): over-taking, races, deletes, reversal, label clashes.
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
async function signUp(organization: object) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: `u${++n}@example.com`, password: "correct horse", organization }),
  });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

async function shop() {
  const o = await signUp({ mode: "create", name: "Rolls Co" });
  const base = `/api/orgs/${o.org.id}`;
  const get = (p: string) => call(o.cookie, `${base}${p}`);
  const post = (p: string, b: unknown, m?: string) => call(o.cookie, `${base}${p}`, b, m);
  const main = (await get("/locations")).body[0].id as string;
  const shed = (await post("/locations", { name: "Shed" })).body.id as string;
  const roll = (await post("/items", { sku: "ROLL", name: "Kraft roll", tracking: "unit" })).body.id as string;
  const receive = async (quantity = 800, extra: object = {}) => (await post("/units", { itemId: roll, locationId: main, quantity, ...extra })).body.units[0] as { id: string; code: string };
  /** The invariant: for a unit-tracked item the stock rows equal the remaining quantity of live units, per location. */
  const invariant = async (itemId = roll) => {
    const units = await store.units.find({ itemId: new (await import("mongodb")).ObjectId(itemId), status: { $ne: "consumed" } }).toArray();
    const want = new Map<string, number>();
    for (const u of units) want.set(u.locationId.toHexString(), (want.get(u.locationId.toHexString()) ?? 0) + u.quantity);
    const rows = await store.stock.find({ itemId: new (await import("mongodb")).ObjectId(itemId) }).toArray();
    const have = new Map(rows.filter((r) => r.quantity !== 0).map((r) => [r.locationId.toHexString(), r.quantity]));
    return { want: Object.fromEntries(want), have: Object.fromEntries(have) };
  };
  return { o, base, get, post, main, shed, roll, receive, invariant };
}

describe("taking from units", () => {
  it("refuses over-taking, zero, fractions and other organizations' units", async () => {
    const s = await shop();
    const u = await s.receive(800);
    expect((await s.post(`/units/${u.id}/adjust`, { delta: -801 })).status).toBe(422);
    expect((await s.post(`/units/${u.id}/adjust`, { delta: 0 })).status).toBe(400);
    expect((await s.post(`/units/${u.id}/adjust`, { delta: -1.5 })).status).toBe(400);
    expect((await s.post("/units", { itemId: s.roll, locationId: s.main, quantity: -5 })).status).toBe(400);
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/units/${u.id}/adjust`, { delta: -1 })).status).toBe(404);
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/units/${u.id}`)).status).toBe(404);
    expect((await s.post(`/units/${u.id}/move`, { toLocationId: "0".repeat(24) })).status).toBe(404);
    expect(await s.invariant()).toEqual({ want: { [s.main]: 800 }, have: { [s.main]: 800 } });
  });

  it("two people taking the same roll at once can't take more than is on it", async () => {
    const s = await shop();
    const u = await s.receive(800);
    const results = await Promise.all([-500, -500, -500].map((delta) => s.post(`/units/${u.id}/adjust`, { delta })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422]);
    expect((await s.get(`/units/${u.id}`)).body.quantity).toBe(300);
    expect(await s.invariant()).toEqual({ want: { [s.main]: 300 }, have: { [s.main]: 300 } });
  });

  it("taking the last of a roll flips it to consumed exactly once, even when racing", async () => {
    const s = await shop();
    const u = await s.receive(100);
    const results = await Promise.all([s.post(`/units/${u.id}/adjust`, { delta: -100 }), s.post(`/units/${u.id}/adjust`, { delta: -100 })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]); // the loser sees "Only 0 left"
    expect((await s.get(`/units/${u.id}`)).body).toMatchObject({ quantity: 0, status: "consumed" });
    expect(await s.invariant()).toEqual({ want: {}, have: {} });
  });

  it("stock stays equal to the units while a roll is being used and moved at the same time", async () => {
    const s = await shop();
    for (let round = 0; round < 15; round++) {
      const u = await s.receive(100);
      await Promise.all([s.post(`/units/${u.id}/adjust`, { delta: -1 }), s.post(`/units/${u.id}/move`, { toLocationId: s.shed })]);
      const inv = await s.invariant();
      expect(inv.have, `round ${round}`).toEqual(inv.want);
      await s.post(`/units/${u.id}/adjust`, { delta: -99 }); // clear the board for the next round
    }
  });
});

describe("deleting things that hold units", () => {
  it("won't delete an item while it still has rolls (they would be orphaned and still count as stock)", async () => {
    const s = await shop();
    await s.receive(800);
    const del = await call(s.o.cookie, `${s.base}/items/${s.roll}`, undefined, "DELETE");
    expect(del.status).toBe(409);
    expect((await s.get("/units")).body.units).toHaveLength(1);
    expect(await s.invariant()).toEqual({ want: { [s.main]: 800 }, have: { [s.main]: 800 } });
  });

  it("deletes fine once every roll is used up", async () => {
    const s = await shop();
    const u = await s.receive(10);
    await s.post(`/units/${u.id}/adjust`, { delta: -10 });
    expect((await call(s.o.cookie, `${s.base}/items/${s.roll}`, undefined, "DELETE")).status).toBeLessThan(300);
  });

  it("won't delete a location that holds a roll", async () => {
    const s = await shop();
    const u = await s.receive(50);
    await s.post(`/units/${u.id}/move`, { toLocationId: s.shed });
    const del = await call(s.o.cookie, `${s.base}/locations/${s.shed}`, undefined, "DELETE");
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect((await s.get(`/units/${u.id}`)).body.locationPath).toBe("Shed");
  });
});

describe("reversal and labels", () => {
  it("Activity refuses to reverse unit movements cleanly (409, not a 500), whatever their type", async () => {
    const s = await shop();
    const u = await s.receive(100);
    await s.post(`/units/${u.id}/adjust`, { delta: -10 });
    await s.post(`/units/${u.id}/move`, { toLocationId: s.shed });
    const page = (await s.get("/movements?limit=50")).body.entries as { id: string }[];
    expect(page.length).toBeGreaterThanOrEqual(4);
    for (const e of page) expect([409, 403]).toContain((await s.post(`/movements/${e.id}/reverse`, {})).status);
    expect(await s.invariant()).toEqual({ want: { [s.shed]: 90 }, have: { [s.shed]: 90 } });
  });

  it("a label can't equal an item's SKU or barcode, in either direction, ignoring case", async () => {
    const s = await shop();
    const u = await s.receive(100, { codes: ["PAL-0001"] });
    expect(u.code).toBe("PAL-0001");
    expect((await s.post("/items", { sku: "pal-0001", name: "Clash by SKU" })).status).toBe(409);
    expect((await s.post("/items", { sku: "OK-1", name: "Clash by barcode", barcodes: ["Pal-0001"] })).status).toBe(409);
    const plain = (await s.post("/items", { sku: "BOLT", name: "Bolt", barcodes: ["9999"] })).body.id;
    expect((await s.post("/units", { itemId: s.roll, locationId: s.main, quantity: 5, codes: ["bolt"] })).status).toBe(409);
    expect((await s.post("/units", { itemId: s.roll, locationId: s.main, quantity: 5, codes: ["9999"] })).status).toBe(409);
    // changing an existing item's SKU or barcode to a label is refused too
    expect((await s.post(`/items/${plain}`, { sku: "PAL-0001" }, "PATCH")).status).toBe(409);
    expect((await s.post(`/items/${plain}`, { barcodes: ["pal-0001"] }, "PATCH")).status).toBe(409);
  });

  it("scanning a label finds the unit, ignoring case and surrounding spaces", async () => {
    const s = await shop();
    const u = await s.receive(100, { codes: ["Roll-77"] });
    for (const code of ["Roll-77", "roll-77", " ROLL-77 "]) {
      const r = (await s.get(`/lookup?code=${encodeURIComponent(code)}`)).body;
      expect(r.kind, code).toBe("unit");
      expect(r.unit.id).toBe(u.id);
    }
  });
});
