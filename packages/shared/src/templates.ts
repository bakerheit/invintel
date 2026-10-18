import { z } from "zod";

// INV-17: document templates. Every document we produce (purchase order, sales order confirmation, packing slip, invoice) is drawn from
// the organization's letterhead (company) and a template for that kind of document, optionally adjusted for one trading partner.
// No template language and no code: a small set of settings, so a template can never do anything but change how a document looks.

export const DOC_KINDS = ["purchase_order", "sales_order", "packing_slip", "invoice"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const docKindSchema = z.enum(DOC_KINDS);

export const DOC_LABELS: Record<DocKind, string> = {
  purchase_order: "Purchase order", sales_order: "Sales order confirmation", packing_slip: "Packing slip", invoice: "Invoice",
};

/** Columns a document can show, in the order they are drawn. The first column that is switched on takes whatever width is left. */
export const DOC_COLUMNS: Record<DocKind, { key: string; label: string }[]> = {
  purchase_order: [{ key: "sku", label: "Part number" }, { key: "description", label: "Description" }, { key: "quantity", label: "Quantity" }, { key: "unitPrice", label: "Unit price" }, { key: "amount", label: "Amount" }],
  sales_order: [{ key: "sku", label: "Part number" }, { key: "description", label: "Description" }, { key: "quantity", label: "Quantity" }, { key: "unitPrice", label: "Unit price" }, { key: "amount", label: "Amount" }],
  packing_slip: [{ key: "sku", label: "Part number" }, { key: "description", label: "Description" }, { key: "ordered", label: "Ordered" }, { key: "shipped", label: "Shipped now" }, { key: "toDate", label: "Shipped to date" }],
  invoice: [{ key: "sku", label: "Part number" }, { key: "description", label: "Description" }, { key: "quantity", label: "Quantity" }, { key: "unitPrice", label: "Unit price" }, { key: "amount", label: "Amount" }],
};

export const ACCENTS = [
  { name: "Slate", hex: "#334155" }, { name: "Blue", hex: "#1d4ed8" }, { name: "Green", hex: "#15803d" },
  { name: "Red", hex: "#b91c1c" }, { name: "Orange", hex: "#c2410c" }, { name: "Purple", hex: "#6d28d9" },
] as const;

const line = (max: number) => z.string().trim().max(max);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1d4ed8");

/** The letterhead: who the documents come from. Used by every document. */
export const companyProfileSchema = z.object({
  /** Leave empty to use the organization's name. */
  name: line(100).default(""),
  addressLines: z.array(line(80)).max(5).default([]),
  phone: line(40).default(""),
  email: line(120).default(""),
  website: line(120).default(""),
  /** A tax or registration number, printed under the address. */
  taxId: line(60).default(""),
  paper: z.enum(["a4", "letter"]).default("a4"),
  /** Invoices: the tax added to what shipped, in hundredths of a percent (825 = 8.25%), and how many days a customer has to pay. */
  taxLabel: line(20).default("Tax"),
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export const DEFAULT_COMPANY: CompanyProfile = companyProfileSchema.parse({});

export const docTemplateSchema = z.object({
  /** The big word at the top. Empty: the kind's own ("PURCHASE ORDER"). */
  title: line(40).default(""),
  accent: hex.default("#334155"),
  showLogo: z.boolean().default(true),
  columns: z.array(z.string().max(20)).max(8),
  /** Terms and conditions (or payment terms) printed after the lines. */
  terms: line(800).default(""),
  /** A line at the bottom of every page. */
  footer: line(300).default(""),
});
export type DocTemplate = z.infer<typeof docTemplateSchema>;

/** What a trading partner can change for their own documents: the same fields, all optional. */
export const docTemplateOverrideSchema = docTemplateSchema.partial();
export type DocTemplateOverride = z.infer<typeof docTemplateOverrideSchema>;

export const DEFAULT_TITLES: Record<DocKind, string> = { purchase_order: "PURCHASE ORDER", sales_order: "ORDER CONFIRMATION", packing_slip: "PACKING SLIP", invoice: "INVOICE" };

export const defaultTemplate = (kind: DocKind): DocTemplate => ({
  title: "", accent: "#334155", showLogo: true, columns: DOC_COLUMNS[kind].map((c) => c.key), terms: "", footer: "",
});

/** Keeps only columns this kind has, in their fixed order; at least one is always on. */
export function cleanColumns(kind: DocKind, cols: string[] | undefined): string[] {
  const all = DOC_COLUMNS[kind].map((c) => c.key);
  const picked = all.filter((k) => cols?.includes(k));
  return picked.length ? picked : all;
}

/** The template in force for a document: the kind's defaults, then the organization's, then the trading partner's. */
export function resolveTemplate(kind: DocKind, org?: Partial<DocTemplate> | null, partner?: DocTemplateOverride | null): DocTemplate {
  const merged = { ...defaultTemplate(kind), ...strip(org), ...strip(partner) };
  return { ...merged, columns: cleanColumns(kind, merged.columns) };
}
const strip = <T extends object>(o?: T | null): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

export const documentSettingsUpdateSchema = z.object({ company: companyProfileSchema.optional(), templates: z.partialRecord(docKindSchema, docTemplateSchema).optional() });

/** What the Settings screen reads and the preview draws from. */
export interface DocumentSettings {
  company: CompanyProfile;
  /** The organization's own name, used when the company name is empty. */
  orgName: string;
  templates: Record<DocKind, DocTemplate>;
  logo: { width: number; height: number; contentType: string; bytes: number } | null;
}

export const logoUploadSchema = z.object({
  contentBase64: z.string().min(1).max(500_000),
});
export type LogoUpload = z.infer<typeof logoUploadSchema>;

export const docPreviewSchema = z.object({
  kind: docKindSchema,
  company: companyProfileSchema.optional(),
  template: docTemplateSchema.optional(),
  /** Preview as this trading partner's override would change it. */
  override: docTemplateOverrideSchema.optional(),
});
export type DocPreview = z.input<typeof docPreviewSchema>;

// ---------- documents we send to a customer (carried by the email bridge, drawn with the templates above) ----------

/** The order confirmation: what we promise a customer, with prices. */
export const canonicalSalesConfirmationSchema = z.object({
  kind: z.literal("sales_confirmation"),
  version: z.literal(1),
  number: z.string().min(1).max(40),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  customerName: z.string().max(200),
  customerRef: z.string().max(80).default(""),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  note: z.string().max(1000).default(""),
  currency: z.string().length(3).default("USD"),
  lines: z
    .array(z.object({ lineNo: z.number().int().min(1), sku: z.string().max(64), name: z.string().max(200), quantity: z.string().regex(/^\d+(\.\d+)?$/), unit: z.string().max(16), unitPriceCents: z.number().int().min(0), lineTotalCents: z.number().int().min(0) }))
    .min(1)
    .max(100),
  totalCents: z.number().int().min(0),
  shipper: z.string().max(100).default(""),
});
export type CanonicalSalesConfirmation = z.infer<typeof canonicalSalesConfirmationSchema>;
