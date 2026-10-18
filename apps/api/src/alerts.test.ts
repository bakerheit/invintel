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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `al${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, id: b.user.id as string, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const DAY = 86_400_000;
const MIN = 60_000;

async function setup() {
  const owner = await signUp({ mode: "create", name: "Acme" }, "Owner");
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Mia");
  const base = `/api/orgs/${owner.org.id}`;
  const main = (await call(owner.cookie, `${base}/locations`)).body[0].id as string;
  const mk = async (sku: string, qty: number, reorderLevel = 0) => (await call(owner.cookie, `${base}/items`, { sku, name: sku, reorderLevel, unitCostCents: 100, ...(qty ? { initialStock: { locationId: main, quantity: qty } } : {}) })).body.id as string;
  const alerts = async (cookie = owner.cookie) => (await call(cookie, `${base}/alerts`)).body as { alerts: { key: string; type: string; severity: string; state: string; by: string | null; title: string }[]; open: { critical: number; warning: number; total: number } };
  return { owner, member, base, main, mk, alerts, a: `${base}/alerts` };
}

describe("alerts", () => {
  it("is quiet when nothing is wrong, and flags out of stock and low stock", async () => {
    const { mk, alerts } = await setup();
    await mk("FINE", 50, 10);
    expect((await alerts()).alerts).toEqual([]);
    const out = await mk("EMPTY", 0, 5);
    const low = await mk("LOW", 4, 10);
    const res = await alerts();
    const by = Object.fromEntries(res.alerts.map((x) => [x.type, x]));
    expect(by.out_of_stock).toMatchObject({ key: `out_of_stock:${out}`, severity: "critical", state: "open" });
    expect(by.low_stock).toMatchObject({ key: `low_stock:${low}`, severity: "warning" });
    expect(res.open).toEqual({ critical: 1, warning: 1, total: 2 });
    expect(res.alerts[0]!.severity).toBe("critical"); // critical sorts first
  });

  it("warns when an item is being used up faster than it will last", async () => {
    const { owner, mk, alerts } = await setup();
    const roll = await mk("ROLL", 5);
    const slow = await mk("SLOW", 500);
    const org = new ObjectId(owner.org.id);
    const used = (itemId: string, qty: number) => store.movements.insertOne({ _id: new ObjectId(), orgId: org, type: "consume", itemId: new ObjectId(itemId), locationId: new ObjectId(), delta: -qty, reason: "run", userName: "x", createdAt: new Date(Date.now() - 5 * DAY) });
    await used(roll, 30); // 1 a day over 30 days; 5 on hand = 5 days
    await used(slow, 30); // 500 on hand = 500 days
    const res = (await alerts()).alerts.filter((x) => x.type === "days_of_supply");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ key: `days_of_supply:${roll}` });
    expect(res[0]!.title).toContain("5 days");
  });

  it("flags purchase orders past their date, machines down too long, and places overdue for a count", async () => {
    const { owner, base, main, mk, alerts } = await setup();
    const item = await mk("PAPER", 100);
    const supplier = (await call(owner.cookie, `${base}/purchasing/suppliers`, { name: "Mill" })).body.id as string;
    const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    const order = async (expectedDate: string) => {
      const id = (await call(owner.cookie, `${base}/purchasing/orders`, { supplierId: supplier, expectedDate, lines: [{ itemId: item, quantity: 5, unitCostCents: 100 }] })).body.id as string;
      await call(owner.cookie, `${base}/purchasing/orders/${id}/place`, {});
      return id;
    };
    const future = await order(day(3));
    const late = await order(day(-2));
    const veryLate = await order(day(-10));
    const lateAlerts = (await alerts()).alerts.filter((x) => x.type === "late_po");
    expect(lateAlerts.map((x) => x.key).sort()).toEqual([`late_po:${late}`, `late_po:${veryLate}`].sort());
    expect(lateAlerts.find((x) => x.key === `late_po:${veryLate}`)!.severity).toBe("critical");
    expect(lateAlerts.find((x) => x.key === `late_po:${late}`)!.severity).toBe("warning");
    void future;

    // A machine down for 30 minutes is fine; 90 is a problem.
    const prod = (await call(owner.cookie, `${base}/locations`, { name: "Line", type: "production", code: "LINE" })).body.id as string;
    const wc = (await call(owner.cookie, `${base}/production/work-centers`, { name: "Press 1", locationId: prod })).body.id as string;
    const org = new ObjectId(owner.org.id);
    await store.downtime.insertOne({ _id: new ObjectId(), orgId: org, workCenterId: new ObjectId(wc), reason: "Breakdown", note: "", open: true, startedAt: new Date(Date.now() - 30 * MIN), startedBy: { id: new ObjectId(), name: "Op" } });
    expect((await alerts()).alerts.some((x) => x.type === "machine_down")).toBe(false);
    await store.downtime.updateOne({ orgId: org }, { $set: { startedAt: new Date(Date.now() - 90 * MIN) } });
    expect((await alerts()).alerts.find((x) => x.type === "machine_down")).toMatchObject({ key: `machine_down:${wc}`, severity: "critical" });

    // A place counted long ago is overdue; one being counted right now isn't flagged.
    const cnt = (await call(owner.cookie, `${base}/counts`, { locationId: main })).body.id as string;
    await call(owner.cookie, `${base}/counts/${cnt}/post`, {});
    await store.counts.updateOne({ _id: new ObjectId(cnt) }, { $set: { postedAt: new Date(Date.now() - 60 * DAY) } });
    expect((await alerts()).alerts.find((x) => x.type === "count_overdue")).toMatchObject({ key: `count_overdue:${main}` });
    await call(owner.cookie, `${base}/counts`, { locationId: main });
    expect((await alerts()).alerts.some((x) => x.type === "count_overdue")).toBe(false);
  });

  it("acknowledge and snooze stick to the problem, and the problem coming back is new", async () => {
    const { owner, member, base, main, mk, alerts, a } = await setup();
    const low = await mk("LOW", 2, 10);
    const key = `low_stock:${low}`;
    expect((await call(member.cookie, `${a}/acknowledge`, { key })).body).toMatchObject({ state: "acknowledged", by: "Mia" });
    expect((await alerts(owner.cookie)).alerts[0]).toMatchObject({ state: "acknowledged", by: "Mia" });
    expect((await alerts()).open.total).toBe(0);
    expect((await call(owner.cookie, `${a}/reopen`, { key })).body.state).toBe("open");

    const snoozed = await call(owner.cookie, `${a}/snooze`, { key, days: 3 });
    expect(snoozed.body.state).toBe("snoozed");
    expect(new Date(snoozed.body.snoozedUntil).getTime()).toBeGreaterThan(Date.now() + 2 * DAY);
    // The snooze runs out.
    await store.alertStates.updateOne({ key }, { $set: { until: new Date(Date.now() - 1000) } });
    expect((await alerts()).alerts[0]!.state).toBe("open");

    // Acknowledge, fix the stock (the alert goes away and the memory with it), let it run low again: open again.
    await call(owner.cookie, `${a}/acknowledge`, { key });
    await call(owner.cookie, `${base}/receipts`, { itemId: low, locationId: main, quantity: 100 });
    expect((await alerts()).alerts).toEqual([]);
    await call(owner.cookie, `${base}/items/${low}/adjust`, { locationId: main, delta: -100, reason: "gone" });
    expect((await alerts()).alerts[0]).toMatchObject({ key, state: "open" });
    // A key that isn't a live problem can't be acknowledged.
    expect((await call(owner.cookie, `${a}/acknowledge`, { key: "low_stock:" + "a".repeat(24) })).status).toBe(404);
    const log = (await call(owner.cookie, `${base}/audit?limit=100`)).body.events.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(["alert.acknowledged", "alert.snoozed", "alert.reopened"]));
  });

  it("writes a digest preview, honours settings, and respects modules and membership", async () => {
    const { owner, member, base, mk, a } = await setup();
    expect((await call(owner.cookie, `${a}/digest`)).body.subject).toContain("nothing needs attention");
    await mk("EMPTY", 0, 5);
    await mk("LOW", 3, 10);
    const d = (await call(member.cookie, `${a}/digest`)).body;
    expect(d.subject).toBe("Acme: 2 things need attention (1 urgent)");
    expect(d.sections.map((s: { title: string }) => s.title)).toEqual(["Needs action now", "Keep an eye on"]);
    expect(d.text).toContain("EMPTY is out of stock");

    expect((await call(member.cookie, `${a}/settings`, { daysOfSupply: 3, machineDownMinutes: 30 }, "PUT")).status).toBe(403);
    expect((await call(owner.cookie, `${a}/settings`, { daysOfSupply: 0, machineDownMinutes: 30 }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, `${a}/settings`, { daysOfSupply: 3, machineDownMinutes: 30 }, "PUT")).status).toBe(200);
    expect((await call(member.cookie, `${a}/settings`)).body).toEqual({ daysOfSupply: 3, machineDownMinutes: 30 });
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, a)).status).toBe(404);
    void base;
  });
});
