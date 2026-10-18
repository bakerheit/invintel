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
  ids: Record<string, string> & { storage: string; machine: string; finished: string; paper: string; glue: string; box: string };
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
  ids.paper = await id(await post("/items", { sku: "PAPER", name: "Kraft paper", initialStock: { locationId: ids.storage, quantity: 1000 } }));
  ids.glue = await id(await post("/items", { sku: "GLUE", name: "Glue", initialStock: { locationId: ids.storage, quantity: 500 } }));
  ids.box = await id(await post("/items", { sku: "BOX", name: "Pizza box" }));
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

describe("work centers", () => {
  it("sit in a production location, are admin-only, and have unique names and codes", async () => {
    const w = await world();
    const wrong = await w.post("/production/work-centers", { name: "Nope", locationId: w.ids.storage });
    expect(wrong.status).toBe(422);
    expect((await w.post("/production/work-centers", { name: "WC", locationId: w.ids.machine }, "member")).status).toBe(403);
    const ok = await w.post("/production/work-centers", { name: "Corrugator 1", code: "WC-1", locationId: w.ids.machine });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ name: "Corrugator 1", active: true, runningOrders: 0, locationPath: "Corrugator area" });
    expect((await w.post("/production/work-centers", { name: "corrugator 1", locationId: w.ids.machine })).status).toBe(409);
    expect((await w.post("/production/work-centers", { name: "Other", code: "wc-1", locationId: w.ids.machine })).status).toBe(409);
    expect((await w.get("/production/work-centers", "member")).status).toBe(200);
  });

  it("can be renamed and switched off, but not while work orders are open on them", async () => {
    const w = await world();
    const { wc, order } = await plant(w);
    const patch = (body: unknown) => call(`${w.base}/production/work-centers/${wc.id}`, { method: "PATCH", body, cookie: w.owner.cookie });
    expect((await patch({ name: "Corrugator One" })).status).toBe(200);
    expect((await patch({ active: false })).status).toBe(409); // WO released on it
    await w.post(`/production/work-orders/${order.id}/action`, { action: "cancel" });
    const off = await patch({ active: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ name: "Corrugator One", active: false });
    // a switched-off machine takes no new work orders
    expect((await w.post("/production/work-orders", { outputItemId: w.ids.box, quantity: 5, workCenterId: wc.id })).status).toBe(422);
    expect((await call(`${w.base}/production/work-centers/${wc.id}`, { method: "PATCH", body: { active: true }, cookie: w.member.cookie })).status).toBe(403);
  });
});

describe("BOMs", () => {
  it("version per output item: a new BOM retires the active one", async () => {
    const w = await world();
    const body = { outputItemId: w.ids.box, inputs: [{ itemId: w.ids.paper, quantity: 2 }] };
    const v1 = await (await w.post("/production/boms", body)).json();
    const v2 = await (await w.post("/production/boms", { ...body, inputs: [{ itemId: w.ids.paper, quantity: 3 }] })).json();
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const active = await (await w.get("/production/boms")).json();
    expect(active.map((b: { id: string }) => b.id)).toEqual([v2.id]);
    const all = await (await w.get("/production/boms?all=1")).json();
    expect(all.map((b: { status: string }) => b.status)).toEqual(["active", "retired"]);
  });

  it("rejects bad inputs: self-reference, repeats, unknown items, members", async () => {
    const w = await world();
    const post = (inputs: object[], outputItemId = w.ids.box, who: "owner" | "member" = "owner") => w.post("/production/boms", { outputItemId, inputs }, who);
    expect((await post([{ itemId: w.ids.box, quantity: 1 }])).status).toBe(422);
    expect((await post([{ itemId: w.ids.paper, quantity: 1 }, { itemId: w.ids.paper, quantity: 2 }])).status).toBe(422);
    expect((await post([{ itemId: "0".repeat(24), quantity: 1 }])).status).toBe(404);
    expect((await post([])).status).toBe(400);
    expect((await post([{ itemId: w.ids.paper, quantity: 1 }], w.ids.box, "member")).status).toBe(403);
  });
});

