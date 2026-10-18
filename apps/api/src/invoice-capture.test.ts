import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { moneyToCents, parseJsonInvoice, parseUbl, readDate, readFromText } from "./invoice-capture.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  process.env.TEST_INBOX_SECRET = "inbox-secret-123";
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `c${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization, user: b.user };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* binary */ }
  return { status: res.status, body: json, headers: res.headers, text: t };
};

const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>INV-2026-0042</cbc:ID>
  <cbc:IssueDate>2026-10-20</cbc:IssueDate>
  <cbc:DueDate>2026-11-19</cbc:DueDate>
  <cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>
  <cac:OrderReference><cbc:ID>PO-0001</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Acme Paper</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="USD">0.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="USD">4700.00</cbc:LineExtensionAmount><cbc:PayableAmount currencyID="USD">4700.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="EA">10</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="USD">4700.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>KRAFT Kraft roll 42 lb</cbc:Name></cac:Item><cac:Price><cbc:PriceAmount currencyID="USD">470.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

describe("reading money and dates exactly", () => {
  it("reads dollars and cents without floating point, and refuses what it can't be sure of", () => {
    expect(moneyToCents("$1,234.50")).toBe(123450);
    expect(moneyToCents("12")).toBe(1200);
    expect(moneyToCents("0.1")).toBe(10);
    expect(moneyToCents("19.99")).toBe(1999);
    expect(moneyToCents("12.345")).toBe(1235); // rounds half up
    expect(moneyToCents("1.234,50")).toBeNull(); // European style is not guessed
    expect(moneyToCents("abc")).toBeNull();
    expect(moneyToCents("")).toBeNull();
    expect(moneyToCents("-5.00")).toBeNull();
    expect(moneyToCents("9".repeat(20))).toBeNull();
  });
  it("reads ISO and written dates, not ambiguous ones, not impossible ones", () => {
    expect(readDate("due 2026-11-17")).toBe("2026-11-17");
    expect(readDate("Date: Oct 18, 2026")).toBe("2026-10-18");
    expect(readDate("18 October 2026")).toBe("2026-10-18");
    expect(readDate("03/04/2026")).toBeNull();
    expect(readDate("2026-02-30")).toBeNull();
    expect(readDate("no date here")).toBeNull();
  });
});

describe("reading an invoice", () => {
  it("reads a UBL invoice exactly: number, dates, order, total, currency, lines", () => {
    const f = parseUbl(UBL)!;
    expect(f).toMatchObject({ invoiceNumber: "INV-2026-0042", invoiceDate: "2026-10-20", dueDate: "2026-11-19", poNumber: "PO-0001", totalCents: 470000, taxCents: 0, currency: "USD" });
    expect(f.lines).toEqual([{ description: "KRAFT Kraft roll 42 lb", quantity: "10", unitPriceCents: 47000, lineTotalCents: 470000 }]);
    expect(Object.values(f.confidence).every((c) => c === "read")).toBe(true);
  });
  it("refuses XML with a DOCTYPE or entities, and things that aren't invoices", () => {
    expect(parseUbl(`<!DOCTYPE lolz [<!ENTITY a "aaaa">]>${UBL}`)).toBeNull();
    expect(parseUbl(UBL.replace("<?xml", '<!ENTITY x SYSTEM "file:///etc/passwd"><?xml'))).toBeNull();
    expect(parseUbl("<Order><ID>1</ID></Order>")).toBeNull();
    expect(parseUbl("not xml")).toBeNull();
  });
  it("reads a JSON invoice, with money as text or cents", () => {
    const f = parseJsonInvoice(JSON.stringify({ invoiceNumber: "A-1", issueDate: "2026-10-01", poNumber: "PO-0003", total: "1234.50", lines: [{ description: "Widget", quantity: "3", unitPrice: "10.00" }] }))!;
    expect(f).toMatchObject({ invoiceNumber: "A-1", totalCents: 123450, poNumber: "PO-0003" });
    expect(f.lines[0]).toEqual({ description: "Widget", quantity: "3", unitPriceCents: 1000, lineTotalCents: 3000 });
    expect(parseJsonInvoice("{nope")).toBeNull();
    expect(parseJsonInvoice(JSON.stringify({ hello: 1 }))).toBeNull();
  });
  it("searches free text and marks every find as a guess, and finds nothing rather than inventing", () => {
    const f = readFromText("Invoice INV-2026-0099 for PO-0007", "Hello,\nInvoice date: Oct 20, 2026\nTotal due: $4,700.00\nPayment due by Nov 19, 2026\nThanks");
    expect(f).toMatchObject({ invoiceNumber: "INV-2026-0099", poNumber: "PO-0007", totalCents: 470000, invoiceDate: "2026-10-20", dueDate: "2026-11-19" });
    expect(Object.values(f.confidence).every((c) => c === "guess")).toBe(true);
    const none = readFromText("Hi there", "Please find attached.");
    expect(none).toMatchObject({ invoiceNumber: "", poNumber: "", totalCents: null, invoiceDate: null });
    expect(Object.values(none.confidence).every((c) => c === "missing")).toBe(true);
    expect(readFromText("invoice for your records", "total: soon").invoiceNumber).toBe(""); // a word after "invoice" is not a number
  });
});

// ---------- through the inbox ----------

async function world() {
  const owner = await signUp({ mode: "create", name: "Buyer Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call((who === "owner" ? owner : member).cookie, `${base}${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const item = (await post("/items", { sku: "KRAFT", name: "Kraft roll 42 lb", unitCostCents: 47000 })).body.id as string;
  const supplier = (await post("/purchasing/suppliers", { name: "Acme Paper" })).body.id as string;
  const partner = (await post("/b2b/partners", { name: "Acme Paper", kind: "supplier", supplierId: supplier, bridge: "invoice-inbox", bridgeConfig: { secretEnv: "TEST_INBOX_SECRET" } })).body;
  const po = (await post("/purchasing/orders", { supplierId: supplier, lines: [{ itemId: item, quantity: 10, unitCostCents: 47000 }] })).body;
  const inbound = (body: unknown, secret: string | null = "inbox-secret-123", pid = partner.id) =>
    app.request(`/api/b2b/inbound/${pid}`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-invintel-secret": secret } : {}) }, body: JSON.stringify(body) });
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  return { owner, member, base, post, get, item, supplier, partner, po, inbound, b64, orgId: new ObjectId(owner.org.id) };
}

describe("capturing invoices from email", () => {
  it("captures a UBL attachment exactly, keeps the file, matches it to the order, and audits it", async () => {
    const w = await world();
    const res = await w.inbound({ from: "billing@acme.example", subject: "Invoice INV-2026-0042", text: "See attached", messageId: "m-1", attachments: [{ filename: "inv.xml", contentType: "application/xml", contentBase64: w.b64(UBL) }] });
    expect(res.status).toBe(201);
    const list = (await w.get("/b2b/invoices", "member")).body;
    expect(list).toHaveLength(1);
    const c = list[0];
    expect(c).toMatchObject({ status: "captured", source: "ubl", invoiceNumber: "INV-2026-0042", poNumber: "PO-0001", totalCents: 470000, partnerName: "Acme Paper", from: "billing@acme.example" });
    expect(c.confidence.totalCents).toBe("read");
    expect(c.files).toEqual([expect.objectContaining({ filename: "inv.xml", contentType: "application/xml" })]);
    expect(c.match.order).toMatchObject({ number: "PO-0001", totalCents: 470000 });
    expect(c.match.differenceCents).toBe(0);
    expect(c.match.notes.join(" ")).toMatch(/matches the order/);
    expect(c.match.notes.join(" ")).toMatch(/Nothing has been received/);
    const file = await w.get(`/b2b/files/${c.files[0].id}`, "member");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment; filename="inv\.xml"/);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.text).toContain("INV-2026-0042");
    expect((await store.audit.find({ orgId: w.orgId, action: "b2b.invoice_captured" }).toArray())).toHaveLength(1);
    expect((await w.get("/b2b/messages?direction=in&state=received")).body[0].docType).toBe("invoice");
  });

  it("reads plain emails as guesses and keeps PDFs for a person to read", async () => {
    const w = await world();
    await w.inbound({ from: "ar@acme.example", subject: "Invoice INV-77 for PO-0001", text: "Total due: $4,650.00\nDue date: Nov 30, 2026", messageId: "m-2" });
    await w.inbound({ from: "ar@acme.example", subject: "Your invoice", text: "attached", messageId: "m-3", attachments: [{ filename: "scan.pdf", contentType: "application/pdf", contentBase64: w.b64("%PDF-1.4 fake") }] });
    const list = (await w.get("/b2b/invoices")).body as { subject: string; invoiceNumber: string; confidence: Record<string, string>; totalCents: number | null; files: unknown[]; match: { differenceCents: number | null; notes: string[] } }[];
    const text = list.find((x) => x.subject.includes("INV-77"))!;
    expect(text).toMatchObject({ invoiceNumber: "INV-77", totalCents: 465000 });
    expect(text.confidence).toMatchObject({ invoiceNumber: "guess", totalCents: "guess", poNumber: "guess", invoiceDate: "missing" });
    expect(text.match.differenceCents).toBe(-5000);
    expect(text.match.notes.join(" ")).toMatch(/below the order by \$50\.00/);
    const pdf = list.find((x) => x.subject === "Your invoice")!;
    expect(pdf).toMatchObject({ invoiceNumber: "", totalCents: null });
    expect(pdf.files).toHaveLength(1);
    expect(Object.values(pdf.confidence).every((c) => c === "missing")).toBe(true);
    expect(pdf.match.notes.join(" ")).toMatch(/No order number/);
  });

  it("the same email twice is one capture; the same invoice number twice from a supplier is flagged", async () => {
    const w = await world();
    const mail = { from: "a@acme.example", subject: "Invoice INV-5", text: "Total: $10.00", messageId: "same" };
    expect((await w.inbound(mail)).status).toBe(201);
    const again = await w.inbound(mail);
    expect(again.status).toBe(200);
    expect((await again.json()).duplicate).toBe(true);
    expect((await w.get("/b2b/invoices")).body).toHaveLength(1);
    await w.inbound({ ...mail, messageId: "other-mail" });
    const list = (await w.get("/b2b/invoices")).body;
    expect(list).toHaveLength(2);
    expect(list.filter((x: { match: { duplicateOf: string | null } }) => x.match.duplicateOf).length).toBeGreaterThanOrEqual(1);
  });

  it("refuses a wrong or missing secret, an unknown partner, bad bodies, and oversize files are not kept", async () => {
    const w = await world();
    const ok = { from: "a@acme.example", subject: "Invoice INV-9", text: "x", messageId: "k" };
    expect((await w.inbound(ok, "wrong")).status).toBe(422);
    expect((await w.inbound(ok, null)).status).toBe(422);
    expect((await w.inbound(ok, "inbox-secret-123", "0".repeat(24))).status).toBe(404);
    expect((await w.inbound({ attachments: "nope" })).status).toBe(422);
    delete process.env.TEST_INBOX_SECRET;
    expect((await w.inbound(ok)).status).toBe(422); // the partner's secret isn't configured on the server
    process.env.TEST_INBOX_SECRET = "inbox-secret-123";
    expect((await w.get("/b2b/invoices")).body).toHaveLength(0);
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1).toString("base64");
    const r = await w.inbound({ ...ok, messageId: "big", attachments: [{ filename: "big.pdf", contentType: "application/pdf", contentBase64: big }] });
    expect(r.status).toBe(413); // bodies over 2 MB are refused outright
    expect((await w.get("/b2b/invoices")).body).toHaveLength(0);
  });

  it("filenames can't smuggle path or header tricks into downloads", async () => {
    const w = await world();
    await w.inbound({ from: "a@x.example", subject: "Invoice INV-1", text: "x", messageId: "f", attachments: [{ filename: '../../etc/passwd"\r\nX-Evil: 1', contentType: "text/html\r\nX-Evil: 1", contentBase64: w.b64("<script>alert(1)</script>") }] });
    const c = (await w.get("/b2b/invoices")).body[0];
    expect(c.files[0].filename).not.toMatch(/[\/\r\n"]/);
    const dl = await w.get(`/b2b/files/${c.files[0].id}`);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("x-evil")).toBeNull();
  });
});

