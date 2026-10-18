import { zValidator } from "@hono/zod-validator";
import { traceQuerySchema, type RecallDrill, type TraceAffectedRow, type TraceNode, type TraceQuery, type TraceResult } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { auditActor, recordAudit } from "./audit.js";
import { csvText } from "./csv.js";
import type { DrillDoc, MovementDoc, StockUnitDoc, Store, WorkOrderDoc } from "./db.js";
import { indexLocations, loadLocations } from "./locations.js";
import type { OrgEnv } from "./org-access.js";

// INV-1: lot genealogy and mock recall. Everything is read from the ledger and the unit records:
//  - a labelled roll or pallet carries its lot, and every line it takes part in carries the work order;
//  - a work order's "load / consume / scrap" lines by unit say what went in, and its "produce" lines say what came out;
//  - plain stock has no lot after receiving, so links through plain stock are INFERRED and always marked as such.

const ci = { locale: "en", strength: 2 } as const;
const MAX_DEPTH = 8;
const MAX_NODES = 2000;
const day = (d: Date) => d.toISOString().slice(0, 10);

type Fail = { ok: false; status: 404 | 422; error: string };

class Trace {
  nodes = 0;
  truncated = false;
  seen = new Set<string>();
  affected = new Map<string, TraceAffectedRow>();
  wos = new Set<string>();
  pos = new Set<string>();
  suppliers = new Set<string>();
  customers = new Set<string>();
  inferred = false;
  notes: string[] = [];
  private items = new Map<string, { sku: string; name: string }>();
  private woCache = new Map<string, WorkOrderDoc | null>();
  private unitCache = new Map<string, StockUnitDoc | null>();
  private poCache = new Map<string, { number: string; supplier: string } | null>();
  locs!: ReturnType<typeof indexLocations>;

  constructor(private store: Store, private orgId: ObjectId) {}

  async init() {
    this.locs = indexLocations(await loadLocations(this.store, this.orgId));
  }

  path = (id: ObjectId) => (this.locs.byId.has(id.toHexString()) ? this.locs.pathOf(id.toHexString()) : "Deleted location");

  async item(id: ObjectId) {
    const k = id.toHexString();
    if (!this.items.has(k)) {
      const i = await this.store.items.findOne({ _id: id, orgId: this.orgId }, { projection: { sku: 1, name: 1 } });
      this.items.set(k, { sku: i?.sku ?? "", name: i?.name ?? "Deleted item" });
    }
    return this.items.get(k)!;
  }

  async wo(id: ObjectId) {
    const k = id.toHexString();
    if (!this.woCache.has(k)) this.woCache.set(k, await this.store.workOrders.findOne({ _id: id, orgId: this.orgId }));
    return this.woCache.get(k)!;
  }

  async unit(id: ObjectId) {
    const k = id.toHexString();
    if (!this.unitCache.has(k)) this.unitCache.set(k, await this.store.units.findOne({ _id: id, orgId: this.orgId }));
    return this.unitCache.get(k)!;
  }

  async po(id: ObjectId) {
    const k = id.toHexString();
    if (!this.poCache.has(k)) {
      const p = await this.store.purchaseOrders.findOne({ _id: id, orgId: this.orgId }, { projection: { number: 1, supplierId: 1 } });
      const s = p ? await this.store.suppliers.findOne({ _id: p.supplierId }, { projection: { name: 1 } }) : null;
      this.poCache.set(k, p ? { number: p.number, supplier: s?.name ?? "" } : null);
    }
    return this.poCache.get(k)!;
  }

  node(kind: TraceNode["kind"], key: string, label: string, detail: string, exact = true): TraceNode | null {
    if (this.nodes >= MAX_NODES) {
      this.truncated = true;
      return null;
    }
    this.nodes++;
    return { id: `${kind}:${key}`, kind, label, detail, exact, children: [] };
  }

  /** Lines of one kind for a work order, ignoring anything that was reversed. */
  lines(woId: ObjectId, types: MovementDoc["type"][]) {
    return this.store.movements.find({ orgId: this.orgId, workOrderId: woId, type: { $in: types as never[] }, reversedBy: { $exists: false } }).sort({ createdAt: 1 }).toArray();
  }

