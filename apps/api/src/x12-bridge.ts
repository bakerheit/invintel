import type { B2BDocType, CanonicalOrder } from "@invintel/shared";
import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { getBridge, recordAck, registerBridge, registerInboundHook, sendMessage, type Bridge, type Failure, type InboundResult, type Sent, systemActor } from "./b2b-core.js";
import { nextSeq } from "./counters.js";
import type { B2BMessageDoc, Store, TradingPartnerDoc } from "./db.js";
import type { Actor } from "./stock-service.js";
import { X12_CONTENT_TYPE, profileProblems, type X12Profile, type X12Version } from "./x12.js";
import { ackTo997, acknowledge, orderTo850, readX12, SET_TO_DOC_TYPE, type X12Doc } from "./x12-maps.js";

// INV-14: the X12 bridge. It turns our canonical documents into X12 and back, checks that what arrives really is from the
// partner it claims (ISA ids) and in the right mode (a test partner only ever carries the test indicator), allocates control
// numbers, and returns a 997 for everything it receives.
//
// There is no network transport yet. A partner's `transport` setting says how documents travel; "loopback" is a built-in test
// partner (x12-loopback.ts). Anything else is refused at send time with a clear message, so a real AS2, SFTP or provider
// transport is one adapter away and nothing else changes.
//
// Partner settings (bridgeConfig): ourQual, ourId (how we are known to them), theirQual, theirId, version (004010 or 005010),
// transport ("loopback"), secretEnv (name of the environment variable holding the secret for the inbound route), uomMap (JSON,
// extra unit codes: {"sheet":"SH"}), ack997 ("off" to stop returning receipts).

export const X12_BRIDGE = "x12";
const MAX_CONTROL = 999_999_999;

export interface X12Setup {
  ours: { qual: string; id: string };
  theirs: { qual: string; id: string };
  version: X12Version;
  usage: "T" | "P";
  uomMap: Record<string, string>;
  transport: string;
  ack997: boolean;
}

export function setupOf(partner: Pick<TradingPartnerDoc, "bridgeConfig" | "mode">): { ok: true; setup: X12Setup } | { ok: false; error: string } {
  const c = partner.bridgeConfig;
  let uomMap: Record<string, string> = {};
  if (c.uomMap) {
    try {
      const j = JSON.parse(c.uomMap) as unknown;
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error();
      for (const [k, v] of Object.entries(j)) {
        if (typeof v !== "string" || !/^[A-Z0-9]{2,3}$/.test(v)) return { ok: false, error: `The unit map code for "${k}" must be 2 or 3 capital letters or digits` };
        uomMap[k.trim().toLowerCase()] = v;
      }
    } catch {
      return { ok: false, error: 'The unit map must be JSON like {"sheet":"SH"}' };
    }
  }
  const setup: X12Setup = {
    ours: { qual: (c.ourQual ?? "").toUpperCase(), id: c.ourId ?? "" }, theirs: { qual: (c.theirQual ?? "").toUpperCase(), id: c.theirId ?? "" },
    version: (c.version ?? "004010") as X12Version, usage: partner.mode === "test" ? "T" : "P", uomMap, transport: c.transport ?? "", ack997: c.ack997 !== "off",
  };
  const bad = profileProblems(profileOut(setup));
  if (bad.length) return { ok: false, error: `This partner's X12 settings are incomplete: ${bad[0]}` };
  return { ok: true, setup };
}

export const profileOut = (s: X12Setup): X12Profile => ({ senderQual: s.ours.qual, senderId: s.ours.id, receiverQual: s.theirs.qual, receiverId: s.theirs.id, version: s.version, usage: s.usage });
export const profileIn = (s: X12Setup): X12Profile => ({ senderQual: s.theirs.qual, senderId: s.theirs.id, receiverQual: s.ours.qual, receiverId: s.ours.id, version: s.version, usage: s.usage });

/** Interchange control numbers: atomic per organization and partner, 1 to 999999999, wrapping, never reused within a cycle. */
export async function nextControl(store: Store, orgId: ObjectId, partnerId: ObjectId, kind = "x12"): Promise<number> {
  return ((await nextSeq(store, orgId, `${kind}:${partnerId.toHexString()}`)) - 1) % MAX_CONTROL + 1;
}

/** Settings problems to show when a partner is saved (null when fine). */
export function validateX12Config(config: Record<string, string>, mode: "test" | "live"): string | null {
  const r = setupOf({ bridgeConfig: config, mode });
  if (!r.ok) return r.error;
  if (r.setup.transport !== "" && r.setup.transport !== "loopback") return `Transport "${r.setup.transport}" isn't available yet (only "loopback")`;
  if (r.setup.transport === "loopback" && mode === "live") return "The loopback test partner can't be a live partner";
  return null;
}

