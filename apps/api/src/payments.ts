import { zValidator } from "@hono/zod-validator";
import { objectIdSchema, paymentInputSchema, paymentVoidSchema, type Payment, type Remittance } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import type { InvoiceDoc, PaymentDoc, Store } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";

const idParam = z.object({ id: objectIdSchema });
const oid = (s: string) => new ObjectId(s);
const money = (c: number) => (c / 100).toFixed(2);

async function present(store: Store, orgId: ObjectId, docs: PaymentDoc[]): Promise<Payment[]> {
  const [suppliers, invoices] = await Promise.all([
    store.suppliers.find({ orgId, _id: { $in: [...new Set(docs.map((d) => d.supplierId.toHexString()))].map(oid) } }, { projection: { name: 1 } }).toArray(),
    store.invoices.find({ orgId, _id: { $in: docs.flatMap((d) => d.allocations.map((a) => a.invoiceId)) } }, { projection: { number: 1, invoiceNumber: 1 } }).toArray(),
  ]);
  const sName = new Map(suppliers.map((s) => [s._id.toHexString(), s.name]));
  const inv = new Map(invoices.map((i) => [i._id.toHexString(), i]));
  return docs.map((d) => ({
    id: d._id.toHexString(), number: d.number, supplierId: d.supplierId.toHexString(), supplierName: sName.get(d.supplierId.toHexString()) ?? "Deleted supplier",
    method: d.method, paidOn: d.paidOn, reference: d.reference, note: d.note, currency: d.currency, amountCents: d.amountCents,
    allocations: d.allocations.map((a) => ({ invoiceId: a.invoiceId.toHexString(), invoiceNumber: inv.get(a.invoiceId.toHexString())?.invoiceNumber ?? "?", ourNumber: inv.get(a.invoiceId.toHexString())?.number ?? "?", amountCents: a.amountCents })),
    createdBy: d.createdBy.name, createdAt: d.createdAt.toISOString(), voidedAt: d.voidedAt?.toISOString() ?? null, voidReason: d.voidReason ?? null,
  }));
}

/**
 * Payment records. Nothing here moves money: a payment says "we paid this supplier this much, this way, on this
 * date, for these invoices". The balance on each invoice is kept in step atomically, so the same invoice can't be
 * paid past what it is for even if two people record payments at once.
 */
