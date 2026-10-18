import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { addressLines, addressOneLine, isBlankAddress, optionalAddressSchema, sameAddress, type Address } from "@invintel/shared";
import { deflateSync } from "node:zlib";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { OutboxTransport, setMailTransport } from "./mail.js";
import { x12Country, invoiceTo810, orderTo850, readX12, shipTo856 } from "./x12-maps.js";
import { registerDocContextLoader } from "./doc-context.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
const outbox = mkdtempSync(path.join(os.tmpdir(), "invintel-inv18-outbox-"));
const dbName = `invintel_test_${randomBytes(4).toString("hex")}`;
beforeAll(async () => {
  store = await connect(uri, dbName);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
  setMailTransport(new OutboxTransport(outbox));
});
afterAll(async () => {
  setMailTransport(null);
  await store.db.dropDatabase();
  await store.close();
});

// Golden files for the documents that carry addresses (see x12.test.ts for how they are kept).
const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "golden", "x12");
function golden(name: string, text: string) {
  const file = join(goldenDir, name);
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, text);
  else if (!existsSync(file)) throw new Error(`Missing golden file ${name} (run with UPDATE_GOLDEN=1, then read it)`);
  expect(text).toBe(readFileSync(file, "utf8"));
}

let n = 0;
const makeClient = (a: ReturnType<typeof createApp>) => {
  const signUp = async (organization: object, name = "Ada") => {
    const res = await a.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `ad${++n}@example.com`, password: "correct horse", organization }) });
    const b = await res.json();
    return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
  };
  const raw = (cookie: string, p: string, body?: unknown, method?: string) => a.request(p, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (cookie: string, p: string, body?: unknown, method?: string) => {
    const res = await raw(cookie, p, body, method);
    const t = await res.text();
    let json: any;
    try { json = t ? JSON.parse(t) : undefined; } catch { /* not json */ }
    return { status: res.status, body: json, text: t };
  };
  return { signUp, raw, call };
};
const A = () => makeClient(app);
const textOf = (pdf: Buffer | string) => [...(Buffer.isBuffer(pdf) ? pdf.toString("latin1") : pdf).matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]!.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, "$1")).join("\n");

const HERE: Address = { name: "", line1: "1200 Mill Road", line2: "", city: "Springfield", region: "IL", postal: "62701", country: "US" };
const MILL: Address = { name: "", line1: "400 River Street", line2: "Dock 3", city: "Dayton", region: "OH", postal: "45402", country: "US" };
const BILL: Address = { name: "Accounts payable", line1: "88 Commerce Way", line2: "Suite 300", city: "Madison", region: "WI", postal: "53703", country: "US" };
const SHIP: Address = { name: "Plant 2, dock 4", line1: "5100 Industrial Parkway", line2: "", city: "Janesville", region: "WI", postal: "53546", country: "US" };

