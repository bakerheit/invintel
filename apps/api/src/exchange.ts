import { zValidator } from "@hono/zod-validator";
import {
  EXCHANGE_PROTOCOL, NO_PERMISSIONS, despatchBodySchema, envelopeSchema, exchangeIdentityUpdateSchema, exchangeInvitationSchema, objectIdSchema, orderBodySchema,
  orderResponseBodySchema, queryBodySchema, storedToNumber, uomOf,
  type B2BDocType, type ExchangeEnvelope, type ExchangeIdentity, type ExchangeInvitation, type ExchangePermissions, type ExchangeType, type QueryResponseBody,
} from "@invintel/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { type Bridge, type InboundHook, receiveMessage, recordAck, registerBridge, registerInboundHook, sendMessage } from "./b2b-core.js";
import { isDuplicateKey, type B2BMessageDoc, type ExchangeIdentityDoc, type OrgDoc, type Store, type TradingPartnerDoc } from "./db.js";
import { fingerprint, generateKeyPair, openKey, sealKey, signPayload, verifyPayload, withinWindow } from "./exchange-crypto.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { loadItems } from "./item-queries.js";
import { toOrders } from "./purchasing.js";
import { answerWithSales } from "./sales-exchange.js";

const BRIDGE_ID = "invintel";
const secret = () => process.env.EXCHANGE_KEY_SECRET || undefined;
const oid = (s: string) => new ObjectId(s);
const idParam = z.object({ id: objectIdSchema });

// ---------- identity ----------

/** Every organization gets a signing identity the first time it needs one. */
export async function ensureIdentity(store: Store, orgId: ObjectId, actor?: { id: ObjectId | null; name: string }): Promise<ExchangeIdentityDoc> {
  const have = await store.exchangeIdentities.findOne({ orgId });
  if (have) return have;
  const keys = generateKeyPair();
  const doc: ExchangeIdentityDoc = {
    _id: new ObjectId(), orgId, exchangeId: `ix_${randomBytes(8).toString("hex")}`, publicKey: keys.publicKey, privateKey: sealKey(keys.privateKey, secret()), baseUrl: "", createdAt: new Date(),
  };
  try {
    await store.exchangeIdentities.insertOne(doc);
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return (await store.exchangeIdentities.findOne({ orgId }))!;
  }
  const org = await store.orgs.findOne({ _id: orgId }, { projection: { name: 1 } });
  await recordAudit(store, { orgId, actor: actor ?? { id: null, name: "System" }, action: "exchange.identity_created", entity: { type: "organization", id: orgId.toHexString(), label: org?.name ?? "" }, summary: `Created this organization's exchange identity ${doc.exchangeId}`, snapshot: { exchangeId: doc.exchangeId, fingerprint: fingerprint(doc.publicKey) } });
  return doc;
}

const identityView = (d: ExchangeIdentityDoc, name: string): ExchangeIdentity => ({ exchangeId: d.exchangeId, name, publicKey: d.publicKey, fingerprint: fingerprint(d.publicKey), baseUrl: d.baseUrl });
const invitationOf = (d: ExchangeIdentityDoc, name: string): ExchangeInvitation => ({ protocol: EXCHANGE_PROTOCOL, ...identityView(d, name) });

// ---------- partner config (kept as strings in the partner's bridgeConfig) ----------

export const permsOf = (p: Pick<TradingPartnerDoc, "bridgeConfig">): ExchangePermissions => ({
  shareStock: p.bridgeConfig.shareStock === "1", shareStockQuantities: p.bridgeConfig.shareStockQuantities === "1", shareOrderStatus: p.bridgeConfig.shareOrderStatus === "1",
});
const permsToConfig = (x: ExchangePermissions) => ({ shareStock: x.shareStock ? "1" : "0", shareStockQuantities: x.shareStockQuantities ? "1" : "0", shareOrderStatus: x.shareOrderStatus ? "1" : "0" });

/** Which documents may come from which kind of partner: orders from customers; answers, ship notices and invoices from suppliers. */
const ALLOWED_FROM: Record<ExchangeType, "customer" | "supplier" | "any"> = {
  order: "customer", order_response: "supplier", despatch_advice: "supplier", invoice: "supplier", query: "any", query_response: "any", receipt: "any",
};

// ---------- sending ----------

async function post(url: string, body: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(8000) });
  return { ok: res.ok, status: res.status };
}

