import { invoiceUploadSchema, type CaptureConfidence, type CapturedFile, type CapturedInvoice, type CapturedLine, type InvoiceMatchPreview } from "@invintel/shared";
import { createHash } from "node:crypto";
import { Binary, ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { onInbound, registerBridge, storeInbound, type Bridge, type Failure } from "./b2b-core.js";
import type { B2BMessageDoc, CapturedInvoiceDoc, Store, TradingPartnerDoc } from "./db.js";
import { toOrders } from "./purchasing.js";
import { setupOf } from "./x12-bridge.js";
import { readX12 } from "./x12-maps.js";
import { X12_CONTENT_TYPE } from "./x12.js";

// INV-12: invoice capture. An invoice arrives (email forwarded by a mail service, a file uploaded at the desk) and is read
// as far as it can be read safely: structured files (UBL XML, JSON) are read exactly; free text is searched for the
// obvious fields and every such find is marked "guess"; PDFs and other files are kept untouched for a person to read
// (there is no OCR here). Nothing is paid or posted: the result is a CAPTURED INVOICE for a person to check.
// We never read or store bank details from a document: changing where money goes must not be one click away.

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_TEXT = 100_000;

type Fields = {
  invoiceNumber: string; invoiceDate: string | null; dueDate: string | null; poNumber: string; totalCents: number | null; taxCents: number; currency: string; lines: CapturedLine[];
  confidence: CapturedInvoiceDoc["confidence"];
};
const missing = (): CapturedInvoiceDoc["confidence"] => ({ invoiceNumber: "missing", invoiceDate: "missing", dueDate: "missing", poNumber: "missing", totalCents: "missing" });

// ---------- reading money and dates exactly ----------

/** "$1,234.50", "1.234,50" is NOT guessed: only the US/ISO style with a dot is read. Returns cents or null. No floating point. */
export function moneyToCents(text: string): number | null {
  const raw = text.trim().replace(/^[$€£]\s?/, "");
  // Commas must be thousands separators (1,234.50). "1.234,50" would read as 1.23 if we were careless, so it is refused.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(raw)) return null;
  const t = raw.replace(/,/g, "");
  if (!/^\d{1,12}(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  return Number.isSafeInteger(cents) ? cents + roundUp : null;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** ISO dates and "Oct 18, 2026" / "18 Oct 2026". Day-first numeric dates like 03/04/2026 are ambiguous and are NOT read. */
export function readDate(text: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const named = /\b([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})\b/.exec(text) ?? null;
  const named2 = /\b(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})\b/.exec(text) ?? null;
  let y: string, m: string, d: string;
  if (iso) { y = iso[1]!; m = iso[2]!; d = iso[3]!; }
  else if (named && MONTHS[named[1]!.toLowerCase()]) { y = named[3]!; m = MONTHS[named[1]!.toLowerCase()]!; d = named[2]!.padStart(2, "0"); }
  else if (named2 && MONTHS[named2[2]!.toLowerCase()]) { y = named2[3]!; m = MONTHS[named2[2]!.toLowerCase()]!; d = named2[1]!.padStart(2, "0"); }
  else return null;
  const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() + 1 === Number(m) && dt.getUTCDate() === Number(d) ? `${y}-${m}-${d}` : null;
}

// ---------- structured: UBL XML and JSON ----------

const xmlText = (xml: string, tag: string) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]{1,200})</${tag}>`).exec(xml);
  return m ? m[1]!.trim() : null;
};
const xmlAttr = (xml: string, tag: string, attr: string) => new RegExp(`<${tag}\\s[^>]*${attr}="([^"]{1,20})"`).exec(xml)?.[1] ?? null;
const xmlBlock = (xml: string, tag: string) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;