async function world(c = A()) {
  const owner = await c.signUp({ mode: "create", name: "Plant Co" });
  const member = await c.signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => c.call((who === "owner" ? owner : member).cookie, `${base}${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => c.call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const rawGet = (p: string, who: "owner" | "member" = "owner") => c.raw((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const main = (await get("/locations")).body[0].id as string;
  const mk = async (sku: string, qty: number, extra: object = {}) => (await post("/items", { sku, name: `${sku} item`, unitCostCents: 1000, ...(qty > 0 ? { initialStock: { locationId: main, quantity: qty } } : {}), ...extra })).body.id as string;
  const partner = async (b: object) => (await post("/b2b/partners", { kind: "customer", mode: "test", ...b })).body;
  const order = async (lines: { itemId: string; quantity: number; unitPriceCents?: number }[], extra: object = {}) => (await post("/sales/orders", { customerName: "Walk-in", lines: lines.map((l) => ({ unitPriceCents: 5000, ...l })), ...extra })).body;
  const confirm = (id: string) => post(`/sales/orders/${id}/confirm`, {});
  const ship = (id: string, lines: object[], extra: object = {}) => post(`/sales/orders/${id}/ship`, { lines, ...extra }, "member");
  const pdfText = async (p: string) => { const r = await rawGet(p); return { status: r.status, text: textOf(Buffer.from(await r.arrayBuffer())) }; };
  const company = (over: object = {}) => post("/documents/settings", { company: { name: "Plant Corrugated Ltd", address: HERE, phone: "", email: "", website: "", taxId: "", paper: "a4", taxLabel: "Tax", taxRateBps: 0, paymentTermsDays: 30, ...over } }, "owner", "PUT");
  return { c, owner, member, base, post, get, rawGet, main, mk, partner, order, confirm, ship, pdfText, company, orgId: new ObjectId(owner.org.id) };
}

// ---------- the address type ----------

describe("addresses", () => {
  it("prints the place, the street, 'City, ST postal' and the country, leaving out what is empty", () => {
    expect(addressLines(SHIP)).toEqual(["Plant 2, dock 4", "5100 Industrial Parkway", "Janesville, WI 53546", "US"]);
    expect(addressLines({ line1: "1 Main St", city: "Reno" })).toEqual(["1 Main St", "Reno"]);
    expect(addressLines({ line1: "1 Main St", postal: "12345" })).toEqual(["1 Main St", "12345"]);
    expect(addressLines(null)).toEqual([]);
    expect(addressOneLine(BILL)).toBe("88 Commerce Way, Suite 300, Madison, WI 53703, US"); // the place name is for labels, not the one-liner
    expect(isBlankAddress({ line1: "  ", city: "" })).toBe(true);
    expect(isBlankAddress(null)).toBe(true);
    expect(isBlankAddress(HERE)).toBe(false);
    expect(sameAddress(SHIP, { ...SHIP, line1: "  5100 Industrial Parkway " })).toBe(true);
    expect(sameAddress(SHIP, BILL)).toBe(false);
  });

  it("an address that isn't given is different from one that is blank: omitted stays omitted, blank becomes none, junk is refused", () => {
    expect(optionalAddressSchema.parse(undefined)).toBeUndefined();
    expect(optionalAddressSchema.parse(null)).toBeNull();
    expect(optionalAddressSchema.parse({ line1: "", city: " " })).toBeNull();
    expect(optionalAddressSchema.parse({ line1: " 1 Main St ", city: "Reno" })).toMatchObject({ line1: "1 Main St", city: "Reno", country: "" });
    expect(optionalAddressSchema.safeParse({ line1: "x".repeat(56) }).success).toBe(false);
    expect(optionalAddressSchema.safeParse({ city: "x".repeat(31) }).success).toBe(false);
    expect(optionalAddressSchema.safeParse("1 Main St").success).toBe(false);
  });

  it("understands country names for EDI and refuses the ones it can't be sure of", () => {
    expect(x12Country("us")).toBe("US");
    expect(x12Country("United States")).toBe("US");
    expect(x12Country("  Canada ")).toBe("CA");
    expect(x12Country("")).toBe("");
    expect(x12Country("Atlantis")).toBeNull();
    expect(x12Country("USA")).toBe("US");
  });
});

// ---------- suppliers and customers ----------

describe("addresses on suppliers and customers", () => {
  it("a supplier takes an address, changes it, clears it, and refuses a bad one; older suppliers show none", async () => {
    const w = await world();
    const sup = (await w.post("/purchasing/suppliers", { name: "Mill Co", address: MILL })).body;
    expect(sup.address).toEqual(MILL);
    expect((await w.post(`/purchasing/suppliers/${sup.id}`, { address: { ...MILL, city: "Columbus" } }, "owner", "PATCH")).body.address.city).toBe("Columbus");
    expect((await w.post(`/purchasing/suppliers/${sup.id}`, { phone: "555" }, "owner", "PATCH")).body.address.city).toBe("Columbus"); // not given: unchanged
    expect((await w.post(`/purchasing/suppliers/${sup.id}`, { address: { line1: "", city: "" } }, "owner", "PATCH")).body.address).toBeNull(); // blank: cleared
    expect((await w.post("/purchasing/suppliers", { name: "Bad", address: { line1: "x".repeat(80) } })).status).toBe(400);
    expect((await w.post("/purchasing/suppliers", { name: "Bad2", address: "nope" })).status).toBe(400);
    expect((await w.post("/purchasing/suppliers", { name: "Member's", address: MILL }, "member")).status).toBe(403);
    // an older supplier (no address field at all)
    await store.suppliers.insertOne({ _id: new ObjectId(), orgId: w.orgId, name: "Old Supplier", contact: "", email: "", phone: "", notes: "", createdAt: new Date() });
    const list = (await w.get("/purchasing/suppliers", "member")).body as { name: string; address: unknown }[];
    expect(list.find((s) => s.name === "Old Supplier")!.address).toBeNull();
  });

  it("a customer partner takes a bill-to and a ship-to; older partners show none", async () => {
    const w = await world();
    const p = await w.partner({ name: "Bluebird", bridge: "loopback", billTo: BILL, shipTo: SHIP });
    expect(p).toMatchObject({ billTo: BILL, shipTo: SHIP });
    const cleared = await w.post(`/b2b/partners/${p.id}`, { shipTo: null }, "owner", "PATCH");
    expect(cleared.body).toMatchObject({ billTo: BILL, shipTo: null });
    expect((await w.post(`/b2b/partners/${p.id}`, { billTo: { line1: "x".repeat(60) } }, "owner", "PATCH")).status).toBe(400);
    await store.tradingPartners.insertOne({ _id: new ObjectId(), orgId: w.orgId, name: "Old Partner", kind: "customer", supplierId: null, identifiers: [], bridge: "loopback", bridgeConfig: {}, mode: "test", enabled: true, contactEmail: "", note: "", createdAt: new Date() });
    const old = ((await w.get("/b2b/partners")).body as any[]).find((x) => x.name === "Old Partner");
    expect(old).toMatchObject({ billTo: null, shipTo: null, docTemplates: {} });
  });
});

describe("addresses on sales orders", () => {
  it("a new order copies the customer's addresses (ship-to falls back to bill-to); its own win; a later change to the customer leaves it alone", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 50);
    const both = await w.partner({ name: "Bluebird", bridge: "loopback", billTo: BILL, shipTo: SHIP });
    const billOnly = await w.partner({ name: "Cedar", bridge: "loopback", billTo: BILL });
    const none = await w.partner({ name: "Plain", bridge: "loopback" });
    const lines = [{ itemId: k, quantity: 1 }];
    const a = await w.order(lines, { customerPartnerId: both.id });
    expect(a).toMatchObject({ billTo: BILL, shipTo: SHIP });
    expect(await w.order(lines, { customerPartnerId: billOnly.id })).toMatchObject({ billTo: BILL, shipTo: BILL });
    expect(await w.order(lines, { customerPartnerId: none.id })).toMatchObject({ billTo: null, shipTo: null });
    expect(await w.order(lines, { customerPartnerId: both.id, shipTo: HERE })).toMatchObject({ billTo: BILL, shipTo: HERE });
    expect(await w.order(lines, { customerPartnerId: both.id, billTo: null, shipTo: null })).toMatchObject({ billTo: null, shipTo: null }); // explicitly none
    expect(await w.order(lines, { customerName: "Walk-in", billTo: MILL })).toMatchObject({ billTo: MILL, shipTo: null });
    await w.post(`/b2b/partners/${both.id}`, { shipTo: { ...SHIP, city: "Beloit" } }, "owner", "PATCH");
    expect((await w.get(`/sales/orders/${a.id}`)).body.shipTo.city).toBe("Janesville"); // the order keeps what it was made with
    expect(await w.order(lines, { customerPartnerId: both.id })).toMatchObject({ shipTo: { city: "Beloit" } });
    // editing a draft
    const edited = await w.post(`/sales/orders/${a.id}`, { shipTo: HERE }, "owner", "PATCH");
    expect(edited.body).toMatchObject({ billTo: BILL, shipTo: HERE });
    expect((await w.post(`/sales/orders/${a.id}`, { note: "x" }, "owner", "PATCH")).body.shipTo).toEqual(HERE); // not mentioned: unchanged
    expect((await w.post(`/sales/orders/${a.id}`, { billTo: { line1: "y".repeat(80) } }, "owner", "PATCH")).status).toBe(400);
    // rewriting a confirmed order keeps its addresses
    await w.confirm(a.id);
    expect((await w.post(`/sales/orders/${a.id}/rewrite`, {})).body).toMatchObject({ billTo: BILL, shipTo: HERE });
    // an order made before addresses existed
    const old = await w.order(lines);
    await store.salesOrders.updateOne({ _id: new ObjectId(old.id) }, { $unset: { billTo: "", shipTo: "" } });
    expect((await w.get(`/sales/orders/${old.id}`)).body).toMatchObject({ billTo: null, shipTo: null });
    await w.confirm(old.id);
    expect((await w.pdfText(`/sales/orders/${old.id}/confirmation.pdf`)).status).toBe(200);
  });
});

// ---------- on the documents ----------

describe("addresses on the PDFs", () => {
  it("the purchase order shows the supplier's address and where it is delivered; without addresses it looks as before", async () => {
    const w = await world();
    await w.company();
    const k = await w.mk("KRAFT", 10, { name: "Kraft roll" });
    const sup = (await w.post("/purchasing/suppliers", { name: "Mill Co", contact: "Sam", address: MILL })).body.id;
    const bare = (await w.post("/purchasing/suppliers", { name: "Bare Co" })).body.id;
    const po = async (s: string) => { const o = (await w.post("/purchasing/orders", { supplierId: s, lines: [{ itemId: k, quantity: 5, unitCostCents: 100 }] })).body; await w.post(`/purchasing/orders/${o.id}/place`, {}); return o; };
    const t = (await w.pdfText(`/b2b/orders/${(await po(sup)).id}/preview.pdf`)).text;
    for (const x of ["TO (SUPPLIER)", "Mill Co", "400 River Street", "Dock 3", "Dayton, OH 45402", "DELIVER TO", "Plant Corrugated Ltd", "1200 Mill Road", "Springfield, IL 62701"]) expect(t).toContain(x);
    const b = (await w.pdfText(`/b2b/orders/${(await po(bare)).id}/preview.pdf`)).text;
    expect(b).toContain("Bare Co");
    expect(b).not.toContain("400 River Street");
    // no letterhead address: no "Deliver to" block
    const w2 = await world();
    const k2 = await w2.mk("KRAFT", 10);
    const s2 = (await w2.post("/purchasing/suppliers", { name: "Mill Co", address: MILL })).body.id;
    const o2 = (await w2.post("/purchasing/orders", { supplierId: s2, lines: [{ itemId: k2, quantity: 5, unitCostCents: 100 }] })).body;
    await w2.post(`/purchasing/orders/${o2.id}/place`, {});
    const t2 = (await w2.pdfText(`/b2b/orders/${o2.id}/preview.pdf`)).text;
    expect(t2).toContain("Dayton, OH 45402");
    expect(t2).not.toContain("DELIVER TO");
  });

  it("the confirmation, packing slip and invoice show bill-to and ship-to; one block when they are the same place", async () => {
    const w = await world();
    await w.company({ taxRateBps: 500 });
    const k = await w.mk("KRAFT", 50, { name: "Kraft roll" });
    const two = await w.partner({ name: "Bluebird", bridge: "loopback", billTo: BILL, shipTo: SHIP });
    const same = await w.partner({ name: "Cedar", bridge: "loopback", billTo: BILL });
    const make = async (p: { id: string }) => { const o = await w.order([{ itemId: k, quantity: 4, unitPriceCents: 1000 }], { customerPartnerId: p.id }); await w.confirm(o.id); await w.ship(o.id, [{ itemId: k, quantity: 4, locationId: w.main }]); return o; };
    const a = await make(two);
    const conf = (await w.pdfText(`/sales/orders/${a.id}/confirmation.pdf`)).text;
    for (const x of ["BILL TO", "Accounts payable", "Madison, WI 53703", "SHIP TO", "Plant 2, dock 4", "Janesville, WI 53546"]) expect(conf).toContain(x);
    const slip = (await w.pdfText(`/sales/orders/${a.id}/shipments/SO-0001-1/packing-slip.pdf`)).text;
    expect(slip).toContain("SHIP TO");
    expect(slip).toContain("5100 Industrial Parkway");
    expect(slip).not.toContain("88 Commerce Way");
    const inv = (await w.pdfText(`/sales/orders/${a.id}/shipments/SO-0001-1/invoice.pdf`)).text;
    for (const x of ["BILL TO", "88 Commerce Way", "SHIP TO", "5100 Industrial Parkway"]) expect(inv).toContain(x);
    const b = await make(same);
    const conf2 = (await w.pdfText(`/sales/orders/${b.id}/confirmation.pdf`)).text;
    expect(conf2).toContain("CUSTOMER");
    expect(conf2).not.toContain("SHIP TO");
    expect(conf2).toContain("88 Commerce Way");
    expect((await w.pdfText(`/sales/orders/${b.id}/shipments/SO-0002-1/invoice.pdf`)).text).toContain("BILL TO");
    // a stored invoice keeps the addresses it was issued with
    await w.post(`/b2b/partners/${two.id}`, { billTo: { ...BILL, line1: "1 New Street" } }, "owner", "PATCH");
    expect((await w.pdfText(`/sales/orders/${a.id}/shipments/SO-0001-1/invoice.pdf`)).text).toContain("88 Commerce Way");
  });

  it("the letterhead prints its structured address, still prints the older lines, and the structured address wins", async () => {
    const w = await world();
    await w.post("/documents/settings", { company: { name: "Old Style Co", addressLines: ["9 Legacy Lane", "Oldtown"], phone: "", email: "", website: "", taxId: "", paper: "a4", taxLabel: "Tax", taxRateBps: 0, paymentTermsDays: 30 } }, "owner", "PUT");
    const preview = async () => textOf(Buffer.from(await (await w.c.raw(w.owner.cookie, `${w.base}/documents/preview`, { kind: "invoice" })).arrayBuffer()));
    const legacy = await preview();
    expect(legacy).toContain("9 Legacy Lane");
    expect(legacy).toContain("Oldtown");
    await w.post("/documents/settings", { company: { name: "Old Style Co", addressLines: ["9 Legacy Lane"], address: HERE, phone: "", email: "", website: "", taxId: "", paper: "a4", taxLabel: "Tax", taxRateBps: 0, paymentTermsDays: 30 } }, "owner", "PUT");
    const both = await preview();
    expect(both).toContain("1200 Mill Road");
    expect(both).not.toContain("9 Legacy Lane");
  });
});

// ---------- in the EDI documents (N1 / N3 / N4) ----------

describe("addresses in X12", () => {
  const NOW = new Date("2026-10-18T09:30:00Z");
  const profile = { senderQual: "ZZ", senderId: "NWCORR", receiverQual: "ZZ", receiverId: "SUNRISEPM", version: "004010" as const, usage: "T" as const };
  const opts = (control: number) => ({ profile, control, now: NOW });
  const order = (over: object = {}) => ({
    kind: "order" as const, version: 1 as const, poNumber: "PO-1", revision: 1, issuedAt: "2026-10-18", buyer: { name: "Northwind Corrugated Co.", address: HERE }, supplier: { name: "Sunrise Paper Mill", contact: "", email: "", address: MILL },
    shipTo: { ...SHIP, name: "Plant 2, dock 4" }, currency: "USD", expectedDate: null, note: "", lines: [{ lineNo: 1, sku: "A", name: "A", quantity: "1", unit: "ea", unitPriceCents: 100, lineTotalCents: 100 }], totalCents: 100, portalUrl: null, ...over,
  });
  const text = (w: { ok: boolean; text?: string; errors?: string[] }) => { if (!w.ok) throw new Error(w.errors!.join("; ")); return w.text!; };

  it("writes the 850's buyer, supplier and ship-to with their street, city, state, postal code and country, and reads them back", () => {
    const x = text(orderTo850(order(), opts(1)));
    expect(x).toContain("N1*BY*Northwind Corrugated Co.~\nN3*1200 Mill Road~\nN4*Springfield*IL*62701*US~");
    expect(x).toContain("N1*SE*Sunrise Paper Mill~\nN3*400 River Street*Dock 3~\nN4*Dayton*OH*45402*US~");
    expect(x).toContain("N1*ST*Plant 2, dock 4~\nN3*5100 Industrial Parkway~\nN4*Janesville*WI*53546*US~");
    const back = readX12(x);
    expect(back.ok && back.doc).toEqual({ kind: "order", doc: order() });
  });

  it("golden files: 850, 856 and 810 with their addresses", () => {
    golden("850-order-addresses.x12", text(orderTo850(order(), opts(11))));
    const ship = { kind: "despatch_advice" as const, version: 1 as const, shipmentNo: "SH-1", poNumber: "PO-1", shipDate: "2026-11-03", carrier: "UPS", trackingNumber: "1Z999", customerName: "Bluebird Packaging", shipTo: SHIP, lines: [{ lineNo: 1, sku: "A", quantity: "1", unit: "ea" }] };
    golden("856-ship-addresses.x12", text(shipTo856(ship, opts(12))));
    const inv = { kind: "invoice" as const, version: 1 as const, invoiceNumber: "INV-1", invoiceDate: "2026-11-03", dueDate: "2026-12-03", poNumber: "PO-1", currency: "USD", taxCents: 0, totalCents: 100, billTo: "Bluebird Packaging", billToAddress: BILL, shipToAddress: SHIP, lines: [{ lineNo: 1, sku: "A", name: "A", quantity: "1", unit: "ea", unitPriceCents: 100, lineTotalCents: 100 }] };
    golden("810-invoice-addresses.x12", text(invoiceTo810(inv, opts(13))));
  });

  it("without addresses the document is the one it always was (names only); half an address is an error that says what to fix", () => {
    const plain = text(orderTo850(order({ buyer: { name: "Northwind Corrugated Co." }, supplier: { name: "Sunrise Paper Mill", contact: "", email: "" }, shipTo: undefined }), opts(2)));
    expect(plain).toContain("N1*BY*Northwind Corrugated Co.~\nN1*SE*Sunrise Paper Mill~\nPO1");
    expect(plain).not.toContain("N3*");
    const err = (sup: Partial<Address>) => { const r = orderTo850(order({ supplier: { name: "S", contact: "", email: "", address: { ...MILL, ...sup } } }), opts(3)); return r.ok ? "ok" : r.errors.join("; "); };
    expect(err({ region: "Ohio" })).toMatch(/state or province as a code \(like IL\), not "Ohio"/);
    expect(err({ country: "Atlantis" })).toMatch(/two-letter country code/);
    expect(err({ city: "" })).toMatch(/needs a city/);
    expect(err({ line1: "", line2: "Dock 3" })).toMatch(/second street line needs a first/);
    expect(err({ postal: "!" })).toMatch(/postal code/);
    expect(err({ line1: "x".repeat(56) })).toMatch(/longer than the 55 characters/);
    expect(err({ country: "United States", region: "oh" })).toBe("ok");
    expect(text(orderTo850(order({ supplier: { name: "S", contact: "", email: "", address: { ...MILL, country: "United States", region: "oh" } } }), opts(4)))).toContain("N4*Dayton*OH*45402*US~");
    // street characters X12 reserves are cleaned, never passed through
    expect(text(orderTo850(order({ supplier: { name: "S", contact: "", email: "", address: { ...MILL, line1: "Unit 4 * Rear ~ Yard" } } }), opts(5)))).toContain("N3*Unit 4 Rear Yard*Dock 3~");
  });

  it("puts the ship-to in the 856 and the bill-to and ship-to in the 810", () => {
    const ship = { kind: "despatch_advice" as const, version: 1 as const, shipmentNo: "SH-1", poNumber: "PO-1", shipDate: "2026-11-03", carrier: "", trackingNumber: "", customerName: "Bluebird", shipTo: SHIP, lines: [{ lineNo: 1, sku: "A", quantity: "1", unit: "ea" }] };
    const sx = text(shipTo856({ ...ship, shipTo: { ...SHIP, name: "" } }, opts(6)));
    expect(sx).toContain("N1*ST*Bluebird~\nN3*5100 Industrial Parkway~\nN4*Janesville*WI*53546*US~\nHL*2*1*O");
    const sb = readX12(sx);
    expect(sb.ok && sb.doc).toMatchObject({ kind: "despatch_advice", doc: { customerName: "Bluebird", shipTo: { line1: "5100 Industrial Parkway", city: "Janesville", name: "" } } });
    const inv = { kind: "invoice" as const, version: 1 as const, invoiceNumber: "INV-1", invoiceDate: "2026-11-03", dueDate: "2026-12-03", poNumber: "PO-1", currency: "USD", taxCents: 0, totalCents: 100, billTo: "Bluebird", billToAddress: { ...BILL, name: "" }, shipToAddress: { ...SHIP, name: "Plant 2, dock 4" }, lines: [{ lineNo: 1, sku: "A", name: "A", quantity: "1", unit: "ea", unitPriceCents: 100, lineTotalCents: 100 }] };
    const ix = text(invoiceTo810(inv, opts(7)));
    expect(ix).toContain("N1*BT*Bluebird~\nN3*88 Commerce Way*Suite 300~\nN4*Madison*WI*53703*US~\nN1*ST*Plant 2, dock 4~\nN3*5100 Industrial Parkway~\nN4*Janesville*WI*53546*US~\nITD");
    const ib = readX12(ix);
    expect(ib.ok && ib.doc).toEqual({ kind: "invoice", doc: inv });
  });

  it("an order to an EDI supplier carries the addresses end to end, and one that can't be written says so before anything is sent", async () => {
    const w = await world();
    await w.company();
    const k = await w.mk("KRAFT", 10, { name: "Kraft roll" });
    const sup = (await w.post("/purchasing/suppliers", { name: "Sunrise", address: MILL })).body.id;
    const cfg = { ourQual: "ZZ", ourId: "PLANTCO", theirQual: "ZZ", theirId: "SUNRISEPM", version: "004010", transport: "loopback" };
    await w.partner({ name: "Sunrise", kind: "supplier", supplierId: sup, bridge: "x12", bridgeConfig: cfg });
    const po = (await w.post("/purchasing/orders", { supplierId: sup, lines: [{ itemId: k, quantity: 5, unitCostCents: 100 }] })).body;
    await w.post(`/purchasing/orders/${po.id}/place`, {});
    const sent = await w.post(`/b2b/orders/${po.id}/send`, {});
    expect(sent.status).toBe(201);
    const body = (await w.get(`/b2b/messages/${sent.body.id}`)).body.body as string;
    for (const x of ["N1*BY*Plant Co~", "N3*1200 Mill Road~", "N4*Springfield*IL*62701*US~", "N1*SE*Sunrise~", "N4*Dayton*OH*45402*US~", "N1*ST*Plant Co~"]) expect(body).toContain(x);
    const back = readX12(body);
    expect(back.ok && back.doc.kind === "order" && back.doc.doc.supplier.address).toMatchObject({ line1: "400 River Street", city: "Dayton", region: "OH" });
    // a state written out in full: refused with the reason, nothing sent
    await w.post(`/purchasing/suppliers/${sup}`, { address: { ...MILL, region: "Ohio" } }, "owner", "PATCH");
    const po2 = (await w.post("/purchasing/orders", { supplierId: sup, lines: [{ itemId: k, quantity: 1, unitCostCents: 100 }] })).body;
    await w.post(`/purchasing/orders/${po2.id}/place`, {});
    const refused = await w.post(`/b2b/orders/${po2.id}/send`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/state or province as a code/);
  });

  it("an EDI customer gets the ship-to in the 856 and the bill-to and ship-to in the 810 when Sales ships and invoices", async () => {
    const w = await world();
    await w.company();
    const k = await w.mk("KRAFT", 50, { name: "Kraft roll" });
    const cfg = { ourQual: "ZZ", ourId: "PLANTCO", theirQual: "ZZ", theirId: "BLUEBIRD", version: "004010", transport: "loopback" };
    const cust = await w.partner({ name: "Bluebird", bridge: "x12", bridgeConfig: cfg, billTo: BILL, shipTo: SHIP });
    const o = await w.order([{ itemId: k, quantity: 4, unitPriceCents: 1000 }], { customerPartnerId: cust.id, customerRef: "BP-9" });
    await w.confirm(o.id);
    await w.ship(o.id, [{ itemId: k, quantity: 4, locationId: w.main }]);
    await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/send-invoice`, {});
    const msgs = ((await w.get("/b2b/messages?direction=out")).body as any[]);
    const slip = (await w.get(`/b2b/messages/${msgs.find((m) => m.docType === "despatch_advice").id}`)).body.body as string;
    expect(slip).toContain("N1*ST*Plant 2, dock 4~\nN3*5100 Industrial Parkway~\nN4*Janesville*WI*53546*US~");
    const inv = (await w.get(`/b2b/messages/${msgs.find((m) => m.docType === "invoice").id}`)).body.body as string;
    expect(inv).toContain("N1*BT*Accounts payable~"); // the bill-to place name when it has one
    expect(inv).toContain("N3*88 Commerce Way*Suite 300~");
    expect(inv).toContain("N1*ST*Plant 2, dock 4~");
  });
});

