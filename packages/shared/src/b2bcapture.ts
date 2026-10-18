import { z } from "zod";

// Invoice capture: an invoice arrives from a supplier (by email, as an upload, as a structured file) and becomes a
// CAPTURED INVOICE: what we could read from it, how sure we are of each field, the original file, and a first look
// at how it lines up with our purchase order. A person checks and corrects it; it never becomes a payable by itself.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** "read" = taken from structured data; "guess" = found in free text, check it; "entered" = typed or corrected by a person; "missing" = not found. */
export type CaptureConfidence = "read" | "guess" | "entered" | "missing";
export const CAPTURE_FIELDS = ["invoiceNumber", "invoiceDate", "dueDate", "poNumber", "totalCents"] as const;
export type CaptureField = (typeof CAPTURE_FIELDS)[number];

export const CAPTURE_STATUSES = ["captured", "converted", "discarded"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export const capturedLineSchema = z.object({
  description: z.string().trim().max(200).default(""),
  /** Decimal text as written ("12.5"). */
  quantity: z.string().trim().regex(/^\d+(\.\d+)?$/).default("1"),
  unitPriceCents: z.number().int().min(0).max(100_000_000_00).default(0),
  lineTotalCents: z.number().int().min(0).max(100_000_000_00).default(0),
});
export type CapturedLine = z.infer<typeof capturedLineSchema>;

/** What a person may correct. Anything sent is marked "entered". */
export const capturedInvoiceUpdateSchema = z
  .object({
    invoiceNumber: z.string().trim().max(64),
    invoiceDate: date.nullable(),
    dueDate: date.nullable(),
    poNumber: z.string().trim().max(40),
    totalCents: z.number().int().min(0).max(100_000_000_00).nullable(),
    taxCents: z.number().int().min(0).max(100_000_000_00),
    currency: z.string().trim().length(3),
    note: z.string().trim().max(500),
    lines: z.array(capturedLineSchema).max(200),
  })
  .partial();
export type CapturedInvoiceUpdate = z.input<typeof capturedInvoiceUpdateSchema>;

/** A file someone sends us as an invoice (an upload from the desk). The content is base64. */
export const invoiceUploadSchema = z.object({
  partnerId: z.string().regex(/^[0-9a-f]{24}$/i),
  filename: z.string().trim().min(1).max(120),
  contentType: z.string().trim().min(1).max(100),
  contentBase64: z.string().min(1).max(7_000_000),
  note: z.string().trim().max(500).default(""),
});
export type InvoiceUpload = z.input<typeof invoiceUploadSchema>;

export interface CapturedFile {
  id: string;
  filename: string;
  contentType: string;
  bytes: number;
}

export interface InvoiceMatchPreview {
  /** What the purchase order says, when the order number found one of ours. */
  order: { id: string; number: string; supplierName: string; totalCents: number } | null;
  /** invoice total minus order total (cents), or null when either is missing. */
  differenceCents: number | null;
  /** The same supplier invoice number already captured earlier. */
  duplicateOf: string | null;
  /** Plain words for the person checking it. */
  notes: string[];
}

export interface CapturedInvoice {
  id: string;
  status: CaptureStatus;
  partnerId: string;
  partnerName: string;
  source: "email" | "upload" | "json" | "ubl" | "x12";
  messageId: string;
  from: string;
  subject: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  dueDate: string | null;
  poNumber: string;
  totalCents: number | null;
  taxCents: number;
  currency: string;
  lines: CapturedLine[];
  confidence: Record<CaptureField, CaptureConfidence>;
  files: CapturedFile[];
  note: string;
  match: InvoiceMatchPreview;
  createdAt: string;
  updatedAt: string;
}