describe("work orders", () => {
  it("are numbered, snapshot the BOM, and compute requirements with scrap", async () => {
    const w = await world();
    const { order, bom } = await plant(w, { release: false });
    expect(order).toMatchObject({ number: "WO-0001", status: "planned", bomVersion: 1, bomId: bom.id, produced: 0 });
    // 100 boxes x 2 paper x 1.10 = 220, 100 glue
    expect(order.requirements.map((r: { itemSku: string; expected: number }) => [r.itemSku, r.expected])).toEqual([["PAPER", 220], ["GLUE", 100]]);
    const second = await (await w.post("/production/work-orders", { bomId: bom.id, quantity: 5, workCenterId: order.workCenterId })).json();
    expect(second.number).toBe("WO-0002");
    expect((await w.post("/production/work-orders", { outputItemId: w.ids.paper, quantity: 5, workCenterId: order.workCenterId })).status).toBe(404);
  });

  it("scales requirements by the BOM's expected yield", async () => {
    const w = await world();
    const { order } = await plant(w, { yieldPct: 80, quantity: 80, release: false });
    // 80 good at 80% yield means 100 started: 220 paper, 100 glue
    expect(order.requirements.map((r: { expected: number }) => r.expected)).toEqual([220, 100]);
  });

  it("follow planned > released > running > done, and only admins release or cancel", async () => {
    const w = await world();
    const { order } = await plant(w, { release: false });
    const act = (action: string, who: "owner" | "member" = "owner") => w.post(`/production/work-orders/${order.id}/action`, { action }, who);
    const loadBody = { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 10 };
    expect((await w.post(`/production/work-orders/${order.id}/load`, loadBody)).status).toBe(409); // still planned
    expect((await act("release", "member")).status).toBe(403);
    expect((await act("complete")).status).toBe(409);
    expect((await (await act("release")).json()).status).toBe("released");
    expect((await act("release")).status).toBe(409);
    expect((await w.post(`/production/work-orders/${order.id}/load`, loadBody, "member")).status).toBe(201);
    expect((await (await w.get(`/production/work-orders/${order.id}`)).json()).status).toBe("running");
    expect((await act("cancel")).status).toBe(409); // running: complete it instead
    expect((await (await act("complete", "member")).json()).status).toBe("done");
    expect((await w.post(`/production/work-orders/${order.id}/load`, loadBody)).status).toBe(409);
  });

  it("can be cancelled before they run, and then take no floor actions", async () => {
    const w = await world();
    const { order } = await plant(w);
    expect((await (await w.post(`/production/work-orders/${order.id}/action`, { action: "cancel" })).json()).status).toBe("cancelled");
    expect((await w.post(`/production/work-orders/${order.id}/output`, { good: 1, toLocationId: w.ids.finished })).status).toBe(409);
  });

  it("are invisible to other organizations", async () => {
    const w = await world();
    const { order } = await plant(w);
    const other = await signUp({ mode: "create", name: "Other Co" });
    const res = await call(`/api/orgs/${other.org.id}/production/work-orders/${order.id}`, { cookie: other.cookie });
    expect(res.status).toBe(404);
    const foreign = await call(`/api/orgs/${w.owner.org.id}/production/work-orders/${order.id}`, { cookie: other.cookie });
    expect(foreign.status).toBe(404);
  });
});