  /** Where a labelled unit went to a customer (shipments that haven't been undone), with the customer's name. */
  async shipmentsOf(u: StockUnitDoc) {
    const moves = await this.store.movements.find({ orgId: this.orgId, unitId: u._id, type: "ship", salesOrderId: { $exists: true }, reversedBy: { $exists: false } }).sort({ createdAt: 1 }).toArray();
    const out: { id: string; order: string; customer: string; ref: string; at: Date; quantity: number }[] = [];
    for (const m of moves) {
      const so = await this.store.salesOrders.findOne({ _id: m.salesOrderId!, orgId: this.orgId }, { projection: { number: 1, customerName: 1, customerRef: 1 } });
      if (so) out.push({ id: m._id.toHexString(), order: so.number, customer: so.customerName || "a customer", ref: so.customerRef, at: m.createdAt, quantity: -m.delta });
    }
    return out;
  }

  async addUnitRow(u: StockUnitDoc, via: string) {
    const k = `u:${u._id.toHexString()}`;
    if (this.affected.has(k)) return;
    const it = await this.item(u.itemId);
    const shipped = u.status === "consumed" ? await this.shipmentsOf(u) : [];
    this.affected.set(k, { kind: "unit", code: u.code, itemSku: it.sku, itemName: it.name, lot: u.lot, quantity: u.status === "consumed" ? 0 : u.quantity, status: shipped.length ? "shipped" : u.status, location: shipped.length ? `Shipped to ${shipped[shipped.length - 1]!.customer}` : this.path(u.locationId), via });
  }

  async unitNode(u: StockUnitDoc, via: string): Promise<TraceNode | null> {
    const it = await this.item(u.itemId);
    const shipped = u.status === "consumed" ? await this.shipmentsOf(u) : [];
    const gone = shipped.length ? `shipped to ${shipped.map((s) => s.customer).join(", ")}` : "used up";
    const n = this.node("unit", u._id.toHexString(), `${u.code}: ${it.name}`, `${u.lot ? `lot ${u.lot} · ` : ""}${u.status === "consumed" ? gone : `${u.quantity.toLocaleString("en-US")} left, ${u.status === "quarantined" ? "on quality hold, " : ""}at ${this.path(u.locationId)}`}`);
    if (n) await this.addUnitRow(u, via);
    return n;
  }

  async woNode(w: WorkOrderDoc, exact = true): Promise<TraceNode | null> {
    const it = await this.item(w.outputItemId);
    this.wos.add(w.number);
    return this.node("work_order", w._id.toHexString(), `${w.number}: ${w.quantity.toLocaleString("en-US")} × ${it.name}`, `status ${w.status}`, exact);
  }

  // ---------- forward: from a unit to what it went into ----------

  async forwardUnit(u: StockUnitDoc, depth: number, via: string): Promise<TraceNode | null> {
    const key = `u:${u._id.toHexString()}`;
    const node = await this.unitNode(u, via);
    if (!node) return null;
    if (this.seen.has(key)) return { ...node, repeat: true };
    this.seen.add(key);
    if (depth >= MAX_DEPTH) return node;
    const used = await this.store.movements
      .find({ orgId: this.orgId, unitId: u._id, workOrderId: { $exists: true }, type: { $in: ["load", "consume", "scrap"] }, reversedBy: { $exists: false } })
      .sort({ createdAt: 1 })
      .toArray();
    const woIds = [...new Map(used.map((m) => [m.workOrderId!.toHexString(), m.workOrderId!])).values()];
    for (const id of woIds) {
      const w = await this.wo(id);
      if (!w) continue;
      const child = await this.forwardWo(w, depth + 1);
      if (child) node.children.push(child);
    }
    // And on to a customer: a labelled roll or pallet that was shipped (INV-15).
    for (const s of await this.shipmentsOf(u)) {
      this.customers.add(s.customer);
      const out = this.node("shipment", s.id, `Shipped to ${s.customer}`, `${s.order}${s.ref ? `, their order ${s.ref}` : ""} · ${s.at.toISOString().slice(0, 10)} · ${s.quantity.toLocaleString("en-US")} of ${u.code}`);
      if (out) node.children.push(out);
    }
    return node;
  }