const same = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return x.equals(y);
};

/**
 * Everything a received X12 document has to pass before it is stored: it parses, it is from this partner's ids to ours, and its
 * test/production indicator matches the partner's mode. Used by the bridge (real inbound) and by the loopback test partner.
 */
export function acceptInbound(text: string, partner: TradingPartnerDoc): InboundResult {
  const s = setupOf(partner);
  if (!s.ok) return { ok: false, error: s.error };
  const r = readX12(text, { uomMap: s.setup.uomMap });
  if (!r.ok) return { ok: false, error: r.errors.slice(0, 5).join("; ").slice(0, 500) };
  const ic = r.interchange;
  if (ic.senderQual.toUpperCase() !== s.setup.theirs.qual || ic.senderId !== s.setup.theirs.id) return { ok: false, error: `Sent by ${ic.senderQual}/${ic.senderId}, not by this partner` };
  if (ic.receiverQual.toUpperCase() !== s.setup.ours.qual || ic.receiverId !== s.setup.ours.id) return { ok: false, error: `Addressed to ${ic.receiverQual}/${ic.receiverId}, not to us` };
  if (ic.usage !== s.setup.usage) return { ok: false, error: ic.usage === "T" ? "A test document sent to a live partner" : "A production document sent to a test partner" };
  const docType = SET_TO_DOC_TYPE[ic.set.id as keyof typeof SET_TO_DOC_TYPE] as B2BDocType;
  const d = r.doc;
  const poNumber = d.kind === "functional_ack" ? undefined : d.kind === "invoice" ? d.doc.poNumber || undefined : d.doc.poNumber;
  const partnerRef = d.kind === "despatch_advice" ? d.doc.shipmentNo : d.kind === "invoice" ? d.doc.invoiceNumber : undefined;
  return {
    ok: true, docType, body: text, contentType: X12_CONTENT_TYPE, idempotencyKey: `x12:${ic.set.id}:${ic.control}`,
    correlation: { ...(poNumber ? { poNumber } : {}), ...(partnerRef ? { partnerRef } : {}) },
  };
}

export const x12Bridge: Bridge = {
  id: X12_BRIDGE,
  validateConfig: validateX12Config,
  carries: ["order", "order_response", "despatch_advice", "invoice", "functional_ack"],
  async send(m, partner) {
    const s = setupOf(partner);
    if (!s.ok) return { ok: false, error: s.error, retryable: false };
    const r = readX12(m.body, { uomMap: s.setup.uomMap });
    if (!r.ok) return { ok: false, error: `The document isn't valid X12: ${r.errors[0]}`, retryable: false };
    const ic = r.interchange;
    if (ic.senderId !== s.setup.ours.id || ic.receiverId !== s.setup.theirs.id) return { ok: false, error: "The document is addressed to someone other than this partner", retryable: false };
    if (ic.usage !== s.setup.usage) return { ok: false, error: `The document is marked ${ic.usage === "T" ? "test" : "production"} but the partner is ${partner.mode}`, retryable: false };
    if ((SET_TO_DOC_TYPE[ic.set.id as keyof typeof SET_TO_DOC_TYPE] as string) !== m.docType) return { ok: false, error: `A ${ic.set.id} isn't a ${m.docType}`, retryable: false };
    if (s.setup.transport === "loopback") return { ok: true, state: "delivered", providerMessageId: `x12-loop-${ic.control}` };
    return { ok: false, error: "No transport is set up for this partner yet (AS2, SFTP or a provider would go here)", retryable: false };
  },
  async verifyInbound(req, partner) {
    const envName = partner.bridgeConfig.secretEnv;
    const secret = envName ? process.env[envName] : undefined;
    if (!secret) return { ok: false, error: "This partner has no secret set up" };
    const given = req.headers["x-invintel-secret"] ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!same(given ?? "", secret)) return { ok: false, error: "Bad secret" };
    return acceptInbound(req.body, partner);
  },
};
registerBridge(x12Bridge);

// ---------- sending an order as X12 ----------

