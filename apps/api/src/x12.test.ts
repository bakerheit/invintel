import type { CanonicalFunctionalAck, CanonicalInvoice, CanonicalOrder, CanonicalOrderResponse, CanonicalShipNotice } from "@invintel/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInterchange, mulCents, parseX12, sumQty, type X12Profile } from "./x12.js";
import { acknowledge, ackTo997, answerOf, invoiceTo810, orderTo850, readX12, responseTo855, shipTo856, type MapOpts } from "./x12-maps.js";

// Golden files: the exact X12 text each canonical document must produce (fictional companies). A change to one of these files is a
// change to what we send to partners and must be deliberate. UPDATE_GOLDEN=1 rewrites them; read the diff before committing.
const dir = join(dirname(fileURLToPath(import.meta.url)), "golden", "x12");
function golden(name: string, text: string) {
  const file = join(dir, name);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) { if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, text); else throw new Error(`Missing golden file ${name} (run with UPDATE_GOLDEN=1, then read it)`); }
  expect(text).toBe(readFileSync(file, "utf8"));
}

const NOW = new Date("2026-10-18T09:30:00Z");
const buyerToSeller: X12Profile = { senderQual: "ZZ", senderId: "NWCORR", receiverQual: "ZZ", receiverId: "SUNRISEPM", version: "004010", usage: "T" };
const sellerToBuyer: X12Profile = { senderQual: "ZZ", senderId: "SUNRISEPM", receiverQual: "ZZ", receiverId: "NWCORR", version: "004010", usage: "T" };
const out = (profile: X12Profile, control: number, extra: Partial<MapOpts> = {}): MapOpts => ({ profile, control, now: NOW, ...extra });

const order = (over: Partial<CanonicalOrder> = {}): CanonicalOrder => ({
  kind: "order", version: 1, poNumber: "PO-48213", revision: 1, issuedAt: "2026-10-18", buyer: { name: "Northwind Corrugated Co." }, supplier: { name: "Sunrise Paper Mill", contact: "", email: "" },
  currency: "USD", expectedDate: "2026-11-05", note: "Deliver to the east dock. Call before arrival.",
  lines: [
    { lineNo: 1, sku: "LINER-T33", name: "Test liner 33 lb, 60 in roll", quantity: "6", unit: "roll", unitPriceCents: 42000, lineTotalCents: 252000 },
    { lineNo: 2, sku: "STARCH-25", name: "Corn starch, 25 kg bag", quantity: "12.500", unit: "kg", unitPriceCents: 8250, lineTotalCents: 103125 },
    { lineNo: 3, sku: "INK-BLK", name: "Flexo ink, black, 5 gal", quantity: "8", unit: "ea", unitPriceCents: 9500, lineTotalCents: 76000 },
  ],
  totalCents: 431125, portalUrl: null, ...over,
});

const response = (status: CanonicalOrderResponse["status"]): CanonicalOrderResponse => ({
  kind: "order_response", version: 1, poNumber: "PO-48213", status, poDate: "2026-10-18", issuedAt: "2026-10-19", note: status === "rejected" ? "Out of stock until December." : "",
  lines:
    status === "accepted" ? [
      { lineNo: 1, sku: "LINER-T33", status: "accepted", orderedQuantity: "6", quantity: "6", unit: "roll", promisedDate: "2026-11-05" },
      { lineNo: 2, sku: "STARCH-25", status: "accepted", orderedQuantity: "12.500", quantity: "12.500", unit: "kg", promisedDate: null },
    ] : status === "changed" ? [
      { lineNo: 1, sku: "LINER-T33", status: "changed", orderedQuantity: "6", quantity: "5", unit: "roll", promisedDate: "2026-11-07" },
      { lineNo: 2, sku: "STARCH-25", status: "accepted", orderedQuantity: "12.500", quantity: "12.500", unit: "kg", promisedDate: null },
    ] : [
      { lineNo: 1, sku: "LINER-T33", status: "rejected", orderedQuantity: "6", quantity: "0", unit: "roll", promisedDate: null },
    ],
});

