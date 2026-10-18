import { type Address, canonicalInvoiceSchema, canonicalOrderSchema, canonicalSalesConfirmationSchema, canonicalShipNoticeSchema, supplierAnswerSchema, type CanonicalInvoice, type CanonicalOrder, type CanonicalSalesConfirmation, type CanonicalShipNotice, type OrderExchange, type PortalOrder } from "@invintel/shared";
import { zValidator } from "@hono/zod-validator";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { recordAudit } from "./audit.js";
import { getBridge, recordAck, registerBridge, retryMessage, sendMessage, storeInbound, type Bridge, type Failure, type Sent } from "./b2b-core.js";
import type { B2BMessageDoc, PortalLinkDoc, Store, TradingPartnerDoc } from "./db.js";
import { getMailTransport } from "./mail.js";
import { isEmail } from "./mime.js";
import { docContextFor, loadDocContext } from "./doc-context.js";
import { renderDocument } from "./doc-render.js";
import { buildCanonicalOrder, renderOrderPdf } from "./order-doc.js";
import { toOrders } from "./purchasing.js";
import { sendX12Order, X12_BRIDGE } from "./x12-bridge.js";
import { answerOf, readX12 } from "./x12-maps.js";
import { X12_CONTENT_TYPE } from "./x12.js";
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

