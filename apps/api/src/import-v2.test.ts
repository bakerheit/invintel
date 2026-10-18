import { randomBytes } from "node:crypto";
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
async function signUp(organization: object) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: `iv${++n}@example.com`, password: "correct horse", organization }),
  });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = (cookie: string, path: string, body?: unknown, method?: string) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A fresh organization with an owner, a "Main" location and a base URL. */
async function setup() {
  const { cookie, org } = await signUp({ mode: "create", name: `Acme ${n}` });
  const base = `/api/orgs/${org.id}`;
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await call(cookie, `${base}${path}`, body, method);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const imp = (csv: string, extra: object = {}) => json("/data/items/import", { csv, ...extra });
  const items = async () => (await json("/items")).body as { id: string; sku: string; name: string; quantity: number; unitCostCents: number; reorderLevel: number; barcodes: string[]; category: string; unit: string; decimals: number }[];
  const bySku = async (sku: string) => (await items()).find((i) => i.sku === sku)!;
  return { cookie, org, base, json, imp, items, bySku };
}

const SEED = ["sku,name,category,reorder_level,unit_cost,barcodes,location,quantity", "A,Alpha,Bolts,10,1.00,111,Main,5", "B,Beta,Nuts,20,2.50,222,Main,7"].join("\n");

describe("import v2: preview and column mapping", () => {
  it("returns the headers, the mapping it chose, and a sample", async () => {
    const t = await setup();
    const res = await t.imp("Part,Title,Qty,Where\nA,Alpha,5,Main\nB,Beta,7,Main\nC,Gamma,1,Main\nD,Delta,2,Main\nE,Eps,3,Main", { dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.headers).toEqual(["Part", "Title", "Qty", "Where"]);
    // "Part" and "Title" aren't names we know, so those two aren't found; Qty is.
    expect(res.body.mapping).toEqual({ quantity: 2 });
    expect(res.body.needs).toEqual(["sku", "name"]);
    expect(res.body.rows).toEqual([]);
    expect(res.body.sample).toHaveLength(4);
    expect(res.body.sample[0]).toEqual(["A", "Alpha", "5", "Main"]);
  });

  it("imports with a mapping the person chose", async () => {
    const t = await setup();
    const csv = "Part,Title,On shelf,Where,Price\nA,Alpha,5,Main,1.50\nB,Beta,7,Main,2";
    const mapping = { sku: 0, name: 1, quantity: 2, location: 3, cost: 4 };
    const preview = await t.imp(csv, { dryRun: true, mapping });
    expect(preview.body.errors).toBe(0);
    expect(preview.body.itemsToCreate).toBe(2);
    expect(preview.body.mapping).toEqual(mapping);
    expect((await t.imp(csv, { dryRun: false, mapping })).status).toBe(201);
    expect(await t.bySku("A")).toMatchObject({ name: "Alpha", quantity: 5, unitCostCents: 150 });
  });

  it("only reads the fields that are mapped", async () => {
    const t = await setup();
    // Both columns look like known headers, but the person said only SKU and name count.
    const res = await t.imp("sku,name,cost\nA,Alpha,9.99", { dryRun: false, mapping: { sku: 0, name: 1 } });
    expect(res.status).toBe(201);
    expect((await t.bySku("A")).unitCostCents).toBe(0);
  });

  it("refuses bad mappings", async () => {
    const t = await setup();
    const csv = "a,b\nA,Alpha";
    expect((await t.imp(csv, { mapping: { sku: 0, name: 0 } })).status).toBe(400); // one column, two fields
    expect((await t.imp(csv, { mapping: { sku: 0, name: 5 } })).status).toBe(400); // past the end
    // No SKU, or no name to create with: a preview says what is missing, applying is refused.
    expect((await t.imp(csv, { mapping: { name: 1 } })).body.needs).toEqual(["sku"]);
    expect((await t.imp(csv, { mapping: { sku: 0 } })).body.needs).toEqual(["name"]);
    expect((await t.imp(csv, { mapping: { name: 1 }, dryRun: false })).status).toBe(400);
    expect((await t.imp(csv, { mapping: { sku: 0 }, dryRun: false })).status).toBe(400);
    expect((await t.imp(csv, { mapping: { sku: 0, bogus: 1 } })).status).toBe(400); // not a field
    expect((await t.imp(csv, { mapping: { sku: -1, name: 1 } })).status).toBe(400);
    expect(await t.items()).toHaveLength(0);
  });
});

describe("import v2: update mode", () => {
  it("shows exactly what would change, and leaves blank cells alone", async () => {
    const t = await setup();
    await t.imp(SEED, { dryRun: false });
    const csv = "sku,name,category,reorder_level,unit_cost,barcodes\nA,Alpha prime,,15,1.25,111|999\nB,Beta,,,,";
    const preview = await t.imp(csv, { dryRun: true, mode: "update" });
    expect(preview.body.itemsToUpdate).toBe(1);
    const a = preview.body.rows.find((r: { sku: string }) => r.sku === "A");
    expect(a.status).toBe("update");
    expect(a.changes).toEqual([
      { field: "name", from: "Alpha", to: "Alpha prime" },
      { field: "reorder level", from: "10", to: "15" },
      { field: "unit cost", from: "$1.00", to: "$1.25" },
      { field: "barcodes", from: "111", to: "111 | 999" },
    ]);
    expect(preview.body.rows.find((r: { sku: string }) => r.sku === "B")).toMatchObject({ status: "skip", message: expect.stringMatching(/No changes/) });
    // Nothing happened yet.
    expect(await t.bySku("A")).toMatchObject({ name: "Alpha", reorderLevel: 10 });

    const applied = await t.imp(csv, { dryRun: false, mode: "update" });
    expect(applied.status).toBe(201);
    expect(await t.bySku("A")).toMatchObject({ name: "Alpha prime", reorderLevel: 15, unitCostCents: 125, barcodes: ["111", "999"], category: "Bolts" });
    expect((await t.bySku("B")).name).toBe("Beta");
  });

  it("matches SKUs ignoring case, and never touches stock of an item that exists", async () => {
    const t = await setup();
    await t.imp(SEED, { dryRun: false });
    const res = await t.imp("sku,name,location,quantity\na,Alpha two,Main,500", { dryRun: false, mode: "update" });
    expect(res.status).toBe(201);
    expect(res.body.rows[0].message).toMatch(/Stock isn't changed by import/);
    expect(await t.bySku("A")).toMatchObject({ name: "Alpha two", quantity: 5 });
  });

  it("update mode skips unknown SKUs; upsert creates them", async () => {
    const t = await setup();
    await t.imp(SEED, { dryRun: false });
    const csv = "sku,name\nA,Alpha 2\nZ,Zed";
    const update = await t.imp(csv, { dryRun: false, mode: "update" });
    expect(update.body.rows.find((r: { sku: string }) => r.sku === "Z")).toMatchObject({ status: "skip", message: expect.stringMatching(/nothing to update/) });
    expect((await t.items()).some((i) => i.sku === "Z")).toBe(false);
    const upsert = await t.imp("sku,name\nA,Alpha 3\nZ,Zed", { dryRun: false, mode: "upsert" });
    expect(upsert.body).toMatchObject({ itemsToCreate: 1, itemsToUpdate: 1 });
    expect(await t.bySku("Z")).toMatchObject({ name: "Zed" });
    expect((await t.bySku("A")).name).toBe("Alpha 3");
  });

  it("update mode needs no name column", async () => {
    const t = await setup();
    await t.imp(SEED, { dryRun: false });
    const res = await t.imp("sku,unit_cost\nA,3.00", { dryRun: false, mode: "update" });
    expect(res.status).toBe(201);
    expect((await t.bySku("A")).unitCostCents).toBe(300);
  });

  it("refuses to change unit or decimals, and reads reorder level in the item's unit", async () => {
    const t = await setup();
    await t.imp("sku,name,unit,decimals,reorder_level\nR,Resin,kg,3,50.5", { dryRun: false });
    const bad = await t.imp("sku,unit,decimals\nR,g,0", { dryRun: true, mode: "update" });
    expect(bad.body.errors).toBe(1);
    expect(bad.body.rows[0].message).toMatch(/can't be changed by import/);
    // Same unit is fine (it is a no-op), a new reorder level is read with the item's decimals.
    const ok = await t.imp("sku,unit,decimals,reorder_level\nR,kg,3,60.25", { dryRun: false, mode: "update" });
    expect(ok.status).toBe(201);
    expect((await t.bySku("R")).reorderLevel).toBe(60250);
    const tooFine = await t.imp("sku,reorder_level\nR,1.2345", { dryRun: true, mode: "update" });
    expect(tooFine.body.rows[0].message).toMatch(/3 decimal places/);
  });

  it("checks new barcodes against everything else", async () => {
    const t = await setup();
    await t.imp(SEED, { dryRun: false });
    const taken = await t.imp("sku,barcodes\nA,222", { dryRun: true, mode: "update" });
    expect(taken.body.rows[0]).toMatchObject({ status: "error", message: expect.stringMatching(/already used by Beta/) });
    const twice = await t.imp("sku,barcodes\nA,555\nB,555", { dryRun: true, mode: "update" });
    expect(twice.body.errors).toBe(1);
    expect(twice.body.rows.find((r: { status: string }) => r.status === "error").message).toMatch(/another item in this file/);
  });
});

describe("import v2: problem rows", () => {
  const CSV = "sku,name,quantity,location\nOK1,Fine one,5,Main\nBAD,Bad one,x,Main\nOK2,Fine two,3,Main\nBAD,Bad again,2,Main\nOK1,Fine one,1,Main";

  it("stops by default and imports nothing", async () => {
    const t = await setup();
    const res = await t.imp(CSV, { dryRun: false });
    expect(res.status).toBe(422);
    expect(res.body.errors).toBeGreaterThan(0);
    expect(await t.items()).toHaveLength(0);
  });

  it("can skip the bad rows, keeps them for fixing, and reports them", async () => {
    const t = await setup();
    const res = await t.imp(CSV, { dryRun: false, onErrors: "skip", filename: "stock.csv" });
    expect(res.status).toBe(201);
    expect((await t.items()).map((i) => i.sku).sort()).toEqual(["OK1", "OK2"]);
    expect((await t.bySku("OK1")).quantity).toBe(6); // its second line still added stock
    const bad = res.body.rows.filter((r: { status: string }) => r.status === "error");
    expect(bad.map((r: { line: number }) => r.line)).toEqual([3, 5]);
    expect(bad[0].cells).toEqual(["BAD", "Bad one", "x", "Main"]);
    // The second BAD line can't stand alone once its first line failed.
    expect(bad[1].message).toMatch(/first line for this SKU had a problem/);
  });
});

describe("import v2: history and undo", () => {
  it("records a batch and audits it", async () => {
    const t = await setup();
    const res = await t.imp(SEED, { dryRun: false, filename: "start.csv" });
    expect(res.body.batchId).toBeTruthy();
    const list = (await t.json("/data/imports")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: "IMP-0001", filename: "start.csv", created: 2, updated: 0, undoneAt: null, mode: "create" });
    const audit = (await t.json("/audit")).body.events;
    expect(audit.find((e: { action: string }) => e.action === "import.applied").summary).toMatch(/IMP-0001 \(start.csv\): 2 created, 0 updated/);
    // A preview, or an import that changes nothing, leaves no batch.
    await t.imp(SEED, { dryRun: true });
    await t.imp(SEED, { dryRun: false });
    expect((await t.json("/data/imports")).body).toHaveLength(1);
    expect((await t.json("/audit/verify")).body.ok).toBe(true);
  });

  it("undoes a create-and-update import, writing stock off through the ledger", async () => {
    const t = await setup();
    await t.imp(SEED, { dryRun: false });
    const second = await t.imp("sku,name,unit_cost,location,quantity\nA,Alpha prime,9.00,,\nC,Gamma,1.00,Main,4", { dryRun: false, mode: "upsert" });
    const batchId = second.body.batchId;
    expect((await t.bySku("C")).quantity).toBe(4);

    const undo = await t.json(`/data/imports/${batchId}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ removed: 1, restored: 1, batch: { number: "IMP-0002", created: 1, updated: 1 } });
    expect(undo.body.batch.undoneAt).toBeTruthy();
    expect((await t.items()).some((i) => i.sku === "C")).toBe(false);
    expect(await t.bySku("A")).toMatchObject({ name: "Alpha", unitCostCents: 100 });

    // The ledger still adds up: C came in as 4 and went out as 4.
    const ledger = await store.movements.find({ orgId: { $exists: true } }).toArray();
    const forC = ledger.filter((m) => m.reason === "Imported from CSV" || m.reason === "Import IMP-0002 undone");
    expect(forC.some((m) => m.reason === "Import IMP-0002 undone" && m.delta === -4)).toBe(true);
    const audit = (await t.json("/audit")).body.events.map((e: { action: string }) => e.action);
    expect(audit).toContain("import.undone");
    expect((await t.json("/audit/verify")).body.ok).toBe(true);

    expect((await t.json(`/data/imports/${batchId}/undo`, {})).status).toBe(409); // not twice
    expect((await t.json("/data/imports")).body[0].undoneAt).toBeTruthy();
  });

  it("refuses to undo once stock has moved, and changes nothing", async () => {
    const t = await setup();
    const res = await t.imp(SEED, { dryRun: false });
    const a = await t.bySku("A");
    const loc = (await t.json("/locations")).body[0].id;
    await t.json(`/items/${a.id}/adjust`, { locationId: loc, delta: -1, reason: "Used" });
    const undo = await t.json(`/data/imports/${res.body.batchId}/undo`, {});
    expect(undo.status).toBe(409);
    expect(undo.body.problems).toEqual([expect.stringMatching(/^A: its stock has moved/)]);
    expect((await t.items()).map((i) => i.sku).sort()).toEqual(["A", "B"]); // all or nothing: B stayed too
  });

  it("refuses when a created item is on an order, or an updated item was edited again", async () => {
    const t = await setup();
    const created = await t.imp(SEED, { dryRun: false });
    const supplier = (await t.json("/purchasing/suppliers", { name: "Co" })).body;
    const a = await t.bySku("A");
    await t.json("/purchasing/orders", { supplierId: supplier.id, lines: [{ itemId: a.id, quantity: 3, unitCostCents: 100 }] });
    const blocked = await t.json(`/data/imports/${created.body.batchId}/undo`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.problems[0]).toMatch(/^A: it is now on an order/);

    const b = await t.bySku("B");
    const upd = await t.imp("sku,name\nB,Beta prime", { dryRun: false, mode: "update" });
    await t.json(`/items/${b.id}`, { name: "Beta third" }, "PATCH");
    const stale = await t.json(`/data/imports/${upd.body.batchId}/undo`, {});
    expect(stale.status).toBe(409);
    expect(stale.body.problems[0]).toMatch(/^B: its name was changed again/);
    expect((await t.bySku("B")).name).toBe("Beta third");
  });

  it("is admin-only and scoped to the organization", async () => {
    const t = await setup();
    const res = await t.imp(SEED, { dryRun: false });
    const member = await signUp({ mode: "join", joinCode: t.org.joinCode });
    expect((await call(member.cookie, `${t.base}/data/imports`)).status).toBe(403);
    expect((await call(member.cookie, `${t.base}/data/imports/${res.body.batchId}/undo`, {})).status).toBe(403);
    const other = await setup();
    expect((await other.json(`/data/imports/${res.body.batchId}/undo`, {})).status).toBe(404);
    expect((await other.json("/data/imports")).body).toEqual([]);
  });
});