/** The signed envelope for one message. The envelope id is the message's idempotency key, so a retry is recognised as the same message. */
function buildEnvelope(identity: ExchangeIdentityDoc, partner: TradingPartnerDoc, m: { docType: B2BDocType; body: string; idempotencyKey: string; correlation: B2BMessageDoc["correlation"] }): ExchangeEnvelope {
  const unsigned = {
    protocol: EXCHANGE_PROTOCOL as typeof EXCHANGE_PROTOCOL, id: m.idempotencyKey, type: m.docType as ExchangeType, from: identity.exchangeId, to: partner.bridgeConfig.exchangeId!,
    createdAt: new Date().toISOString(), ...(m.correlation.partnerRef ? { reference: m.correlation.partnerRef } : {}), body: JSON.parse(m.body) as unknown,
  };
  return { ...unsigned, signature: signPayload(unsigned, openKey(identity.privateKey, secret())) };
}

/** Delivers an envelope to whoever owns `to`: in this process if they're on this server, otherwise over HTTPS. */
async function deliver(store: Store, partner: TradingPartnerDoc, raw: string): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
  const local = await store.exchangeIdentities.findOne({ exchangeId: partner.bridgeConfig.exchangeId });
  if (local) {
    const r = await acceptEnvelope(store, raw);
    return r.ok ? { ok: true } : { ok: false, error: "The other side did not accept it", retryable: false };
  }
  const base = partner.bridgeConfig.baseUrl;
  if (!base) return { ok: false, error: `${partner.name} has no address on file, and isn't on this server`, retryable: false };
  try {
    const r = await post(`${base.replace(/\/$/, "")}/api/exchange/inbox`, raw);
    if (r.ok) return { ok: true };
    return { ok: false, error: `${partner.name} answered ${r.status}`, retryable: r.status >= 500 || r.status === 429 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't reach the partner", retryable: true };
  }
}

export function createInvintelBridge(store: Store): Bridge {
  return {
    id: BRIDGE_ID,
    carries: ["order", "order_response", "despatch_advice", "invoice", "query", "query_response"],
    async send(m, partner) {
      if (!partner.bridgeConfig.exchangeId || !partner.bridgeConfig.publicKey) return { ok: false, error: "This partner has no exchange identity. Connect it with their invitation.", retryable: false };
      const identity = await store.exchangeIdentities.findOne({ orgId: partner.orgId });
      if (!identity) return { ok: false, error: "This organization has no exchange identity yet", retryable: false };
      let env: ExchangeEnvelope;
      try {
        env = buildEnvelope(identity, partner, m);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Couldn't build the message", retryable: false };
      }
      const res = await deliver(store, partner, JSON.stringify(env));
      return res.ok ? { ok: true, state: "delivered", providerMessageId: env.id } : res;
    },
    async verifyInbound(req, partner) {
      let json: unknown;
      try { json = JSON.parse(req.body); } catch { return { ok: false, error: "Not JSON" }; }
      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) return { ok: false, error: "Not an exchange message" };
      const env = parsed.data as ExchangeEnvelope;
      const mine = await store.exchangeIdentities.findOne({ orgId: partner.orgId });
      if (!mine || env.to !== mine.exchangeId) return { ok: false, error: "Not addressed to us" };
      if (env.from !== partner.bridgeConfig.exchangeId || !partner.bridgeConfig.publicKey) return { ok: false, error: "Unknown sender" };
      if (!withinWindow(env.createdAt)) return { ok: false, error: "Too old or too new" };
      const { signature, ...unsigned } = env;
      if (!verifyPayload(unsigned, signature, partner.bridgeConfig.publicKey)) return { ok: false, error: "Bad signature" };
      const allowed = ALLOWED_FROM[env.type];
      if (allowed !== "any" && allowed !== partner.kind) return { ok: false, error: `A ${partner.kind} can't send a ${env.type}` };
      const body = env.body as { poNumber?: string } | null;
      return { ok: true, docType: env.type as B2BDocType, body: req.body, idempotencyKey: env.id, providerMessageId: env.id, correlation: { ...(env.reference ? { partnerRef: env.reference } : {}), ...(body && typeof body.poNumber === "string" ? { poNumber: body.poNumber } : {}) } };
    },
  };
}

