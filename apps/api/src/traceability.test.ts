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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `t${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* csv */ }
  return { status: res.status, body: json, text: t };
};

/**
 * A small plant: paper rolls (tracked by label) and glue (plain) become pallets (tracked by label) in WO-1,
 * and pallets plus nothing else become plain crates in WO-2.
 */
async function plant() {
  const owner = await signUp({ mode: "create", name: "Boxes" });
  const base = `/api/orgs/${owner.org.id}`;
  const get = (p: string) => call(owner.cookie, `${base}${p}`);
  const post = (p: string, b: unknown, m?: string) => call(owner.cookie, `${base}${p}`, b, m);
  const main = (await get("/locations")).body[0].id as string;
  const mach = (await post("/locations", { name: "Press", type: "production" })).body.id as string;
  const fg = (await post("/locations", { name: "Finished", type: "finished" })).body.id as string;
  const roll = (await post("/items", { sku: "ROLL", name: "Paper roll", tracking: "unit" })).body.id as string;
  const glue = (await post("/items", { sku: "GLUE", name: "Glue" })).body.id as string;
  const pallet = (await post("/items", { sku: "PAL", name: "Box pallet", tracking: "unit" })).body.id as string;
  const crate = (await post("/items", { sku: "CRATE", name: "Crate" })).body.id as string;
  const supplier = (await post("/purchasing/suppliers", { name: "Acme Paper" })).body.id as string;
  const rolls = async (lot: string, count: number, quantity = 800) => (await post("/units", { itemId: roll, locationId: main, quantity, count, lot })).body.units as { id: string; code: string }[];
  const [a1, a2] = await rolls("SUP-A", 2);
  const [b1] = await rolls("SUP-B", 1);
  // glue arrives on a purchase order with a supplier lot
  const po = (await post("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: glue, quantity: 100, unitCostCents: 10 }] })).body;
  await post(`/purchasing/orders/${po.id}/place`, {});
  expect((await post(`/purchasing/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: glue, quantity: 100, supplierLot: "G-1" }] })).status).toBe(201);

  const wc = (await post("/production/work-centers", { name: "Press 1", locationId: mach })).body.id as string;
  await post("/production/boms", { outputItemId: pallet, inputs: [{ itemId: roll, quantity: 1 }, { itemId: glue, quantity: 1 }] });
  const wo1 = (await post("/production/work-orders", { outputItemId: pallet, quantity: 100, workCenterId: wc })).body;
  await post(`/production/work-orders/${wo1.id}/action`, { action: "release" });
  const p = `/production/work-orders/${wo1.id}`;
  expect((await post(`${p}/load`, { itemId: roll, unitId: a1!.id })).status).toBe(201);
  expect((await post(`${p}/load`, { itemId: glue, fromLocationId: main, quantity: 20 })).status).toBe(201);
  expect((await post(`${p}/consume`, { itemId: roll, unitId: a1!.id, used: 800 })).status).toBe(201);
  expect((await post(`${p}/consume`, { itemId: glue, used: 20 })).status).toBe(201);
  const out1 = await post(`${p}/output`, { good: 100, unitSize: 50, lot: "PAL-1", toLocationId: fg });
  expect(out1.status).toBe(201);
  await post(`${p}/action`, { action: "complete" });
  const pallets = (await get(`/units?itemId=${pallet}`)).body.units as { id: string; code: string }[];

  await post("/production/boms", { outputItemId: crate, inputs: [{ itemId: pallet, quantity: 1 }] });
  const wo2 = (await post("/production/work-orders", { outputItemId: crate, quantity: 10, workCenterId: wc })).body;
  await post(`/production/work-orders/${wo2.id}/action`, { action: "release" });
  const p2 = `/production/work-orders/${wo2.id}`;
  expect((await post(`${p2}/load`, { itemId: pallet, unitId: pallets[0]!.id })).status).toBe(201);
  expect((await post(`${p2}/consume`, { itemId: pallet, unitId: pallets[0]!.id, used: 50 })).status).toBe(201);
  expect((await post(`${p2}/output`, { good: 10, toLocationId: fg })).status).toBe(201);
  return { owner, base, get, post, main, fg, roll, glue, pallet, crate, a1: a1!, a2: a2!, b1: b1!, pallets, wo1: wo1.number as string, wo2: wo2.number as string, po };
}

const flat = (nodes: any[]): any[] => nodes.flatMap((x) => [x, ...flat(x.children)]);
const labels = (res: any) => flat(res.tree).map((x) => x.label);

