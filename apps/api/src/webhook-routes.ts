import { zValidator } from "@hono/zod-validator";
import { objectIdSchema, webhookInputSchema, webhookUpdateSchema, type Webhook, type WebhookWithSecret } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import type { Store, WebhookDoc } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { deliverNow, newSecret, queueTest, toDelivery } from "./webhooks.js";
import { validateWebhookUrl } from "./webhook-safety.js";

const MAX_WEBHOOKS = 20;
const idParam = z.object({ id: objectIdSchema });
const deliveryParam = z.object({ id: objectIdSchema, deliveryId: objectIdSchema });

export function createWebhookRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  r.use("*", requireRole("admin"));

  const present = async (h: WebhookDoc): Promise<Webhook> => {
    const last = await store.webhookDeliveries.findOne({ webhookId: h._id }, { sort: { createdAt: -1 } });
    return {
      id: h._id.toHexString(), url: h.url, events: h.events, description: h.description, enabled: h.enabled,
      disabledReason: h.disabledReason ?? null, createdAt: h.createdAt.toISOString(), createdBy: h.createdBy.name,
      lastDelivery: last ? toDelivery(last) : null,
    };
  };
  const host = (url: string) => new URL(url).host;

  r.get("/", async (c) => {
    const docs = await store.webhooks.find({ orgId: c.get("org")._id }).sort({ createdAt: -1 }).toArray();
    return c.json(await Promise.all(docs.map(present)));
  });

  r.post("/", zValidator("json", webhookInputSchema), async (c) => {
    const org = c.get("org");
    const input = c.req.valid("json");
    const checked = validateWebhookUrl(input.url);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    if ((await store.webhooks.countDocuments({ orgId: org._id })) >= MAX_WEBHOOKS) return c.json({ error: `An organization can have ${MAX_WEBHOOKS} webhooks.` }, 409);
    const me = c.get("user");
    const now = new Date();
    const doc: WebhookDoc = {
      _id: new ObjectId(), orgId: org._id, url: checked.url.toString(), events: input.events, description: input.description,
      secret: newSecret(), enabled: true, failures: 0, createdBy: { id: new ObjectId(me.id), name: me.name }, createdAt: now, updatedAt: now,
    };
    await store.webhooks.insertOne(doc);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "webhook.created",
      entity: { type: "organization", id: org._id.toHexString(), label: `Webhook ${host(doc.url)}` },
      summary: `Added a webhook to ${host(doc.url)} for ${doc.events.includes("*") ? "all events" : doc.events.join(", ")}`,
      refs: { webhookId: doc._id.toHexString() },
    });
    return c.json<WebhookWithSecret>({ ...(await present(doc)), secret: doc.secret }, 201);
  });

  r.patch("/:id", zValidator("param", idParam), zValidator("json", webhookUpdateSchema), async (c) => {
    const org = c.get("org");
    const patch = c.req.valid("json");
    const _id = new ObjectId(c.req.valid("param").id);
    const before = await store.webhooks.findOne({ _id, orgId: org._id });
    if (!before) return c.json({ error: "Webhook not found" }, 404);
    const set: Partial<WebhookDoc> = { updatedAt: new Date() };
    const said: string[] = [];
    if (patch.url !== undefined) {
      const checked = validateWebhookUrl(patch.url);
      if (!checked.ok) return c.json({ error: checked.error }, 400);
      if (checked.url.toString() !== before.url) { set.url = checked.url.toString(); said.push(`address to ${host(set.url)}`); }
    }
    if (patch.events && patch.events.join() !== before.events.join()) { set.events = patch.events; said.push("events"); }
    if (patch.description !== undefined && patch.description !== before.description) { set.description = patch.description; said.push("description"); }
    const unset: Record<string, ""> = {};
    if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
      set.enabled = patch.enabled;
      said.push(patch.enabled ? "switched on" : "switched off");
      if (patch.enabled) { set.failures = 0; unset.disabledReason = ""; }
    }
    await store.webhooks.updateOne({ _id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    const after = (await store.webhooks.findOne({ _id }))!;
    if (said.length) {
      await recordAudit(store, {
        orgId: org._id, actor: auditActor(c.get("user")), action: "webhook.updated",
        entity: { type: "organization", id: org._id.toHexString(), label: `Webhook ${host(after.url)}` },
        summary: `Changed the webhook to ${host(after.url)}: ${said.join(", ")}`,
        refs: { webhookId: _id.toHexString() },
      });
    }
    return c.json(await present(after));
  });

  r.delete("/:id", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const _id = new ObjectId(c.req.valid("param").id);
    const doc = await store.webhooks.findOneAndDelete({ _id, orgId: org._id });
    if (!doc) return c.json({ error: "Webhook not found" }, 404);
    await store.webhookDeliveries.deleteMany({ webhookId: _id });
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "webhook.deleted",
      entity: { type: "organization", id: org._id.toHexString(), label: `Webhook ${host(doc.url)}` },
      summary: `Removed the webhook to ${host(doc.url)}`,
      refs: { webhookId: _id.toHexString() },
    });
    return c.body(null, 204);
  });

  /** A new signing secret. The old one stops working at once. Shown only in this answer. */
  r.post("/:id/rotate-secret", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const secret = newSecret();
    const doc = await store.webhooks.findOneAndUpdate({ _id: new ObjectId(c.req.valid("param").id), orgId: org._id }, { $set: { secret, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!doc) return c.json({ error: "Webhook not found" }, 404);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "webhook.secret_rotated",
      entity: { type: "organization", id: org._id.toHexString(), label: `Webhook ${host(doc.url)}` },
      summary: `Changed the signing secret of the webhook to ${host(doc.url)}`,
      refs: { webhookId: doc._id.toHexString() },
    });
    return c.json<WebhookWithSecret>({ ...(await present(doc)), secret });
  });

  /** Sends a made-up event right now and says how it went. */
  r.post("/:id/test", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const hook = await store.webhooks.findOne({ _id: new ObjectId(c.req.valid("param").id), orgId: org._id });
    if (!hook) return c.json({ error: "Webhook not found" }, 404);
    const queued = await queueTest(store, hook, c.get("user").name);
    const sent = await deliverNow(store, queued._id);
    return c.json(toDelivery(sent ?? queued));
  });

  r.get("/:id/deliveries", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const _id = new ObjectId(c.req.valid("param").id);
    if (!(await store.webhooks.findOne({ _id, orgId: org._id }, { projection: { _id: 1 } }))) return c.json({ error: "Webhook not found" }, 404);
    const docs = await store.webhookDeliveries.find({ webhookId: _id }).sort({ createdAt: -1 }).limit(50).toArray();
    return c.json(docs.map(toDelivery));
  });

  /** Tries a failed delivery again, once, now. */
  r.post("/:id/deliveries/:deliveryId/retry", zValidator("param", deliveryParam), async (c) => {
    const org = c.get("org");
    const p = c.req.valid("param");
    const d = await store.webhookDeliveries.findOneAndUpdate(
      { _id: new ObjectId(p.deliveryId), webhookId: new ObjectId(p.id), orgId: org._id, status: "failed" },
      { $set: { status: "pending", nextAttemptAt: new Date(), attempts: 0 }, $unset: { error: "", responseStatus: "" } },
      { returnDocument: "after" },
    );
    if (!d) return c.json({ error: "Only a delivery that gave up can be retried" }, 404);
    const sent = await deliverNow(store, d._id);
    return c.json(toDelivery(sent ?? d));
  });

  return r;
}
