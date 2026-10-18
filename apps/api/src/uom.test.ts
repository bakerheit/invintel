import { randomBytes } from "node:crypto";
import { convertQty, formatQty, itemInputSchema, lineValueCents, parseQty, qtyErrorMessage, toStored, uomOf } from "@invintel/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

describe("formatQty", () => {
  it("prints whole-number items exactly as before", () => {
    expect(formatQty(0)).toBe("0");
    expect(formatQty(1200)).toBe("1,200");
    expect(formatQty(-5)).toBe("-5");
    expect(formatQty(1200, { unit: "ea", decimals: 0 })).toBe("1,200");
  });

  it("puts the point where the item says", () => {
    const kg = { unit: "kg", decimals: 3 };
    expect(formatQty(12500, kg)).toBe("12.500 kg");
    expect(formatQty(5, kg)).toBe("0.005 kg");
    expect(formatQty(1234567, kg)).toBe("1,234.567 kg");
    expect(formatQty(0, kg)).toBe("0.000 kg");
    expect(formatQty(-250, kg)).toBe("-0.250 kg");
  });

  it("can trim zeros, hide the unit, show a sign", () => {
    const kg = { unit: "kg", decimals: 3 };
    expect(formatQty(12500, kg, { trim: true })).toBe("12.5 kg");
    expect(formatQty(12000, kg, { trim: true })).toBe("12 kg");
    expect(formatQty(12500, kg, { unit: false })).toBe("12.500");
    expect(formatQty(12, { unit: "ea", decimals: 0 }, { unit: true })).toBe("12 ea");
    expect(formatQty(40, kg, { sign: true })).toBe("+0.040 kg");
    expect(formatQty(1234567, kg, { group: false })).toBe("1234.567 kg");
  });

  it("doesn't break on bad input", () => {
    expect(formatQty(Number.NaN)).toBe("–");
    expect(formatQty(5, { unit: "kg", decimals: 99 })).toBe("5 kg");
  });
});

