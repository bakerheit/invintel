import { zValidator } from "@hono/zod-validator";
import {
  DEFAULT_DOWNTIME_REASONS, downtimeSettingsSchema, downtimeStartSchema, objectIdSchema,
  type DowntimeEvent, type DowntimeSummary, type DowntimeWorkCenterRow,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { isDuplicateKey, type DowntimeDoc, type OrgDoc, type Store } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const MIN = 60_000;
const DAY = 86_400_000;
const idParam = z.object({ id: objectIdSchema });

export const reasonsOf = (org: Pick<OrgDoc, "downtimeReasons">) => org.downtimeReasons ?? [...DEFAULT_DOWNTIME_REASONS];
export const hoursOf = (org: Pick<OrgDoc, "scheduledHoursPerDay">) => org.scheduledHoursPerDay ?? 8;

/** Minutes of one event that fall inside [from, to]. An event still running counts up to `now`. */
export const minutesWithin = (e: Pick<DowntimeDoc, "startedAt" | "endedAt">, from: Date, to: Date, now: Date) => {
  const start = Math.max(e.startedAt.getTime(), from.getTime());
  const end = Math.min((e.endedAt ?? now).getTime(), to.getTime());
  return end > start ? Math.round((end - start) / MIN) : 0;
};

/**
 * Downtime log and a rough availability figure. "Availability" here is the share of scheduled hours a machine was
 * not logged as down; it ignores speed and quality, so it is OEE-lite, not OEE.
 */
export function createDowntimeRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  async function present(docs: DowntimeDoc[]): Promise<DowntimeEvent[]> {
    const centers = await store.workCenters.find({ _id: { $in: [...new Set(docs.map((d) => d.workCenterId.toHexString()))].map((x) => new ObjectId(x)) } }).toArray();
    const name = new Map(centers.map((c) => [c._id.toHexString(), c.name]));
    const now = new Date();
    return docs.map((d) => ({
      id: d._id.toHexString(), workCenterId: d.workCenterId.toHexString(), workCenterName: name.get(d.workCenterId.toHexString()) ?? "Deleted work center",
      reason: d.reason, note: d.note, startedAt: d.startedAt.toISOString(), endedAt: d.endedAt?.toISOString() ?? null, startedBy: d.startedBy.name, endedBy: d.endedBy?.name ?? null,
      minutes: Math.max(0, Math.round(((d.endedAt ?? now).getTime() - d.startedAt.getTime()) / MIN)),
    }));
  }

  r.get("/settings", (c) => c.json({ reasons: reasonsOf(c.get("org")), scheduledHoursPerDay: hoursOf(c.get("org")) }));

  r.put("/settings", requireRole("admin"), zValidator("json", downtimeSettingsSchema), async (c) => {
    const org = c.get("org");
    const s = c.req.valid("json");
    await store.orgs.updateOne({ _id: org._id }, { $set: { downtimeReasons: s.reasons, scheduledHoursPerDay: s.scheduledHoursPerDay } });
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "downtime.settings_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
      summary: `Changed downtime settings: ${s.reasons.length} reasons, ${s.scheduledHoursPerDay} scheduled hours a day`,
      changes: [{ field: "downtimeReasons", from: reasonsOf(org), to: s.reasons }, { field: "scheduledHoursPerDay", from: hoursOf(org), to: s.scheduledHoursPerDay }],
    });
    return c.json(s);
  });

  /** Any member (the operator) can say a machine is down and say when it is back. */
  r.post("/start", zValidator("json", downtimeStartSchema), async (c) => {
    const org = c.get("org");
    const { workCenterId, reason, note } = c.req.valid("json");
    const center = await store.workCenters.findOne({ _id: new ObjectId(workCenterId), orgId: org._id });
    if (!center) return c.json({ error: "Work center not found" }, 404);
    const allowed = reasonsOf(org).find((x) => x.toLowerCase() === reason.toLowerCase());
    if (!allowed) return c.json({ error: "Pick a reason from the list" }, 400);
    const me = c.get("user");
    const doc: DowntimeDoc = { _id: new ObjectId(), orgId: org._id, workCenterId: center._id, reason: allowed, note, open: true, startedAt: new Date(), startedBy: { id: new ObjectId(me.id), name: me.name } };
    try {
      await store.downtime.insertOne(doc);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const open = await store.downtime.findOne({ orgId: org._id, workCenterId: center._id, endedAt: { $exists: false } });
      return c.json({ error: `${center.name} is already down${open ? ` since ${open.startedAt.toISOString()} (${open.reason})` : ""}`, event: open ? (await present([open]))[0] : undefined }, 409);
    }
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "downtime.started", entity: { type: "work_center", id: center._id.toHexString(), label: center.name },
      summary: `${center.name} down: ${allowed}${note ? ` (${note})` : ""}`, refs: { downtimeId: doc._id.toHexString() },
    });
    return c.json((await present([doc]))[0], 201);
  });

  r.post("/:id/end", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const doc = await store.downtime.findOneAndUpdate(
      { _id: new ObjectId(c.req.valid("param").id), orgId: org._id, endedAt: { $exists: false } },
      { $set: { endedAt: new Date(), endedBy: { id: new ObjectId(me.id), name: me.name } }, $unset: { open: "" } },
      { returnDocument: "after" },
    );
    if (!doc) return c.json({ error: "That downtime isn't open" }, 409);
    const ev = (await present([doc]))[0]!;
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "downtime.ended", entity: { type: "work_center", id: ev.workCenterId, label: ev.workCenterName },
      summary: `${ev.workCenterName} back up after ${ev.minutes} min (${ev.reason})`, refs: { downtimeId: ev.id },
    });
    return c.json(ev);
  });

  r.get("/", async (c) => {
    const org = c.get("org");
    const wc = c.req.query("workCenterId");
    const open = c.req.query("open") === "1";
    const filter = { orgId: org._id, ...(wc && /^[0-9a-f]{24}$/i.test(wc) ? { workCenterId: new ObjectId(wc) } : {}), ...(open ? { endedAt: { $exists: false } } : {}) };
    return c.json(await present(await store.downtime.find(filter).sort({ startedAt: -1 }).limit(100).toArray()));
  });

  r.get("/summary", async (c) => {
    const org = c.get("org");
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 7));
    const now = new Date();
    const from = new Date(now.getTime() - days * DAY);
    const hours = hoursOf(org);
    const [centers, events] = await Promise.all([
      store.workCenters.find({ orgId: org._id }).sort({ name: 1 }).toArray(),
      // Anything that overlaps the window: started before the end and not ended before the start.
      store.downtime.find({ orgId: org._id, startedAt: { $lt: now }, $or: [{ endedAt: { $exists: false } }, { endedAt: { $gt: from } }] }).toArray(),
    ]);
    const scheduled = days * hours * 60;
    const reasonTotals = new Map<string, { minutes: number; events: number }>();
    const rows: DowntimeWorkCenterRow[] = centers.map((wc) => {
      const mine = events.filter((e) => e.workCenterId.equals(wc._id));
      const byReason = new Map<string, number>();
      let down = 0;
      for (const e of mine) {
        const m = minutesWithin(e, from, now, now);
        down += m;
        byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + m);
        const t = reasonTotals.get(e.reason) ?? { minutes: 0, events: 0 };
        t.minutes += m; t.events++;
        reasonTotals.set(e.reason, t);
      }
      const openEv = mine.find((e) => !e.endedAt);
      const top = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        workCenterId: wc._id.toHexString(), name: wc.name, events: mine.length, downMinutes: down, scheduledMinutes: scheduled,
        availabilityPct: Math.max(0, Math.round(((scheduled - down) / scheduled) * 1000) / 10), topReason: top && top[1] > 0 ? top[0] : null,
        downNow: openEv ? { eventId: openEv._id.toHexString(), reason: openEv.reason, since: openEv.startedAt.toISOString() } : null,
      };
    });
    const out: DowntimeSummary = {
      windowDays: days, from: from.toISOString(), to: now.toISOString(), scheduledHoursPerDay: hours, rows,
      byReason: [...reasonTotals.entries()].map(([reason, t]) => ({ reason, ...t })).sort((a, b) => b.minutes - a.minutes),
      totalDownMinutes: rows.reduce((s, x) => s + x.downMinutes, 0),
    };
    return c.json(out);
  });

  return r;
}