  /** What a work order made: labelled outputs (followed on) and plain quantities. */
  async forwardWo(w: WorkOrderDoc, depth: number, exact = true): Promise<TraceNode | null> {
    const key = `w:${w._id.toHexString()}`;
    const node = await this.woNode(w, exact);
    if (!node) return null;
    if (this.seen.has(key)) return { ...node, repeat: true };
    this.seen.add(key);
    const made = await this.lines(w._id, ["produce"]);
    const plain = new Map<string, { itemId: ObjectId; locationId: ObjectId; qty: number }>();
    for (const m of made) {
      if (m.delta <= 0) continue;
      if (m.unitId) {
        const u = await this.unit(m.unitId);
        if (u) {
          const child = await this.forwardUnit(u, depth + 1, w.number);
          if (child) node.children.push(child);
        }
      } else {
        const k = `${m.itemId.toHexString()}:${m.locationId.toHexString()}`;
        plain.set(k, { itemId: m.itemId, locationId: m.locationId, qty: (plain.get(k)?.qty ?? 0) + m.delta });
      }
    }
    for (const [k, p] of plain) {
      const it = await this.item(p.itemId);
      const out = this.node("output", `${w._id.toHexString()}:${k}`, `${p.qty.toLocaleString("en-US")} × ${it.name}`, `made into ${this.path(p.locationId)} (plain stock: not followed after production)`, exact);
      if (!out) continue;
      node.children.push(out);
      this.affected.set(`q:${w._id.toHexString()}:${k}`, { kind: "quantity", code: null, itemSku: it.sku, itemName: it.name, lot: "", quantity: p.qty, status: "produced", location: this.path(p.locationId), via: w.number });
    }
    return node;
  }

  // ---------- backward: from a unit or work order to what went into it ----------

  async backwardUnit(u: StockUnitDoc, depth: number, via: string): Promise<TraceNode | null> {
    const key = `bu:${u._id.toHexString()}`;
    const node = await this.unitNode(u, via);
    if (!node) return null;
    if (this.seen.has(key)) return { ...node, repeat: true };
    this.seen.add(key);
    const made = await this.store.movements.findOne({ orgId: this.orgId, unitId: u._id, type: "produce", workOrderId: { $exists: true }, reversedBy: { $exists: false } }, { sort: { createdAt: 1 } });
    if (made?.workOrderId && depth < MAX_DEPTH) {
      const w = await this.wo(made.workOrderId);
      if (w) {
        const child = await this.backwardWo(w, depth + 1);
        if (child) node.children.push(child);
      }
      return node;
    }
    // Not made here: it arrived. Say when, on which order, from whom.
    const rec = await this.store.movements.findOne({ orgId: this.orgId, unitId: u._id, type: "receive", reversedBy: { $exists: false } }, { sort: { createdAt: 1 } });
    if (rec) {
      const po = rec.purchaseOrderId ? await this.po(rec.purchaseOrderId) : null;
      if (po) { this.pos.add(po.number); if (po.supplier) this.suppliers.add(po.supplier); }
      const r = this.node("receipt", `${u._id.toHexString()}`, `Received ${day(rec.createdAt)}`, [u.lot && `lot ${u.lot}`, po && `${po.number}${po.supplier ? `, ${po.supplier}` : ""}`, rec.reason].filter(Boolean).join(" · "));
      if (r) node.children.push(r);
    }
    return node;
  }

  /** What went into a work order: units by label (exact), plain materials by item (inferred, with candidate receipts). */
  async backwardWo(w: WorkOrderDoc, depth: number): Promise<TraceNode | null> {
    const key = `bw:${w._id.toHexString()}`;
    const node = await this.woNode(w);
    if (!node) return null;
    if (this.seen.has(key)) return { ...node, repeat: true };
    this.seen.add(key);
    const used = await this.lines(w._id, ["load", "consume", "scrap"]);
    const unitIds = [...new Map(used.filter((m) => m.unitId).map((m) => [m.unitId!.toHexString(), m.unitId!])).values()];
    for (const id of unitIds) {
      const u = await this.unit(id);
      if (!u) continue;
      const child = await this.backwardUnit(u, depth + 1, w.number);
      if (child) node.children.push(child);
    }
    const plain = new Map<string, number>();
    for (const m of used) if (!m.unitId && m.type === "consume" && m.delta < 0) plain.set(m.itemId.toHexString(), (plain.get(m.itemId.toHexString()) ?? 0) - m.delta);
    const first = used[0]?.createdAt ?? w.createdAt;
    for (const [itemId, qty] of plain) {
      const it = await this.item(new ObjectId(itemId));
      const inputs = this.node("inputs", `${w._id.toHexString()}:${itemId}`, `${qty.toLocaleString("en-US")} × ${it.name}`, "plain stock: the lot is not recorded after receiving, so these are the possible sources", false);
      if (!inputs) continue;
      this.inferred = true;
      const recent = await this.store.movements
        .find({ orgId: this.orgId, itemId: new ObjectId(itemId), type: "receive", unitId: { $exists: false }, reversedBy: { $exists: false }, createdAt: { $lte: first } })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();
      for (const m of recent) {
        const po = m.purchaseOrderId ? await this.po(m.purchaseOrderId) : null;
        if (po) { this.pos.add(po.number); if (po.supplier) this.suppliers.add(po.supplier); }
        const r = this.node("receipt", m._id.toHexString(), `Received ${day(m.createdAt)}: ${m.delta.toLocaleString("en-US")}`, [m.supplierLot && `lot ${m.supplierLot}`, po && `${po.number}${po.supplier ? `, ${po.supplier}` : ""}`].filter(Boolean).join(" · ") || "no lot recorded", false);
        if (r) inputs.children.push(r);
      }
      node.children.push(inputs);
    }
    return node;
  }
}

