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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `s${++n}@example.com`, password: "correct horse", organization }) });
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
 * Two presses. Work order A on Press 1 (box from paper): material scrap 5 "Trim" and 3 "Setup", output 90 good and
 * 10 scrapped "Damaged". Work order B on Press 2: material scrap 2 with no reason, 50 good. And 4 bolts scrapped from
 * a quality hold for "Machine fault". Costs: paper $10, box $5, bolt $2.50.
 */
async function plant() {
  const owner = await signUp({ mode: "create", name: "Scrap Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const post = (p: string, b: unknown, m?: string) => call(owner.cookie, `${base}${p}`, b, m);
  const main = (await get("/locations")).body[0].id as string;
  const mach = (await post("/locations", { name: "Presses", type: "production" })).body.id as string;
  const mach2 = (await post("/locations", { name: "Press 2 area", type: "production" })).body.id as string;
  const fg = (await post("/locations", { name: "Finished", type: "finished" })).body.id as string;
  const paper = (await post("/items", { sku: "PAPER", name: "Paper", unitCostCents: 1000, initialStock: { locationId: main, quantity: 500 } })).body.id as string;
  const box = (await post("/items", { sku: "BOX", name: "Box", unitCostCents: 500 })).body.id as string;
  const bolt = (await post("/items", { sku: "BOLT", name: "Bolt", unitCostCents: 250, initialStock: { locationId: main, quantity: 50 } })).body.id as string;
  const wc1 = (await post("/production/work-centers", { name: "Press 1", locationId: mach })).body.id as string;
  const wc2 = (await post("/production/work-centers", { name: "Press 2", locationId: mach2 })).body.id as string;
  await post("/production/boms", { outputItemId: box, inputs: [{ itemId: paper, quantity: 2 }] });
  const wo = async (wc: string, qty: number) => {
    const w = (await post("/production/work-orders", { outputItemId: box, quantity: qty, workCenterId: wc })).body;
    await post(`/production/work-orders/${w.id}/action`, { action: "release" });
    return w as { id: string; number: string };
  };
  const a = await wo(wc1, 100);
  const b = await wo(wc2, 50);
  const load = (w: { id: string }, qty: number) => post(`/production/work-orders/${w.id}/load`, { itemId: paper, fromLocationId: main, quantity: qty });
  const use = (w: { id: string }, body: object) => post(`/production/work-orders/${w.id}/consume`, { itemId: paper, ...body });
  await load(a, 100);
  await load(b, 20);
  expect((await use(a, { used: 40, scrap: 5, scrapReason: "trim" })).status).toBe(201);
  expect((await use(a, { used: 20, scrap: 3, scrapReason: "Setup" })).status).toBe(201);
  expect((await post(`/production/work-orders/${a.id}/output`, { good: 90, scrap: 10, scrapReason: "Damaged", toLocationId: fg })).status).toBe(201);
  expect((await use(b, { used: 10, scrap: 2 })).status).toBe(201);
  expect((await post(`/production/work-orders/${b.id}/output`, { good: 50, toLocationId: fg })).status).toBe(201);
  const hold = (await post("/quality/holds", { itemId: bolt, locationId: main, quantity: 4, reason: "Damaged" })).body;
  expect((await post(`/quality/ncrs/${hold.id}/dispose`, { type: "scrap", reason: "Machine fault" })).status).toBe(200);
  return { owner, member, base, get, post, a, b, wc1, wc2, paper, box, bolt, main, fg, mach };
}

const money = (r: any, reason: string) => r.byReason.find((x: any) => x.reason === reason)?.valueCents;

describe("scrap and yield report", () => {
  it("adds up scrap by reason, work center, item and source, with value from the item's unit cost", async () => {
    const t = await plant();
    const r = (await t.get("/production/scrap?days=30")).body;
    expect(r.totals).toMatchObject({ valueCents: 16000, lines: 5, goodOutput: 140, scrappedOutput: 10, yieldPct: 93.3, noReasonValueCents: 2000 });
    expect(money(r, "Trim")).toBe(5000);
    expect(money(r, "Setup")).toBe(3000);
    expect(money(r, "Damaged")).toBe(5000);
    expect(money(r, "Machine fault")).toBe(1000);
    expect(money(r, "No reason given")).toBe(2000);
    expect(r.byReason.map((x: any) => x.valueCents)).toEqual([...r.byReason.map((x: any) => x.valueCents)].sort((a, b) => b - a)); // biggest first
    const c = Object.fromEntries(r.byWorkCenter.map((x: any) => [x.name, x]));
    expect(c["Press 1"]).toMatchObject({ scrapLines: 3, valueCents: 13000, goodOutput: 90, scrappedOutput: 10, yieldPct: 90 });
    expect(c["Press 2"]).toMatchObject({ scrapLines: 1, valueCents: 2000, goodOutput: 50, scrappedOutput: 0, yieldPct: 100 });
    expect(c["Not on a work order"]).toMatchObject({ valueCents: 1000, yieldPct: null });
    const i = Object.fromEntries(r.byItem.map((x: any) => [x.sku, x]));
    expect(i.PAPER).toMatchObject({ quantity: 10, valueCents: 10000, lines: 3 });
    expect(i.BOX).toMatchObject({ quantity: 10, valueCents: 5000 });
    expect(i.BOLT).toMatchObject({ quantity: 4, valueCents: 1000 });
    expect(Object.fromEntries(r.bySource.map((x: any) => [x.source, x.valueCents]))).toEqual({ usage: 10000, output: 5000, hold: 1000 });
    expect(r.bucket).toBe("day");
    expect(r.trend).toHaveLength(1);
    expect(r.trend[0]).toMatchObject({ valueCents: 16000, goodOutput: 140, scrappedOutput: 10, yieldPct: 93.3 });
  });

  it("windows by days, groups weekly for long windows, and filters by work center", async () => {
    const t = await plant();
    // push the 'Setup' scrap line 100 days back
    const line = (await store.movements.findOne({ orgId: new ObjectId(t.owner.org.id), type: "scrap", reasonCode: "Setup" }))!;
    await store.movements.updateOne({ _id: line._id }, { $set: { createdAt: new Date(Date.now() - 100 * 86_400_000) } });
    const d30 = (await t.get("/production/scrap?days=30")).body;
    const d180 = (await t.get("/production/scrap?days=180")).body;
    expect(money(d30, "Setup")).toBeUndefined();
    expect(money(d180, "Setup")).toBe(3000);
    expect(d180.bucket).toBe("week");
    expect(d180.trend.length).toBe(2);
    for (const p of d180.trend) expect(new Date(p.label + "T00:00:00Z").getUTCDay()).toBe(1); // weeks start on Monday
    const p1 = (await t.get(`/production/scrap?days=30&workCenterId=${t.wc1}`)).body;
    expect(p1.byWorkCenter.map((x: any) => x.name)).toEqual(["Press 1"]);
    expect(p1.totals).toMatchObject({ goodOutput: 90, scrappedOutput: 10 });
    expect(p1.bySource.find((x: any) => x.source === "hold").lines).toBe(0);
  });

  it("ignores scrap that was reversed in Activity", async () => {
    const t = await plant();
    const line = (await store.movements.findOne({ orgId: new ObjectId(t.owner.org.id), type: "scrap", reasonCode: "Setup" }))!;
    expect((await t.post(`/movements/${line._id.toHexString()}/reverse`, {})).status).toBe(200);
    const r = (await t.get("/production/scrap?days=30")).body;
    expect(money(r, "Setup")).toBeUndefined();
    expect(r.totals.lines).toBe(4);
    // regression: a two-line document (used + scrap, both removals) used to crash after it had been reversed
    const audit = await store.audit.findOne({ action: "stock.reversed", orgId: new ObjectId(t.owner.org.id) });
    expect(audit?.summary).toMatch(/entry of 2 lines/);
  });

  it("validates the days window and the scrap reason, and stores the list's own spelling", async () => {
    const t = await plant();
    expect((await t.get("/production/scrap?days=45")).status).toBe(400);
    expect((await t.get("/production/scrap?days=abc")).status).toBe(400);
    expect((await t.get("/production/scrap?workCenterId=nope")).status).toBe(400);
    const w = (await t.post("/production/work-orders", { outputItemId: t.box, quantity: 5, workCenterId: t.wc1 })).body;
    await t.post(`/production/work-orders/${w.id}/action`, { action: "release" });
    await t.post(`/production/work-orders/${w.id}/load`, { itemId: t.paper, fromLocationId: t.main, quantity: 20 });
    const bad = await t.post(`/production/work-orders/${w.id}/consume`, { itemId: t.paper, used: 1, scrap: 1, scrapReason: "Gremlins" });
    expect(bad.status).toBe(400);
    expect((await t.post(`/production/work-orders/${w.id}/output`, { good: 1, scrap: 1, scrapReason: "Gremlins", toLocationId: t.fg })).status).toBe(400);
    // nothing was booked by the refused calls
    expect((await t.get("/production/scrap?days=30")).body.totals.lines).toBe(5);
    // a custom list is what counts
    expect((await t.post("/reasons", { scrap: ["Gremlins"] }, "PUT")).status).toBe(200);
    expect((await t.post(`/production/work-orders/${w.id}/consume`, { itemId: t.paper, used: 1, scrap: 1, scrapReason: "gremlins" })).status).toBe(201);
    expect(money((await t.get("/production/scrap?days=30")).body, "Gremlins")).toBe(1000);
  });

  it("records the reason on rolls too (unit-tracked material)", async () => {
    const t = await plant();
    const roll = (await t.post("/items", { sku: "ROLL", name: "Roll", tracking: "unit", unitCostCents: 20 })).body.id as string;
    const unit = (await t.post("/units", { itemId: roll, locationId: t.main, quantity: 100 })).body.units[0].id as string;
    await t.post("/production/boms", { outputItemId: t.box, inputs: [{ itemId: roll, quantity: 1 }] });
    const w = (await t.post("/production/work-orders", { outputItemId: t.box, quantity: 5, workCenterId: t.wc2 })).body;
    await t.post(`/production/work-orders/${w.id}/action`, { action: "release" });
    await t.post(`/production/work-orders/${w.id}/load`, { itemId: roll, unitId: unit });
    expect((await t.post(`/production/work-orders/${w.id}/consume`, { itemId: roll, unitId: unit, used: 30, scrap: 20, scrapReason: "Wrong size" })).status).toBe(201);
    const r = (await t.get("/production/scrap?days=30")).body;
    expect(r.byItem.find((x: any) => x.sku === "ROLL")).toMatchObject({ quantity: 20, valueCents: 400 });
    expect(money(r, "Wrong size")).toBe(400);
  });

  it("exports the lines, is readable by members, belongs to its organization, and follows the Production switch", async () => {
    const t = await plant();
    const csv = (await t.get("/production/scrap/lines.csv?days=30", "member")).text.trim().split("\r\n");
    expect(csv[0]).toBe("date,source,work_order,work_center,item_sku,item,quantity,value,reason,by");
    expect(csv).toHaveLength(6);
    expect(csv.filter((l) => l.includes(",output,")).join()).toContain("Damaged");
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `${t.base}/production/scrap?days=30`)).status).toBe(404);
    expect((await call(other.cookie, `/api/orgs/${other.org.id}/production/scrap?days=30`)).body.totals.lines).toBe(0);
    expect((await call(t.owner.cookie, `${t.base}/modules`, { production: false }, "PATCH")).status).toBe(200);
    expect((await t.get("/production/scrap?days=30")).status).toBe(403);
  });
});