const fmt = (c: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export function confirmationEmailText(c: CanonicalSalesConfirmation, shipper: string): string {
  return [
    "Hello,", "",
    `Thank you for your order${c.customerRef ? ` ${c.customerRef}` : ""}. This is ${shipper || "our"} confirmation ${c.number}; it is attached as a PDF.`, "",
    ...c.lines.map((l) => `  ${l.lineNo}. ${l.sku ? `${l.sku} ` : ""}${l.name}: ${l.quantity} ${l.unit} at ${fmt(l.unitPriceCents, c.currency)} = ${fmt(l.lineTotalCents, c.currency)}`), "",
    `Total: ${fmt(c.totalCents, c.currency)} ${c.currency}`,
    ...(c.requestedDate ? [`Requested delivery date: ${c.requestedDate}`] : []),
    ...(c.note ? ["", c.note] : []), "", "Thank you,", shipper || "",
  ].join("\n");
}

export function invoiceEmailText(i: CanonicalInvoice, shipper: string): string {
  return [
    "Hello,", "",
    `Please find invoice ${i.invoiceNumber} from ${shipper || "us"} attached as a PDF${i.poNumber ? ` (your order ${i.poNumber})` : ""}.`, "",
    `Total: ${fmt(i.totalCents, i.currency)} ${i.currency}${i.taxCents > 0 ? ` (including ${i.taxLabel || "tax"} ${fmt(i.taxCents, i.currency)})` : ""}`,
    ...(i.dueDate ? [`Due: ${i.dueDate}`] : []), "", "Thank you,", shipper || "",
  ].join("\n");
}

/** The ship notice as an email (INV-16): what went, when, how, and the tracking, in plain text. */
export function shipNoticeEmailText(n: CanonicalShipNotice, shipper: string): string {
  return [
    "Hello,",
    "",
    `${shipper || "We"} shipped part or all of your order ${n.poNumber} (shipment ${n.shipmentNo}) on ${n.shipDate}.`,
    "",
    ...n.lines.map((l) => `  ${l.lineNo}. ${l.sku ? `${l.sku}: ` : ""}${l.quantity} ${l.unit}`),
    "",
    ...(n.carrier ? [`Carrier: ${n.carrier}`] : []),
    ...(n.trackingNumber ? [`Tracking number: ${n.trackingNumber}`] : []),
    "",
    "Thank you,",
    shipper || "",
  ].join("\n");
}

/** Sends the canonical order as an email with the PDF attached, and ship notices as plain emails. Partner settings: `to` (required), `cc`, `replyTo`. */
export const emailBridge: Bridge = {
  id: "email",
  carries: ["order", "order_change", "despatch_advice", "order_response", "invoice"],
  async send(message, partner) {
    const to = (partner.bridgeConfig.to ?? "").split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
    if (!to.length || !to.every(isEmail)) return { ok: false, error: "This partner has no valid email address (setting \"to\")", retryable: false };
    const cc = (partner.bridgeConfig.cc ?? "").split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
    if (!cc.every(isEmail)) return { ok: false, error: "The cc setting has an invalid email address", retryable: false };
    const replyTo = partner.bridgeConfig.replyTo && isEmail(partner.bridgeConfig.replyTo) ? partner.bridgeConfig.replyTo : undefined;
    if (message.docType === "despatch_advice") {
      let notice: CanonicalShipNotice;
      let shipper = "";
      try {
        const raw = JSON.parse(message.body) as { shipper?: unknown };
        notice = canonicalShipNoticeSchema.parse(raw);
        shipper = typeof raw.shipper === "string" ? raw.shipper : "";
      } catch {
        return { ok: false, error: "The document isn't a valid ship notice", retryable: false };
      }
      const sent = await getMailTransport().send({
        from: mailFrom(), to, ...(cc.length ? { cc } : {}), ...(replyTo ? { replyTo } : {}),
        subject: `Shipment ${notice.shipmentNo} for your order ${notice.poNumber}${shipper ? ` from ${shipper}` : ""}${partner.mode === "test" ? " (TEST)" : ""}`.replace(/[\r\n]+/g, " "),
        text: shipNoticeEmailText(notice, shipper),
        attachments: [{ filename: `${notice.shipmentNo}-packing-slip.pdf`, contentType: "application/pdf", content: renderDocument({ kind: "packing_slip", doc: notice }, await docContextFor(partner.orgId, partner._id, "packing_slip", shipper || "Shipper")) }],
      });
      return sent.ok ? { ok: true, state: "sent", providerMessageId: sent.messageId } : { ok: false, error: sent.error, retryable: sent.retryable };
    }
    if (message.docType === "order_response" || message.docType === "invoice") {
      // What we send a customer: an order confirmation or an invoice, drawn with our letterhead and templates.
      let json: unknown;
      try { json = JSON.parse(message.body); } catch { return { ok: false, error: "The document isn't valid JSON", retryable: false }; }
      const made = message.docType === "invoice" ? canonicalInvoiceSchema.safeParse(json) : canonicalSalesConfirmationSchema.safeParse(json);
      if (!made.success) return { ok: false, error: `The document isn't a valid ${message.docType === "invoice" ? "invoice" : "order confirmation"}`, retryable: false };
      const test = partner.mode === "test" ? " (TEST)" : "";
      const doc = made.data;
      const inv = message.docType === "invoice";
      const number = "invoiceNumber" in doc ? doc.invoiceNumber : doc.number;
      const shipper = doc.shipper ?? "";
      const ctx = await docContextFor(partner.orgId, partner._id, inv ? "invoice" : "sales_order", shipper || "Sender");
      const sent = await getMailTransport().send({
        from: mailFrom(), to, ...(cc.length ? { cc } : {}), ...(replyTo ? { replyTo } : {}),
        subject: `${inv ? "Invoice" : "Order confirmation"} ${number}${shipper ? ` from ${shipper}` : ""}${test}`.replace(/[\r\n]+/g, " "),
        text: inv ? invoiceEmailText(doc as CanonicalInvoice, shipper) : confirmationEmailText(doc as CanonicalSalesConfirmation, shipper),
        attachments: [{ filename: `${number}.pdf`, contentType: "application/pdf", content: inv ? renderDocument({ kind: "invoice", doc: doc as CanonicalInvoice }, ctx) : renderDocument({ kind: "sales_order", doc: doc as CanonicalSalesConfirmation }, ctx) }],
      });
      return sent.ok ? { ok: true, state: "sent", providerMessageId: sent.messageId } : { ok: false, error: sent.error, retryable: sent.retryable };
    }
    let order: CanonicalOrder;
    try {
      order = canonicalOrderSchema.parse(JSON.parse(message.body));
    } catch {
      return { ok: false, error: "The document isn't a valid order", retryable: false };
    }
    const res = await getMailTransport().send({
      from: mailFrom(),
      to,
      ...(cc.length ? { cc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: `Purchase order ${order.poNumber} from ${order.buyer.name}${partner.mode === "test" ? " (TEST)" : ""}`.replace(/[\r\n]+/g, " "),
      text: orderEmailText(order),
      attachments: [{ filename: `${order.poNumber}.pdf`, contentType: "application/pdf", content: renderOrderPdf(order, await docContextFor(partner.orgId, partner._id, "purchase_order", order.buyer.name)) }],
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

/** The supplier's address and ours (the letterhead's), for the order document. */
async function addresses(store: Store, orgId: ObjectId, supplier: { address?: Address | null } | null) {
  const org = await store.orgs.findOne({ _id: orgId }, { projection: { documentProfile: 1 } });
  return { supplierAddress: supplier?.address ?? null, buyerAddress: org?.documentProfile?.company?.address ?? null };
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
  if (partner.bridge === X12_BRIDGE) {
    // EDI partners get an 850 and no supplier page; their system answers with a 997 and an 855.
    const canonical = buildCanonicalOrder(order!, { buyerName: orgName, supplierContact: supplier?.contact ?? "", supplierEmail: "", portalUrl: null, revision, ...(await addresses(store, orgId, supplier)) });
    return sendX12Order(store, orgId, actor, partner, canonical, poId);
  }
  const { link, url } = await newLink(store, orgId, partner._id, poId);
  const canonical = buildCanonicalOrder(order!, { buyerName: orgName, supplierContact: supplier?.contact ?? "", supplierEmail: partner.bridgeConfig.to ?? supplier?.email ?? "", portalUrl: url, revision, ...(await addresses(store, orgId, supplier)) });
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
  const canonical = buildCanonicalOrder(order!, { buyerName: orgName, supplierContact: supplier?.contact ?? "", supplierEmail: supplier?.email ?? "", portalUrl: null, ...(await addresses(store, orgId, supplier)) });
  const partner = await store.tradingPartners.findOne({ orgId, supplierId: po.supplierId, kind: "supplier" }, { projection: { _id: 1 } });
  return { ok: true, pdf: renderOrderPdf(canonical, await loadDocContext(store, orgId, "purchase_order", partner?._id ?? null)), canonical };
}

// ---------- what the buyer sees on the order ----------

type Answer = { action: "confirm" | "reject" | "ship"; promisedDate?: string | null; shipDate?: string; carrier?: string; trackingNumber?: string; note?: string; at: Date };

async function answersFor(store: Store, orgId: ObjectId, poId: ObjectId): Promise<Answer[]> {
  const docs = await store.b2bMessages.find({ orgId, direction: "in", "correlation.poId": poId.toHexString(), docType: { $in: ["order_response", "despatch_advice"] } }).sort({ createdAt: 1 }).toArray();
  return docs.flatMap((d) => {
    try {
      if (d.raw.contentType === X12_CONTENT_TYPE) {
        const r = readX12(d.raw.body);
        const a = r.ok ? answerOf(r.doc) : null;
        return a ? [{ ...a, at: d.createdAt } as Answer] : [];
      }
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
