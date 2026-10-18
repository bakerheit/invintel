import { B2B_TRANSITIONS, type B2BAckInput, type B2BDocType, type B2BMessage, type B2BMessageDetail, type B2BState, type SendMessageInput } from "@invintel/shared";
import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { recordAudit } from "./audit.js";
import { isDuplicateKey, type B2BMessageDoc, type Store, type TradingPartnerDoc } from "./db.js";
import type { Actor } from "./stock-service.js";

// INV-12: the transport-independent core of business-to-business exchange. A BRIDGE is the only thing that knows how
// documents travel (email, an EDI provider, the Invintel-to-Invintel exchange, a loopback for tests). Everything else,
// the message log, states, idempotency, retries, acknowledgements and audit, lives here and is the same for every bridge.
//
//   sendMessage(store, orgId, actor, partnerId, input)      write the message, hand it to the partner's bridge, record the result
//   receiveMessage(store, orgId, partnerId, request)         ask the bridge to verify an inbound request, then store what came in
//   retryMessage(store, orgId, actor, messageId)             send a failed message again (same message, same key)
//   recordAck(store, orgId, messageId, ack, actor?)          the other side's answer to something we sent (or ours to something received)
//
// To add a bridge: implement `Bridge` and call `registerBridge`. Bridges never touch the database.

/** What a bridge returns after trying to send. */
export type SendResult =
  | { ok: true; /** "delivered" when the bridge knows it arrived; otherwise "sent". */ state?: "sent" | "delivered"; providerMessageId?: string }
  | { ok: false; error: string; /** True when trying again later may work (timeout, 5xx); false when the document or setup is wrong. */ retryable: boolean };

export interface InboundRequest {
  headers: Record<string, string>;
  body: string;
}

/** What a bridge hands back after verifying an inbound request (a signature, a webhook secret, a certificate...). */
export type InboundResult =
  | { ok: true; docType: B2BDocType; body: string; contentType?: string; idempotencyKey: string; providerMessageId?: string; correlation?: B2BMessageDoc["correlation"] }
  | { ok: false; error: string };

export interface Bridge {
  /** The name partners refer to in `bridge`. */
  id: string;
  /** Document types this bridge can carry; sending another type fails before anything is attempted. */
  carries: B2BDocType[];
  send(message: { id: string; docType: B2BDocType; body: string; contentType: string; idempotencyKey: string; correlation: B2BMessageDoc["correlation"] }, partner: TradingPartnerDoc): Promise<SendResult>;
  verifyInbound(req: InboundRequest, partner: TradingPartnerDoc): Promise<InboundResult>;
}

const bridges = new Map<string, Bridge>();
export const registerBridge = (b: Bridge) => { bridges.set(b.id, b); };
export const getBridge = (id: string) => bridges.get(id);
export const bridgeIds = () => [...bridges.keys()];

/** A bridge that does nothing outside the process: accepts every document, answers like a cooperative partner. For tests and demos. */
export const loopbackBridge: Bridge = {
  id: "loopback",
  carries: ["order", "order_change", "order_response", "despatch_advice", "invoice", "remittance", "query", "query_response"],
  async send(m) { return { ok: true, state: "delivered", providerMessageId: `loop-${m.id}` }; },
  async verifyInbound(req) {
    try {
      const j = JSON.parse(req.body) as { docType?: B2BDocType; key?: string };
      if (!j.docType || !j.key) return { ok: false, error: "A loopback message needs docType and key" };
      return { ok: true, docType: j.docType, body: req.body, idempotencyKey: j.key };
    } catch {
      return { ok: false, error: "Not JSON" };
    }
  },
};
registerBridge(loopbackBridge);