/** Reads the main fields of a UBL 2.x invoice. XML with a DOCTYPE or entities is refused (they are how XML bombs and file reads are done). */
export function parseUbl(xml: string): Fields | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:\w+:)?Invoice[\s>]/.test(xml)) return null;
  const x = xml.replace(/<(\/?)(\w+):/g, "<$1$2:"); // keep prefixes as written
  const number = xmlText(x, "cbc:ID");
  const issue = xmlText(x, "cbc:IssueDate");
  const due = xmlText(x, "cbc:DueDate");
  const orderRef = xmlBlock(x, "cac:OrderReference");
  const po = orderRef ? xmlText(orderRef, "cbc:ID") : null;
  const totals = xmlBlock(x, "cac:LegalMonetaryTotal") ?? "";
  const payable = xmlText(totals, "cbc:PayableAmount");
  const taxTotal = xmlBlock(x, "cac:TaxTotal");
  const tax = taxTotal ? xmlText(taxTotal, "cbc:TaxAmount") : null;
  const lines: CapturedLine[] = [];
  for (const m of x.matchAll(/<cac:InvoiceLine(?:\s[^>]*)?>([\s\S]*?)<\/cac:InvoiceLine>/g)) {
    const b = m[1]!;
    const qty = xmlText(b, "cbc:InvoicedQuantity") ?? "1";
    const ext = moneyToCents(xmlText(b, "cbc:LineExtensionAmount") ?? "") ?? 0;
    const price = moneyToCents(xmlText(xmlBlock(b, "cac:Price") ?? "", "cbc:PriceAmount") ?? "") ?? 0;
    lines.push({ description: (xmlText(xmlBlock(b, "cac:Item") ?? "", "cbc:Name") ?? "").slice(0, 200), quantity: /^\d+(\.\d+)?$/.test(qty) ? qty : "1", unitPriceCents: price, lineTotalCents: ext });
    if (lines.length >= 200) break;
  }
  const date = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const f: Fields = {
    invoiceNumber: (number ?? "").slice(0, 64), invoiceDate: date(issue), dueDate: date(due), poNumber: (po ?? "").slice(0, 40), totalCents: payable ? moneyToCents(payable) : null,
    taxCents: tax ? (moneyToCents(tax) ?? 0) : 0, currency: (xmlText(x, "cbc:DocumentCurrencyCode") ?? xmlAttr(totals, "cbc:PayableAmount", "currencyID") ?? "USD").slice(0, 3).toUpperCase(), lines,
    confidence: missing(),
  };
  const sure = (v: unknown): CaptureConfidence => (v ? "read" : "missing");
  f.confidence = { invoiceNumber: sure(f.invoiceNumber), invoiceDate: sure(f.invoiceDate), dueDate: sure(f.dueDate), poNumber: sure(f.poNumber), totalCents: f.totalCents === null ? "missing" : "read" };
  return f;
}

const jsonInvoice = z.object({
  invoiceNumber: z.string().max(64),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  poNumber: z.string().max(40).optional(),
  currency: z.string().length(3).optional(),
  total: z.union([z.string(), z.number()]).optional(),
  totalCents: z.number().int().optional(),
  taxCents: z.number().int().min(0).optional(),
  lines: z.array(z.object({ description: z.string().max(200).default(""), quantity: z.union([z.string(), z.number()]).default("1"), unitPrice: z.union([z.string(), z.number()]).optional(), unitPriceCents: z.number().int().optional() })).max(200).optional(),
});