describe("working on a captured invoice", () => {
  async function captured() {
    const w = await world();
    await w.inbound({ from: "ar@acme.example", subject: "Invoice INV-42", text: "Total due: $4,700.00", messageId: "e1" });
    const c = (await w.get("/b2b/invoices")).body[0];
    return { ...w, c };
  }

  it("a correction is marked as entered by a person and audited; anyone can correct, only admins discard", async () => {
    const w = await captured();
    const fixed = await w.post(`/b2b/invoices/${w.c.id}`, { poNumber: "PO-0001", dueDate: "2026-12-01", totalCents: 470000 }, "member", "PATCH");
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ poNumber: "PO-0001", dueDate: "2026-12-01", confidence: { poNumber: "entered", dueDate: "entered", totalCents: "guess" } }); // total unchanged: still the guess
    expect(fixed.body.match.order.number).toBe("PO-0001");
    expect((await store.audit.find({ orgId: w.orgId, action: "b2b.invoice_edited" }).toArray())).toHaveLength(1);
    expect((await w.post(`/b2b/invoices/${w.c.id}`, { totalCents: -5 }, "member", "PATCH")).status).toBe(400);
    expect((await w.post(`/b2b/invoices/${w.c.id}`, { invoiceDate: "yesterday" }, "member", "PATCH")).status).toBe(400);
    expect((await w.post(`/b2b/invoices/${w.c.id}/discard`, {}, "member")).status).toBe(403);
    const gone = await w.post(`/b2b/invoices/${w.c.id}/discard`, { note: "Duplicate of INV-41" });
    expect(gone.body).toMatchObject({ status: "discarded" });
    expect((await w.post(`/b2b/invoices/${w.c.id}`, { note: "x" }, "owner", "PATCH")).status).toBe(409);
    expect((await w.post(`/b2b/invoices/${w.c.id}/discard`, {})).status).toBe(409);
    expect((await w.get("/b2b/invoices")).body).toHaveLength(0); // default list is what still needs a look
    expect((await w.get("/b2b/invoices?status=discarded")).body).toHaveLength(1);
    expect((await w.get("/b2b/invoices?status=banana")).status).toBe(400);
  });

  it("shapes what invoice entry would receive: items found on the order become stock lines in stored units, the rest one-unit lines; nothing is created", async () => {
    const w = await world();
    await w.inbound({ from: "b@acme.example", subject: "inv", text: "", messageId: "ubl", attachments: [{ filename: "i.xml", contentType: "application/xml", contentBase64: w.b64(UBL) }] });
    const c = (await w.get("/b2b/invoices")).body[0];
    const input = (await w.get(`/b2b/invoices/${c.id}/invoice-input`)).body;
    expect(input).toMatchObject({ supplierId: w.supplier, purchaseOrderId: w.po.id, invoiceNumber: "INV-2026-0042", issueDate: "2026-10-20", dueDate: "2026-11-19", currency: "USD", statedTotalCents: 470000, freightCents: 0 });
    expect(input.lines).toEqual([{ itemId: w.item, description: "KRAFT Kraft roll 42 lb", quantity: 10, unitPriceCents: 47000, taxCents: 0 }]);
    await w.post(`/b2b/invoices/${c.id}`, { lines: [{ description: "Freight surcharge", quantity: "1", unitPriceCents: 2500, lineTotalCents: 2500 }] }, "owner", "PATCH");
    expect((await w.get(`/b2b/invoices/${c.id}/invoice-input`)).body.lines[0]).toEqual({ itemId: null, description: "Freight surcharge", quantity: 1, unitPriceCents: 2500, taxCents: 0 });
    expect((await w.get("/b2b/invoices")).body).toHaveLength(1);
    expect((await w.post(`/b2b/invoices/${c.id}/converted`, { invoiceId: "0".repeat(24) }, "member")).status).toBe(403);
    expect((await w.post(`/b2b/invoices/${c.id}/converted`, { invoiceId: "0".repeat(24) })).body.status).toBe("converted");
  });

  it("what it shapes is what supplier-invoice entry takes: entered, three-way matched, and the capture closes", async () => {
    const w = await world();
    await w.inbound({ from: "b@acme.example", subject: "inv", text: "", messageId: "ubl2", attachments: [{ filename: "i.xml", contentType: "application/xml", contentBase64: w.b64(UBL) }] });
    const c = (await w.get("/b2b/invoices")).body[0];
    const input = (await w.get(`/b2b/invoices/${c.id}/invoice-input`)).body;
    const made = await w.post("/invoices", input);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ number: "INVC-0001", supplierId: w.supplier, purchaseOrderId: w.po.id, invoiceNumber: "INV-2026-0042", subtotalCents: 470000, totalCents: 470000, statedTotalCents: 470000, status: "draft" });
    // The order here is still a draft and nothing has arrived, so the match says both: a capture never becomes a payable by itself.
    expect(made.body.match.flags.map((f: { code: string }) => f.code).sort()).toEqual(["not_received", "po_not_open"]);
    expect((await w.post(`/b2b/invoices/${c.id}/converted`, { invoiceId: made.body.id })).body.status).toBe("converted");
    expect((await w.get("/b2b/invoices")).body).toHaveLength(0);
  });
});