export type Failure = { ok: false; status: 404 | 409 | 422; error: string };
export type Sent = { ok: true; message: B2BMessageDoc; created: boolean };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Moves a message to `to` only if that is a legal step; the state is part of the filter so two writers can't both win. */
export async function moveState(store: Store, msg: B2BMessageDoc, to: B2BState, extra: Record<string, unknown> = {}) {
  if (!B2B_TRANSITIONS[msg.state].includes(to)) return null;
  return store.b2bMessages.findOneAndUpdate({ _id: msg._id, state: msg.state }, { $set: { state: to, updatedAt: new Date(), ...extra } }, { returnDocument: "after" });
}

async function audit(store: Store, orgId: ObjectId, actor: { id: ObjectId | null; name: string }, action: "b2b.message_sent" | "b2b.message_received" | "b2b.message_failed" | "b2b.message_acknowledged", msg: B2BMessageDoc, partner: TradingPartnerDoc, summary: string) {
  await recordAudit(store, {
    orgId, actor, action, entity: { type: "b2b_message", id: msg._id.toHexString(), label: `${partner.name}: ${msg.docType}` }, summary,
    snapshot: { partner: partner.name, direction: msg.direction, docType: msg.docType, state: msg.state, mode: partner.mode, hash: msg.raw.hash, correlation: msg.correlation },
  });
}

const actorRef = (a: Actor) => ({ id: a.userId as ObjectId | null, name: a.userName });

async function attempt(store: Store, orgId: ObjectId, actor: Actor, partner: TradingPartnerDoc, msg: B2BMessageDoc): Promise<B2BMessageDoc> {
  const bridge = getBridge(partner.bridge);
  const fail = async (error: string, retryable: boolean) => {
    const failed = await store.b2bMessages.findOneAndUpdate(
      { _id: msg._id },
      { $set: { state: "failed", updatedAt: new Date() }, $push: { attempts: { at: new Date(), ok: false, error, retryable } } },
      { returnDocument: "after" },
    );
    const m = failed ?? msg;
    await audit(store, orgId, actorRef(actor), "b2b.message_failed", m, partner, `${partner.name}: ${msg.docType} could not be sent: ${error}`);
    return m;
  };
  if (!bridge) return fail(`There is no bridge called "${partner.bridge}"`, false);
  if (!bridge.carries.includes(msg.docType)) return fail(`The ${bridge.id} bridge doesn't carry ${msg.docType} documents`, false);
  let res: SendResult;
  try {
    res = await bridge.send({ id: msg._id.toHexString(), docType: msg.docType, body: msg.raw.body, contentType: msg.raw.contentType, idempotencyKey: msg.idempotencyKey, correlation: msg.correlation }, partner);
  } catch (e) {
    res = { ok: false, error: e instanceof Error ? e.message : "The bridge threw", retryable: true };
  }
  if (!res.ok) return fail(res.error, res.retryable);
  const next: B2BState = res.state ?? "sent";
  const moved = await store.b2bMessages.findOneAndUpdate(
    { _id: msg._id, state: "queued" },
    { $set: { state: next, updatedAt: new Date(), ...(res.providerMessageId ? { providerMessageId: res.providerMessageId } : {}) }, $push: { attempts: { at: new Date(), ok: true, error: "", retryable: false } } },
    { returnDocument: "after" },
  );
  const m = moved ?? msg;
  await audit(store, orgId, actorRef(actor), "b2b.message_sent", m, partner, `${partner.name}: ${msg.docType} ${next}${partner.mode === "test" ? " (test partner)" : ""}`);
  return m;
}

