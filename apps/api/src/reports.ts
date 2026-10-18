import type {
  AbcClass, AgingBucket, AgingReport, AgingRow, CountAccuracyReport, CountScheduleReport, CountScheduleRow, ItemAccuracy, LocationAccuracy,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { csvNumber, csvText } from "./csv.js";
import type { Store } from "./db.js";
import { indexLocations, loadLocations } from "./locations.js";
import type { OrgEnv } from "./org-access.js";

const DAY = 86_400_000;
const BUCKETS: { label: string; from: number; to: number | null }[] = [
  { label: "0 to 30 days", from: 0, to: 30 },
  { label: "31 to 90 days", from: 31, to: 90 },
  { label: "91 to 180 days", from: 91, to: 180 },
  { label: "181 to 365 days", from: 181, to: 365 },
  { label: "Over a year", from: 366, to: null },
];
const bucketOf = (days: number) => BUCKETS.find((b) => days >= b.from && (b.to === null || days <= b.to))!;

/** How often a place is counted, by the most important class of stock in it. */
export const COUNT_INTERVALS: Record<AbcClass, number> = { A: 30, B: 90, C: 180 };
const DUE_SOON_DAYS = 7;

export async function agingReport(store: Store, orgId: ObjectId, now = new Date(), locationId?: ObjectId): Promise<AgingReport> {
  const [stock, items, boms, locations, lastMoves] = await Promise.all([
    store.stock.find({ orgId, quantity: { $gt: 0 }, ...(locationId ? { locationId } : {}) }).toArray(),
    store.items.find({ orgId }).toArray(),
    store.boms.find({ orgId, status: "active" }).toArray(),
    loadLocations(store, orgId),
    store.movements
      .aggregate<{ _id: { i: ObjectId; l: ObjectId }; at: Date }>([
        { $match: { orgId } },
        { $group: { _id: { i: "$itemId", l: "$locationId" }, at: { $max: "$createdAt" } } },
      ])
      .toArray(),
  ]);
  const idx = indexLocations(locations);
  const itemById = new Map(items.map((i) => [i._id.toHexString(), i]));
  const wanted = new Set(boms.flatMap((b) => [b.outputItemId.toHexString(), ...b.inputs.map((i) => i.itemId.toHexString())]));
  const last = new Map(lastMoves.map((m) => [`${m._id.i.toHexString()}:${m._id.l.toHexString()}`, m.at]));

  const rows: AgingRow[] = [];
  for (const s of stock) {
    const item = itemById.get(s.itemId.toHexString());
    if (!item) continue;
    const at = last.get(`${s.itemId.toHexString()}:${s.locationId.toHexString()}`) ?? s.updatedAt;
    const daysSince = Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY));
    rows.push({
      itemId: item._id.toHexString(), sku: item.sku, name: item.name, locationId: s.locationId.toHexString(),
      locationPath: idx.byId.has(s.locationId.toHexString()) ? idx.pathOf(s.locationId.toHexString()) : "Deleted location",
      quantity: s.quantity, valueCents: s.quantity * item.unitCostCents, lastMovementAt: at.toISOString(), daysSince,
      onActiveBom: wanted.has(item._id.toHexString()), bucket: bucketOf(daysSince).label,
    });
  }
  rows.sort((a, b) => b.daysSince - a.daysSince || b.valueCents - a.valueCents || a.name.localeCompare(b.name, "en"));
  const buckets: AgingBucket[] = BUCKETS.map((b) => {
    const inB = rows.filter((r) => r.bucket === b.label);
    return { label: b.label, fromDays: b.from, toDays: b.to, rows: inB.length, units: inB.reduce((s, r) => s + r.quantity, 0), valueCents: inB.reduce((s, r) => s + r.valueCents, 0) };
  });
  return {
    asOf: now.toISOString(), rows, buckets,
    totalValueCents: rows.reduce((s, r) => s + r.valueCents, 0),
    idleValueCents: rows.filter((r) => r.daysSince > 180).reduce((s, r) => s + r.valueCents, 0),
  };
}

