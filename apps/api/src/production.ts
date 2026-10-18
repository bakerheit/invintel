import { zValidator } from "@hono/zod-validator";
import {
  bomInputSchema,
  consumeInputSchema,
  loadInputSchema,
  objectIdSchema,
  outputInputSchema,
  workCenterInputSchema,
  workCenterUpdateSchema,
  workOrderActionSchema,
  workOrderInputSchema,
  workOrderStatusSchema,
  type Bom,
  type MovementType,
  type VarianceLine,
  type VarianceSummaryRow,
  type WorkCenter,
  type WorkOrder,
  type WorkOrderVariance,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import {
  duplicateField,
  isDuplicateKey,
  type BomDoc,
  type MovementDoc,
  type Store,
  type WorkCenterDoc,
  type WorkOrderDoc,
} from "./db.js";
import { auditActor, recordAudit } from "./audit.js";
import { actorOf } from "./items.js";
import { indexLocations, loadLocations } from "./locations.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { changeStock, logMovement, quantityAt, type Actor } from "./stock-service.js";

const idParam = z.object({ id: objectIdSchema });
const round2 = (n: number) => Math.round(n * 100) / 100;
const oid = (s: string) => new ObjectId(s);

type Fail = { ok: false; status: 404 | 409 | 422; error: string };
const fail = (status: Fail["status"], error: string): Fail => ({ ok: false, status, error });

// ---------- planning math ----------

/** Input needed to START `started` units of output, with the line's expected scrap on top. */
export const expectedInput = (bom: Pick<BomDoc, "outputQuantity">, line: { quantity: number; scrapPct: number }, started: number) =>
  (started / bom.outputQuantity) * line.quantity * (1 + line.scrapPct / 100);

/** To get `good` units out you have to start more when the BOM expects some output loss. */
export const startedFor = (bom: Pick<BomDoc, "yieldPct">, good: number) => good / (bom.yieldPct / 100);

// ---------- ledger posting ----------

interface Line {
  type: MovementType;
  itemId: ObjectId;
  locationId: ObjectId;
  delta: number;
  reason: string;
}

/**
 * Posts the lines of one production document. Removals go first (they can fail), and if anything
 * fails the stock changes already made are put back. All lines share a group id so the Activity
 * screen reverses them together.
 */
async function postLines(store: Store, orgId: ObjectId, actor: Actor, wo: WorkOrderDoc, lines: Line[]) {
  const ordered = [...lines].filter((l) => l.delta !== 0).sort((a, b) => a.delta - b.delta);
  const applied: Line[] = [];
  const unwind = () => Promise.all(applied.map((l) => changeStock(store, orgId, l.itemId, l.locationId, -l.delta)));
  try {
    for (const l of ordered) {
      if ((await changeStock(store, orgId, l.itemId, l.locationId, l.delta)) === null) {
        await unwind();
        const [loc, item] = await Promise.all([
          store.locations.findOne({ _id: l.locationId }),
          store.items.findOne({ _id: l.itemId }),
        ]);
        const have = await quantityAt(store, orgId, l.itemId, l.locationId);
        return fail(422, `Only ${have} of ${item?.name ?? "that item"} at ${loc?.name ?? "that location"}`);
      }
      applied.push(l);
    }
  } catch (e) {
    await unwind();
    throw e;
  }
  const group = new ObjectId();
  const ids: ObjectId[] = [];
  for (const l of ordered) {
    ids.push(await logMovement(store, { orgId, ...l, transferId: group, workOrderId: wo._id, actor }));
  }
  return { ok: true as const, movementIds: ids };
}

// ---------- read models ----------

async function loadItemNames(store: Store, ids: ObjectId[]) {
  const items = await store.items.find({ _id: { $in: ids } }, { projection: { sku: 1, name: 1 } }).toArray();
  return new Map(items.map((i) => [i._id.toHexString(), i]));
}

const toBom = async (store: Store, docs: BomDoc[]): Promise<Bom[]> => {
  const names = await loadItemNames(store, [...new Set(docs.flatMap((b) => [b.outputItemId, ...b.inputs.map((i) => i.itemId)]).map(String))].map(oid));
  return docs.map((b) => ({
    id: b._id.toHexString(),
    outputItemId: b.outputItemId.toHexString(),
    outputItemSku: names.get(b.outputItemId.toHexString())?.sku ?? "",
    outputItemName: names.get(b.outputItemId.toHexString())?.name ?? "Deleted item",
    outputQuantity: b.outputQuantity,
    yieldPct: b.yieldPct,
    note: b.note,
    version: b.version,
    status: b.status,
    inputs: b.inputs.map((i) => ({
      itemId: i.itemId.toHexString(),
      itemSku: names.get(i.itemId.toHexString())?.sku ?? "",
      itemName: names.get(i.itemId.toHexString())?.name ?? "Deleted item",
      quantity: i.quantity,
      scrapPct: i.scrapPct,
    })),
    createdAt: b.createdAt.toISOString(),
  }));
};

/** What the ledger says happened on a work order. Reversed lines and reversals don't count. */
async function actuals(store: Store, wo: WorkOrderDoc, centerLocationId: ObjectId) {
  const rows = await store.movements.find({ workOrderId: wo._id, reversedBy: { $exists: false } }).toArray();
  const byItem = new Map<string, { loaded: number; consumed: number; scrapped: number; remnant: number; produced: number }>();
  const slot = (m: MovementDoc) => {
    const k = m.itemId.toHexString();
    if (!byItem.has(k)) byItem.set(k, { loaded: 0, consumed: 0, scrapped: 0, remnant: 0, produced: 0 });
    return byItem.get(k)!;
  };
  for (const m of rows) {
    const t = m.type;
    const s = slot(m);
    if (t === "load" && m.delta > 0) s.loaded += m.delta;
    else if (t === "consume" && m.delta < 0) s.consumed -= m.delta;
    else if (t === "scrap" && m.delta < 0) s.scrapped -= m.delta;
    else if (t === "produce" && m.delta > 0) s.produced += m.delta;
    // A remnant is the half of a transfer that lands somewhere other than the machine.
    else if (t === "transfer" && m.delta > 0 && !m.locationId.equals(centerLocationId)) s.remnant += m.delta;
  }
  const out = byItem.get(wo.outputItemId.toHexString());
  const scrappedOut = out?.scrapped ?? 0; // output scrap is posted as produce + scrap at the machine
  return { byItem, good: Math.max(0, (out?.produced ?? 0) - scrappedOut), scrappedOutput: scrappedOut };
}

async function toWorkOrder(store: Store, docs: WorkOrderDoc[]): Promise<WorkOrder[]> {
  const centers = await store.workCenters.find({ _id: { $in: docs.map((d) => d.workCenterId) } }).toArray();
  const centerById = new Map(centers.map((c) => [c._id.toHexString(), c]));
  const names = await loadItemNames(store, [...new Set(docs.flatMap((d) => [d.outputItemId, ...d.requirements.map((r) => r.itemId)]).map(String))].map(oid));
  return Promise.all(
    docs.map(async (d) => {
      const center = centerById.get(d.workCenterId.toHexString());
      const a = center ? await actuals(store, d, center.locationId) : { good: 0 };
      return {
        id: d._id.toHexString(),
        number: d.number,
        status: d.status,
        bomId: d.bomId.toHexString(),
        bomVersion: d.bomVersion,
        outputItemId: d.outputItemId.toHexString(),
        outputItemSku: names.get(d.outputItemId.toHexString())?.sku ?? "",
        outputItemName: names.get(d.outputItemId.toHexString())?.name ?? "Deleted item",
        quantity: d.quantity,
        workCenterId: d.workCenterId.toHexString(),
        workCenterName: center?.name ?? "Deleted work center",
        dueDate: d.dueDate,
        note: d.note,
        requirements: d.requirements.map((r) => ({
          itemId: r.itemId.toHexString(),
          itemSku: names.get(r.itemId.toHexString())?.sku ?? "",
          itemName: names.get(r.itemId.toHexString())?.name ?? "Deleted item",
          expected: r.expected,
        })),
        produced: a.good,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      };
    }),
  );
}

async function varianceOf(store: Store, wo: WorkOrderDoc): Promise<WorkOrderVariance> {
  const bom = (await store.boms.findOne({ _id: wo.bomId }))!;
  const center = (await store.workCenters.findOne({ _id: wo.workCenterId }))!;
  const a = await actuals(store, wo, center.locationId);
  const reported = a.good + a.scrappedOutput;
  // Compare against what the BOM says this much output should have used. Before any output, against the plan.
  const started = reported > 0 ? reported : startedFor(bom, wo.quantity);
  const names = await loadItemNames(store, bom.inputs.map((i) => i.itemId));
  const lines: VarianceLine[] = bom.inputs.map((line) => {
    const k = line.itemId.toHexString();
    const s = a.byItem.get(k) ?? { loaded: 0, consumed: 0, scrapped: 0, remnant: 0, produced: 0 };
    const expected = round2(expectedInput(bom, line, started));
    const variance = round2(s.consumed + s.scrapped - expected);
    return {
      itemId: k,
      itemSku: names.get(k)?.sku ?? "",
      itemName: names.get(k)?.name ?? "Deleted item",
      expected,
      loaded: s.loaded,
      consumed: s.consumed,
      scrapped: s.scrapped,
      remnant: s.remnant,
      atMachine: s.loaded - s.consumed - s.scrapped - s.remnant,
      variance,
      variancePct: expected > 0 ? round2((variance / expected) * 100) : null,
    };
  });
  const pcts = lines.filter((l) => l.variancePct !== null && l.consumed + l.scrapped > 0).map((l) => Math.abs(l.variancePct!));
  return {
    workOrderId: wo._id.toHexString(),
    number: wo.number,
    status: wo.status,
    basisQuantity: round2(started),
    planned: wo.quantity,
    good: a.good,
    scrapped: a.scrappedOutput,
    yieldPct: reported > 0 ? round2((a.good / reported) * 100) : null,
    expectedYieldPct: bom.yieldPct,
    lines,
    worstVariancePct: pcts.length ? Math.max(...pcts) : null,
  };
}

// ---------- routes ----------

export function createProductionRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  // ----- work centers -----

  const toCenters = async (orgId: ObjectId, docs: WorkCenterDoc[]): Promise<WorkCenter[]> => {
    const locations = indexLocations(await loadLocations(store, orgId));
    const running = await store.workOrders
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { orgId, status: "running" } },
        { $group: { _id: "$workCenterId", n: { $sum: 1 } } },
      ])
      .toArray();
    const runningBy = new Map(running.map((x) => [x._id.toHexString(), x.n]));
    return docs.map((c) => ({
      id: c._id.toHexString(),
      name: c.name,
      code: c.code,
      description: c.description,
      locationId: c.locationId.toHexString(),
      locationPath: locations.pathOf(c.locationId.toHexString()),
      active: c.active,
      runningOrders: runningBy.get(c._id.toHexString()) ?? 0,
      createdAt: c.createdAt.toISOString(),
    }));
  };

  const productionLocation = async (orgId: ObjectId, id: string): Promise<Fail | null> => {
    const loc = await store.locations.findOne({ _id: oid(id), orgId });
    if (!loc) return fail(404, "Location not found");
    if ((loc.type ?? "storage") !== "production") return fail(422, "A work center sits in a production-area location. Make or pick one under Locations.");
    return null;
  };

  r.get("/work-centers", async (c) => {
    const orgId = c.get("org")._id;
    return c.json(await toCenters(orgId, await store.workCenters.find({ orgId }).sort({ name: 1 }).toArray()));
  });

  r.post("/work-centers", requireRole("admin"), zValidator("json", workCenterInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const bad = await productionLocation(orgId, input.locationId);
    if (bad) return c.json({ error: bad.error }, bad.status as 404 | 422);
    const doc: WorkCenterDoc = { _id: new ObjectId(), orgId, ...input, locationId: oid(input.locationId), createdAt: new Date() };
    try {
      await store.workCenters.insertOne(doc);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return c.json({ error: duplicateField(e) === "code" ? "Another work center already uses that code" : "A work center with that name already exists" }, 409);
    }
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: "work_center.created",
      entity: { type: "work_center", id: doc._id.toHexString(), label: doc.name },
      summary: `Created work center ${doc.name}`,
      snapshot: { name: doc.name, code: doc.code, active: doc.active },
    });
    return c.json((await toCenters(orgId, [doc]))[0], 201);
  });

  r.patch("/work-centers/:id", requireRole("admin"), zValidator("param", idParam), zValidator("json", workCenterUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { locationId, ...rest } = c.req.valid("json");
    if (locationId) {
      const bad = await productionLocation(orgId, locationId);
      if (bad) return c.json({ error: bad.error }, bad.status as 404 | 422);
    }
    try {
      const doc = await store.workCenters.findOneAndUpdate(
        { _id: oid(c.req.valid("param").id), orgId },
        { $set: { ...rest, ...(locationId ? { locationId: oid(locationId) } : {}) } },
        { returnDocument: "after" },
      );
      if (!doc) return c.json({ error: "Work center not found" }, 404);
      await recordAudit(store, {
        orgId,
        actor: auditActor(c.get("user")),
        action: "work_center.updated",
        entity: { type: "work_center", id: doc._id.toHexString(), label: doc.name },
        summary: `Edited work center ${doc.name}${rest.active === false ? " (switched off)" : ""}`,
        snapshot: { ...rest, ...(locationId ? { locationId } : {}) },
      });
      return c.json((await toCenters(orgId, [doc]))[0]);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return c.json({ error: duplicateField(e) === "code" ? "Another work center already uses that code" : "A work center with that name already exists" }, 409);
    }
  });

  // ----- BOMs -----

  r.get("/boms", zValidator("query", z.object({ outputItemId: objectIdSchema.optional(), all: z.string().optional() })), async (c) => {
    const orgId = c.get("org")._id;
    const { outputItemId, all } = c.req.valid("query");
    const filter = { orgId, ...(outputItemId ? { outputItemId: oid(outputItemId) } : {}), ...(all ? {} : { status: "active" as const }) };
    return c.json(await toBom(store, await store.boms.find(filter).sort({ outputItemId: 1, version: -1 }).toArray()));
  });

  r.get("/boms/:id", zValidator("param", idParam), async (c) => {
    const doc = await store.boms.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id });
    return doc ? c.json((await toBom(store, [doc]))[0]) : c.json({ error: "BOM not found" }, 404);
  });

  /** Posting a BOM for an item that already has one makes the next version and retires the old one. */
  r.post("/boms", requireRole("admin"), zValidator("json", bomInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const itemIds = [input.outputItemId, ...input.inputs.map((i) => i.itemId)].map(oid);
    const found = await store.items.countDocuments({ orgId, _id: { $in: itemIds } });
    if (found !== new Set(itemIds.map(String)).size) return c.json({ error: "One of those items doesn't exist" }, 404);
    const inputIds = input.inputs.map((i) => i.itemId);
    if (inputIds.includes(input.outputItemId)) return c.json({ error: "An item can't be an input to itself" }, 422);
    if (new Set(inputIds).size !== inputIds.length) return c.json({ error: "List each input item once" }, 422);

    const latest = await store.boms.find({ orgId, outputItemId: oid(input.outputItemId) }).sort({ version: -1 }).limit(1).toArray();
    const doc: BomDoc = {
      _id: new ObjectId(),
      orgId,
      outputItemId: oid(input.outputItemId),
      outputQuantity: input.outputQuantity,
      yieldPct: input.yieldPct,
      inputs: input.inputs.map((i) => ({ itemId: oid(i.itemId), quantity: i.quantity, scrapPct: i.scrapPct })),
      note: input.note,
      version: (latest[0]?.version ?? 0) + 1,
      status: "active",
      createdAt: new Date(),
    };
    try {
      await store.boms.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: "Someone saved a BOM for this item at the same time. Try again." }, 409);
      throw e;
    }
    await store.boms.updateMany({ orgId, outputItemId: doc.outputItemId, _id: { $ne: doc._id }, status: "active" }, { $set: { status: "retired" } });
    const saved = (await toBom(store, [doc]))[0]!;
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: "bom.created",
      entity: { type: "bom", id: doc._id.toHexString(), label: `${saved.outputItemName} v${doc.version}` },
      summary: `Saved BOM version ${doc.version} for ${saved.outputItemName}`,
      snapshot: { version: doc.version, outputQuantity: doc.outputQuantity, yieldPct: doc.yieldPct, inputs: saved.inputs.map((i) => ({ item: i.itemName, quantity: i.quantity, scrapPct: i.scrapPct })) },
    });
    return c.json(saved, 201);
  });

  // ----- work orders -----

  const loadOrder = (orgId: ObjectId, id: string) => store.workOrders.findOne({ _id: oid(id), orgId });

  r.get("/work-orders", zValidator("query", z.object({ status: z.string().optional() })), async (c) => {
    const orgId = c.get("org")._id;
    const wanted = (c.req.valid("query").status ?? "").split(",").filter((s) => workOrderStatusSchema.safeParse(s).success);
    const docs = await store.workOrders
      .find({ orgId, ...(wanted.length ? { status: { $in: wanted as WorkOrderDoc["status"][] } } : {}) })
      .sort({ _id: -1 })
      .limit(200)
      .toArray();
    return c.json(await toWorkOrder(store, docs));
  });

  r.get("/work-orders/:id", zValidator("param", idParam), async (c) => {
    const doc = await loadOrder(c.get("org")._id, c.req.valid("param").id);
    return doc ? c.json((await toWorkOrder(store, [doc]))[0]) : c.json({ error: "Work order not found" }, 404);
  });

  r.post("/work-orders", requireRole("admin"), zValidator("json", workOrderInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const bom = input.bomId
      ? await store.boms.findOne({ _id: oid(input.bomId), orgId })
      : await store.boms.findOne({ orgId, outputItemId: oid(input.outputItemId!), status: "active" });
    if (!bom) return c.json({ error: input.bomId ? "BOM not found" : "That item has no active BOM yet" }, 404);
    const center = await store.workCenters.findOne({ _id: oid(input.workCenterId), orgId });
    if (!center) return c.json({ error: "Work center not found" }, 404);
    if (!center.active) return c.json({ error: "That work center is switched off" }, 422);

    const started = startedFor(bom, input.quantity);
    const counter = await store.counters.findOneAndUpdate({ _id: `${orgId.toHexString()}:wo` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
    const now = new Date();
    const doc: WorkOrderDoc = {
      _id: new ObjectId(),
      orgId,
      number: `WO-${String(counter!.seq).padStart(4, "0")}`,
      status: "planned",
      bomId: bom._id,
      bomVersion: bom.version,
      outputItemId: bom.outputItemId,
      quantity: input.quantity,
      workCenterId: center._id,
      dueDate: input.dueDate,
      note: input.note,
      requirements: bom.inputs.map((i) => ({ itemId: i.itemId, expected: round2(expectedInput(bom, i, started)) })),
      createdAt: now,
      updatedAt: now,
    };
    await store.workOrders.insertOne(doc);
    const made = (await toWorkOrder(store, [doc]))[0]!;
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: "work_order.created",
      entity: { type: "work_order", id: doc._id.toHexString(), label: doc.number },
      summary: `Created ${doc.number}: ${doc.quantity} x ${made.outputItemName} at ${center.name}`,
      snapshot: { quantity: doc.quantity, bomVersion: doc.bomVersion, workCenter: center.name, dueDate: doc.dueDate },
    });
    return c.json(made, 201);
  });

  /** release / complete / cancel. Starting (running) happens by itself with the first floor action. */
  r.post("/work-orders/:id/action", zValidator("param", idParam), zValidator("json", workOrderActionSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { action } = c.req.valid("json");
    if (action !== "complete" && c.get("role") === "member") return c.json({ error: "You need to be an admin of this organization to do that" }, 403);
    const wo = await loadOrder(orgId, c.req.valid("param").id);
    if (!wo) return c.json({ error: "Work order not found" }, 404);
    const from: Record<typeof action, WorkOrderDoc["status"][]> = { release: ["planned"], complete: ["released", "running"], cancel: ["planned", "released"] };
    const to = { release: "released", complete: "done", cancel: "cancelled" } as const;
    if (!from[action].includes(wo.status)) {
      return c.json({ error: `A ${wo.status} work order can't be ${action}d${action === "cancel" && wo.status === "running" ? ". Complete it instead." : ""}` }, 409);
    }
    const updated = await store.workOrders.findOneAndUpdate(
      { _id: wo._id, status: wo.status },
      { $set: { status: to[action], updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) return c.json({ error: "Someone else just changed this work order" }, 409);
    const verb = { release: "released", complete: "completed", cancel: "cancelled" } as const;
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: `work_order.${verb[action]}`,
      entity: { type: "work_order", id: wo._id.toHexString(), label: wo.number },
      summary: `${wo.number} ${verb[action]}`,
      changes: [{ field: "status", from: wo.status, to: to[action] }],
    });
    return c.json((await toWorkOrder(store, [updated]))[0]);
  });

  // ----- floor actions -----

  /** Shared by Load, Report usage and Report output: the order must be open and its machine known. */
  const openOrder = async (orgId: ObjectId, id: string) => {
    const wo = await loadOrder(orgId, id);
    if (!wo) return fail(404, "Work order not found");
    if (wo.status === "planned") return fail(409, `${wo.number} is only planned. Release it first.`);
    if (wo.status !== "released" && wo.status !== "running") return fail(409, `${wo.number} is ${wo.status}.`);
    const center = await store.workCenters.findOne({ _id: wo.workCenterId });
    if (!center) return fail(404, "Work center not found");
    return { ok: true as const, wo, center };
  };

  const afterPost = async (wo: WorkOrderDoc, movementIds: ObjectId[]) => {
    if (wo.status === "released") {
      await store.workOrders.updateOne({ _id: wo._id, status: "released" }, { $set: { status: "running", updatedAt: new Date() } });
    }
    const fresh = (await store.workOrders.findOne({ _id: wo._id }))!;
    return { workOrder: (await toWorkOrder(store, [fresh]))[0]!, movementIds: movementIds.map((id) => id.toHexString()) };
  };

  const nameOf = async (id: ObjectId) => (await store.items.findOne({ _id: id }, { projection: { name: 1 } }))?.name ?? "item";

  const requiresItem = (wo: WorkOrderDoc, itemId: string) => wo.requirements.some((q) => q.itemId.toHexString() === itemId.toLowerCase());

  /** Load material onto the machine: stock moves from where it is to the work center's staging location. */
  r.post("/work-orders/:id/load", zValidator("param", idParam), zValidator("json", loadInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const opened = await openOrder(orgId, c.req.valid("param").id);
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    const { wo, center } = opened;
    const input = c.req.valid("json");
    if (!requiresItem(wo, input.itemId)) return c.json({ error: "That material isn't on this work order's BOM" }, 422);
    if (oid(input.fromLocationId).equals(center.locationId)) return c.json({ error: "That material is already at the machine" }, 422);
    const from = await store.locations.findOne({ _id: oid(input.fromLocationId), orgId });
    if (!from) return c.json({ error: "Location not found" }, 404);
    const itemId = oid(input.itemId);
    const itemName = await nameOf(itemId);
    const note = `Loaded to ${center.name} for ${wo.number}`;
    const res = await postLines(store, orgId, actorOf(c.get("user")), wo, [
      { type: "load", itemId, locationId: from._id, delta: -input.quantity, reason: note },
      { type: "load", itemId, locationId: center.locationId, delta: input.quantity, reason: note },
    ]);
    if (!res.ok) return c.json({ error: res.error }, res.status);
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: "production.loaded",
      entity: { type: "work_order", id: wo._id.toHexString(), label: wo.number },
      summary: `Loaded ${input.quantity} ${itemName} to ${center.name} for ${wo.number}`,
      snapshot: { item: itemName, quantity: input.quantity, from: from.name },
      refs: { movementIds: res.movementIds.map((id) => id.toHexString()) },
    });
    return c.json(await afterPost(wo, res.movementIds), 201);
  });

  /** Report usage: what was consumed, wasted, and what goes back to stock as a remnant. */
  r.post("/work-orders/:id/consume", zValidator("param", idParam), zValidator("json", consumeInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const opened = await openOrder(orgId, c.req.valid("param").id);
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    const { wo, center } = opened;
    const input = c.req.valid("json");
    if (!requiresItem(wo, input.itemId)) return c.json({ error: "That material isn't on this work order's BOM" }, 422);
    const itemId = oid(input.itemId);
    const itemName = await nameOf(itemId);
    const lines: Line[] = [
      { type: "consume", itemId, locationId: center.locationId, delta: -input.used, reason: input.reason || `Used on ${wo.number}` },
      { type: "scrap", itemId, locationId: center.locationId, delta: -input.scrap, reason: input.reason || `Scrap on ${wo.number}` },
    ];
    if (input.remnant > 0) {
      const dest = await store.locations.findOne({ _id: oid(input.remnantLocationId!), orgId });
      if (!dest) return c.json({ error: "Location not found" }, 404);
      if (dest._id.equals(center.locationId)) return c.json({ error: "Send the remnant somewhere other than the machine" }, 422);
      const note = `Remnant from ${wo.number}`;
      lines.push(
        { type: "transfer", itemId, locationId: center.locationId, delta: -input.remnant, reason: note },
        { type: "transfer", itemId, locationId: dest._id, delta: input.remnant, reason: note },
      );
    }
    const res = await postLines(store, orgId, actorOf(c.get("user")), wo, lines);
    if (!res.ok) return c.json({ error: res.error }, res.status);
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: "production.consumed",
      entity: { type: "work_order", id: wo._id.toHexString(), label: wo.number },
      summary: `Reported usage on ${wo.number}: ${itemName} used ${input.used}, scrap ${input.scrap}, remnant ${input.remnant}`,
      snapshot: { item: itemName, used: input.used, scrap: input.scrap, remnant: input.remnant },
      refs: { movementIds: res.movementIds.map((id) => id.toHexString()) },
    });
    return c.json(await afterPost(wo, res.movementIds), 201);
  });

  /** Report output: good quantity lands in stock; scrapped output is made and written off at the machine. */
  r.post("/work-orders/:id/output", zValidator("param", idParam), zValidator("json", outputInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const opened = await openOrder(orgId, c.req.valid("param").id);
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    const { wo, center } = opened;
    const input = c.req.valid("json");
    const dest = await store.locations.findOne({ _id: oid(input.toLocationId), orgId });
    if (!dest) return c.json({ error: "Location not found" }, 404);
    const why = input.reason;
    const lines: Line[] = [
      { type: "produce", itemId: wo.outputItemId, locationId: dest._id, delta: input.good, reason: why || `Output of ${wo.number}` },
      // Scrapped output never reaches stock, but it was made: book it in and out so the ledger shows it.
      { type: "produce", itemId: wo.outputItemId, locationId: center.locationId, delta: input.scrap, reason: why || `Output of ${wo.number} (scrapped)` },
      { type: "scrap", itemId: wo.outputItemId, locationId: center.locationId, delta: -input.scrap, reason: why || `Scrapped output of ${wo.number}` },
    ];
    const res = await postLines(store, orgId, actorOf(c.get("user")), wo, lines);
    if (!res.ok) return c.json({ error: res.error }, res.status);
    await recordAudit(store, {
      orgId,
      actor: auditActor(c.get("user")),
      action: "production.output",
      entity: { type: "work_order", id: wo._id.toHexString(), label: wo.number },
      summary: `Reported output on ${wo.number}: ${input.good} good, ${input.scrap} scrap`,
      snapshot: { good: input.good, scrap: input.scrap },
      refs: { movementIds: res.movementIds.map((id) => id.toHexString()) },
    });
    return c.json(await afterPost(wo, res.movementIds), 201);
  });

  // ----- variance -----

  r.get("/work-orders/:id/variance", zValidator("param", idParam), async (c) => {
    const wo = await loadOrder(c.get("org")._id, c.req.valid("param").id);
    return wo ? c.json(await varianceOf(store, wo)) : c.json({ error: "Work order not found" }, 404);
  });

  /** One row per work order that has started, worst first. */
  r.get("/variance", async (c) => {
    const orgId = c.get("org")._id;
    const docs = await store.workOrders.find({ orgId, status: { $in: ["running", "done"] } }).sort({ _id: -1 }).limit(100).toArray();
    const names = await loadItemNames(store, [...new Set(docs.map((d) => d.outputItemId.toHexString()))].map(oid));
    const rows: VarianceSummaryRow[] = await Promise.all(
      docs.map(async (d) => {
        const v = await varianceOf(store, d);
        return {
          workOrderId: v.workOrderId,
          number: v.number,
          status: v.status,
          outputItemName: names.get(d.outputItemId.toHexString())?.name ?? "Deleted item",
          yieldPct: v.yieldPct,
          worstVariancePct: v.worstVariancePct,
        };
      }),
    );
    rows.sort((a, b) => (b.worstVariancePct ?? -1) - (a.worstVariancePct ?? -1));
    return c.json(rows);
  });

  return r;
}
