import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email: `pb${++n}@example.com`, password: "correct horse", organization }),
  });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization as { id: string; joinCode: string } };
}
function client(cookie: string, orgId: string) {
  const base = `/api/orgs/${orgId}`;
  const raw = (path: string, body?: unknown, method?: string) =>
    app.request(`${base}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (path: string, body?: unknown, method?: string) => {
    const res = await raw(path, body, method);
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  return { raw, json };
}

/**
 * Paper Mill sells us KRAFT (each, ordered 100 at $2.00) and RESIN (kg, 3 decimals, ordered 25.000 kg at $1.20/kg).
 * The order is placed and 60 KRAFT and 10.000 kg RESIN have arrived. A second admin (Bob) and a member (Cy) exist.
 */
async function world() {
  const owner = await signUp({ mode: "create", name: "Box Co" });
  const a = client(owner.cookie, owner.org.id);
  const bob = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const cy = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Cy");
  await store.memberships.updateOne({ orgId: new ObjectId(owner.org.id), userId: (await store.users.findOne({ email: { $regex: "pb" }, name: "Bob" }, { sort: { _id: -1 } }))!._id }, { $set: { role: "admin" } });
  const B = client(bob.cookie, owner.org.id);
  const C = client(cy.cookie, owner.org.id);
  const dock = (await a.json("/locations")).body[0].id as string;
  const id = async (path: string, body: unknown) => (await a.json(path, body)).body.id as string;
  const supplier = await id("/purchasing/suppliers", { name: "Paper Mill" });
  const other = await id("/purchasing/suppliers", { name: "Other Co" });
  const kraft = await id("/items", { sku: "KRAFT", name: "Kraft paper", unitCostCents: 200 });
  const resin = await id("/items", { sku: "RESIN", name: "PET resin", unit: "kg", decimals: 3, unitCostCents: 120 });
  const nut = await id("/items", { sku: "NUT", name: "Nut" });
  const po = (await a.json("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: kraft, quantity: 100, unitCostCents: 200 }, { itemId: resin, quantity: 25000, unitCostCents: 120 }, { itemId: nut, quantity: 50, unitCostCents: 10 }] })).body;
  await a.json(`/purchasing/orders/${po.id}/place`, {});
  await a.json(`/purchasing/orders/${po.id}/receive`, { locationId: dock, lines: [{ itemId: kraft, quantity: 60 }, { itemId: resin, quantity: 10000 }] });
  const orgId = owner.org.id;
  const invoice = (over: object = {}) => ({
    supplierId: supplier, purchaseOrderId: po.id as string, invoiceNumber: `SI-${++n}`, issueDate: "2026-10-01", dueDate: "2026-10-31",
    lines: [{ itemId: kraft, quantity: 60, unitPriceCents: 200 }, { itemId: resin, quantity: 10000, unitPriceCents: 120 }], ...over,
  });
  const make = async (over: object = {}) => (await a.json("/invoices", invoice(over))).body;
  return { a, B, C, orgId, dock, supplier, other, kraft, resin, nut, po, invoice, make };
}
const flagCodes = (m: { flags: { code: string; severity: string }[] }) => m.flags.map((f) => f.code).sort();

describe("supplier invoices", () => {
  it("work their own totals out from the lines, in each item's own unit", async () => {
    const w = await world();
    const res = await w.a.json("/invoices", { ...w.invoice({ freightCents: 500 }), totalCents: 1, subtotalCents: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: "INVC-0001", status: "draft", currency: "USD", subtotalCents: 13200, taxCents: 0, freightCents: 500, totalCents: 13700, paidCents: 0, balanceCents: 13700 });
    expect(res.body.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([12000, 1200]); // 60 x $2.00, 10.000 kg x $1.20
    expect(res.body.lines[1]).toMatchObject({ itemSku: "RESIN", uom: { unit: "kg", decimals: 3 } });
    const taxed = await w.a.json("/invoices", w.invoice({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 200, taxCents: 960 }] }));
    expect(taxed.body).toMatchObject({ subtotalCents: 12000, taxCents: 960, totalCents: 12960 });
  });

  it("are for admins, belong to one organization, and refuse bad input", async () => {
    const w = await world();
    const inv = await w.make();
    expect((await w.C.json("/invoices")).status).toBe(403);
    expect((await w.C.json("/invoices", w.invoice())).status).toBe(403);
    expect((await w.C.json(`/invoices/${inv.id}`)).status).toBe(403);
    const other = await world();
    expect((await other.a.json(`/invoices/${inv.id}`)).status).toBe(404);
    expect((await other.a.json(`/invoices/${inv.id}/submit`, {})).status).toBe(404);
    expect((await w.a.json("/invoices", w.invoice({ supplierId: other.supplier }))).status).toBe(404);
    expect((await w.a.json("/invoices", w.invoice({ purchaseOrderId: other.po.id }))).status).toBe(404);
    expect((await w.a.json("/invoices", w.invoice({ lines: [{ itemId: other.kraft, quantity: 1, unitPriceCents: 1 }] }))).status).toBe(404);
    for (const bad of [{ lines: [] }, { invoiceNumber: " " }, { issueDate: "yesterday" }, { issueDate: "2026-13-45" }, { currency: "dollars" }, { freightCents: -1 }, { lines: [{ itemId: null, quantity: 0, unitPriceCents: 1 }] }]) {
      expect((await w.a.json("/invoices", w.invoice(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.a.json("/invoices")).body).toHaveLength(1);
  });

  it("can be edited while open, which sends them back to draft, and not after approval", async () => {
    const w = await world();
    const inv = await w.make({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 230 }] });
    const sub = await w.a.json(`/invoices/${inv.id}/submit`, {});
    expect(sub.body.status).toBe("review");
    const edit = await w.a.json(`/invoices/${inv.id}`, { lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 200 }], note: "corrected" }, "PATCH");
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ status: "draft", totalCents: 12000, note: "corrected" });
    expect((await w.a.json(`/invoices/${inv.id}/approve`, {})).status).toBe(409); // match it first
    const again = await w.a.json(`/invoices/${inv.id}/submit`, {});
    expect(again.body).toMatchObject({ purchaseOrderNumber: "PO-0001", dueDate: "2026-10-31" }); // fields a PATCH leaves out stay as they were
    expect(again.body.status).toBe("approved");
    const late = await w.a.json(`/invoices/${inv.id}`, { note: "too late" }, "PATCH");
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/approved/);
  });
});

describe("three-way match", () => {
  it("passes when price, quantity and receipts all agree, and the invoice is ready to pay", async () => {
    const w = await world();
    const inv = await w.make();
    const res = await w.a.json(`/invoices/${inv.id}/submit`, {});
    expect(res.body.status).toBe("approved");
    expect(res.body.match).toMatchObject({ status: "matched", flags: [] });
    expect(res.body.match.lines[0]).toMatchObject({ line: 1, orderedQuantity: 100, orderedPriceCents: 200, receivedQuantity: 60, invoicedQuantity: 60, invoicedElsewhere: 0 });
    expect(res.body).toMatchObject({ approvedBy: "Ada", overrideReason: null });
    const audit = (await w.a.json("/audit")).body.events as { action: string; summary: string }[];
    expect(audit.find((e) => e.action === "invoice.approved")!.summary).toMatch(/clean match/);
    expect(audit.some((e) => e.action === "invoice.submitted")).toBe(true);
  });

  it("flags a price above the order, but only notes a lower one", async () => {
    const w = await world();
    const high = await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 230 }] })).id}/submit`, {});
    expect(high.body.status).toBe("review");
    expect(flagCodes(high.body.match)).toEqual(["price_higher"]);
    expect(high.body.match.flags[0]).toMatchObject({ severity: "block", line: 1 });
    expect(high.body.match.flags[0].message).toMatch(/billed \$2\.30 each, ordered at \$2\.00 \(\+15\.0%\)/);
    const low = await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 150 }] })).id}/submit`, {});
    expect(low.body.status).toBe("approved");
    expect(low.body.match.status).toBe("matched");
    expect(low.body.match.flags).toEqual([expect.objectContaining({ code: "price_lower", severity: "info" })]);
  });

  it("flags billing for goods that haven't arrived, or more than arrived, in the item's own unit", async () => {
    const w = await world();
    const none = (await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.nut, quantity: 50, unitPriceCents: 10 }] })).id}/submit`, {})).body;
    expect(flagCodes(none.match)).toEqual(["not_received"]);
    expect(none.match.flags[0].message).toMatch(/none has been received/);
    const over = (await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.resin, quantity: 12500, unitPriceCents: 120 }] })).id}/submit`, {})).body;
    expect(flagCodes(over.match)).toEqual(["over_billed"]);
    expect(over.match.flags[0].message).toMatch(/12\.500 kg billed in total, 10\.000 kg received/);
    const more = (await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.kraft, quantity: 61, unitPriceCents: 200 }] })).id}/submit`, {})).body;
    expect(flagCodes(more.match)).toEqual(["over_billed"]);
  });

  it("counts what other invoices for the same order have already billed", async () => {
    const w = await world();
    const first = await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.kraft, quantity: 40, unitPriceCents: 200 }] })).id}/submit`, {});
    expect(first.body.status).toBe("approved");
    const second = (await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.kraft, quantity: 30, unitPriceCents: 200 }] })).id}/submit`, {})).body;
    expect(flagCodes(second.match)).toEqual(["over_billed"]);
    expect(second.match.lines[0]).toMatchObject({ invoicedQuantity: 30, invoicedElsewhere: 40, receivedQuantity: 60 });
    const fits = await w.a.json(`/invoices/${(await w.make({ lines: [{ itemId: w.kraft, quantity: 20, unitPriceCents: 200 }] })).id}/submit`, {});
    expect(fits.body.status).toBe("approved");
  });

  it("sees receipts made after the invoice was entered, including through a shipment", async () => {
    const w = await world();
    const inv = await w.make({ lines: [{ itemId: w.nut, quantity: 20, unitPriceCents: 10 }] });
    expect(flagCodes((await w.a.json(`/invoices/${inv.id}`)).body.match)).toEqual(["not_received"]);
    const ship = (await w.a.json("/shipments", { supplierId: w.supplier, purchaseOrderId: w.po.id, reference: "ASN-1", lines: [{ itemId: w.nut, quantity: 20 }] })).body;
    expect((await w.a.json(`/shipments/${ship.id}/receive`, { locationId: w.dock })).status).toBe(201);
    expect((await w.a.json(`/invoices/${inv.id}`)).body.match.flags).toEqual([]);
    expect((await w.a.json(`/invoices/${inv.id}/submit`, {})).body.status).toBe("approved");
  });

  it("flags the same supplier invoice number entered twice, other currencies, and totals that don't add up", async () => {
    const w = await world();
    const a = await w.make({ invoiceNumber: "SI-DUP" });
    const b = await w.a.json("/invoices", w.invoice({ invoiceNumber: " si-dup " }));
    expect(flagCodes((await w.a.json(`/invoices/${b.body.id}`)).body.match)).toEqual(["duplicate"]);
    expect((await w.a.json(`/invoices/${a.id}`)).body.match.flags.map((f: { code: string }) => f.code)).toEqual(["duplicate"]); // from either side
    // Voiding one clears it. A different supplier can use the same number.
    await w.a.json(`/invoices/${a.id}/void`, { reason: "entered twice" });
    expect((await w.a.json(`/invoices/${b.body.id}`)).body.match.flags).toEqual([]);
    const elsewhere = await w.a.json("/invoices", { ...w.invoice({ invoiceNumber: "SI-DUP", purchaseOrderId: null }), supplierId: w.other });
    expect(flagCodes((await w.a.json(`/invoices/${elsewhere.body.id}`)).body.match)).toEqual(["no_po"]);

    const eur = await w.make({ currency: "eur" });
    expect(flagCodes((await w.a.json(`/invoices/${eur.id}`)).body.match)).toEqual(["currency"]);
    const off = await w.make({ statedTotalCents: 13000 });
    expect(flagCodes((await w.a.json(`/invoices/${off.id}`)).body.match)).toEqual(["total_differs"]);
    const within = await w.make({ statedTotalCents: 13203 });
    expect((await w.a.json(`/invoices/${within.id}`)).body.match.flags).toEqual([]);
  });

  it("flags an invoice with no order, items not on the order, and orders that aren't open or are someone else's", async () => {
    const w = await world();
    const none = await w.a.json("/invoices", w.invoice({ purchaseOrderId: null }));
    expect(none.body.match).toMatchObject({ status: "no_po" });
    expect(flagCodes(none.body.match)).toEqual(["no_po"]);
    expect((await w.a.json(`/invoices/${none.body.id}/submit`, {})).body.status).toBe("review"); // a person has to look

    const extra = await w.make({ lines: [{ itemId: w.kraft, quantity: 1, unitPriceCents: 200 }, { itemId: null, description: "Fuel surcharge", quantity: 1, unitPriceCents: 4000 }] });
    expect((await w.a.json(`/invoices/${extra.id}`)).body.match.flags).toEqual([]); // freight and fees aren't stock
    const spare = (await w.a.json("/items", { sku: "SPARE", name: "Spare" })).body.id;
    const off = await w.make({ lines: [{ itemId: spare, quantity: 1, unitPriceCents: 1 }] });
    expect(flagCodes((await w.a.json(`/invoices/${off.id}`)).body.match)).toEqual(["not_on_po"]);

    const draft = (await w.a.json("/purchasing/orders", { supplierId: w.supplier, lines: [{ itemId: w.kraft, quantity: 5, unitCostCents: 200 }] })).body;
    const onDraft = await w.make({ purchaseOrderId: draft.id, lines: [{ itemId: w.kraft, quantity: 5, unitPriceCents: 200 }] });
    expect(flagCodes((await w.a.json(`/invoices/${onDraft.id}`)).body.match)).toEqual(["not_received", "po_not_open"]);
    const wrongSupplier = await w.a.json("/invoices", { ...w.invoice(), supplierId: w.other });
    expect(flagCodes((await w.a.json(`/invoices/${wrongSupplier.body.id}`)).body.match)).toContain("po_supplier");
  });

  it("uses the organization's tolerances, which only admins change", async () => {
    const w = await world();
    expect((await w.a.json("/invoices/settings")).body).toEqual({ currency: "USD", priceTolerancePct: 1, qtyTolerancePct: 0, totalToleranceCents: 5 });
    expect((await w.C.json("/invoices/settings", { currency: "USD", priceTolerancePct: 5, qtyTolerancePct: 10, totalToleranceCents: 5 }, "PUT")).status).toBe(403);
    expect((await w.a.json("/invoices/settings", { currency: "USD", priceTolerancePct: 500, qtyTolerancePct: 0, totalToleranceCents: 5 }, "PUT")).status).toBe(400);
    const set = await w.a.json("/invoices/settings", { currency: "USD", priceTolerancePct: 5, qtyTolerancePct: 10, totalToleranceCents: 5 }, "PUT");
    expect(set.status).toBe(200);
    const slight = await w.make({ lines: [{ itemId: w.kraft, quantity: 65, unitPriceCents: 209 }] }); // +4.5%, 8% over what arrived
    expect((await w.a.json(`/invoices/${slight.id}`)).body.match.flags).toEqual([]);
    const toomuch = await w.make({ lines: [{ itemId: w.kraft, quantity: 67, unitPriceCents: 215 }] }); // +7.5%, 11.7% over
    expect(flagCodes((await w.a.json(`/invoices/${toomuch.id}`)).body.match)).toEqual(["over_billed", "price_higher"]);
    expect(((await w.a.json("/audit")).body.events as { action: string; summary: string }[]).find((e) => e.action === "invoice.settings_changed")!.summary).toMatch(/priceTolerancePct 1 to 5/);
    const gbp = await w.a.json("/invoices/settings", { currency: "gbp", priceTolerancePct: 1, qtyTolerancePct: 0, totalToleranceCents: 5 }, "PUT");
    expect(gbp.body.currency).toBe("GBP");
    expect((await w.make()).currency).toBe("GBP");
  });
});

