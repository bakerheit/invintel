import type { CanonicalFunctionalAck, CanonicalInvoice, CanonicalOrder, CanonicalOrderResponse, CanonicalShipNotice } from "@invintel/shared";
import {
  buildInterchange, centsToDecimal, decimalToCents, find, findAll, fromX12Date, mulCents, parseX12, seg, sumQty, toX12Date, X12Errors,
  type ParsedInterchange, type Segment, type X12Profile,
} from "./x12.js";

// INV-14: pure mappers between our canonical documents (shared/b2bdocs.ts) and X12 transaction sets:
//
//   850 purchase order      CanonicalOrder          <->  orderTo850 / readX12
//   855 order acknowledgment CanonicalOrderResponse <->  responseTo855
//   856 ship notice          CanonicalShipNotice    <->  shipTo856
//   810 invoice              CanonicalInvoice       <->  invoiceTo810
//   997 functional ack       CanonicalFunctionalAck <->  ackTo997
//
// Writers are strict: anything X12 can't carry exactly (a part number with a "*", a unit with no X12 code, a total that doesn't
// add up) is an error listed back to the caller and nothing is produced. Readers say exactly what is wrong with a document
// and never invent a value. No database, no clock: the caller passes `now` and the control number.

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export type Written = { ok: true; text: string } | { ok: false; errors: string[] };

export interface MapOpts {
  profile: X12Profile;
  control: number;
  now: Date;
  /** Partner-specific unit codes on top of the built-in table, keyed by our unit in lower case ("sheet": "SH"). */
  uomMap?: Record<string, string>;
}

// ---------- units ----------

const UOM: [string, string][] = [
  ["ea", "EA"], ["each", "EA"], ["pc", "PC"], ["pcs", "PC"], ["kg", "KG"], ["g", "GR"], ["lb", "LB"], ["lbs", "LB"], ["oz", "OZ"], ["ton", "TN"],
  ["roll", "RL"], ["rolls", "RL"], ["box", "BX"], ["case", "CS"], ["pallet", "PL"], ["sheet", "SH"], ["m", "MR"], ["ft", "FT"], ["in", "IN"],
  ["gal", "GA"], ["l", "LT"], ["pair", "PR"], ["bag", "BG"], ["drum", "DR"], ["bundle", "BD"], ["carton", "CT"], ["ream", "RM"], ["kit", "KT"],
];
const TO_X12 = new Map(UOM);
const FROM_X12 = new Map<string, string>();
for (const [ours, code] of UOM) if (!FROM_X12.has(code)) FROM_X12.set(code, ours);

function unitCode(unit: string, o: MapOpts, e: X12Errors): string {
  const k = unit.trim().toLowerCase();
  const code = o.uomMap?.[k] ?? TO_X12.get(k);
  if (!code) { e.add(`The unit "${unit}" has no X12 unit code (add it to this partner's unit map)`); return ""; }
  return code;
}
function unitName(code: string, o: Pick<MapOpts, "uomMap"> | undefined, e: X12Errors): string {
  const custom = o?.uomMap && Object.entries(o.uomMap).find(([, v]) => v === code)?.[0];
  const name = custom ?? FROM_X12.get(code);
  if (!name) { e.add(`Unknown X12 unit code "${code}"`); return ""; }
  return name;
}

const el = (s: Segment | undefined, i: number) => s?.[i] ?? "";
const finish = (e: X12Errors, o: MapOpts, setId: string, body: Segment[]): Written => {
  if (e.any) return { ok: false, errors: e.list };
  return { ok: true, text: buildInterchange({ profile: o.profile, setId, control: o.control, body, now: o.now }) };
};

function noteSegments(note: string, e: X12Errors): Segment[] {
  const words = e.text(note, "Note", 100_000, false).split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > 80) { e.add("A word in the note is longer than the 80 characters an X12 note line holds"); return []; }
    if ((cur ? cur.length + 1 : 0) + w.length > 80) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > 20) e.add("The note is too long for an X12 document (20 lines of 80 characters)");
  return lines.map((l) => seg("NTE", "GEN", l));
}

/** The order of the NTE lines back into one note. */
const readNote = (segs: Segment[]) => findAll(segs, "NTE").map((s) => el(s, 2)).join(" ");

// =====================================================================================================================
// 850 purchase order
// =====================================================================================================================