export function createPaymentRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  r.use("*", requireRole("admin"));

  r.get("/", async (c) => {
    const org = c.get("org");
    const q = z.object({ supplierId: objectIdSchema.optional(), invoiceId: objectIdSchema.optional() }).parse(c.req.query());
    const filter = { orgId: org._id, ...(q.supplierId ? { supplierId: oid(q.supplierId) } : {}), ...(q.invoiceId ? { "allocations.invoiceId": oid(q.invoiceId) } : {}) };
    const docs = await store.payments.find(filter).sort({ paidOn: -1, createdAt: -1 }).limit(300).toArray();
    return c.json(await present(store, org._id, docs));
  });

  r.get("/:id", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const d = await store.payments.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    return d ? c.json((await present(store, org._id, [d]))[0]) : c.json({ error: "Payment not found" }, 404);
  });

  r.post("/", zValidator("json", paymentInputSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const input = c.req.valid("json");
    if (input.paidOn > new Date().toISOString().slice(0, 10)) return c.json({ error: "A payment record is for money that has been paid, so the date can't be in the future" }, 400);
    const supplier = await store.suppliers.findOne({ _id: oid(input.supplierId), orgId: org._id });
    if (!supplier) return c.json({ error: "Supplier not found" }, 404);
    const ids = input.allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) return c.json({ error: "List each invoice once" }, 400);
    const invoices = await store.invoices.find({ orgId: org._id, _id: { $in: ids.map(oid) } }).toArray();
    if (invoices.length !== ids.length) return c.json({ error: "One of those invoices can't be found" }, 404);
    const byId = new Map(invoices.map((i) => [i._id.toHexString(), i]));
    for (const a of input.allocations) {
      const inv = byId.get(a.invoiceId)!;
      if (!inv.supplierId.equals(supplier._id)) return c.json({ error: `${inv.number} is from a different supplier` }, 400);
      if (inv.status !== "approved") return c.json({ error: `${inv.number} is ${inv.status === "paid" ? "already paid" : inv.status}. Only approved invoices can be paid.` }, 409);
      if (a.amountCents > inv.totalCents - inv.paidCents) return c.json({ error: `${inv.number} only has $${money(inv.totalCents - inv.paidCents)} left to pay` }, 409);
    }
    const currencies = new Set(invoices.map((i) => i.currency));
    if (currencies.size > 1) return c.json({ error: "These invoices are in different currencies. Record a payment for each currency." }, 400);
    const currency = [...currencies][0]!;

    // Take the money off each balance in one guarded step apiece; undo them all if any fails.
    const taken: { id: ObjectId; amount: number }[] = [];
    const undo = () => Promise.all(taken.map((t) => store.invoices.updateOne({ _id: t.id }, { $inc: { paidCents: -t.amount } })));
    for (const a of input.allocations) {
      const res = await store.invoices.findOneAndUpdate(
        { _id: oid(a.invoiceId), orgId: org._id, status: "approved", $expr: { $lte: [{ $add: ["$paidCents", a.amountCents] }, "$totalCents"] } },
        { $inc: { paidCents: a.amountCents }, $set: { updatedAt: new Date() } },
      );
      if (!res) {
        await undo();
        return c.json({ error: `${byId.get(a.invoiceId)!.number} changed while you were paying it. Reload and try again.` }, 409);
      }
      taken.push({ id: oid(a.invoiceId), amount: a.amountCents });
    }
    const doc: PaymentDoc = {
      _id: new ObjectId(), orgId: org._id, number: "", supplierId: supplier._id, method: input.method, paidOn: input.paidOn, reference: input.reference, note: input.note, currency,
      amountCents: input.allocations.reduce((s, a) => s + a.amountCents, 0), allocations: input.allocations.map((a) => ({ invoiceId: oid(a.invoiceId), amountCents: a.amountCents })),
      createdBy: { id: oid(me.id), name: me.name }, createdAt: new Date(),
    };
    try {
      doc.number = await nextNumber(store, org._id, "payment", "PAY-");
      await store.payments.insertOne(doc);
    } catch (e) {
      await undo();
      throw e;
    }
    // Fully paid invoices are done.
    await store.invoices.updateMany({ _id: { $in: ids.map(oid) }, status: "approved", $expr: { $eq: ["$paidCents", "$totalCents"] } }, { $set: { status: "paid", updatedAt: new Date() } });
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "payment.recorded", entity: { type: "payment", id: doc._id.toHexString(), label: doc.number },
      summary: `Recorded ${doc.number}: $${money(doc.amountCents)} ${currency} to ${supplier.name} by ${doc.method.replace("_", " ")}${doc.reference ? ` (${doc.reference})` : ""} for ${invoices.map((i) => i.invoiceNumber).join(", ")}`,
      refs: { paymentId: doc._id.toHexString(), invoiceIds: ids, amountCents: doc.amountCents },
    });
    return c.json((await present(store, org._id, [doc]))[0], 201);
  });

  /** Takes a payment back: the invoices owe it again. The record stays, marked void. */
  r.post("/:id/void", zValidator("param", idParam), zValidator("json", paymentVoidSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const { reason } = c.req.valid("json");
    const doc = await store.payments.findOneAndUpdate(
      { _id: oid(c.req.valid("param").id), orgId: org._id, voidedAt: { $exists: false } },
      { $set: { voidedAt: new Date(), voidedBy: { id: oid(me.id), name: me.name }, voidReason: reason } },
      { returnDocument: "after" },
    );
    if (!doc) return c.json({ error: "Payment not found, or already void" }, 404);
    for (const a of doc.allocations) {
      await store.invoices.updateOne({ _id: a.invoiceId }, { $inc: { paidCents: -a.amountCents }, $set: { updatedAt: new Date() } });
      await store.invoices.updateOne({ _id: a.invoiceId, status: "paid" }, { $set: { status: "approved" } });
    }
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "payment.voided", entity: { type: "payment", id: doc._id.toHexString(), label: doc.number },
      summary: `Voided ${doc.number} ($${money(doc.amountCents)}): ${reason}`, refs: { paymentId: doc._id.toHexString(), invoiceIds: doc.allocations.map((a) => a.invoiceId.toHexString()) },
    });
    return c.json((await present(store, org._id, [doc]))[0]);
  });

  /** What to send the supplier: what was paid, how, and which invoices it covered. */
  r.get("/:id/remittance", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const d = await store.payments.findOne({ _id: oid(c.req.valid("param").id), orgId: org._id });
    if (!d) return c.json({ error: "Payment not found" }, 404);
    const [supplier, invoices] = await Promise.all([
      store.suppliers.findOne({ _id: d.supplierId }, { projection: { name: 1 } }),
      store.invoices.find({ orgId: org._id, _id: { $in: d.allocations.map((a) => a.invoiceId) } }).toArray(),
    ]);
    const inv = new Map<string, InvoiceDoc>(invoices.map((i) => [i._id.toHexString(), i]));
    const remittance: Remittance = {
      paymentNumber: d.number, paidOn: d.paidOn, method: d.method, reference: d.reference, currency: d.currency, from: { name: org.name }, to: { name: supplier?.name ?? "Supplier" },
      lines: d.allocations.map((a) => { const i = inv.get(a.invoiceId.toHexString()); return { invoiceNumber: i?.invoiceNumber ?? "?", issueDate: i?.issueDate ?? "", invoiceTotalCents: i?.totalCents ?? 0, amountCents: a.amountCents }; }),
      totalCents: d.amountCents, note: d.note, voided: !!d.voidedAt,
    };
    return c.json(remittance);
  });

  return r;
}