/** What both the HTTP inbox and in-process delivery call. Every refusal looks the same from outside. */
export async function acceptEnvelope(store: Store, raw: string): Promise<{ ok: boolean }> {
  let to = "", from = "";
  try {
    const j = JSON.parse(raw) as { to?: string; from?: string };
    to = String(j.to ?? ""); from = String(j.from ?? "");
  } catch { return { ok: false }; }
  const mine = await store.exchangeIdentities.findOne({ exchangeId: to });
  if (!mine) return { ok: false };
  const partner = await store.tradingPartners.findOne({ orgId: mine.orgId, bridge: BRIDGE_ID, "bridgeConfig.exchangeId": from });
  if (!partner) return { ok: false };
  const res = await receiveMessage(store, mine.orgId, partner._id, { headers: {}, body: raw });
  return { ok: res.ok };
}

export function createExchangeInboxRoutes(store: Store) {
  const r = new Hono();
  const hits = new Map<string, { n: number; reset: number }>();
  r.post("/inbox", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "Too big" }, 413) }), async (c) => {
    const ip = c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for") ?? "local";
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + 60_000 });
    else if (++h.n > 300) return c.json({ error: "Slow down" }, 429);
    const res = await acceptEnvelope(store, await c.req.text());
    return res.ok ? c.json({ received: true }) : c.json({ error: "Not accepted" }, 422);
  });
  return r;
}

// ---------- handling what arrives ----------

/** The document inside a stored message: what we sent is kept as the bare document, what we received as the signed envelope around it. */
const docOf = (m: Pick<B2BMessageDoc, "direction" | "raw">): unknown => {
  const j = JSON.parse(m.raw.body) as unknown;
  return m.direction === "in" ? (j as { body?: unknown }).body : j;
};

const answerStock = async (store: Store, orgId: ObjectId, partner: TradingPartnerDoc, sku: string): Promise<QueryResponseBody> => {
  const perms = permsOf(partner);
  if (!perms.shareStock) return { kind: "stock", ok: false, reason: "We don't share stock levels with you yet." };
  const items = await loadItems(store, orgId);
  const item = items.find((i) => i.sku.toLowerCase() === sku.toLowerCase());
  if (!item) return { kind: "stock", ok: false, reason: "We don't carry that item." };
  // What a partner is told is what can still be promised: not what sits on quality hold, not what is reserved for orders (INV-15).
  const qty = Math.max(0, item.stock.reduce((s, x) => s + x.quantity, 0) - (item.onHold ?? 0) - (item.reserved ?? 0));
  const uom = uomOf(item);
  const availability = qty <= 0 ? "out" : item.reorderLevel > 0 && qty <= item.reorderLevel ? "low" : "in_stock";
  return { kind: "stock", ok: true, stock: { sku: item.sku, description: item.name, availability, ...(perms.shareStockQuantities ? { quantity: storedToNumber(qty, uom.decimals), unit: uom.unit } : {}) } };
};

const answerOrderStatus = async (store: Store, orgId: ObjectId, partner: TradingPartnerDoc, poNumber: string): Promise<QueryResponseBody> => {
  if (!permsOf(partner).shareOrderStatus) return { kind: "order_status", ok: false, reason: "We don't share order status with you yet." };
  const msgs = await store.b2bMessages.find({ orgId, partnerId: partner._id, "correlation.poNumber": poNumber }).sort({ createdAt: 1 }).toArray();
  const got = msgs.find((m) => m.direction === "in" && m.docType === "order");
  if (!got) return { kind: "order_status", ok: false, reason: "We have no order with that number from you." };
  let status = "received";
  let promisedDate: string | null = null;
  for (const m of msgs.filter((x) => x.direction === "out" && x.docType === "order_response")) {
    const d = docOf(m) as { status?: string; promisedDate?: string | null };
    if (d.status) { status = d.status; promisedDate = d.promisedDate ?? null; }
  }
  const shipped = msgs.some((m) => m.direction === "out" && m.docType === "despatch_advice");
  return { kind: "order_status", ok: true, order: { poNumber, status: shipped ? "shipped" : status, promisedDate, shipped } };
};

