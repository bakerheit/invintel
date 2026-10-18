import { zValidator } from "@hono/zod-validator";
import { AUDIT_ENTITY_TYPES, objectIdSchema, type AuditPage } from "@invintel/shared";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { ObjectId, type Filter } from "mongodb";
import { z } from "zod";
import { auditCsvHeader, auditCsvRow, toAuditEvent, verifyChain } from "./audit.js";
import type { AuditEventDoc, Store } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const filterQuery = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  /** An id (or, for stock events, an item id). */
  entityId: z.string().trim().max(64).optional(),
  /** A full action ("item.updated") or a group ("item", "stock"). */
  action: z.string().trim().max(60).optional(),
  actorId: objectIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

const listQuery = filterQuery.extend({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function buildFilter(orgId: ObjectId, q: z.infer<typeof filterQuery>): Filter<AuditEventDoc> {
  const filter: Filter<AuditEventDoc> = { orgId };
  if (q.entityType) filter["entity.type"] = q.entityType;
  if (q.entityId) filter["entity.id"] = q.entityId;
  if (q.actorId) filter["actor.id"] = new ObjectId(q.actorId);
  if (q.action) {
    filter.action = q.action.includes(".")
      ? (q.action as AuditEventDoc["action"])
      : ({ $regex: `^${escapeRegex(q.action)}\\.` } as unknown as AuditEventDoc["action"]);
  }
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), "i");
    filter.$or = [{ summary: rx }, { "entity.label": rx }, { "actor.name": rx }];
  }
  return filter;
}

/** The audit log is for admins: it shows who changed what, including other people's work. */
export function createAuditRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  r.use("*", requireRole("admin"));

  r.get("/", zValidator("query", listQuery), async (c) => {
    const orgId = c.get("org")._id;
    const { before, limit, ...filters } = c.req.valid("query");
    const filter = buildFilter(orgId, filters);
    if (before) filter.seq = { $lt: before };
    const docs = await store.audit.find(filter).sort({ seq: -1 }).limit(limit + 1).toArray();
    const page: AuditPage = {
      events: docs.slice(0, limit).map(toAuditEvent),
      ...(docs.length > limit ? { nextBefore: docs[limit - 1]!.seq } : {}),
    };
    return c.json(page);
  });

  r.get("/verify", async (c) => c.json(await verifyChain(store, c.get("org")._id)));

  /** Everything matching the filters, oldest first, as CSV. Streamed so a big history isn't held in memory. */
  r.get("/export", zValidator("query", filterQuery), (c) => {
    const orgId = c.get("org")._id;
    const filter = buildFilter(orgId, c.req.valid("query"));
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    return stream(c, async (s) => {
      await s.write(`${auditCsvHeader()}\n`);
      for await (const doc of store.audit.find(filter).sort({ seq: 1 })) {
        await s.write(`${auditCsvRow(doc)}\n`);
      }
    });
  });

  return r;
}
