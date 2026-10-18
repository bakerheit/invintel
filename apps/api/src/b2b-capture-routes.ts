import { zValidator } from "@hono/zod-validator";
import { CAPTURE_STATUSES, capturedInvoiceUpdateSchema, invoiceUploadSchema, objectIdSchema, parseQty, uomOf, type CapturedInvoice } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import type { CapturedInvoiceDoc, Store } from "./db.js";
import { presentCaptured, uploadInvoice } from "./invoice-capture.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);

/**
 * What we would hand to supplier-invoice entry: the captured fields shaped for creating an invoice. Lines that name an
 * item on the matched order become stock lines (quantity in the item's own stored units); the rest become one-unit lines
 * for the amount printed. Nothing is created here: a person still checks and approves the invoice itself.
 */
export async function invoiceInputFor(store: Store, orgId: ObjectId, d: CapturedInvoiceDoc) {
  const partner = await store.tradingPartners.findOne({ _id: d.partnerId, orgId });
  const po = d.poNumber ? await store.purchaseOrders.findOne({ orgId, number: d.poNumber.trim().toUpperCase() }) : null;
  const items = po ? await store.items.find({ _id: { $in: po.lines.map((l) => l.itemId) } }).toArray() : [];
  const lines = d.lines.map((l) => {
    const hay = l.description.toLowerCase();
    const item = items.find((i) => hay.includes(i.sku.toLowerCase()) || (i.name.length > 3 && hay.includes(i.name.toLowerCase())));
    if (item) {
      const q = parseQty(l.quantity, uomOf(item).decimals);
      if (q.ok && q.stored > 0) return { itemId: item._id.toHexString(), description: l.description, quantity: q.stored, unitPriceCents: l.unitPriceCents, taxCents: 0 };
    }
    return { itemId: null, description: l.description || "Invoice line", quantity: 1, unitPriceCents: l.lineTotalCents, taxCents: 0 };
  });
  return {
    supplierId: partner?.supplierId?.toHexString() ?? null,
    purchaseOrderId: po?._id.toHexString() ?? null,
    invoiceNumber: d.invoiceNumber,
    issueDate: d.invoiceDate,
    dueDate: d.dueDate,
    currency: d.currency,
    lines,
    freightCents: 0,
    statedTotalCents: d.totalCents,
    note: `Captured from ${d.source} (${d.from || "unknown sender"})`.slice(0, 500),
  };
}