export function orderTo850(order: CanonicalOrder, o: MapOpts): Written {
  const e = new X12Errors();
  const po = e.id(order.poNumber, "PO number", 22);
  const buyer = e.text(order.buyer.name, "Buyer name", 60);
  const supplier = e.text(order.supplier.name, "Supplier name", 60);
  const body: Segment[] = [seg("BEG", order.revision > 1 ? "05" : "00", "SA", po, "", toX12Date(order.issuedAt))];
  if (!/^[A-Z]{3}$/.test(order.currency)) e.add("Currency must be a three letter code");
  body.push(seg("CUR", "BY", order.currency));
  if (order.expectedDate) body.push(seg("DTM", "002", toX12Date(order.expectedDate)));
  body.push(...noteSegments(order.note, e));
  if (buyer) body.push(seg("N1", "BY", buyer));
  if (supplier) body.push(seg("N1", "SE", supplier));
  let sum = 0;
  const seen = new Set<number>();
  for (const l of order.lines) {
    if (seen.has(l.lineNo)) e.add(`Line number ${l.lineNo} is used twice`);
    seen.add(l.lineNo);
    const sku = e.id(l.sku, `Line ${l.lineNo} part number`, 48);
    const uom = unitCode(l.unit, o, e);
    if (l.lineTotalCents !== mulCents(l.quantity, l.unitPriceCents)) e.add(`Line ${l.lineNo}: quantity x price doesn't equal the line total`);
    sum += l.lineTotalCents;
    body.push(seg("PO1", l.lineNo, l.quantity, uom, centsToDecimal(l.unitPriceCents), "", "BP", sku));
    const desc = e.text(l.name, `Line ${l.lineNo} description`, 80, true);
    if (desc) body.push(seg("PID", "F", "", "", "", desc));
  }
  if (sum !== order.totalCents) e.add("The order total doesn't equal the sum of its lines");
  body.push(seg("CTT", order.lines.length, e.any ? "0" : sumQty(order.lines.map((l) => l.quantity))));
  body.push(seg("AMT", "TT", centsToDecimal(order.totalCents)));
  return finish(e, o, "850", body);
}

function readOrder(ic: ParsedInterchange, o?: Pick<MapOpts, "uomMap">): Result<CanonicalOrder> {
  const e = new X12Errors();
  const segs = ic.set.segments;
  const beg = find(segs, "BEG");
  if (!beg) return { ok: false, errors: ["The BEG segment is missing"] };
  const purpose = el(beg, 1);
  if (purpose !== "00" && purpose !== "05") e.add(`BEG01 "${purpose}" isn't supported (only 00 original and 05 replace; changes need the 860, which isn't built)`);
  const poNumber = el(beg, 3);
  if (!poNumber) e.add("BEG03 (PO number) is missing");
  const issuedAt = fromX12Date(el(beg, 5));
  if (!issuedAt) e.add("BEG05 (PO date) is missing or not CCYYMMDD");
  const cur = find(segs, "CUR", (s) => s[1] === "BY" || s[1] === "SE");
  const currency = el(cur, 2) || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) e.add(`Currency "${currency}" isn't a three letter code`);
  const dtm = find(segs, "DTM", (s) => s[1] === "002");
  const expectedDate = dtm ? fromX12Date(el(dtm, 2)) : null;
  if (dtm && !expectedDate) e.add("DTM*002 (delivery date) isn't CCYYMMDD");
  const party = (...codes: string[]) => el(find(segs, "N1", (s) => codes.includes(el(s, 1))), 2);

  const lines: CanonicalOrder["lines"] = [];
  let current: CanonicalOrder["lines"][number] | null = null;
  let total: number | null = null;
  for (const s of segs) {
    if (s[0] === "PO1") {
      const lineNo = el(s, 1) === "" ? lines.length + 1 : Number(el(s, 1));
      if (!Number.isInteger(lineNo) || lineNo < 1) { e.add(`PO101 "${el(s, 1)}" isn't a line number`); continue; }
      const quantity = el(s, 2);
      if (!/^\d+(\.\d+)?$/.test(quantity)) e.add(`Line ${lineNo}: quantity "${quantity}" isn't a plain positive number`);
      const price = decimalToCents(el(s, 4));
      if (price === null) e.add(`Line ${lineNo}: price "${el(s, 4)}" is missing or has more than two decimals (not supported)`);
      let sku = "";
      for (const want of ["BP", "VP", "VN", "UP"]) {
        for (let i = 6; i + 1 < s.length; i += 2) if (s[i] === want) { sku = s[i + 1]!; break; }
        if (sku) break;
      }
      if (!sku) e.add(`Line ${lineNo}: no part number (PO106/PO107 with BP, VP, VN or UP)`);
      const unit = unitName(el(s, 3), o, e);
      current = { lineNo, sku, name: "", quantity, unit, unitPriceCents: price ?? 0, lineTotalCents: /^\d+(\.\d+)?$/.test(quantity) ? mulCents(quantity, price ?? 0) : 0 };
      lines.push(current);
    } else if (s[0] === "PID" && current && el(s, 1) === "F" && !current.name) {
      current.name = el(s, 5);
    } else if (s[0] === "AMT" && el(s, 1) === "TT") {
      total = decimalToCents(el(s, 2));
    }
  }
  if (!lines.length) e.add("The order has no PO1 lines");
  if (e.any || !issuedAt) return { ok: false, errors: e.list };
  const sum = lines.reduce((a, l) => a + l.lineTotalCents, 0);
  return {
    ok: true,
    value: {
      kind: "order", version: 1, poNumber, revision: purpose === "05" ? 2 : 1, issuedAt, buyer: { name: party("BY") }, supplier: { name: party("SE", "SU", "VN"), contact: "", email: "" },
      currency, expectedDate, note: readNote(segs), lines, totalCents: total ?? sum, portalUrl: null,
    },
  };
}

