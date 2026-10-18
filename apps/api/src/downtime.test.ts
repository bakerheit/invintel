import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { minutesWithin } from "./downtime.js";

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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `dt${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const MIN = 60_000;

async function setup() {
  const owner = await signUp({ mode: "create", name: "Acme" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Op");
  const base = `/api/orgs/${owner.org.id}`;
  const locs = (await call(owner.cookie, `${base}/locations`)).body;
  const prod = (await call(owner.cookie, `${base}/locations`, { name: "Line", type: "production", code: "LINE" })).body.id as string;
  const wc = async (name: string) => (await call(owner.cookie, `${base}/production/work-centers`, { name, locationId: prod })).body.id as string;
  void locs;
  return { owner, member, base, wc, d: `${base}/production/downtime` };
}

describe("minutesWithin", () => {
  it("clips an event to the window and counts a running one up to now", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const from = new Date("2026-10-18T00:00:00Z");
    const t = (s: string) => new Date(s);
    expect(minutesWithin({ startedAt: t("2026-10-17T23:00:00Z"), endedAt: t("2026-10-18T01:00:00Z") }, from, now, now)).toBe(60); // starts before the window
    expect(minutesWithin({ startedAt: t("2026-10-18T10:00:00Z") }, from, now, now)).toBe(120); // still running
    expect(minutesWithin({ startedAt: t("2026-10-17T01:00:00Z"), endedAt: t("2026-10-17T02:00:00Z") }, from, now, now)).toBe(0);
  });
});

describe("downtime", () => {
  it("lets an operator start and end downtime, one open per machine, from a short reason list", async () => {
    const { owner, member, base, wc, d } = await setup();
    const press = await wc("Press 1");
    expect((await call(member.cookie, `${d}/start`, { workCenterId: press, reason: "Lunch" })).status).toBe(400); // not on the list
    const start = await call(member.cookie, `${d}/start`, { workCenterId: press, reason: "breakdown", note: "belt snapped" });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ reason: "Breakdown", workCenterName: "Press 1", endedAt: null, startedBy: "Op" });
    const again = await call(owner.cookie, `${d}/start`, { workCenterId: press, reason: "Changeover" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("already down");
    expect((await call(member.cookie, `${d}?open=1`)).body).toHaveLength(1);
    const end = await call(owner.cookie, `${d}/${start.body.id}/end`, {});
    expect(end.status).toBe(200);
    expect(end.body).toMatchObject({ endedBy: "Ada" });
    expect(end.body.endedAt).not.toBeNull();
    expect((await call(owner.cookie, `${d}/${start.body.id}/end`, {})).status).toBe(409);
    expect((await call(member.cookie, `${d}?open=1`)).body).toHaveLength(0);
    // Down again after being back up is fine; other organizations can't touch it.
    expect((await call(member.cookie, `${d}/start`, { workCenterId: press, reason: "Changeover" })).status).toBe(201);
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `${d}/start`, { workCenterId: press, reason: "Breakdown" })).status).toBe(404);
    const log = (await call(owner.cookie, `${base}/audit?limit=50`)).body.events.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(["downtime.started", "downtime.ended"]));
  });

  it("admins set the reason list and the scheduled hours; members can't", async () => {
    const { owner, member, d } = await setup();
    expect((await call(member.cookie, `${d}/settings`)).body.reasons).toContain("Breakdown");
    expect((await call(member.cookie, `${d}/settings`, { reasons: ["A"], scheduledHoursPerDay: 8 }, "PUT")).status).toBe(403);
    expect((await call(owner.cookie, `${d}/settings`, { reasons: ["A", "a"], scheduledHoursPerDay: 8 }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, `${d}/settings`, { reasons: ["Jam", "Clean"], scheduledHoursPerDay: 16 }, "PUT")).status).toBe(200);
    expect((await call(member.cookie, `${d}/settings`)).body).toEqual({ reasons: ["Jam", "Clean"], scheduledHoursPerDay: 16 });
  });

  it("summarizes lost minutes, availability and the biggest reasons over a window", async () => {
    const { owner, base, wc, d } = await setup();
    const a = await wc("Press A");
    const b = await wc("Press B");
    await call(owner.cookie, `${d}/settings`, { reasons: ["Breakdown", "Changeover"], scheduledHoursPerDay: 10 }, "PUT");
    const org = new ObjectId(owner.org.id);
    const now = Date.now();
    const ev = (wcId: string, reason: string, startMinAgo: number, endMinAgo: number | null) => store.downtime.insertOne({
      _id: new ObjectId(), orgId: org, workCenterId: new ObjectId(wcId), reason, note: "", startedAt: new Date(now - startMinAgo * MIN),
      ...(endMinAgo === null ? { open: true as const } : { endedAt: new Date(now - endMinAgo * MIN) }), startedBy: { id: new ObjectId(), name: "x" },
    });
    await ev(a, "Breakdown", 600, 540); // 60 min
    await ev(a, "Changeover", 300, 270); // 30 min
    await ev(b, "Breakdown", 120, 60); // 60 min
    await ev(b, "Changeover", 10, null); // running for ~10 min
    await ev(a, "Breakdown", 10 * 24 * 60, 10 * 24 * 60 - 500); // 10 days ago: outside a 7-day window
    const s = (await call(owner.cookie, `${d}/summary?days=7`)).body;
    expect(s).toMatchObject({ windowDays: 7, scheduledHoursPerDay: 10 });
    const rowA = s.rows.find((r: { name: string }) => r.name === "Press A");
    expect(rowA).toMatchObject({ events: 2, downMinutes: 90, scheduledMinutes: 7 * 10 * 60, topReason: "Breakdown", downNow: null });
    expect(rowA.availabilityPct).toBeCloseTo((1 - 90 / 4200) * 100, 1);
    const rowB = s.rows.find((r: { name: string }) => r.name === "Press B");
    expect(rowB.downMinutes).toBeGreaterThanOrEqual(69);
    expect(rowB.downMinutes).toBeLessThanOrEqual(71);
    expect(rowB.downNow).toMatchObject({ reason: "Changeover" });
    expect(s.byReason[0]).toMatchObject({ reason: "Breakdown", minutes: 120 });
    expect(s.totalDownMinutes).toBe(s.rows.reduce((t: number, r: { downMinutes: number }) => t + r.downMinutes, 0));
    // A longer window picks up the old event.
    expect((await call(owner.cookie, `${d}/summary?days=30`)).body.rows.find((r: { name: string }) => r.name === "Press A").events).toBe(3);
    void base;
  });
});