describe("approving problems", () => {
  const flagged = async (w: Awaited<ReturnType<typeof world>>, who = w.a) => {
    const inv = (await who.json("/invoices", w.invoice({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 230 }] }))).body;
    await who.json(`/invoices/${inv.id}/submit`, {});
    return inv.id as string;
  };

  it("needs a reason to pay anyway, and says so in the record", async () => {
    const w = await world();
    const id = await flagged(w);
    const no = await w.B.json(`/invoices/${id}/approve`, {});
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/Say why/);
    expect((await w.a.json(`/invoices/${id}`)).body.status).toBe("review");
    const yes = await w.B.json(`/invoices/${id}/approve`, { overrideReason: "Mill raised the price, confirmed by phone" });
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ status: "approved", overrideReason: "Mill raised the price, confirmed by phone", approvedBy: "Bob" });
    expect(((await w.a.json("/audit")).body.events as { action: string; summary: string }[]).find((e) => e.action === "invoice.approved")!.summary).toMatch(/overriding 1 problem\(s\): Mill raised the price/);
  });

  it("needs someone else to override problems on an invoice you entered, unless you're the only approver", async () => {
    const w = await world();
    const id = await flagged(w);
    const self = await w.a.json(`/invoices/${id}/approve`, { overrideReason: "fine" });
    expect(self.status).toBe(403);
    expect((await w.B.json(`/invoices/${id}/approve`, { overrideReason: "fine, checked" })).status).toBe(200);
    // Alone, you can.
    const solo = await world();
    await store.memberships.updateMany({ orgId: new ObjectId(solo.orgId), role: "admin" }, { $set: { role: "member" } });
    const id2 = await flagged(solo);
    expect((await solo.a.json(`/invoices/${id2}/approve`, { overrideReason: "only approver" })).status).toBe(200);
  });

  it("goes through the organization's approval rule when there is one", async () => {
    const w = await world();
    await w.a.json("/approvals/rules", { rules: [{ kind: "invoice", thresholdCents: 300, appliesTo: "everyone" }] }, "PUT");
    const small = await w.make({ lines: [{ itemId: w.resin, quantity: 1000, unitPriceCents: 120 }] }); // $1.20, under the $3 line
    expect((await w.a.json(`/invoices/${small.id}/submit`, {})).body.status).toBe("approved");

    const big = await w.make({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 200 }] });
    const sub = await w.a.json(`/invoices/${big.id}/submit`, {}); // $120, over it, cleanly matched
    expect(sub.status).toBe(202);
    expect(sub.body.approvalRequired).toBe(true);
    expect(sub.body.approval).toMatchObject({ kind: "invoice", status: "pending", valueCents: 12000, subject: { type: "invoice" } });
    let now = (await w.a.json(`/invoices/${big.id}`)).body;
    expect(now).toMatchObject({ status: "review", approvalNumber: sub.body.approval.number });
    expect((await w.a.json(`/invoices/${big.id}/approve`, {})).status).toBe(409); // already waiting

    const own = await w.a.json(`/approvals/${sub.body.approval.id}/approve`, {});
    expect(own.status).toBe(403); // the asker can't
    const done = await w.B.json(`/approvals/${sub.body.approval.id}/approve`, { note: "ok" });
    expect(done.status).toBe(200);
    now = (await w.a.json(`/invoices/${big.id}`)).body;
    expect(now).toMatchObject({ status: "approved", approvedBy: "Bob", approvalNumber: null });
    expect(((await w.a.json("/audit")).body.events as { action: string; summary: string }[]).some((e) => e.action === "invoice.approved" && /approved APR-/.test(e.summary))).toBe(true);

    // A rejected request leaves the invoice waiting, and it can be asked for again.
    const again = await w.make({ lines: [{ itemId: w.resin, quantity: 5000, unitPriceCents: 120 }], invoiceNumber: "SI-AGAIN" }); // $6.00, clean
    const asked = await w.a.json(`/invoices/${again.id}/submit`, {});
    expect(asked.status).toBe(202);
    expect((await w.B.json(`/approvals/${asked.body.approval.id}/reject`, { note: "wrong supplier" })).status).toBe(200);
    expect((await w.a.json(`/invoices/${again.id}`)).body.status).toBe("review");
    expect((await w.a.json(`/invoices/${again.id}/approve`, {})).status).toBe(202);
    // Editing or voiding withdraws a waiting request.
    const pending = await w.make({ lines: [{ itemId: w.resin, quantity: 4000, unitPriceCents: 120 }] }); // $4.80
    const req = await w.a.json(`/invoices/${pending.id}/submit`, {});
    expect(req.status).toBe(202);
    await w.a.json(`/invoices/${pending.id}/void`, { reason: "not ours" });
    expect((await w.B.json(`/approvals/${req.body.approval.id}/approve`, {})).status).toBe(409);
  });

  it("can't be approved on stale information: the match is re-run when a second person approves", async () => {
    const w = await world();
    await w.a.json("/approvals/rules", { rules: [{ kind: "invoice", thresholdCents: 0, appliesTo: "everyone" }] }, "PUT");
    const inv = await w.make({ lines: [{ itemId: w.kraft, quantity: 60, unitPriceCents: 200 }] });
    const asked = await w.a.json(`/invoices/${inv.id}/submit`, {});
    // The goods are returned (the receipt is reversed) before the second person looks.
    const receipt = await store.movements.findOne({ type: "receive", purchaseOrderId: { $exists: true }, itemId: new ObjectId(w.kraft) });
    await w.a.json(`/movements/${receipt!._id.toHexString()}/reverse`, {});
    const res = await w.B.json(`/approvals/${asked.body.approval.id}/approve`, {});
    expect(res.status).toBe(409);
    expect((await w.a.json(`/invoices/${inv.id}`)).body.status).toBe("review");
  });
});