/** What we do with a verified message from an Invintel partner. */
const onInbound: InboundHook = async (store, orgId, partner, msg) => {
  const env = JSON.parse(msg.raw.body) as ExchangeEnvelope;
  const system = { userId: partner._id, userName: partner.name };
  if (msg.docType === "query") {
    const q = queryBodySchema.safeParse(env.body);
    const answer: QueryResponseBody = !q.success ? { kind: "stock", ok: false, reason: "We couldn't read that question." } : q.data.kind === "stock" ? await answerStock(store, orgId, partner, q.data.sku) : await answerOrderStatus(store, orgId, partner, q.data.poNumber);
    // The answer goes back as its own message, so the asker finds it in their log like anything else we send.
    await sendMessage(store, orgId, system, partner._id, { docType: "query_response", body: JSON.stringify(answer), contentType: "application/json", correlation: { partnerRef: env.id }, idempotencyKey: `answer-${env.id}` });
    await recordAck(store, orgId, msg._id, { level: "business", result: answer.ok ? "accepted" : "rejected", detail: answer.ok ? "Answered" : answer.reason ?? "Not answered" });
    return;
  }
  if (msg.docType === "order") {
    const ok = orderBodySchema.safeParse(env.body).success;
    if (!ok) await recordAck(store, orgId, msg._id, { level: "functional", result: "rejected", detail: "The order could not be read" });
    return;
  }
  if (msg.docType === "order_response") {
    const body = orderResponseBodySchema.safeParse(env.body);
    if (!body.success) return;
    // Find the order we sent, and tell the log what the supplier said.
    const sent = await store.b2bMessages.findOne({ orgId, partnerId: partner._id, direction: "out", docType: "order", "correlation.poNumber": body.data.poNumber }, { sort: { createdAt: -1 } });
    if (sent && ["sent", "delivered"].includes(sent.state)) {
      await recordAck(store, orgId, sent._id, { level: "business", result: body.data.status === "rejected" ? "rejected" : "accepted", detail: `${body.data.status}${body.data.promisedDate ? `, promised ${body.data.promisedDate}` : ""}${body.data.note ? `: ${body.data.note}` : ""}` });
    }
  }
};

export function registerInvintelExchange(store: Store) {
  registerBridge(createInvintelBridge(store));
  registerInboundHook(BRIDGE_ID, onInbound);
}

// ---------- routes (signed in) ----------

const connectSchema = z.object({ invitation: exchangeInvitationSchema, kind: z.enum(["supplier", "customer"]) });
const permissionsSchema = z.object({ shareStock: z.boolean(), shareStockQuantities: z.boolean(), shareOrderStatus: z.boolean() });
const askSchema = z.object({ partnerId: objectIdSchema, question: queryBodySchema });
const respondSchema = z.object({ status: z.enum(["accepted", "rejected", "changed"]), promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), note: z.string().trim().max(1000).default(""), /** Accept even if there isn't enough stock available to promise (a back-order). */ backorder: z.boolean().default(false) });
const shipSchema = z.object({ shippedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), carrier: z.string().trim().max(80).default(""), tracking: z.string().trim().max(120).default("") });
const sendPoSchema = z.object({ partnerId: objectIdSchema });


// ---------- answering and shipping an incoming order (also used by Sales) ----------

export type IncomingOrder = { m: B2BMessageDoc; order: z.infer<typeof orderBodySchema> };

export async function loadIncomingOrder(store: Store, orgId: ObjectId, id: string): Promise<IncomingOrder | null> {
  const m = await store.b2bMessages.findOne({ _id: oid(id), orgId, direction: "in", docType: "order" });
  if (!m) return null;
  const order = orderBodySchema.safeParse(docOf(m));
  return order.success ? { m, order: order.data } : null;
}

type Asker = { userId: ObjectId; userName: string };

/** Sends our answer to a customer's order. The same answer twice is the same message. */
export async function sendOrderResponse(store: Store, orgId: ObjectId, actor: Asker, got: IncomingOrder, input: { status: "accepted" | "rejected" | "changed"; promisedDate: string | null; note: string }) {
  const body = orderResponseBodySchema.parse({ poNumber: got.order.poNumber, status: input.status, promisedDate: input.promisedDate, note: input.note, lines: got.order.lines.map((l) => ({ sku: l.sku, quantity: input.status === "rejected" ? 0 : l.quantity, status: input.status })) });
  const res = await sendMessage(store, orgId, actor, got.m.partnerId, { docType: "order_response", body: JSON.stringify(body), contentType: "application/json", correlation: { poNumber: got.order.poNumber, partnerRef: got.order.poNumber }, idempotencyKey: `resp-${got.m._id.toHexString()}-${input.status}-${input.promisedDate ?? ""}` });
  if (!res.ok) return res;
  if (res.created) await recordAck(store, orgId, got.m._id, { level: "business", result: input.status === "rejected" ? "rejected" : "accepted", detail: `We answered: ${input.status}` }).catch(() => undefined);
  await recordAudit(store, { orgId, actor: { id: actor.userId, name: actor.userName }, action: "exchange.order_answered", entity: { type: "b2b_message", id: got.m._id.toHexString(), label: got.order.poNumber }, summary: `Answered ${got.order.poNumber}: ${input.status}${input.promisedDate ? `, promised ${input.promisedDate}` : ""}` });
  return res;
}

