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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `ap${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, id: b.user.id as string, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

async function setup() {
  const owner = await signUp({ mode: "create", name: "Acme" }, "Owner");
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Mia");
  const admin = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Adam");
  const base = `/api/orgs/${owner.org.id}`;
  await call(owner.cookie, `${base}/members/${admin.id}`, { role: "admin" }, "PATCH");
  const main = (await call(owner.cookie, `${base}/locations`)).body[0].id as string;
  const item = (await call(owner.cookie, `${base}/items`, { sku: "ROLL", name: "Kraft roll", unitCostCents: 5000, initialStock: { locationId: main, quantity: 10 } })).body.id as string;
  const qty = async () => (await call(owner.cookie, `${base}/items/${item}`)).body.quantity as number;
  return { owner, member, admin, base, main, item, qty, p: `${base}/approvals` };
}

describe("approvals", () => {
  it("does nothing special until a rule exists, and only admins set rules", async () => {
    const { owner, member, base, main, item, qty, p } = await setup();
    expect((await call(member.cookie, `${base}/items/${item}/adjust`, { locationId: main, delta: -5, reason: "damaged" })).status).toBe(200);
    expect(await qty()).toBe(5);
    expect((await call(member.cookie, `${p}/rules`, { rules: [] }, "PUT")).status).toBe(403);
    expect((await call(owner.cookie, `${p}/rules`, { rules: [{ kind: "adjustment", thresholdCents: 1000, appliesTo: "members" }, { kind: "adjustment", thresholdCents: 5, appliesTo: "everyone" }] }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, `${p}/rules`, { rules: [{ kind: "adjustment", thresholdCents: 1000, appliesTo: "members" }] }, "PUT")).status).toBe(200);
    expect((await call(member.cookie, `${p}/rules`)).body.rules).toHaveLength(1);
  });

  it("holds a big adjustment for a second person, then carries it out once when approved", async () => {
    const { owner, member, admin, base, main, item, qty, p } = await setup();
    await call(owner.cookie, `${p}/rules`, { rules: [{ kind: "adjustment", thresholdCents: 10000, appliesTo: "members" }] }, "PUT");
    // $50 each: 1 unit is under the line and posts at once; 3 units ($150) waits.
    expect((await call(member.cookie, `${base}/items/${item}/adjust`, { locationId: main, delta: -1, reason: "small" })).status).toBe(200);
    expect(await qty()).toBe(9);
    const held = await call(member.cookie, `${base}/items/${item}/adjust`, { locationId: main, delta: -3, reason: "water damage" });
    expect(held.status).toBe(202);
    expect(held.body).toMatchObject({ approvalRequired: true, approval: { number: "APR-0001", status: "pending", valueCents: 15000, requestedBy: "Mia", canDecide: false } });
    expect(await qty()).toBe(9); // nothing posted yet
    const id = held.body.approval.id as string;

    // Admins see it and can decide; the member sees only their own; the requester can't approve.
    expect((await call(admin.cookie, `${p}?status=pending`)).body).toHaveLength(1);
    expect((await call(admin.cookie, `${p}/pending-count`)).body.count).toBe(1);
    expect((await call(member.cookie, `${p}/${id}/approve`, {})).status).toBe(403);
    const ok = await call(admin.cookie, `${p}/${id}/approve`, { note: "checked the photo" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "approved", decidedBy: "Adam", note: "checked the photo" });
    expect(await qty()).toBe(6);
    // It was posted as Mia, with the approver named, and can't run twice.
    const entry = (await call(owner.cookie, `${base}/movements?itemId=${item}`)).body.entries.find((e: { delta: number }) => e.delta === -3);
    expect(entry).toMatchObject({ userName: "Mia" });
    expect(entry.reason).toContain("approved by Adam");
    expect((await call(owner.cookie, `${p}/${id}/approve`, {})).status).toBe(409);
    expect(await qty()).toBe(6);
    // The audit log tells the story.
    const log = (await call(owner.cookie, `${base}/audit?limit=100`)).body.events.map((e: { action: string }) => e.action);
    expect(log).toEqual(expect.arrayContaining(["approval.requested", "approval.approved", "stock.adjusted", "approval.rules_changed"]));
  });

  it("rejection needs a reason and posts nothing; only the asker cancels; a request that can't run is marked failed", async () => {
    const { owner, member, admin, base, main, item, qty, p } = await setup();
    await call(owner.cookie, `${p}/rules`, { rules: [{ kind: "adjustment", thresholdCents: 0, appliesTo: "members" }] }, "PUT");
    const ask = async (delta: number) => (await call(member.cookie, `${base}/items/${item}/adjust`, { locationId: main, delta, reason: "x" })).body.approval.id as string;
    const a = await ask(-2);
    expect((await call(admin.cookie, `${p}/${a}/reject`, { note: "" })).status).toBe(400);
    expect((await call(admin.cookie, `${p}/${a}/reject`, { note: "count it first" })).body).toMatchObject({ status: "rejected", note: "count it first" });
    expect(await qty()).toBe(10);
    expect((await call(admin.cookie, `${p}/${a}/approve`, {})).status).toBe(409);

    const b = await ask(-2);
    expect((await call(admin.cookie, `${p}/${b}/cancel`, {})).status).toBe(409); // not the asker
    expect((await call(member.cookie, `${p}/${b}/cancel`, {})).body.status).toBe("cancelled");

    // Asked for -8, then the stock fell to 5 before approval: approving fails cleanly and leaves stock alone.
    const c = await ask(-8);
    await call(owner.cookie, `${base}/items/${item}/adjust`, { locationId: main, delta: -5, reason: "owner fix" }); // owner isn't a member so not gated
    const failed = await call(admin.cookie, `${p}/${c}/approve`, {});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ status: "failed" });
    expect(failed.body.failure).toMatch(/Only 5/);
    expect(await qty()).toBe(5);
    // Members only see their own requests.
    expect((await call(member.cookie, p)).body.every((x: { requestedBy: string }) => x.requestedBy === "Mia")).toBe(true);
  });

  it("holds a purchase order, and a sole admin can approve their own", async () => {
    const { owner, admin, member, base, item, p } = await setup();
    const supplier = (await call(owner.cookie, `${base}/purchasing/suppliers`, { name: "Mill" })).body.id as string;
    const mkOrder = async () => (await call(owner.cookie, `${base}/purchasing/orders`, { supplierId: supplier, lines: [{ itemId: item, quantity: 10, unitCostCents: 5000 }] })).body.id as string;
    await call(owner.cookie, `${p}/rules`, { rules: [{ kind: "purchase_order", thresholdCents: 20000, appliesTo: "everyone" }] }, "PUT");

    const po = await mkOrder(); // $500
    const held = await call(owner.cookie, `${base}/purchasing/orders/${po}/place`, {});
    expect(held.status).toBe(202);
    expect((await call(owner.cookie, `${base}/purchasing/orders/${po}`)).body.status).toBe("draft");
    // Asking again doesn't pile up a second request.
    expect((await call(owner.cookie, `${base}/purchasing/orders/${po}/place`, {})).body.approval.id).toBe(held.body.approval.id);
    // Two admins exist, so the owner can't approve their own; the other admin can.
    expect((await call(owner.cookie, `${p}/${held.body.approval.id}/approve`, {})).status).toBe(403);
    expect((await call(admin.cookie, `${p}/${held.body.approval.id}/approve`, {})).status).toBe(200);
    expect((await call(owner.cookie, `${base}/purchasing/orders/${po}`)).body.status).toBe("ordered");

    // With only one admin left, they may approve their own request.
    await call(owner.cookie, `${base}/members/${admin.id}`, { role: "member" }, "PATCH");
    const po2 = await mkOrder();
    const held2 = await call(owner.cookie, `${base}/purchasing/orders/${po2}/place`, {});
    expect(held2.body.approval.canDecide).toBe(true);
    const self = await call(owner.cookie, `${p}/${held2.body.approval.id}/approve`, {});
    expect(self.status).toBe(200);
    expect((await call(owner.cookie, `${base}/purchasing/orders/${po2}`)).body.status).toBe("ordered");
    void member;
  });

  it("is invisible to other organizations", async () => {
    const { p } = await setup();
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, p)).status).toBe(404);
  });
});
