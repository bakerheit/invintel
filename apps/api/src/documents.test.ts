import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";
import { renderDocPdf, type DocContext, type DocSpec } from "./doc-pdf.js";
import { plainContext } from "./doc-render.js";
import { MAX_LOGO_BYTES, readImage } from "./image.js";
import { OutboxTransport, setMailTransport } from "./mail.js";
import { PdfDoc } from "./pdf.js";
import { taxOn } from "./sales-docs.js";
import { readX12 } from "./x12-maps.js";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;
const outbox = mkdtempSync(path.join(os.tmpdir(), "invintel-inv17-outbox-"));
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

// ---------- helpers ----------

let n = 0;
async function signUp(organization: object, name = "Ada") {
  const res = await app.request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `dc${++n}@example.com`, password: "correct horse", organization }) });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const raw = (cookie: string, p: string, body?: unknown, method?: string) =>
  app.request(p, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (cookie: string, p: string, body?: unknown, method?: string) => {
  const res = await raw(cookie, p, body, method);
  const t = await res.text();
  let json: any;
  try { json = t ? JSON.parse(t) : undefined; } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers };
};
/** All the text a PDF draws, in order, so tests can read what a person would. */
const textOf = (pdf: Buffer | string) => [...(Buffer.isBuffer(pdf) ? pdf.toString("latin1") : pdf).matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]!.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, "$1")).join("\n");

// A PNG encoder for tests: real chunks, real CRCs, any colour type and filter.
const CRC_T = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_T[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "latin1"), data]); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body)); return Buffer.concat([head, body, tail]); };
function png(w: number, h: number, ct: number, rows: Buffer[], opts: { depth?: number; interlace?: number; plte?: Buffer; trns?: Buffer; filters?: number[]; extra?: Buffer[] } = {}): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = opts.depth ?? 8; ihdr[9] = ct; ihdr[12] = opts.interlace ?? 0;
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const bpp = Math.max(1, (channels * (opts.depth ?? 8)) >> 3);
  const out: Buffer[] = [];
  rows.forEach((row, y) => {
    const f = opts.filters?.[y] ?? 0;
    const prev = y > 0 ? rows[y - 1]! : Buffer.alloc(row.length);
    const enc = Buffer.alloc(row.length);
    for (let x = 0; x < row.length; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0, b = prev[x]!, c = x >= bpp ? prev[x - bpp]! : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      enc[x] = (row[x]! - pred) & 255;
    }
    out.push(Buffer.from([f]), enc);
  });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(opts.plte ? [chunk("PLTE", opts.plte)] : []), ...(opts.trns ? [chunk("tRNS", opts.trns)] : []), ...(opts.extra ?? []), chunk("IDAT", deflateSync(Buffer.concat(out))), chunk("IEND", Buffer.alloc(0))]);
}
const rgbRows = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => f(x, y)).flat()));
const logoPng = () => png(40, 20, 2, rgbRows(40, 20, (x, y) => [x * 6, y * 12, 120]));
/** A JPEG with the structure of a real one (not drawable, but it has every marker a reader checks). */
const jpeg = (opts: { w?: number; h?: number; comps?: number; precision?: number; sof?: number; adobe?: number; noEoi?: boolean } = {}) => {
  const sof = Buffer.from([0xff, opts.sof ?? 0xc0, 0, 8 + 3 * (opts.comps ?? 3), opts.precision ?? 8, (opts.h ?? 20) >> 8, (opts.h ?? 20) & 255, (opts.w ?? 40) >> 8, (opts.w ?? 40) & 255, opts.comps ?? 3, ...Array.from({ length: (opts.comps ?? 3) * 3 }, (_, i) => (i % 3 === 0 ? i / 3 + 1 : 0x11))]);
  const adobe = opts.adobe !== undefined ? Buffer.concat([Buffer.from([0xff, 0xee, 0, 14]), Buffer.from("Adobe"), Buffer.from([0, 100, 0, 0, 0, 0, opts.adobe])]) : Buffer.alloc(0);
  const sos = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), adobe, sof, sos, Buffer.from([1, 2, 3, 4, 5]), opts.noEoi ? Buffer.alloc(0) : Buffer.from([0xff, 0xd9])]);
};

// ---------- logos ----------