export function parseJsonInvoice(text: string): Fields | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const p = jsonInvoice.safeParse(raw);
  if (!p.success) return null;
  const j = p.data;
  const total = j.totalCents ?? (j.total !== undefined ? moneyToCents(String(j.total)) : null);
  const lines: CapturedLine[] = (j.lines ?? []).map((l) => {
    const q = String(l.quantity);
    const unit = l.unitPriceCents ?? (l.unitPrice !== undefined ? (moneyToCents(String(l.unitPrice)) ?? 0) : 0);
    return { description: l.description, quantity: /^\d+(\.\d+)?$/.test(q) ? q : "1", unitPriceCents: unit, lineTotalCents: Math.round(Number(/^\d+(\.\d+)?$/.test(q) ? q : "1") * unit) };
  });
  const date = j.issueDate ?? j.invoiceDate ?? null;
  return {
    invoiceNumber: j.invoiceNumber, invoiceDate: date, dueDate: j.dueDate ?? null, poNumber: j.poNumber ?? "", totalCents: total, taxCents: j.taxCents ?? 0, currency: (j.currency ?? "USD").toUpperCase(), lines,
    confidence: { invoiceNumber: j.invoiceNumber ? "read" : "missing", invoiceDate: date ? "read" : "missing", dueDate: j.dueDate ? "read" : "missing", poNumber: j.poNumber ? "read" : "missing", totalCents: total === null ? "missing" : "read" },
  };
}

// ---------- free text: search, and say it is a guess ----------

export function readFromText(subject: string, body: string): Fields {
  const text = `${subject}\n${body}`.slice(0, MAX_TEXT);
  const inv = /\binvoice\s*(?:no\.?|number|#|nr\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i.exec(text);
  // an "invoice" followed by an ordinary word (e.g. "invoice for") is not a number: require a digit
  const invoiceNumber = inv && /\d/.test(inv[1]!) ? inv[1]!.toUpperCase() : "";
  const ours = /\bPO-?(\d{1,10})\b/i.exec(text);
  const generic = ours ? null : /\bpurchase\s+order\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{1,20})/i.exec(text);
  const po = ours ? `PO-${ours[1]!.padStart(4, "0")}` : generic ? generic[1]!.toUpperCase() : "";
  const total = /\b(?:total(?:\s+due)?|amount\s+due|balance\s+due)\s*[:\-]?\s*(?:USD\s*)?([$€£]?\s?[\d,]+\.\d{2})/i.exec(text);
  const dueIdx = text.search(/\bdue(?:\s+date)?\b/i);
  const due = dueIdx >= 0 ? readDate(text.slice(dueIdx, dueIdx + 60)) : null;
  const dateIdx = text.search(/\b(?:invoice\s+date|date\s+of\s+invoice|issued|dated)\b/i);
  const issued = dateIdx >= 0 ? readDate(text.slice(dateIdx, dateIdx + 60)) : null;
  const guess = (v: unknown): CaptureConfidence => (v ? "guess" : "missing");
  const totalCents = total ? moneyToCents(total[1]!) : null;
  return {
    invoiceNumber, invoiceDate: issued, dueDate: due, poNumber: po, totalCents, taxCents: 0, currency: "USD", lines: [],
    confidence: { invoiceNumber: guess(invoiceNumber), invoiceDate: guess(issued), dueDate: guess(due), poNumber: guess(po), totalCents: totalCents === null ? "missing" : "guess" },
  };
}

// ---------- the email bridge for incoming invoices ----------

const emailInSchema = z.object({
  from: z.string().max(300).default(""),
  subject: z.string().max(300).default(""),
  text: z.string().max(MAX_TEXT).default(""),
  messageId: z.string().max(200).optional(),
  attachments: z.array(z.object({ filename: z.string().max(120), contentType: z.string().max(100), contentBase64: z.string().max(7_000_000) })).max(MAX_FILES).default([]),
});

/**
 * Receives invoices that a mail service (an inbound-parse webhook) or a person posts as JSON:
 * { from, subject, text, attachments: [{ filename, contentType, contentBase64 }] }. The request must carry the secret the
 * partner is set up with: partner setting `secretEnv` names the environment variable that holds it (never the secret itself),
 * and the request sends it as `x-invintel-secret` or `Authorization: Bearer ...`.
 */
