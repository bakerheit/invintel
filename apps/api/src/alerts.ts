import { zValidator } from "@hono/zod-validator";
import {
  DEFAULT_ALERT_SETTINGS, alertKeySchema, alertSettingsSchema, alertSnoozeSchema, type Alert, type AlertsResponse, type AlertSettings, type DigestPreview,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { auditActor, recordAudit } from "./audit.js";
import { countScheduleReport } from "./reports.js";
import type { OrgDoc, Store } from "./db.js";
import { loadItems } from "./item-queries.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { isOpen, toOrders } from "./purchasing.js";

const DAY = 86_400_000;
const MIN = 60_000;

export const alertSettingsOf = (org: Pick<OrgDoc, "alertSettings">): AlertSettings => ({ ...DEFAULT_ALERT_SETTINGS, ...org.alertSettings });

/** Every problem the data shows right now, before anyone has acknowledged anything. */
export async function computeAlerts(store: Store, org: OrgDoc, now = new Date()): Promise<Omit<Alert, "state" | "by" | "at" | "snoozedUntil">[]> {
  const orgId = org._id;
  const settings = alertSettingsOf(org);
  const mods = { purchasing: true, production: true, sales: true, ...org.modules };
  const base = `/o/${orgId.toHexString()}`;
  const out: Omit<Alert, "state" | "by" | "at" | "snoozedUntil">[] = [];

  // Stock: out, low, and running out soon at the recent pace.
  const since = new Date(now.getTime() - 30 * DAY);
  const [items, used] = await Promise.all([
    loadItems(store, orgId),
    store.movements.aggregate<{ _id: ObjectId; qty: number }>([
      { $match: { orgId, type: "consume", delta: { $lt: 0 }, reversedBy: { $exists: false }, createdAt: { $gte: since } } },
      { $group: { _id: "$itemId", qty: { $sum: { $multiply: ["$delta", -1] } } } },
    ]).toArray(),
  ]);
  const perDay = new Map(used.map((u) => [u._id.toHexString(), u.qty / 30]));
  for (const i of items) {
    const qty = i.stock.reduce((s, x) => s + x.quantity, 0);
    const subject = { type: "item" as const, id: i._id.toHexString(), label: `${i.name} (${i.sku})` };
    const link = `${base}/inventory/${subject.id}`;
    if (qty <= 0) {
      out.push({ key: `out_of_stock:${subject.id}`, type: "out_of_stock", severity: "critical", title: `${i.name} is out of stock`, detail: i.reorderLevel > 0 ? `Reorder level is ${i.reorderLevel}.` : "None on hand.", subject, link });
    } else if (i.reorderLevel > 0 && qty <= i.reorderLevel) {
      out.push({ key: `low_stock:${subject.id}`, type: "low_stock", severity: "warning", title: `${i.name} is low`, detail: `${qty} on hand, reorder at ${i.reorderLevel}.`, subject, link });
    }
    const rate = perDay.get(subject.id) ?? 0;
    if (qty > 0 && rate > 0) {
      const days = qty / rate;
      if (days < settings.daysOfSupply) {
        out.push({ key: `days_of_supply:${subject.id}`, type: "days_of_supply", severity: "warning", title: `${i.name} runs out in about ${Math.max(1, Math.round(days))} ${Math.round(days) <= 1 ? "day" : "days"}`, detail: `${qty} on hand, using about ${Math.round(rate * 10) / 10} a day over the last 30 days.`, subject, link });
      }
    }
  }

  // Purchase orders that should have arrived by now.
  if (mods.purchasing) {
    const docs = await store.purchaseOrders.find({ orgId, state: "ordered", expectedDate: { $ne: null } }).toArray();
    const today = now.toISOString().slice(0, 10);
    for (const o of (await toOrders(store, docs)).filter(isOpen)) {
      if (!o.expectedDate || o.expectedDate >= today) continue;
      const late = Math.floor((now.getTime() - new Date(`${o.expectedDate}T00:00:00Z`).getTime()) / DAY);
      out.push({
        key: `late_po:${o.id}`, type: "late_po", severity: late >= 7 ? "critical" : "warning", title: `${o.number} from ${o.supplierName} is ${late} ${late === 1 ? "day" : "days"} late`,
        detail: `${o.receivedUnits} of ${o.orderedUnits} units received. Expected ${o.expectedDate}.`, subject: { type: "purchase_order", id: o.id, label: o.number }, link: `${base}/purchasing`,
      });
    }
  }

  // Places that are due or overdue for a count.
  const sched = await countScheduleReport(store, orgId, now);
  for (const r of sched.rows) {
    if (r.status !== "overdue" || r.openCountId) continue;
    out.push({
      key: `count_overdue:${r.locationId}`, type: "count_overdue", severity: "warning", title: `${r.locationPath} is ${r.daysOverdue} days overdue for a count`,
      detail: `Class ${r.abc} stock, counted every ${r.intervalDays} days. Last counted ${r.lastCountedAt?.slice(0, 10)}.`, subject: { type: "location", id: r.locationId, label: r.locationPath }, link: `${base}/counts?start=${r.locationId}`,
    });
  }

  // A machine that has been down a while.
  if (mods.production) {
    const open = await store.downtime.find({ orgId, endedAt: { $exists: false } }).toArray();
    const centers = new Map((await store.workCenters.find({ _id: { $in: open.map((d) => d.workCenterId) } }).toArray()).map((c) => [c._id.toHexString(), c.name]));
    for (const d of open) {
      const mins = Math.round((now.getTime() - d.startedAt.getTime()) / MIN);
      if (mins < settings.machineDownMinutes) continue;
      const name = centers.get(d.workCenterId.toHexString()) ?? "A machine";
      out.push({
        key: `machine_down:${d.workCenterId.toHexString()}`, type: "machine_down", severity: "critical", title: `${name} has been down ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}`,
        detail: `${d.reason}${d.note ? ` (${d.note})` : ""}. Started by ${d.startedBy.name}.`, subject: { type: "work_center", id: d.workCenterId.toHexString(), label: name }, link: `${base}/reports/downtime`,
      });
    }
  }
  return out;
}

export async function alertsFor(store: Store, org: OrgDoc, now = new Date()): Promise<AlertsResponse> {
  const raw = await computeAlerts(store, org, now);
  const states = await store.alertStates.find({ orgId: org._id }).toArray();
  const byKey = new Map(states.map((s) => [s.key, s]));
  const live = new Set(raw.map((a) => a.key));
  // An acknowledgement or snooze belongs to the problem: once it is gone, forget it, so it can come back as a new problem.
  const stale = states.filter((s) => !live.has(s.key) || (s.state === "snoozed" && s.until && s.until <= now));
  if (stale.length) await store.alertStates.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
  const staleIds = new Set(stale.map((s) => s._id.toHexString()));
  const alerts: Alert[] = raw.map((a) => {
    const s = byKey.get(a.key);
    const active = s && !staleIds.has(s._id.toHexString());
    return { ...a, state: active ? s.state : "open", by: active ? s.by.name : null, at: active ? s.at.toISOString() : null, snoozedUntil: active && s.until ? s.until.toISOString() : null };
  });
  const rank = { open: 0, acknowledged: 1, snoozed: 2 } as const;
  alerts.sort((a, b) => rank[a.state] - rank[b.state] || (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1) || a.title.localeCompare(b.title, "en"));
  const open = alerts.filter((a) => a.state === "open");
  return { asOf: now.toISOString(), alerts, open: { critical: open.filter((a) => a.severity === "critical").length, warning: open.filter((a) => a.severity === "warning").length, total: open.length } };
}

export function digestOf(org: Pick<OrgDoc, "name">, res: AlertsResponse): DigestPreview {
  const open = res.alerts.filter((a) => a.state === "open");
  const groups: [string, (a: Alert) => boolean][] = [
    ["Needs action now", (a) => a.severity === "critical"],
    ["Keep an eye on", (a) => a.severity === "warning"],
  ];
  const sections = groups.map(([title, f]) => ({ title, lines: open.filter(f).map((a) => `${a.title}. ${a.detail}`) })).filter((s) => s.lines.length);
  const quiet = res.alerts.length - open.length;
  const subject = open.length ? `${org.name}: ${open.length} ${open.length === 1 ? "thing needs" : "things need"} attention${res.open.critical ? ` (${res.open.critical} urgent)` : ""}` : `${org.name}: nothing needs attention`;
  const text = [subject, ...sections.flatMap((s) => ["", s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`)]), ...(quiet ? ["", `${quiet} more ${quiet === 1 ? "is" : "are"} acknowledged or snoozed.`] : [])].join("\n");
  return { asOf: res.asOf, subject, text, sections };
}

export function createAlertRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", async (c) => c.json(await alertsFor(store, c.get("org"))));
  r.get("/digest", async (c) => c.json(digestOf(c.get("org"), await alertsFor(store, c.get("org")))));
  r.get("/settings", (c) => c.json(alertSettingsOf(c.get("org"))));

  r.put("/settings", requireRole("admin"), zValidator("json", alertSettingsSchema), async (c) => {
    const org = c.get("org");
    const s = c.req.valid("json");
    await store.orgs.updateOne({ _id: org._id }, { $set: { alertSettings: s } });
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "alert.settings_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
      summary: `Changed alert settings: days of supply ${s.daysOfSupply}, machine down after ${s.machineDownMinutes} min`, changes: [{ field: "alertSettings", from: alertSettingsOf(org), to: s }],
    });
    return c.json(s);
  });

  /** Only a problem that exists right now can be acknowledged or snoozed. */
  const change = async (c: any, key: string, make: (now: Date) => { state: "acknowledged" | "snoozed"; until?: Date } | null, action: "alert.acknowledged" | "alert.snoozed" | "alert.reopened", verb: string) => {
    const org = c.get("org") as OrgDoc;
    const me = c.get("user") as { id: string; name: string };
    const now = new Date();
    const alert = (await alertsFor(store, org, now)).alerts.find((a) => a.key === key);
    if (!alert) return c.json({ error: "That alert isn't active any more" }, 404);
    const next = make(now);
    if (next) await store.alertStates.updateOne({ orgId: org._id, key }, { $set: { ...next, by: { id: new ObjectId(me.id), name: me.name }, at: now }, ...(next.until ? {} : { $unset: { until: "" } }) }, { upsert: true });
    else await store.alertStates.deleteOne({ orgId: org._id, key });
    await recordAudit(store, { orgId: org._id, actor: auditActor(me), action, entity: { type: "alert", id: key, label: alert.title }, summary: `${verb}: ${alert.title}`, refs: { key, type: alert.type } });
    return c.json((await alertsFor(store, org, now)).alerts.find((a) => a.key === key));
  };
  r.post("/acknowledge", zValidator("json", alertKeySchema), (c) => change(c, c.req.valid("json").key, () => ({ state: "acknowledged" }), "alert.acknowledged", "Acknowledged"));
  r.post("/snooze", zValidator("json", alertSnoozeSchema), (c) => {
    const { key, days } = c.req.valid("json");
    return change(c, key, (now) => ({ state: "snoozed", until: new Date(now.getTime() + days * DAY) }), "alert.snoozed", `Snoozed ${days} ${days === 1 ? "day" : "days"}`);
  });
  r.post("/reopen", zValidator("json", alertKeySchema), (c) => change(c, c.req.valid("json").key, () => null, "alert.reopened", "Reopened"));
  return r;
}
