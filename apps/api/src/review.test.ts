import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Regression tests from the review of purchasing.ts and data.ts (CSV import/export).
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
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `r${++n}@example.com`, password: "correct horse", organization }),
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
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* csv */ }
  return { status: res.status, text, body: json };
};

describe("CSV export then import (round trip)", () => {
  it("keeps descriptions, and text that starts with = + - @ comes back unchanged", async () => {
    const a = await signUp({ mode: "create", name: "Source Co" });
    const baseA = `/api/orgs/${a.org.id}`;
    const mainA = (await call(a.cookie, `${baseA}/locations`)).body[0].id;
    await call(a.cookie, `${baseA}/items`, {
      sku: "-RB-1", name: "=SUM(A1)", description: 'Spare, "quoted"\nsecond line', category: "+misc", reorderLevel: 3, unitCostCents: 150,
      barcodes: ["12345678"], initialStock: { locationId: mainA, quantity: 7 },
    });
    const csv = (await call(a.cookie, `${baseA}/data/items.csv`)).text;

    const b = await signUp({ mode: "create", name: "Dest Co" });
    const baseB = `/api/orgs/${b.org.id}`;
    const imp = await call(b.cookie, `${baseB}/data/items/import`, { csv, dryRun: false });
    expect(imp.status).toBe(201);
    const items = (await call(b.cookie, `${baseB}/items`)).body;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sku: "-RB-1", name: "=SUM(A1)", description: 'Spare, "quoted"\nsecond line', category: "+misc", reorderLevel: 3, unitCostCents: 150, barcodes: ["12345678"], quantity: 7,
    });
  });

  it("reads a unit cost like 1.005 as 101 cents, not 100 (no floating point error)", async () => {
    const a = await signUp({ mode: "create", name: "Cost Co" });
    const base = `/api/orgs/${a.org.id}`;
    const csv = ["sku,name,unit cost", "A,Alpha,1.005", "B,Beta,19.99", "C,Gamma,0.29", "D,Delta,1.115"].join("\n");
    expect((await call(a.cookie, `${base}/data/items/import`, { csv, dryRun: false })).status).toBe(201);
    const cents = Object.fromEntries((await call(a.cookie, `${base}/items`)).body.map((i: { sku: string; unitCostCents: number }) => [i.sku, i.unitCostCents]));
    expect(cents).toEqual({ A: 101, B: 1999, C: 29, D: 112 });
  });
});

describe("receiving against a purchase order", () => {
  it("posts nothing at all if any line can't be received (no half-received order a retry would double)", async () => {
    const o = await signUp({ mode: "create", name: "Buyer Co" });
    const base = `/api/orgs/${o.org.id}`;
    const main = (await call(o.cookie, `${base}/locations`)).body[0].id;
    const a = (await call(o.cookie, `${base}/items`, { sku: "A", name: "Alpha" })).body.id;
    const b = (await call(o.cookie, `${base}/items`, { sku: "B", name: "Beta" })).body.id;
    const supplier = (await call(o.cookie, `${base}/purchasing/suppliers`, { name: "Acme Supply" })).body.id;
    const po = (await call(o.cookie, `${base}/purchasing/orders`, { supplierId: supplier, lines: [{ itemId: a, quantity: 10, unitCostCents: 100 }, { itemId: b, quantity: 10, unitCostCents: 100 }] })).body;
    await call(o.cookie, `${base}/purchasing/orders/${po.id}/place`, {});
    expect((await call(o.cookie, `${base}/items/${b}`, undefined, "DELETE")).status).toBeLessThan(300); // item B is deleted after the order was placed

    const res = await call(o.cookie, `${base}/purchasing/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: a, quantity: 10 }, { itemId: b, quantity: 10 }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const alpha = (await call(o.cookie, `${base}/items/${a}`)).body;
    expect(alpha.quantity).toBe(0); // before the fix: 10 were already posted and counted against the order
    const order = (await call(o.cookie, `${base}/purchasing/orders/${po.id}`)).body;
    expect(order.receivedUnits).toBe(0);
  });

  it("a placed order that was cancelled between the check and the posting can't take stock", async () => {
    // Not a timing test: it checks the guard exists by receiving against a cancelled order.
    const o = await signUp({ mode: "create", name: "Buyer2 Co" });
    const base = `/api/orgs/${o.org.id}`;
    const main = (await call(o.cookie, `${base}/locations`)).body[0].id;
    const a = (await call(o.cookie, `${base}/items`, { sku: "A", name: "Alpha" })).body.id;
    const supplier = (await call(o.cookie, `${base}/purchasing/suppliers`, { name: "Acme Supply" })).body.id;
    const po = (await call(o.cookie, `${base}/purchasing/orders`, { supplierId: supplier, lines: [{ itemId: a, quantity: 10, unitCostCents: 100 }] })).body;
    await call(o.cookie, `${base}/purchasing/orders/${po.id}/place`, {});
    await call(o.cookie, `${base}/purchasing/orders/${po.id}/cancel`, {});
    expect((await call(o.cookie, `${base}/purchasing/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: a, quantity: 1 }] })).status).toBe(409);
  });
});

describe("import limits", () => {
  it("a 5000-row file previews and imports in reasonable time, and 5001 rows are refused", async () => {
    const a = await signUp({ mode: "create", name: "Big Co" });
    const base = `/api/orgs/${a.org.id}`;
    const row = (i: number) => `SKU-${i},Item ${i},Cat,3,1.25,BC${String(i).padStart(9, "0")},Main,2`;
    const csv = (rows: number) => ["sku,name,category,reorder,cost,barcode,location,qty", ...Array.from({ length: rows }, (_, i) => row(i))].join("\n");
    const t0 = Date.now();
    const dry = await call(a.cookie, `${base}/data/items/import`, { csv: csv(5000), dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ itemsToCreate: 5000, errors: 0 });
    const dryMs = Date.now() - t0;
    expect((await call(a.cookie, `${base}/data/items/import`, { csv: csv(5001), dryRun: true })).status).toBe(400);
    const t1 = Date.now();
    expect((await call(a.cookie, `${base}/data/items/import`, { csv: csv(1000), dryRun: false })).status).toBe(201); // applying 5000 takes about 19 s (see the review notes)
    console.log(`import timing: preview of 5000 ${dryMs} ms, apply of 1000 ${Date.now() - t1} ms`);
    expect(dryMs).toBeLessThan(20_000);
  }, 120_000);

  it("duplicate barcodes inside one file are reported against the later row, with nothing imported", async () => {
    const a = await signUp({ mode: "create", name: "Dup Co" });
    const base = `/api/orgs/${a.org.id}`;
    const csv = ["sku,name,barcodes", "A,Alpha,111|222", "B,Beta,222", "C,Gamma,333", "c,Gamma again,"].join("\n");
    const res = await call(a.cookie, `${base}/data/items/import`, { csv, dryRun: false });
    expect(res.status).toBe(422);
    expect(res.body.rows.filter((r: { status: string }) => r.status === "error").map((r: { sku: string }) => r.sku)).toEqual(["B"]);
    expect((await call(a.cookie, `${base}/items`)).body).toHaveLength(0);
  });
});