export const invoiceInboxBridge: Bridge = {
  id: "invoice-inbox",
  carries: ["invoice"],
  async send() { return { ok: false, error: "The invoice inbox only receives", retryable: false }; },
  async verifyInbound(req, partner) {
    const envName = partner.bridgeConfig.secretEnv;
    const secret = envName ? process.env[envName] : undefined;
    if (!secret) return { ok: false, error: "This partner has no secret set up" };
    const given = req.headers["x-invintel-secret"] ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = createHash("sha256").update(given ?? "").digest();
    const b = createHash("sha256").update(secret).digest();
    if (!(a.length === b.length && a.every((x, i) => x === b[i]))) return { ok: false, error: "Bad secret" };
    let parsed: z.infer<typeof emailInSchema>;
    try { parsed = emailInSchema.parse(JSON.parse(req.body)); } catch { return { ok: false, error: "Not a valid invoice email" }; }
    const key = parsed.messageId ?? createHash("sha256").update(req.body).digest("hex");
    return { ok: true, docType: "invoice", body: req.body, idempotencyKey: `mail:${key}`, correlation: {} };
  },
};
registerBridge(invoiceInboxBridge);

// ---------- capturing ----------

interface Parsed { from: string; subject: string; text: string; files: { filename: string; contentType: string; data: Buffer }[] }

