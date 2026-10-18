import { zValidator } from "@hono/zod-validator";
import {
  DEFAULT_INVOICE_SETTINGS,
  formatQty,
  invoiceApproveSchema,
  invoiceInputSchema,
  invoiceSettingsSchema,
  invoiceUpdateSchema,
  invoiceVoidSchema,
  lineValueCents,
  objectIdSchema,
  supplierPaymentDetailsSchema,
  uomOf,
  type ApprovalRequired,
  type Invoice,
  type InvoiceListRow,
  type InvoiceStatus,
  type OrgRole,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { createApproval, isSoleApprover, ruleFor, toApproval } from "./approvals-core.js";
import { auditActor, diffFields, recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import { csvText } from "./csv.js";
import type { InvoiceDoc, InvoiceLineDoc, ItemDoc, OrgDoc, Store, SupplierDoc } from "./db.js";
import { blocks, matchInvoice, needsReview, settingsOf, totalsOf } from "./invoice-match.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const supplierParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);
const keyOf = (n: string) => n.trim().toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);
const money = (c: number) => (c / 100).toFixed(2);

export const invoiceEntity = (d: Pick<InvoiceDoc, "_id" | "number">) => ({ type: "invoice" as const, id: d._id.toHexString(), label: d.number });

interface Context {
  org: OrgDoc;
  role: OrgRole;
  user: { id: string; name: string };
}

async function lookups(store: Store, orgId: ObjectId, docs: InvoiceDoc[]) {
  const itemIds = [...new Set(docs.flatMap((d) => d.lines.flatMap((l) => (l.itemId ? [l.itemId.toHexString()] : []))))];
  const [items, suppliers, orders, approvals] = await Promise.all([
    store.items.find({ orgId, _id: { $in: itemIds.map(oid) } }).toArray(),
    store.suppliers.find({ orgId, _id: { $in: [...new Set(docs.map((d) => d.supplierId.toHexString()))].map(oid) } }).toArray(),
    store.purchaseOrders.find({ orgId, _id: { $in: docs.flatMap((d) => (d.purchaseOrderId ? [d.purchaseOrderId] : [])) } }, { projection: { number: 1 } }).toArray(),
    store.approvals.find({ orgId, _id: { $in: docs.flatMap((d) => (d.approvalId ? [d.approvalId] : [])) } }, { projection: { number: 1, status: 1 } }).toArray(),
  ]);
  return {
    items: new Map(items.map((i) => [i._id.toHexString(), i])),
    suppliers: new Map(suppliers.map((s) => [s._id.toHexString(), s])),
    orders: new Map(orders.map((o) => [o._id.toHexString(), o])),
    approvals: new Map(approvals.map((a) => [a._id.toHexString(), a])),
  };
}

const isOverdue = (d: Pick<InvoiceDoc, "status" | "dueDate" | "totalCents" | "paidCents">) => (d.status === "approved" || d.status === "review") && !!d.dueDate && d.dueDate < today() && d.paidCents < d.totalCents;

function toRow(d: InvoiceDoc, lk: Awaited<ReturnType<typeof lookups>>): InvoiceListRow {
  return {
    id: d._id.toHexString(), number: d.number, status: d.status, supplierName: lk.suppliers.get(d.supplierId.toHexString())?.name ?? "Deleted supplier",
    invoiceNumber: d.invoiceNumber, purchaseOrderNumber: d.purchaseOrderId ? (lk.orders.get(d.purchaseOrderId.toHexString())?.number ?? null) : null,
    issueDate: d.issueDate, dueDate: d.dueDate, currency: d.currency, totalCents: d.totalCents, balanceCents: d.status === "void" ? 0 : d.totalCents - d.paidCents,
    flags: d.match?.flags.filter((f) => f.severity !== "info").length ?? 0, overdue: isOverdue(d),
  };
}

/** The whole invoice for a screen. While it is still being worked on the match is re-run live, so it reflects receipts made since. */
export async function presentInvoice(store: Store, ctx: Context, d: InvoiceDoc): Promise<Invoice> {
  const lk = await lookups(store, ctx.org._id, [d]);
  const live = d.status === "draft" || d.status === "review";
  const match = live ? await matchInvoice(store, ctx.org, d, d._id) : (d.match ?? null);
  const admin = ctx.role !== "member";
  const open = d.status === "draft" || d.status === "review";
  const lines = d.lines.map((l, i) => {
    const item = l.itemId ? lk.items.get(l.itemId.toHexString()) : undefined;
    return {
      line: i + 1, itemId: l.itemId?.toHexString() ?? null, itemSku: item?.sku ?? null, description: l.description || item?.name || "", uom: uomOf(item),
      quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxCents: l.taxCents, amountCents: lineValueCents(l.quantity, l.unitPriceCents, item?.decimals ?? 0),
    };
  });
  return {
    id: d._id.toHexString(), number: d.number, status: d.status, supplierId: d.supplierId.toHexString(),
    supplierName: lk.suppliers.get(d.supplierId.toHexString())?.name ?? "Deleted supplier",
    purchaseOrderId: d.purchaseOrderId?.toHexString() ?? null, purchaseOrderNumber: d.purchaseOrderId ? (lk.orders.get(d.purchaseOrderId.toHexString())?.number ?? null) : null,
    invoiceNumber: d.invoiceNumber, issueDate: d.issueDate, dueDate: d.dueDate, currency: d.currency, lines,
    subtotalCents: d.subtotalCents, taxCents: d.taxCents, freightCents: d.freightCents, totalCents: d.totalCents, statedTotalCents: d.statedTotalCents, note: d.note,
    match, paidCents: d.paidCents, balanceCents: d.status === "void" ? 0 : d.totalCents - d.paidCents,
    createdBy: d.createdBy.name, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
    approvedBy: d.approvedBy?.name ?? null, approvedAt: d.approvedAt?.toISOString() ?? null, overrideReason: d.overrideReason ?? null, voidReason: d.voidReason ?? null,
    approvalNumber: d.approvalId && lk.approvals.get(d.approvalId.toHexString())?.status === "pending" ? (lk.approvals.get(d.approvalId.toHexString())?.number ?? null) : null,
    can: {
      edit: admin && open, submit: admin && d.status === "draft", approve: admin && d.status === "review",
      void: admin && d.status !== "void" && d.status !== "paid" && d.paidCents === 0, pay: admin && d.status === "approved" && d.totalCents - d.paidCents > 0,
    },
  };
}

/** Cancels a request for a second person's OK that is still waiting, e.g. because the invoice changed or was voided. */
async function dropApproval(store: Store, d: InvoiceDoc) {
  if (d.approvalId) await store.approvals.updateOne({ _id: d.approvalId, status: "pending" }, { $set: { status: "cancelled", decidedAt: new Date() } });
}

/**
 * Marks an invoice approved (ready to pay). Used when an admin approves it directly, and when a second person
 * approves the request an organization's rules asked for. It re-checks the match so an invoice that changed in
 * the meantime can't be approved on stale information.
 */
export async function approveInvoiceDirect(
  store: Store, org: OrgDoc, invoiceId: ObjectId, approver: { id: string; name: string }, overrideReason: string, via: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = await store.invoices.findOne({ _id: invoiceId, orgId: org._id });
  if (!d) return { ok: false, error: "The invoice can't be found" };
  if (d.status !== "review") return { ok: false, error: `The invoice is ${d.status}, not waiting for approval` };
  const match = await matchInvoice(store, org, d, d._id);
  if (blocks(match) && !overrideReason) return { ok: false, error: "The invoice has problems and no reason was given for paying it anyway" };
  const claimed = await store.invoices.findOneAndUpdate(
    { _id: d._id, status: "review" },
    { $set: { status: "approved", match, approvedBy: { id: oid(approver.id), name: approver.name }, approvedAt: new Date(), updatedAt: new Date(), ...(overrideReason ? { overrideReason } : {}) }, $unset: { approvalId: "" } },
  );
  if (!claimed) return { ok: false, error: "Someone else just changed this invoice" };
  await recordAudit(store, {
    orgId: org._id, actor: auditActor(approver), action: "invoice.approved", entity: invoiceEntity(d),
    summary: `Approved ${d.number} (${d.invoiceNumber})${via ? ` ${via}` : ""}${overrideReason ? `, overriding ${match.flags.filter((f) => f.severity === "block").length} problem(s): ${overrideReason}` : ""}`,
    refs: { invoiceId: d._id.toHexString(), flags: match.flags.map((f) => f.code), totalCents: d.totalCents },
  });
  return { ok: true };
}

/** Applies a supplier's new payment details. Used directly, and when a second person approves the request. */
export async function applyPaymentDetails(
  store: Store, orgId: ObjectId, supplierId: ObjectId, details: NonNullable<SupplierDoc["paymentDetails"]>, who: { id: string; name: string }, via: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const before = await store.suppliers.findOneAndUpdate({ _id: supplierId, orgId }, { $set: { paymentDetails: details } });
  if (!before) return { ok: false, error: "The supplier can't be found" };
  const was = before.paymentDetails ?? null;
  await recordAudit(store, {
    orgId, actor: auditActor(who), action: "supplier.payment_details_changed", entity: { type: "supplier", id: supplierId.toHexString(), label: before.name },
    summary: `${was ? "Changed" : "Set"} how ${before.name} is paid${via ? ` ${via}` : ""}: ${details.method.replace("_", " ")}${details.accountLast4 ? `, account ending ${details.accountLast4}` : ""}`,
    changes: diffFields({ ...(was ?? {}) } as Record<string, unknown>, details as unknown as Record<string, unknown>),
  });
  return { ok: true };
}

export function createInvoiceRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  const ctx = (c: { get: (k: "org" | "role" | "user") => any }): Context => ({ org: c.get("org"), role: c.get("role"), user: c.get("user") });

  // ---------------- matching rules ----------------

  r.get("/settings", (c) => c.json(settingsOf(c.get("org"))));

  r.put("/settings", requireRole("admin"), zValidator("json", invoiceSettingsSchema), async (c) => {
    const org = c.get("org");
    const next = c.req.valid("json");
    const was = settingsOf(org);
    await store.orgs.updateOne({ _id: org._id }, { $set: { invoiceSettings: next } });
    const changes = diffFields(was as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    if (changes.length) {
      await recordAudit(store, {
        orgId: org._id, actor: auditActor(c.get("user")), action: "invoice.settings_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
        summary: `Changed invoice matching rules: ${changes.map((x) => `${x.field} ${String(x.from)} to ${String(x.to)}`).join(", ")}`, changes,
      });
    }
    return c.json(next);
  });

  // ---------------- how a supplier is paid ----------------

  r.get("/suppliers/:id/payment-details", zValidator("param", supplierParam), async (c) => {
    const s = await store.suppliers.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id }, { projection: { paymentDetails: 1 } });
    if (!s) return c.json({ error: "Supplier not found" }, 404);
    return c.json(s.paymentDetails ?? null);
  });

  /** Changing where money goes is the classic invoice-fraud route, so an organization can require a second person's OK. */
  r.put("/suppliers/:id/payment-details", requireRole("admin"), zValidator("param", supplierParam), zValidator("json", supplierPaymentDetailsSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const _id = oid(c.req.valid("param").id);
    const details = c.req.valid("json");
    const supplier = await store.suppliers.findOne({ _id, orgId: org._id });
    if (!supplier) return c.json({ error: "Supplier not found" }, 404);
    if (JSON.stringify(supplier.paymentDetails ?? null) === JSON.stringify(details)) return c.json(details);
    const rule = ruleFor(org, "supplier_payment_details", 0, c.get("role"));
    if (rule) {
      const doc = await createApproval(store, org._id, { ...me, role: c.get("role") }, {
        kind: "supplier_payment_details", valueCents: 0, payload: { supplierId: _id, paymentDetails: details },
        summary: `Change how ${supplier.name} is paid to ${details.method.replace("_", " ")}${details.accountLast4 ? `, account ending ${details.accountLast4}` : ""}`,
        subject: { type: "supplier", id: _id.toHexString(), label: supplier.name },
      });
      const body: ApprovalRequired = { approvalRequired: true, approval: toApproval(doc, { id: me.id, role: c.get("role") }, await isSoleApprover(store, org._id)) };
      return c.json(body, 202);
    }
    const res = await applyPaymentDetails(store, org._id, _id, details, me, "");
    if (!res.ok) return c.json({ error: res.error }, 404);
    return c.json(details);
  });

  // ---------------- exports ----------------

  /** One row per invoice line, plus a freight row, for importing as bills into an accounting system. */
  r.get("/export/bills.csv", requireRole("admin"), async (c) => {
    const org = c.get("org");
    const docs = await store.invoices.find({ orgId: org._id, status: { $in: ["approved", "paid"] } }).sort({ issueDate: 1, number: 1 }).toArray();
    const lk = await lookups(store, org._id, docs);
    const lines = ["bill_no,our_ref,vendor,bill_date,due_date,currency,po_number,status,line,sku,description,quantity,unit,unit_price,amount,tax"];
    for (const d of docs) {
      const head = [csvText(d.invoiceNumber), d.number, csvText(lk.suppliers.get(d.supplierId.toHexString())?.name ?? ""), d.issueDate, d.dueDate ?? "", d.currency, d.purchaseOrderId ? csvText(lk.orders.get(d.purchaseOrderId.toHexString())?.number ?? "") : "", d.status];
      d.lines.forEach((l, i) => {
        const item = l.itemId ? lk.items.get(l.itemId.toHexString()) : undefined;
        const uom = uomOf(item);
        lines.push([...head, String(i + 1), csvText(item?.sku ?? ""), csvText(l.description || item?.name || ""), formatQty(l.quantity, uom, { unit: false, group: false }), csvText(uom.unit), money(l.unitPriceCents), money(lineValueCents(l.quantity, l.unitPriceCents, uom.decimals)), money(l.taxCents)].join(","));
      });
      if (d.freightCents) lines.push([...head, String(d.lines.length + 1), "", "Freight", "1", "ea", money(d.freightCents), money(d.freightCents), "0.00"].join(","));
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="invintel-bills-${today()}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${lines.join("\r\n")}\r\n`);
  });

  r.get("/export/payments.csv", requireRole("admin"), async (c) => {
    const org = c.get("org");
    const docs = await store.payments.find({ orgId: org._id }).sort({ paidOn: 1, number: 1 }).toArray();
    const suppliers = new Map((await store.suppliers.find({ orgId: org._id }, { projection: { name: 1 } }).toArray()).map((s) => [s._id.toHexString(), s.name]));
    const invoices = new Map((await store.invoices.find({ orgId: org._id }, { projection: { invoiceNumber: 1 } }).toArray()).map((i) => [i._id.toHexString(), i.invoiceNumber]));
    const lines = ["payment_no,paid_on,vendor,method,reference,currency,amount,applied_to,status,note"];
    for (const p of docs) {
      lines.push([
        p.number, p.paidOn, csvText(suppliers.get(p.supplierId.toHexString()) ?? ""), p.method, csvText(p.reference), p.currency, money(p.amountCents),
        csvText(p.allocations.map((a) => `${invoices.get(a.invoiceId.toHexString()) ?? "?"}:${money(a.amountCents)}`).join("; ")), p.voidedAt ? "void" : "paid", csvText(p.note),
      ].join(","));
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="invintel-payments-${today()}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${lines.join("\r\n")}\r\n`);
  });

  // ---------------- invoices ----------------

  const listQuery = z.object({
    status: z.enum(["draft", "review", "approved", "paid", "void", "open"]).optional(),
    supplierId: objectIdSchema.optional(),
    q: z.string().trim().max(80).optional(),
  });

  r.get("/", requireRole("admin"), zValidator("query", listQuery), async (c) => {
    const org = c.get("org");
    const q = c.req.valid("query");
    const filter: Record<string, unknown> = { orgId: org._id };
    if (q.status === "open") filter.status = { $in: ["draft", "review", "approved"] };
    else if (q.status) filter.status = q.status;
    if (q.supplierId) filter.supplierId = oid(q.supplierId);
    if (q.q) filter.$or = [{ invoiceNumber: { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { number: { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }];
    const docs = await store.invoices.find(filter).sort({ createdAt: -1 }).limit(300).toArray();
    const lk = await lookups(store, org._id, docs);
    return c.json(docs.map((d) => toRow(d, lk)));
  });

  /** Checks the pieces of an invoice that must belong to this organization, and works out its totals. */
  async function build(c: { get: (k: "org") => OrgDoc }, input: z.output<typeof invoiceInputSchema>) {
    const org = c.get("org");
    if (!(await store.suppliers.findOne({ _id: oid(input.supplierId), orgId: org._id }, { projection: { _id: 1 } }))) return { error: "Supplier not found", status: 404 as const };
    if (input.purchaseOrderId && !(await store.purchaseOrders.findOne({ _id: oid(input.purchaseOrderId), orgId: org._id }, { projection: { _id: 1 } }))) return { error: "Purchase order not found", status: 404 as const };
    const itemIds = [...new Set(input.lines.flatMap((l) => (l.itemId ? [l.itemId] : [])))];
    const items = new Map((await store.items.find({ orgId: org._id, _id: { $in: itemIds.map(oid) } }).toArray()).map((i) => [i._id.toHexString(), i]));
    if (items.size !== itemIds.length) return { error: "One of those items isn't in this organization", status: 404 as const };
    const lines: InvoiceLineDoc[] = input.lines.map((l) => ({ itemId: l.itemId ? oid(l.itemId) : null, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxCents: l.taxCents }));
    const totals = totalsOf(lines, input.freightCents, items);
    return { lines, totals, items };
  }

  r.post("/", requireRole("admin"), zValidator("json", invoiceInputSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const input = c.req.valid("json");
    const built = await build(c, input);
    if ("error" in built) return c.json({ error: built.error }, built.status);
    const now = new Date();
    const doc: InvoiceDoc = {
      _id: new ObjectId(), orgId: org._id, number: await nextNumber(store, org._id, "invoice", "INVC-"), status: "draft", supplierId: oid(input.supplierId),
      purchaseOrderId: input.purchaseOrderId ? oid(input.purchaseOrderId) : null, invoiceNumber: input.invoiceNumber, invoiceKey: keyOf(input.invoiceNumber),
      issueDate: input.issueDate, dueDate: input.dueDate, currency: input.currency ?? settingsOf(org).currency, lines: built.lines, ...built.totals,
      freightCents: input.freightCents, statedTotalCents: input.statedTotalCents, note: input.note, paidCents: 0,
      createdBy: { id: oid(me.id), name: me.name }, createdAt: now, updatedAt: now,
    };
    await store.invoices.insertOne(doc);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "invoice.created", entity: invoiceEntity(doc),
      summary: `Entered ${doc.number}: ${doc.invoiceNumber} for $${money(doc.totalCents)}`, refs: { invoiceId: doc._id.toHexString(), supplierId: doc.supplierId.toHexString() },
    });
    return c.json(await presentInvoice(store, ctx(c), doc), 201);
  });

  r.get("/:id", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const d = await store.invoices.findOne({ _id: oid(c.req.valid("param").id), orgId: c.get("org")._id });
    return d ? c.json(await presentInvoice(store, ctx(c), d)) : c.json({ error: "Invoice not found" }, 404);
  });

  /** Editing sends it back to draft: whatever was matched or approved no longer describes it. */
  r.patch("/:id", requireRole("admin"), zValidator("param", idParam), zValidator("json", invoiceUpdateSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const before = await store.invoices.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!before) return c.json({ error: "Invoice not found" }, 404);
    if (before.status !== "draft" && before.status !== "review") return c.json({ error: `This invoice is ${before.status}, so it can't be edited. Void it and enter it again.` }, 409);
    const patch = c.req.valid("json");
    const merged = invoiceInputSchema.safeParse({
      supplierId: before.supplierId.toHexString(), purchaseOrderId: before.purchaseOrderId?.toHexString() ?? null, invoiceNumber: before.invoiceNumber, issueDate: before.issueDate,
      dueDate: before.dueDate, currency: before.currency, freightCents: before.freightCents, statedTotalCents: before.statedTotalCents, note: before.note,
      lines: before.lines.map((l) => ({ itemId: l.itemId?.toHexString() ?? null, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxCents: l.taxCents })),
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    });
    if (!merged.success) return c.json({ error: merged.error.issues[0]?.message ?? "Invalid invoice" }, 400);
    const built = await build(c, merged.data);
    if ("error" in built) return c.json({ error: built.error }, built.status);
    const input = merged.data;
    await dropApproval(store, before);
    const set: Partial<InvoiceDoc> = {
      status: "draft", supplierId: oid(input.supplierId), purchaseOrderId: input.purchaseOrderId ? oid(input.purchaseOrderId) : null, invoiceNumber: input.invoiceNumber,
      invoiceKey: keyOf(input.invoiceNumber), issueDate: input.issueDate, dueDate: input.dueDate, currency: input.currency ?? before.currency, lines: built.lines, ...built.totals,
      freightCents: input.freightCents, statedTotalCents: input.statedTotalCents, note: input.note, updatedAt: new Date(),
    };
    await store.invoices.updateOne({ _id: before._id }, { $set: set, $unset: { match: "", approvalId: "", approvedBy: "", approvedAt: "", overrideReason: "" } });
    const after = (await store.invoices.findOne({ _id: before._id }))!;
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "invoice.updated", entity: invoiceEntity(after),
      summary: `Edited ${after.number}${before.totalCents !== after.totalCents ? `: total $${money(before.totalCents)} to $${money(after.totalCents)}` : ""}`,
      changes: diffFields({ invoiceNumber: before.invoiceNumber, issueDate: before.issueDate, dueDate: before.dueDate ?? "", totalCents: before.totalCents, note: before.note }, { invoiceNumber: after.invoiceNumber, issueDate: after.issueDate, dueDate: after.dueDate ?? "", totalCents: after.totalCents, note: after.note }),
    });
    return c.json(await presentInvoice(store, ctx(c), after));
  });

  /** Matches it. A clean match is ready to pay (unless the organization wants a second person's OK); anything else waits for a person. */
  r.post("/:id/submit", requireRole("admin"), zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const d = await store.invoices.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!d) return c.json({ error: "Invoice not found" }, 404);
    if (d.status !== "draft") return c.json({ error: `This invoice is already ${d.status}` }, 409);
    const match = await matchInvoice(store, org, d, d._id);
    const claimed = await store.invoices.findOneAndUpdate({ _id: d._id, status: "draft" }, { $set: { status: "review", match, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!claimed) return c.json({ error: "Someone else just changed this invoice" }, 409);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "invoice.submitted", entity: invoiceEntity(d),
      summary: `Matched ${d.number}: ${needsReview(match) ? `${match.flags.filter((f) => f.severity !== "info").length} thing(s) need a person` : "everything agrees with the order and what arrived"}`,
      refs: { invoiceId: d._id.toHexString(), flags: match.flags.map((f) => f.code) },
    });
    if (!needsReview(match)) {
      const rule = ruleFor(org, "invoice", d.totalCents, c.get("role"));
      if (rule) return requestApproval(c, claimed, "");
      const res = await approveInvoiceDirect(store, org, d._id, me, "", "(clean match)");
      if (!res.ok) return c.json({ error: res.error }, 409);
    }
    return c.json(await presentInvoice(store, ctx(c), (await store.invoices.findOne({ _id: d._id }))!));
  });

  async function requestApproval(c: { get: (k: "org" | "role" | "user") => any; json: (b: unknown, s?: any) => Response }, d: InvoiceDoc, overrideReason: string) {
    const org: OrgDoc = c.get("org");
    const me = c.get("user");
    if (d.approvalId && (await store.approvals.findOne({ _id: d.approvalId, status: "pending" }, { projection: { _id: 1 } }))) {
      return c.json({ error: "This invoice is already waiting for a second person's OK" }, 409);
    }
    const supplier = await store.suppliers.findOne({ _id: d.supplierId }, { projection: { name: 1 } });
    const approval = await createApproval(store, org._id, { ...me, role: c.get("role") }, {
      kind: "invoice", valueCents: d.totalCents, payload: { invoiceId: d._id, ...(overrideReason ? { overrideReason } : {}) },
      summary: `Pay ${supplier?.name ?? "a supplier"} invoice ${d.invoiceNumber} (${d.number}) for $${money(d.totalCents)}${overrideReason ? `, overriding problems: ${overrideReason}` : ""}`,
      subject: { type: "invoice", id: d._id.toHexString(), label: `${d.number} (${d.invoiceNumber})` },
    });
    await store.invoices.updateOne({ _id: d._id }, { $set: { approvalId: approval._id, updatedAt: new Date() } });
    const body: ApprovalRequired = { approvalRequired: true, approval: toApproval(approval, { id: me.id, role: c.get("role") }, await isSoleApprover(store, org._id)) };
    return c.json(body, 202);
  }

  r.post("/:id/approve", requireRole("admin"), zValidator("param", idParam), zValidator("json", invoiceApproveSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const d = await store.invoices.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!d) return c.json({ error: "Invoice not found" }, 404);
    if (d.status !== "review") return c.json({ error: d.status === "draft" ? "Match the invoice first" : `This invoice is already ${d.status}` }, 409);
    const { overrideReason } = c.req.valid("json");
    const match = await matchInvoice(store, org, d, d._id);
    if (blocks(match) && !overrideReason) return c.json({ error: "This invoice has problems. Say why it is fine to pay it anyway.", match }, 400);
    // Overriding a problem on an invoice you entered yourself needs someone else, unless you are the only approver.
    if (blocks(match) && d.createdBy.id.toHexString() === me.id && !(await isSoleApprover(store, org._id))) {
      return c.json({ error: "Someone else has to override the problems on an invoice you entered" }, 403);
    }
    if (ruleFor(org, "invoice", d.totalCents, c.get("role"))) return requestApproval(c, d, overrideReason);
    const res = await approveInvoiceDirect(store, org, d._id, me, overrideReason, "");
    if (!res.ok) return c.json({ error: res.error }, 409);
    return c.json(await presentInvoice(store, ctx(c), (await store.invoices.findOne({ _id: d._id }))!));
  });

  r.post("/:id/void", requireRole("admin"), zValidator("param", idParam), zValidator("json", invoiceVoidSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const d = await store.invoices.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!d) return c.json({ error: "Invoice not found" }, 404);
    if (d.status === "void") return c.json({ error: "Already void" }, 409);
    const { reason } = c.req.valid("json");
    // Only if nothing has been paid against it: a payment has to be voided first.
    const claimed = await store.invoices.findOneAndUpdate({ _id: d._id, status: { $in: ["draft", "review", "approved"] }, paidCents: 0 }, { $set: { status: "void", voidReason: reason, updatedAt: new Date() }, $unset: { approvalId: "" } }, { returnDocument: "after" });
    if (!claimed) return c.json({ error: "Something has been paid against this invoice. Void that payment first." }, 409);
    await dropApproval(store, d);
    await recordAudit(store, { orgId: org._id, actor: auditActor(me), action: "invoice.voided", entity: invoiceEntity(d), summary: `Voided ${d.number} (${d.invoiceNumber}): ${reason}`, refs: { invoiceId: d._id.toHexString() } });
    return c.json(await presentInvoice(store, ctx(c), claimed));
  });

  void DEFAULT_INVOICE_SETTINGS;
  return r;
}

export type { InvoiceStatus, ItemDoc };
