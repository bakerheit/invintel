import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { nextNumber } from "./counters.js";
import { connect, type Store } from "./db.js";
import { ObjectId } from "mongodb";

// Needs a running MongoDB (docker compose up -d). Each run uses its own throwaway database.
const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;

const call = (path: string, { method, body, cookie }: { method?: string; body?: unknown; cookie?: string } = {}) =>
  app.request(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(cookie && { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await call("/api/auth/register", {
    body: { name, email: `p${++n}@example.com`, password: "correct horse", organization },
  });
  expect(res.status).toBe(201);
  const { organization: org } = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org };
}

interface World {
  owner: Awaited<ReturnType<typeof signUp>>;
  member: Awaited<ReturnType<typeof signUp>>;
  base: string;
  post: (path: string, body: unknown, who?: "owner" | "member") => Response | Promise<Response>;
  get: (path: string, who?: "owner" | "member") => Response | Promise<Response>;
  ids: Record<string, string> & { storage: string; machine: string; finished: string; paper: string; glue: string; box: string; pallet: string };
}

async function world(): Promise<World> {
  const owner = await signUp({ mode: "create", name: "Box Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const who = (w: "owner" | "member") => (w === "owner" ? owner : member).cookie;
  const post = (path: string, body: unknown, w: "owner" | "member" = "owner") => call(`${base}${path}`, { body, cookie: who(w) });
  const get = (path: string, w: "owner" | "member" = "owner") => call(`${base}${path}`, { cookie: who(w) });
  const id = async (res: Response) => ((await res.json()) as { id: string }).id;
  const ids = {} as World["ids"];
  ids.storage = await id(await post("/locations", { name: "Roll store", type: "storage" }));
  ids.machine = await id(await post("/locations", { name: "Corrugator area", type: "production", code: "CORR-1" }));
  ids.finished = await id(await post("/locations", { name: "Finished goods", type: "finished" }));
  ids.paper = await id(await post("/items", { sku: "PAPER", name: "Kraft paper roll", tracking: "unit" }));
  ids.glue = await id(await post("/items", { sku: "GLUE", name: "Glue", initialStock: { locationId: ids.storage, quantity: 500 } }));
  ids.box = await id(await post("/items", { sku: "BOX", name: "Pizza box" }));
  ids.pallet = await id(await post("/items", { sku: "PALLET-BOX", name: "Pallet of boxes", tracking: "unit" }));
  return { owner, member, base, post, get, ids };
}

const stockAt = async (w: World, itemId: string, locationId: string) => {
  const item = await (await w.get(`/items/${itemId}`)).json();
  return (item.stock as { locationId: string; quantity: number }[]).find((s) => s.locationId === locationId)?.quantity ?? 0;
};

/** A work center, a BOM (2 paper + 1 glue per box, paper 10% scrap) and a work order for 100 boxes, released. */
async function plant(w: World, { yieldPct = 100, quantity = 100, release = true } = {}) {
  const wc = await (await w.post("/production/work-centers", { name: "Corrugator 1", code: "WC-1", locationId: w.ids.machine })).json();
  const bom = await (
    await w.post("/production/boms", {
      outputItemId: w.ids.box,
      yieldPct,
      inputs: [
        { itemId: w.ids.paper, quantity: 2, scrapPct: 10 },
        { itemId: w.ids.glue, quantity: 1 },
      ],
    })
  ).json();
  const order = await (await w.post("/production/work-orders", { outputItemId: w.ids.box, quantity, workCenterId: wc.id })).json();
  if (release) expect((await w.post(`/production/work-orders/${order.id}/action`, { action: "release" })).status).toBe(200);
  return { wc, bom, order };
}

beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});
beforeEach(async () => {
  await Promise.all(
    [store.users, store.sessions, store.orgs, store.memberships, store.locations, store.items, store.stock, store.movements, store.workCenters, store.boms, store.workOrders, store.counters, store.audit].map(
      (c) => (c as { deleteMany: (f: object) => Promise<unknown> }).deleteMany({}),
    ),
  );
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});


interface Unit { id: string; code: string; quantity: number; status: string; locationId: string }
const receiveRolls = async (w: World, quantity: number, count = 1) =>
  ((await (await w.post("/units", { itemId: w.ids.paper, locationId: w.ids.storage, quantity, count, lot: "L1" })).json()).units as Unit[]);
const unitNow = async (w: World, id: string) => (await (await w.get(`/units/${id}`)).json()) as Unit;

async function plantUnits(w: World) {
  const wc = await (await w.post("/production/work-centers", { name: "Corrugator 1", locationId: w.ids.machine })).json();
  await w.post("/production/boms", { outputItemId: w.ids.box, inputs: [{ itemId: w.ids.paper, quantity: 2 }] });
  const order = await (await w.post("/production/work-orders", { outputItemId: w.ids.box, quantity: 100, workCenterId: wc.id })).json();
  await w.post(`/production/work-orders/${order.id}/action`, { action: "release" });
  return order;
}

describe("production on unit-tracked material (rolls)", () => {
  it("marks unit-tracked requirements, and refuses quantity-style load and usage for them", async () => {
    const w = await world();
    const order = await plantUnits(w);
    expect(order.requirements[0]).toMatchObject({ itemSku: "PAPER", tracking: "unit" });
    const [roll] = await receiveRolls(w, 800);
    const base = `/production/work-orders/${order.id}`;
    const qtyLoad = await w.post(`${base}/load`, { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 5 });
    expect(qtyLoad.status).toBe(409);
    expect((await qtyLoad.json()).error).toMatch(/scan the roll/i);
    expect((await w.post(`${base}/consume`, { itemId: w.ids.paper, used: 5 })).status).toBe(409);
    expect((await w.post(`${base}/load`, { itemId: w.ids.paper })).status).toBe(400); // neither unit nor quantity
    expect(roll!.status).toBe("available");
  });

  it("load moves the whole roll to the machine; usage and scrap shrink it; the leftover goes back on the same roll", async () => {
    const w = await world();
    const order = await plantUnits(w);
    const [roll] = await receiveRolls(w, 800);
    const base = `/production/work-orders/${order.id}`;
    // the wrong material can't be loaded
    const [other] = ((await (await w.post("/units", { itemId: w.ids.pallet, locationId: w.ids.storage, quantity: 10 })).json()).units as Unit[]);
    expect((await w.post(`${base}/load`, { itemId: w.ids.paper, unitId: other!.id })).status).toBe(422);

    const load = await w.post(`${base}/load`, { itemId: w.ids.paper, unitId: roll!.id });
    expect(load.status).toBe(201);
    expect((await load.json()).workOrder.status).toBe("running");
    expect(await unitNow(w, roll!.id)).toMatchObject({ locationId: w.ids.machine, quantity: 800 });
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(800);
    expect(await stockAt(w, w.ids.paper, w.ids.storage)).toBe(0);
    expect((await w.post(`${base}/load`, { itemId: w.ids.paper, unitId: roll!.id })).status).toBe(409); // already there

    // usage must add up to what is on the roll
    expect((await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: roll!.id, used: 900 })).status).toBe(422);
    expect((await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: roll!.id, used: 500, scrap: 30, remnant: 100, remnantLocationId: w.ids.storage })).status).toBe(422); // left is 270
    const use = await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: roll!.id, used: 500, scrap: 30, remnant: 270, remnantLocationId: w.ids.storage });
    expect(use.status).toBe(201);
    expect(await unitNow(w, roll!.id)).toMatchObject({ locationId: w.ids.storage, quantity: 270, status: "available" });
    expect(await stockAt(w, w.ids.paper, w.ids.storage)).toBe(270); // the invariant: stock rows = remaining units
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(0);

    const v = await (await w.get(`${base}/variance`)).json();
    expect(v.lines[0]).toMatchObject({ loaded: 800, consumed: 500, scrapped: 30, remnant: 270, atMachine: 0 });
  });

  it("a roll used up completely is flagged consumed, and can't be loaded or used again", async () => {
    const w = await world();
    const order = await plantUnits(w);
    const [roll] = await receiveRolls(w, 100);
    const base = `/production/work-orders/${order.id}`;
    await w.post(`${base}/load`, { itemId: w.ids.paper, unitId: roll!.id });
    expect((await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: roll!.id, used: 90, scrap: 10 })).status).toBe(201);
    expect(await unitNow(w, roll!.id)).toMatchObject({ quantity: 0, status: "consumed" });
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(0);
    expect((await w.post(`${base}/load`, { itemId: w.ids.paper, unitId: roll!.id })).status).toBe(409);
    expect((await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: roll!.id, used: 1 })).status).toBe(409);
  });

  it("a roll that is partly used and has no leftover location stays loaded at the machine", async () => {
    const w = await world();
    const order = await plantUnits(w);
    const [roll] = await receiveRolls(w, 300);
    const base = `/production/work-orders/${order.id}`;
    await w.post(`${base}/load`, { itemId: w.ids.paper, unitId: roll!.id });
    await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: roll!.id, used: 100 });
    expect(await unitNow(w, roll!.id)).toMatchObject({ locationId: w.ids.machine, quantity: 200 });
    // not at the machine -> can't report usage on it
    const [far] = await receiveRolls(w, 50);
    expect((await w.post(`${base}/consume`, { itemId: w.ids.paper, unitId: far!.id, used: 10 })).status).toBe(422);
  });

  it("output of a unit-tracked item makes labelled pallets, with a short last one", async () => {
    const w = await world();
    const wc = await (await w.post("/production/work-centers", { name: "Stacker", locationId: w.ids.machine })).json();
    await w.post("/production/boms", { outputItemId: w.ids.pallet, inputs: [{ itemId: w.ids.glue, quantity: 1 }] });
    const order = await (await w.post("/production/work-orders", { outputItemId: w.ids.pallet, quantity: 60, workCenterId: wc.id })).json();
    await w.post(`/production/work-orders/${order.id}/action`, { action: "release" });
    const url = `/production/work-orders/${order.id}/output`;
    expect((await w.post(url, { good: 60, toLocationId: w.ids.finished })).status).toBe(409); // needs a unit size
    expect((await w.post(url, { good: 50, scrap: 5, unitSize: 25, toLocationId: w.ids.finished })).status).toBe(422);
    const ok = await w.post(url, { good: 60, unitSize: 25, lot: "RUN-7", toLocationId: w.ids.finished });
    expect(ok.status).toBe(201);
    expect((await ok.json()).workOrder.produced).toBe(60);
    const units = ((await (await w.get(`/units?itemId=${w.ids.pallet}`)).json()) as { units: Unit[] }).units ?? [];
    expect(units.map((u) => u.quantity).sort()).toEqual([10, 25, 25]);
    expect(await stockAt(w, w.ids.pallet, w.ids.finished)).toBe(60);
  });
});