describe("how a supplier is paid", () => {
  it("is set by admins, never as a full account number, and can need a second person's OK", async () => {
    const w = await world();
    const details = { method: "bank_transfer", accountName: "Paper Mill Ltd", bankName: "First Bank", accountLast4: "4821", instructions: "Quote the invoice number" };
    expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`)).body).toBeNull();
    expect((await w.C.json(`/invoices/suppliers/${w.supplier}/payment-details`, details, "PUT")).status).toBe(403);
    for (const bad of [{ accountLast4: "12345" }, { accountLast4: "ab12" }, { instructions: "Account 123456789012" }, { instructions: "card 4111 1111 1111 1111" }, { method: "wire" }]) {
      expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`, { ...details, ...bad }, "PUT")).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`, details, "PUT")).status).toBe(200);
    expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`)).body).toMatchObject({ accountLast4: "4821" });
    const events = (await w.a.json("/audit")).body.events as { action: string; summary: string }[];
    expect(events.find((e) => e.action === "supplier.payment_details_changed")!.summary).toMatch(/Set how Paper Mill is paid: bank transfer, account ending 4821/);

    await w.a.json("/approvals/rules", { rules: [{ kind: "supplier_payment_details", thresholdCents: 0, appliesTo: "everyone" }] }, "PUT");
    const change = { ...details, accountLast4: "9999", accountName: "Someone Else" };
    const asked = await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`, change, "PUT");
    expect(asked.status).toBe(202);
    expect(asked.body.approval).toMatchObject({ kind: "supplier_payment_details", subject: { type: "supplier", label: "Paper Mill" } });
    expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`)).body.accountLast4).toBe("4821"); // unchanged until approved
    expect((await w.a.json(`/approvals/${asked.body.approval.id}/approve`, {})).status).toBe(403);
    expect((await w.B.json(`/approvals/${asked.body.approval.id}/approve`, {})).status).toBe(200);
    expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`)).body).toMatchObject({ accountLast4: "9999", accountName: "Someone Else" });
    // Saving the same thing again asks nothing.
    expect((await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`, change, "PUT")).status).toBe(200);
  });
});