const ship: CanonicalShipNotice = {
  kind: "despatch_advice", version: 1, shipmentNo: "SH-20417", poNumber: "PO-48213", shipDate: "2026-11-03", carrier: "Demo Freight", trackingNumber: "DEMO-TRK-0001",
  lines: [{ lineNo: 1, sku: "LINER-T33", quantity: "6", unit: "roll" }, { lineNo: 2, sku: "STARCH-25", quantity: "12.500", unit: "kg" }],
};

const invoice: CanonicalInvoice = {
  kind: "invoice", version: 1, invoiceNumber: "SPM-20418", invoiceDate: "2026-11-03", dueDate: "2026-12-03", poNumber: "PO-48213", currency: "USD",
  lines: [
    { lineNo: 1, sku: "LINER-T33", name: "Test liner 33 lb, 60 in roll", quantity: "6", unit: "roll", unitPriceCents: 42000, lineTotalCents: 252000 },
    { lineNo: 2, sku: "STARCH-25", name: "Corn starch, 25 kg bag", quantity: "12.500", unit: "kg", unitPriceCents: 8250, lineTotalCents: 103125 },
  ],
  taxCents: 2850, totalCents: 357975,
};

const text = (w: { ok: boolean; text?: string; errors?: string[] }) => { if (!w.ok) throw new Error(w.errors!.join("; ")); return w.text!; };

describe("850 purchase order", () => {
  it("matches the golden file and reads back to the same order", () => {
    const x = text(orderTo850(order(), out(buyerToSeller, 101)));
    golden("850-order.x12", x);
    const isa = x.split("\n")[0]!;
    expect(isa.length).toBe(106); // ISA is fixed width, terminator included
    const back = readX12(x);
    expect(back.ok && back.doc).toEqual({ kind: "order", doc: order() });
  });

  it("a revised order is a BEG01 05 (replace) and reads back as a later revision", () => {
    const x = text(orderTo850(order({ revision: 3 }), out(buyerToSeller, 102)));
    expect(x).toContain("BEG*05*SA*PO-48213");
    const back = readX12(x);
    expect(back.ok && back.doc.kind === "order" && back.doc.doc.revision).toBe(2); // X12 doesn't number revisions: any replacement reads as "revised"
  });

  it("version 5010 uses its own ISA and GS values and still reads", () => {
    const x = text(orderTo850(order(), out({ ...buyerToSeller, version: "005010" }, 103)));
    expect(x.split("\n")[0]).toContain("*^*00501*000000103*0*T*>");
    expect(x).toContain("*X*005010~");
    const back = readX12(x);
    expect(back.ok && back.interchange.group.version).toBe("005010");
  });

  it("carries the test or production indicator, and the control number in ISA13, GS06 and IEA02", () => {
    const x = text(orderTo850(order(), out({ ...buyerToSeller, usage: "P" }, 4711)));
    expect(x).toContain("*000004711*0*P*>~");
    expect(x).toContain("*4711*X*004010~");
    expect(x.trim().endsWith("IEA*1*000004711~")).toBe(true);
  });

  it("refuses to send what X12 can't carry exactly, and lists every problem at once", () => {
    const bad = orderTo850(order({
      poNumber: "PO*1", buyer: { name: "N".repeat(61) },
      lines: [{ lineNo: 1, sku: "A~B", name: "x", quantity: "1", unit: "sheet-of-gold", unitPriceCents: 100, lineTotalCents: 100 }, { lineNo: 1, sku: "OK", name: "x", quantity: "2", unit: "ea", unitPriceCents: 100, lineTotalCents: 999 }],
      totalCents: 5,
    }), out(buyerToSeller, 1));
    expect(bad.ok).toBe(false);
    const msg = (!bad.ok && bad.errors.join("\n")) || "";
    for (const part of ["PO number", "Buyer name", "part number", "has no X12 unit code", "used twice", "doesn't equal the line total", "order total"]) expect(msg).toContain(part);
  });

  it("changes reserved characters in descriptions to spaces and cuts them to 80, but never touches identifiers", () => {
    const o = order();
    o.lines[0]!.name = "Liner * 33 lb ~ roll > " + "x".repeat(100);
    const x = text(orderTo850(o, out(buyerToSeller, 5)));
    const pid = x.split("\n").find((l) => l.startsWith("PID"))!;
    expect(pid.length).toBeLessThanOrEqual("PID*F****~".length + 80);
    expect(pid.slice(0, -1)).not.toMatch(/[>~]/);
    expect(pid).toContain("PID*F****Liner 33 lb roll xxxx"); // the reserved characters became single spaces
  });

  it("wraps a long note into 80 character lines and reads it back whole", () => {
    const note = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const x = text(orderTo850(order({ note }), out(buyerToSeller, 6)));
    expect(x.split("\n").filter((l) => l.startsWith("NTE")).length).toBeGreaterThan(1);
    const back = readX12(x);
    expect(back.ok && back.doc.kind === "order" && back.doc.doc.note).toBe(note);
    expect(orderTo850(order({ note: "a".repeat(90) }), out(buyerToSeller, 7)).ok).toBe(false);
  });

  it("a partner unit map adds codes the built-in table doesn't have", () => {
    const o = order();
    o.lines[2]!.unit = "sack";
    expect(orderTo850(o, out(buyerToSeller, 8)).ok).toBe(false);
    const x = text(orderTo850(o, out(buyerToSeller, 8, { uomMap: { sack: "SA" } })));
    expect(x).toContain("PO1*3*8*SA*95.00");
    const back = readX12(x, { uomMap: { sack: "SA" } });
    expect(back.ok && back.doc.kind === "order" && back.doc.doc.lines[2]!.unit).toBe("sack");
    expect(readX12(x).ok).toBe(false); // without the map the code is unknown, not guessed
  });
});

