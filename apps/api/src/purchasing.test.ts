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
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `p${++n}@example.com`, password: "correct horse", organization }),
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
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

async function setup() {
  const owner = await signUp({ mode: "create", name: "Acme" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const main = (await call(owner.cookie, `${base}/locations`)).body[0].id as string;
  const kraft = (await call(owner.cookie, `${base}/items`, { sku: "KRAFT", name: "Kraft roll", unitCostCents: 48000, reorderLevel: 10, initialStock: { locationId: main, quantity: 4 } })).body.id as string;
  const glue = (await call(owner.cookie, `${base}/items`, { sku: "GLUE", name: "Glue", unitCostCents: 250, reorderLevel: 5, initialStock: { locationId: main, quantity: 20 } })).body.id as string;
  const supplier = (await call(owner.cookie, `${base}/purchasing/suppliers`, { name: "Paper Mill Co", email: "orders@example.com" })).body.id as string;
  return { owner, member, base, main, kraft, glue, supplier, p: `${base}/purchasing` };
}

describe("purchasing", () => {
  it("suppliers: admin writes, anyone reads, names are unique", async () => {
    const { owner, member, p } = await setup();
    expect((await call(member.cookie, `${p}/suppliers`, { name: "Nope" })).status).toBe(403);
    expect((await call(owner.cookie, `${p}/suppliers`, { name: "paper mill co" })).status).toBe(409);
    const list = await call(member.cookie, `${p}/suppliers`);
    expect(list.body.map((s: { name: string }) => s.name)).toEqual(["Paper Mill Co"]);
    expect((await call(owner.cookie, `${p}/suppliers/${list.body[0].id}`, { phone: "555-0100" }, "PATCH")).body.phone).toBe("555-0100");
  });

  it("walks an order through draft, placed, partial, received, with arrivals read from the ledger", async () => {
    const { owner, member, base, main, kraft, glue, supplier, p } = await setup();
    const po = (await call(owner.cookie, `${p}/orders`, { supplierId: supplier, expectedDate: "2026-11-01", lines: [{ itemId: kraft, quantity: 10, unitCostCents: 47000 }, { itemId: glue, quantity: 40, unitCostCents: 240 }] })).body;
    expect(po).toMatchObject({ number: "PO-0001", status: "draft", totalCents: 10 * 47000 + 40 * 240, orderedUnits: 50 });

    // Can't receive a draft; members can't place or create.
    expect((await call(member.cookie, `${p}/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: kraft, quantity: 1 }] })).status).toBe(409);
    expect((await call(member.cookie, `${p}/orders/${po.id}/place`, {})).status).toBe(403);
    expect((await call(owner.cookie, `${p}/orders/${po.id}/place`, {})).body.status).toBe("ordered");
    // Placed: lines are frozen.
    expect((await call(owner.cookie, `${p}/orders/${po.id}`, { lines: [{ itemId: kraft, quantity: 1, unitCostCents: 1 }] }, "PATCH")).status).toBe(409);

    // A member (the dock) receives part of it.
    const r1 = await call(member.cookie, `${p}/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: kraft, quantity: 6 }] });
    expect(r1.status).toBe(201);
    expect(r1.body.order).toMatchObject({ status: "partial", receivedUnits: 6 });
    expect((await call(owner.cookie, `${base}/items/${kraft}`)).body.quantity).toBe(10);

    // Reversing that receipt in Activity takes it off the order again.
    const entry = (await call(owner.cookie, `${base}/movements?itemId=${kraft}`)).body.entries.find((e: { delta: number; type: string }) => e.delta === 6 && e.type === "receive");
    expect((await call(owner.cookie, `${base}/movements/${entry.id}/reverse`, { reason: "wrong PO" })).status).toBe(200);
    expect((await call(owner.cookie, `${p}/orders/${po.id}`)).body).toMatchObject({ status: "ordered", receivedUnits: 0 });

    // Receive everything, with some over-shipped glue.
    const r2 = await call(owner.cookie, `${p}/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: kraft, quantity: 10 }, { itemId: glue, quantity: 45 }] });
    expect(r2.body.order.status).toBe("received");
    expect(r2.body.overReceived).toEqual([{ itemId: glue, itemName: "Glue", over: 5 }]);
    expect((await call(owner.cookie, `${p}/orders/${po.id}/receive`, { locationId: main, lines: [{ itemId: kraft, quantity: 1 }] }, "POST")).body.order?.status ?? "refused").toBe("received"); // received orders still accept (supplier sent more)
  });

  it("cancel, close short, and validation", async () => {
    const { owner, main, kraft, glue, supplier, p } = await setup();
    const make = async (lines: object[]) => (await call(owner.cookie, `${p}/orders`, { supplierId: supplier, lines })).body;
    const a = await make([{ itemId: kraft, quantity: 5, unitCostCents: 100 }]);
    await call(owner.cookie, `${p}/orders/${a.id}/place`, {});
    expect((await call(owner.cookie, `${p}/orders/${a.id}/close`, {})).status).toBe(409); // nothing arrived
    expect((await call(owner.cookie, `${p}/orders/${a.id}/cancel`, {})).body.status).toBe("cancelled");
    expect((await call(owner.cookie, `${p}/orders/${a.id}/place`, {})).status).toBe(409);

    const b = await make([{ itemId: kraft, quantity: 5, unitCostCents: 100 }, { itemId: glue, quantity: 5, unitCostCents: 10 }]);
    await call(owner.cookie, `${p}/orders/${b.id}/place`, {});
    await call(owner.cookie, `${p}/orders/${b.id}/receive`, { locationId: main, lines: [{ itemId: kraft, quantity: 5 }] });
    expect((await call(owner.cookie, `${p}/orders/${b.id}/cancel`, {})).status).toBe(409); // some arrived
    const closed = await call(owner.cookie, `${p}/orders/${b.id}/close`, {});
    expect(closed.body).toMatchObject({ status: "received", closedShort: true });

    expect((await call(owner.cookie, `${p}/orders`, { supplierId: supplier, lines: [] })).status).toBe(400);
    expect((await call(owner.cookie, `${p}/orders`, { supplierId: supplier, lines: [{ itemId: kraft, quantity: 1, unitCostCents: 1 }, { itemId: kraft, quantity: 1, unitCostCents: 1 }] })).status).toBe(400);
    expect((await call(owner.cookie, `${p}/orders`, { supplierId: "a".repeat(24), lines: [{ itemId: kraft, quantity: 1, unitCostCents: 1 }] })).status).toBe(400);
    const c = await make([{ itemId: kraft, quantity: 5, unitCostCents: 100 }]);
    await call(owner.cookie, `${p}/orders/${c.id}/place`, {});
    expect((await call(owner.cookie, `${p}/orders/${c.id}/receive`, { locationId: main, lines: [{ itemId: glue, quantity: 1 }] })).status).toBe(400); // not on the order
    expect((await call(owner.cookie, `${p}/orders/${c.id}/receive`, { locationId: "b".repeat(24), lines: [{ itemId: kraft, quantity: 1 }] })).status).toBe(404);
  });

  it("suggests reorders, counts what is already on order, and builds a draft from them", async () => {
    const { owner, member, kraft, glue, supplier, p } = await setup();
    // Kraft has 4 of reorder 10 -> suggest 16. Glue has 20 of 5: fine.
    const s1 = (await call(member.cookie, `${p}/suggestions`)).body;
    expect(s1).toEqual([expect.objectContaining({ itemId: kraft, quantity: 4, reorderLevel: 10, onOrder: 0, suggestedQuantity: 16 })]);
    const draft = await call(owner.cookie, `${p}/orders/from-suggestions`, { supplierId: supplier, itemIds: [kraft, glue] });
    expect(draft.status).toBe(201);
    expect(draft.body.lines).toHaveLength(1);
    expect(draft.body.lines[0]).toMatchObject({ itemId: kraft, quantity: 16, unitCostCents: 48000 });
    // Drafts don't count as on order; placing it does, so nothing more is suggested.
    expect((await call(owner.cookie, `${p}/suggestions`)).body[0].onOrder).toBe(0);
    await call(owner.cookie, `${p}/orders/${draft.body.id}/place`, {});
    expect((await call(owner.cookie, `${p}/suggestions`)).body).toEqual([]);
    expect((await call(owner.cookie, `${p}/orders/from-suggestions`, { supplierId: supplier, itemIds: [kraft] })).status).toBe(400);
  });

  it("is invisible to other organizations", async () => {
    const { p } = await setup();
    const other = await signUp({ mode: "create", name: "Other" });
    expect((await call(other.cookie, `${p}/orders`)).status).toBe(404);
  });

  it("only orders what is actually running low, and a receive in progress blocks cancel and close", async () => {
    const { owner, glue, kraft, supplier, p } = await setup();
    // Glue has 20 of reorder 5, so it is not on the suggestion list and can't be ordered through it.
    const res = await call(owner.cookie, `${p}/orders/from-suggestions`, { supplierId: supplier, itemIds: [glue] });
    expect(res.status).toBe(400);

    const po = (await call(owner.cookie, `${p}/orders`, { supplierId: supplier, lines: [{ itemId: kraft, quantity: 5, unitCostCents: 100 }] })).body;
    await call(owner.cookie, `${p}/orders/${po.id}/place`, {});
    // Pretend a receive is mid-flight: its lease is still valid.
    await store.purchaseOrders.updateOne({ _id: new ObjectId(po.id) }, { $set: { receivingUntil: new Date(Date.now() + 20_000) } });
    expect((await call(owner.cookie, `${p}/orders/${po.id}/cancel`, {})).status).toBe(409);
    // An expired lease (a receive that died) doesn't block forever.
    await store.purchaseOrders.updateOne({ _id: new ObjectId(po.id) }, { $set: { receivingUntil: new Date(Date.now() - 1000) } });
    expect((await call(owner.cookie, `${p}/orders/${po.id}/cancel`, {})).body.status).toBe("cancelled");
  });
});