export async function countAccuracyReport(store: Store, orgId: ObjectId, now = new Date()): Promise<CountAccuracyReport> {
  const [counts, items, locations] = await Promise.all([
    store.counts.find({ orgId, status: "posted" }).toArray(),
    store.items.find({ orgId }).toArray(),
    loadLocations(store, orgId),
  ]);
  const idx = indexLocations(locations);
  const cost = new Map(items.map((i) => [i._id.toHexString(), i]));
  const byLoc = new Map<string, LocationAccuracy>();
  const byItem = new Map<string, ItemAccuracy>();
  const months = new Map<string, { n: number; ok: number }>();
  for (let m = 5; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    months.set(d.toISOString().slice(0, 7), { n: 0, ok: 0 });
  }
  let lines = 0, ok = 0;
  for (const c of counts) {
    const key = c.locationId.toHexString();
    const loc = byLoc.get(key) ?? {
      locationId: key, locationPath: idx.byId.has(key) ? idx.pathOf(key) : "Deleted location", counts: 0, linesCounted: 0, linesMatched: 0, accuracyPct: 0,
      absVarianceUnits: 0, absVarianceCents: 0, netVarianceCents: 0, lastPostedAt: null,
    };
    loc.counts++;
    const posted = c.postedAt ?? c.startedAt;
    if (!loc.lastPostedAt || posted.toISOString() > loc.lastPostedAt) loc.lastPostedAt = posted.toISOString();
    const month = months.get(posted.toISOString().slice(0, 7));
    for (const l of c.lines) {
      const expected = l.expectedAtPost ?? l.counted;
      const diff = l.counted - expected;
      const unitCost = cost.get(l.itemId.toHexString())?.unitCostCents ?? 0;
      loc.linesCounted++; lines++;
      if (diff === 0) { loc.linesMatched++; ok++; }
      loc.absVarianceUnits += Math.abs(diff); loc.absVarianceCents += Math.abs(diff) * unitCost; loc.netVarianceCents += diff * unitCost;
      if (month) { month.n++; if (diff === 0) month.ok++; }
      const item = cost.get(l.itemId.toHexString());
      const it = byItem.get(l.itemId.toHexString()) ?? { itemId: l.itemId.toHexString(), sku: item?.sku ?? "", name: item?.name ?? "Deleted item", linesCounted: 0, linesMissed: 0, absVarianceUnits: 0, absVarianceCents: 0 };
      it.linesCounted++; if (diff !== 0) it.linesMissed++;
      it.absVarianceUnits += Math.abs(diff); it.absVarianceCents += Math.abs(diff) * unitCost;
      byItem.set(it.itemId, it);
    }
    byLoc.set(key, loc);
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const byLocation = [...byLoc.values()].map((l) => ({ ...l, accuracyPct: pct(l.linesMatched, l.linesCounted) ?? 0 })).sort((a, b) => a.accuracyPct - b.accuracyPct || b.absVarianceCents - a.absVarianceCents);
  return {
    asOf: now.toISOString(), postedCounts: counts.length, linesCounted: lines, accuracyPct: pct(ok, lines), byLocation,
    worstItems: [...byItem.values()].filter((i) => i.linesMissed > 0).sort((a, b) => b.absVarianceCents - a.absVarianceCents || b.linesMissed - a.linesMissed).slice(0, 10),
    byMonth: [...months.entries()].map(([month, m]) => ({ month, linesCounted: m.n, accuracyPct: pct(m.ok, m.n) })),
  };
}

/**
 * ABC by on-hand value: items that make up the first 80% of total stock value are A, the next 15% are B, the rest C.
 * (There's no sales history yet, so value on hand stands in for annual usage.) A place is counted as often as the most important class in it.
 */
export async function countScheduleReport(store: Store, orgId: ObjectId, now = new Date()): Promise<CountScheduleReport> {
  const [stock, items, counts, locations] = await Promise.all([
    store.stock.find({ orgId, quantity: { $gt: 0 } }).toArray(),
    store.items.find({ orgId }).toArray(),
    store.counts.find({ orgId, status: { $in: ["posted", "open"] } }).toArray(),
    loadLocations(store, orgId),
  ]);
  const idx = indexLocations(locations);
  const cost = new Map(items.map((i) => [i._id.toHexString(), i.unitCostCents]));
  const valueByItem = new Map<string, number>();
  for (const s of stock) valueByItem.set(s.itemId.toHexString(), (valueByItem.get(s.itemId.toHexString()) ?? 0) + s.quantity * (cost.get(s.itemId.toHexString()) ?? 0));
  const total = [...valueByItem.values()].reduce((a, b) => a + b, 0);
  const ranked = [...valueByItem.entries()].sort((a, b) => b[1] - a[1]);
  const klass = new Map<string, AbcClass>();
  let run = 0;
  for (const [id, v] of ranked) {
    // Class by the share *before* adding this item, so a single item that is most of the value is still A.
    const before = total ? run / total : 1;
    klass.set(id, v === 0 ? "C" : before < 0.8 ? "A" : before < 0.95 ? "B" : "C");
    run += v;
  }
  const classShare: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  const classItems: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  for (const [id, v] of valueByItem) { const k = klass.get(id)!; classShare[k] += total ? v / total : 0; classItems[k]++; }
  for (const k of ["A", "B", "C"] as const) classShare[k] = Math.round(classShare[k] * 1000) / 10;

  const order: AbcClass[] = ["A", "B", "C"];
  const perLoc = new Map<string, { value: number; best: AbcClass }>();
  for (const s of stock) {
    const k = s.locationId.toHexString();
    const cls = klass.get(s.itemId.toHexString()) ?? "C";
    const cur = perLoc.get(k) ?? { value: 0, best: "C" as AbcClass };
    cur.value += s.quantity * (cost.get(s.itemId.toHexString()) ?? 0);
    if (order.indexOf(cls) < order.indexOf(cur.best)) cur.best = cls;
    perLoc.set(k, cur);
  }
  const rows: CountScheduleRow[] = [...perLoc.entries()].map(([id, p]) => {
    const posted = counts.filter((c) => c.status === "posted" && c.locationId.toHexString() === id).map((c) => (c.postedAt ?? c.startedAt).getTime());
    const lastMs = posted.length ? Math.max(...posted) : null;
    const interval = COUNT_INTERVALS[p.best];
    const dueMs = lastMs === null ? null : lastMs + interval * DAY;
    const daysOver = dueMs === null ? null : Math.floor((now.getTime() - dueMs) / DAY);
    const status = lastMs === null ? "never-counted" : daysOver! > 0 ? "overdue" : daysOver! >= -DUE_SOON_DAYS ? "due-soon" : "ok";
    const open = counts.find((c) => c.status === "open" && c.locationId.toHexString() === id);
    return {
      locationId: id, locationPath: idx.byId.has(id) ? idx.pathOf(id) : "Deleted location", abc: p.best, intervalDays: interval, stockValueCents: p.value,
      lastCountedAt: lastMs === null ? null : new Date(lastMs).toISOString(), dueAt: dueMs === null ? null : new Date(dueMs).toISOString(), daysOverdue: daysOver, status, openCountId: open?._id.toHexString() ?? null,
    };
  });
  const weight = { overdue: 0, "never-counted": 1, "due-soon": 2, ok: 3 } as const;
  rows.sort((a, b) => weight[a.status] - weight[b.status] || order.indexOf(a.abc) - order.indexOf(b.abc) || b.stockValueCents - a.stockValueCents);
  return { asOf: now.toISOString(), intervals: COUNT_INTERVALS, classShare, classItems, rows };
}

export function createReportRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  const oid = (s: string | undefined) => (s && /^[0-9a-f]{24}$/i.test(s) ? new ObjectId(s) : undefined);

  r.get("/aging", async (c) => c.json(await agingReport(store, c.get("org")._id, new Date(), oid(c.req.query("locationId")))));

  r.get("/aging.csv", async (c) => {
    const rep = await agingReport(store, c.get("org")._id, new Date(), oid(c.req.query("locationId")));
    const lines = ["sku,name,location,quantity,value,last_movement,days_since,on_active_bom"];
    for (const x of rep.rows) {
      lines.push([csvText(x.sku), csvText(x.name), csvText(x.locationPath), csvNumber(x.quantity), (x.valueCents / 100).toFixed(2), x.lastMovementAt.slice(0, 10), csvNumber(x.daysSince), x.onActiveBom ? "yes" : "no"].join(","));
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="stock-aging-${rep.asOf.slice(0, 10)}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${lines.join("\r\n")}\r\n`);
  });

  r.get("/count-accuracy", async (c) => c.json(await countAccuracyReport(store, c.get("org")._id)));
  r.get("/count-schedule", async (c) => c.json(await countScheduleReport(store, c.get("org")._id)));
  return r;
}
