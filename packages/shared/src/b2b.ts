import { z } from "zod";
import { docKindSchema, docTemplateOverrideSchema, type DocKind, type DocTemplateOverride } from "./templates.js";

// INV-12: the transport-independent core of business-to-business exchange. A TRADING PARTNER is another business we
// exchange documents with, over a BRIDGE (an adapter for one way of moving documents: email, an EDI provider, the
// Invintel-to-Invintel exchange, a loopback for tests). A B2B MESSAGE is one document sent or received: it is kept
// whole (raw payload, immutable), with its state, attempts and acknowledgements, and linked to our own records.

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

/** Everything we might exchange. Bridges say which of these they carry. */
export const B2B_DOC_TYPES = [
  "order", "order_change", "order_response", "despatch_advice", "invoice", "remittance", "query", "query_response", "functional_ack",
] as const;
export const b2bDocTypeSchema = z.enum(B2B_DOC_TYPES);
export type B2BDocType = z.infer<typeof b2bDocTypeSchema>;

export const B2B_DOC_LABELS: Record<B2BDocType, string> = {
  order: "Purchase order", order_change: "Order change", order_response: "Order acknowledgement", despatch_advice: "Ship notice",
  invoice: "Invoice", remittance: "Payment advice", query: "Question", query_response: "Answer", functional_ack: "Receipt (997)",
};

/** queued: written, not yet handed to the bridge. sent/delivered: the bridge took it / it arrived (transport level). acknowledged/rejected:
 *  the other side's answer (or ours, for what we received). failed: the bridge could not send it (retry allowed). received: came in from the partner. */
export const B2B_STATES = ["queued", "sent", "delivered", "acknowledged", "rejected", "failed", "received"] as const;
export type B2BState = (typeof B2B_STATES)[number];

/** Which state may follow which. Moves only go forward; "failed" can be retried back to "queued". */
export const B2B_TRANSITIONS: Record<B2BState, B2BState[]> = {
  queued: ["sent", "delivered", "failed"],
  sent: ["delivered", "acknowledged", "rejected", "failed"],
  delivered: ["acknowledged", "rejected"],
  failed: ["queued"],
  acknowledged: [],
  rejected: [],
  received: ["acknowledged", "rejected"],
};

export const B2B_ACK_LEVELS = ["transport", "functional", "business"] as const;
export const b2bAckSchema = z.object({
  level: z.enum(B2B_ACK_LEVELS),
  result: z.enum(["accepted", "rejected"]),
  detail: z.string().trim().max(500).default(""),
});
export type B2BAckInput = z.input<typeof b2bAckSchema>;

// ---------- trading partners ----------

export const partnerFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  kind: z.enum(["supplier", "customer"]),
  /** The supplier record this partner is, when it is one. */
  supplierId: id.nullable(),
  /** How the other side is known: a scheme (e.g. "GLN", "ISA", "Peppol", "email") and a value. */
  identifiers: z.array(z.object({ scheme: z.string().trim().min(1).max(30), value: z.string().trim().min(1).max(100) })).max(10),
  /** Which bridge carries documents, and its non-secret settings (secrets stay in the server environment, referenced by name). */
  bridge: z.string().trim().min(1).max(40),
  bridgeConfig: z.record(z.string().max(40), z.string().max(500)).refine((c) => Object.keys(c).length <= 20, "At most 20 settings"),
  /** Test partners only ever use test endpoints; going live is an explicit change. */
  mode: z.enum(["test", "live"]),
  enabled: z.boolean(),
  contactEmail: z.string().trim().max(200),
  note: z.string().trim().max(500),
  /** How documents made for this partner differ from the organization's templates (INV-17): the same fields, all optional. */
  docTemplates: z.partialRecord(docKindSchema, docTemplateOverrideSchema),
};
export const tradingPartnerInputSchema = z.object({
  ...partnerFields,
  supplierId: partnerFields.supplierId.default(null),
  identifiers: partnerFields.identifiers.default([]),
  bridgeConfig: partnerFields.bridgeConfig.default({}),
  mode: partnerFields.mode.default("test"),
  enabled: partnerFields.enabled.default(true),
  contactEmail: partnerFields.contactEmail.default(""),
  note: partnerFields.note.default(""),
  docTemplates: partnerFields.docTemplates.default({}),
});
export type TradingPartnerInput = z.input<typeof tradingPartnerInputSchema>;
export const tradingPartnerUpdateSchema = z.object(partnerFields).partial();
export type TradingPartnerUpdate = z.infer<typeof tradingPartnerUpdateSchema>;

export interface TradingPartner {
  id: string;
  name: string;
  kind: "supplier" | "customer";
  supplierId: string | null;
  identifiers: { scheme: string; value: string }[];
  bridge: string;
  bridgeConfig: Record<string, string>;
  mode: "test" | "live";
  enabled: boolean;
  contactEmail: string;
  note: string;
  docTemplates: Partial<Record<DocKind, DocTemplateOverride>>;
  createdAt: string;
}

// ---------- messages ----------

/** What a message is about in our own records (all optional). */
export const b2bCorrelationSchema = z.object({
  poId: id.optional(),
  poNumber: z.string().trim().max(40).optional(),
  invoiceId: id.optional(),
  shipmentId: id.optional(),
  /** The other side's reference (their PO, ship notice or invoice number). */
  partnerRef: z.string().trim().max(80).optional(),
  /** EDI interchange control number (ISA13) of what we sent, so the partner's receipt can be matched to it. */
  controlNumber: z.string().trim().max(20).optional(),
});
export type B2BCorrelation = z.infer<typeof b2bCorrelationSchema>;

export const sendMessageInputSchema = z.object({
  docType: b2bDocTypeSchema,
  /** The document as the bridge will carry it (JSON text, XML, an X12 string...). */
  body: z.string().max(2_000_000),
  contentType: z.string().trim().max(100).default("application/json"),
  correlation: b2bCorrelationSchema.default({}),
  /** The same key never makes two messages, so a retry after a timeout can't send a document twice. */
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});
export type SendMessageInput = z.input<typeof sendMessageInputSchema>;

export interface B2BAttempt {
  at: string;
  ok: boolean;
  error: string;
  retryable: boolean;
}

export interface B2BAck {
  level: (typeof B2B_ACK_LEVELS)[number];
  result: "accepted" | "rejected";
  detail: string;
  at: string;
}

export interface B2BMessage {
  id: string;
  partnerId: string;
  partnerName: string;
  direction: "out" | "in";
  docType: B2BDocType;
  state: B2BState;
  idempotencyKey: string;
  correlation: B2BCorrelation;
  contentType: string;
  /** Size and fingerprint of the stored raw document; read the body from GET /b2b/messages/:id. */
  rawBytes: number;
  rawHash: string;
  providerMessageId: string | null;
  attempts: B2BAttempt[];
  acks: B2BAck[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface B2BMessageDetail extends B2BMessage {
  body: string;
}