describe("855 acknowledgment", () => {
  for (const status of ["accepted", "changed", "rejected"] as const) {
    it(`${status}: golden file and round trip`, () => {
      const x = text(responseTo855(response(status), out(sellerToBuyer, 201)));
      golden(`855-${status}.x12`, x);
      const back = readX12(x);
      expect(back.ok && back.doc).toEqual({ kind: "order_response", doc: response(status) });
    });
  }

  it("refuses an answer that contradicts itself", () => {
    const r = response("accepted");
    r.lines[0]!.status = "changed";
    expect(responseTo855(r, out(sellerToBuyer, 1)).ok).toBe(false);
    const rj = response("rejected");
    rj.lines[0]!.quantity = "3";
    expect(responseTo855(rj, out(sellerToBuyer, 1)).ok).toBe(false);
    const ch = response("changed");
    ch.lines[0]!.status = "accepted";
    expect(responseTo855(ch, out(sellerToBuyer, 1)).ok).toBe(false);
  });

  it("describes a changed answer for the order page", () => {
    const x = text(responseTo855(response("changed"), out(sellerToBuyer, 202)));
    const back = readX12(x);
    const a = back.ok ? answerOf(back.doc) : null;
    expect(a).toMatchObject({ action: "confirm", promisedDate: "2026-11-07" });
    expect(a?.note).toContain("line 1: 6 -> 5 by 2026-11-07");
    const rj = readX12(text(responseTo855(response("rejected"), out(sellerToBuyer, 203))));
    expect(rj.ok && answerOf(rj.doc)).toMatchObject({ action: "reject", note: "Out of stock until December." });
  });

  it("reads an AK (acknowledged, no detail) as accepted with no lines", () => {
    const x = text(responseTo855({ ...response("accepted"), lines: [] }, out(sellerToBuyer, 204))).replace("BAK*00*AD", "BAK*00*AK");
    const back = readX12(x);
    expect(back.ok && back.doc.kind === "order_response" && back.doc.doc.status).toBe("accepted");
  });
});

describe("856 ship notice", () => {
  it("golden file and round trip", () => {
    const x = text(shipTo856(ship, out(sellerToBuyer, 301)));
    golden("856-ship.x12", x);
    const back = readX12(x);
    expect(back.ok && back.doc).toEqual({ kind: "despatch_advice", doc: ship });
    expect(back.ok && answerOf(back.doc)).toMatchObject({ action: "ship", shipDate: "2026-11-03", carrier: "Demo Freight", trackingNumber: "DEMO-TRK-0001" });
  });

  it("works without a carrier or tracking, and refuses a ship notice for two orders", () => {
    const x = text(shipTo856({ ...ship, carrier: "", trackingNumber: "" }, out(sellerToBuyer, 302)));
    expect(x).not.toContain("TD5");
    expect(x).not.toContain("REF*");
    const two = x.replace("HL*3*2*I", "PRF*PO-9~\nHL*3*2*I");
    expect(readX12(two.replace(/PRF\*PO-9~\n/, "")).ok).toBe(true);
    const twoOrders = x.replace("LIN*2*", "PRF*PO-9~\nLIN*2*");
    const r = readX12(twoOrders);
    expect(r.ok).toBe(false);
  });
});

