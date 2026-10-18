import { z } from "zod";

// INV-13: Invintel-to-Invintel exchange. Two organizations trade signed documents directly, with no EDI network between them.
// It plugs into the B2B core (INV-12) as a bridge called "invintel": the TradingPartner holds the other side's public key and address.

export const EXCHANGE_PROTOCOL = "invintel-exchange/1";

/** What this organization shows the world: who it is and how to check what it signs. */
export interface ExchangeIdentity {
  /** Stable public id, e.g. "ix_4f9c2a7e1b3d5a60". Generated once. */
  exchangeId: string;
  name: string;
  /** Ed25519 public key, base64 of the SPKI DER. */
  publicKey: string;
  /** Short readable fingerprint for checking by phone that both sides hold the same key. */
  fingerprint: string;
  /** Where partners on other servers deliver messages. Empty for partners on this same server. */
  baseUrl: string;
}

/** What you hand to a future partner so they can add you: copy it, send it any way you like. It holds no secret. */
export interface ExchangeInvitation extends ExchangeIdentity {
  protocol: typeof EXCHANGE_PROTOCOL;
}

export const exchangeInvitationSchema = z.object({
  protocol: z.literal(EXCHANGE_PROTOCOL),
  exchangeId: z.string().regex(/^ix_[0-9a-f]{16}$/),
  name: z.string().trim().min(1).max(100),
  publicKey: z.string().min(40).max(200),
  fingerprint: z.string().max(40),
  baseUrl: z.string().max(300),
});

export const exchangeIdentityUpdateSchema = z.object({
  /** Public address of this server for partners elsewhere (https only, except localhost). */
  baseUrl: z.string().trim().max(300).refine((u) => u === "" || /^https:\/\/[^\s]+$/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/.test(u), "Use an https address"),
});

/** The documents and questions the exchange carries. The first four are documents; the rest are about asking and answering. */
export const EXCHANGE_TYPES = ["order", "order_response", "despatch_advice", "invoice", "query", "query_response", "receipt"] as const;
export type ExchangeType = (typeof EXCHANGE_TYPES)[number];

export const QUESTION_KINDS = ["stock", "order_status"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** What each partner may ask us, default nothing. Stock and order status are separate switches. */
export const exchangePermissionsSchema = z.object({
  shareStock: z.boolean(),
  shareStockQuantities: z.boolean(),
  shareOrderStatus: z.boolean(),
});
export type ExchangePermissions = z.infer<typeof exchangePermissionsSchema>;
export const NO_PERMISSIONS: ExchangePermissions = { shareStock: false, shareStockQuantities: false, shareOrderStatus: false };

/** The signed message. `signature` covers everything else, in canonical JSON. */
export interface ExchangeEnvelope {
  protocol: typeof EXCHANGE_PROTOCOL;
  /** Unique per message; the receiver treats a repeat as the same message. */
  id: string;
  type: ExchangeType;
  from: string;
  to: string;
  createdAt: string;
  /** The message this one answers, if any. */
  inReplyTo?: string;
  /** The sender's own reference for the thing the message is about (their PO number, say). */
  reference?: string;
  body: unknown;
  signature: string;
}

export const envelopeSchema = z.object({
  protocol: z.literal(EXCHANGE_PROTOCOL),
  id: z.string().min(8).max(80),
  type: z.enum(EXCHANGE_TYPES),
  from: z.string().regex(/^ix_[0-9a-f]{16}$/),
  to: z.string().regex(/^ix_[0-9a-f]{16}$/),
  createdAt: z.string().max(40),
  inReplyTo: z.string().max(80).optional(),
  reference: z.string().max(80).optional(),
  body: z.unknown(),
  signature: z.string().min(40).max(200),
});

// ---------- document bodies ----------

const line = z.object({ sku: z.string().trim().min(1).max(64), description: z.string().trim().max(200).default(""), quantity: z.number().positive().max(1_000_000_000), unit: z.string().trim().max(20).default(""), unitPriceCents: z.number().int().min(0).default(0) });

export const orderBodySchema = z.object({
  poNumber: z.string().trim().min(1).max(40),
  currency: z.string().trim().length(3).default("USD"),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  note: z.string().trim().max(1000).default(""),
  lines: z.array(line).min(1).max(100),
});
export type OrderBody = z.infer<typeof orderBodySchema>;

export const orderResponseBodySchema = z.object({
  poNumber: z.string().trim().min(1).max(40),
  status: z.enum(["accepted", "rejected", "changed"]),
  /** Date the supplier commits to ship (or deliver). */
  promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  note: z.string().trim().max(1000).default(""),
  lines: z.array(z.object({ sku: z.string().max(64), quantity: z.number().min(0), status: z.enum(["accepted", "rejected", "changed"]) })).max(100).default([]),
});
export type OrderResponseBody = z.infer<typeof orderResponseBodySchema>;

export const despatchBodySchema = z.object({
  poNumber: z.string().trim().min(1).max(40),
  shipmentNumber: z.string().trim().min(1).max(40),
  shippedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  carrier: z.string().trim().max(80).default(""),
  tracking: z.string().trim().max(120).default(""),
  lines: z.array(z.object({ sku: z.string().max(64), quantity: z.number().positive(), lot: z.string().max(64).default("") })).min(1).max(100),
});
export type DespatchBody = z.infer<typeof despatchBodySchema>;

export const queryBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stock"), sku: z.string().trim().min(1).max(64) }),
  z.object({ kind: z.literal("order_status"), poNumber: z.string().trim().min(1).max(40) }),
]);
export type QueryBody = z.infer<typeof queryBodySchema>;

export interface QueryResponseBody {
  kind: QuestionKind;
  /** false when the question can't be answered (not allowed, unknown item or order); `reason` says why in plain words. */
  ok: boolean;
  reason?: string;
  stock?: { sku: string; description: string; availability: "in_stock" | "low" | "out"; quantity?: number; unit?: string };
  order?: { poNumber: string; status: string; promisedDate: string | null; shipped: boolean };
}

/** The delivery-level answer to any message: "I got it" or "I refused it, and why". Business answers are separate documents. */
export interface ReceiptBody {
  received: boolean;
  reason?: string;
}
