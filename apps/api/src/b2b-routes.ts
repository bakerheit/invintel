import { zValidator } from "@hono/zod-validator";
import {
  b2bAckSchema, objectIdSchema, sendMessageInputSchema, tradingPartnerInputSchema, tradingPartnerUpdateSchema,
  B2B_STATES, type B2BMessageDetail, type TradingPartner,
} from "@invintel/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, diffFields, recordAudit, summarizeChanges } from "./audit.js";
import { bridgeIds, getBridge, presentMessages, receiveMessage, recordAck, retryMessage, sendMessage } from "./b2b-core.js";
import { createCaptureRoutes, createFileRoutes } from "./b2b-capture-routes.js";
import { orderExchange, previewPurchaseOrder, sendPurchaseOrder } from "./b2b-orders.js";
import { duplicateField, isDuplicateKey, type Store, type TradingPartnerDoc } from "./db.js";
import { actorOf } from "./items.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);

const toPartner = (p: TradingPartnerDoc): TradingPartner => ({
  id: p._id.toHexString(), name: p.name, kind: p.kind, supplierId: p.supplierId?.toHexString() ?? null, identifiers: p.identifiers, bridge: p.bridge,
  bridgeConfig: p.bridgeConfig, mode: p.mode, enabled: p.enabled, contactEmail: p.contactEmail, note: p.note, createdAt: p.createdAt.toISOString(),
});

/** Trading partners, the message log and the actions on it, for signed-in people (under /api/orgs/:orgId/b2b). */
export function createB2BRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  async function check(orgId: ObjectId, p: { bridge?: string; supplierId?: string | null }) {
    if (p.bridge !== undefined && !getBridge(p.bridge)) return { status: 422 as const, error: `There is no bridge called "${p.bridge}". Available: ${bridgeIds().join(", ")}` };
    if (p.supplierId && !(await store.suppliers.findOne({ _id: oid(p.supplierId), orgId }, { projection: { _id: 1 } }))) return { status: 404 as const, error: "Supplier not found" };
    return null;
  }

  r.get("/bridges", (c) => c.json(bridgeIds().map((id) => ({ id, carries: getBridge(id)!.carries }))));

  r.get("/partners", async (c) => c.json((await store.tradingPartners.find({ orgId: c.get("org")._id }).collation({ locale: "en", strength: 2 }).sort({ name: 1 }).toArray()).map(toPartner)));

  r.post("/partners", requireRole("admin"), zValidator("json", tradingPartnerInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const input = c.req.valid("json");
    const bad = await check(orgId, input);
    if (bad) return c.json({ error: bad.error }, bad.status);
    const doc: TradingPartnerDoc = { _id: new ObjectId(), orgId, ...input, supplierId: input.supplierId ? oid(input.supplierId) : null, createdAt: new Date() };
    try {
      await store.tradingPartners.insertOne(doc);
    } catch (e) {
      if (isDuplicateKey(e)) return c.json({ error: "A trading partner with that name already exists" }, 409);
      throw e;
    }
    await recordAudit(store, {
      orgId, actor: auditActor(c.get("user")), action: "b2b.partner_created", entity: { type: "trading_partner", id: doc._id.toHexString(), label: doc.name },
      summary: `Added trading partner ${doc.name} (${doc.kind}, ${doc.bridge}, ${doc.mode})`, snapshot: { name: doc.name, kind: doc.kind, bridge: doc.bridge, mode: doc.mode, identifiers: doc.identifiers },
    });
    return c.json(toPartner(doc), 201);
  });

  r.patch("/partners/:id", requireRole("admin"), zValidator("param", idParam), zValidator("json", tradingPartnerUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const patch = c.req.valid("json");
    const bad = await check(orgId, patch);
    if (bad) return c.json({ error: bad.error }, bad.status);
    const { supplierId, ...rest } = patch;
    let before: TradingPartnerDoc | null;
    try {
      before = await store.tradingPartners.findOneAndUpdate({ _id: oid(c.req.valid("param").id), orgId }, { $set: { ...rest, ...(supplierId !== undefined ? { supplierId: supplierId ? oid(supplierId) : null } : {}) } });
    } catch (e) {
      if (isDuplicateKey(e) && duplicateField(e) === "name") return c.json({ error: "A trading partner with that name already exists" }, 409);
      throw e;
    }
    if (!before) return c.json({ error: "Trading partner not found" }, 404);
    // Credentials and endpoints are never shown in audit entries: only the names of settings that changed.
    const changes = diffFields(
      { name: before.name, kind: before.kind, bridge: before.bridge, mode: before.mode, enabled: before.enabled, contactEmail: before.contactEmail, note: before.note },
      Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "bridgeConfig" && k !== "identifiers")),
    );
    if (rest.bridgeConfig) changes.push({ field: "bridgeConfig", from: Object.keys(before.bridgeConfig).sort().join(", "), to: Object.keys(rest.bridgeConfig).sort().join(", ") });
    if (changes.length) {
      await recordAudit(store, { orgId, actor: auditActor(c.get("user")), action: "b2b.partner_updated", entity: { type: "trading_partner", id: before._id.toHexString(), label: rest.name ?? before.name }, summary: summarizeChanges(changes), changes });
    }
    return c.json(toPartner((await store.tradingPartners.findOne({ _id: before._id }))!));
  });

  const listQuery = z.object({
    partnerId: objectIdSchema.optional(),
    direction: z.enum(["in", "out"]).optional(),
    state: z.enum(B2B_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  r.get("/messages", zValidator("query", listQuery), async (c) => {
    const orgId = c.get("org")._id;
    const q = c.req.valid("query");
    const docs = await store.b2bMessages.find({ orgId, ...(q.partnerId ? { partnerId: oid(q.partnerId) } : {}), ...(q.direction ? { direction: q.direction } : {}), ...(q.state ? { state: q.state } : {}) }).sort({ createdAt: -1 }).limit(q.limit).toArray();
    return c.json(await presentMessages(store, orgId, docs));
  });

  r.get("/messages/:id", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.b2bMessages.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Message not found" }, 404);
    // The raw document of a sent order holds the supplier's private link, so only admins read bodies.
    return c.json<B2BMessageDetail>({ ...(await presentMessages(store, orgId, [doc]))[0]!, body: c.get("role") === "member" ? "" : doc.raw.body });
  });

  r.route("/invoices", createCaptureRoutes(store));
  r.route("/files", createFileRoutes(store));

  // ----- purchase orders -----

  /** What is going on between us and the supplier for this order. */
  r.get("/orders/:id", zValidator("param", idParam), async (c) => {
    const res = await orderExchange(store, c.get("org")._id, oid(c.req.valid("param").id));
    return "ok" in res ? c.json({ error: res.error }, res.status) : c.json(res);
  });

  /** Email the order (PDF and a confirmation link) to its supplier's trading partner. */
  r.post("/orders/:id/send", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const res = await sendPurchaseOrder(store, org._id, actorOf(c.get("user")), oid(c.req.valid("param").id), org.name);
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json((await presentMessages(store, org._id, [res.message]))[0], res.created ? 201 : 200);
  });

  /** The PDF the supplier would get. Nothing is sent. */
  r.get("/orders/:id/preview.pdf", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const res = await previewPurchaseOrder(store, org._id, oid(c.req.valid("param").id), org.name);
    if (!res.ok) return c.json({ error: res.error }, res.status);
    c.header("content-type", "application/pdf");
    c.header("content-disposition", `inline; filename="${res.canonical.poNumber}.pdf"`);
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(res.pdf));
  });

  /** Send a document to a partner through its bridge. */
  r.post("/partners/:id/messages", requireRole("admin"), zValidator("param", idParam), zValidator("json", sendMessageInputSchema), async (c) => {
    const orgId = c.get("org")._id;
    const res = await sendMessage(store, orgId, actorOf(c.get("user")), oid(c.req.valid("param").id), c.req.valid("json"));
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json((await presentMessages(store, orgId, [res.message]))[0], res.created ? 201 : 200);
  });

  r.post("/messages/:id/retry", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const res = await retryMessage(store, orgId, actorOf(c.get("user")), oid(c.req.valid("param").id));
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json((await presentMessages(store, orgId, [res.message]))[0]);
  });

  /** Record an answer by hand ("confirmed by phone", or our decision on a document we received). */
  r.post("/messages/:id/ack", requireRole("admin"), zValidator("param", idParam), zValidator("json", b2bAckSchema), async (c) => {
    const orgId = c.get("org")._id;
    const res = await recordAck(store, orgId, oid(c.req.valid("param").id), c.req.valid("json"), actorOf(c.get("user")));
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json((await presentMessages(store, orgId, [res.message]))[0]);
  });

  return r;
}

