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
    body: JSON.stringify({ name, email: `ar${++n}@example.com`, password: "correct horse", organization }),
  });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization as { id: string; joinCode: string } };
}

function client(cookie: string, orgId: string) {
  const base = `/api/orgs/${orgId}`;
  const raw = (path: string, body?: unknown, method?: string) =>
    app.request(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await raw(path, body, method);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { base, raw, json };
}

/** An organization with a bit of everything: places, items, a kg item, rolls, a PO, a count, a recipe, a work order, an import and a reversal. */
async function richOrg() {
  const owner = await signUp({ mode: "create", name: "Source Plant" });
  const c = client(owner.cookie, owner.org.id);
  const id = async (path: string, body: unknown) => (await c.json(path, body)).body.id as string;

  const main = (await c.json("/locations")).body[0].id as string;
  const plant = await id("/locations", { name: "Plant 1", type: "storage" });
  const bin = await id("/locations", { name: "Bin A", type: "storage", parentId: plant, code: "BIN-A" });
  const machine = await id("/locations", { name: "Line 1", type: "production", parentId: plant });

  const bolt = await id("/items", { sku: "BOLT", name: "Bolt M8", barcodes: ["4006381333931"], unitCostCents: 15, reorderLevel: 20, initialStock: { locationId: main, quantity: 100 } });
  const resin = await id("/items", { sku: "RESIN", name: "PET resin", unit: "kg", decimals: 3, unitCostCents: 120, altUnits: [{ name: "bag", factor: "25" }] });
  const paper = await id("/items", { sku: "ROLL", name: "Paper roll", tracking: "unit" });
  const box = await id("/items", { sku: "BOX", name: "Box" });

  await c.json(`/items/${resin}/adjust`, { locationId: bin, delta: 128055, reason: "Delivery" });
  await c.json(`/items/${bolt}/transfer`, { fromLocationId: main, toLocationId: bin, quantity: 30 });
  const rolls = (await c.json("/units", { itemId: paper, locationId: bin, quantity: 800, count: 2, lot: "L-7" })).body;

  const supplier = await id("/purchasing/suppliers", { name: "Chem Co", email: "a@chem.test" });
  const po = (await c.json("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: resin, quantity: 25500, unitCostCents: 110 }] })).body;
  await c.json(`/purchasing/orders/${po.id}/place`, {});
  await c.json(`/purchasing/orders/${po.id}/receive`, { locationId: bin, lines: [{ itemId: resin, quantity: 10500 }] });

  const count = (await c.json("/counts", { locationId: bin })).body;
  await c.json(`/counts/${count.id}/lines`, { itemId: bolt, counted: 29 }, "PUT");

  const wc = (await c.json("/production/work-centers", { name: "Press 1", code: "WC-1", locationId: machine })).body;
  await c.json("/production/boms", { outputItemId: box, inputs: [{ itemId: bolt, quantity: 2, scrapPct: 0 }] });
  const wo = (await c.json("/production/work-orders", { outputItemId: box, quantity: 10, workCenterId: wc.id })).body;

  await c.json("/data/items/import", { csv: "sku,name,quantity,location\nIMPORTED,From a file,12,Main", dryRun: false, filename: "start.csv" });

  // One ledger line reversed, so reversal links have to survive too.
  const mv = (await c.json(`/items/${bolt}/adjust`, { locationId: main, delta: -5, reason: "oops" })).body;
  const activity = (await c.json("/movements?limit=5")).body.entries as { id: string; reason: string }[];
  await c.json(`/movements/${activity.find((e) => e.reason === "oops")!.id}/reverse`, {});

  await store.orgs.updateOne({ _id: new ObjectId(owner.org.id) }, { $set: { modules: { production: true, purchasing: true }, scrapReasons: ["Jam", "Torn"], approvalRules: [{ kind: "adjustment", thresholdCents: 5000, appliesTo: "members" }] } });
  return { owner, c, ids: { main, plant, bin, machine, bolt, resin, paper, box, supplier, wo: wo.id as string, po: po.id as string }, rolls, mv };
}

const download = async (c: ReturnType<typeof client>) => {
  const res = await c.raw("/data/archive.json");
  return { res, archive: res.status === 200 ? await res.json() : null };
};

describe("full-data archive", () => {
  it("restores everything into an empty organization, with new ids and exact numbers", async () => {
    const src = await richOrg();
    const { res, archive } = await download(src.c);
    expect(res.headers.get("content-disposition")).toMatch(/invintel-archive-source-plant-\d{4}-\d{2}-\d{2}\.json/);
    expect(archive).toMatchObject({ format: "invintel-archive", version: 1, organizationName: "Source Plant" });
    expect(archive.counts.items).toBe(5); // BOLT, RESIN, ROLL, BOX, IMPORTED
    expect(archive.counts.units).toBe(2);
    expect(archive.data.items.every((d: Record<string, unknown>) => !("orgId" in d))).toBe(true);

    const dst = await signUp({ mode: "create", name: "Fresh Org" });
    const t = client(dst.cookie, dst.org.id);
    const check = await t.json("/data/archive/restore", { archive, dryRun: true });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ dryRun: true, blocked: null, organizationName: "Source Plant" });
    expect((await t.json("/items")).body).toHaveLength(0); // a check changes nothing

    const done = await t.json("/data/archive/restore", { archive, dryRun: false });
    expect(done.status).toBe(201);
    expect(done.body.counts).toEqual(archive.counts);

    // Items: same fields, new ids.
    const srcItems = (await src.c.json("/items")).body as { id: string; sku: string }[];
    const dstItems = (await t.json("/items")).body as typeof srcItems;
    expect(dstItems.map((i) => i.sku).sort()).toEqual(srcItems.map((i) => i.sku).sort());
    for (const s of srcItems) {
      const d = dstItems.find((i) => i.sku === s.sku)! as Record<string, unknown>;
      expect(d.id).not.toBe(s.id);
      const { id: _a, createdAt: _b, updatedAt: _c, stock: srcStock, ...srcRest } = s as Record<string, unknown>;
      const { id: _d, createdAt: _e, updatedAt: _f, stock: dstStock, ...dstRest } = d;
      expect(dstRest).toEqual(srcRest);
      expect((dstStock as unknown[]).length).toBe((srcStock as unknown[]).length);
    }
    expect(dstItems.find((i) => i.sku === "RESIN")).toMatchObject({ unit: "kg", decimals: 3, quantity: 128055 + 10500, altUnits: [{ name: "bag", factor: "25" }] });

    // Places keep their tree, and stock sits in the same places by path.
    const paths = async (c: ReturnType<typeof client>) => ((await c.json("/locations")).body as { path: string; code: string; type: string }[]).map((l) => `${l.path}|${l.code}|${l.type}`).sort();
    expect(await paths(t)).toEqual(await paths(src.c));
    const stockByPath = async (c: ReturnType<typeof client>) => {
      const locs = new Map(((await c.json("/locations")).body as { id: string; path: string }[]).map((l) => [l.id, l.path]));
      const items = (await c.json("/items")).body as { sku: string; stock: { locationId: string; quantity: number }[] }[];
      return items.flatMap((i) => i.stock.map((s) => `${i.sku}@${locs.get(s.locationId)}=${s.quantity}`)).sort();
    };
    expect(await stockByPath(t)).toEqual(await stockByPath(src.c));

    // The ledger came across whole: same lines, same totals, links intact (transfer pairs, the reversal).
    const ledger = async (orgId: string) => store.movements.find({ orgId: new ObjectId(orgId) }).toArray();
    const sm = await ledger(src.owner.org.id);
    const dm = await ledger(dst.org.id);
    expect(dm).toHaveLength(sm.length);
    expect(dm.reduce((s, m) => s + m.delta, 0)).toBe(sm.reduce((s, m) => s + m.delta, 0));
    const pair = new Map<string, number>();
    for (const m of dm) if (m.transferId) pair.set(m.transferId.toHexString(), (pair.get(m.transferId.toHexString()) ?? 0) + 1);
    expect([...pair.values()]).toEqual([2]);
    const reversed = dm.find((m) => m.reversedBy);
    expect(dm.find((m) => m.reversalOf?.equals(reversed!._id))?._id.equals(reversed!.reversedBy!)).toBe(true);
    const srcIds = new Set(sm.map((m) => m._id.toHexString()));
    expect(dm.some((m) => srcIds.has(m._id.toHexString()))).toBe(false);

    // Rolls, order, count, recipe and work order keep pointing at the right things.
    const units = (await t.json("/units")).body.units as { code: string; itemSku: string; lot: string; quantity: number; locationPath: string }[];
    expect(units.map((u) => `${u.code}:${u.itemSku}:${u.lot}:${u.quantity}:${u.locationPath}`).sort()).toEqual(
      src.rolls.units.map((u: { code: string; itemSku: string; lot: string; quantity: number; locationPath: string }) => `${u.code}:${u.itemSku}:${u.lot}:${u.quantity}:${u.locationPath}`).sort(),
    );
    const orders = (await t.json("/purchasing/orders")).body as { number: string; status: string; totalCents: number; lines: { itemSku: string; quantity: number; received: number }[] }[];
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ number: "PO-0001", status: "partial", totalCents: 2805, lines: [{ itemSku: "RESIN", quantity: 25500, received: 10500 }] });
    expect((await t.json("/counts")).body).toHaveLength(1);
    const wos = (await t.json("/production/work-orders")).body as { number: string; outputSku?: string; outputItemName?: string }[];
    expect(wos).toHaveLength(1);
    expect(wos[0]!.number).toBe((await src.c.json("/production/work-orders")).body[0].number);

    // Settings, numbering and the audit trail.
    const org = (await store.orgs.findOne({ _id: new ObjectId(dst.org.id) }))!;
    expect(org).toMatchObject({ scrapReasons: ["Jam", "Torn"], approvalRules: [{ kind: "adjustment", thresholdCents: 5000, appliesTo: "members" }] });
    expect(org.joinCode).toBe(dst.org.joinCode); // never taken from the archive
    const supplier = (await t.json("/purchasing/suppliers")).body[0].id;
    const second = (await t.json("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: dstItems.find((i) => i.sku === "BOLT")!.id, quantity: 1, unitCostCents: 1 }] })).body;
    expect(second.number).toBe("PO-0002");
    const more = (await t.json("/units", { itemId: dstItems.find((i) => i.sku === "ROLL")!.id, locationId: (await t.json("/locations")).body[0].id, quantity: 5 })).body;
    expect(more.units[0].code).toBe("U-000003");
    const audit = (await t.json("/audit")).body.events as { action: string; summary: string }[];
    expect(audit.some((e) => e.action === "archive.restored" && /Source Plant/.test(e.summary))).toBe(true);
    expect((await t.json("/audit/verify")).body.ok).toBe(true);
    expect(((await src.c.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "archive.exported")).toBe(true);
  });

  it("an archive of an archive is the same data", async () => {
    const src = await richOrg();
    const first = (await download(src.c)).archive;
    const dst = await signUp({ mode: "create", name: "Copy" });
    const t = client(dst.cookie, dst.org.id);
    expect((await t.json("/data/archive/restore", { archive: first, dryRun: false })).status).toBe(201);
    const second = (await download(t)).archive;
    expect(second.counts).toEqual(first.counts);
    expect(second.settings).toEqual(first.settings);
    const strip = (docs: Record<string, unknown>[]) => docs.map((d) => String(d.sku ?? d.name ?? d.code ?? d.number ?? "")).sort();
    for (const name of ["items", "suppliers", "locations", "purchaseOrders", "units"]) expect(strip(second.data[name])).toEqual(strip(first.data[name]));
  });

  it("only restores into an organization with nothing in it, and only for its owner", async () => {
    const src = await richOrg();
    const { archive } = await download(src.c);
    // Back into itself.
    const self = await src.c.json("/data/archive/restore", { archive, dryRun: false });
    expect(self.status).toBe(409);
    expect(self.body.error).toMatch(/already has/);
    expect((await src.c.json("/data/archive/restore", { archive, dryRun: true })).body.blocked).toMatch(/already has/);

    const dst = await signUp({ mode: "create", name: "Empty" });
    const member = await signUp({ mode: "join", joinCode: dst.org.joinCode }, "Bob");
    expect((await client(member.cookie, dst.org.id).json("/data/archive/restore", { archive, dryRun: false })).status).toBe(403);
    expect((await client(member.cookie, dst.org.id).raw("/data/archive.json")).status).toBe(403);
    expect((await client(dst.cookie, dst.org.id).raw("/data/archive.json")).status).toBe(200);
    const stranger = await signUp({ mode: "create", name: "Elsewhere" });
    expect((await client(stranger.cookie, dst.org.id).raw("/data/archive.json")).status).toBe(404);
    expect((await client(dst.cookie, dst.org.id).json("/items")).body).toHaveLength(0);
  });

  describe("refuses anything that isn't a clean archive", () => {
    const fresh = async () => {
      const dst = await signUp({ mode: "create", name: "Target" });
      const t = client(dst.cookie, dst.org.id);
      const post = (archive: unknown) => t.json("/data/archive/restore", { archive, dryRun: false });
      const untouched = async () => {
        expect((await t.json("/items")).body).toHaveLength(0);
        expect((await t.json("/locations")).body.length).toBeGreaterThan(0); // the starting location is still there
      };
      return { t, post, untouched, orgId: dst.org.id };
    };
    const base = (data: Record<string, unknown[]> = {}, extra: object = {}) => ({
      format: "invintel-archive", version: 1, exportedAt: "2026-10-18T00:00:00.000Z", organizationName: "X", settings: {}, data, ...extra,
    });
    const oid = (c: string) => ({ $oid: c.repeat(24) });
    const when = { $date: "2026-10-01T00:00:00.000Z" };
    const item = (c: string, sku: string, extra: object = {}) => ({ _id: oid(c), sku, name: sku, reorderLevel: 0, unitCostCents: 0, createdAt: when, updatedAt: when, ...extra });

    it("not an archive, wrong version, unknown data", async () => {
      const f = await fresh();
      expect((await f.post({ hello: "world" })).status).toBe(400);
      expect((await f.post("nope")).status).toBe(400);
      expect((await f.post(base({}, { version: 2 }))).body.error).toMatch(/version 2/);
      expect((await f.post(base({ passwords: [] }))).body.error).toMatch(/doesn't know about/);
      expect((await f.post(base({}, { settings: { joinCode: "AAAAAAAA" } }))).body.error).toMatch(/setting this version doesn't know/);
      expect((await f.post(base({}, { settings: { modules: { purchasing: "yes" } } }))).body.error).toMatch(/isn't valid/);
      await f.untouched();
    });

    it("operators and odd field names", async () => {
      const f = await fresh();
      expect((await f.post(base({ items: [item("a", "X", { $where: "1" })] }))).body.error).toMatch(/field name that isn't allowed/);
      expect((await f.post(base({ items: [item("a", "X", { "a.b": 1 })] }))).body.error).toMatch(/isn't allowed/);
      expect((await f.post(base({ items: [item("a", "X", { nested: { $ne: 1 } })] }))).body.error).toMatch(/isn't allowed/);
      expect((await f.post(base({ items: [item("a", "X", { __proto__x: 1, ["__proto__"]: { y: 1 } })] }))).status).toBe(400);
      expect((await f.post(base({ items: [item("a", "X", { at: { $date: "not a date" } })] }))).body.error).toMatch(/date/);
      expect((await f.post(base({ items: [item("a", "X", { ref: { $oid: "xyz" } })] }))).body.error).toMatch(/id that isn't valid/);
      await f.untouched();
    });

    it("missing or wrong-typed fields, ids that repeat", async () => {
      const f = await fresh();
      expect((await f.post(base({ items: [{ _id: oid("a"), name: "No SKU" }] }))).body.error).toMatch(/missing "sku"/);
      expect((await f.post(base({ items: [item("a", "X", { createdAt: "yesterday" })] }))).body.error).toMatch(/"createdAt"/);
      expect((await f.post(base({ items: [item("a", "X", { reorderLevel: "ten" })] }))).body.error).toMatch(/"reorderLevel"/);
      expect((await f.post(base({ items: [{ sku: "X", name: "x", reorderLevel: 0, unitCostCents: 0 }] }))).body.error).toMatch(/no valid id/);
      expect((await f.post(base({ items: [item("a", "X"), item("a", "Y")] }))).body.error).toMatch(/appears twice/);
      expect((await f.post(base({ stock: [{ _id: oid("b"), itemId: "plain string", locationId: oid("c"), quantity: 1 }] }))).body.error).toMatch(/"itemId"/);
      await f.untouched();
    });

    it("can't point at another organization's records", async () => {
      const other = await richOrg();
      const foreign = (await other.c.json("/items")).body[0].id as string;
      const f = await fresh();
      const archive = base({
        items: [item("a", "MINE")],
        suppliers: [{ _id: oid("b"), name: "S", createdAt: when }],
        purchaseOrders: [{ _id: oid("c"), number: "PO-0001", state: "ordered", supplierId: oid("b"), lines: [{ itemId: { $oid: foreign }, quantity: 5, unitCostCents: 1 }], createdAt: when, updatedAt: when }],
      });
      expect((await f.post(archive)).status).toBe(201);
      const po = (await f.t.json("/purchasing/orders")).body[0];
      expect(po.lines[0].itemId).not.toBe(foreign);
      expect(po.lines[0].itemName).toBe("Deleted item"); // it points at nothing, not at the other organization's item
      // Ids that came with the file are never reused.
      const mine = (await f.t.json("/items")).body[0].id;
      expect(mine).not.toBe("a".repeat(24));
      // The other organization is untouched.
      expect(((await other.c.json("/items")).body as unknown[]).length).toBe(5);
    });

    it("leaves nothing half-restored if the database says no", async () => {
      const f = await fresh();
      // Two items with the same SKU: valid-looking, but the unique index refuses the second.
      const res = await f.post(base({ locations: [{ _id: oid("1"), name: "Dock", description: "", createdAt: when, updatedAt: when }], items: [item("a", "DUP"), item("b", "dup")] }));
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/nothing was restored/);
      await f.untouched();
      expect(((await f.t.json("/locations")).body as { name: string }[]).some((l) => l.name === "Dock")).toBe(false);
      // And it can be tried again once the file is fixed.
      expect((await f.post(base({ items: [item("a", "ONE"), item("b", "TWO")] }))).status).toBe(201);
    });
  });
});