describe("logo images: strict, small, only PNG and JPEG", () => {
  it("reads a PNG as plain pixels, whatever the colour type or row filters", () => {
    const px = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * 101 + y) & 255];
    const rows = rgbRows(9, 6, px);
    for (const filters of [[0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2], [3, 3, 3, 3, 3, 3], [4, 4, 4, 4, 4, 4], [0, 1, 2, 3, 4, 0]]) {
      const r = readImage(png(9, 6, 2, rows, { filters }));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.pdf).toMatchObject({ width: 9, height: 6, colorSpace: "DeviceRGB", filter: "FlateDecode" });
      expect([...inflateSync(r.pdf.data)]).toEqual(rows.flatMap((row) => [...row])); // exactly the pixels that went in
    }
  });

  it("grey stays grey; transparency is flattened onto white; palettes of any depth are read", () => {
    const grey = readImage(png(4, 2, 0, [Buffer.from([0, 64, 128, 255]), Buffer.from([255, 128, 64, 0])]));
    expect(grey.ok && grey.pdf.colorSpace).toBe("DeviceGray");
    // RGBA: fully transparent red -> white, half transparent black -> mid grey, opaque stays
    const rgba = readImage(png(3, 1, 6, [Buffer.from([255, 0, 0, 0, 0, 0, 0, 128, 10, 20, 30, 255])]));
    expect(rgba.ok && [...inflateSync(rgba.pdf.data)]).toEqual([255, 255, 255, 127, 127, 127, 10, 20, 30]);
    const ga = readImage(png(2, 1, 4, [Buffer.from([0, 0, 200, 255])]));
    expect(ga.ok && [...inflateSync(ga.pdf.data)]).toEqual([255, 200]);
    // 2-bit palette with one transparent entry: indexes 0,1,2,3 in one byte
    const pal = readImage(png(4, 1, 3, [Buffer.from([0b00011011])], { depth: 2, plte: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 10, 10]), trns: Buffer.from([0]) }));
    expect(pal.ok && [...inflateSync(pal.pdf.data)]).toEqual([255, 255, 255, 0, 255, 0, 0, 0, 255, 10, 10, 10]);
    // a colour key makes that colour transparent
    const key = readImage(png(2, 1, 2, [Buffer.from([1, 2, 3, 9, 9, 9])], { trns: Buffer.from([0, 1, 0, 2, 0, 3]) }));
    expect(key.ok && [...inflateSync(key.pdf.data)]).toEqual([255, 255, 255, 9, 9, 9]);
  });

  it("refuses PNGs that are damaged, unsafe or unsupported, each with a reason a person can act on", () => {
    const ok = logoPng();
    const err = (b: Buffer) => { const r = readImage(b); return r.ok ? "ok" : r.error; };
    expect(err(ok)).toBe("ok");
    const flip = (at: number) => { const b = Buffer.from(ok); b[at] = b[at]! ^ 0xff; return b; };
    expect(err(flip(20))).toMatch(/damaged/); // inside IHDR: its checksum no longer matches
    expect(err(flip(ok.length - 20))).toMatch(/damaged|wrong size|too large/);
    expect(err(ok.subarray(0, ok.length - 5))).toMatch(/cut short/);
    expect(err(Buffer.concat([ok, Buffer.from("junk")]))).toMatch(/after its end|cut short/);
    expect(err(png(4, 4, 2, rgbRows(4, 4, () => [1, 2, 3]), { interlace: 1 }))).toMatch(/Interlaced/);
    expect(err(png(4, 4, 2, rgbRows(4, 4, () => [1, 2, 3]), { depth: 16 }))).toMatch(/8-bit/);
    expect(err(png(4, 1, 3, [Buffer.from([0])], { depth: 8 }))).toMatch(/colour table/); // a palette image with no palette
    expect(err(png(4, 4, 2, rgbRows(4, 4, () => [1, 2, 3]), { extra: [chunk("ABCD", Buffer.alloc(0))] }))).toMatch(/isn't supported \(ABCD\)/); // unknown critical chunk
    expect(err(png(4, 4, 2, rgbRows(4, 4, () => [1, 2, 3]), { extra: [chunk("tEXt", Buffer.from("k\0v"))] }))).toBe("ok"); // a harmless ancillary chunk is ignored
    // pixel data that doesn't match the size it claims
    const lie = Buffer.from(png(4, 4, 2, rgbRows(4, 4, () => [1, 2, 3])));
    expect(err(png(5000, 4, 2, rgbRows(1, 4, () => [1, 2, 3])))).toMatch(/pixels each way/);
    expect(err(png(40, 40, 2, rgbRows(4, 4, () => [1, 2, 3])))).toMatch(/wrong size|damaged|too large/);
    void lie;
  });

  it("a PNG that inflates to far more than it claims is refused without being expanded", () => {
    // 1x1 image whose data stream is 50 MB of zeros: the declared size is 4 bytes, so inflating must stop almost at once
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(50_000_000))), chunk("IEND", Buffer.alloc(0))]);
    expect(bomb.length).toBeLessThan(MAX_LOGO_BYTES);
    const t = Date.now();
    const r = readImage(bomb);
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("reads JPEGs by structure, and refuses CMYK, 12-bit, arithmetic-coded and cut-off ones", () => {
    const r = readImage(jpeg({ w: 300, h: 100 }));
    expect(r.ok && r).toMatchObject({ kind: "jpeg", contentType: "image/jpeg", width: 300, height: 100, pdf: { colorSpace: "DeviceRGB", filter: "DCTDecode" } });
    expect(readImage(jpeg({ comps: 1 })).ok).toBe(true);
    expect(readImage(jpeg({ sof: 0xc2 })).ok).toBe(true); // progressive
    const err = (b: Buffer) => { const x = readImage(b); return x.ok ? "ok" : x.error; };
    expect(err(jpeg({ comps: 4 }))).toMatch(/grey or RGB/);
    expect(err(jpeg({ adobe: 2 }))).toMatch(/CMYK/);
    expect(err(jpeg({ precision: 12 }))).toMatch(/8-bit/);
    expect(err(jpeg({ sof: 0xc9 }))).toMatch(/standard/);
    expect(err(jpeg({ noEoi: true }))).toMatch(/cut short/);
    expect(err(jpeg({ w: 4000 }))).toMatch(/pixels each way/);
    expect(err(jpeg({ w: 0 }))).toMatch(/pixels each way/);
    expect(err(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toMatch(/valid JPEG/);
    const lieLen = Buffer.from(jpeg()); lieLen[4] = 0xff; lieLen[5] = 0xff; // a segment that claims to run past the file
    expect(err(lieLen)).toMatch(/damaged|cut short/);
  });

  it("refuses everything else by what the bytes are, not what the file says: SVG, GIF, scripts, empty, too big", () => {
    const err = (b: Buffer) => { const x = readImage(b); return x.ok ? "ok" : x.error; };
    expect(err(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toMatch(/Only PNG and JPEG/);
    expect(err(Buffer.from("GIF89a\x01\x00\x01\x00"))).toMatch(/Only PNG and JPEG/);
    expect(err(Buffer.from("<?xml version='1.0'?><svg/>"))).toMatch(/Only PNG and JPEG/);
    expect(err(Buffer.alloc(0))).toMatch(/empty/);
    expect(err(Buffer.concat([logoPng(), Buffer.alloc(MAX_LOGO_BYTES)]))).toMatch(/too big/);
    let seed = 9;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const base of [logoPng(), jpeg()]) {
      for (let i = 0; i < 300; i++) {
        const b = Buffer.from(base);
        for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
        const cut = rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
        expect(() => readImage(cut)).not.toThrow(); // never throws, whatever it is given
      }
    }
  });
});

// ---------- the PDF writer and the layout ----------

describe("the PDF writer", () => {
  it("writes a valid file: cross-reference offsets point at the objects, paper size and colours and images are as asked", () => {
    for (const [paper, w, h] of [["a4", 595, 842], ["letter", 612, 792]] as const) {
      const doc = new PdfDoc(paper);
      doc.addPage();
      doc.rect(10, 10, 100, 20, "#1d4ed8");
      doc.text(20, 40, "Café (déjà vu) \\ ok €", { color: "#b91c1c", bold: true });
      const img = readImage(logoPng());
      if (!img.ok) throw new Error("setup");
      doc.image(img.pdf, 10, 60, 80, 40);
      const buf = doc.toBuffer({ title: "T", author: "A" });
      const s = buf.toString("latin1");
      expect(s.startsWith("%PDF-1.4")).toBe(true);
      expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
      expect(s).toContain(`/MediaBox [0 0 ${w} ${h}]`);
      expect(s).toContain("0.114 0.306 0.847 rg"); // #1d4ed8
      expect(s).toContain("/Subtype /Image");
      expect(s).toContain("/Im1 Do");
      const start = Number(/startxref\n(\d+)\n/.exec(s)![1]);
      expect(s.slice(start, start + 4)).toBe("xref");
      const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
      entries.forEach((off, i) => expect(s.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
      expect(textOf(buf)).toContain("Caf\xe9 (d\xe9j\xe0 vu)"); // WinAnsi: é survives as one byte
    }
  });

  it("measures real Helvetica widths, wraps and breaks over-long words, and cuts to fit with an ellipsis", () => {
    const d = new PdfDoc();
    const width = (s: string) => d.wrap(s, 1e9, 10)[0]!.length;
    expect(width("abc")).toBe(3);
    const lines = d.wrap("a short line that needs to wrap at some point because it is long", 120, 10);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(" ")).toBe("a short line that needs to wrap at some point because it is long");
    const broken = d.wrap("W".repeat(80), 100, 10); // one word wider than the line is broken, never run off the page
    expect(broken.length).toBeGreaterThan(3);
    expect(broken.join("")).toBe("W".repeat(80));
    expect(d.fit("A very long description of a part", 80, 9)).toMatch(/…$/);
    expect(d.fit("Short", 80, 9)).toBe("Short");
  });
});

describe("the document layout", () => {
  const spec = (rows: number, extra: Partial<DocSpec> = {}): DocSpec => ({
    number: "PO-0042", meta: [["Issued", "2026-11-02"]], parties: [{ heading: "To (supplier)", lines: ["Sample Mill", "Sam", "sam@mill.example"] }], facts: [["Requested delivery date", "2026-11-20"]],
    columns: [{ key: "sku", header: "Part number", align: "left" }, { key: "description", header: "Description", align: "left" }, { key: "quantity", header: "Quantity", align: "right" }, { key: "unitPrice", header: "Unit price", align: "right" }, { key: "amount", header: "Amount", align: "right" }],
    rows: Array.from({ length: rows }, (_, i) => ({ sku: `SKU-${String(i + 1).padStart(3, "0")}`, description: `Item number ${i + 1} with a description`, quantity: "5 ea", unitPrice: "$1.00", amount: "$5.00" })),
    totals: [{ label: "Total", value: "$5.00 USD", strong: true }], ...extra,
  });
  const ctx = (over: Partial<DocContext["template"]> = {}, company: Partial<DocContext["company"]> = {}): DocContext => ({
    ...plainContext("purchase_order", "Plant Co", { template: over, company }), logo: null,
  });

  it("continues a long table on more pages with the header repeated, every row once, and a page number on each page", () => {
    const pdf = renderDocPdf(spec(120), ctx({ footer: "Thank you for your business" }));
    const s = pdf.toString("latin1");
    const pages = (s.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(4);
    const t = textOf(pdf);
    for (let i = 1; i <= 120; i++) expect(t.split("\n").filter((l) => l === `SKU-${String(i).padStart(3, "0")}`)).toHaveLength(1);
    expect(t.split("\n").filter((l) => l === "Part number")).toHaveLength(pages); // the table header on every page
    for (let p = 1; p <= pages; p++) expect(t).toContain(`Page ${p} of ${pages}`);
    expect(t.split("\n").filter((l) => /\(continued\)/.test(l))).toHaveLength(pages - 1);
    expect(t.split("\n").filter((l) => l === "Thank you for your business")).toHaveLength(pages);
    expect(t.indexOf("Total")).toBeGreaterThan(t.indexOf("SKU-120")); // totals after the last row
  });

  it("applies the template: title, accent, which columns, terms, footer; and the letterhead", () => {
    const pdf = renderDocPdf(spec(3), ctx({ title: "Order form", accent: "#15803d", columns: ["sku", "quantity"], terms: "Payment within 30 days of invoice.", footer: "Questions? Call us" }, { name: "Plant Co", addressLines: ["1 Mill Road", "Springfield"], phone: "555-0100", email: "hi@plant.example", taxId: "TAX-123" }));
    const t = textOf(pdf);
    const s = pdf.toString("latin1");
    expect(t).toContain("Order form");
    expect(t).not.toContain("PURCHASE ORDER");
    expect(s).toContain("0.082 0.502 0.239 rg"); // #15803d
    expect(t).toContain("Part number");
    expect(t).toContain("Quantity");
    expect(t).not.toContain("Unit price");
    expect(t).not.toContain("Amount");
    expect(t).toContain("SKU-001");
    expect(t).not.toContain("Item number 1 with a description"); // the description column is off
  });

  it("a long title shrinks or wraps beside the letterhead instead of running over it", () => {
    const x = (pdf: Buffer, word: string) => Number(new RegExp(`/F2 [\\d.]+ Tf ([\\d.]+) [\\d.]+ Td \\(${word}`).exec(pdf.toString("latin1"))![1]);
    for (const title of ["BLUEBIRD ORDER CONFIRMATION", "A VERY LONG TITLE THAT NO ONE SHOULD EVER REALLY USE ON A DOCUMENT", "OK"]) {
      const pdf = renderDocPdf(spec(1), ctx({ title }, { name: "Plant Co", phone: "555-0100", email: "orders@a-very-long-company-name.example", website: "www.a-very-long-company-name.example" }));
      const first = title.split(" ")[0]!;
      const left = 48 + (595 - 96) * 0.56; // where the letterhead's widest line can reach
      expect(x(pdf, first.slice(0, 4))).toBeGreaterThan(title === "OK" ? 0 : left - 30);
      expect(textOf(pdf).split("\n").filter((l) => title.startsWith(l) || l.startsWith(first)).length).toBeGreaterThan(0);
    }
  });

  it("prints the whole letterhead: a long contact line wraps instead of being cut", () => {
    const pdf = renderDocPdf(spec(1), ctx({}, { phone: "555-0100", email: "orders@a-very-long-company-name.example", website: "www.a-very-long-company-name.example" }));
    const t = textOf(pdf);
    expect(t).toContain("orders@a-very-long-company-name.example");
    expect(t).toContain("www.a-very-long-company-name.example");
    expect(t).not.toContain("…");
  });

  it("with the description column off the first column takes the width; with the table narrow, text never runs off the page", () => {
    const wide = spec(2, { rows: [{ sku: "X".repeat(200), description: "D".repeat(400), quantity: "1 ea", unitPrice: "$1.00", amount: "$1.00" }, { sku: "B", description: "A normal description", quantity: "1", unitPrice: "$1.00", amount: "$1.00" }] });
    const pdf = renderDocPdf(wide, ctx());
    const t = textOf(pdf);
    expect(t).toContain("A normal description");
    expect(t.split("\n").some((l) => l.length > 120)).toBe(false);
    const only = renderDocPdf(spec(2), ctx({ columns: ["amount"] }));
    expect(textOf(only)).toContain("Amount");
  });

  it("draws the logo only when there is one and the template shows it, and the paper size follows the letterhead", () => {
    const img = readImage(logoPng());
    if (!img.ok) throw new Error("setup");
    const withLogo = renderDocPdf(spec(2), { ...ctx(), logo: img.pdf });
    expect(withLogo.toString("latin1")).toContain("/Im1 Do");
    const off = renderDocPdf(spec(2), { ...ctx({ showLogo: false }), logo: img.pdf });
    expect(off.toString("latin1")).not.toContain("/Im1 Do");
    expect(renderDocPdf(spec(2), ctx()).toString("latin1")).not.toContain("/Im1 Do");
    expect(renderDocPdf(spec(2), ctx({}, { paper: "letter" })).toString("latin1")).toContain("/MediaBox [0 0 612 792]");
    expect(renderDocPdf(spec(2), ctx({}, { paper: "a4" })).toString("latin1")).toContain("/MediaBox [0 0 595 842]");
  });

  it("survives hostile text: parentheses, backslashes, newlines, control characters, emoji", () => {
    const evil = ") Tj ET\n/Evil (\\) \u0000\u0007 😀 ‮";
    const pdf = renderDocPdf(spec(1, { rows: [{ sku: evil, description: evil, quantity: evil, unitPrice: evil, amount: evil }], note: evil, parties: [{ heading: evil, lines: [evil] }], number: evil }), ctx({ title: evil, terms: evil, footer: evil }, { name: evil, addressLines: [evil] }));
    const s = pdf.toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(s)![1]);
    const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(s.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(s).not.toMatch(/\n\/Evil \(/); // nothing escaped the string it was written in
  });
});

// ---------- settings, logo, preview ----------

async function world() {
  const owner = await signUp({ mode: "create", name: "Plant Co" });
  const member = await signUp({ mode: "join", joinCode: owner.org.joinCode }, "Bob");
  const base = `/api/orgs/${owner.org.id}`;
  const post = (p: string, b: unknown, who: "owner" | "member" = "owner", m?: string) => call((who === "owner" ? owner : member).cookie, `${base}${p}`, b, m);
  const get = (p: string, who: "owner" | "member" = "owner") => call((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const rawGet = (p: string, who: "owner" | "member" = "owner") => raw((who === "owner" ? owner : member).cookie, `${base}${p}`);
  const main = (await get("/locations")).body[0].id as string;
  const mk = async (sku: string, qty: number, extra: object = {}) => (await post("/items", { sku, name: `${sku} item`, unitCostCents: 1000, ...(qty > 0 ? { initialStock: { locationId: main, quantity: qty } } : {}), ...extra })).body.id as string;
  const partner = async (b: object) => (await post("/b2b/partners", { kind: "customer", mode: "test", ...b })).body;
  const order = async (lines: { itemId: string; quantity: number; unitPriceCents?: number }[], extra: object = {}) => (await post("/sales/orders", { customerName: "Walk-in", lines: lines.map((l) => ({ unitPriceCents: 5000, ...l })), ...extra })).body;
  const confirm = (id: string) => post(`/sales/orders/${id}/confirm`, {});
  const ship = (id: string, lines: object[], extra: object = {}) => post(`/sales/orders/${id}/ship`, { lines, ...extra }, "member");
  const pdfText = async (p: string, who: "owner" | "member" = "owner") => { const r = await rawGet(p, who); return { status: r.status, type: r.headers.get("content-type"), text: textOf(Buffer.from(await r.arrayBuffer())) }; };
  return { owner, member, base, post, get, rawGet, main, mk, partner, order, confirm, ship, pdfText, orgId: new ObjectId(owner.org.id) };
}
const b64 = (b: Buffer) => b.toString("base64");

describe("document settings: letterhead, templates, logo", () => {
  it("starts with the organization's name and each kind's own look; every member can read it, only an admin changes it", async () => {
    const w = await world();
    const s = (await w.get("/documents/settings", "member")).body;
    expect(s).toMatchObject({ orgName: "Plant Co", company: { name: "", addressLines: [], paper: "a4", taxRateBps: 0, paymentTermsDays: 30 }, logo: null });
    expect(Object.keys(s.templates).sort()).toEqual(["invoice", "packing_slip", "purchase_order", "sales_order"]);
    expect(s.templates.packing_slip.columns).toEqual(["sku", "description", "ordered", "shipped", "toDate"]);
    expect(s.templates.invoice.accent).toBe("#334155");
    expect((await w.post("/documents/settings", { company: { name: "X" } }, "member", "PUT")).status).toBe(403);
    expect((await w.post("/documents/logo", { contentBase64: b64(logoPng()) }, "member")).status).toBe(403);
    expect((await w.post("/documents/preview", { kind: "invoice" }, "member")).status).toBe(403);
    expect((await w.rawGet("/documents/logo", "member")).status).toBe(404);
  });

  it("saves the letterhead and templates, checks them, keeps columns to what the kind has, and audits the change", async () => {
    const w = await world();
    const company = { name: "Plant Corrugated Ltd", addressLines: ["1 Mill Road", "Springfield, IL 62701"], phone: "555-0100", email: "hello@plant.example", website: "plant.example", taxId: "TAX-9", paper: "letter", taxLabel: "Sales tax", taxRateBps: 825, paymentTermsDays: 45 };
    const tpl = (over: object = {}) => ({ title: "", accent: "#1d4ed8", showLogo: true, columns: ["sku", "quantity", "bogus"], terms: "Net 45", footer: "Thanks!", ...over });
    const saved = await w.post("/documents/settings", { company, templates: { invoice: tpl() } }, "owner", "PUT");
    expect(saved.status).toBe(200);
    expect(saved.body.company).toMatchObject(company);
    expect(saved.body.templates.invoice).toMatchObject({ accent: "#1d4ed8", columns: ["sku", "quantity"], terms: "Net 45", footer: "Thanks!" }); // "bogus" is dropped
    expect(saved.body.templates.purchase_order.accent).toBe("#334155"); // others untouched
    for (const bad of [{ accent: "blue" }, { accent: "#12345" }, { terms: "x".repeat(801) }, { footer: "x".repeat(301) }, { title: "x".repeat(41) }]) {
      expect((await w.post("/documents/settings", { templates: { invoice: tpl(bad) } }, "owner", "PUT")).status).toBe(400);
    }
    for (const bad of [{ addressLines: ["a", "b", "c", "d", "e", "f"] }, { addressLines: ["x".repeat(81)] }, { paper: "legal" }, { taxRateBps: 10_001 }, { taxRateBps: -1 }, { taxRateBps: 8.5 }, { paymentTermsDays: 366 }]) {
      expect((await w.post("/documents/settings", { company: { ...company, ...bad } }, "owner", "PUT")).status).toBe(400);
    }
    const none = await w.post("/documents/settings", { templates: { invoice: tpl({ columns: ["nope"] }) } }, "owner", "PUT");
    expect(none.body.templates.invoice.columns).toEqual(["sku", "description", "quantity", "unitPrice", "amount"]); // never a table with no columns
    const events = (await w.get("/audit")).body.events as { action: string; summary: string }[];
    expect(events.filter((e) => e.action === "organization.documents_changed").map((e) => e.summary)[1]).toMatch(/the letterhead.*the invoice template/);
  });

  it("takes a PNG or JPEG logo, serves it back as an inert image, replaces and removes it", async () => {
    const w = await world();
    const up = await w.post("/documents/logo", { contentBase64: b64(logoPng()) });
    expect(up.status).toBe(200);
    expect(up.body.logo).toMatchObject({ width: 40, height: 20, contentType: "image/png" });
    const img = await w.rawGet("/documents/logo", "member");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(Buffer.from(await img.arrayBuffer()).equals(logoPng())).toBe(true);
    const jpg = await w.post("/documents/logo", { contentBase64: `data:image/jpeg;base64,${b64(jpeg())}` });
    expect(jpg.body.logo).toMatchObject({ contentType: "image/jpeg" });
    expect(await store.docLogos.countDocuments({ orgId: w.orgId })).toBe(1); // replaced, not added
    expect((await w.post("/documents/logo", null, "owner", "DELETE")).body.logo).toBeNull();
    expect((await w.rawGet("/documents/logo")).status).toBe(404);
  });

  it("refuses logos that aren't safe images, with the reason, and keeps the old one", async () => {
    const w = await world();
    await w.post("/documents/logo", { contentBase64: b64(logoPng()) });
    const bad = async (buf: Buffer | string) => w.post("/documents/logo", { contentBase64: typeof buf === "string" ? buf : b64(buf) });
    const svg = await bad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
    expect(svg.status).toBe(400);
    expect(svg.body.error).toMatch(/Only PNG and JPEG/);
    expect((await bad(Buffer.from("GIF89a"))).status).toBe(400);
    expect((await bad("not base64 !!")).status).toBe(400);
    expect((await bad(Buffer.concat([logoPng(), Buffer.alloc(MAX_LOGO_BYTES)]))).status).toBe(400);
    expect((await bad(jpeg({ adobe: 2 }))).body.error).toMatch(/CMYK/);
    expect((await w.post("/documents/logo", {})).status).toBe(400);
    expect((await w.get("/documents/settings")).body.logo).toMatchObject({ width: 40, height: 20 }); // still the first one
  });

  it("previews every kind of document with fictional data, using values that aren't saved yet, and saves nothing", async () => {
    const w = await world();
    await w.post("/documents/logo", { contentBase64: b64(logoPng()) });
    for (const [kind, word] of [["purchase_order", "PURCHASE ORDER"], ["sales_order", "ORDER CONFIRMATION"], ["packing_slip", "PACKING SLIP"], ["invoice", "INVOICE"]] as const) {
      const r = await raw(w.owner.cookie, `${w.base}/documents/preview`, { kind });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/pdf");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const buf = Buffer.from(await r.arrayBuffer());
      expect(buf.toString("latin1").startsWith("%PDF-1.4")).toBe(true);
      expect(textOf(buf)).toContain(word);
      expect(buf.toString("latin1")).toContain("/Im1 Do"); // the saved logo
    }
    const draft = await raw(w.owner.cookie, `${w.base}/documents/preview`, { kind: "invoice", company: { name: "Draft Name Inc", taxRateBps: 1000, taxLabel: "VAT", addressLines: ["9 Draft St"] }, template: { title: "TAX INVOICE", accent: "#b91c1c", showLogo: false, columns: ["description", "amount"], terms: "Pay promptly", footer: "Draft footer" } });
    const buf = Buffer.from(await draft.arrayBuffer());
    const t = textOf(buf);
    expect(t).toContain("Draft Name Inc");
    expect(t).toContain("TAX INVOICE");
    expect(t).toContain("9 Draft St");
    expect(t).toContain("VAT");
    expect(t).toContain("Pay promptly");
    expect(t).not.toContain("Unit price");
    expect(buf.toString("latin1")).not.toContain("/Im1 Do");
    expect(buf.toString("latin1")).toContain("0.725 0.110 0.110 rg");
    const saved = (await w.get("/documents/settings")).body;
    expect(saved.company.name).toBe(""); // the preview changed nothing
    expect((await raw(w.owner.cookie, `${w.base}/documents/preview`, { kind: "invoice", template: { accent: "red", columns: [] } })).status).toBe(400);
    expect((await raw(w.owner.cookie, `${w.base}/documents/preview`, { kind: "memo" })).status).toBe(400);
  });

  it("is private to the organization", async () => {
    const w = await world();
    await w.post("/documents/logo", { contentBase64: b64(logoPng()) });
    const other = await signUp({ mode: "create", name: "Elsewhere" });
    const ob = `/api/orgs/${other.org.id}`;
    expect((await call(other.cookie, `${ob}/documents/settings`)).body.logo).toBeNull();
    expect((await raw(other.cookie, `${ob}/documents/logo`)).status).toBe(404);
    expect((await call(other.cookie, `/api/orgs/${w.base.split("/").pop()}/documents/settings`)).status).toBe(404);
  });
});

// ---------- the documents of a sales order ----------

describe("sales order documents", () => {
  it("draws the confirmation, packing slip and invoice with the letterhead and templates", async () => {
    const w = await world();
    await w.post("/documents/settings", {
      company: { name: "Plant Corrugated Ltd", addressLines: ["1 Mill Road"], phone: "555-0100", paper: "letter", taxLabel: "Sales tax", taxRateBps: 825, paymentTermsDays: 30, email: "", website: "", taxId: "" },
      templates: { invoice: { title: "TAX INVOICE", accent: "#15803d", showLogo: true, columns: ["sku", "description", "quantity", "unitPrice", "amount"], terms: "Net 30. Late fees apply.", footer: "Thank you" } },
    }, "owner", "PUT");
    const k = await w.mk("KRAFT", 100, { name: "Kraft roll", unit: "ea" });
    const o = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 10001 }], { customerName: "Walk-in", customerRef: "BP-9", requestedDate: "2026-11-20" });
    expect((await w.pdfText(`/sales/orders/${o.id}/confirmation.pdf`)).status).toBe(409); // a draft is no promise
    await w.confirm(o.id);
    const conf = await w.pdfText(`/sales/orders/${o.id}/confirmation.pdf`, "member");
    expect(conf.type).toBe("application/pdf");
    for (const x of ["Plant Corrugated Ltd", "1 Mill Road", "ORDER CONFIRMATION", "SO-0001", "Walk-in", "BP-9", "2026-11-20", "Kraft roll", "$1,000.10", "$100.01"]) expect(conf.text).toContain(x);
    await w.ship(o.id, [{ itemId: k, quantity: 4, locationId: w.main }], { carrier: "UPS", trackingNumber: "1Z9" });
    const slip = await w.pdfText(`/sales/orders/${o.id}/shipments/SO-0001-1/packing-slip.pdf`, "member");
    for (const x of ["PACKING SLIP", "SO-0001-1", "SHIP TO", "BP-9", "UPS", "1Z9", "Kraft roll", "10 ea", "4 ea", "Shipped now", "Shipped to date"]) expect(slip.text).toContain(x);
    expect(slip.text).not.toContain("Unit price");
    expect((await w.pdfText(`/sales/orders/${o.id}/shipments/SO-0001-9/packing-slip.pdf`)).status).toBe(404);
    // invoices are made on request, by an admin
    expect((await w.pdfText(`/sales/orders/${o.id}/shipments/SO-0001-1/invoice.pdf`, "member")).status).toBe(403);
    const inv = await w.pdfText(`/sales/orders/${o.id}/shipments/SO-0001-1/invoice.pdf`);
    for (const x of ["TAX INVOICE", "INV-0001", "BILL TO", "Walk-in", "BP-9", "SO-0001-1", "$400.04", "Subtotal", "Sales tax", "$33.00", "$433.04", "Total due", "Net 30. Late fees apply.", "Thank you", "Page 1 of 1"]) expect(inv.text).toContain(x);
  });

  it("numbers an invoice the first time it is asked for, then keeps it exactly as issued even if tax or terms change", async () => {
    const w = await world();
    await w.post("/documents/settings", { company: { taxLabel: "Tax", taxRateBps: 1000, paymentTermsDays: 10 } }, "owner", "PUT");
    const k = await w.mk("KRAFT", 100, { name: "Kraft roll" });
    const a = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 1000 }]);
    const b = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 1000 }]);
    for (const o of [a, b]) { await w.confirm(o.id); await w.ship(o.id, [{ itemId: k, quantity: 5, locationId: w.main }]); }
    const first = await w.pdfText(`/sales/orders/${a.id}/shipments/SO-0001-1/invoice.pdf`);
    expect(first.text).toContain("INV-0001");
    expect(first.text).toContain("$55.00"); // 5 x $10.00 + 10% tax
    await w.post("/documents/settings", { company: { taxLabel: "VAT", taxRateBps: 2000, paymentTermsDays: 60 } }, "owner", "PUT");
    const again = await w.pdfText(`/sales/orders/${a.id}/shipments/SO-0001-1/invoice.pdf`);
    expect(again.text).toContain("INV-0001");
    expect(again.text).toContain("$55.00"); // not rewritten by the new rate
    expect(again.text).toContain("$5.00");
    expect(again.text).not.toContain("VAT");
    const second = await w.pdfText(`/sales/orders/${b.id}/shipments/SO-0002-1/invoice.pdf`);
    expect(second.text).toContain("INV-0002");
    expect(second.text).toContain("$60.00"); // issued under the new rate
    const stored = (await store.salesOrders.findOne({ _id: new ObjectId(a.id) }))!.shipments[0]!;
    expect(stored.invoiceNumber).toBe("INV-0001");
    expect(stored.invoice).toMatchObject({ invoiceNumber: "INV-0001", taxCents: 500, totalCents: 5500, taxLabel: "Tax" });
    // two people asking at once get the same invoice
    const c = await w.order([{ itemId: k, quantity: 4, unitPriceCents: 1000 }]);
    await w.confirm(c.id);
    await w.ship(c.id, [{ itemId: k, quantity: 4, locationId: w.main }]);
    const both = await Promise.all([w.pdfText(`/sales/orders/${c.id}/shipments/SO-0003-1/invoice.pdf`), w.pdfText(`/sales/orders/${c.id}/shipments/SO-0003-1/invoice.pdf`)]);
    const nums = both.map((r) => /INV-\d{4}/.exec(r.text)![0]);
    expect(nums[0]).toBe(nums[1]);
    // and other organizations can't ask for ours
    const other = await signUp({ mode: "create", name: "Elsewhere" });
    expect((await raw(other.cookie, `/api/orgs/${other.org.id}/sales/orders/${a.id}/shipments/SO-0001-1/invoice.pdf`)).status).toBe(404);
  });

  it("works tax out to the cent with no floating point", () => {
    expect(taxOn(10_001, 825)).toBe(825); // 825.0825
    expect(taxOn(1, 5_000)).toBe(1); // half a cent rounds up
    expect(taxOn(1, 4_999)).toBe(0);
    expect(taxOn(100, 0)).toBe(0);
    expect(taxOn(999_999_999_999, 10_000)).toBe(999_999_999_999); // 100%: nothing overflows
    expect(taxOn(123_456_789, 825)).toBe(Number((123_456_789n * 825n * 2n + 10_000n) / 20_000n));
  });
});