describe("floor actions post to the ledger", () => {
  it("Load moves stock to the machine, refuses what isn't on the BOM or isn't in stock, and changes nothing on failure", async () => {
    const w = await world();
    const { order } = await plant(w);
    const url = `/production/work-orders/${order.id}/load`;
    expect((await w.post(url, { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 300 })).status).toBe(201);
    expect(await stockAt(w, w.ids.paper, w.ids.storage)).toBe(700);
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(300);
    expect((await w.post(url, { itemId: w.ids.box, fromLocationId: w.ids.storage, quantity: 1 })).status).toBe(422); // not an input
    expect((await w.post(url, { itemId: w.ids.paper, fromLocationId: w.ids.machine, quantity: 1 })).status).toBe(422); // already there
    const tooMuch = await w.post(url, { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 701 });
    expect(tooMuch.status).toBe(422);
    expect(await stockAt(w, w.ids.paper, w.ids.storage)).toBe(700);
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(300);
  });

  it("Report usage consumes, scraps and returns a remnant; it can't use more than is at the machine", async () => {
    const w = await world();
    const { order } = await plant(w);
    await w.post(`/production/work-orders/${order.id}/load`, { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 300 });
    const url = `/production/work-orders/${order.id}/consume`;
    const over = await w.post(url, { itemId: w.ids.paper, used: 200, scrap: 80, remnant: 50, remnantLocationId: w.ids.storage });
    expect(over.status).toBe(422);
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(300); // nothing half-posted
    expect((await w.post(url, { itemId: w.ids.paper, used: 10, remnant: 5 })).status).toBe(400); // remnant needs a place
    const ok = await w.post(url, { itemId: w.ids.paper, used: 200, scrap: 20, remnant: 80, remnantLocationId: w.ids.storage });
    expect(ok.status).toBe(201);
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(0);
    expect(await stockAt(w, w.ids.paper, w.ids.storage)).toBe(780); // 700 + 80 remnant
  });

  it("Report output puts good boxes in stock and books scrapped boxes in and out", async () => {
    const w = await world();
    const { order } = await plant(w);
    const res = await w.post(`/production/work-orders/${order.id}/output`, { good: 90, scrap: 6, toLocationId: w.ids.finished });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workOrder).toMatchObject({ status: "running", produced: 90 });
    expect(await stockAt(w, w.ids.box, w.ids.finished)).toBe(90);
    expect(await stockAt(w, w.ids.box, w.ids.machine)).toBe(0);
  });

  it("everything shows up in Activity with production types, and a reversal takes the whole document back", async () => {
    const w = await world();
    const { order } = await plant(w);
    await w.post(`/production/work-orders/${order.id}/load`, { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 100 });
    await w.post(`/production/work-orders/${order.id}/consume`, { itemId: w.ids.paper, used: 60, scrap: 5, remnant: 35, remnantLocationId: w.ids.storage });
    const page = await (await w.get("/movements?limit=50")).json();
    const types = new Set(page.entries.map((e: { type: string }) => e.type));
    expect([...types].sort()).toEqual(["consume", "load", "receive", "scrap", "transfer"]);
    const consume = page.entries.find((e: { type: string }) => e.type === "consume");
    const rev = await w.post(`/movements/${consume.id}/reverse`, { reason: "typo" });
    expect(rev.status).toBe(200);
    expect(await stockAt(w, w.ids.paper, w.ids.machine)).toBe(100); // all four lines undone together
    expect(await stockAt(w, w.ids.paper, w.ids.storage)).toBe(900);
    // ...and the variance no longer counts the reversed usage
    const v = await (await w.get(`/production/work-orders/${order.id}/variance`)).json();
    const paper = v.lines.find((l: { itemSku: string }) => l.itemSku === "PAPER");
    expect(paper).toMatchObject({ loaded: 100, consumed: 0, scrapped: 0, remnant: 0, atMachine: 100 });
  });

  it("writes audit events for the document types", async () => {
    const w = await world();
    const { order } = await plant(w);
    await w.post(`/production/work-orders/${order.id}/load`, { itemId: w.ids.glue, fromLocationId: w.ids.storage, quantity: 10 });
    const actions = (await store.audit.find({}).toArray()).map((e) => e.action);
    for (const a of ["work_center.created", "bom.created", "work_order.created", "work_order.released", "production.loaded"]) expect(actions).toContain(a);
  });
});

describe("variance", () => {
  it("compares what the BOM expects for the output reported against what was actually used", async () => {
    const w = await world();
    const { order } = await plant(w);
    const id = order.id;
    await w.post(`/production/work-orders/${id}/load`, { itemId: w.ids.paper, fromLocationId: w.ids.storage, quantity: 300 });
    await w.post(`/production/work-orders/${id}/load`, { itemId: w.ids.glue, fromLocationId: w.ids.storage, quantity: 120 });
    await w.post(`/production/work-orders/${id}/consume`, { itemId: w.ids.paper, used: 210, scrap: 30, remnant: 60, remnantLocationId: w.ids.storage });
    await w.post(`/production/work-orders/${id}/consume`, { itemId: w.ids.glue, used: 105 });
    await w.post(`/production/work-orders/${id}/output`, { good: 95, scrap: 5, toLocationId: w.ids.finished });
    const v = await (await w.get(`/production/work-orders/${id}/variance`)).json();
    expect(v).toMatchObject({ number: "WO-0001", planned: 100, good: 95, scrapped: 5, yieldPct: 95, basisQuantity: 100 });
    const paper = v.lines.find((l: { itemSku: string }) => l.itemSku === "PAPER");
    // 100 started x 2 x 1.10 = 220 expected; used 210 + scrap 30 = 240, so +20 (9.09%)
    expect(paper).toMatchObject({ expected: 220, consumed: 210, scrapped: 30, remnant: 60, atMachine: 0, variance: 20, variancePct: 9.09 });
    const glue = v.lines.find((l: { itemSku: string }) => l.itemSku === "GLUE");
    expect(glue).toMatchObject({ expected: 100, consumed: 105, atMachine: 15, variance: 5, variancePct: 5 });
    expect(v.worstVariancePct).toBe(9.09);

    const summary = await (await w.get("/production/variance")).json();
    expect(summary).toEqual([expect.objectContaining({ number: "WO-0001", yieldPct: 95, worstVariancePct: 9.09 })]);
  });

  it("before any output, measures against the plan", async () => {
    const w = await world();
    const { order } = await plant(w);
    const v = await (await w.get(`/production/work-orders/${order.id}/variance`)).json();
    expect(v).toMatchObject({ good: 0, yieldPct: null, basisQuantity: 100, worstVariancePct: null });
    expect(v.lines[0]).toMatchObject({ expected: 220, consumed: 0, variance: -220 });
  });
});