describe("uploading an invoice at the desk", () => {
  it("a member uploads a file for a partner; JSON invoices are read exactly; the same file twice is refused; bad input is refused", async () => {
    const w = await world();
    const json = JSON.stringify({ invoiceNumber: "UP-1", issueDate: "2026-10-05", poNumber: "PO-0001", total: "4700.00" });
    const res = await w.post("/b2b/invoices/upload", { partnerId: w.partner.id, filename: "up1.json", contentType: "application/json", contentBase64: w.b64(json) }, "member");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: "json", invoiceNumber: "UP-1", totalCents: 470000, from: "Bob" });
    expect((await w.post("/b2b/invoices/upload", { partnerId: w.partner.id, filename: "up1.json", contentType: "application/json", contentBase64: w.b64(json) }, "member")).status).toBe(409);
    expect((await w.post("/b2b/invoices/upload", { partnerId: "0".repeat(24), filename: "x.pdf", contentType: "application/pdf", contentBase64: w.b64("x") })).status).toBe(404);
    expect((await w.post("/b2b/invoices/upload", { partnerId: w.partner.id, filename: "x.pdf", contentType: "application/pdf", contentBase64: "" })).status).toBe(400);
    expect((await w.post("/b2b/invoices/upload", { partnerId: w.partner.id, filename: "x.pdf", contentType: "application/pdf", contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") })).status).toBe(422);
  });

  it("other organizations can't see captured invoices or their files", async () => {
    const w = await world();
    await w.inbound({ from: "a@acme.example", subject: "Invoice INV-1", text: "x", messageId: "iso", attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64: w.b64("%PDF") }] });
    const c = (await w.get("/b2b/invoices")).body[0];
    const other = await signUp({ mode: "create", name: "Other" });
    const ob = `/api/orgs/${other.org.id}/b2b`;
    expect((await call(other.cookie, `${ob}/invoices`)).body).toEqual([]);
    expect((await call(other.cookie, `${ob}/invoices/${c.id}`)).status).toBe(404);
    expect((await call(other.cookie, `${ob}/files/${c.files[0].id}`)).status).toBe(404);
    expect((await call(other.cookie, `${w.base}/b2b/invoices`)).status).toBe(404);
  });
});