describe("forward trace (where did this go)", () => {
  it("follows a supplier lot to the work orders that used it, what they made, and where that is now", async () => {
    const t = await plant();
    const res = (await t.get("/traceability/trace?lot=SUP-A")).body;
    expect(res.query).toMatch(/lot SUP-A/);
    const ls = labels(res);
    expect(ls.some((l: string) => l.startsWith(t.a1.code))).toBe(true);
    expect(ls.some((l: string) => l.startsWith(t.a2.code))).toBe(true);
    expect(ls.some((l: string) => l.startsWith(t.wo1))).toBe(true);
    expect(ls.some((l: string) => l.startsWith(t.pallets[0]!.code))).toBe(true);
    expect(ls.some((l: string) => l.startsWith(t.wo2))).toBe(true); // a second level: the pallet went into WO-2
    expect(ls.some((l: string) => l.includes("× Crate"))).toBe(true);
    expect(res.summary.workOrders).toEqual([t.wo1, t.wo2]);
    // rolls: a1 used up, a2 untouched; pallets: one half-used on the press, one still in finished goods
    const byCode = Object.fromEntries(res.affected.filter((r: any) => r.code).map((r: any) => [r.code, r]));
    expect(byCode[t.a1.code]).toMatchObject({ status: "consumed", quantity: 0 });
    expect(byCode[t.a2.code]).toMatchObject({ status: "available", quantity: 800, location: "Main" });
    expect(byCode[t.pallets[1]!.code]).toMatchObject({ status: "available", quantity: 50, location: "Finished", via: t.wo1 });
    expect(res.summary.units).toBe(4); // a1, a2, two pallets
    expect(res.summary.stillInStock).toBe(800 + 50 + 0); // a2 + untouched pallet; the used pallet is used up
    expect(res.summary.locations.map((l: any) => l.path)).toEqual(expect.arrayContaining(["Main", "Finished"]));
    expect(typeof res.tookMs).toBe("number");
    expect(res.summary.hasInferred).toBe(false);
  });

  it("a lot nobody used ends at its own units; a different lot does not leak into the trace", async () => {
    const t = await plant();
    const res = (await t.get("/traceability/trace?lot=SUP-B")).body;
    expect(res.summary.units).toBe(1);
    expect(res.summary.workOrders).toEqual([]);
    expect(res.affected[0]).toMatchObject({ code: t.b1.code, quantity: 800 });
    const a = (await t.get("/traceability/trace?lot=sup-a")).body; // case does not matter
    expect(a.summary.units).toBe(4);
  });

  it("plain stock lots are traced to possible work orders and marked as inferred", async () => {
    const t = await plant();
    const res = (await t.get("/traceability/trace?lot=G-1")).body;
    expect(res.summary.hasInferred).toBe(true);
    expect(res.summary.purchaseOrders).toEqual([t.po.number]);
    expect(res.summary.suppliers).toEqual(["Acme Paper"]);
    const lotNode = res.tree[0];
    expect(lotNode.kind).toBe("lot");
    expect(lotNode.children.every((c: any) => c.exact === false)).toBe(true);
    expect(flat(res.tree).some((x: any) => x.label.startsWith(t.wo1))).toBe(true);
    expect(res.notes.join(" ")).toMatch(/possible/);
  });

  it("starting from a roll or a work order works too", async () => {
    const t = await plant();
    const fromUnit = (await t.get(`/traceability/trace?unit=${t.a1.code.toLowerCase()}`)).body;
    expect(fromUnit.summary.workOrders).toContain(t.wo1);
    const fromWo = (await t.get(`/traceability/trace?workOrder=wo-2`)).body;
    expect(fromWo.summary.workOrders).toEqual([t.wo2]);
    expect(fromWo.affected.some((r: any) => r.kind === "quantity" && r.quantity === 10)).toBe(true);
  });

  it("shows stock on quality hold as such", async () => {
    const t = await plant();
    await t.post("/quality/holds", { unitId: t.a2.id, reason: "Supplier issue" });
    const res = (await t.get("/traceability/trace?lot=SUP-A")).body;
    const row = res.affected.find((r: any) => r.code === t.a2.code);
    expect(row.status).toBe("quarantined");
    expect(flat(res.tree).find((x: any) => x.label.startsWith(t.a2.code)).detail).toMatch(/quality hold/);
  });
});