async function runTrace(store: Store, orgId: ObjectId, q: ReturnType<typeof traceQuerySchema.parse>): Promise<TraceResult | Fail> {
  const t0 = performance.now();
  const tr = new Trace(store, orgId);
  await tr.init();
  const tree: TraceNode[] = [];
  let label = "";

  if (q.unit) {
    const u = await store.units.findOne({ orgId, code: q.unit }, { collation: ci });
    if (!u) return { ok: false, status: 404, error: `No roll or pallet is labelled "${q.unit}"` };
    label = `${q.direction === "forward" ? "Where did" : "What went into"} ${u.code} ${q.direction === "forward" ? "go" : ""}`.trim();
    const n = q.direction === "forward" ? await tr.forwardUnit(u, 0, "") : await tr.backwardUnit(u, 0, "");
    if (n) tree.push(n);
  } else if (q.workOrder) {
    const m = /^wo-?(\d+)$/i.exec(q.workOrder);
    const w = m ? await store.workOrders.findOne({ orgId, number: `WO-${m[1]!.padStart(4, "0")}` }) : null;
    if (!w) return { ok: false, status: 404, error: `No work order "${q.workOrder}"` };
    label = `${q.direction === "forward" ? "What came out of" : "What went into"} ${w.number}`;
    const n = q.direction === "forward" ? await tr.forwardWo(w, 0) : await tr.backwardWo(w, 0);
    if (n) tree.push(n);
  } else {
    const lot = q.lot!;
    const itemFilter = q.itemId ? { itemId: new ObjectId(q.itemId) } : {};
    const units = await store.units.find({ orgId, lot, ...itemFilter }, { collation: ci }).sort({ _id: 1 }).toArray();
    const plainReceipts = await store.movements
      .find({ orgId, supplierLot: lot, type: "receive", unitId: { $exists: false }, reversedBy: { $exists: false }, ...itemFilter }, { collation: ci })
      .sort({ createdAt: 1 })
      .toArray();
    if (!units.length && !plainReceipts.length) return { ok: false, status: 404, error: `Nothing was received or made under lot "${lot}"` };
    label = `${q.direction === "forward" ? "Where did" : "What went into"} lot ${lot} ${q.direction === "forward" ? "go" : ""}`.trim();
    for (const u of units) {
      const n = q.direction === "forward" ? await tr.forwardUnit(u, 0, "") : await tr.backwardUnit(u, 0, "");
      if (n) tree.push(n);
    }
    if (q.direction === "forward") {
      for (const m of plainReceipts) {
        const it = await tr.item(m.itemId);
        const po = m.purchaseOrderId ? await tr.po(m.purchaseOrderId) : null;
        if (po) { tr.pos.add(po.number); if (po.supplier) tr.suppliers.add(po.supplier); }
        const lotNode = tr.node("lot", m._id.toHexString(), `Lot ${lot}: ${m.delta.toLocaleString("en-US")} × ${it.name}`, [`received ${day(m.createdAt)}`, po && `${po.number}${po.supplier ? `, ${po.supplier}` : ""}`].filter(Boolean).join(" · "));
        if (!lotNode) continue;
        // Plain stock has no lot after receiving: any work order that used this item afterwards MIGHT have used it.
        tr.inferred = true;
        const later = await store.movements
          .find({ orgId, itemId: m.itemId, type: "consume", unitId: { $exists: false }, workOrderId: { $exists: true }, reversedBy: { $exists: false }, createdAt: { $gte: m.createdAt } })
          .sort({ createdAt: 1 })
          .toArray();
        const ids = [...new Map(later.map((x) => [x.workOrderId!.toHexString(), x.workOrderId!])).values()].slice(0, 30);
        for (const id of ids) {
          const w = await tr.wo(id);
          if (!w) continue;
          const child = await tr.forwardWo(w, 1, false);
          if (child) lotNode.children.push({ ...child, exact: false });
        }
        tree.push(lotNode);
      }
    } else if (plainReceipts.length) {
      tr.notes.push("Part of this lot was received as plain stock, which has no lot after receiving, so there is nothing further back to trace for it.");
    }
  }

  if (tr.inferred) tr.notes.push("Some links go through plain stock (not tracked by roll or pallet label). Those are marked \"possible\": the system can say they might be involved, not that they were. Track the material by unit to make the trace exact.");
  if (tr.truncated) tr.notes.push(`The trace stopped at ${MAX_NODES} steps. Narrow it down (a unit or a work order) to see the rest.`);

  const rows = [...tr.affected.values()];
  const unitRows = rows.filter((r) => r.kind === "unit");
  const byLoc = new Map<string, { units: number; quantity: number }>();
  for (const r of rows) {
    if (r.status === "consumed") continue;
    const e = byLoc.get(r.location) ?? { units: 0, quantity: 0 };
    if (r.kind === "unit") e.units++;
    e.quantity += r.quantity;
    byLoc.set(r.location, e);
  }
  return {
    direction: q.direction,
    query: label,
    tree,
    affected: rows,
    summary: {
      units: unitRows.length,
      stillInStock: unitRows.filter((r) => r.status !== "consumed").reduce((s, r) => s + r.quantity, 0),
      workOrders: [...tr.wos].sort(),
      purchaseOrders: [...tr.pos].sort(),
      suppliers: [...tr.suppliers].sort(),
      customers: [...tr.customers].sort(),
      locations: [...byLoc].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.quantity - a.quantity),
      hasInferred: tr.inferred,
    },
    notes: tr.notes,
    tookMs: Math.max(1, Math.round(performance.now() - t0)),
  };
}

