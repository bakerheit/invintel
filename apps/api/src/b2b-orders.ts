import { canonicalOrderSchema, supplierAnswerSchema, type CanonicalOrder, type OrderExchange, type PortalOrder } from "@invintel/shared";
import { zValidator } from "@hono/zod-validator";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { recordAudit } from "./audit.js";
import { getBridge, recordAck, registerBridge, retryMessage, sendMessage, storeInbound, type Bridge, type Failure, type Sent } from "./b2b-core.js";
import type { B2BMessageDoc, PortalLinkDoc, Store, TradingPartnerDoc } from "./db.js";
import { getMailTransport } from "./mail.js";
import { isEmail } from "./mime.js";
import { buildCanonicalOrder, renderOrderPdf } from "./order-doc.js";
import { toOrders } from "./purchasing.js";
import type { Actor } from "./stock-service.js";

// INV-12: sending a purchase order by email (a PDF and a secure link) and letting the supplier answer on a plain page:
// confirm (with a promised date), decline, or tell us it has shipped (date, carrier, tracking). No account on their side.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DAY = 86_400_000;
export const publicUrl = () => (process.env.INVINTEL_PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, "");
const mailFrom = () => process.env.INVINTEL_MAIL_FROM ?? "orders@invintel.local";

// ---------- the email bridge ----------

const fmtMoney = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export function orderEmailText(o: CanonicalOrder): string {
  return [
    `Hello${o.supplier.contact ? ` ${o.supplier.contact}` : ""},`,
    "",
    `${o.buyer.name} would like to order the following (purchase order ${o.poNumber}${o.revision > 1 ? `, revision ${o.revision}` : ""}). The order is attached as a PDF.`,
    "",
    ...o.lines.map((l) => `  ${l.lineNo}. ${l.sku ? `${l.sku} ` : ""}${l.name}: ${l.quantity} ${l.unit} at ${fmtMoney(l.unitPriceCents)} = ${fmtMoney(l.lineTotalCents)}`),
    "",
    `Total: ${fmtMoney(o.totalCents)} ${o.currency}`,
    ...(o.expectedDate ? [`Requested delivery date: ${o.expectedDate}`] : []),
    ...(o.note ? ["", o.note] : []),
    ...(o.portalUrl ? ["", "Please confirm the order, give a ship date and tracking here (no account needed):", o.portalUrl] : []),
    "",
    "Thank you,",
    o.buyer.name,
  ].join("\n");
}

