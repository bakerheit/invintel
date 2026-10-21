import { WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT, type WebhookDelivery } from "@invintel/shared";
import { createHmac, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { onAuditEvent, recordAudit } from "./audit.js";
import type { AuditEventDoc, Store, WebhookDeliveryDoc, WebhookDoc } from "./db.js";
import { BlockedAddressError, postJson } from "./webhook-safety.js";
import { isSealed, openWebhookSecret, SecretUnavailableError, sealWebhookSecret, webhookSecretKey } from "./webhook-secrets.js";

/** Seconds to wait after each failed attempt. After the last one the delivery gives up. */
export const RETRY_DELAYS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600];
export const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
/** Deliveries that give up in a row before a webhook is switched off. */
export const MAX_FAILURES = 10;
const LEASE_MS = 60_000;

export const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

/** `t=<unix seconds>,v1=<hex>`: HMAC-SHA256 of "<t>.<body>" with the webhook's secret. The time lets a receiver reject old replays. */
export function sign(secret: string, body: string, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

const PUBLIC_EVENTS = new Set<string>(WEBHOOK_EVENTS);

/** What a receiver is sent for an audit event. No snapshots, and nothing that isn't already in the audit log. */
export function eventBody(event: AuditEventDoc): string {
  return JSON.stringify({
    id: event._id.toHexString(),
    type: event.action,
    createdAt: event.at.toISOString(),
    organizationId: event.orgId.toHexString(),
    seq: event.seq,
    actor: { name: event.actor.name },
    entity: event.entity,
    summary: event.summary,
    ...(event.changes?.length ? { changes: event.changes } : {}),
    ...(event.refs ? { refs: event.refs } : {}),
  });
}

/** Queues this event for every enabled webhook that listens for it. Runs after the audit event is written. */
export async function queueEvent(store: Store, event: AuditEventDoc): Promise<void> {
  if (!PUBLIC_EVENTS.has(event.action)) return;
  const hooks = await store.webhooks.find({ orgId: event.orgId, enabled: true, events: { $in: ["*", event.action] } }).toArray();
  if (!hooks.length) return;
  const body = eventBody(event);
  const now = new Date();
  await store.webhookDeliveries.insertMany(
    hooks.map((h) => ({
      _id: new ObjectId(), orgId: event.orgId, webhookId: h._id, eventId: event._id.toHexString(), type: event.action, body,
      status: "pending" as const, attempts: 0, nextAttemptAt: now, createdAt: now,
    })),
  );
}

/** Wires a store's audit events to webhook queues. Call once when the app is created. */
export const listenForEvents = (store: Store) => onAuditEvent(store, (event) => queueEvent(store, event));

/** A delivery the page can show. */
export const toDelivery = (d: WebhookDeliveryDoc): WebhookDelivery => ({
  id: d._id.toHexString(),
  eventId: d.eventId,
  type: d.type,
  status: d.status,
  attempts: d.attempts,
  responseStatus: d.responseStatus ?? null,
  error: d.error ?? null,
  createdAt: d.createdAt.toISOString(),
  deliveredAt: d.deliveredAt?.toISOString() ?? null,
  nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
});

/** Makes a delivery for a test, so someone setting up a receiver can see it work. */
export async function queueTest(store: Store, hook: WebhookDoc, by: string): Promise<WebhookDeliveryDoc> {
  const id = new ObjectId();
  const now = new Date();
  const doc: WebhookDeliveryDoc = {
    _id: new ObjectId(), orgId: hook.orgId, webhookId: hook._id, eventId: id.toHexString(), type: WEBHOOK_TEST_EVENT,
    body: JSON.stringify({
      id: id.toHexString(), type: WEBHOOK_TEST_EVENT, createdAt: now.toISOString(), organizationId: hook.orgId.toHexString(),
      actor: { name: by }, summary: "This is a test from Invintel. If you can read it, the webhook works.",
    }),
    status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now,
  };
  await store.webhookDeliveries.insertOne(doc);
  return doc;
}

const describeError = (e: unknown) => {
  if (e instanceof BlockedAddressError) return e.message;
  const err = e as NodeJS.ErrnoException;
  if (err.code === "ENOTFOUND") return "The address couldn't be found (no such host name)";
  if (err.code === "ECONNREFUSED") return "The receiver refused the connection";
  if (err.code === "ECONNRESET") return "The connection was cut off";
  if (err.code === "CERT_HAS_EXPIRED" || err.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /certificate/i.test(err.message ?? "")) return "The receiver's security certificate isn't valid";
  return (err.message || "The request failed").slice(0, 200);
};

/**
 * Makes one attempt at one delivery that a worker has already claimed. 2xx is delivered. Anything else (an answer
 * of 4xx or 5xx, a redirect, a timeout, a blocked address) is a failure that is tried again later, up to MAX_ATTEMPTS.
 */
export async function attempt(store: Store, d: WebhookDeliveryDoc): Promise<WebhookDeliveryDoc> {
  const hook = await store.webhooks.findOne({ _id: d.webhookId, orgId: d.orgId });
  const finish = async (set: Partial<WebhookDeliveryDoc>, unset: (keyof WebhookDeliveryDoc)[] = []) => {
    const next = await store.webhookDeliveries.findOneAndUpdate(
      { _id: d._id },
      { $set: set, $unset: Object.fromEntries([...unset, "leaseUntil"].map((k) => [k, ""])) },
      { returnDocument: "after" },
    );
    return next ?? d;
  };
  if (!hook) return finish({ status: "failed", nextAttemptAt: null, error: "The webhook was removed" });
  // A test is allowed through even on a switched-off webhook (that is how you check a fix). Real events are not.
  if (!hook.enabled && d.type !== WEBHOOK_TEST_EVENT) return finish({ status: "failed", nextAttemptAt: null, error: "The webhook is switched off" });

  // The secret is encrypted at rest when the server has a key. A plain one from before that is encrypted now, on first use.
  let secret: string;
  try {
    secret = openWebhookSecret(hook.secret);
    if (webhookSecretKey() && !isSealed(hook.secret)) await store.webhooks.updateOne({ _id: hook._id, secret: hook.secret }, { $set: { secret: sealWebhookSecret(secret) } });
  } catch (e) {
    if (!(e instanceof SecretUnavailableError)) throw e;
    // Waiting won't fix a missing or wrong key, and it isn't the receiver's fault, so it doesn't count toward switching the webhook off.
    return finish({ status: "failed", error: e.message, nextAttemptAt: null });
  }
  const body = d.body;
  let failure: string;
  let status: number | undefined;
  let blocked = false;
  try {
    const res = await postJson(hook.url, body, {
      "content-type": "application/json",
      "x-invintel-event": d.type,
      "x-invintel-event-id": d.eventId,
      "x-invintel-delivery": d._id.toHexString(),
      "x-invintel-signature": sign(secret, body),
    });
    status = res.status;
    if (res.status >= 200 && res.status < 300) {
      if (hook.failures) await store.webhooks.updateOne({ _id: hook._id }, { $set: { failures: 0 } });
      return finish({ status: "delivered", responseStatus: res.status, deliveredAt: new Date(), nextAttemptAt: null }, ["error"]);
    }
    failure = res.status >= 300 && res.status < 400 ? `The receiver answered ${res.status}: redirects aren't followed` : `The receiver answered ${res.status}`;
  } catch (e) {
    failure = describeError(e);
    blocked = e instanceof BlockedAddressError;
  }

  // A blocked address won't fix itself by waiting.
  const giveUp = blocked || d.attempts >= MAX_ATTEMPTS;
  if (!giveUp) {
    const delay = RETRY_DELAYS[Math.min(d.attempts - 1, RETRY_DELAYS.length - 1)]!;
    return finish({ status: "retrying", error: failure, ...(status ? { responseStatus: status } : {}), nextAttemptAt: new Date(Date.now() + delay * 1000) });
  }
  const done = await finish({ status: "failed", error: failure, ...(status ? { responseStatus: status } : {}), nextAttemptAt: null });
  if (d.type !== WEBHOOK_TEST_EVENT) await noteFailure(store, hook);
  return done;
}

/** Counts a delivery that gave up, and switches the webhook off when it keeps happening. */
async function noteFailure(store: Store, hook: WebhookDoc) {
  const updated = await store.webhooks.findOneAndUpdate({ _id: hook._id }, { $inc: { failures: 1 } }, { returnDocument: "after" });
  if (updated && updated.enabled && updated.failures >= MAX_FAILURES) {
    await store.webhooks.updateOne({ _id: hook._id }, { $set: { enabled: false, disabledReason: `Switched off after ${MAX_FAILURES} deliveries in a row failed`, updatedAt: new Date() } });
    await recordAudit(store, {
      orgId: hook.orgId, actor: { id: null, name: "Invintel" }, action: "webhook.disabled",
      entity: { type: "organization", id: hook.orgId.toHexString(), label: `Webhook ${new URL(hook.url).host}` },
      summary: `Switched off the webhook to ${new URL(hook.url).host} after ${MAX_FAILURES} failed deliveries in a row`,
    });
  }
}

/** Takes the next due delivery for itself, or null. Claiming is one atomic step, so two workers never send the same one. */
async function claim(store: Store, now: Date, onlyId?: ObjectId): Promise<WebhookDeliveryDoc | null> {
  return store.webhookDeliveries.findOneAndUpdate(
    {
      ...(onlyId ? { _id: onlyId } : {}),
      status: { $in: ["pending", "retrying"] },
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
    },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
  );
}

/** Sends everything that is due, a few at a time. Returns how many it tried. */
export async function deliverDue(store: Store, opts: { now?: Date; limit?: number; concurrency?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  let tried = 0;
  const worker = async () => {
    while (tried < limit) {
      const d = await claim(store, now);
      if (!d) return;
      tried++;
      await attempt(store, d).catch((e) => console.error("webhook delivery crashed", e));
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return tried;
}

/** Sends one particular delivery now (a test or a retry button), and returns how it went. */
export async function deliverNow(store: Store, id: ObjectId): Promise<WebhookDeliveryDoc | null> {
  const d = await claim(store, new Date(), id);
  return d ? attempt(store, d) : null;
}

/** Runs deliverDue every few seconds for as long as the server is up. */
export function startWebhookWorker(store: Store, everyMs = 5000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    deliverDue(store)
      .catch((e) => console.error("webhook worker", e))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