/**
 * Sends the ship notice for an incoming order. By default it covers the whole order once; Sales passes what a shipment really
 * contained, its shipment number, and a key of its own so a part shipment and the rest are separate notices.
 */
export async function sendShipNotice(
  store: Store, orgId: ObjectId, actor: Asker, got: IncomingOrder,
  input: { shippedDate?: string; carrier?: string; tracking?: string; shipmentNumber?: string; lines?: { sku: string; quantity: number }[]; key?: string },
) {
  const body = despatchBodySchema.parse({
    poNumber: got.order.poNumber, shipmentNumber: input.shipmentNumber ?? `SH-${got.order.poNumber}`, shippedDate: input.shippedDate ?? new Date().toISOString().slice(0, 10),
    carrier: input.carrier ?? "", tracking: input.tracking ?? "", lines: input.lines ?? got.order.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
  });
  const res = await sendMessage(store, orgId, actor, got.m.partnerId, { docType: "despatch_advice", body: JSON.stringify(body), contentType: "application/json", correlation: { poNumber: got.order.poNumber, partnerRef: got.order.poNumber }, idempotencyKey: input.key ?? `ship-${got.m._id.toHexString()}` });
  if (!res.ok) return res;
  if (res.created) await recordAudit(store, { orgId, actor: { id: actor.userId, name: actor.userName }, action: "exchange.order_shipped", entity: { type: "b2b_message", id: got.m._id.toHexString(), label: got.order.poNumber }, summary: `Sent ship notice for ${got.order.poNumber}${input.tracking ? ` (tracking ${input.tracking})` : ""}` });
  return res;
}

const salesOn = (org: Pick<OrgDoc, "modules">) => org.modules?.sales !== false;

