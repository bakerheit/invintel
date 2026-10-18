import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { OutboxTransport, SmtpTransport, setMailTransport, type MailResult, type MailTransport } from "./mail.js";
import { buildMime } from "./mime.js";
import { buildCanonicalOrder, renderOrderPdf } from "./order-doc.js";
import { PdfDoc } from "./pdf.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
const outbox = mkdtempSync(path.join(os.tmpdir(), "invintel-test-outbox-"));
beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
  setMailTransport(new OutboxTransport(outbox));
});
afterAll(async () => {
  setMailTransport(null);
  await store.db.dropDatabase();
  await store.close();
});

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `e${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization, user: b.user };
}
const call = async (cookie: string, path: string, body?: unknown, method?: string) => {
  const res = await app.request(path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* not json */ }
  return { status: res.status, body: json, text: t, headers: res.headers };
};
const anon = async (path: string, body?: unknown) => {
  const res = await app.request(path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* not json */ }
  return { status: res.status, body: json };
};

// ---------- pure pieces ----------

const sampleOrder = (lines = 3, extra: Partial<{ name: string; note: string }> = {}) =>
  buildCanonicalOrder(
    {
      id: "x", number: "PO-0007", status: "ordered", closedShort: false, supplierId: "s", supplierName: "Acme Paper (Pty) Ltd", expectedDate: "2026-11-15", note: extra.note ?? "Deliver to dock 2",
      lines: Array.from({ length: lines }, (_, i) => ({ itemId: `i${i}`, itemSku: `SKU-${i + 1}`, itemName: extra.name ?? `Kraft roll ${i + 1} (42 lb) & "special" \\ item`, uom: { unit: "kg", decimals: 3 }, quantity: 12_500 + i, unitCostCents: 480, received: 0 })),
      totalCents: 0, orderedUnits: 0, receivedUnits: 0, createdAt: "", updatedAt: "",
    } as never,
    { buyerName: "Buyer Co", supplierContact: "Sam", supplierEmail: "orders@acme.example", portalUrl: "https://example.test/b2b/s/abc", now: new Date("2026-10-18T12:00:00Z") },
  );

describe("the canonical order and its PDF", () => {
  it("keeps quantities as exact decimal text in the item's unit and prices exactly", () => {
    const o = sampleOrder(2);
    expect(o.lines[0]).toMatchObject({ lineNo: 1, sku: "SKU-1", quantity: "12.500", unit: "kg", unitPriceCents: 480, lineTotalCents: 6000 });
    expect(o.lines[1]!.quantity).toBe("12.501");
    expect(o.issuedAt).toBe("2026-10-18");
  });

  it("makes a valid PDF: header, trailer, cross-reference offsets that point at the objects, text a person can read", () => {
    const pdf = renderOrderPdf(sampleOrder(3)).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(pdf)![1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    const entries = [...pdf.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((off, i) => expect(pdf.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(pdf).toContain("PO-0007");
    expect(pdf).toContain("PURCHASE ORDER");
    expect(pdf).toContain("Acme Paper \\(Pty\\) Ltd"); // parentheses escaped
    expect(pdf).toContain("12.500 kg");
    expect(pdf).toContain("(Requested delivery date:)");
    expect(pdf).toContain("(2026-11-15)");
    expect(pdf).toContain("https://example.test/b2b/s/abc");
    expect(pdf).toMatch(/\/Count 1/);
  });

  it("runs to more pages for long orders, and survives odd characters in names", () => {
    const pdf = renderOrderPdf(sampleOrder(70, { name: "Emoji 🎉 and ünïcode — “quotes”" })).toString("latin1");
    expect(pdf).toMatch(/\/Count 3/);
    const start = Number(/startxref\n(\d+)\n/.exec(pdf)![1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    expect(pdf).toContain("\\"); // escapes present
    expect(pdf).not.toMatch(/[^\x00-\xff]/);
  });

  it("the writer escapes backslashes and parentheses and never writes characters outside the file's encoding", () => {
    const d = new PdfDoc();
    d.text(10, 10, "a\\b (c) ☃");
    const out = d.toBuffer().toString("latin1");
    expect(out).toContain("(a\\\\b \\(c\\) ?)");
  });
});

describe("building emails", () => {
  const base = { from: "orders@buyer.example", to: ["orders@acme.example"], subject: "PO-1", text: "Hello\nthere" };

  it("builds a multipart message with the attachment intact", () => {
    const pdf = Buffer.from("%PDF-fake-content-" + "x".repeat(200));
    const { raw, messageId } = buildMime({ ...base, attachments: [{ filename: "PO-1.pdf", contentType: "application/pdf", content: pdf }] });
    expect(raw).toContain("Content-Type: multipart/mixed");
    expect(raw).toContain(`Message-ID: ${messageId}`);
    const b64 = /filename="PO-1.pdf"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)![1]!.replace(/\r\n/g, "");
    expect(Buffer.from(b64, "base64").equals(pdf)).toBe(true);
    expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });

  it("encodes non-ASCII subjects", () => {
    const { raw } = buildMime({ ...base, subject: "Bestellung für Müller" });
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it("refuses anything that could add headers or recipients", () => {
    expect(() => buildMime({ ...base, subject: "Hi\r\nBcc: evil@x.example" })).toThrow(/line breaks/);
    expect(() => buildMime({ ...base, to: ["a@b.example\r\nBcc: evil@x.example"] })).toThrow(/line breaks/);
    expect(() => buildMime({ ...base, to: ["not an address"] })).toThrow(/isn't an email/);
    expect(() => buildMime({ ...base, to: [] })).toThrow(/no recipient/);
    expect(() => buildMime({ ...base, attachments: [{ filename: "a.pdf\r\nX: y", contentType: "application/pdf", content: Buffer.from("x") }] })).toThrow(/line breaks/);
    expect(() => buildMime({ ...base, attachments: [{ filename: "a.pdf", contentType: "text/plain\r\nX: y", content: Buffer.from("x") }] })).toThrow(/line breaks/);
  });
});

// ---------- SMTP against a local fake server ----------

interface Fake { port: number; received: { from: string; rcpt: string[]; data: string }[]; close(): Promise<void> }
function fakeSmtp(opts: { rcptReply?: string; dataReply?: string; authRequired?: boolean; hang?: boolean } = {}): Promise<Fake> {
  const received: Fake["received"] = [];
  const server = net.createServer((sock) => {
    if (opts.hang) return;
    let buf = "";
    let mode: "cmd" | "data" = "cmd";
    let cur = { from: "", rcpt: [] as string[], data: "" };
    sock.write("220 fake.example ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const i = buf.indexOf("\r\n.\r\n");
          if (i < 0) return;
          cur.data = buf.slice(0, i);
          buf = buf.slice(i + 5);
          mode = "cmd";
          if ((opts.dataReply ?? "250").startsWith("250")) received.push(cur);
          sock.write(`${opts.dataReply ?? "250 queued as 1"}\r\n`);
          cur = { from: "", rcpt: [], data: "" };
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write("250-fake.example\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (/^AUTH PLAIN/i.test(line)) sock.write("235 ok\r\n");
        else if (/^MAIL FROM/i.test(line)) { cur.from = /<(.*)>/.exec(line)![1]!; sock.write("250 ok\r\n"); }
        else if (/^RCPT TO/i.test(line)) {
          const reply = opts.rcptReply ?? "250 ok";
          if (reply.startsWith("250")) cur.rcpt.push(/<(.*)>/.exec(line)![1]!);
          sock.write(`${reply}\r\n`);
        } else if (/^DATA/i.test(line)) { mode = "data"; sock.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("500 what\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => new Promise((r) => { server.close(() => r()); }) })));
}
const mail = { from: "orders@buyer.example", to: ["orders@acme.example"], subject: "PO-9", text: "Line one\n.leading dot line\nEnd", attachments: [{ filename: "PO-9.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-x") }] };

describe("SMTP transport", () => {
  it("delivers a message: envelope, headers, attachment, and lines that start with a dot", async () => {
    const f = await fakeSmtp();
    const res = await new SmtpTransport({ host: "127.0.0.1", port: f.port, secure: false }).send(mail);
    await f.close();
    expect(res.ok).toBe(true);
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ from: "orders@buyer.example", rcpt: ["orders@acme.example"] });
    expect(f.received[0]!.data).toContain("Subject: PO-9");
    expect(f.received[0]!.data).toContain("filename=\"PO-9.pdf\"");
  });

  it("a rejected recipient (5xx) is a permanent failure; a busy server (4xx) is temporary", async () => {
    const perm = await fakeSmtp({ rcptReply: "550 No such user" });
    const a = await new SmtpTransport({ host: "127.0.0.1", port: perm.port, secure: false }).send(mail);
    await perm.close();
    expect(a).toMatchObject({ ok: false, retryable: false });
    expect(!a.ok && a.error).toContain("550");
    const temp = await fakeSmtp({ dataReply: "451 Try later" });
    const b = await new SmtpTransport({ host: "127.0.0.1", port: temp.port, secure: false }).send(mail);
    await temp.close();
    expect(b).toMatchObject({ ok: false, retryable: true });
  });

  it("a server that is down or silent is a temporary failure", async () => {
    const down = await new SmtpTransport({ host: "127.0.0.1", port: 1, secure: false }).send(mail);
    expect(down).toMatchObject({ ok: false, retryable: true });
    const silent = await fakeSmtp({ hang: true });
    const t = await new SmtpTransport({ host: "127.0.0.1", port: silent.port, secure: false, timeoutMs: 300 }).send(mail);
    await silent.close();
    expect(t).toMatchObject({ ok: false, retryable: true });
  });

  it("won't send a password over an unencrypted connection", async () => {
    const f = await fakeSmtp();
    const res = await new SmtpTransport({ host: "127.0.0.1", port: f.port, secure: false, user: "u", pass: "p" }).send(mail);
    await f.close();
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(f.received).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain('"p"');
  });
});

// ---------- the order flow ----------

async function world(opts: { transport?: MailTransport } = {}) {
  if (opts.transport) setMailTransport(opts.transport);
  else setMailTransport(new OutboxTransport(outbox));
  const owner = await signUp({ mode: "create", name: "Buyer Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call((who === "owner" ? owner : member).cookie, `${base}${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const main = (await get("/locations")).body[0].id as string;
  const item = (await post("/items", { sku: "KRAFT", name: "Kraft roll", unitCostCents: 48000 })).body.id as string;
  const supplier = (await post("/purchasing/suppliers", { name: "Acme Paper", contact: "Sam", email: "sam@acme.example" })).body.id as string;
  const partner = (await post("/b2b/partners", { name: "Acme Paper", kind: "supplier", supplierId: supplier, bridge: "email", bridgeConfig: { to: "orders@acme.example" } })).body;
  const po = (await post("/purchasing/orders", { supplierId: supplier, expectedDate: "2026-11-20", note: "Dock 2 please", lines: [{ itemId: item, quantity: 10, unitCostCents: 47000 }] })).body;
  const place = () => post(`/purchasing/orders/${po.id}/place`, {});
  const filesBefore = readdirSync(outbox).length;
  return { owner, member, base, post, get, main, item, supplier, partner, po, place, orgId: new ObjectId(owner.org.id), newFiles: () => readdirSync(outbox).sort().slice(filesBefore) };
}
const tokenOf = (url: string) => url.split("/").pop()!;

