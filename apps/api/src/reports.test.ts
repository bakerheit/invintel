import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { COUNT_INTERVALS } from "./reports.js";

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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `r${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined };
};
const DAY = 86_400_000;

async function setup() {
  const o = await signUp({ mode: "create", name: "Acme" });
  const base = `/api/orgs/${o.org.id}`;
  const main = (await call(o.cookie, `${base}/locations`)).body[0].id as string;
  const shelf = (await call(o.cookie, `${base}/locations`, { name: "Shelf B", type: "storage" })).body.id as string;
  const mk = async (sku: string, qty: number, cost: number, loc = main) => (await call(o.cookie, `${base}/items`, { sku, name: sku, unitCostCents: cost, initialStock: { locationId: loc, quantity: qty } })).body.id as string;
  return { o, base, main, shelf, mk };
}

describe("stock aging", () => {
  it("buckets stock by days since it last moved, values it, and exports CSV", async () => {
    const { o, base, main, shelf, mk } = await setup();
    const fresh = await mk("FRESH", 10, 100);
    const old = await mk("OLD", 5, 1000);
    const ancient = await mk("ANCIENT", 2, 5000, shelf);
    // Age the ledger: OLD last moved 120 days ago, ANCIENT 400 days ago.
    const age = (itemId: string, days: number) => store.movements.updateMany({ itemId: new ObjectId(itemId) }, { $set: { createdAt: new Date(Date.now() - days * DAY) } });
    await age(old, 120);
    await age(ancient, 400);
    const rep = (await call(o.cookie, `${base}/reports/aging`)).body;
    const by = Object.fromEntries(rep.rows.map((r: { sku: string }) => [r.sku, r]));
    expect(by.FRESH).toMatchObject({ daysSince: 0, bucket: "0 to 30 days", valueCents: 1000 });
    expect(by.OLD).toMatchObject({ daysSince: 120, bucket: "91 to 180 days", valueCents: 5000 });
    expect(by.ANCIENT).toMatchObject({ daysSince: 400, bucket: "Over a year", locationPath: "Shelf B" });
    expect(rep.rows.map((r: { sku: string }) => r.sku)).toEqual(["ANCIENT", "OLD", "FRESH"]); // oldest first
    expect(rep.totalValueCents).toBe(1000 + 5000 + 10000);
    expect(rep.idleValueCents).toBe(10000); // only ANCIENT is over 180 days
    expect(rep.buckets.find((b: { label: string }) => b.label === "Over a year")).toMatchObject({ rows: 1, units: 2, valueCents: 10000 });
    // Filter by location, and a moved item counts as fresh at its new place.
    expect((await call(o.cookie, `${base}/reports/aging?locationId=${shelf}`)).body.rows).toHaveLength(1);
    await call(o.cookie, `${base}/moves`, { itemId: old, fromLocationId: main, toLocationId: shelf, quantity: 5 });
    const after = (await call(o.cookie, `${base}/reports/aging`)).body.rows.find((r: { sku: string }) => r.sku === "OLD");
    expect(after).toMatchObject({ daysSince: 0, locationPath: "Shelf B" });

    const csv = await call(o.cookie, `${base}/reports/aging.csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toBe("sku,name,location,quantity,value,last_movement,days_since,on_active_bom");
    expect(csv.text).toContain("ANCIENT,ANCIENT,Shelf B,2,100.00");
  });

  it("is members-only", async () => {
    const { base } = await setup();
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `${base}/reports/aging`)).status).toBe(404);
  });
});

describe("count accuracy and schedule", () => {
  it("scores posted counts by location, item and month", async () => {
    const { o, base, main, mk } = await setup();
    const a = await mk("A", 10, 100);
    const b = await mk("B", 5, 200);
    const cnt = (await call(o.cookie, `${base}/counts`, { locationId: main })).body.id as string;
    await call(o.cookie, `${base}/counts/${cnt}/lines`, { itemId: a, counted: 8 }, "PUT"); // short 2 units = $2.00
    await call(o.cookie, `${base}/counts/${cnt}/lines`, { itemId: b, counted: 5 }, "PUT"); // matches
    await call(o.cookie, `${base}/counts/${cnt}/post`, {});
    const rep = (await call(o.cookie, `${base}/reports/count-accuracy`)).body;
    expect(rep).toMatchObject({ postedCounts: 1, linesCounted: 2, accuracyPct: 50 });
    expect(rep.byLocation[0]).toMatchObject({ counts: 1, linesCounted: 2, linesMatched: 1, accuracyPct: 50, absVarianceUnits: 2, absVarianceCents: 200, netVarianceCents: -200 });
    expect(rep.worstItems).toEqual([expect.objectContaining({ sku: "A", linesMissed: 1, absVarianceCents: 200 })]);
    expect(rep.byMonth).toHaveLength(6);
    expect(rep.byMonth[5]).toMatchObject({ linesCounted: 2, accuracyPct: 50 });
    // Cancelled and open counts are not scored.
    const second = (await call(o.cookie, `${base}/counts`, { locationId: main })).body.id as string;
    await call(o.cookie, `${base}/counts/${second}/lines`, { itemId: a, counted: 1 }, "PUT");
    expect((await call(o.cookie, `${base}/reports/count-accuracy`)).body.postedCounts).toBe(1);
  });

  it("classes items ABC by value and says which places are due", async () => {
    const { o, base, main, shelf, mk } = await setup();
    await mk("BIG", 10, 10000); // $1000 = most of the value: class A, lives in Main
    await mk("SMALL", 10, 10, shelf); // $1: class C, lives in Shelf B
    let rep = (await call(o.cookie, `${base}/reports/count-schedule`)).body;
    expect(rep.intervals).toEqual(COUNT_INTERVALS);
    const row = (path: string) => rep.rows.find((r: { locationPath: string }) => r.locationPath === path);
    expect(row("Main")).toMatchObject({ abc: "A", intervalDays: 30, status: "never-counted", lastCountedAt: null });
    expect(row("Shelf B")).toMatchObject({ abc: "C", intervalDays: 180, status: "never-counted" });
    expect(rep.classItems).toEqual({ A: 1, B: 0, C: 1 });

    // Count Main, backdate the post: 20 days ago is fine, 40 days ago is overdue for an A place, 25 days is due soon.
    const id = (await call(o.cookie, `${base}/counts`, { locationId: main })).body.id as string;
    await call(o.cookie, `${base}/counts/${id}/post`, { zeroUncounted: false });
    const setAge = (days: number) => store.counts.updateOne({ _id: new ObjectId(id) }, { $set: { postedAt: new Date(Date.now() - days * DAY) } });
    for (const [days, status] of [[10, "ok"], [25, "due-soon"], [40, "overdue"]] as const) {
      await setAge(days);
      rep = (await call(o.cookie, `${base}/reports/count-schedule`)).body;
      expect(row("Main")).toMatchObject({ status });
    }
    expect(row("Main").daysOverdue).toBe(10);
    // Overdue and never-counted sort before the rest; an open count is flagged.
    const open = (await call(o.cookie, `${base}/counts`, { locationId: shelf })).body.id as string;
    rep = (await call(o.cookie, `${base}/reports/count-schedule`)).body;
    expect(row("Shelf B").openCountId).toBe(open);
    expect(rep.rows[0].locationPath).toBe("Main");
  });
});