/** Builds the 850 for a purchase order and sends it. Called by sendPurchaseOrder when the supplier's partner uses this bridge. */
export async function sendX12Order(store: Store, orgId: ObjectId, actor: Actor, partner: TradingPartnerDoc, order: CanonicalOrder, poId: ObjectId): Promise<Sent | Failure> {
  const s = setupOf(partner);
  if (!s.ok) return { ok: false, status: 409, error: s.error };
  const key = `po:${order.poNumber}:rev:${order.revision}`;
  const existing = await store.b2bMessages.findOne({ orgId, partnerId: partner._id, direction: "out", idempotencyKey: key });
  if (existing) return { ok: true, message: existing, created: false };
  const control = await nextControl(store, orgId, partner._id);
  const w = orderTo850(order, { profile: profileOut(s.setup), control, now: new Date(), uomMap: s.setup.uomMap });
  if (!w.ok) return { ok: false, status: 422, error: `This order can't be sent as X12: ${w.errors.join("; ")}` };
  return sendMessage(store, orgId, actor, partner._id, {
    docType: "order", body: w.text, contentType: X12_CONTENT_TYPE, idempotencyKey: key,
    correlation: { poId: poId.toHexString(), poNumber: order.poNumber, controlNumber: String(control) },
  });
}

// ---------- what happens when a document arrives ----------

async function attachOrder(store: Store, orgId: ObjectId, partner: TradingPartnerDoc, message: B2BMessageDoc, poNumber: string) {
  const po = await store.purchaseOrders.findOne({ orgId, number: poNumber });
  if (!po || (partner.supplierId && !po.supplierId.equals(partner.supplierId))) return null;
  await store.b2bMessages.updateOne({ _id: message._id }, { $set: { "correlation.poId": po._id.toHexString(), "correlation.poNumber": po.number } });
  return po;
}

async function onX12Inbound(store: Store, orgId: ObjectId, partner: TradingPartnerDoc, message: B2BMessageDoc) {
  const s = setupOf(partner);
  if (!s.ok) return;
  const r = readX12(message.raw.body, { uomMap: s.setup.uomMap });
  if (!r.ok) return;
  const d: X12Doc = r.doc;

  if (d.kind === "functional_ack") {
    // The partner's receipt for something we sent: match it by the control number we put in the group.
    const want = SET_TO_DOC_TYPE[d.doc.setId as keyof typeof SET_TO_DOC_TYPE];
    const sent = await store.b2bMessages.findOne({ orgId, partnerId: partner._id, direction: "out", docType: want as B2BDocType, "correlation.controlNumber": String(Number(d.doc.groupControl)) });
    if (sent) {
      await recordAck(store, orgId, sent._id, { level: "functional", result: d.doc.status === "rejected" ? "rejected" : "accepted", detail: d.doc.errors.join("; ") });
      await store.b2bMessages.updateOne({ _id: message._id }, { $set: { "correlation.poNumber": sent.correlation.poNumber ?? "", ...(sent.correlation.poId ? { "correlation.poId": sent.correlation.poId } : {}) } });
    }
    return; // a receipt is never itself acknowledged
  }

  if (d.kind === "order_response") {
    const po = await attachOrder(store, orgId, partner, message, d.doc.poNumber);
    if (po) {
      const sent = await store.b2bMessages.find({ orgId, partnerId: partner._id, direction: "out", docType: "order", "correlation.poId": po._id.toHexString() }).sort({ createdAt: -1 }).limit(1).next()
        ?? await store.b2bMessages.find({ orgId, partnerId: partner._id, direction: "out", docType: "order", "correlation.poNumber": po.number }).sort({ createdAt: -1 }).limit(1).next();
      if (sent) {
        const detail = ((d.doc.status === "changed" ? "Accepted with changes. " : "") + d.doc.note).trim().slice(0, 500);
        await recordAck(store, orgId, sent._id, { level: "business", result: d.doc.status === "rejected" ? "rejected" : "accepted", detail });
      }
    }
  } else if (d.kind === "despatch_advice") {
    await attachOrder(store, orgId, partner, message, d.doc.poNumber);
  } else if (d.kind === "invoice" && d.doc.poNumber) {
    await attachOrder(store, orgId, partner, message, d.doc.poNumber);
  }

  if (!s.setup.ack997) return;
  const control = await nextControl(store, orgId, partner._id);
  const w = ackTo997(acknowledge(r.interchange), { profile: profileOut(s.setup), control, now: new Date(), uomMap: s.setup.uomMap });
  if (!w.ok) return;
  await sendMessage(store, orgId, systemActor, partner._id, {
    docType: "functional_ack", body: w.text, contentType: X12_CONTENT_TYPE, idempotencyKey: `997:${message._id.toHexString()}`,
    correlation: { ...(message.correlation.poNumber ? { poNumber: message.correlation.poNumber } : {}), controlNumber: String(control) },
  });
}
registerInboundHook(X12_BRIDGE, onX12Inbound);

export { getBridge };