// =====================================================================================================================
// 855 purchase order acknowledgment
// =====================================================================================================================

const LINE_CODE: Record<CanonicalOrderResponse["lines"][number]["status"], string> = { accepted: "IA", changed: "IC", rejected: "IR" };
const LINE_STATUS: Record<string, CanonicalOrderResponse["lines"][number]["status"]> = { IA: "accepted", IC: "changed", IQ: "changed", IE: "changed", IP: "changed", IB: "changed", IR: "rejected", ID: "rejected" };
const BAK_CODE: Record<CanonicalOrderResponse["status"], string> = { accepted: "AD", changed: "AC", rejected: "RJ" };
const BAK_STATUS: Record<string, CanonicalOrderResponse["status"]> = { AD: "accepted", AK: "accepted", AC: "changed", RJ: "rejected" };

export function responseTo855(r: CanonicalOrderResponse, o: MapOpts): Written {
  const e = new X12Errors();
  const po = e.id(r.poNumber, "PO number", 22);
  const body: Segment[] = [seg("BAK", "00", BAK_CODE[r.status], po, toX12Date(r.poDate), "", "", "", "", toX12Date(r.issuedAt))];
  body.push(...noteSegments(r.note, e));
  if (r.status === "accepted" && r.lines.some((l) => l.status !== "accepted")) e.add("The order is marked accepted but a line is not");
  if (r.status === "rejected" && r.lines.some((l) => l.status !== "rejected")) e.add("The order is marked rejected but a line is not");
  if (r.status === "changed" && r.lines.length && r.lines.every((l) => l.status === "accepted")) e.add("The order is marked changed but every line is accepted as ordered");
  for (const l of r.lines) {
    const sku = e.id(l.sku, `Line ${l.lineNo} part number`, 48);
    const uom = unitCode(l.unit, o, e);
    body.push(seg("PO1", l.lineNo, l.orderedQuantity, uom, "", "", "BP", sku));
    if (l.status === "rejected" && l.quantity !== "0") e.add(`Line ${l.lineNo} is rejected, so its quantity must be 0`);
    body.push(seg("ACK", LINE_CODE[l.status], l.status === "rejected" ? l.orderedQuantity : l.quantity, uom, ...(l.promisedDate ? ["067", toX12Date(l.promisedDate)] : [])));
  }
  body.push(seg("CTT", r.lines.length));
  return finish(e, o, "855", body);
}

