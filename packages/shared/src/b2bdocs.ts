import { z } from "zod";

// The canonical documents Invintel keeps for business-to-business exchange. Every bridge and every standard (PDF and
// email, X12, cXML, UBL) is rendered FROM these and parsed INTO these, so the purchase order code never needs to know
// how a partner wants it.

/** A purchase order as we mean it. Quantities are decimal text in the item's own unit ("12.500" kg), never floating point. */
export const canonicalOrderSchema = z.object({
  kind: z.literal("order"),
  version: z.literal(1),
  poNumber: z.string().min(1).max(40),
  /** Counts up when a placed order changes; 1 for the first send. */
  revision: z.number().int().min(1).default(1),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  buyer: z.object({ name: z.string().max(200) }),
  supplier: z.object({ name: z.string().max(200), contact: z.string().max(200).default(""), email: z.string().max(200).default("") }),
  /** Invintel doesn't model currency yet: amounts are in the organization's currency, shown as USD. */
  currency: z.string().length(3).default("USD"),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  note: z.string().max(1000).default(""),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(1),
        sku: z.string().max(64),
        name: z.string().max(200),
        quantity: z.string().regex(/^\d+(\.\d+)?$/),
        unit: z.string().max(16),
        unitPriceCents: z.number().int().min(0),
        lineTotalCents: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(100),
  totalCents: z.number().int().min(0),
  /** Where the supplier can confirm, give a ship date and tracking. */
  portalUrl: z.string().max(500).nullable(),
});
export type CanonicalOrder = z.infer<typeof canonicalOrderSchema>;

// ---------- the supplier's answer page ----------

/** What a supplier tells us from the confirmation page. */
export const supplierAnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), note: z.string().trim().max(500).default("") }),
  z.object({ action: z.literal("reject"), note: z.string().trim().min(1, "Say why").max(500) }),
  z.object({
    action: z.literal("ship"),
    shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    carrier: z.string().trim().max(60).default(""),
    trackingNumber: z.string().trim().max(80).default(""),
    note: z.string().trim().max(500).default(""),
  }),
]);
export type SupplierAnswer = z.input<typeof supplierAnswerSchema>;

/** What the supplier sees on the page: the order, and what they've already told us. No other organization data. */
export interface PortalOrder {
  buyerName: string;
  poNumber: string;
  expectedDate: string | null;
  note: string;
  lines: { lineNo: number; sku: string; name: string; quantity: string; unit: string; unitPriceCents: number; lineTotalCents: number }[];
  totalCents: number;
  supplierName: string;
  answers: { action: "confirm" | "reject" | "ship"; at: string; promisedDate: string | null; shipDate: string | null; carrier: string; trackingNumber: string; note: string }[];
  /** False once the order is closed, cancelled or the link has expired. */
  open: boolean;
  expiresAt: string;
}

/** What the buyer sees on a purchase order about the exchange with its supplier. */
export interface OrderExchange {
  partner: { id: string; name: string; bridge: string; mode: "test" | "live" } | null;
  /** The last message sent for this order, if any. */
  lastMessage: { id: string; state: string; at: string; error: string } | null;
  confirmed: boolean;
  rejected: boolean;
  promisedDate: string | null;
  shipDate: string | null;
  carrier: string;
  trackingNumber: string;
  note: string;
  portalUrl: string | null;
}

// ---------- the other canonical documents (INV-14: X12 maps to and from these) ----------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const qty = z.string().regex(/^\d+(\.\d+)?$/);

/** The supplier's answer to an order (X12 855). "changed" means accepted, but not as ordered. */
export const canonicalOrderResponseSchema = z.object({
  kind: z.literal("order_response"),
  version: z.literal(1),
  poNumber: z.string().min(1).max(40),
  status: z.enum(["accepted", "changed", "rejected"]),
  /** The date of the order being answered, and the date of this answer. */
  poDate: day,
  issuedAt: day,
  note: z.string().max(500).default(""),
  lines: z
    .array(z.object({ lineNo: z.number().int().min(1), sku: z.string().max(64), status: z.enum(["accepted", "changed", "rejected"]), orderedQuantity: qty, /** What the supplier will deliver; "0" when the line is rejected. */ quantity: qty, unit: z.string().max(16), promisedDate: day.nullable() }))
    .max(100),
});
export type CanonicalOrderResponse = z.infer<typeof canonicalOrderResponseSchema>;

/** A ship notice (X12 856): what is on its way against an order. */
export const canonicalShipNoticeSchema = z.object({
  kind: z.literal("despatch_advice"),
  version: z.literal(1),
  shipmentNo: z.string().min(1).max(40),
  poNumber: z.string().min(1).max(40),
  shipDate: day,
  carrier: z.string().max(60).default(""),
  trackingNumber: z.string().max(80).default(""),
  lines: z
    .array(z.object({
      lineNo: z.number().int().min(1), sku: z.string().max(64), quantity: qty, unit: z.string().max(16),
      /** For a packing slip (INV-17): what the item is, what was ordered, and what has shipped in all. Optional: X12 doesn't carry them. */
      name: z.string().max(200).optional(), orderedQuantity: qty.optional(), shippedToDate: qty.optional(),
    }))
    .min(1)
    .max(100),
  /** Who is shipping and to whom, for the packing slip. */
  shipper: z.string().max(100).optional(),
  customerName: z.string().max(200).optional(),
});
export type CanonicalShipNotice = z.infer<typeof canonicalShipNoticeSchema>;

/** A supplier invoice (X12 810). Amounts in cents; the total includes tax. */
export const canonicalInvoiceSchema = z.object({
  kind: z.literal("invoice"),
  version: z.literal(1),
  invoiceNumber: z.string().min(1).max(40),
  invoiceDate: day,
  dueDate: day.nullable(),
  poNumber: z.string().max(40).default(""),
  currency: z.string().length(3).default("USD"),
  lines: z
    .array(z.object({ lineNo: z.number().int().min(1), sku: z.string().max(64), name: z.string().max(200), quantity: qty, unit: z.string().max(16), unitPriceCents: z.number().int().min(0), lineTotalCents: z.number().int().min(0) }))
    .min(1)
    .max(200),
  taxCents: z.number().int().min(0).default(0),
  totalCents: z.number().int().min(0),
  /** For the PDF (INV-17): who it is for, what the tax is called, which shipment it covers, and who issued it. Optional: X12 doesn't carry them. */
  billTo: z.string().max(200).optional(),
  taxLabel: z.string().max(20).optional(),
  shipmentNo: z.string().max(40).optional(),
  shipper: z.string().max(100).optional(),
});
export type CanonicalInvoice = z.infer<typeof canonicalInvoiceSchema>;

/** A receipt for a document, at the syntax level (X12 997): the other side could, or could not, read what we sent. */
export const canonicalFunctionalAckSchema = z.object({
  kind: z.literal("functional_ack"),
  version: z.literal(1),
  /** The group and set being acknowledged, and their control numbers. */
  groupCode: z.string().max(2),
  groupControl: z.string().max(9),
  setId: z.string().max(3),
  setControl: z.string().max(9),
  status: z.enum(["accepted", "accepted_with_errors", "rejected"]),
  /** X12 syntax error codes (AK5 02-06: "4" = segment count doesn't match) and what they mean. */
  errorCodes: z.array(z.string().regex(/^[0-9A-Z]$/)).max(5).default([]),
  errors: z.array(z.string().max(200)).max(20).default([]),
});
export type CanonicalFunctionalAck = z.infer<typeof canonicalFunctionalAckSchema>;