describe("sending a purchase order by email", () => {
  it("emails the PDF and a private link, logs the message, and shows the buyer what happened", async () => {
    const w = await world();
    expect((await w.post(`/b2b/orders/${w.po.id}/send`, {})).status).toBe(409); // still a draft
    await w.place();
    expect((await w.post(`/b2b/orders/${w.po.id}/send`, {}, "member")).status).toBe(403);
    const res = await w.post(`/b2b/orders/${w.po.id}/send`, {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ docType: "order", direction: "out", state: "sent", correlation: { poNumber: w.po.number } });
    const files = w.newFiles();
    expect(files).toHaveLength(1);
    const eml = readFileSync(path.join(outbox, files[0]!), "utf8");
    expect(eml).toContain("To: orders@acme.example");
    expect(eml).toMatch(/Subject: Purchase order PO-\d+ from Buyer Co \(TEST\)/); // a test partner says so
    expect(eml).toContain(`filename="${w.po.number}.pdf"`);
    const text = Buffer.from(/base64\r\n\r\n([\s\S]*?)\r\n--/.exec(eml)![1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(text).toContain("Kraft roll");
    expect(text).toMatch(/https?:\/\/[^\s]+\/b2b\/s\/[A-Za-z0-9_-]{40,}/);
    const ex = (await w.get(`/b2b/orders/${w.po.id}`, "member")).body;
    expect(ex).toMatchObject({ partner: { name: "Acme Paper", bridge: "email", mode: "test" }, lastMessage: { state: "sent" }, confirmed: false });
    expect(ex.portalUrl).toMatch(/\/b2b\/s\//);
    // only admins can read the raw document (it contains the private link)
    expect((await w.get(`/b2b/messages/${res.body.id}`, "member")).body.body).toBe("");
    expect((await w.get(`/b2b/messages/${res.body.id}`)).body.body).toContain(w.po.number);
  });

  it("previews the PDF without sending, and says what is missing", async () => {
    const w = await world();
    const pdf = await w.get(`/b2b/orders/${w.po.id}/preview.pdf`, "member");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.text.startsWith("%PDF-1.4")).toBe(true);
    expect(w.newFiles()).toHaveLength(0);
    const lone = await signUp({ mode: "create", name: "Lone" });
    const lb = `/api/orgs/${lone.org.id}`;
    const sup = (await call(lone.cookie, `${lb}/purchasing/suppliers`, { name: "Nobody" })).body.id;
    const it = (await call(lone.cookie, `${lb}/items`, { sku: "X", name: "X" })).body.id;
    const p2 = (await call(lone.cookie, `${lb}/purchasing/orders`, { supplierId: sup, lines: [{ itemId: it, quantity: 1, unitCostCents: 1 }] })).body;
    await call(lone.cookie, `${lb}/purchasing/orders/${p2.id}/place`, {});
    const noPartner = await call(lone.cookie, `${lb}/b2b/orders/${p2.id}/send`, {});
    expect(noPartner.status).toBe(409);
    expect(noPartner.body.error).toMatch(/trading partner/);
    expect((await call(lone.cookie, `${lb}/b2b/orders/${"0".repeat(24)}/send`, {})).status).toBe(404);
  });

  it("a bad address is a permanent failure; a mail server hiccup can be retried and keeps the same message", async () => {
    const w = await world();
    await w.place();
    await w.post(`/b2b/partners/${w.partner.id}`, { bridgeConfig: { to: "not-an-address" } }, "owner", "PATCH");
    const bad = await w.post(`/b2b/orders/${w.po.id}/send`, {});
    expect(bad.body.state).toBe("failed");
    expect(bad.body.attempts[0]).toMatchObject({ ok: false, retryable: false });
    expect((await w.post(`/b2b/messages/${bad.body.id}/retry`, {})).status).toBe(409);

    let calls = 0;
    const flaky: MailTransport = { kind: "test", async send(): Promise<MailResult> { calls++; return calls === 1 ? { ok: false, error: "451 try later", retryable: true } : { ok: true, messageId: "<ok@test>", where: "test" }; } };
    const w2 = await world({ transport: flaky });
    await w2.place();
    const first = await w2.post(`/b2b/orders/${w2.po.id}/send`, {});
    expect(first.body.state).toBe("failed");
    const again = await w2.post(`/b2b/orders/${w2.po.id}/send`, {}); // sending again retries the failed message
    expect(again.body).toMatchObject({ id: first.body.id, state: "sent" });
    expect(again.body.attempts.map((a: { ok: boolean }) => a.ok)).toEqual([false, true]);
    setMailTransport(new OutboxTransport(outbox));
  });

  it("sending again after it went through makes revision 2 with a new link, and the old link stops working", async () => {
    const w = await world();
    await w.place();
    const one = (await w.post(`/b2b/orders/${w.po.id}/send`, {})).body;
    const url1 = (await w.get(`/b2b/orders/${w.po.id}`)).body.portalUrl as string;
    const two = await w.post(`/b2b/orders/${w.po.id}/send`, {});
    expect(two.body.id).not.toBe(one.id);
    const url2 = (await w.get(`/b2b/orders/${w.po.id}`)).body.portalUrl as string;
    expect(url2).not.toBe(url1);
    expect((await anon(`/api/b2b/portal/${tokenOf(url1)}`)).status).toBe(404);
    expect((await anon(`/api/b2b/portal/${tokenOf(url2)}`)).status).toBe(200);
    const eml = readFileSync(path.join(outbox, w.newFiles().pop()!), "utf8");
    const text = Buffer.from(/base64\r\n\r\n([\s\S]*?)\r\n--/.exec(eml)![1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(text).toContain("revision 2");
  });
});

describe("the supplier's page", () => {
  async function sent() {
    const w = await world();
    await w.place();
    await w.post(`/b2b/orders/${w.po.id}/send`, {});
    const url = (await w.get(`/b2b/orders/${w.po.id}`)).body.portalUrl as string;
    return { ...w, token: tokenOf(url), page: (t = tokenOf(url)) => anon(`/api/b2b/portal/${t}`), answer: (b: unknown, t = tokenOf(url)) => anon(`/api/b2b/portal/${t}/answer`, b) };
  }

  it("shows the order and nothing else of ours", async () => {
    const w = await sent();
    const page = await w.page();
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ buyerName: "Buyer Co", poNumber: w.po.number, supplierName: "Acme Paper", open: true, expectedDate: "2026-11-20", note: "Dock 2 please", answers: [] });
    expect(page.body.lines[0]).toMatchObject({ sku: "KRAFT", quantity: "10", unitPriceCents: 47000, lineTotalCents: 470000 });
    const keys = Object.keys(page.body).sort();
    expect(keys).toEqual(["answers", "buyerName", "expectedDate", "lines", "note", "open", "expiresAt", "poNumber", "supplierName", "totalCents"].sort());
    expect((await w.page("short")).status).toBe(404);
    expect((await w.page("A".repeat(43))).status).toBe(404);
  });

  it("confirm with a promised date acknowledges the sent order and shows on the buyer's side", async () => {
    const w = await sent();
    expect((await w.answer({ action: "confirm", promisedDate: "2026-11-18", note: "Will ship on the 18th" })).status).toBe(201);
    const ex = (await w.get(`/b2b/orders/${w.po.id}`)).body;
    expect(ex).toMatchObject({ confirmed: true, rejected: false, promisedDate: "2026-11-18", note: "Will ship on the 18th", lastMessage: { state: "acknowledged" } });
    const inbound = (await w.get("/b2b/messages?direction=in")).body;
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ docType: "order_response", state: "received", correlation: { poNumber: w.po.number } });
    expect((await w.page()).body.answers[0]).toMatchObject({ action: "confirm", promisedDate: "2026-11-18" });
    expect((await store.audit.find({ orgId: w.orgId, action: "b2b.order_answered" }).toArray())).toHaveLength(1);
  });

  it("a supplier can decline with a reason, then later confirm; the latest decision wins on the order", async () => {
    const w = await sent();
    expect((await w.answer({ action: "reject" })).status).toBe(400); // a reason is required
    expect((await w.answer({ action: "reject", note: "Out of stock" })).status).toBe(201);
    expect((await w.get(`/b2b/orders/${w.po.id}`)).body).toMatchObject({ rejected: true, confirmed: false, note: "Out of stock", lastMessage: { state: "rejected" } });
    expect((await w.answer({ action: "confirm", promisedDate: "2026-12-01" })).status).toBe(201);
    const ex = (await w.get(`/b2b/orders/${w.po.id}`)).body;
    expect(ex).toMatchObject({ confirmed: true, rejected: false, promisedDate: "2026-12-01" });
    expect(ex.lastMessage.state).toBe("rejected"); // the first business answer settled the message; the later one is a new inbound message
    expect((await w.get("/b2b/messages?direction=in")).body).toHaveLength(2);
  });

  it("a ship notice records date, carrier and tracking as a despatch advice", async () => {
    const w = await sent();
    expect((await w.answer({ action: "ship" })).status).toBe(400);
    expect((await w.answer({ action: "ship", shipDate: "next week" })).status).toBe(400);
    expect((await w.answer({ action: "ship", shipDate: "2026-11-17", carrier: "FastFreight", trackingNumber: "FF-12345" })).status).toBe(201);
    expect((await w.get(`/b2b/orders/${w.po.id}`)).body).toMatchObject({ shipDate: "2026-11-17", carrier: "FastFreight", trackingNumber: "FF-12345" });
    expect((await w.get("/b2b/messages?direction=in")).body[0].docType).toBe("despatch_advice");
  });

  it("refuses expired, revoked and closed orders, bad answers, and strangers", async () => {
    const w = await sent();
    expect((await w.answer({ action: "dance" })).status).toBe(400);
    expect((await w.answer({ action: "confirm", promisedDate: "tomorrow" })).status).toBe(400);
    // closed order
    expect((await w.post(`/purchasing/orders/${w.po.id}/cancel`, {})).status).toBe(200);
    const closed = await w.answer({ action: "confirm" });
    expect(closed.status).toBe(409);
    expect((await w.page()).body.open).toBe(false);
    // expired link
    await store.portalLinks.updateMany({ orgId: w.orgId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await w.page()).status).toBe(404);
    expect((await w.answer({ action: "confirm" })).status).toBe(404);
    // a partner that is switched off can't be answered for
    const w2 = await sent();
    await w2.post(`/b2b/partners/${w2.partner.id}`, { enabled: false }, "owner", "PATCH");
    expect((await w2.answer({ action: "confirm" })).status).toBe(404);
  });
});