function readResponse(ic: ParsedInterchange, o?: Pick<MapOpts, "uomMap">): Result<CanonicalOrderResponse> {
  const e = new X12Errors();
  const segs = ic.set.segments;
  const bak = find(segs, "BAK");
  if (!bak) return { ok: false, errors: ["The BAK segment is missing"] };
  const status = BAK_STATUS[el(bak, 2)];
  if (!status) e.add(`BAK02 "${el(bak, 2)}" isn't supported (AD, AC, RJ, AK)`);
  const poNumber = el(bak, 3);
  if (!poNumber) e.add("BAK03 (PO number) is missing");
  const poDate = fromX12Date(el(bak, 4));
  if (!poDate) e.add("BAK04 (PO date) is missing or not CCYYMMDD");
  const issuedAt = fromX12Date(el(bak, 9)) ?? poDate;
  const lines: CanonicalOrderResponse["lines"] = [];
  let cur: { lineNo: number; sku: string; ordered: string; unit: string } | null = null;
  for (const s of segs) {
    if (s[0] === "PO1") {
      const lineNo = Number(el(s, 1) || lines.length + 1);
      let sku = "";
      for (let i = 6; i + 1 < s.length; i += 2) if (["BP", "VP", "VN", "UP"].includes(s[i]!)) { sku = s[i + 1]!; break; }
      cur = { lineNo, sku, ordered: el(s, 2), unit: unitName(el(s, 3), o, e) };
      if (!sku) e.add(`Line ${lineNo}: no part number`);
      if (!/^\d+(\.\d+)?$/.test(cur.ordered)) e.add(`Line ${lineNo}: ordered quantity "${cur.ordered}" isn't a plain number`);
    } else if (s[0] === "ACK" && cur) {
      const st = LINE_STATUS[el(s, 1)];
      if (!st) { e.add(`Line ${cur.lineNo}: ACK01 "${el(s, 1)}" isn't supported`); continue; }
      const q = el(s, 2) || cur.ordered;
      if (!/^\d+(\.\d+)?$/.test(q)) e.add(`Line ${cur.lineNo}: ACK02 "${q}" isn't a plain number`);
      const dateQ = ["067", "068", "017"].includes(el(s, 4)) ? fromX12Date(el(s, 5)) : null;
      lines.push({ lineNo: cur.lineNo, sku: cur.sku, status: st, orderedQuantity: cur.ordered, quantity: st === "rejected" ? "0" : q, unit: cur.unit, promisedDate: dateQ });
      cur = null;
    }
  }
  if (e.any || !status || !poDate || !issuedAt) return { ok: false, errors: e.list };
  return { ok: true, value: { kind: "order_response", version: 1, poNumber, status, poDate, issuedAt, note: readNote(segs), lines } };
}

// =====================================================================================================================
// 856 ship notice (shipment / order / item hierarchy, one order per notice)
// =====================================================================================================================

export function shipTo856(n: CanonicalShipNotice, o: MapOpts): Written {
  const e = new X12Errors();
  const no = e.id(n.shipmentNo, "Shipment number", 30);
  const po = e.id(n.poNumber, "PO number", 22);
  const time = o.now.toISOString().slice(11, 16).replace(":", "");
  const body: Segment[] = [seg("BSN", "00", no, toX12Date(n.shipDate), time), seg("HL", 1, "", "S")];
  body.push(seg("DTM", "011", toX12Date(n.shipDate)));
  const carrier = e.text(n.carrier, "Carrier", 35);
  if (carrier) body.push(seg("TD5", "", "", "", "", carrier));
  const tracking = n.trackingNumber ? e.id(n.trackingNumber, "Tracking number", 30) : "";
  if (tracking) body.push(seg("REF", "CN", tracking));
  body.push(seg("HL", 2, 1, "O"), seg("PRF", po));
  let hl = 2;
  for (const l of n.lines) {
    hl += 1;
    const sku = e.id(l.sku, `Line ${l.lineNo} part number`, 48);
    const uom = unitCode(l.unit, o, e);
    body.push(seg("HL", hl, 2, "I"), seg("LIN", l.lineNo, "BP", sku), seg("SN1", "", l.quantity, uom));
  }
  body.push(seg("CTT", hl));
  return finish(e, o, "856", body);
}