describe("parseQty", () => {
  it("reads what people type", () => {
    expect(toStored("12", 0)).toBe(12);
    expect(toStored("12.5", 3)).toBe(12500);
    expect(toStored(".5", 2)).toBe(50);
    expect(toStored("0.005", 3)).toBe(5);
    expect(toStored("1,250.5", 3)).toBe(1250500);
    expect(toStored(" 7 ", 1)).toBe(70);
  });

  it("round trips with the formatter", () => {
    for (const [stored, decimals] of [[0, 0], [7, 3], [123456789, 4], [1000, 2]] as const) {
      const text = formatQty(stored, { unit: "kg", decimals }, { unit: false });
      expect(toStored(text, decimals)).toBe(stored);
    }
  });

  it("treats trailing zeros as no extra precision", () => {
    expect(toStored("1.500", 1)).toBe(15);
    expect(toStored("3.0", 0)).toBe(3);
  });

  it("refuses to round", () => {
    expect(parseQty("1.5", 0)).toEqual({ ok: false, reason: "precision" });
    expect(parseQty("1.2345", 3)).toEqual({ ok: false, reason: "precision" });
  });

  it("refuses nonsense", () => {
    for (const bad of ["", "  ", "abc", "1.2.3", "5.", "1,2", "12,34", "1e3", "$5", "--3", "."]) {
      expect(parseQty(bad, 2).ok, bad).toBe(false);
    }
    expect(parseQty("", 0)).toEqual({ ok: false, reason: "empty" });
  });

  it("only takes a minus when asked", () => {
    expect(parseQty("-3", 0)).toEqual({ ok: false, reason: "negative" });
    expect(parseQty("-3", 0, { signed: true })).toEqual({ ok: true, stored: -3 });
    expect(parseQty("-0.5", 1, { signed: true })).toEqual({ ok: true, stored: -5 });
    expect(Object.is(toStored("-0", 0, { signed: true }), -0)).toBe(false);
  });

  it("refuses numbers too big to store exactly", () => {
    expect(parseQty("9007199254740993", 0)).toEqual({ ok: false, reason: "range" });
    expect(parseQty("90071992547409.93", 2)).toEqual({ ok: false, reason: "range" });
    expect(toStored("9007199254740991", 0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("has a message for every failure", () => {
    expect(qtyErrorMessage("precision", { unit: "kg", decimals: 3 })).toBe("kg goes to 3 decimal places");
    expect(qtyErrorMessage("precision", { unit: "ea", decimals: 0 })).toBe("ea only counts whole numbers");
    expect(qtyErrorMessage("precision", { unit: "L", decimals: 1 })).toBe("L goes to 1 decimal place");
    for (const r of ["empty", "format", "negative", "range"] as const) expect(qtyErrorMessage(r).length).toBeGreaterThan(3);
  });
});

describe("convertQty", () => {
  it("converts exactly", () => {
    expect(convertQty("2", "12", 0)).toEqual({ ok: true, stored: 24 });
    expect(convertQty("0.5", "12", 0)).toEqual({ ok: true, stored: 6 });
    expect(convertQty("10", "0.4536", 3)).toEqual({ ok: true, stored: 4536 });
    expect(convertQty("1", "0.4536", 4)).toEqual({ ok: true, stored: 4536 });
  });

  it("refuses an answer that isn't a whole number of stored units", () => {
    expect(convertQty("2.5", "5", 0)).toEqual({ ok: false, reason: "precision" });
    expect(convertQty("1", "0.4536", 3)).toEqual({ ok: false, reason: "precision" });
  });

  it("refuses bad factors and quantities", () => {
    expect(convertQty("2", "0", 0).ok).toBe(false);
    expect(convertQty("2", "abc", 0).ok).toBe(false);
    expect(convertQty("x", "12", 0).ok).toBe(false);
    expect(convertQty("-2", "12", 0)).toEqual({ ok: false, reason: "negative" });
    expect(convertQty("-2", "12", 0, { signed: true })).toEqual({ ok: true, stored: -24 });
  });
});

describe("lineValueCents", () => {
  it("scales a stored count back to display units", () => {
    expect(lineValueCents(5, 250, 0)).toBe(1250);
    expect(lineValueCents(12500, 120, 3)).toBe(1500); // 12.5 kg at $1.20/kg = $15.00
    expect(lineValueCents(1, 120, 3)).toBe(0); // 0.001 kg = 0.12 cents -> rounds to 0
    expect(lineValueCents(5, 120, 3)).toBe(1); // 0.6 cents -> 1
    expect(lineValueCents(-12500, 120, 3)).toBe(-1500);
    expect(lineValueCents(-5, 120, 3)).toBe(-1); // half away from zero
    expect(lineValueCents(0, 999, 2)).toBe(0);
  });

  it("is exact where floats would not be", () => {
    expect(lineValueCents(9_007_199_254, 1_000_000, 0)).toBe(9_007_199_254_000_000);
  });
});

describe("uomOf", () => {
  it("defaults old items to each / 0 decimals", () => {
    expect(uomOf({})).toEqual({ unit: "ea", decimals: 0 });
    expect(uomOf(null)).toEqual({ unit: "ea", decimals: 0 });
    expect(uomOf({ unit: " kg ", decimals: 3 })).toEqual({ unit: "kg", decimals: 3 });
    expect(uomOf({ unit: "kg", decimals: 9 })).toEqual({ unit: "kg", decimals: 0 });
    expect(uomOf({ unit: "kg", decimals: 1.5 })).toEqual({ unit: "kg", decimals: 0 });
  });
});

describe("item schema", () => {
  const base = { sku: "A", name: "A" };
  it("defaults to each", () => {
    expect(itemInputSchema.parse(base)).toMatchObject({ unit: "ea", decimals: 0, altUnits: [] });
  });
  it("rejects bad units", () => {
    expect(itemInputSchema.safeParse({ ...base, decimals: 5 }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, decimals: -1 }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, decimals: 1.5 }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, unit: "  " }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, unit: "x".repeat(17) }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, altUnits: [{ name: "cs", factor: "0" }] }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, altUnits: [{ name: "cs", factor: "1.1234567" }] }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, altUnits: [{ name: "cs", factor: "-2" }] }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...base, altUnits: [{ name: "cs", factor: "12" }, { name: "CS", factor: "6" }] }).success).toBe(false);
  });
  it("accepts a case of 12", () => {
    expect(itemInputSchema.safeParse({ ...base, unit: "ea", altUnits: [{ name: "case", factor: "12" }] }).success).toBe(true);
  });
});

// ---------------- through the API ----------------

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
let n = 0;

