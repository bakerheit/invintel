import { z } from "zod";
import { MAX_QTY, type Uom } from "./units.js";

// Supplier invoices, shipments (advance ship notices) and payment records, with a three-way match
// of invoice, purchase order and what was actually received. No money moves here: a payment is a record.

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "That isn't a real date");
const cents = z.number().int().min(0).max(100_000_000_000);

export const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code like USD");
export const DEFAULT_CURRENCY = "USD";

// ---------- matching rules (per organization) ----------

export const invoiceSettingsSchema = z.object({
  /** The money the books are kept in. An invoice in another currency is flagged. */
  currency: currencySchema,
  /** A price above the order's by more than this share is flagged (below is noted, not blocked). */
  priceTolerancePct: z.number().min(0).max(100),
  /** More billed than received by more than this share is flagged. */
  qtyTolerancePct: z.number().min(0).max(100),
  /** The supplier's stated total may differ from the sum of its lines by this much. */
  totalToleranceCents: z.number().int().min(0).max(1_000_000),
});
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;
export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = { currency: DEFAULT_CURRENCY, priceTolerancePct: 1, qtyTolerancePct: 0, totalToleranceCents: 5 };

// ---------- invoices ----------

export const INVOICE_STATUSES = ["draft", "review", "approved", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const invoiceLineInputSchema = z.object({
  /** The item billed. Leave empty for things that aren't stock (freight, fees). */
  itemId: id.nullable().default(null),
  description: z.string().trim().max(200).default(""),
  /** In the item's own unit, as the whole number stored (12.5 kg with 3 decimals is 12500). 1 for a service. */
  quantity: z.number().int().min(1).max(MAX_QTY),
  /** Price of ONE unit of the item (one kg), in cents. */
  unitPriceCents: cents,
  /** Tax the supplier charged on this line, in cents. */
  taxCents: cents.default(0),
});
export type InvoiceLineInput = z.input<typeof invoiceLineInputSchema>;

// The fields have no defaults here: Zod's .partial() keeps defaults, which would make a PATCH reset anything it left out.
const invoiceFields = {
  supplierId: id,
  purchaseOrderId: id.nullable(),
  /** The supplier's own number for it. Printed on their document. */
  invoiceNumber: z.string().trim().min(1, "Enter the supplier's invoice number").max(64),
  issueDate: date,
  dueDate: date.nullable(),
  currency: currencySchema,
  lines: z.array(invoiceLineInputSchema).min(1, "Add at least one line").max(200),
  freightCents: cents,
  /** The total printed on the supplier's document, if you want it checked against the lines. */
  statedTotalCents: cents.nullable(),
  note: z.string().trim().max(500),
};
export const invoiceInputSchema = z.object({
  ...invoiceFields,
  purchaseOrderId: invoiceFields.purchaseOrderId.default(null),
  dueDate: invoiceFields.dueDate.default(null),
  currency: invoiceFields.currency.optional(),
  freightCents: invoiceFields.freightCents.default(0),
  statedTotalCents: invoiceFields.statedTotalCents.default(null),
  note: invoiceFields.note.default(""),
});
export type InvoiceInput = z.input<typeof invoiceInputSchema>;
export const invoiceUpdateSchema = z.object(invoiceFields).partial();
export type InvoiceUpdate = z.input<typeof invoiceUpdateSchema>;

export type MatchSeverity = "block" | "warn" | "info";
export type MatchCode =
  | "duplicate"
  | "no_po"
  | "po_not_open"
  | "po_supplier"
  | "currency"
  | "total_differs"
  | "not_on_po"
  | "price_higher"
  | "price_lower"
  | "not_received"
  | "over_billed"
  | "over_ordered";

export interface MatchFlag {
  code: MatchCode;
  severity: MatchSeverity;
  /** 1-based line the flag is about, if it is about one. */
  line: number | null;
  message: string;
}

/** What the order and the receiving dock say about one invoice line. */
export interface MatchLine {
  line: number;
  itemId: string | null;
  /** On the order: quantity, price. Null if the item isn't on it. */
  orderedQuantity: number | null;
  orderedPriceCents: number | null;
  /** Received so far against the order (ledger receipts that haven't been reversed). */
  receivedQuantity: number | null;
  /** Billed on this invoice, and on other invoices for the same order line. */
  invoicedQuantity: number;
  invoicedElsewhere: number;
}

export interface MatchResult {
  /** matched: everything agrees. flagged: something needs a person. no_po: nothing to match against. */
  status: "matched" | "flagged" | "no_po";
  flags: MatchFlag[];
  lines: MatchLine[];
  checkedAt: string;
}

export interface InvoiceLine {
  line: number;
  itemId: string | null;
  itemSku: string | null;
  description: string;
  uom: Uom;
  quantity: number;
  unitPriceCents: number;
  taxCents: number;
  /** quantity x price, before tax. */
  amountCents: number;
}

export interface Invoice {
  id: string;
  /** Ours: INVC-0001. */
  number: string;
  status: InvoiceStatus;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotalCents: number;
  taxCents: number;
  freightCents: number;
  totalCents: number;
  statedTotalCents: number | null;
  note: string;
  match: MatchResult | null;
  paidCents: number;
  balanceCents: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Who OK'd it, and why, if a person had to override flags. */
  approvedBy: string | null;
  approvedAt: string | null;
  overrideReason: string | null;
  /** Why it was voided. */
  voidReason: string | null;
  /** A waiting request for a second person's OK, if the organization's rules want one. */
  approvalNumber: string | null;
  /** Who can do what to it right now, so the screen shows the right buttons. */
  can: { edit: boolean; submit: boolean; approve: boolean; void: boolean; pay: boolean };
}

export interface InvoiceListRow {
  id: string;
  number: string;
  status: InvoiceStatus;
  supplierName: string;
  invoiceNumber: string;
  purchaseOrderNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  totalCents: number;
  balanceCents: number;
  flags: number;
  overdue: boolean;
}

export const invoiceApproveSchema = z.object({
  /** Required when the match found something that blocks: say why it is OK to pay anyway. */
  overrideReason: z.string().trim().max(300).default(""),
});
export type InvoiceApproveInput = z.input<typeof invoiceApproveSchema>;

export const invoiceVoidSchema = z.object({ reason: z.string().trim().min(1, "Say why").max(300) });
export type InvoiceVoidInput = z.input<typeof invoiceVoidSchema>;

// ---------- shipments (advance ship notices) ----------

export const SHIPMENT_STATUSES = ["expected", "partial", "received", "cancelled"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const shipmentLineInputSchema = z.object({
  itemId: id,
  /** In the item's own unit, as the whole number stored. */
  quantity: z.number().int().min(1).max(MAX_QTY),
  /** The supplier's lot or batch, so it arrives with the receipt. */
  supplierLot: z.string().trim().max(64).default(""),
});

export const shipmentInputSchema = z.object({
  supplierId: id,
  purchaseOrderId: id.nullable().default(null),
  /** The supplier's number for it: the ASN or packing slip. Unique per supplier. */
  reference: z.string().trim().min(1, "Enter the supplier's reference").max(64),
  shipDate: date.nullable().default(null),
  expectedDate: date.nullable().default(null),
  carrier: z.string().trim().max(80).default(""),
  tracking: z.string().trim().max(120).default(""),
  lines: z.array(shipmentLineInputSchema).min(1, "Add at least one line").max(200),
  note: z.string().trim().max(500).default(""),
});
export type ShipmentInput = z.input<typeof shipmentInputSchema>;

export interface ShipmentLine {
  itemId: string;
  itemSku: string;
  itemName: string;
  uom: Uom;
  quantity: number;
  supplierLot: string;
  /** Received against this shipment (ledger receipts that haven't been reversed). */
  received: number;
}

export interface Shipment {
  id: string;
  /** Ours: SHP-0001. */
  number: string;
  status: ShipmentStatus;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  reference: string;
  shipDate: string | null;
  expectedDate: string | null;
  carrier: string;
  tracking: string;
  lines: ShipmentLine[];
  note: string;
  createdBy: string;
  createdAt: string;
  /** Anything the supplier said that doesn't match the order (item not on it, more than ordered). */
  warnings: string[];
}

export const shipmentReceiveSchema = z.object({
  locationId: id,
  /** Leave out to receive everything still expected. Otherwise what actually arrived. */
  lines: z.array(z.object({ itemId: id, quantity: z.number().int().min(1).max(MAX_QTY) })).max(200).optional(),
  /** Hold everything for inspection instead of putting it away. */
  inspect: z.boolean().default(false),
});
export type ShipmentReceiveInput = z.input<typeof shipmentReceiveSchema>;

// ---------- payments ----------

export const PAYMENT_METHODS = ["bank_transfer", "check", "card", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  check: "Check",
  card: "Card",
  cash: "Cash",
  other: "Other",
};

export const paymentInputSchema = z.object({
  supplierId: id,
  method: z.enum(PAYMENT_METHODS),
  paidOn: date,
  /** A check number, a bank reference, a card receipt. */
  reference: z.string().trim().max(80).default(""),
  note: z.string().trim().max(300).default(""),
  /** What this payment covers. One payment can pay several invoices of the same supplier. */
  allocations: z.array(z.object({ invoiceId: id, amountCents: z.number().int().min(1).max(100_000_000_000) })).min(1, "Choose an invoice to pay").max(100),
});
export type PaymentInput = z.input<typeof paymentInputSchema>;

export interface Payment {
  id: string;
  /** Ours: PAY-0001. */
  number: string;
  supplierId: string;
  supplierName: string;
  method: PaymentMethod;
  paidOn: string;
  reference: string;
  note: string;
  currency: string;
  amountCents: number;
  allocations: { invoiceId: string; invoiceNumber: string; ourNumber: string; amountCents: number }[];
  createdBy: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export const paymentVoidSchema = z.object({ reason: z.string().trim().min(1, "Say why").max(300) });
export type PaymentVoidInput = z.input<typeof paymentVoidSchema>;

/** What goes to the supplier to say what a payment covered. */
export interface Remittance {
  paymentNumber: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string;
  currency: string;
  from: { name: string };
  to: { name: string };
  lines: { invoiceNumber: string; issueDate: string; invoiceTotalCents: number; amountCents: number }[];
  totalCents: number;
  note: string;
  voided: boolean;
}

// ---------- supplier payment details ----------

/** Where a supplier is paid. Deliberately not a full bank account number: only the last four digits and a description. */
export const supplierPaymentDetailsSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  accountName: z.string().trim().max(120).default(""),
  bankName: z.string().trim().max(120).default(""),
  /** The last four digits of the account, so people can recognise it. Never the whole number. */
  accountLast4: z.string().trim().regex(/^\d{0,4}$/, "Only the last 4 digits").default(""),
  instructions: z
    .string()
    .trim()
    .max(300)
    .refine((s) => !/\d[\d\s-]{7,}\d/.test(s), "Don't put a full account or card number in here. Keep it to the last 4 digits.")
    .default(""),
});
export type SupplierPaymentDetails = z.infer<typeof supplierPaymentDetailsSchema>;
