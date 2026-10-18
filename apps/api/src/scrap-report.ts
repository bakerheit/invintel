import { scrapQuerySchema, type ScrapCenterRow, type ScrapItemRow, type ScrapReasonRow, type ScrapReport, type ScrapSource, type ScrapTrendPoint } from "@invintel/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { csvNumber, csvText } from "./csv.js";
import type { MovementDoc, Store } from "./db.js";
import type { OrgEnv } from "./org-access.js";

const DAY = 86_400_000;
export const NO_REASON = "No reason given";
export const NO_WORK_ORDER = "Not on a work order";

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** The Monday of the week a date is in, as a day key. */
const weekKey = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return dayKey(x);
};
const pct = (good: number, scrapped: number) => (good + scrapped > 0 ? Math.round((good / (good + scrapped)) * 1000) / 10 : null);

interface ScrapLine {
  at: Date;
  source: ScrapSource;
  woNumber: string;
  workCenterId: string | null;
  workCenterName: string;
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  valueCents: number;
  reason: string;
  by: string;
}

/**
 * Everything the report is made of, read once: scrap lines in the window with their work order, work center, item
 * and cost, plus good output per work center and day for the yield.
 */
export async function loadScrap(store: Store, orgId: ObjectId, days: number, workCenterId?: string, now = new Date()) {
  const from = new Date(now.getTime() - days * DAY);
  const live = { orgId, reversedBy: { $exists: false }, createdAt: { $gte: from, $lte: now } };
  const [scrapRows, produceRows] = await Promise.all([
    store.movements.find({ ...live, type: "scrap", delta: { $lt: 0 } }).toArray(),
    store.movements.find({ ...live, type: "produce", delta: { $gt: 0 }, workOrderId: { $exists: true } }).toArray(),
  ]);
  const woIds = [...new Set([...scrapRows, ...produceRows].flatMap((m: MovementDoc) => (m.workOrderId ? [m.workOrderId.toHexString()] : [])))].map((x) => new ObjectId(x));
  const [wos, items] = await Promise.all([
    store.workOrders.find({ _id: { $in: woIds } }).toArray(),
    store.items.find({ orgId }, { projection: { sku: 1, name: 1, unitCostCents: 1 } }).toArray(),
  ]);
  const centers = await store.workCenters.find({ _id: { $in: [...new Set(wos.map((w) => w.workCenterId.toHexString()))].map((x) => new ObjectId(x)) } }).toArray();
  const wo = new Map(wos.map((w) => [w._id.toHexString(), w]));
  const item = new Map(items.map((i) => [i._id.toHexString(), i]));
  const center = new Map(centers.map((c) => [c._id.toHexString(), c.name]));

  const lines: ScrapLine[] = [];
  for (const m of scrapRows) {
    const w = m.workOrderId ? wo.get(m.workOrderId.toHexString()) : undefined;
    const i = item.get(m.itemId.toHexString());
    // Output scrap is the output item scrapped on a work order; the rest of a work order's scrap is material scrap.
    const source: ScrapSource = m.ncrId ? "hold" : w && w.outputItemId.equals(m.itemId) ? "output" : "usage";
    const qty = -m.delta;
    lines.push({
      at: m.createdAt, source, woNumber: w?.number ?? "", workCenterId: w?.workCenterId.toHexString() ?? null,
      workCenterName: w ? (center.get(w.workCenterId.toHexString()) ?? "Deleted work center") : NO_WORK_ORDER,
      itemId: m.itemId.toHexString(), sku: i?.sku ?? "", name: i?.name ?? "Deleted item", quantity: qty, valueCents: Math.round(qty * (i?.unitCostCents ?? 0)),
      reason: m.reasonCode || NO_REASON, by: m.userName,
    });
  }
  // Good output = produce lines minus the output scrap booked against the same work order.
  const good: { at: Date; workCenterId: string; qty: number }[] = [];
  for (const m of produceRows) {
    const w = wo.get(m.workOrderId!.toHexString());
    if (!w) continue;
    good.push({ at: m.createdAt, workCenterId: w.workCenterId.toHexString(), qty: m.delta });
  }
  const outScrap = lines.filter((l) => l.source === "output");
  const keep = (id: string | null) => !workCenterId || id === workCenterId;
  return {
    from, to: now, center,
    lines: lines.filter((l) => keep(l.workCenterId) && (!workCenterId || l.source !== "hold")),
    outputScrap: outScrap.filter((l) => keep(l.workCenterId)),
    // produce lines include the scrapped output (made then written off), so take it back out to get good output
    good: good.filter((g) => keep(g.workCenterId)),
  };
}