const call = (path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) =>
  app.request(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { ...(opts.body !== undefined && { "content-type": "application/json" }), ...(opts.cookie && { cookie: opts.cookie }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});
beforeEach(async () => {
  await Promise.all(
    [store.users, store.sessions, store.orgs, store.memberships, store.locations, store.items, store.stock, store.movements, store.audit, store.units, store.counters, store.purchaseOrders, store.suppliers].map((c) => c.deleteMany({})),
  );
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});

describe("units of measure through the API", () => {
  let cookie: string;
  let base: string;
  let loc: { id: string };

  const post = (path: string, body: object) => call(`${base}${path}`, { body, cookie });
  const patch = (path: string, body: object) => call(`${base}${path}`, { method: "PATCH", body, cookie });
  const get = async (path: string) => (await call(`${base}${path}`, { cookie })).json();

  beforeEach(async () => {
    const res = await call("/api/auth/register", {
      body: { name: "Ada", email: `uom${++n}@example.com`, password: "correct horse", organization: { mode: "create", name: "Acme" } },
    });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    base = `/api/orgs/${(await res.json()).organization.id}`;
    loc = (await get("/locations"))[0];
  });

  it("old-style items come back as each / 0 decimals", async () => {
    const res = await post("/items", { sku: "BOLT", name: "Bolt" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ unit: "ea", decimals: 0, altUnits: [] });
    // An item stored before these fields existed.
    await store.items.updateMany({}, { $unset: { unit: "", decimals: "", altUnits: "" } });
    const [item] = await get("/items");
    expect(item).toMatchObject({ unit: "ea", decimals: 0, altUnits: [] });
  });

  it("stores whole numbers and keeps the ledger exact for a kg item", async () => {
    const item = await (await post("/items", { sku: "RES", name: "Resin", unit: "kg", decimals: 3, unitCostCents: 120 })).json();
    expect(item).toMatchObject({ unit: "kg", decimals: 3 });
    // 12.5 kg is posted as 12500 (the smallest unit).
    expect((await post(`/items/${item.id}/adjust`, { locationId: loc.id, delta: 12500, reason: "Delivery" })).status).toBe(200);
    expect((await post(`/items/${item.id}/adjust`, { locationId: loc.id, delta: -2250, reason: "Used" })).status).toBe(200);
    expect((await get(`/items/${item.id}`)).quantity).toBe(10250);
    // The API still refuses fractions: the contract is whole numbers.
    expect((await post(`/items/${item.id}/adjust`, { locationId: loc.id, delta: 0.5 })).status).toBe(400);
    const movements = await get(`/items/${item.id}/movements`);
    expect(movements.map((m: { delta: number }) => m.delta).sort((a: number, b: number) => a - b)).toEqual([-2250, 12500]);
  });

  it("values stock by display unit, not stored unit", async () => {
    const item = await (await post("/items", { sku: "RES", name: "Resin", unit: "kg", decimals: 3, unitCostCents: 120 })).json();
    await post(`/items/${item.id}/adjust`, { locationId: loc.id, delta: 12500 });
    const overview = await get("/overview");
    expect(overview.valueCents).toBe(1500); // 12.5 kg x $1.20
  });

  it("changes decimals freely before an item has history, and refuses after", async () => {
    const item = await (await post("/items", { sku: "ROPE", name: "Rope" })).json();
    expect((await patch(`/items/${item.id}`, { unit: "m", decimals: 2 })).status).toBe(200);
    expect((await get(`/items/${item.id}`)).decimals).toBe(2);

    await post(`/items/${item.id}/adjust`, { locationId: loc.id, delta: 1000 });
    const refused = await patch(`/items/${item.id}`, { decimals: 3 });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/decimal places/i);
    expect((await get(`/items/${item.id}`)).decimals).toBe(2);
    // Same value is not a change, and renaming the unit is harmless.
    expect((await patch(`/items/${item.id}`, { decimals: 2, unit: "metre" })).status).toBe(200);
    expect((await get(`/items/${item.id}`)).unit).toBe("metre");
  });

  it("also refuses once the item is on an order, even with no stock", async () => {
    const item = await (await post("/items", { sku: "RES", name: "Resin", unit: "kg", decimals: 3 })).json();
    const supplier = await (await post("/purchasing/suppliers", { name: "Chem Co" })).json();
    const po = await post("/purchasing/orders", { supplierId: supplier.id, lines: [{ itemId: item.id, quantity: 5000, unitCostCents: 100 }] });
    expect(po.status).toBe(201);
    expect((await patch(`/items/${item.id}`, { decimals: 0 })).status).toBe(409);
  });

  it("scales purchase order totals by the item's decimals", async () => {
    const item = await (await post("/items", { sku: "RES", name: "Resin", unit: "kg", decimals: 3 })).json();
    const supplier = await (await post("/purchasing/suppliers", { name: "Chem Co" })).json();
    const po = await (await post("/purchasing/orders", { supplierId: supplier.id, lines: [{ itemId: item.id, quantity: 25000, unitCostCents: 150 }] })).json();
    expect(po.totalCents).toBe(3750); // 25 kg x $1.50
  });

  it("records the unit settings in the audit log", async () => {
    const item = await (await post("/items", { sku: "ROPE", name: "Rope" })).json();
    await patch(`/items/${item.id}`, { unit: "m", decimals: 2, altUnits: [{ name: "reel", factor: "50" }] });
    const events = (await get("/audit")).events;
    const updated = events.find((e: { action: string }) => e.action === "item.updated");
    expect(updated.summary).toMatch(/unit of measure/);
    expect(updated.summary).toMatch(/decimal places/);
    expect(updated.summary).toMatch(/reel = 50/);
    expect((await get("/audit/verify")).ok).toBe(true);
  });
});