describe("payments", () => {
  const approved = async (w: Awaited<ReturnType<typeof world>>, over: object = {}) => {
    const inv = await w.make(over);
    await w.a.json(`/invoices/${inv.id}/submit`, {});
    return (await w.a.json(`/invoices/${inv.id}`)).body as { id: string; totalCents: number; number: string };
  };
  const pay = (w: Awaited<ReturnType<typeof world>>, allocations: { invoiceId: string; amountCents: number }[], over: object = {}) =>
    w.a.json("/payments", { supplierId: w.supplier, method: "bank_transfer", paidOn: "2026-10-18", reference: "TRX-1", allocations, ...over });

  it("record what was paid, keep each invoice's balance exact, and finish the invoice when it is covered", async () => {
    const w = await world();
    const inv = await approved(w); // $132.00
    const part = await pay(w, [{ invoiceId: inv.id, amountCents: 5000 }]);
    expect(part.status).toBe(201);
    expect(part.body).toMatchObject({ number: "PAY-0001", amountCents: 5000, currency: "USD", method: "bank_transfer", reference: "TRX-1", supplierName: "Paper Mill", voidedAt: null });
    expect(part.body.allocations).toEqual([{ invoiceId: inv.id, invoiceNumber: expect.stringMatching(/^SI-/), ourNumber: inv.number, amountCents: 5000 }]);
    expect((await w.a.json(`/invoices/${inv.id}`)).body).toMatchObject({ status: "approved", paidCents: 5000, balanceCents: 8200 });
    const rest = await pay(w, [{ invoiceId: inv.id, amountCents: 8200 }], { method: "check", reference: "CHK 2210" });
    expect(rest.status).toBe(201);
    expect((await w.a.json(`/invoices/${inv.id}`)).body).toMatchObject({ status: "paid", paidCents: 13200, balanceCents: 0, can: { pay: false, void: false } });
    expect((await w.a.json(`/payments?invoiceId=${inv.id}`)).body).toHaveLength(2);
    expect(((await w.a.json("/audit")).body.events as { action: string }[]).filter((e) => e.action === "payment.recorded")).toHaveLength(2);
  });

  it("can cover several invoices of one supplier at once", async () => {
    const w = await world();
    const one = await approved(w, { lines: [{ itemId: w.kraft, quantity: 10, unitPriceCents: 200 }] });
    const two = await approved(w, { lines: [{ itemId: w.kraft, quantity: 20, unitPriceCents: 200 }] });
    const res = await pay(w, [{ invoiceId: one.id, amountCents: 2000 }, { invoiceId: two.id, amountCents: 4000 }]);
    expect(res.body.amountCents).toBe(6000);
    for (const i of [one, two]) expect((await w.a.json(`/invoices/${i.id}`)).body.status).toBe("paid");
  });

  it("refuse what can't be right", async () => {
    const w = await world();
    const inv = await approved(w);
    const draft = await w.make();
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 13201 }])).status).toBe(409); // more than it is for
    expect((await pay(w, [{ invoiceId: draft.id, amountCents: 100 }])).body.error).toMatch(/Only approved invoices/);
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 100 }], { paidOn: "2999-01-01" })).body.error).toMatch(/future/);
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 100 }, { invoiceId: inv.id, amountCents: 100 }])).status).toBe(400);
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 100 }], { supplierId: w.other })).body.error).toMatch(/different supplier/);
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 100 }], { method: "bitcoin" })).status).toBe(400);
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 0 }])).status).toBe(400);
    expect((await pay(w, [])).status).toBe(400);
    expect((await w.C.json("/payments", { supplierId: w.supplier, method: "cash", paidOn: "2026-10-18", allocations: [{ invoiceId: inv.id, amountCents: 100 }] })).status).toBe(403);
    expect((await w.a.json(`/invoices/${inv.id}`)).body.paidCents).toBe(0);
    const eur = await w.make({ lines: [{ itemId: null, description: "Fee", quantity: 1, unitPriceCents: 500 }], purchaseOrderId: null });
    await store.invoices.updateOne({ _id: new ObjectId(eur.id) }, { $set: { currency: "EUR", status: "approved" } });
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 100 }, { invoiceId: eur.id, amountCents: 100 }])).body.error).toMatch(/different currencies/);
    expect((await w.a.json(`/invoices/${inv.id}`)).body.paidCents).toBe(0); // nothing half-applied
  });

  it("never pay an invoice past its total, even when two people pay at once", async () => {
    const w = await world();
    const inv = await approved(w);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => pay(w, [{ invoiceId: inv.id, amountCents: 13200 }], { reference: `R${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await w.a.json(`/invoices/${inv.id}`)).body).toMatchObject({ paidCents: 13200, status: "paid" });
    expect(await store.payments.countDocuments({ orgId: new ObjectId(w.orgId) })).toBe(1);
  });

  it("can be voided, which puts the balance back; an invoice with a payment can't be voided", async () => {
    const w = await world();
    const inv = await approved(w);
    const p = await pay(w, [{ invoiceId: inv.id, amountCents: 13200 }]);
    expect((await w.a.json(`/invoices/${inv.id}/void`, { reason: "oops" })).status).toBe(409);
    expect((await w.a.json(`/payments/${p.body.id}/void`, {})).status).toBe(400); // a reason is needed
    const v = await w.a.json(`/payments/${p.body.id}/void`, { reason: "Bank bounced it" });
    expect(v.body).toMatchObject({ voidReason: "Bank bounced it", voidedAt: expect.any(String) });
    expect((await w.a.json(`/invoices/${inv.id}`)).body).toMatchObject({ status: "approved", paidCents: 0, balanceCents: 13200 });
    expect((await w.a.json(`/payments/${p.body.id}/void`, { reason: "again" })).status).toBe(404);
    expect((await pay(w, [{ invoiceId: inv.id, amountCents: 13200 }], { reference: "TRX-2" })).status).toBe(201); // can be paid again
    expect(((await w.a.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "payment.voided")).toBe(true);
  });

  it("make a remittance for the supplier", async () => {
    const w = await world();
    const one = await approved(w, { lines: [{ itemId: w.kraft, quantity: 10, unitPriceCents: 200 }], invoiceNumber: "SI-A" });
    const two = await approved(w, { lines: [{ itemId: w.kraft, quantity: 20, unitPriceCents: 200 }], invoiceNumber: "SI-B", issueDate: "2026-10-05" });
    const p = await pay(w, [{ invoiceId: one.id, amountCents: 2000 }, { invoiceId: two.id, amountCents: 3000 }], { reference: "CHK 77", method: "check", note: "October run" });
    const rem = (await w.a.json(`/payments/${p.body.id}/remittance`)).body;
    expect(rem).toEqual({
      paymentNumber: "PAY-0001", paidOn: "2026-10-18", method: "check", reference: "CHK 77", currency: "USD", from: { name: "Box Co" }, to: { name: "Paper Mill" },
      lines: [{ invoiceNumber: "SI-A", issueDate: "2026-10-01", invoiceTotalCents: 2000, amountCents: 2000 }, { invoiceNumber: "SI-B", issueDate: "2026-10-05", invoiceTotalCents: 4000, amountCents: 3000 }],
      totalCents: 5000, note: "October run", voided: false,
    });
    const other = await world();
    expect((await other.a.json(`/payments/${p.body.id}/remittance`)).status).toBe(404);
  });
});

describe("shipments (advance ship notices)", () => {
  const asn = (w: Awaited<ReturnType<typeof world>>, over: object = {}) =>
    w.a.json("/shipments", { supplierId: w.supplier, purchaseOrderId: w.po.id, reference: `ASN-${++n}`, carrier: "FastFreight", tracking: "FF123", expectedDate: "2026-10-20", lines: [{ itemId: w.kraft, quantity: 40, supplierLot: "LOT-9" }, { itemId: w.resin, quantity: 15000 }], ...over });

  it("are recorded by anyone on the dock, once per supplier reference, and warn about what doesn't match the order", async () => {
    const w = await world();
    const s = await asn(w, { reference: "ASN-1" });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ number: "SHP-0001", status: "expected", purchaseOrderNumber: "PO-0001", supplierName: "Paper Mill", carrier: "FastFreight" });
    expect(s.body.lines.map((l: { received: number }) => l.received)).toEqual([0, 0]);
    expect((await asn(w, { reference: " asn-1 " })).status).toBe(409);
    expect((await w.C.json("/shipments", { supplierId: w.supplier, reference: "ASN-C", lines: [{ itemId: w.nut, quantity: 1 }] })).status).toBe(201);
    const odd = await asn(w, { lines: [{ itemId: w.kraft, quantity: 150 }, { itemId: w.nut, quantity: 10 }, { itemId: (await w.a.json("/items", { sku: "SP", name: "Spare" })).body.id, quantity: 1 }] });
    expect(odd.body.warnings).toEqual(["Kraft paper: 150 shipped, 100 ordered.", "Spare isn't on PO-0001."]);
    expect((await asn(w, { lines: [{ itemId: w.kraft, quantity: 1 }, { itemId: w.kraft, quantity: 2 }] })).status).toBe(400);
    expect((await asn(w, { supplierId: w.other })).status).toBe(201); // another supplier's own reference space
    const other = await world();
    expect((await other.a.json(`/shipments/${s.body.id}`)).status).toBe(404);
    expect((await asn(w, { supplierId: other.supplier })).status).toBe(404);
  });

  it("receive through the ledger, tagged with the shipment and the order, in full or in part", async () => {
    const w = await world();
    const s = (await asn(w)).body;
    const part = await w.C.json(`/shipments/${s.id}/receive`, { locationId: w.dock, lines: [{ itemId: w.kraft, quantity: 25 }] });
    expect(part.status).toBe(201);
    expect(part.body.shipment).toMatchObject({ status: "partial" });
    expect(part.body.shipment.lines.map((l: { received: number }) => l.received)).toEqual([25, 0]);
    const rest = await w.a.json(`/shipments/${s.id}/receive`, { locationId: w.dock }); // everything still expected
    expect(rest.status).toBe(201);
    expect(rest.body.shipment).toMatchObject({ status: "received" });
    expect(rest.body.shipment.lines.map((l: { received: number }) => l.received)).toEqual([40, 15000]);
    expect((await w.a.json(`/shipments/${s.id}/receive`, { locationId: w.dock })).status).toBe(409); // nothing left
    // The ledger: tagged both ways, with the supplier's lot, and the order counts it.
    const tagged = await store.movements.find({ shipmentId: new ObjectId(s.id) }).toArray();
    expect(tagged).toHaveLength(3);
    expect(tagged.every((m) => m.purchaseOrderId?.equals(new ObjectId(w.po.id)) && m.type === "receive")).toBe(true);
    expect(tagged.find((m) => m.itemId.equals(new ObjectId(w.kraft)) && m.delta === 15)!.supplierLot).toBe("LOT-9");
    const order = (await w.a.json(`/purchasing/orders/${w.po.id}`)).body;
    expect(order.lines.find((l: { itemSku: string }) => l.itemSku === "KRAFT").received).toBe(60 + 40);
    expect(order.lines.find((l: { itemSku: string }) => l.itemSku === "RESIN").received).toBe(10000 + 15000);
    expect((await w.a.json("/items")).body.find((i: { sku: string }) => i.sku === "RESIN").quantity).toBe(25000);
    expect(((await w.a.json("/audit")).body.events as { action: string }[]).some((e) => e.action === "shipment.received")).toBe(true);
    // Reversing a receipt takes it off the shipment again.
    await w.a.json(`/movements/${tagged[0]!._id.toHexString()}/reverse`, {});
    expect((await w.a.json(`/shipments/${s.id}`)).body.status).not.toBe("received");
  });

  it("work without an order, and refuse what can't be done", async () => {
    const w = await world();
    const s = (await asn(w, { purchaseOrderId: null, lines: [{ itemId: w.kraft, quantity: 10, supplierLot: "L1" }] })).body;
    expect((await w.a.json(`/shipments/${s.id}/receive`, { locationId: w.dock, inspect: true })).status).toBe(400);
    expect((await w.a.json(`/shipments/${s.id}/receive`, { locationId: new ObjectId().toHexString() })).status).toBe(404);
    expect((await w.a.json(`/shipments/${s.id}/receive`, { locationId: w.dock, lines: [{ itemId: w.resin, quantity: 1 }] })).status).toBe(400);
    expect((await w.a.json(`/shipments/${s.id}/receive`, { locationId: w.dock })).status).toBe(201);
    const moved = await store.movements.findOne({ shipmentId: new ObjectId(s.id) });
    expect(moved).toMatchObject({ delta: 10, supplierLot: "L1", type: "receive" });
    expect(moved!.purchaseOrderId).toBeUndefined();
    // Cancelling: admins only, and only before anything arrives.
    const c2 = (await asn(w)).body;
    expect((await w.C.json(`/shipments/${c2.id}/cancel`, {})).status).toBe(403);
    expect((await w.a.json(`/shipments/${s.id}/cancel`, {})).status).toBe(409);
    expect((await w.a.json(`/shipments/${c2.id}/cancel`, {})).body.status).toBe("cancelled");
    expect((await w.a.json(`/shipments/${c2.id}/receive`, { locationId: w.dock })).status).toBe(409);
    // A draft or cancelled order can't be received against.
    const draft = (await w.a.json("/purchasing/orders", { supplierId: w.supplier, lines: [{ itemId: w.kraft, quantity: 5, unitCostCents: 200 }] })).body;
    const onDraft = (await asn(w, { purchaseOrderId: draft.id })).body;
    expect((await w.a.json(`/shipments/${onDraft.id}/receive`, { locationId: w.dock })).body.error).toMatch(/Place the purchase order/);
    expect((await w.a.json("/shipments?status=open")).body.every((x: { status: string }) => x.status === "expected" || x.status === "partial")).toBe(true);
  });

  it("can hold what arrives for inspection when it has an order", async () => {
    const w = await world();
    const s = (await asn(w, { lines: [{ itemId: w.kraft, quantity: 10 }] })).body;
    const res = await w.a.json(`/shipments/${s.id}/receive`, { locationId: w.dock, inspect: true });
    expect(res.status).toBe(201);
    expect(res.body.ncrs).toHaveLength(1);
  });
});

describe("exports for accounting", () => {
  it("list approved and paid invoices line by line, and payments, for admins only", async () => {
    const w = await world();
    const inv = await w.make({ invoiceNumber: "=SUM(A1)", freightCents: 500 });
    await w.a.json(`/invoices/${inv.id}/submit`, {});
    await w.make({ invoiceNumber: "DRAFT-ONE" }); // not approved: not exported
    await w.a.json("/payments", { supplierId: w.supplier, method: "check", paidOn: "2026-10-18", reference: "CHK 1", allocations: [{ invoiceId: inv.id, amountCents: 5000 }] });
    const bills = await (await w.a.raw("/invoices/export/bills.csv")).text();
    const rows = bills.trim().split("\r\n");
    expect(rows[0]).toBe("bill_no,our_ref,vendor,bill_date,due_date,currency,po_number,status,line,sku,description,quantity,unit,unit_price,amount,tax");
    expect(rows).toHaveLength(1 + 3); // two lines and freight
    expect(rows[1]).toBe("'=SUM(A1),INVC-0001,Paper Mill,2026-10-01,2026-10-31,USD,PO-0001,approved,1,KRAFT,Kraft paper,60,ea,2.00,120.00,0.00");
    expect(rows[2]).toContain(",2,RESIN,PET resin,10.000,kg,1.20,12.00,0.00");
    expect(rows[3]).toContain(",3,,Freight,1,ea,5.00,5.00,0.00");
    expect(bills).not.toContain("DRAFT-ONE");
    const pays = (await (await w.a.raw("/invoices/export/payments.csv")).text()).trim().split("\r\n");
    expect(pays[0]).toBe("payment_no,paid_on,vendor,method,reference,currency,amount,applied_to,status,note");
    expect(pays[1]).toBe("PAY-0001,2026-10-18,Paper Mill,check,CHK 1,USD,50.00,'=SUM(A1):50.00,paid,");
    expect((await w.C.raw("/invoices/export/bills.csv")).status).toBe(403);
    expect((await w.C.raw("/invoices/export/payments.csv")).status).toBe(403);
  });
});

describe("archive and API keys", () => {
  it("invoices, shipments and payments travel in a full archive and numbering carries on", async () => {
    const w = await world();
    const inv = await w.make();
    await w.a.json(`/invoices/${inv.id}/submit`, {});
    await w.a.json("/payments", { supplierId: w.supplier, method: "bank_transfer", paidOn: "2026-10-18", allocations: [{ invoiceId: inv.id, amountCents: 3000 }] });
    await w.a.json("/shipments", { supplierId: w.supplier, purchaseOrderId: w.po.id, reference: "ASN-A", lines: [{ itemId: w.nut, quantity: 5 }] });
    await w.a.json(`/invoices/suppliers/${w.supplier}/payment-details`, { method: "check", accountName: "Paper Mill" }, "PUT");
    await w.a.json("/invoices/settings", { currency: "USD", priceTolerancePct: 3, qtyTolerancePct: 0, totalToleranceCents: 5 }, "PUT");
    const archive = (await (await w.a.raw("/data/archive.json")).json());
    expect(archive.counts).toMatchObject({ invoices: 1, payments: 1, shipments: 1 });
    expect(archive.settings.invoiceSettings.priceTolerancePct).toBe(3);

    const dst = await signUp({ mode: "create", name: "Copy" });
    const t = client(dst.cookie, dst.org.id);
    expect((await t.json("/data/archive/restore", { archive, dryRun: false })).status).toBe(201);
    const invoices = (await t.json("/invoices")).body as { id: string; number: string; paidCents?: number; balanceCents: number; status: string }[];
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ number: "INVC-0001", status: "approved", balanceCents: 10200 });
    expect(invoices[0]!.id).not.toBe(inv.id);
    const pays = (await t.json("/payments")).body;
    expect(pays[0].allocations[0]).toMatchObject({ invoiceId: invoices[0]!.id, amountCents: 3000 });
    expect((await t.json("/shipments")).body).toHaveLength(1);
    const supplier = ((await t.json("/purchasing/suppliers")).body as { id: string; name: string }[]).find((x) => x.name === "Paper Mill")!.id;
    expect((await t.json(`/invoices/suppliers/${supplier}/payment-details`)).body).toMatchObject({ method: "check" });
    expect((await t.json("/invoices/settings")).body.priceTolerancePct).toBe(3);
    const detail = (await t.json(`/invoices/${invoices[0]!.id}`)).body;
    expect(detail.match).toBeNull(); // the match snapshot isn't carried over
    const next = await t.json("/invoices", { supplierId: supplier, invoiceNumber: "NEW-1", issueDate: "2026-11-01", lines: [{ itemId: null, description: "Fee", quantity: 1, unitPriceCents: 100 }] });
    expect(next.body.number).toBe("INVC-0002");
  });

  it("an API key can't touch payables, even a write key", async () => {
    const w = await world();
    const key = (await w.a.json("/api-keys", { name: "sync", scope: "write" })).body.key as string;
    const asKey = async (path: string, method = "GET", body?: unknown) =>
      (await app.request(`/api/orgs/${w.orgId}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status;
    for (const [path, method] of [["/invoices", "GET"], ["/payments", "GET"], ["/shipments", "GET"], ["/invoices/export/bills.csv", "GET"], ["/invoices", "POST"], ["/payments", "POST"], ["/shipments", "POST"]] as const) {
      expect(await asKey(path, method, method === "POST" ? {} : undefined), `${method} ${path}`).toBe(403);
    }
  });
});