function readShip(ic: ParsedInterchange, o?: Pick<MapOpts, "uomMap">): Result<CanonicalShipNotice> {
  const e = new X12Errors();
  const segs = ic.set.segments;
  const bsn = find(segs, "BSN");
  if (!bsn) return { ok: false, errors: ["The BSN segment is missing"] };
  if (el(bsn, 1) !== "00") e.add(`BSN01 "${el(bsn, 1)}" isn't supported (only 00 original)`);
  const shipmentNo = el(bsn, 2);
  if (!shipmentNo) e.add("BSN02 (shipment number) is missing");
  const dtm = find(segs, "DTM", (s) => s[1] === "011");
  const shipDate = fromX12Date(el(dtm, 2)) ?? fromX12Date(el(bsn, 3));
  if (!shipDate) e.add("No ship date (DTM*011 or BSN03 as CCYYMMDD)");
  const pos = [...new Set(findAll(segs, "PRF").map((s) => el(s, 1)).filter(Boolean))];
  if (pos.length !== 1) e.add(pos.length ? "More than one order in one ship notice isn't supported" : "No PRF (PO number) segment");
  const ref = find(segs, "REF", (s) => s[1] === "CN" || s[1] === "2I");
  const lines: CanonicalShipNotice["lines"] = [];
  let cur: { lineNo: number; sku: string } | null = null;
  for (const s of segs) {
    if (s[0] === "LIN") {
      let sku = "";
      for (let i = 2; i + 1 < s.length; i += 2) if (["BP", "VP", "VN", "UP"].includes(s[i]!)) { sku = s[i + 1]!; break; }
      const lineNo = Number(el(s, 1) || lines.length + 1);
      if (!sku) e.add(`Item ${lineNo}: no part number in LIN`);
      cur = { lineNo, sku };
    } else if (s[0] === "SN1" && cur) {
      const q = el(s, 2);
      if (!/^\d+(\.\d+)?$/.test(q)) e.add(`Item ${cur.lineNo}: shipped quantity "${q}" isn't a plain number`);
      lines.push({ lineNo: cur.lineNo, sku: cur.sku, quantity: q, unit: unitName(el(s, 3), o, e) });
      cur = null;
    }
  }
  if (!lines.length) e.add("The ship notice has no items (LIN/SN1)");
  if (e.any || !shipDate) return { ok: false, errors: e.list };
  return { ok: true, value: { kind: "despatch_advice", version: 1, shipmentNo, poNumber: pos[0]!, shipDate, carrier: el(find(segs, "TD5"), 5), trackingNumber: el(ref, 2), lines } };
}

// =====================================================================================================================
// 810 invoice
// =====================================================================================================================