describe("810 invoice", () => {
  it("golden file and round trip (due date, tax, total)", () => {
    const x = text(invoiceTo810(invoice, out(sellerToBuyer, 401)));
    golden("810-invoice.x12", x);
    const back = readX12(x);
    expect(back.ok && back.doc).toEqual({ kind: "invoice", doc: invoice });
  });

  it("refuses an invoice whose total isn't lines plus tax, and reads net days as a due date", () => {
    expect(invoiceTo810({ ...invoice, totalCents: 1 }, out(sellerToBuyer, 1)).ok).toBe(false);
    const x = text(invoiceTo810(invoice, out(sellerToBuyer, 402))).replace(/ITD\*05\*3\*\*\*\*20261203/, "ITD*01*3*****30");
    const back = readX12(x);
    expect(back.ok && back.doc.kind === "invoice" && back.doc.doc.dueDate).toBe("2026-12-03");
  });
});

describe("997 functional acknowledgment", () => {
  it("accepted: golden file, round trip, and built from the document it acknowledges", () => {
    const sent = readX12(text(orderTo850(order(), out(buyerToSeller, 101))));
    if (!sent.ok) throw new Error("setup");
    const ack = acknowledge(sent.interchange);
    expect(ack).toMatchObject({ groupCode: "PO", groupControl: "101", setId: "850", setControl: "0001", status: "accepted" });
    const x = text(ackTo997(ack, out(sellerToBuyer, 501)));
    golden("997-accepted.x12", x);
    const back = readX12(x);
    expect(back.ok && back.doc).toEqual({ kind: "functional_ack", doc: ack });
  });

  it("rejected: says why, and refuses a rejection with no reason", () => {
    const sent = readX12(text(orderTo850(order(), out(buyerToSeller, 101))));
    if (!sent.ok) throw new Error("setup");
    const ack: CanonicalFunctionalAck = acknowledge(sent.interchange, ["4", "5"]);
    const x = text(ackTo997(ack, out(sellerToBuyer, 502)));
    golden("997-rejected.x12", x);
    const back = readX12(x);
    expect(back.ok && back.doc.kind === "functional_ack" && back.doc.doc.errors).toEqual(["Number of segments doesn't match the SE count", "One or more segments in error"]);
    expect(ackTo997({ ...ack, errorCodes: [], errors: [] }, out(sellerToBuyer, 503)).ok).toBe(false);
  });
});