export function createCaptureRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  const list = z.object({ status: z.enum([...CAPTURE_STATUSES, "all"]).default("captured"), limit: z.coerce.number().int().min(1).max(200).default(100) });

  r.get("/", zValidator("query", list), async (c) => {
    const orgId = c.get("org")._id;
    const q = c.req.valid("query");
    const docs = await store.capturedInvoices.find({ orgId, ...(q.status === "all" ? {} : { status: q.status }) }).sort({ createdAt: -1 }).limit(q.limit).toArray();
    return c.json(await presentCaptured(store, orgId, docs));
  });

  r.post("/upload", zValidator("json", invoiceUploadSchema), async (c) => {
    const orgId = c.get("org")._id;
    const res = await uploadInvoice(store, orgId, c.get("user").name, c.req.valid("json"));
    if (!res.ok) return c.json({ error: res.error }, res.status);
    const doc = (await store.capturedInvoices.findOne({ _id: oid(res.id) }))!;
    return c.json((await presentCaptured(store, orgId, [doc]))[0], 201);
  });

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.capturedInvoices.findOne({ _id: oid(c.req.valid("param").id), orgId });
    return doc ? c.json((await presentCaptured(store, orgId, [doc]))[0]) : c.json({ error: "Not found" }, 404);
  });

  /** Correct what was read. Everything sent is marked as entered by a person. */
  r.patch("/:id", zValidator("param", idParam), zValidator("json", capturedInvoiceUpdateSchema), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.capturedInvoices.findOne({ _id: oid(c.req.valid("param").id), orgId });
    if (!doc) return c.json({ error: "Not found" }, 404);
    if (doc.status !== "captured") return c.json({ error: `A ${doc.status} invoice can't be edited` }, 409);
    const p = c.req.valid("json");
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    const changed: string[] = [];
    const confidence = { ...doc.confidence };
    for (const k of ["invoiceNumber", "invoiceDate", "dueDate", "poNumber", "totalCents"] as const) {
      if (p[k] !== undefined && p[k] !== doc[k]) { $set[k] = p[k]; confidence[k] = "entered"; changed.push(k); }
    }
    for (const k of ["taxCents", "currency", "note"] as const) if (p[k] !== undefined && p[k] !== doc[k]) { $set[k] = k === "currency" ? (p[k] as string).toUpperCase() : p[k]; changed.push(k); }
    if (p.lines) { $set.lines = p.lines.map((l) => ({ description: l.description ?? "", quantity: l.quantity ?? "1", unitPriceCents: l.unitPriceCents ?? 0, lineTotalCents: l.lineTotalCents ?? 0 })); changed.push("lines"); }
    $set.confidence = confidence;
    const res = await store.capturedInvoices.findOneAndUpdate({ _id: doc._id, status: "captured" }, { $set }, { returnDocument: "after" });
    if (!res) return c.json({ error: "Someone else just changed this" }, 409);
    if (changed.length) {
      await recordAudit(store, {
        orgId, actor: auditActor(c.get("user")), action: "b2b.invoice_edited", entity: { type: "captured_invoice", id: doc._id.toHexString(), label: res.invoiceNumber || "(no number)" },
        summary: `Corrected ${changed.join(", ")} on a captured invoice`, changes: changed.filter((f) => f !== "lines" && f !== "note").map((f) => ({ field: f, from: (doc as never)[f], to: (res as never)[f] })),
      });
    }
    return c.json((await presentCaptured(store, orgId, [res]))[0]);
  });

  r.post("/:id/discard", requireRole("admin"), zValidator("param", idParam), zValidator("json", z.object({ note: z.string().trim().max(300).default("") })), async (c) => {
    const orgId = c.get("org")._id;
    const res = await store.capturedInvoices.findOneAndUpdate(
      { _id: oid(c.req.valid("param").id), orgId, status: "captured" },
      { $set: { status: "discarded", updatedAt: new Date(), ...(c.req.valid("json").note ? { note: c.req.valid("json").note } : {}) } },
      { returnDocument: "after" },
    );
    if (!res) return c.json({ error: "Only a captured invoice can be discarded" }, 409);
    await recordAudit(store, {
      orgId, actor: auditActor(c.get("user")), action: "b2b.invoice_discarded", entity: { type: "captured_invoice", id: res._id.toHexString(), label: res.invoiceNumber || "(no number)" },
      summary: `Discarded a captured invoice${res.invoiceNumber ? ` (${res.invoiceNumber})` : ""}${c.req.valid("json").note ? `: ${c.req.valid("json").note}` : ""}`,
    });
    return c.json((await presentCaptured(store, orgId, [res]))[0]);
  });

  /** What supplier-invoice entry would be given. Read only. */
  r.get("/:id/invoice-input", zValidator("param", idParam), async (c) => {
    const orgId = c.get("org")._id;
    const doc = await store.capturedInvoices.findOne({ _id: oid(c.req.valid("param").id), orgId });
    return doc ? c.json(await invoiceInputFor(store, orgId, doc)) : c.json({ error: "Not found" }, 404);
  });

  /** For whatever creates the real invoice: record that it did. */
  r.post("/:id/converted", requireRole("admin"), zValidator("param", idParam), zValidator("json", z.object({ invoiceId: objectIdSchema })), async (c) => {
    const orgId = c.get("org")._id;
    const res = await store.capturedInvoices.findOneAndUpdate({ _id: oid(c.req.valid("param").id), orgId, status: "captured" }, { $set: { status: "converted", updatedAt: new Date(), note: `Became invoice ${c.req.valid("json").invoiceId}` } }, { returnDocument: "after" });
    if (!res) return c.json({ error: "Only a captured invoice can be converted" }, 409);
    return c.json((await presentCaptured(store, orgId, [res]))[0]);
  });

  return r;
}

/** Download an attachment. Always as a file, never rendered in the page. */
export function createFileRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  r.get("/:id", zValidator("param", idParam), async (c) => {
    const f = await store.b2bFiles.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id });
    if (!f) return c.json({ error: "Not found" }, 404);
    c.header("content-type", "application/octet-stream");
    c.header("content-disposition", `attachment; filename="${f.filename.replace(/[^\w.\- ]/g, "_")}"`);
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(f.data.buffer));
  });
  return r;
}

export type { CapturedInvoice };
