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
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `c${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

async function setup() {
  const owner = await signUp({ mode: "create", name: "Acme" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const main = (await call(owner.cookie, `${base}/locations`)).body[0].id as string;
  const mk = async (sku: string, qty: number, cost: number) => (await call(owner.cookie, `${base}/items`, { sku, name: sku, unitCostCents: cost, initialStock: { locationId: main, quantity: qty } })).body.id as string;
  const a = await mk("A", 10, 100);
  const b = await mk("B", 5, 200);
  const c = await mk("C", 8, 300);
  return { owner, member, base, main, a, b, c, p: `${base}/counts` };
}

describe("cycle counts", () => {
  it("members count, an admin reviews and posts the differences through the ledger", async () => {
    const { owner, member, base, main, a, b, c, p } = await setup();
    const started = await call(member.cookie, p, { locationId: main });
    expect(started).toMatchObject({ status: 201, body: { number: "CNT-0001", status: "open" } });
    const id = started.body.id as string;
    // A second start at the same place continues the same sheet.
    expect((await call(owner.cookie, p, { locationId: main })).body.id).toBe(id);

    await call(member.cookie, `${p}/${id}/lines`, { itemId: a, counted: 8 }, "PUT"); // short by 2
    await call(member.cookie, `${p}/${id}/lines`, { itemId: b, counted: 5 }, "PUT"); // matches
    const again = await call(member.cookie, `${p}/${id}/lines`, { itemId: a, counted: 9 }, "PUT"); // recount replaces
    expect(again.body.lines).toHaveLength(2);
    expect(again.body.summary).toMatchObject({ counted: 2, matched: 1, under: 1, over: 0, netUnits: -1, netCents: -100 });
    expect(again.body.uncounted).toEqual([expect.objectContaining({ itemId: c, expected: 8 })]);

    // Counting doesn't change stock; only an admin can post.
    expect((await call(owner.cookie, `${base}/items/${a}`)).body.quantity).toBe(10);
    expect((await call(member.cookie, `${p}/${id}/post`, {})).status).toBe(403);

    const posted = await call(owner.cookie, `${p}/${id}/post`, {});
    expect(posted.status).toBe(200);
    expect(posted.body.adjustments).toBe(1);
    expect((await call(owner.cookie, `${base}/items/${a}`)).body.quantity).toBe(9);
    expect((await call(owner.cookie, `${base}/items/${c}`)).body.quantity).toBe(8); // uncounted left alone
    // Posted counts keep what the system said at the time, and can't be posted or edited again.
    const view = (await call(owner.cookie, `${p}/${id}`)).body;
    expect(view.status).toBe("posted");
    expect(view.lines.find((l: { itemId: string }) => l.itemId === a)).toMatchObject({ expected: 10, counted: 9, variance: -1 });
    expect((await call(owner.cookie, `${p}/${id}/post`, {})).status).toBe(409);
    expect((await call(member.cookie, `${p}/${id}/lines`, { itemId: a, counted: 1 }, "PUT")).status).toBe(409);
    // The adjustment is in Activity and reversible like any other.
    const entry = (await call(owner.cookie, `${base}/movements?itemId=${a}`)).body.entries.find((e: { reason: string }) => e.reason === "Count CNT-0001");
    expect(entry).toMatchObject({ delta: -1, type: "adjust" });
    expect((await call(owner.cookie, `${base}/movements/${entry.id}/reverse`, {})).status).toBe(200);
    // And a new count can start at the same place afterwards.
    expect((await call(owner.cookie, p, { locationId: main })).body.number).toBe("CNT-0002");
  });

  it("can write off what nobody counted, and cancelling leaves stock alone", async () => {
    const { owner, member, base, main, a, c, p } = await setup();
    const id = (await call(owner.cookie, p, { locationId: main })).body.id as string;
    await call(owner.cookie, `${p}/${id}/lines`, { itemId: a, counted: 10 }, "PUT");
    const posted = await call(owner.cookie, `${p}/${id}/post`, { zeroUncounted: true });
    expect(posted.body.adjustments).toBe(2); // B and C written off
    expect((await call(owner.cookie, `${base}/items/${c}`)).body.quantity).toBe(0);

    const second = (await call(owner.cookie, p, { locationId: main })).body.id as string;
    expect((await call(owner.cookie, `${p}/${second}/cancel`, {})).body.status).toBe("cancelled");
    expect((await call(owner.cookie, `${base}/items/${a}`)).body.quantity).toBe(10);
    void member;
  });

  it("only the starter or an admin cancels; validation; other orgs see nothing", async () => {
    const { owner, member, main, a, p } = await setup();
    const id = (await call(owner.cookie, p, { locationId: main })).body.id as string;
    expect((await call(member.cookie, `${p}/${id}/cancel`, {})).status).toBe(403);
    expect((await call(owner.cookie, `${p}/${id}/lines`, { itemId: a, counted: -1 }, "PUT")).status).toBe(400);
    expect((await call(owner.cookie, `${p}/${id}/lines`, { itemId: "a".repeat(24), counted: 1 }, "PUT")).status).toBe(404);
    expect((await call(owner.cookie, p, { locationId: "b".repeat(24) })).status).toBe(404);
    const stranger = await signUp({ mode: "create", name: "Other" });
    expect((await call(stranger.cookie, p)).status).toBe(404);
  });
});
