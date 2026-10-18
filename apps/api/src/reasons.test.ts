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
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `rs${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : undefined };
};

describe("reason lists (scrap and quality hold)", () => {
  it("start with defaults, can be changed by an admin (one list or both), and the change is audited", async () => {
    const owner = await signUp({ mode: "create", name: "Acme" });
    const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
    const base = `/api/orgs/${owner.org.id}/reasons`;
    const first = (await call(member.cookie, base)).body;
    expect(first.scrap).toContain("Trim");
    expect(first.hold).toContain("Awaiting inspection");

    expect((await call(member.cookie, base, { scrap: ["Only me"] }, "PUT")).status).toBe(403);
    const put = await call(owner.cookie, base, { scrap: ["Trim", "Bad glue"] }, "PUT");
    expect(put.status).toBe(200);
    expect(put.body.scrap).toEqual(["Trim", "Bad glue"]);
    expect(put.body.hold).toEqual(first.hold); // untouched
    expect((await call(member.cookie, base)).body.scrap).toEqual(["Trim", "Bad glue"]);

    // validation
    expect((await call(owner.cookie, base, {}, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, base, { scrap: [] }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, base, { hold: ["Damaged", "damaged"] }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, base, { hold: [""] }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, base, { scrap: Array.from({ length: 21 }, (_, i) => `R${i}`) }, "PUT")).status).toBe(400);

    const audit = await store.audit.find({ action: "reasons.changed" }).toArray();
    expect(audit).toHaveLength(1);
    // other organizations have their own lists
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/reasons`)).body.scrap).toContain("Trim");
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/reasons`)).body.scrap).not.toContain("Bad glue");
  });
});

describe("supplier lot on receipts", () => {
  it("is kept on the ledger line for floor receipts, purchase order receipts and unit receipts, and shown in Activity", async () => {
    const o = await signUp({ mode: "create", name: "Lots Co" });
    const base = `/api/orgs/${o.org.id}`;
    const main = (await call(o.cookie, `${base}/locations`)).body[0].id;
    const bolt = (await call(o.cookie, `${base}/items`, { sku: "BOLT", name: "Bolt" })).body.id;
    const roll = (await call(o.cookie, `${base}/items`, { sku: "ROLL", name: "Roll", tracking: "unit" })).body.id;

    expect((await call(o.cookie, `${base}/receipts`, { itemId: bolt, locationId: main, quantity: 10, supplierLot: "  L-100 " })).status).toBe(201);
    expect((await call(o.cookie, `${base}/receipts`, { itemId: bolt, locationId: main, quantity: 5 })).status).toBe(201); // no lot: fine
    const supplier = (await call(o.cookie, `${base}/purchasing/suppliers`, { name: "Acme Supply" })).body.id;
    const po = (await call(o.cookie, `${base}/purchasing/orders`, { supplierId: supplier, lines: [{ itemId: bolt, quantity: 20, unitCostCents: 5 }] })).body;
    await call(o.cookie, `${base}/purchasing/orders/${po.id}/place`, {});
    expect((await call(o.cookie, `${base}/purchasing/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: bolt, quantity: 20, supplierLot: "L-200" }] })).status).toBe(201);
    expect((await call(o.cookie, `${base}/units`, { itemId: roll, locationId: main, quantity: 800, lot: "RL-9", count: 2 })).status).toBe(201);

    const lots = (await store.movements.find({ supplierLot: { $exists: true } }).toArray()).map((m) => m.supplierLot).sort();
    expect(lots).toEqual(["L-100", "L-200", "RL-9", "RL-9"]);
    const withLot = (await store.movements.find({ itemId: { $exists: true }, supplierLot: "L-200" }).toArray())[0]!;
    expect(withLot.purchaseOrderId?.toHexString()).toBe(po.id); // lot and order travel together

    const entries = (await call(o.cookie, `${base}/movements?limit=50`)).body.entries as { supplierLot?: string }[];
    expect(entries.filter((e) => e.supplierLot).map((e) => e.supplierLot).sort()).toEqual(["L-100", "L-200", "RL-9", "RL-9"]);
    // too long is refused
    expect((await call(o.cookie, `${base}/receipts`, { itemId: bolt, locationId: main, quantity: 1, supplierLot: "x".repeat(65) })).status).toBe(400);
  });
});