export function createTraceabilityRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/trace", zValidator("query", traceQuerySchema), async (c) => {
    const res = await runTrace(store, c.get("org")._id, c.req.valid("query"));
    return "ok" in res ? c.json({ error: res.error }, res.status) : c.json<TraceResult>(res);
  });

  /** The same trace as a spreadsheet: one row per affected unit or plain output. */
  r.get("/trace.csv", zValidator("query", traceQuerySchema), async (c) => {
    const res = await runTrace(store, c.get("org")._id, c.req.valid("query"));
    if ("ok" in res) return c.json({ error: res.error }, res.status);
    const lines = ["kind,label,item_sku,item,lot,quantity,status,location,via_work_order"];
    for (const a of res.affected) lines.push([a.kind, csvText(a.code ?? ""), csvText(a.itemSku), csvText(a.itemName), csvText(a.lot), String(a.quantity), a.status, csvText(a.location), csvText(a.via)].join(","));
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="trace-${new Date().toISOString().slice(0, 10)}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${lines.join("\r\n")}\r\n`);
  });

  /** Run a trace as a drill: it is timed and kept, so the plant can show how fast it can answer a recall. */
  r.post("/drills", zValidator("json", traceQuerySchema), async (c) => {
    const org = c.get("org");
    const res = await runTrace(store, org._id, c.req.valid("json"));
    if ("ok" in res) return c.json({ error: res.error }, res.status);
    const me = c.get("user");
    const doc: DrillDoc = {
      _id: new ObjectId(), orgId: org._id, at: new Date(), by: { id: new ObjectId(me.id), name: me.name }, direction: res.direction, query: res.query, tookMs: res.tookMs,
      units: res.summary.units, stillInStock: res.summary.stillInStock, workOrders: res.summary.workOrders.length, locations: res.summary.locations.length, hasInferred: res.summary.hasInferred,
    };
    await store.drills.insertOne(doc);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "traceability.drill", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
      summary: `Mock recall: ${res.query} (${res.summary.units} units, ${res.summary.workOrders.length} work orders, ${res.tookMs} ms)`,
      snapshot: { query: res.query, direction: res.direction, units: res.summary.units, stillInStock: res.summary.stillInStock, tookMs: res.tookMs, hasInferred: res.summary.hasInferred },
    });
    return c.json({ drill: toDrill(doc), result: res }, 201);
  });

  r.get("/drills", async (c) => {
    const docs = await store.drills.find({ orgId: c.get("org")._id }).sort({ at: -1 }).limit(20).toArray();
    return c.json<RecallDrill[]>(docs.map(toDrill));
  });

  return r;
}

const toDrill = (d: DrillDoc): RecallDrill => ({
  id: d._id.toHexString(), at: d.at.toISOString(), by: d.by.name, direction: d.direction, query: d.query, tookMs: d.tookMs,
  units: d.units, stillInStock: d.stillInStock, workOrders: d.workOrders, locations: d.locations, hasInferred: d.hasInferred,
});

export type { TraceQuery };