export async function scrapReport(store: Store, orgId: ObjectId, days: number, workCenterId?: string, now = new Date()): Promise<ScrapReport> {
  const d = await loadScrap(store, orgId, days, workCenterId, now);
  const bucket: "day" | "week" = days <= 31 ? "day" : "week";
  const key = bucket === "day" ? dayKey : weekKey;

  const reasons = new Map<string, ScrapReasonRow>();
  const centers = new Map<string, ScrapCenterRow>();
  const items = new Map<string, ScrapItemRow>();
  const sources = new Map<ScrapSource, { valueCents: number; lines: number }>();
  const trend = new Map<string, ScrapTrendPoint>();
  const point = (at: Date): ScrapTrendPoint => {
    const k = key(at);
    if (!trend.has(k)) trend.set(k, { label: k, valueCents: 0, goodOutput: 0, scrappedOutput: 0, yieldPct: null });
    return trend.get(k)!;
  };
  const row = (id: string | null, name: string): ScrapCenterRow => {
    const k = id ?? "none";
    if (!centers.has(k)) centers.set(k, { workCenterId: id, name, scrapLines: 0, valueCents: 0, goodOutput: 0, scrappedOutput: 0, yieldPct: null });
    return centers.get(k)!;
  };

  let total = 0, noReason = 0;
  for (const l of d.lines) {
    total += l.valueCents;
    if (l.reason === NO_REASON) noReason += l.valueCents;
    const r = reasons.get(l.reason) ?? { reason: l.reason, lines: 0, valueCents: 0 };
    r.lines++; r.valueCents += l.valueCents; reasons.set(l.reason, r);
    const c = row(l.workCenterId, l.workCenterName);
    c.scrapLines++; c.valueCents += l.valueCents;
    const i = items.get(l.itemId) ?? { itemId: l.itemId, sku: l.sku, name: l.name, quantity: 0, valueCents: 0, lines: 0 };
    i.quantity += l.quantity; i.valueCents += l.valueCents; i.lines++; items.set(l.itemId, i);
    const s = sources.get(l.source) ?? { valueCents: 0, lines: 0 };
    s.valueCents += l.valueCents; s.lines++; sources.set(l.source, s);
    point(l.at).valueCents += l.valueCents;
  }
  // Output: scrapped output per work center and day, good output = produced - scrapped output.
  for (const l of d.outputScrap) {
    row(l.workCenterId, l.workCenterName).scrappedOutput += l.quantity;
    point(l.at).scrappedOutput += l.quantity;
  }
  for (const g of d.good) {
    row(g.workCenterId, d.center.get(g.workCenterId) ?? "Deleted work center").goodOutput += g.qty;
    point(g.at).goodOutput += g.qty;
  }
  // produce lines include scrapped output (made and written off); take it back out
  for (const l of d.outputScrap) {
    row(l.workCenterId, l.workCenterName).goodOutput -= l.quantity;
    point(l.at).goodOutput -= l.quantity;
  }
  let goodTotal = 0, scrappedTotal = 0;
  for (const c of centers.values()) {
    c.goodOutput = Math.max(0, c.goodOutput);
    c.yieldPct = pct(c.goodOutput, c.scrappedOutput);
    goodTotal += c.goodOutput; scrappedTotal += c.scrappedOutput;
  }
  for (const p of trend.values()) { p.goodOutput = Math.max(0, p.goodOutput); p.yieldPct = pct(p.goodOutput, p.scrappedOutput); }

  return {
    windowDays: days, from: d.from.toISOString(), to: d.to.toISOString(), bucket,
    totals: { valueCents: total, lines: d.lines.length, goodOutput: goodTotal, scrappedOutput: scrappedTotal, yieldPct: pct(goodTotal, scrappedTotal), noReasonValueCents: noReason },
    bySource: (["usage", "output", "hold"] as const).map((source) => ({ source, ...(sources.get(source) ?? { valueCents: 0, lines: 0 }) })),
    byReason: [...reasons.values()].sort((a, b) => b.valueCents - a.valueCents || b.lines - a.lines),
    byWorkCenter: [...centers.values()].sort((a, b) => b.valueCents - a.valueCents),
    byItem: [...items.values()].sort((a, b) => b.valueCents - a.valueCents),
    trend: [...trend.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function createScrapReportRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", zValidator("query", scrapQuerySchema), async (c) => {
    const { days, workCenterId } = c.req.valid("query");
    return c.json(await scrapReport(store, c.get("org")._id, days, workCenterId));
  });

  /** Every scrap line in the window, for a spreadsheet. */
  r.get("/lines.csv", zValidator("query", scrapQuerySchema), async (c) => {
    const { days, workCenterId } = c.req.valid("query");
    const d = await loadScrap(store, c.get("org")._id, days, workCenterId);
    const out = ["date,source,work_order,work_center,item_sku,item,quantity,value,reason,by"];
    for (const l of [...d.lines].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      out.push([dayKey(l.at), l.source, csvText(l.woNumber), csvText(l.workCenterName), csvText(l.sku), csvText(l.name), csvNumber(l.quantity), (l.valueCents / 100).toFixed(2), csvText(l.reason), csvText(l.by)].join(","));
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="scrap-${days}d-${dayKey(new Date())}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${out.join("\r\n")}\r\n`);
  });

  return r;
}