describe("backward trace (what went into this)", () => {
  it("goes from a finished pallet to the roll, its lot, and the plain glue as possible sources", async () => {
    const t = await plant();
    const res = (await t.get(`/traceability/trace?direction=backward&unit=${t.pallets[0]!.code}`)).body;
    const ls = labels(res);
    expect(ls.some((l: string) => l.startsWith(t.wo1))).toBe(true);
    const rollNode = flat(res.tree).find((x: any) => x.label.startsWith(t.a1.code));
    expect(rollNode).toBeTruthy();
    expect(rollNode.children[0]).toMatchObject({ kind: "receipt", exact: true });
    expect(rollNode.detail).toMatch(/SUP-A/);
    const glue = flat(res.tree).find((x: any) => x.kind === "inputs");
    expect(glue.exact).toBe(false);
    expect(glue.children[0].detail).toMatch(/G-1/);
    expect(glue.children[0].detail).toContain(t.po.number);
    expect(res.summary.hasInferred).toBe(true);
    // the other roll is NOT in this pallet's history
    expect(ls.some((l: string) => l.startsWith(t.a2.code))).toBe(false);
  });

  it("goes two levels: from a work order through its pallets to the rolls", async () => {
    const t = await plant();
    const res = (await t.get(`/traceability/trace?direction=backward&workOrder=${t.wo2}`)).body;
    const ls = labels(res);
    expect(ls[0]).toMatch(new RegExp(`^${t.wo2}`));
    expect(ls.some((l: string) => l.startsWith(t.wo1))).toBe(true);
    expect(ls.some((l: string) => l.startsWith(t.a1.code))).toBe(true);
    expect(res.summary.workOrders).toEqual([t.wo1, t.wo2]);
  });

  it("backward from a lot of finished pallets finds the rolls behind every pallet", async () => {
    const t = await plant();
    const res = (await t.get("/traceability/trace?direction=backward&lot=PAL-1")).body;
    expect(res.summary.units).toBe(3); // two pallets and the one roll
    const wo1Nodes = flat(res.tree).filter((x: any) => x.kind === "work_order" && x.label.startsWith(t.wo1));
    expect(wo1Nodes).toHaveLength(2); // both pallets came from it...
    expect(wo1Nodes.filter((x: any) => x.repeat)).toHaveLength(1); // ...but it is only expanded once
    expect(flat(res.tree).filter((x: any) => x.kind === "unit" && x.label.startsWith(t.a1.code))).toHaveLength(1);
  });
});

describe("errors, isolation and drills", () => {
  it("says what is wrong: nothing found, no or several starting points, other organizations", async () => {
    const t = await plant();
    expect((await t.get("/traceability/trace?lot=NOPE")).status).toBe(404);
    expect((await t.get("/traceability/trace?unit=NOPE")).status).toBe(404);
    expect((await t.get("/traceability/trace?workOrder=WO-0099")).status).toBe(404);
    expect((await t.get("/traceability/trace?workOrder=banana")).status).toBe(404);
    expect((await t.get("/traceability/trace")).status).toBe(400);
    expect((await t.get("/traceability/trace?lot=A&unit=B")).status).toBe(400);
    expect((await t.get("/traceability/trace?direction=sideways&lot=A")).status).toBe(400);
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/traceability/trace?lot=SUP-A`)).status).toBe(404);
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/traceability/trace?unit=${t.a1.code}`)).status).toBe(404);
    expect((await call(other.cookie, `${t.base}/traceability/trace?lot=SUP-A`)).status).toBe(404);
  });

  it("ignores production lines that were reversed", async () => {
    const t = await plant();
    // reverse the plain glue consumption of WO-1: the plain input then no longer appears under it
    const line = (await store.movements.findOne({ orgId: new ObjectId(t.owner.org.id), itemId: new ObjectId(t.glue), type: "consume" }))!;
    expect((await t.post(`/movements/${line._id.toHexString()}/reverse`, {})).status).toBe(200);
    const res = (await t.get(`/traceability/trace?direction=backward&unit=${t.pallets[0]!.code}`)).body;
    expect(flat(res.tree).some((x: any) => x.kind === "inputs")).toBe(false);
  });

  it("a mock recall is timed, kept in a history, audited, and any member can run it", async () => {
    const t = await plant();
    const member = await signUp({ mode: "join", joinCode: t.owner.org.joinCode }, "Bob");
    const run = await call(member.cookie, `${t.base}/traceability/drills`, { lot: "SUP-A" });
    expect(run.status).toBe(201);
    expect(run.body.drill).toMatchObject({ by: "Bob", direction: "forward", units: 4 });
    expect(run.body.drill.tookMs).toBeGreaterThanOrEqual(1);
    expect(run.body.result.tree.length).toBeGreaterThan(0);
    await call(t.owner.cookie, `${t.base}/traceability/drills`, { direction: "backward", workOrder: t.wo2 });
    const hist = (await t.get("/traceability/drills")).body;
    expect(hist).toHaveLength(2);
    expect(hist[0].direction).toBe("backward"); // newest first
    expect((await store.audit.find({ action: "traceability.drill", orgId: new ObjectId(t.owner.org.id) }).toArray())).toHaveLength(2);
    // a failed drill leaves no history
    expect((await t.post("/traceability/drills", { lot: "NOPE" })).status).toBe(404);
    expect((await t.get("/traceability/drills")).body).toHaveLength(2);
    // another organization sees none of it
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/traceability/drills`)).body).toEqual([]);
  });

  it("exports the affected stock as a spreadsheet", async () => {
    const t = await plant();
    const csv = await t.get("/traceability/trace.csv?lot=SUP-A");
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toBe("kind,label,item_sku,item,lot,quantity,status,location,via_work_order");
    expect(lines.length - 1).toBe(5); // 4 units + the plain crates
    expect(csv.text).toContain(t.a2.code);
    expect((await t.get("/traceability/trace.csv?lot=NOPE")).status).toBe(404);
  });
});