// ---------- per-customer overrides ----------

describe("a customer's own look", () => {
  it("changes the title, terms, accent and columns for one customer only", async () => {
    const w = await world();
    const k = await w.mk("KRAFT", 100, { name: "Kraft roll" });
    const bluebird = await w.partner({ name: "Bluebird", bridge: "loopback" });
    const other = await w.partner({ name: "Other Co", bridge: "loopback" });
    await w.post("/documents/settings", { templates: { sales_order: { title: "", accent: "#334155", showLogo: true, columns: ["sku", "description", "quantity", "unitPrice", "amount"], terms: "Standard terms apply.", footer: "" } } }, "owner", "PUT");
    const patched = await w.post(`/b2b/partners/${bluebird.id}`, { docTemplates: { sales_order: { title: "BLUEBIRD CONFIRMATION", terms: "Bluebird terms: net 60.", accent: "#b91c1c", columns: ["description", "quantity"] } } }, "owner", "PATCH");
    expect(patched.status).toBe(200);
    expect(patched.body.docTemplates.sales_order.title).toBe("BLUEBIRD CONFIRMATION");
    const mine = await w.order([{ itemId: k, quantity: 2 }], { customerPartnerId: bluebird.id });
    const theirs = await w.order([{ itemId: k, quantity: 2 }], { customerPartnerId: other.id });
    await w.confirm(mine.id); await w.confirm(theirs.id);
    const a = await w.rawGet(`/sales/orders/${mine.id}/confirmation.pdf`);
    const ab = Buffer.from(await a.arrayBuffer());
    const at = textOf(ab);
    expect(at).toContain("BLUEBIRD CONFIRMATION");
    expect(at).toContain("Bluebird terms: net 60.");
    expect(at).not.toContain("Standard terms apply.");
    expect(at).not.toContain("Unit price"); // the override's columns
    expect(ab.toString("latin1")).toContain("0.725 0.110 0.110 rg");
    const bt = (await w.pdfText(`/sales/orders/${theirs.id}/confirmation.pdf`)).text;
    expect(bt).toContain("ORDER CONFIRMATION");
    expect(bt).toContain("Standard terms apply.");
    expect(bt).toContain("Unit price");
    // checked like the organization's templates
    expect((await w.post(`/b2b/partners/${bluebird.id}`, { docTemplates: { invoice: { accent: "red" } } }, "owner", "PATCH")).status).toBe(400);
    expect((await w.post(`/b2b/partners/${bluebird.id}`, { docTemplates: { memo: { title: "x" } } }, "owner", "PATCH")).status).toBe(400);
    expect((await w.post(`/b2b/partners/${bluebird.id}`, { docTemplates: { invoice: { terms: "x".repeat(801) } } }, "owner", "PATCH")).status).toBe(400);
    expect((await w.post(`/b2b/partners/${bluebird.id}`, { docTemplates: {} }, "owner", "PATCH")).body.docTemplates).toEqual({}); // back to the organization's
  });
});