function filesOf(p: z.infer<typeof emailInSchema>): Parsed["files"] {
  const out: Parsed["files"] = [];
  for (const a of p.attachments) {
    const data = Buffer.from(a.contentBase64, "base64");
    if (!data.length || data.length > MAX_FILE_BYTES) continue;
    out.push({ filename: a.filename.replace(/[\r\n"\\\/]/g, "_").slice(0, 120) || "attachment", contentType: a.contentType.replace(/[\r\n;]/g, "").slice(0, 100) || "application/octet-stream", data });
  }
  return out;
}

/** Reads an invoice document: the structured attachment if there is one, else the email text. */
export function extract(p: Parsed): { fields: Fields; source: CapturedInvoice["source"] } {
  for (const f of p.files) {
    const head = f.data.subarray(0, 200).toString("utf8");
    if (/xml/i.test(f.contentType) || /\.xml$/i.test(f.filename) || head.trimStart().startsWith("<")) {
      const u = parseUbl(f.data.toString("utf8"));
      if (u) return { fields: u, source: "ubl" };
    }
    if (/json/i.test(f.contentType) || /\.json$/i.test(f.filename)) {
      const j = parseJsonInvoice(f.data.toString("utf8"));
      if (j) return { fields: j, source: "json" };
    }
  }
  return { fields: readFromText(p.subject, p.text), source: "email" };
}

async function keepFiles(store: Store, orgId: ObjectId, messageId: ObjectId, files: Parsed["files"]): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  for (const f of files) {
    const _id = new ObjectId();
    await store.b2bFiles.insertOne({ _id, orgId, messageId, filename: f.filename, contentType: f.contentType, data: new Binary(f.data), bytes: f.data.length, hash: createHash("sha256").update(f.data).digest("hex"), createdAt: new Date() });
    ids.push(_id);
  }
  return ids;
}

/** An 810 that arrived over the X12 bridge: every field is read exactly from the document, so nothing is marked as a guess. */
async function captureX12Invoice(ctx: { store: Store; orgId: ObjectId; partner: TradingPartnerDoc; message: B2BMessageDoc }) {
  const { store, orgId, partner, message } = ctx;
  const s = setupOf(partner);
  const r = readX12(message.raw.body, s.ok ? { uomMap: s.setup.uomMap } : undefined);
  if (!r.ok || r.doc.kind !== "invoice") return;
  const inv = r.doc.doc;
  const now = new Date();
  const doc: CapturedInvoiceDoc = {
    _id: new ObjectId(), orgId, status: "captured", partnerId: partner._id, messageId: message._id, source: "x12", from: partner.name.slice(0, 300), subject: `X12 810 ${r.interchange.control}`,
    invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, poNumber: inv.poNumber, totalCents: inv.totalCents, taxCents: inv.taxCents, currency: inv.currency,
    lines: inv.lines.map((l) => ({ description: l.name || l.sku, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents })),
    confidence: { invoiceNumber: "read", invoiceDate: "read", dueDate: inv.dueDate ? "read" : "missing", poNumber: inv.poNumber ? "read" : "missing", totalCents: "read" }, fileIds: [], note: "", createdAt: now, updatedAt: now,
  };
  await store.capturedInvoices.insertOne(doc);
  await recordAudit(store, {
    orgId, actor: { id: null, name: partner.name }, action: "b2b.invoice_captured", entity: { type: "captured_invoice", id: doc._id.toHexString(), label: doc.invoiceNumber },
    summary: `Captured an invoice from ${partner.name} (${doc.invoiceNumber}): read from an X12 810`, snapshot: { source: "x12", confidence: doc.confidence, mode: partner.mode },
  });
}

export async function captureInvoice(ctx: { store: Store; orgId: ObjectId; partner: TradingPartnerDoc; message: B2BMessageDoc }) {
  const { store, orgId, partner, message } = ctx;
  if (message.raw.contentType === X12_CONTENT_TYPE) return captureX12Invoice(ctx);
  let parsed: z.infer<typeof emailInSchema>;
  try { parsed = emailInSchema.parse(JSON.parse(message.raw.body)); } catch { return; }
  const files = filesOf(parsed);
  const { fields, source } = extract({ from: parsed.from, subject: parsed.subject, text: parsed.text, files });
  const fileIds = await keepFiles(store, orgId, message._id, files);
  const now = new Date();
  const doc: CapturedInvoiceDoc = {
    _id: new ObjectId(), orgId, status: "captured", partnerId: partner._id, messageId: message._id, source, from: parsed.from.slice(0, 300), subject: parsed.subject.slice(0, 300),
    invoiceNumber: fields.invoiceNumber, invoiceDate: fields.invoiceDate, dueDate: fields.dueDate, poNumber: fields.poNumber, totalCents: fields.totalCents, taxCents: fields.taxCents,
    currency: fields.currency, lines: fields.lines, confidence: fields.confidence, fileIds, note: "", createdAt: now, updatedAt: now,
  };
  await store.capturedInvoices.insertOne(doc);
  await recordAudit(store, {
    orgId, actor: { id: null, name: partner.name }, action: "b2b.invoice_captured", entity: { type: "captured_invoice", id: doc._id.toHexString(), label: doc.invoiceNumber || "(no number found)" },
    summary: `Captured an invoice from ${partner.name}${doc.invoiceNumber ? ` (${doc.invoiceNumber})` : ""}: read as ${source}, ${files.length} file${files.length === 1 ? "" : "s"}`,
    snapshot: { source, confidence: doc.confidence, files: files.map((f) => f.filename) },
  });
}
onInbound("invoice", captureInvoice);

/** An invoice file uploaded by a person at the desk is stored as an inbound document from the chosen partner, then captured like any other. */
export async function uploadInvoice(store: Store, orgId: ObjectId, actorName: string, input: z.infer<typeof invoiceUploadSchema>): Promise<{ ok: true; id: string } | Failure> {
  const partner = await store.tradingPartners.findOne({ _id: new ObjectId(input.partnerId), orgId });
  if (!partner) return { ok: false, status: 404, error: "Trading partner not found" };
  const data = Buffer.from(input.contentBase64, "base64");
  if (!data.length) return { ok: false, status: 422, error: "That file is empty" };
  if (data.length > MAX_FILE_BYTES) return { ok: false, status: 422, error: "That file is too big (5 MB at most)" };
  const body = JSON.stringify({ from: actorName, subject: input.filename, text: input.note, attachments: [{ filename: input.filename, contentType: input.contentType, contentBase64: input.contentBase64 }] });
  const hash = createHash("sha256").update(data).digest("hex");
  const stored = await storeInbound(store, orgId, partner, { docType: "invoice", body, contentType: "application/json", idempotencyKey: `upload:${hash}`, fromName: `${actorName} (upload)` });
  if (!stored.ok) return stored;
  if (stored.duplicate) return { ok: false, status: 409, error: "That exact file was already uploaded" };
  const c = await store.capturedInvoices.findOne({ orgId, messageId: stored.message._id });
  return c ? { ok: true, id: c._id.toHexString() } : { ok: false, status: 422, error: "The file was stored but could not be read as an invoice" };
}

// ---------- the view of a captured invoice ----------

const norm = (s: string) => s.trim().toUpperCase();

export async function presentCaptured(store: Store, orgId: ObjectId, docs: CapturedInvoiceDoc[]): Promise<CapturedInvoice[]> {
  const partners = await store.tradingPartners.find({ orgId, _id: { $in: [...new Set(docs.map((d) => d.partnerId.toHexString()))].map((x) => new ObjectId(x)) } }, { projection: { name: 1 } }).toArray();
  const pname = new Map(partners.map((p) => [p._id.toHexString(), p.name]));
  const files = await store.b2bFiles.find({ orgId, _id: { $in: docs.flatMap((d) => d.fileIds) } }, { projection: { filename: 1, contentType: 1, bytes: 1 } }).toArray();
  const fileById = new Map(files.map((f) => [f._id.toHexString(), f]));
  const out: CapturedInvoice[] = [];
  for (const d of docs) {
    const match: InvoiceMatchPreview = { order: null, differenceCents: null, duplicateOf: null, notes: [] };
    if (d.poNumber) {
      const po = await store.purchaseOrders.findOne({ orgId, number: norm(d.poNumber) });
      if (po) {
        const [o] = await toOrders(store, [po]);
        match.order = { id: po._id.toHexString(), number: po.number, supplierName: o!.supplierName, totalCents: o!.totalCents };
        if (d.totalCents !== null) {
          match.differenceCents = d.totalCents - o!.totalCents;
          match.notes.push(match.differenceCents === 0 ? "The total matches the order." : `The total is ${match.differenceCents > 0 ? "above" : "below"} the order by $${(Math.abs(match.differenceCents) / 100).toFixed(2)}.`);
        }
        if (o!.receivedUnits === 0) match.notes.push("Nothing has been received on that order yet.");
      } else match.notes.push(`No order called ${d.poNumber} was found.`);
    } else match.notes.push("No order number was found on the invoice.");
    if (d.invoiceNumber) {
      const dup = await store.capturedInvoices.findOne({ orgId, partnerId: d.partnerId, _id: { $ne: d._id }, status: { $ne: "discarded" }, invoiceNumber: { $regex: `^${d.invoiceNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
      if (dup) { match.duplicateOf = dup._id.toHexString(); match.notes.push("An invoice with this number from the same supplier was already captured."); }
    }
    out.push({
      id: d._id.toHexString(), status: d.status, partnerId: d.partnerId.toHexString(), partnerName: pname.get(d.partnerId.toHexString()) ?? "Deleted partner", source: d.source, messageId: d.messageId.toHexString(),
      from: d.from, subject: d.subject, invoiceNumber: d.invoiceNumber, invoiceDate: d.invoiceDate, dueDate: d.dueDate, poNumber: d.poNumber, totalCents: d.totalCents, taxCents: d.taxCents, currency: d.currency,
      lines: d.lines, confidence: d.confidence, files: d.fileIds.flatMap((id): CapturedFile[] => { const f = fileById.get(id.toHexString()); return f ? [{ id: id.toHexString(), filename: f.filename, contentType: f.contentType, bytes: f.bytes }] : []; }),
      note: d.note, match, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
    });
  }
  return out;
}

export { auditActor };