/**
 * Where a partner's system posts documents to us. No session: the partner's bridge verifies the request itself
 * (a signature, a shared secret, a certificate). Unknown, switched-off and unverifiable requests all get the same
 * plain refusal, and nothing is stored until the bridge has accepted the request.
 */
export function createB2BInboundRoutes(store: Store) {
  const r = new Hono();
  const hits = new Map<string, { n: number; reset: number }>();
  const tooMany = (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + 60_000 }); return false; }
    return ++h.n > 120;
  };

  r.post("/:partnerId", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Too big" }, 413) }), async (c) => {
    const raw = c.req.param("partnerId");
    if (!/^[0-9a-f]{24}$/i.test(raw)) return c.json({ error: "Not accepted" }, 404);
    if (tooMany(raw)) return c.json({ error: "Slow down" }, 429);
    const partner = await store.tradingPartners.findOne({ _id: oid(raw) }, { projection: { orgId: 1 } });
    if (!partner) return c.json({ error: "Not accepted" }, 404);
    const headers = Object.fromEntries([...c.req.raw.headers].map(([k, v]) => [k.toLowerCase(), v]));
    const res = await receiveMessage(store, partner.orgId, oid(raw), { headers, body: await c.req.text() });
    if (!res.ok) return c.json({ error: "Not accepted" }, res.status === 404 || res.status === 409 ? 404 : 422);
    return c.json({ id: res.message._id.toHexString(), duplicate: res.duplicate }, res.duplicate ? 200 : 201);
  });

  return r;
}