describe("number sequences", () => {
  it("count up per organization and kind, never repeating, even when asked at the same time", async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const nums = await Promise.all(Array.from({ length: 20 }, () => nextNumber(store, a, "po", "PO-")));
    expect(new Set(nums).size).toBe(20);
    expect([...nums].sort()[0]).toBe("PO-0001");
    expect(await nextNumber(store, a, "wo", "WO-")).toBe("WO-0001"); // another kind
    expect(await nextNumber(store, b, "po", "PO-")).toBe("PO-0001"); // another org
  });
});

describe("scan lookup", () => {
  it("resolves work order numbers and work center codes", async () => {
    const w = await world();
    const { order } = await plant(w);
    const find = async (code: string) => (await (await w.get(`/production/lookup?code=${encodeURIComponent(code)}`, "member")).json());
    expect(await find("WO-0001")).toMatchObject({ kind: "work_order", workOrder: { id: order.id } });
    expect(await find("wo1")).toMatchObject({ kind: "work_order" });
    expect(await find("wo-0099")).toEqual({ kind: "none" });
    const byCode = await find("wc-1");
    expect(byCode).toMatchObject({ kind: "work_center", workCenter: { code: "WC-1" } });
    expect(byCode.workOrders.map((o: { id: string }) => o.id)).toEqual([order.id]);
    expect((await find("Corrugator 1")).kind).toBe("work_center"); // by name too
    // finished orders are not offered for a machine
    await w.post(`/production/work-orders/${order.id}/action`, { action: "complete" });
    expect((await find("WC-1")).workOrders).toEqual([]);
    expect(await find("")).toEqual({ kind: "none" });
  });
});

describe("variance approval", () => {
  it("is off by default, then flags done orders over the threshold until an admin signs off", async () => {
    const w = await world();
    const { order } = await plant(w, { quantity: 100 });
    const id = order.id;
    await w.post(`/production/work-orders/${id}/load`, { itemId: w.ids.glue, fromLocationId: w.ids.storage, quantity: 200 });
    await w.post(`/production/work-orders/${id}/consume`, { itemId: w.ids.glue, used: 150 }); // BOM says 100: +50%
    await w.post(`/production/work-orders/${id}/output`, { good: 100, toLocationId: w.ids.finished });
    await w.post(`/production/work-orders/${id}/action`, { action: "complete" });
    const view = async () => (await (await w.get(`/production/work-orders/${id}`)).json());
    expect((await view()).approval).toBe("not_needed");
    expect((await w.post(`/production/work-orders/${id}/approve`, {})).status).toBe(409); // nothing to approve while off

    const put = (body: unknown, who: "owner" | "member" = "owner") =>
      call(`${w.base}/production/settings`, { method: "PUT", body, cookie: (who === "owner" ? w.owner : w.member).cookie });
    expect((await put({ varianceThresholdPct: 10 }, "member")).status).toBe(403);
    expect((await put({ varianceThresholdPct: -5 })).status).toBe(400);
    expect((await put({ varianceThresholdPct: 10 })).status).toBe(200);
    expect((await (await w.get("/production/settings", "member")).json()).varianceThresholdPct).toBe(10);
    expect((await view()).approval).toBe("needed");

    expect((await w.post(`/production/work-orders/${id}/approve`, { note: "ok" }, "member")).status).toBe(403);
    const ok = await w.post(`/production/work-orders/${id}/approve`, { note: "Glue pail spilled, confirmed with shift lead" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ approval: "approved", approvedBy: "Ada" });
    expect((await w.post(`/production/work-orders/${id}/approve`, {})).status).toBe(409);
    const actions = (await store.audit.find({}).toArray()).map((e) => e.action);
    expect(actions).toContain("work_order.approved");
    expect(actions).toContain("production.settings_changed");

    // turning it off clears the flag for orders not yet approved, and a raise above the variance does too
    expect((await put({ varianceThresholdPct: null })).status).toBe(200);
  });

  it("an order under the threshold, or not done, never needs approval", async () => {
    const w = await world();
    const { order } = await plant(w, { quantity: 100 });
    await call(`${w.base}/production/settings`, { method: "PUT", body: { varianceThresholdPct: 10 }, cookie: w.owner.cookie });
    expect((await (await w.get(`/production/work-orders/${order.id}`)).json()).approval).toBe("not_needed"); // not done
    expect((await w.post(`/production/work-orders/${order.id}/approve`, {})).status).toBe(409);
  });
});