// ---------- sent by email ----------

describe("documents attached to what is sent", () => {
  const files = () => readdirSync(outbox).sort();
  const mails = (since: number) => files().slice(since).map((f) => readFileSync(path.join(outbox, f), "utf8"));
  /** The text of every PDF attached to an email. */
  const attachments = (eml: string) => [...eml.matchAll(/filename="([^"]+\.pdf)"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => ({ name: m[1]!, text: textOf(Buffer.from(m[2]!.replace(/\r\n/g, ""), "base64")) }));
  const subjectOf = (eml: string) => /^Subject: (.*)$/m.exec(eml)![1]!;

  it("the purchase order email, the packing slip on a ship notice, a confirmation and an invoice are all drawn with our letterhead and the customer's template", async () => {
    const w = await world();
    await w.post("/documents/settings", { company: { name: "Plant Corrugated Ltd", addressLines: ["1 Mill Road"], taxLabel: "Tax", taxRateBps: 500, paymentTermsDays: 30, phone: "", email: "", website: "", taxId: "", paper: "a4" } }, "owner", "PUT");
    const k = await w.mk("KRAFT", 100, { name: "Kraft roll" });
    const cust = await w.partner({ name: "Bluebird", bridge: "email", bridgeConfig: { to: "ap@bluebird.example" } });
    await w.post(`/b2b/partners/${cust.id}`, { docTemplates: { invoice: { title: "BLUEBIRD INVOICE", terms: "Bluebird pays net 60." } } }, "owner", "PATCH");
    const o = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 1000 }], { customerPartnerId: cust.id, customerRef: "BP-9" });
    expect((await w.post(`/sales/orders/${o.id}/send-confirmation`, {})).status).toBe(409); // not confirmed yet
    await w.confirm(o.id);
    expect((await w.post(`/sales/orders/${o.id}`, {})).status).toBeGreaterThan(0);
    const so = (await w.get(`/sales/orders/${o.id}`)).body;
    expect(so.sendDocs).toEqual({ confirmation: true, invoice: true });

    // the confirmation
    let before = files().length;
    expect((await w.post(`/sales/orders/${o.id}/send-confirmation`, {}, "member")).status).toBe(403);
    const sent = await w.post(`/sales/orders/${o.id}/send-confirmation`, {});
    expect(sent.status).toBe(201);
    let [mail] = mails(before);
    expect(subjectOf(mail!)).toBe("Order confirmation SO-0001 from Plant Corrugated Ltd (TEST)");
    expect(mail).toContain("To: ap@bluebird.example");
    let [pdf] = attachments(mail!);
    expect(pdf!.name).toBe("SO-0001.pdf");
    for (const x of ["Plant Corrugated Ltd", "1 Mill Road", "ORDER CONFIRMATION", "BP-9", "Kraft roll", "$100.00"]) expect(pdf!.text).toContain(x);
    expect((await w.post(`/sales/orders/${o.id}/send-confirmation`, {})).status).toBe(200); // the same confirmation twice is one email
    expect(files().length).toBe(before + 1);

    // the ship notice carries the packing slip
    before = files().length;
    const shipped = await w.ship(o.id, [{ itemId: k, quantity: 6, locationId: w.main }], { carrier: "UPS", trackingNumber: "1Z9" });
    expect(shipped.body.notice).toBe("sent");
    [mail] = mails(before);
    [pdf] = attachments(mail!);
    expect(pdf!.name).toBe("SO-0001-1-packing-slip.pdf");
    for (const x of ["Plant Corrugated Ltd", "PACKING SLIP", "SHIP TO", "Bluebird", "Kraft roll", "10 ea", "6 ea", "1Z9"]) expect(pdf!.text).toContain(x);

    // the invoice, with this customer's own title and terms
    before = files().length;
    const inv = await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/send-invoice`, {});
    expect(inv.status).toBe(201);
    expect(inv.body.invoiceNumber).toBe("INV-0001");
    [mail] = mails(before);
    expect(subjectOf(mail!)).toBe("Invoice INV-0001 from Plant Corrugated Ltd (TEST)");
    [pdf] = attachments(mail!);
    expect(pdf!.name).toBe("INV-0001.pdf");
    for (const x of ["BLUEBIRD INVOICE", "Bluebird pays net 60.", "$60.00", "$3.00", "$63.00", "Total due"]) expect(pdf!.text).toContain(x);
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/send-invoice`, {})).status).toBe(200);
    expect(files().length).toBe(before + 1); // not twice
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-9/send-invoice`, {})).status).toBe(404);
    const log = ((await w.get("/b2b/messages?direction=out")).body as any[]).map((m) => `${m.docType}:${m.state}`).sort();
    expect(log).toEqual(["despatch_advice:sent", "invoice:sent", "order_response:sent"]);
  });

  it("a purchase order email uses the letterhead too", async () => {
    const w = await world();
    await w.post("/documents/settings", { company: { name: "Plant Corrugated Ltd", addressLines: ["1 Mill Road"], phone: "555-0100", email: "", website: "", taxId: "", taxLabel: "Tax", taxRateBps: 0, paymentTermsDays: 30, paper: "letter" }, templates: { purchase_order: { title: "ORDER FORM", accent: "#6d28d9", showLogo: true, columns: ["sku", "description", "quantity"], terms: "Deliver Mon-Fri.", footer: "" } } }, "owner", "PUT");
    const k = await w.mk("KRAFT", 10, { name: "Kraft roll" });
    const sup = (await w.post("/purchasing/suppliers", { name: "Mill Co", contact: "Sam", email: "sam@mill.example" })).body.id;
    await w.partner({ name: "Mill Co", kind: "supplier", supplierId: sup, bridge: "email", bridgeConfig: { to: "orders@mill.example" } });
    const po = (await w.post("/purchasing/orders", { supplierId: sup, lines: [{ itemId: k, quantity: 5, unitCostCents: 100 }] })).body;
    await w.post(`/purchasing/orders/${po.id}/place`, {});
    const before = files().length;
    expect((await w.post(`/b2b/orders/${po.id}/send`, {})).status).toBe(201);
    const [pdf] = attachments(mails(before)[0]!);
    for (const x of ["Plant Corrugated Ltd", "1 Mill Road", "ORDER FORM", "Deliver Mon-Fri.", "TO (SUPPLIER)", "Mill Co"]) expect(pdf!.text).toContain(x);
    expect(pdf!.text).not.toContain("Unit price");
    const preview = await w.pdfText(`/b2b/orders/${po.id}/preview.pdf`);
    expect(preview.type).toBe("application/pdf");
    expect(preview.text).toContain("ORDER FORM"); // the preview in the order dialog is the same document
  });

  it("an EDI customer gets the invoice as an 810 with the same numbers, a confirmation can't go to them, and a customer with no way to receive one is told so", async () => {
    const w = await world();
    await w.post("/documents/settings", { company: { taxLabel: "Tax", taxRateBps: 800, paymentTermsDays: 30, name: "", addressLines: [], phone: "", email: "", website: "", taxId: "", paper: "a4" } }, "owner", "PUT");
    const k = await w.mk("KRAFT", 100, { name: "Kraft roll" });
    const cfg = { ourQual: "ZZ", ourId: "PLANTCO", theirQual: "ZZ", theirId: "BLUEBIRD", version: "004010", transport: "loopback" };
    const edi = await w.partner({ name: "EDI Customer", bridge: "x12", bridgeConfig: cfg });
    const o = await w.order([{ itemId: k, quantity: 10, unitPriceCents: 1000 }], { customerPartnerId: edi.id, customerRef: "BP-9" });
    await w.confirm(o.id);
    await w.ship(o.id, [{ itemId: k, quantity: 5, locationId: w.main }]);
    expect((await w.get(`/sales/orders/${o.id}`)).body.sendDocs).toEqual({ confirmation: false, invoice: true });
    expect((await w.post(`/sales/orders/${o.id}/send-confirmation`, {})).status).toBe(409);
    const res = await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/send-invoice`, {});
    expect(res.status).toBe(201);
    const m = ((await w.get("/b2b/messages?direction=out")).body as any[]).find((x) => x.docType === "invoice");
    expect(m).toMatchObject({ contentType: "application/edi-x12", state: "delivered", correlation: expect.objectContaining({ poNumber: "BP-9", controlNumber: "2" }) }); // the 856 for the shipment took 1
    const back = readX12((await w.get(`/b2b/messages/${m.id}`)).body.body as string);
    expect(back.ok && back.doc).toMatchObject({ kind: "invoice", doc: { invoiceNumber: "INV-0001", poNumber: "BP-9", taxCents: 400, totalCents: 5400, lines: [{ sku: "KRAFT", quantity: "5", unitPriceCents: 1000, lineTotalCents: 5000 }] } });
    expect((await w.post(`/sales/orders/${o.id}/shipments/SO-0001-1/send-invoice`, {})).status).toBe(200); // not twice
    expect(((await w.get("/b2b/messages?direction=out")).body as any[]).filter((x) => x.docType === "invoice")).toHaveLength(1);

    const walkin = await w.order([{ itemId: k, quantity: 2 }]);
    await w.confirm(walkin.id);
    await w.ship(walkin.id, [{ itemId: k, quantity: 2, locationId: w.main }]);
    expect((await w.get(`/sales/orders/${walkin.id}`)).body.sendDocs).toEqual({ confirmation: false, invoice: false });
    const nobody = await w.post(`/sales/orders/${walkin.id}/shipments/SO-0002-1/send-invoice`, {});
    expect(nobody.status).toBe(409);
    expect(nobody.body.error).toMatch(/Download the PDF/);
    expect((await w.pdfText(`/sales/orders/${walkin.id}/shipments/SO-0002-1/invoice.pdf`)).status).toBe(200); // but they can still have it as a PDF
    const exch = await w.partner({ name: "Inbox", bridge: "invoice-inbox", bridgeConfig: { secretEnv: "X" } });
    const o3 = await w.order([{ itemId: k, quantity: 1 }], { customerPartnerId: exch.id });
    await w.confirm(o3.id);
    expect((await w.get(`/sales/orders/${o3.id}`)).body.sendDocs).toEqual({ confirmation: false, invoice: false });
  });
});
