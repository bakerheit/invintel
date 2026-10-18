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