describe("reading is strict about the envelope and never guesses", () => {
  const good = text(orderTo850(order(), out(buyerToSeller, 101)));
  const errors = (x: string) => { const r = readX12(x); return r.ok ? [] : r.errors.join("\n"); };

  it("accepts the same document with CRLF, no line breaks at all, or surrounding blank space", () => {
    for (const v of [good.replace(/\n/g, "\r\n"), good.replace(/\n/g, ""), `\n\n${good}\n\n`, `﻿${good}`]) expect(readX12(v).ok).toBe(true);
  });

  it("catches segment counts and control numbers that don't match", () => {
    expect(errors(good.replace(/SE\*\d+\*0001/, "SE*3*0001"))).toContain("SE01 says 3 segments");
    expect(errors(good.replace("SE*", "SE*").replace(/(SE\*\d+\*)0001/, "$10002"))).toContain("ST02 (0001) and SE02 (0002)");
    expect(errors(good.replace(/GE\*1\*101/, "GE*1*999"))).toContain("GE02 (999) and GS06 (101)");
    expect(errors(good.replace(/GE\*1\*/, "GE*2*"))).toContain("GE01 says 2 sets");
    expect(errors(good.replace(/IEA\*1\*000000101/, "IEA*1*000000102"))).toContain("IEA02");
    expect(errors(good.replace(/IEA\*1\*/, "IEA*3*"))).toContain("IEA01 says 3 groups");
  });

  it("catches a broken or missing envelope", () => {
    expect(errors("hello")).toContain("ISA");
    expect(errors(good.slice(0, 80))).toContain("shorter than the 106");
    expect(errors(good.replace(/IEA.*\n?$/, ""))).toContain("IEA");
    expect(errors(good.replace("*T*>~", "*X*>~"))).toContain("ISA15");
    expect(errors(good.replace("000000101*0*T", "00000X101*0*T"))).toContain("ISA13");
    expect(errors(good + "garbage")).toContain("Data after");
    expect(errors(good.replace("ST*850*0001~", "ST*850*0001~\nST*850*0002~"))).toContain("Exactly one transaction set");
    expect(errors(good.replace(/^(ISA.*\n)/, "$1GS*PO*A*B*20261018*0930*7*X*004010~\n"))).toContain("Exactly one functional group");
    expect(errors(good.replace("ST*850", "ST*999"))).toContain("isn't supported");
  });

  it("says what is wrong inside the document", () => {
    expect(errors(good.replace("PO1*1*6*RL", "PO1*1*6.*RL"))).toContain("isn't a plain positive number");
    expect(errors(good.replace("*RL*420.00", "*RL*420.005"))).toContain("more than two decimals");
    expect(errors(good.replace("*RL*", "*ZZ*"))).toContain('Unknown X12 unit code "ZZ"');
    expect(errors(good.replace("BEG*00", "BEG*04"))).toContain("BEG01");
    expect(errors(good.replace("*BP*LINER-T33", "*XX*LINER-T33"))).toContain("no part number");
    expect(errors(good.replace(/BEG\*00\*SA\*PO-48213\*\*20261018/, "BEG*00*SA**"))).toContain("BEG03");
    expect(errors(good.replace(/PO1\*.*\n/g, "").replace(/PID\*.*\n/g, "").replace(/SE\*\d+/, (m) => { const lines = good.replace(/PO1\*.*\n/g, "").replace(/PID\*.*\n/g, "").split("\n"); return `SE*${lines.findIndex((l) => l.startsWith("SE*")) - lines.findIndex((l) => l.startsWith("ST*")) + 1}`; }))).toContain("no PO1 lines");
  });

  it("never throws, whatever it is given", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 300; i++) {
      const chars = good.split("");
      for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) chars[Math.floor(rnd() * chars.length)] = String.fromCharCode(32 + Math.floor(rnd() * 95));
      const mutated = rnd() < 0.2 ? chars.slice(0, Math.floor(rnd() * chars.length)).join("") : chars.join("");
      const r = readX12(mutated);
      expect(typeof r.ok).toBe("boolean");
    }
  });
});

describe("exact arithmetic", () => {
  it("multiplies quantity by price in cents, halves up, with no floating point", () => {
    expect(mulCents("12.500", 8250)).toBe(103125);
    expect(mulCents("0.5", 1)).toBe(1);
    expect(mulCents("0.4", 1)).toBe(0);
    expect(mulCents("3", 33)).toBe(99);
    expect(mulCents("1000000.001", 99999999)).toBe(99999999100000);
  });
  it("sums quantities keeping their decimals", () => {
    expect(sumQty(["6", "12.500", "8"])).toBe("26.500");
    expect(sumQty(["1", "2"])).toBe("3");
    expect(sumQty(["0.05", "0.05"])).toBe("0.10");
  });
  it("refuses a bad profile and a bad control number", () => {
    expect(() => buildInterchange({ profile: { ...buyerToSeller, senderId: "A*B" }, setId: "850", control: 1, body: [], now: NOW })).toThrow();
    expect(() => buildInterchange({ profile: buyerToSeller, setId: "850", control: 0, body: [], now: NOW })).toThrow();
    expect(() => buildInterchange({ profile: buyerToSeller, setId: "850", control: 1_000_000_000, body: [], now: NOW })).toThrow();
    expect(() => buildInterchange({ profile: buyerToSeller, setId: "999", control: 1, body: [], now: NOW })).toThrow();
    expect(parseX12("").ok).toBe(false);
  });
});