// ---------- the archive is complete ----------

/** Same data, comparable: ids renamed by where they first appear (after sorting each collection by content), everything else untouched. */
function canonical(archive: any): unknown {
  const mask = (v: unknown): unknown => (v && typeof v === "object" ? (Array.isArray(v) ? v.map(mask) : "$oid" in (v as object) ? "$ID" : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, mask(x)]))) : v);
  const sorted: Record<string, unknown[]> = {};
  for (const [name, docs] of Object.entries<any[]>(archive.data)) sorted[name] = [...docs].sort((a, b) => JSON.stringify(mask(a)).localeCompare(JSON.stringify(mask(b))));
  const seen = new Map<string, number>();
  const rename = (v: unknown): unknown => (v && typeof v === "object" ? (Array.isArray(v) ? v.map(rename) : "$oid" in (v as object) ? { $id: seen.get((v as any).$oid) ?? (seen.set((v as any).$oid, seen.size), seen.size - 1) } : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, rename(x)]))) : v);
  const { exportedAt: _e, organizationName: _o, counters, ...rest } = archive;
  void counters;
  return rename({ ...rest, data: sorted });
}

describe("the archive carries the new settings", () => {
  const png = () => { // a real 3x2 PNG
    const crcT = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(b)); return Buffer.concat([l, b, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
    const rows = Buffer.concat([Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255]), Buffer.from([0, 9, 8, 7, 6, 5, 4, 3, 2, 1])]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  };

  /** An organization that uses all of it. */
  async function richOrg() {
    const w = await world();
    await w.company({ phone: "555-0100", email: "hello@plant.example", website: "plant.example", taxId: "TAX-9", paper: "letter", taxLabel: "Sales tax", taxRateBps: 825, paymentTermsDays: 45 });
    await w.post("/documents/settings", { templates: { invoice: { title: "TAX INVOICE", accent: "#15803d", showLogo: true, columns: ["sku", "description", "quantity", "amount"], terms: "Net 45", footer: "Thanks!" }, packing_slip: { title: "", accent: "#334155", showLogo: false, columns: ["sku", "shipped"], terms: "", footer: "" } } }, "owner", "PUT");
    expect((await w.post("/documents/logo", { contentBase64: png().toString("base64") })).status).toBe(200);
    const k = await w.mk("KRAFT", 100, { name: "Kraft roll" });
    const sup = (await w.post("/purchasing/suppliers", { name: "Mill Co", contact: "Sam", address: MILL })).body.id as string;
    const cfg = { ourQual: "ZZ", ourId: "PLANTCO", theirQual: "ZZ", theirId: "BLUEBIRD", version: "004010", transport: "loopback" };
    const edi = await w.partner({ name: "EDI Customer", bridge: "x12", bridgeConfig: cfg, billTo: BILL, shipTo: SHIP, docTemplates: { invoice: { title: "EDI INVOICE", terms: "Their terms", accent: "#b91c1c" } } });
    const mail = await w.partner({ name: "Mail Customer", bridge: "email", bridgeConfig: { to: "ap@mail.example" }, billTo: BILL, docTemplates: { sales_order: { title: "MAIL CONFIRMATION" } } });
    const sp = await w.partner({ name: "Mill Co", kind: "supplier", supplierId: sup, bridge: "email", bridgeConfig: { to: "orders@mill.example" } });
    void sp;
    // an Invintel exchange partner, which is tied to this organization's identity and is left out
    await store.tradingPartners.insertOne({ _id: new ObjectId(), orgId: w.orgId, name: "Exchange Co", kind: "customer", supplierId: null, identifiers: [], bridge: "invintel", bridgeConfig: { exchangeId: "ix_1", publicKey: "k" }, mode: "test", enabled: true, contactEmail: "", note: "", createdAt: new Date() });
    for (const cust of [edi, mail]) {
      const o = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 1000 }], { customerPartnerId: cust.id, customerRef: `REF-${cust.name}` });
      await w.confirm(o.id);
      await w.ship(o.id, [{ itemId: k, quantity: 6, locationId: w.main }], { carrier: "UPS", trackingNumber: "1Z9" });
      expect((await w.post(`/sales/orders/${o.id}/shipments/${o.number}-1/send-invoice`, {})).status).toBe(201);
    }
    const po = (await w.post("/purchasing/orders", { supplierId: sup, lines: [{ itemId: k, quantity: 5, unitCostCents: 100 }] })).body;
    await w.post(`/purchasing/orders/${po.id}/place`, {});
    return { ...w, k, sup, edi, mail };
  }
  const exportOf = async (w: Awaited<ReturnType<typeof world>>) => (await w.get("/data/archive.json")).body;

  it("exports and restores into a different database with nothing lost, and the numbering carries on", async () => {
    const w = await richOrg();
    const first = await exportOf(w);
    expect(first.counts).toMatchObject({ tradingPartners: 3, docLogos: 1, salesOrders: 2, suppliers: 1 }); // the exchange partner is left out
    expect(Object.keys(first.settings)).toContain("documentProfile");
    expect(Object.keys(first.counters)).toEqual(expect.arrayContaining([expect.stringMatching(/^x12:[0-9a-f]{24}$/)]));
    // a different database and a fresh organization there
    const dbB = `${dbName}_copy`;
    const storeB = await connect(uri, dbB);
    try {
      const appB = createApp(storeB, { allowRegistration: true, cookieSecure: false });
      const cb = makeClient(appB);
      const owner = await cb.signUp({ mode: "create", name: "Restored Co" });
      const bBase = `/api/orgs/${owner.org.id}`;
      const dry = await cb.call(owner.cookie, `${bBase}/data/archive/restore`, { archive: first, dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.body.blocked).toBeNull();
      expect(dry.body.counts).toMatchObject({ tradingPartners: 3, docLogos: 1 });
      const done = await cb.call(owner.cookie, `${bBase}/data/archive/restore`, { archive: first, dryRun: false });
      expect(done.status).toBe(201);
      const second = (await cb.call(owner.cookie, `${bBase}/data/archive.json`)).body;
      expect(canonical(second)).toEqual(canonical(first)); // everything that was exported comes back, field for field

      // what it means in use: letterhead, templates, logo, partner looks, addresses, issued invoices
      const s = (await cb.call(owner.cookie, `${bBase}/documents/settings`)).body;
      expect(s.company).toMatchObject({ name: "Plant Corrugated Ltd", address: HERE, taxRateBps: 825, paymentTermsDays: 45, paper: "letter", taxLabel: "Sales tax" });
      expect(s.templates.invoice).toMatchObject({ title: "TAX INVOICE", accent: "#15803d", columns: ["sku", "description", "quantity", "amount"], terms: "Net 45", footer: "Thanks!" });
      expect(s.logo).toMatchObject({ width: 3, height: 2, contentType: "image/png" });
      const img = await cb.raw(owner.cookie, `${bBase}/documents/logo`);
      expect(Buffer.from(await img.arrayBuffer()).equals(png())).toBe(true);
      const partners = (await cb.call(owner.cookie, `${bBase}/b2b/partners`)).body as any[];
      expect(partners.map((p) => p.name).sort()).toEqual(["EDI Customer", "Mail Customer", "Mill Co"]);
      const edi = partners.find((p) => p.name === "EDI Customer");
      expect(edi).toMatchObject({ billTo: BILL, shipTo: SHIP, docTemplates: { invoice: { title: "EDI INVOICE", terms: "Their terms", accent: "#b91c1c" } }, bridgeConfig: { ourId: "PLANTCO" } });
      expect((await cb.call(owner.cookie, `${bBase}/purchasing/suppliers`)).body[0].address).toEqual(MILL);
      const orders = (await cb.call(owner.cookie, `${bBase}/sales/orders`)).body as any[];
      expect(orders.map((o) => o.shipments.map((x: any) => x.invoiceNumber)).flat().sort()).toEqual(["INV-0001", "INV-0002"]);
      expect(orders.every((o) => o.billTo?.line1 === "88 Commerce Way")).toBe(true);
      // an issued invoice still comes out as it was issued, from the new organization
      const o1 = orders.find((o) => o.customerRef === "REF-Mail Customer");
      const pdf = await cb.raw(owner.cookie, `${bBase}/sales/orders/${o1.id}/shipments/${o1.number}-1/invoice.pdf`);
      expect(pdf.status).toBe(200);
      expect(textOf(Buffer.from(await pdf.arrayBuffer()))).toContain("INV-000");

      // numbering carries on: the next invoice, the next sales order and the next X12 control number
      const items = (await cb.call(owner.cookie, `${bBase}/items`)).body as any[];
      const loc = (await cb.call(owner.cookie, `${bBase}/locations`)).body[0].id as string;
      void loc;
      const kk = items[0].id as string;
      const o3 = (await cb.call(owner.cookie, `${bBase}/sales/orders`, { customerPartnerId: edi.id, customerRef: "NEXT", lines: [{ itemId: kk, quantity: 1, unitPriceCents: 1000 }] })).body;
      expect(o3.number).toBe("SO-0003");
      await cb.call(owner.cookie, `${bBase}/sales/orders/${o3.id}/confirm`, {});
      const stockRow = (await cb.call(owner.cookie, `${bBase}/items/${kk}`)).body.stock[0].locationId as string;
      const shipped = await cb.call(owner.cookie, `${bBase}/sales/orders/${o3.id}/ship`, { lines: [{ itemId: kk, quantity: 1, locationId: stockRow }] });
      expect(shipped.status).toBe(201);
      const inv = await cb.call(owner.cookie, `${bBase}/sales/orders/${o3.id}/shipments/SO-0003-1/send-invoice`, {});
      expect(inv.body.invoiceNumber).toBe("INV-0003");
      const out = ((await cb.call(owner.cookie, `${bBase}/b2b/messages?direction=out`)).body as any[]).filter((m) => m.correlation.poNumber === "NEXT");
      const controls = out.map((m) => Number(m.correlation.controlNumber)).sort((a, b) => a - b);
      expect(controls.every((c) => c >= 3)).toBe(true); // the source used 1 and 2 with this partner: not reused
    } finally {
      await storeB.db.dropDatabase();
      await storeB.close();
      registerDocContextLoader(store); // the other app took the document loader; put it back for this file
    }
  });

  it("refuses an archive whose new records aren't valid, and says which", async () => {
    const w = await richOrg();
    const good = await exportOf(w);
    const target = await world();
    const restore = (archive: unknown) => target.post("/data/archive/restore", { archive, dryRun: true });
    const edit = (f: (a: any) => void) => { const a = JSON.parse(JSON.stringify(good)); f(a); return a; };
    expect((await restore(good)).status).toBe(200);
    const bad = async (a: unknown, re: RegExp) => { const r = await restore(a); expect(r.status).toBe(400); expect(r.body.error).toMatch(re); };
    await bad(edit((a) => { a.data.tradingPartners[0].billTo = { line1: "x".repeat(80) }; }), /Trading partners: record 1 has an address that isn't valid/);
    await bad(edit((a) => { a.data.tradingPartners[0].docTemplates = { invoice: { accent: "red" } }; }), /document look that isn't valid/);
    await bad(edit((a) => { a.data.tradingPartners[0].docTemplates = { memo: { title: "x" } }; }), /document look that isn't valid/);
    await bad(edit((a) => { a.data.suppliers[0].address = { city: "y".repeat(40) }; }), /Suppliers: record 1 has an address that isn't valid/);
    await bad(edit((a) => { a.data.salesOrders[0].shipTo = "nowhere"; }), /Sales orders: record 1 has an address/);
    await bad(edit((a) => { a.data.salesOrders[0].shipments[0].invoice = { kind: "invoice" }; }), /has an invoice that isn't valid/);
    await bad(edit((a) => { a.data.salesOrders[0].shipments[0].invoiceNumber = 12; }), /invoice number that isn't valid/);
    await bad(edit((a) => { a.settings.documentProfile.templates.invoice.accent = "#12"; }), /setting "documentProfile"/);
    await bad(edit((a) => { a.settings.documentProfile.extra = true; }), /setting "documentProfile"/);
    // a logo is read again from its bytes: SVG, damage and a second logo are all refused
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    await bad(edit((a) => { a.data.docLogos[0].bytes = { $binary: b64('<svg xmlns="http://www.w3.org/2000/svg"/>') }; }), /logo that isn't valid: Only PNG and JPEG/);
    await bad(edit((a) => { const x = Buffer.from(a.data.docLogos[0].bytes.$binary, "base64"); x[30] = x[30]! ^ 0xff; a.data.docLogos[0].bytes = { $binary: x.toString("base64") }; }), /logo that isn't valid/);
    await bad(edit((a) => { a.data.docLogos.push({ ...a.data.docLogos[0], _id: { $oid: "0".repeat(24) } }); }), /more than one logo/);
    await bad(edit((a) => { a.data.docLogos[0].bytes = { $binary: "not base64!!" }; }), /data that isn't valid/);
    // raw bytes anywhere else are a crafted file
    await bad(edit((a) => { a.data.suppliers[0].notes = { $binary: b64("hi") }; }), /data that isn't valid/);
    // a logo's recorded size and type are recomputed, not trusted
    const lied = edit((a) => { a.data.docLogos[0].width = 9999; a.data.docLogos[0].contentType = "image/jpeg"; });
    expect((await target.post("/data/archive/restore", { archive: lied, dryRun: false })).status).toBe(201);
    expect((await target.get("/documents/settings")).body.logo).toMatchObject({ width: 3, height: 2, contentType: "image/png" });
    // control-number counters for a partner that isn't in the archive are ignored
    const counters = edit((a) => { a.counters[`x12:${"a".repeat(24)}`] = 5; });
    const t2 = await world();
    const ok = await t2.post("/data/archive/restore", { archive: counters, dryRun: false });
    expect(ok.status).toBe(201);
    expect(await store.counters.countDocuments({ _id: `${t2.orgId.toHexString()}:x12:${"a".repeat(24)}` })).toBe(0);
    expect((await t2.post("/data/archive/restore", { archive: edit((a) => { a.counters["x12:nope"] = 1; }), dryRun: true })).status).toBe(400);
  });

  it("an organization that already has partners or a logo can't take an archive, and an older archive still restores", async () => {
    const w = await richOrg();
    const good = await exportOf(w);
    const t = await world();
    await t.partner({ name: "Already Here", bridge: "loopback" });
    expect((await t.post("/data/archive/restore", { archive: good, dryRun: true })).body.blocked).toMatch(/trading partners/);
    const t2 = await world();
    await t2.post("/documents/logo", { contentBase64: png().toString("base64") });
    expect((await t2.post("/data/archive/restore", { archive: good, dryRun: true })).body.blocked).toMatch(/document logo/);
    // an archive from before partners, logos and counters existed
    const old = JSON.parse(JSON.stringify(good));
    delete old.data.tradingPartners; delete old.data.docLogos; delete old.counters; delete old.settings.documentProfile;
    for (const o of old.data.salesOrders) { delete o.billTo; delete o.shipTo; }
    const t3 = await world();
    expect((await t3.post("/data/archive/restore", { archive: old, dryRun: false })).status).toBe(201);
    expect((await t3.get("/b2b/partners")).body).toEqual([]);
    expect((await t3.get("/documents/settings")).body.logo).toBeNull();
    const orders = (await t3.get("/sales/orders")).body as any[];
    expect(orders.every((o) => o.billTo === null)).toBe(true);
  });
});