/** Sends the canonical order as an email with the PDF attached. Partner settings: `to` (required), `cc`, `replyTo`. */
export const emailBridge: Bridge = {
  id: "email",
  carries: ["order", "order_change"],
  async send(message, partner) {
    const to = (partner.bridgeConfig.to ?? "").split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
    if (!to.length || !to.every(isEmail)) return { ok: false, error: "This partner has no valid email address (setting \"to\")", retryable: false };
    const cc = (partner.bridgeConfig.cc ?? "").split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
    if (!cc.every(isEmail)) return { ok: false, error: "The cc setting has an invalid email address", retryable: false };
    let order: CanonicalOrder;
    try {
      order = canonicalOrderSchema.parse(JSON.parse(message.body));
    } catch {
      return { ok: false, error: "The document isn't a valid order", retryable: false };
    }
    const replyTo = partner.bridgeConfig.replyTo && isEmail(partner.bridgeConfig.replyTo) ? partner.bridgeConfig.replyTo : undefined;
    const res = await getMailTransport().send({
      from: mailFrom(),
      to,
      ...(cc.length ? { cc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: `Purchase order ${order.poNumber} from ${order.buyer.name}${partner.mode === "test" ? " (TEST)" : ""}`.replace(/[\r\n]+/g, " "),
      text: orderEmailText(order),
      attachments: [{ filename: `${order.poNumber}.pdf`, contentType: "application/pdf", content: renderOrderPdf(order) }],
    });
    return res.ok ? { ok: true, state: "sent", providerMessageId: res.messageId } : { ok: false, error: res.error, retryable: res.retryable };
  },
  async verifyInbound() {
    return { ok: false, error: "Inbound email is handled by the invoice capture bridge" };
  },
};
registerBridge(emailBridge);

// ---------- portal links ----------

async function newLink(store: Store, orgId: ObjectId, partnerId: ObjectId, poId: ObjectId, days = 60) {
  const token = randomBytes(32).toString("base64url");
  const link: PortalLinkDoc = { _id: new ObjectId(), orgId, partnerId, poId, tokenHash: sha(token), createdAt: new Date(), expiresAt: new Date(Date.now() + days * DAY) };
  await store.portalLinks.insertOne(link);
  // A new link replaces the old ones for this order.
  await store.portalLinks.updateMany({ orgId, poId, _id: { $ne: link._id }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  return { link, url: `${publicUrl()}/b2b/s/${token}` };
}

const latestOut = (store: Store, orgId: ObjectId, poId: ObjectId) =>
  store.b2bMessages.find({ orgId, direction: "out", docType: "order", "correlation.poId": poId.toHexString() }).sort({ createdAt: -1 }).limit(1).toArray().then((x) => x[0] ?? null);

/** Sends (or re-sends) a placed purchase order to its supplier's trading partner. */
export async function sendPurchaseOrder(store: Store, orgId: ObjectId, actor: Actor, poId: ObjectId, orgName: string): Promise<Sent | Failure> {
  const po = await store.purchaseOrders.findOne({ _id: poId, orgId });
  if (!po) return { ok: false, status: 404, error: "Order not found" };
  if (po.state !== "ordered") return { ok: false, status: 409, error: po.state === "draft" ? "Place the order before sending it" : `A ${po.state} order can't be sent` };
  const partner = await store.tradingPartners.findOne({ orgId, supplierId: po.supplierId, kind: "supplier", enabled: true });
  if (!partner) return { ok: false, status: 409, error: "Set up this supplier as a trading partner first (Exchange > Partners)" };
  const last = await latestOut(store, orgId, poId);
  if (last?.state === "failed" && last.attempts[last.attempts.length - 1]?.retryable) return retryMessage(store, orgId, actor, last._id);
  const revision = (await store.b2bMessages.countDocuments({ orgId, direction: "out", docType: "order", "correlation.poId": poId.toHexString() })) + 1;
  const [order] = await toOrders(store, [po]);
  const supplier = await store.suppliers.findOne({ _id: po.supplierId });
  const { link, url } = await newLink(store, orgId, partner._id, poId);
  const canonical = buildCanonicalOrder(order!, { buyerName: orgName, supplierContact: supplier?.contact ?? "", supplierEmail: partner.bridgeConfig.to ?? supplier?.email ?? "", portalUrl: url, revision });
  const res = await sendMessage(store, orgId, actor, partner._id, {
    docType: "order", body: JSON.stringify(canonical), contentType: "application/json", correlation: { poId: poId.toHexString(), poNumber: po.number }, idempotencyKey: `po:${poId.toHexString()}:rev:${revision}`,
  });
  if (res.ok) await store.portalLinks.updateOne({ _id: link._id }, { $set: { messageId: res.message._id } });
  return res;
}

/** The PDF the supplier would get, without sending anything. */
export async function previewPurchaseOrder(store: Store, orgId: ObjectId, poId: ObjectId, orgName: string): Promise<{ ok: true; pdf: Buffer; canonical: CanonicalOrder } | Failure> {
  const po = await store.purchaseOrders.findOne({ _id: poId, orgId });
  if (!po) return { ok: false, status: 404, error: "Order not found" };
  const [order] = await toOrders(store, [po]);
  const supplier = await store.suppliers.findOne({ _id: po.supplierId });
  const canonical = buildCanonicalOrder(order!, { buyerName: orgName, supplierContact: supplier?.contact ?? "", supplierEmail: supplier?.email ?? "", portalUrl: null });
  return { ok: true, pdf: renderOrderPdf(canonical), canonical };
}

// ---------- what the buyer sees on the order ----------

type Answer = { action: "confirm" | "reject" | "ship"; promisedDate?: string | null; shipDate?: string; carrier?: string; trackingNumber?: string; note?: string; at: Date };

async function answersFor(store: Store, orgId: ObjectId, poId: ObjectId): Promise<Answer[]> {
  const docs = await store.b2bMessages.find({ orgId, direction: "in", "correlation.poId": poId.toHexString(), docType: { $in: ["order_response", "despatch_advice"] } }).sort({ createdAt: 1 }).toArray();
  return docs.flatMap((d) => {
    try {
      const j = JSON.parse(d.raw.body);
      return [{ ...j, at: d.createdAt } as Answer];
    } catch {
      return [];
    }
  });
}

export async function orderExchange(store: Store, orgId: ObjectId, poId: ObjectId): Promise<OrderExchange | Failure> {
  const po = await store.purchaseOrders.findOne({ _id: poId, orgId });
  if (!po) return { ok: false, status: 404, error: "Order not found" };
  const partner = await store.tradingPartners.findOne({ orgId, supplierId: po.supplierId, kind: "supplier" });
  const last = await latestOut(store, orgId, poId);
  const answers = await answersFor(store, orgId, poId);
  const decision = [...answers].reverse().find((a) => a.action === "confirm" || a.action === "reject");
  const ship = [...answers].reverse().find((a) => a.action === "ship");
  let portalUrl: string | null = null;
  if (last) {
    try { portalUrl = canonicalOrderSchema.parse(JSON.parse(last.raw.body)).portalUrl; } catch { /* old or odd message */ }
  }
  return {
    partner: partner ? { id: partner._id.toHexString(), name: partner.name, bridge: partner.bridge, mode: partner.mode } : null,
    lastMessage: last ? { id: last._id.toHexString(), state: last.state, at: last.createdAt.toISOString(), error: last.attempts.filter((a) => !a.ok).pop()?.error ?? "" } : null,
    confirmed: decision?.action === "confirm",
    rejected: decision?.action === "reject",
    promisedDate: [...answers].reverse().find((a) => a.action === "confirm" && a.promisedDate)?.promisedDate ?? null,
    shipDate: ship?.shipDate ?? null,
    carrier: ship?.carrier ?? "",
    trackingNumber: ship?.trackingNumber ?? "",
    note: decision?.note ?? "",
    portalUrl,
  };
}

// ---------- the supplier's page (no sign-in: the link is the key) ----------

const hits = new Map<string, { n: number; reset: number }>();
const tooMany = (key: string, max = 60) => {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + 60_000 }); return false; }
  return ++h.n > max;
};

async function linkFor(store: Store, token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const link = await store.portalLinks.findOne({ tokenHash: sha(token) });
  if (!link || link.revokedAt || link.expiresAt < new Date()) return null;
  return link;
}

export function createB2BPortalRoutes(store: Store) {
  const r = new Hono();
  const invalid = (c: { json: (b: unknown, s: 404) => Response }) => c.json({ error: "This link isn't valid any more. Ask the buyer to send it again." }, 404);

  r.get("/:token", async (c) => {
    const token = c.req.param("token");
    if (tooMany(`g:${token.slice(0, 12)}`)) return c.json({ error: "Slow down" }, 429) as never;
    const link = await linkFor(store, token);
    if (!link) return invalid(c);
    const [po, msg, partner, org] = await Promise.all([
      store.purchaseOrders.findOne({ _id: link.poId, orgId: link.orgId }),
      link.messageId ? store.b2bMessages.findOne({ _id: link.messageId }) : null,
      store.tradingPartners.findOne({ _id: link.partnerId }),
      store.orgs.findOne({ _id: link.orgId }, { projection: { name: 1 } }),
    ]);
    if (!po || !msg || !partner) return invalid(c);
    const order = canonicalOrderSchema.parse(JSON.parse(msg.raw.body));
    const answers = await answersFor(store, link.orgId, link.poId);
    const body: PortalOrder = {
      buyerName: org?.name ?? order.buyer.name, poNumber: order.poNumber, expectedDate: order.expectedDate, note: order.note, lines: order.lines, totalCents: order.totalCents,
      supplierName: order.supplier.name,
      answers: answers.map((a) => ({ action: a.action, at: a.at.toISOString(), promisedDate: a.promisedDate ?? null, shipDate: a.shipDate ?? null, carrier: a.carrier ?? "", trackingNumber: a.trackingNumber ?? "", note: a.note ?? "" })),
      open: po.state === "ordered", expiresAt: link.expiresAt.toISOString(),
    };
    return c.json(body);
  });

  r.post("/:token/answer", zValidator("json", supplierAnswerSchema), async (c) => {
    const token = c.req.param("token");
    if (tooMany(`p:${token.slice(0, 12)}`, 30)) return c.json({ error: "Slow down" }, 429);
    const link = await linkFor(store, token);
    if (!link) return invalid(c);
    const [po, partner] = await Promise.all([store.purchaseOrders.findOne({ _id: link.poId, orgId: link.orgId }), store.tradingPartners.findOne({ _id: link.partnerId })]);
    if (!po || !partner || !partner.enabled) return invalid(c);
    if (po.state !== "ordered") return c.json({ error: "This order is closed. Contact the buyer." }, 409) as never;
    const a = c.req.valid("json");
    const docType = a.action === "ship" ? "despatch_advice" : "order_response";
    const stored = await storeInbound(store, link.orgId, partner, {
      docType, body: JSON.stringify({ ...a, poNumber: po.number }), idempotencyKey: `portal:${link._id.toHexString()}:${randomUUID()}`,
      correlation: { poId: link.poId.toHexString(), poNumber: po.number }, fromName: `${partner.name} (order page)`,
    });
    if (!stored.ok) return c.json({ error: stored.error }, 409) as never;
    if (a.action !== "ship" && link.messageId) {
      // The business answer to our order: accepted or rejected. A second answer is stored but can't move a settled message.
      await recordAck(store, link.orgId, link.messageId, { level: "business", result: a.action === "confirm" ? "accepted" : "rejected", detail: a.note ?? "" });
    }
    await recordAudit(store, {
      orgId: link.orgId, actor: { id: null, name: `${partner.name} (order page)` }, action: "b2b.order_answered", entity: { type: "purchase_order", id: po._id.toHexString(), label: po.number },
      summary: a.action === "confirm" ? `${partner.name} confirmed ${po.number}${a.promisedDate ? `, promising ${a.promisedDate}` : ""}` : a.action === "reject" ? `${partner.name} declined ${po.number}: ${a.note}` : `${partner.name} shipped ${po.number} on ${a.shipDate}${a.trackingNumber ? ` (${a.carrier} ${a.trackingNumber})` : ""}`,
      snapshot: { action: a.action, partner: partner.name, mode: partner.mode },
    });
    return c.json({ ok: true }, 201);
  });

  return r;
}

export type { B2BMessageDoc, TradingPartnerDoc };
export { getBridge };