/** Writes the message (once per idempotency key), then tries to send it. A duplicate key returns the existing message untouched. */
export async function sendMessage(store: Store, orgId: ObjectId, actor: Actor, partnerId: ObjectId, input: SendMessageInput): Promise<Sent | Failure> {
  const partner = await store.tradingPartners.findOne({ _id: partnerId, orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  if (!partner.enabled) return { ok: false, status: 409, error: `${partner.name} is switched off` };
  const key = input.idempotencyKey ?? randomUUID();
  const existing = await store.b2bMessages.findOne({ orgId, partnerId, direction: "out", idempotencyKey: key });
  if (existing) return { ok: true, message: existing, created: false };
  const body = input.body;
  const now = new Date();
  const msg: B2BMessageDoc = {
    _id: new ObjectId(), orgId, partnerId, direction: "out", docType: input.docType, state: "queued", idempotencyKey: key,
    correlation: input.correlation ?? {}, raw: { body, contentType: input.contentType ?? "application/json", hash: sha(body), bytes: Buffer.byteLength(body) },
    attempts: [], acks: [], createdBy: { id: actor.userId, name: actor.userName }, createdAt: now, updatedAt: now,
  };
  try {
    await store.b2bMessages.insertOne(msg);
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // Two requests with the same key at once: the loser gets the winner's message.
    return { ok: true, message: (await store.b2bMessages.findOne({ orgId, partnerId, direction: "out", idempotencyKey: key }))!, created: false };
  }
  return { ok: true, message: await attempt(store, orgId, actor, partner, msg), created: true };
}

/** A failed message tries again as the same message with the same key (so the other side can recognise it). */
export async function retryMessage(store: Store, orgId: ObjectId, actor: Actor, messageId: ObjectId): Promise<Sent | Failure> {
  const msg = await store.b2bMessages.findOne({ _id: messageId, orgId });
  if (!msg) return { ok: false, status: 404, error: "Message not found" };
  if (msg.direction !== "out") return { ok: false, status: 409, error: "Only messages we sent can be retried" };
  if (msg.state !== "failed") return { ok: false, status: 409, error: `A ${msg.state} message can't be retried` };
  const last = msg.attempts[msg.attempts.length - 1];
  if (last && !last.retryable) return { ok: false, status: 409, error: `Retrying won't help: ${last.error}. Fix the cause and send it again as a new message.` };
  const partner = await store.tradingPartners.findOne({ _id: msg.partnerId, orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  if (!partner.enabled) return { ok: false, status: 409, error: `${partner.name} is switched off` };
  const queued = await moveState(store, msg, "queued");
  if (!queued) return { ok: false, status: 409, error: "Someone else just changed that message" };
  return { ok: true, message: await attempt(store, orgId, actor, partner, queued), created: false };
}

export type Received = { ok: true; message: B2BMessageDoc; duplicate: boolean } | Failure;

/** What the HTTP layer calls for an inbound request: the partner's bridge verifies it, we store it once. */
export async function receiveMessage(store: Store, orgId: ObjectId, partnerId: ObjectId, req: InboundRequest): Promise<Received> {
  const partner = await store.tradingPartners.findOne({ _id: partnerId, orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  if (!partner.enabled) return { ok: false, status: 409, error: `${partner.name} is switched off` };
  const bridge = getBridge(partner.bridge);
  if (!bridge) return { ok: false, status: 422, error: `There is no bridge called "${partner.bridge}"` };
  let verified: InboundResult;
  try {
    verified = await bridge.verifyInbound(req, partner);
  } catch (e) {
    verified = { ok: false, error: e instanceof Error ? e.message : "The bridge threw" };
  }
  if (!verified.ok) return { ok: false, status: 422, error: verified.error };
  if (!bridge.carries.includes(verified.docType)) return { ok: false, status: 422, error: `The ${bridge.id} bridge doesn't carry ${verified.docType} documents` };
  const dup = await store.b2bMessages.findOne({ orgId, partnerId, direction: "in", idempotencyKey: verified.idempotencyKey });
  if (dup) return { ok: true, message: dup, duplicate: true };
  const now = new Date();
  const msg: B2BMessageDoc = {
    _id: new ObjectId(), orgId, partnerId, direction: "in", docType: verified.docType, state: "received", idempotencyKey: verified.idempotencyKey,
    correlation: verified.correlation ?? {}, raw: { body: verified.body, contentType: verified.contentType ?? "application/json", hash: sha(verified.body), bytes: Buffer.byteLength(verified.body) },
    ...(verified.providerMessageId ? { providerMessageId: verified.providerMessageId } : {}),
    attempts: [], acks: [], createdBy: { id: new ObjectId(partner._id), name: partner.name }, createdAt: now, updatedAt: now,
  };
  try {
    await store.b2bMessages.insertOne(msg);
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return { ok: true, message: (await store.b2bMessages.findOne({ orgId, partnerId, direction: "in", idempotencyKey: verified.idempotencyKey }))!, duplicate: true };
  }
  await audit(store, orgId, { id: null, name: partner.name }, "b2b.message_received", msg, partner, `${partner.name}: ${msg.docType} received${partner.mode === "test" ? " (test partner)" : ""}`);
  return { ok: true, message: msg, duplicate: false };
}

/**
 * An answer to a message: the other side's acknowledgement of what we sent, or our own decision on what we received.
 * A business-level "accepted" or "rejected" moves the state to acknowledged or rejected; transport and functional
 * acknowledgements are recorded and only move a sent message on to "delivered".
 */
export async function recordAck(store: Store, orgId: ObjectId, messageId: ObjectId, ack: B2BAckInput, actor?: Actor): Promise<{ ok: true; message: B2BMessageDoc } | Failure> {
  const msg = await store.b2bMessages.findOne({ _id: messageId, orgId });
  if (!msg) return { ok: false, status: 404, error: "Message not found" };
  const partner = await store.tradingPartners.findOne({ _id: msg.partnerId, orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  const level = ack.level;
  const result = ack.result;
  const target: B2BState | null =
    level === "business" ? (result === "accepted" ? "acknowledged" : "rejected") : result === "rejected" ? "rejected" : msg.state === "sent" ? "delivered" : null;
  if (target && !B2B_TRANSITIONS[msg.state].includes(target)) return { ok: false, status: 409, error: `A ${msg.state} message can't become ${target}` };
  if (!target && (msg.state === "acknowledged" || msg.state === "rejected")) return { ok: false, status: 409, error: `That message is already ${msg.state}` };
  const entry = { level, result, detail: ack.detail ?? "", at: new Date() };
  const updated = await store.b2bMessages.findOneAndUpdate(
    { _id: msg._id, state: msg.state },
    { $push: { acks: entry }, $set: { updatedAt: new Date(), ...(target ? { state: target } : {}) } },
    { returnDocument: "after" },
  );
  if (!updated) return { ok: false, status: 409, error: "Someone else just changed that message" };
  await audit(store, orgId, actor ? actorRef(actor) : { id: null, name: partner.name }, "b2b.message_acknowledged", updated, partner, `${partner.name}: ${msg.docType} ${level} answer: ${result}${ack.detail ? ` (${ack.detail})` : ""}`);
  return { ok: true, message: updated };
}

export async function presentMessages(store: Store, orgId: ObjectId, docs: B2BMessageDoc[]): Promise<B2BMessage[]> {
  const partners = await store.tradingPartners.find({ orgId, _id: { $in: [...new Set(docs.map((d) => d.partnerId.toHexString()))].map((x) => new ObjectId(x)) } }, { projection: { name: 1 } }).toArray();
  const name = new Map(partners.map((p) => [p._id.toHexString(), p.name]));
  return docs.map((d) => ({
    id: d._id.toHexString(), partnerId: d.partnerId.toHexString(), partnerName: name.get(d.partnerId.toHexString()) ?? "Deleted partner", direction: d.direction, docType: d.docType,
    state: d.state, idempotencyKey: d.idempotencyKey, correlation: d.correlation, contentType: d.raw.contentType, rawBytes: d.raw.bytes, rawHash: d.raw.hash,
    providerMessageId: d.providerMessageId ?? null,
    attempts: d.attempts.map((a) => ({ at: a.at.toISOString(), ok: a.ok, error: a.error, retryable: a.retryable })),
    acks: d.acks.map((a) => ({ level: a.level, result: a.result, detail: a.detail, at: a.at.toISOString() })),
    createdBy: d.createdBy.name, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
  }));
}

export const withBody = (m: B2BMessage, d: B2BMessageDoc): B2BMessageDetail => ({ ...m, body: d.raw.body });