export function invoiceTo810(inv: CanonicalInvoice, o: MapOpts): Written {
  const e = new X12Errors();
  const no = e.id(inv.invoiceNumber, "Invoice number", 22);
  const po = inv.poNumber ? e.id(inv.poNumber, "PO number", 22) : "";
  const body: Segment[] = [seg("BIG", toX12Date(inv.invoiceDate), no, "", po)];
  body.push(seg("CUR", "BY", inv.currency));
  if (inv.dueDate) body.push(seg("ITD", "05", "3", "", "", "", toX12Date(inv.dueDate)));
  let sum = 0;
  for (const l of inv.lines) {
    const sku = e.id(l.sku, `Line ${l.lineNo} part number`, 48);
    const uom = unitCode(l.unit, o, e);
    if (l.lineTotalCents !== mulCents(l.quantity, l.unitPriceCents)) e.add(`Line ${l.lineNo}: quantity x price doesn't equal the line total`);
    sum += l.lineTotalCents;
    body.push(seg("IT1", l.lineNo, l.quantity, uom, centsToDecimal(l.unitPriceCents), "", "BP", sku));
    const desc = e.text(l.name, `Line ${l.lineNo} description`, 80, true);
    if (desc) body.push(seg("PID", "F", "", "", "", desc));
  }
  if (sum + inv.taxCents !== inv.totalCents) e.add("The invoice total isn't the sum of its lines plus tax");
  body.push(seg("TDS", inv.totalCents));
  if (inv.taxCents > 0) body.push(seg("TXI", "TX", centsToDecimal(inv.taxCents)));
  body.push(seg("CTT", inv.lines.length));
  return finish(e, o, "810", body);
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function readInvoice(ic: ParsedInterchange, o?: Pick<MapOpts, "uomMap">): Result<CanonicalInvoice> {
  const e = new X12Errors();
  const segs = ic.set.segments;
  const big = find(segs, "BIG");
  if (!big) return { ok: false, errors: ["The BIG segment is missing"] };
  const invoiceDate = fromX12Date(el(big, 1));
  if (!invoiceDate) e.add("BIG01 (invoice date) is missing or not CCYYMMDD");
  const invoiceNumber = el(big, 2);
  if (!invoiceNumber) e.add("BIG02 (invoice number) is missing");
  const cur = find(segs, "CUR");
  const currency = el(cur, 2) || "USD";
  const itd = find(segs, "ITD");
  let dueDate: string | null = null;
  if (itd) {
    dueDate = fromX12Date(el(itd, 6));
    if (!dueDate && /^\d{1,3}$/.test(el(itd, 7)) && invoiceDate) dueDate = addDays(invoiceDate, Number(el(itd, 7)));
  }
  const lines: CanonicalInvoice["lines"] = [];
  let curLine: CanonicalInvoice["lines"][number] | null = null;
  for (const s of segs) {
    if (s[0] === "IT1") {
      const lineNo = Number(el(s, 1) || lines.length + 1);
      const quantity = el(s, 2);
      if (!/^\d+(\.\d+)?$/.test(quantity)) e.add(`Line ${lineNo}: quantity "${quantity}" isn't a plain positive number`);
      const price = decimalToCents(el(s, 4));
      if (price === null) e.add(`Line ${lineNo}: price "${el(s, 4)}" is missing or has more than two decimals (not supported)`);
      let sku = "";
      for (let i = 6; i + 1 < s.length; i += 2) if (["BP", "VP", "VN", "UP"].includes(s[i]!)) { sku = s[i + 1]!; break; }
      if (!sku) e.add(`Line ${lineNo}: no part number`);
      curLine = { lineNo, sku, name: "", quantity, unit: unitName(el(s, 3), o, e), unitPriceCents: price ?? 0, lineTotalCents: /^\d+(\.\d+)?$/.test(quantity) ? mulCents(quantity, price ?? 0) : 0 };
      lines.push(curLine);
    } else if (s[0] === "PID" && curLine && el(s, 1) === "F" && !curLine.name) curLine.name = el(s, 5);
  }
  if (!lines.length) e.add("The invoice has no IT1 lines");
  const tds = find(segs, "TDS");
  const total = /^\d+$/.test(el(tds, 1)) ? Number(el(tds, 1)) : null;
  if (total === null) e.add("TDS01 (invoice total, in cents) is missing or isn't a whole number");
  const txi = findAll(segs, "TXI").find((s) => el(s, 1) === "TX");
  const tax = txi ? (decimalToCents(el(txi, 2)) ?? 0) : 0;
  if (e.any || !invoiceDate || total === null) return { ok: false, errors: e.list };
  return { ok: true, value: { kind: "invoice", version: 1, invoiceNumber, invoiceDate, dueDate, poNumber: el(big, 4), currency, lines, taxCents: tax, totalCents: total } };
}

// =====================================================================================================================
// 997 functional acknowledgment
// =====================================================================================================================

const AK5_TEXT: Record<string, string> = {
  "1": "Transaction set not supported", "2": "Transaction set trailer missing", "3": "Control number in header and trailer don't match",
  "4": "Number of segments doesn't match the SE count", "5": "One or more segments in error", "6": "Missing or invalid transaction set id", "7": "Missing or invalid control number",
};
const AK5_STATUS: Record<string, CanonicalFunctionalAck["status"]> = { A: "accepted", E: "accepted_with_errors", R: "rejected" };

/** The receipt for a document we parsed. `problems` are AK5 codes; with none it is an acceptance. */
export function acknowledge(ic: ParsedInterchange, codes: string[] = []): CanonicalFunctionalAck {
  return {
    kind: "functional_ack", version: 1, groupCode: ic.group.code, groupControl: ic.group.control, setId: ic.set.id, setControl: ic.set.control,
    status: codes.length ? "rejected" : "accepted", errorCodes: codes.slice(0, 5), errors: codes.slice(0, 5).map((c) => AK5_TEXT[c] ?? `Error ${c}`),
  };
}

export function ackTo997(a: CanonicalFunctionalAck, o: MapOpts): Written {
  const e = new X12Errors();
  const code = a.status === "accepted" ? "A" : a.status === "accepted_with_errors" ? "E" : "R";
  if (a.status === "accepted" && a.errorCodes.length) e.add("An accepted receipt can't list errors");
  if (a.status === "rejected" && !a.errorCodes.length) e.add("A rejected receipt must say why (an error code)");
  const body: Segment[] = [seg("AK1", a.groupCode, a.groupControl), seg("AK2", a.setId, a.setControl), seg("AK5", code, ...a.errorCodes), seg("AK9", code, 1, 1, a.status === "rejected" ? 0 : 1)];
  return finish(e, o, "997", body);
}

function readAck(ic: ParsedInterchange): Result<CanonicalFunctionalAck> {
  const segs = ic.set.segments;
  const ak1 = find(segs, "AK1"), ak2 = find(segs, "AK2"), ak5 = find(segs, "AK5");
  const e = new X12Errors();
  if (!ak1) e.add("The AK1 segment is missing");
  if (!ak2) e.add("The AK2 segment is missing");
  if (!ak5) e.add("The AK5 segment is missing");
  if (findAll(segs, "AK2").length > 1) e.add("A receipt for more than one transaction set isn't supported");
  const status = AK5_STATUS[el(ak5, 1)];
  if (ak5 && !status) e.add(`AK501 "${el(ak5, 1)}" isn't A, E or R`);
  if (e.any || !status) return { ok: false, errors: e.list };
  const codes = ak5!.slice(2, 7).filter(Boolean);
  return {
    ok: true,
    value: { kind: "functional_ack", version: 1, groupCode: el(ak1, 1), groupControl: el(ak1, 2), setId: el(ak2, 1), setControl: el(ak2, 2), status, errorCodes: codes, errors: codes.map((c) => AK5_TEXT[c] ?? `Error ${c}`) },
  };
}

// =====================================================================================================================
// reading any of them
// =====================================================================================================================

export type X12Doc =
  | { kind: "order"; doc: CanonicalOrder }
  | { kind: "order_response"; doc: CanonicalOrderResponse }
  | { kind: "despatch_advice"; doc: CanonicalShipNotice }
  | { kind: "invoice"; doc: CanonicalInvoice }
  | { kind: "functional_ack"; doc: CanonicalFunctionalAck };

export const SET_TO_DOC_TYPE = { "850": "order", "855": "order_response", "856": "despatch_advice", "810": "invoice", "997": "functional_ack" } as const;

/** Parses the interchange and maps the one transaction set in it, or says everything that is wrong. */
export function readX12(text: string, o?: Pick<MapOpts, "uomMap">): { ok: true; interchange: ParsedInterchange; doc: X12Doc } | { ok: false; errors: string[] } {
  const p = parseX12(text);
  if (!p.ok) return p;
  const ic = p.interchange;
  const wrap = <K extends X12Doc["kind"]>(r: Result<Extract<X12Doc, { kind: K }>["doc"]>, kind: K) =>
    r.ok ? { ok: true as const, interchange: ic, doc: { kind, doc: r.value } as X12Doc } : { ok: false as const, errors: r.errors };
  switch (ic.set.id) {
    case "850": return wrap(readOrder(ic, o), "order");
    case "855": return wrap(readResponse(ic, o), "order_response");
    case "856": return wrap(readShip(ic, o), "despatch_advice");
    case "810": return wrap(readInvoice(ic, o), "invoice");
    case "997": return wrap(readAck(ic), "functional_ack");
    default: return { ok: false, errors: [`Transaction set ${ic.set.id} isn't supported (850, 855, 856, 810 and 997 are)`] };
  }
}

/** What the order page shows for a supplier's answer that came as X12 (same shape the supplier page produces). */
export function answerOf(doc: X12Doc): { action: "confirm" | "reject" | "ship"; promisedDate: string | null; shipDate?: string; carrier?: string; trackingNumber?: string; note: string } | null {
  if (doc.kind === "order_response") {
    const r = doc.doc;
    const changes = r.lines.filter((l) => l.status !== "accepted").map((l) => `line ${l.lineNo}: ${l.status === "rejected" ? "rejected" : `${l.orderedQuantity} -> ${l.quantity}${l.promisedDate ? ` by ${l.promisedDate}` : ""}`}`);
    const note = [r.note, r.status === "changed" && changes.length ? `Changed: ${changes.join("; ")}` : ""].filter(Boolean).join(" ");
    return { action: r.status === "rejected" ? "reject" : "confirm", promisedDate: r.lines.find((l) => l.promisedDate)?.promisedDate ?? null, note };
  }
  if (doc.kind === "despatch_advice") return { action: "ship", promisedDate: null, shipDate: doc.doc.shipDate, carrier: doc.doc.carrier, trackingNumber: doc.doc.trackingNumber, note: "" };
  return null;
}