export function createExchangeRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  const asActor = (u: { id: string; name: string }) => ({ userId: oid(u.id), userName: u.name });
  const partnerView = (p: TradingPartnerDoc) => ({
    id: p._id.toHexString(), name: p.name, kind: p.kind, enabled: p.enabled, mode: p.mode, exchangeId: p.bridgeConfig.exchangeId ?? "", fingerprint: p.bridgeConfig.publicKey ? fingerprint(p.bridgeConfig.publicKey) : "",
    baseUrl: p.bridgeConfig.baseUrl ?? "", permissions: permsOf(p),
  });

  r.get("/identity", async (c) => c.json(identityView(await ensureIdentity(store, c.get("org")._id, auditActor(c.get("user"))), c.get("org").name)));

  r.put("/identity", requireRole("admin"), zValidator("json", exchangeIdentityUpdateSchema), async (c) => {
    const id = await ensureIdentity(store, c.get("org")._id, auditActor(c.get("user")));
    await store.exchangeIdentities.updateOne({ _id: id._id }, { $set: { baseUrl: c.req.valid("json").baseUrl.replace(/\/$/, "") } });
    return c.json(identityView((await store.exchangeIdentities.findOne({ _id: id._id }))!, c.get("org").name));
  });

  r.get("/invitation", async (c) => c.json(invitationOf(await ensureIdentity(store, c.get("org")._id, auditActor(c.get("user"))), c.get("org").name)));

  r.get("/partners", async (c) => c.json((await store.tradingPartners.find({ orgId: c.get("org")._id, bridge: BRIDGE_ID }).sort({ name: 1 }).toArray()).map(partnerView)));

  /** Add a partner from their invitation. If they are on this server, their side is connected back automatically. */
  r.post("/connect", requireRole("admin"), zValidator("json", connectSchema), async (c) => {
    const org = c.get("org");
    const { invitation, kind } = c.req.valid("json");
    const mine = await ensureIdentity(store, org._id, auditActor(c.get("user")));
    if (invitation.exchangeId === mine.exchangeId) return c.json({ error: "That's your own invitation" }, 400);
    if (fingerprint(invitation.publicKey) !== invitation.fingerprint) return c.json({ error: "That invitation's fingerprint doesn't match its key, so it has been altered" }, 400);
    const link = async (orgId: ObjectId, name: string, who: { exchangeId: string; publicKey: string; baseUrl: string }, as: "supplier" | "customer") => {
      const existing = await store.tradingPartners.findOne({ orgId, bridge: BRIDGE_ID, "bridgeConfig.exchangeId": who.exchangeId });
      const config = { exchangeId: who.exchangeId, publicKey: who.publicKey, baseUrl: who.baseUrl, ...permsToConfig(NO_PERMISSIONS) };
      if (existing) {
        await store.tradingPartners.updateOne({ _id: existing._id }, { $set: { "bridgeConfig.publicKey": who.publicKey, "bridgeConfig.baseUrl": who.baseUrl } });
        return (await store.tradingPartners.findOne({ _id: existing._id }))!;
      }
      const doc: TradingPartnerDoc = { _id: new ObjectId(), orgId, name, kind: as, supplierId: null, identifiers: [{ scheme: "invintel", value: who.exchangeId }], bridge: BRIDGE_ID, bridgeConfig: config, mode: "test", enabled: true, contactEmail: "", note: "", createdAt: new Date() };
      let n = 0;
      for (;;) {
        try {
          await store.tradingPartners.insertOne({ ...doc, name: n ? `${name} (${n + 1})` : name });
          return (await store.tradingPartners.findOne({ _id: doc._id }))!;
        } catch (e) {
          if (!isDuplicateKey(e) || ++n > 5) throw e;
        }
      }
    };
    const partner = await link(org._id, invitation.name, invitation, kind);
    // The other organization is on this server: connect them back so both sides can trade straight away.
    const there = await store.exchangeIdentities.findOne({ exchangeId: invitation.exchangeId });
    let connectedBack = false;
    if (there) {
      await link(there.orgId, org.name, { exchangeId: mine.exchangeId, publicKey: mine.publicKey, baseUrl: mine.baseUrl }, kind === "supplier" ? "customer" : "supplier");
      connectedBack = true;
    }
    await recordAudit(store, { orgId: org._id, actor: auditActor(c.get("user")), action: "exchange.connected", entity: { type: "trading_partner", id: partner._id.toHexString(), label: partner.name }, summary: `Connected ${partner.name} as a ${kind} (key ${fingerprint(invitation.publicKey)})${connectedBack ? ", and connected them back" : ""}`, snapshot: { exchangeId: invitation.exchangeId, fingerprint: invitation.fingerprint } });
    return c.json({ partner: partnerView(partner), connectedBack, ourInvitation: invitationOf(mine, org.name) }, 201);
  });

  r.patch("/partners/:id/permissions", requireRole("admin"), zValidator("param", idParam), zValidator("json", permissionsSchema), async (c) => {
    const p = c.req.valid("json");
    const perms: ExchangePermissions = { ...p, shareStockQuantities: p.shareStock && p.shareStockQuantities };
    const doc = await store.tradingPartners.findOneAndUpdate({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id, bridge: BRIDGE_ID }, { $set: Object.fromEntries(Object.entries(permsToConfig(perms)).map(([k, v]) => [`bridgeConfig.${k}`, v])) }, { returnDocument: "after" });
    if (!doc) return c.json({ error: "Partner not found" }, 404);
    await recordAudit(store, { orgId: c.get("org")._id, actor: auditActor(c.get("user")), action: "exchange.permissions_changed", entity: { type: "trading_partner", id: doc._id.toHexString(), label: doc.name }, summary: `${doc.name} may ask about: ${[perms.shareStock && "stock", perms.shareStockQuantities && "exact quantities", perms.shareOrderStatus && "order status"].filter(Boolean).join(", ") || "nothing"}` });
    return c.json(partnerView(doc));
  });

  /** Send one of our purchase orders to a supplier partner. */
  r.post("/purchase-orders/:id/send", requireRole("admin"), zValidator("param", idParam), zValidator("json", sendPoSchema), async (c) => {
    const orgId = c.get("org")._id;
    const po = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!po) return c.json({ error: "Order not found" }, 404);
    if (po.state !== "ordered") return c.json({ error: po.state === "draft" ? "Place the order before sending it" : `A ${po.state} order can't be sent` }, 409);
    const partner = await store.tradingPartners.findOne({ _id: oid(c.req.valid("json").partnerId), orgId, bridge: BRIDGE_ID });
    if (!partner) return c.json({ error: "Partner not found" }, 404);
    if (partner.kind !== "supplier") return c.json({ error: `${partner.name} is a customer, not a supplier` }, 409);
    const [order] = await toOrders(store, [po]);
    const items = await store.items.find({ _id: { $in: po.lines.map((l) => l.itemId) } }).toArray();
    const byId = new Map(items.map((i) => [i._id.toHexString(), i]));
    const body = orderBodySchema.parse({
      poNumber: po.number, currency: "USD", requestedDate: po.expectedDate, note: po.note,
      lines: po.lines.map((l) => { const i = byId.get(l.itemId.toHexString()); const u = uomOf(i); return { sku: i?.sku ?? "", description: i?.name ?? "", quantity: storedToNumber(l.quantity, u.decimals), unit: u.unit, unitPriceCents: l.unitCostCents }; }),
    });
    const res = await sendMessage(store, orgId, asActor(c.get("user")), partner._id, { docType: "order", body: JSON.stringify(body), contentType: "application/json", correlation: { poId: po._id.toHexString(), poNumber: po.number, partnerRef: po.number }, idempotencyKey: `po-${po._id.toHexString()}` });
    if (!res.ok) return c.json({ error: res.error }, res.status);
    void order;
    return c.json({ messageId: res.message._id.toHexString(), state: res.message.state, alreadySent: !res.created }, res.created ? 201 : 200);
  });

  /** Orders our customers have sent us, with what we've answered. */
  r.get("/orders", async (c) => {
    const orgId = c.get("org")._id;
    const incoming = await store.b2bMessages.find({ orgId, direction: "in", docType: "order" }).sort({ createdAt: -1 }).limit(100).toArray();
    const partners = new Map((await store.tradingPartners.find({ orgId }).toArray()).map((p) => [p._id.toHexString(), p]));
    const out = await store.b2bMessages.find({ orgId, direction: "out", docType: { $in: ["order_response", "despatch_advice"] } }).toArray();
    const sales = new Map((await store.salesOrders.find({ orgId, messageId: { $in: incoming.map((m) => m._id) } }, { projection: { number: 1, state: 1, messageId: 1 } }).toArray()).map((s) => [s.messageId!.toHexString(), s]));
    return c.json(incoming.map((m) => {
      const body = orderBodySchema.safeParse(docOf(m));
      const answers = out.filter((o) => o.partnerId.equals(m.partnerId) && o.correlation.poNumber === m.correlation.poNumber);
      const resp = answers.filter((o) => o.docType === "order_response").map((o) => docOf(o) as { status: string; promisedDate: string | null }).pop();
      return { messageId: m._id.toHexString(), partner: partners.get(m.partnerId.toHexString())?.name ?? "Deleted partner", receivedAt: m.createdAt.toISOString(), order: body.success ? body.data : null, response: resp ?? null, shipped: answers.some((o) => o.docType === "despatch_advice"), salesOrder: sales.get(m._id.toHexString()) ? { id: sales.get(m._id.toHexString())!._id.toHexString(), number: sales.get(m._id.toHexString())!.number, state: sales.get(m._id.toHexString())!.state } : null };
    }));
  });

  const loadIncoming = (orgId: ObjectId, id: string) => loadIncomingOrder(store, orgId, id);

  r.post("/orders/:id/respond", requireRole("admin"), zValidator("param", idParam), zValidator("json", respondSchema), async (c) => {
    const org = c.get("org");
    const orgId = org._id;
    const got = await loadIncoming(orgId, c.req.valid("param").id);
    if (!got) return c.json({ error: "Order not found" }, 404);
    const input = c.req.valid("json");
    let salesOrder: { id: string; number: string } | null = null;
    if (salesOn(org)) {
      // Accepting a customer's order means promising stock: it becomes a sales order that reserves it (INV-15).
      const sales = await answerWithSales(store, org, { ...c.get("user"), role: c.get("role") }, got, input);
      if (sales.kind === "approval") return c.json({ approvalRequired: true, approval: sales.approval, salesOrder: sales.salesOrder }, 202);
      if (sales.kind === "refused") return c.json({ error: sales.error, ...(sales.shortages ? { shortages: sales.shortages } : {}), ...(sales.salesOrder ? { salesOrder: sales.salesOrder } : {}) }, sales.status);
      salesOrder = sales.salesOrder;
    }
    const res = await sendOrderResponse(store, orgId, asActor(c.get("user")), got, input);
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json({ messageId: res.message._id.toHexString(), state: res.message.state, ...(salesOrder ? { salesOrder } : {}) }, 201);
  });

  r.post("/orders/:id/ship", zValidator("param", idParam), zValidator("json", shipSchema), async (c) => {
    const org = c.get("org");
    const orgId = org._id;
    const got = await loadIncoming(orgId, c.req.valid("param").id);
    if (!got) return c.json({ error: "Order not found" }, 404);
    // An order we are tracking as a sales order ships from Sales: that takes the stock out and sends this notice, so it can't be sent on its own.
    const so = await store.salesOrders.findOne({ orgId, messageId: got.m._id }, { projection: { number: 1, state: 1 } });
    if (so && so.state !== "cancelled") return c.json({ error: `Ship ${so.number} from Sales: that takes the stock out through the ledger and sends the ship notice.`, salesOrder: so.number }, 409);
    const input = c.req.valid("json");
    const res = await sendShipNotice(store, orgId, asActor(c.get("user")), got, { shippedDate: input.shippedDate, carrier: input.carrier, tracking: input.tracking });
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json({ messageId: res.message._id.toHexString(), state: res.message.state, alreadySent: !res.created }, res.created ? 201 : 200);
  });

  /** Ask a partner a question. The answer arrives as a message and shows up in /answers. */
  r.post("/ask", zValidator("json", askSchema), async (c) => {
    const orgId = c.get("org")._id;
    const { partnerId, question } = c.req.valid("json");
    const partner = await store.tradingPartners.findOne({ _id: oid(partnerId), orgId, bridge: BRIDGE_ID });
    if (!partner) return c.json({ error: "Partner not found" }, 404);
    const res = await sendMessage(store, orgId, asActor(c.get("user")), partner._id, { docType: "query", body: JSON.stringify(question), contentType: "application/json", correlation: { ...(question.kind === "order_status" ? { poNumber: question.poNumber } : {}) }, idempotencyKey: `q-${randomUUID()}` });
    if (!res.ok) return c.json({ error: res.error }, res.status);
    return c.json({ messageId: res.message._id.toHexString(), state: res.message.state }, 201);
  });

  r.get("/answers", async (c) => {
    const orgId = c.get("org")._id;
    const asked = await store.b2bMessages.find({ orgId, direction: "out", docType: "query" }).sort({ createdAt: -1 }).limit(30).toArray();
    const partners = new Map((await store.tradingPartners.find({ orgId }).toArray()).map((p) => [p._id.toHexString(), p.name]));
    const replies = await store.b2bMessages.find({ orgId, direction: "in", docType: "query_response", "correlation.partnerRef": { $in: asked.map((q) => q.idempotencyKey) } }).toArray();
    const byRef = new Map(replies.map((m) => [m.correlation.partnerRef!, m]));
    return c.json(asked.map((q) => {
      const a = byRef.get(q.idempotencyKey);
      return { messageId: q._id.toHexString(), partner: partners.get(q.partnerId.toHexString()) ?? "Deleted partner", askedAt: q.createdAt.toISOString(), question: docOf(q), state: q.state, answer: a ? (docOf(a) as QueryResponseBody) : null };
    }));
  });

  /** Everything exchanged about one of our purchase orders, oldest first. */
  r.get("/purchase-orders/:id/timeline", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const po = await store.purchaseOrders.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!po) return c.json({ error: "Order not found" }, 404);
    const msgs = await store.b2bMessages.find({ orgId, "correlation.poNumber": po.number }).sort({ createdAt: 1 }).toArray();
    const partners = new Map((await store.tradingPartners.find({ orgId }).toArray()).map((p) => [p._id.toHexString(), p.name]));
    return c.json(msgs.map((m) => {
      return { messageId: m._id.toHexString(), at: m.createdAt.toISOString(), direction: m.direction, docType: m.docType, state: m.state, partner: partners.get(m.partnerId.toHexString()) ?? "", summary: (docOf(m) as Record<string, unknown>) ?? null, acks: m.acks.map((a) => ({ level: a.level, result: a.result, detail: a.detail })) };
    }));
  });

  void createHash;
  return r;
}
