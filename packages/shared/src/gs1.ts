/**
 * GS1 element strings as printed on GS1-128 labels (and carried in Data Matrix / QR): SSCC (00), GTIN (01),
 * contained GTIN (02), batch/lot (10), dates (11-17), serial (21), counts (30, 37), and a handful of others
 * that turn up on pallet and carton labels. Pure functions, no dependencies, so the phone, the server and the
 * tests all read a label the same way.
 *
 * The rule here is: read what is certainly there, and refuse the rest. A label that is damaged, cut short, has a
 * wrong check digit, an impossible date or a field we don't know how to measure is rejected with a reason; it is
 * never "repaired" or guessed at. See docs/reports/INV-20-floor-scan.md for what was checked against the GS1
 * General Specifications and what could not be.
 */

/** The GS1 field separator: what FNC1 becomes in the data a scanner transmits (ASCII 29). */
export const GS = "\x1d";

/** GS1 symbology identifiers (AIM): GS1-128, GS1 Data Matrix, GS1 QR. Their presence says "this is GS1 data". */
const SYMBOLOGY_IDS = ["]C1", "]d2", "]Q3"] as const;

interface AiSpec {
  title: string;
  /** Characters allowed: N = digits, X = GS1 character set 82. */
  type: "N" | "X";
  min: number;
  max: number;
  /** Predefined length: the field ends by itself, so no separator follows it. */
  fixed: boolean;
  check?: boolean;
  date?: boolean;
}

const fixedN = (title: string, n: number, extra: Partial<AiSpec> = {}): AiSpec => ({ title, type: "N", min: n, max: n, fixed: true, ...extra });
const varX = (title: string, max: number, min = 1): AiSpec => ({ title, type: "X", min, max, fixed: false });
const varN = (title: string, max: number, min = 1): AiSpec => ({ title, type: "N", min, max, fixed: false });

/**
 * The AIs we know how to measure. Fixed (predefined) lengths and the "needs a separator" rule follow the GS1
 * Barcode Syntax Dictionary (Apache-2.0, published by GS1); anything not listed is refused, because without its
 * length we can't tell where it ends and so can't read the fields after it.
 */
const SPECS: Record<string, AiSpec> = {
  "00": fixedN("SSCC", 18, { check: true }),
  "01": fixedN("GTIN", 14, { check: true }),
  "02": fixedN("GTIN of the contents", 14, { check: true }),
  "03": fixedN("GTIN (made to order)", 14, { check: true }),
  "10": varX("Batch/lot", 20),
  "11": fixedN("Production date", 6, { date: true }),
  "12": fixedN("Due date", 6, { date: true }),
  "13": fixedN("Packaging date", 6, { date: true }),
  "15": fixedN("Best before date", 6, { date: true }),
  "16": fixedN("Sell by date", 6, { date: true }),
  "17": fixedN("Expiry date", 6, { date: true }),
  "20": fixedN("Variant", 2),
  "21": varX("Serial number", 20),
  "22": varX("Consumer product variant", 20),
  "240": varX("Additional product id", 30),
  "241": varX("Customer part number", 30),
  "242": varN("Made-to-order variation", 6),
  "243": varX("Packaging component number", 20),
  "250": varX("Secondary serial number", 30),
  "251": varX("Reference to source", 30),
  "254": varX("GLN extension", 20),
  "30": varN("Count (variable)", 8),
  "37": varN("Count of contained items", 8),
  "400": varX("Customer purchase order", 30),
  "401": varX("Consignment number", 30),
  "402": { title: "Shipment id", type: "N", min: 17, max: 17, fixed: false, check: true },
  "403": varX("Routing code", 30),
  "410": fixedN("Ship to location", 13, { check: true }),
  "411": fixedN("Bill to location", 13, { check: true }),
  "412": fixedN("Purchased from location", 13, { check: true }),
  "413": fixedN("Ship for location", 13, { check: true }),
  "414": fixedN("Location number", 13, { check: true }),
  "415": fixedN("Pay to location", 13, { check: true }),
  "416": fixedN("Production location", 13, { check: true }),
  "417": fixedN("Party", 13, { check: true }),
  "420": varX("Ship to postal code", 20),
  "422": { title: "Country of origin", type: "N", min: 3, max: 3, fixed: false },
  "8004": varX("Individual asset id", 30),
  ...Object.fromEntries(["90", ...Array.from({ length: 9 }, (_, i) => `9${i + 1}`)].map((ai) => [ai, varX("Company internal", ai === "90" ? 30 : 90)])),
};

/** Measures: 3100-3695 (weights, lengths, volumes...). Six digits, fixed length; the last digit of the AI is the decimal point. */
const MEASURE = /^3[1-6]\d[0-5]$/;

function specOf(ai: string): AiSpec | null {
  if (SPECS[ai]) return SPECS[ai]!;
  if (MEASURE.test(ai)) return fixedN("Measure", 6);
  return null;
}

/** The AI at the start of `s`: the shortest of 2, 3 or 4 digits that we know. */
function aiAt(s: string): string | null {
  for (const n of [2, 3, 4]) {
    const ai = s.slice(0, n);
    if (ai.length === n && /^\d+$/.test(ai) && specOf(ai)) return ai;
  }
  return null;
}

// ---------- the pieces ----------

/** GS1 character set 82: digits, upper and lower case letters and !"%&'()*+,-./:;<=>?_ . */
const CSET82 = /^[0-9A-Za-z!"%&'()*+,\-./:;<=>?_]+$/;

/** The GS1 check digit (mod 10, weights 3 and 1 from the right) of the last digit of `digits`. */
export function gs1CheckDigitOk(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

const daysIn = (y: number, m: number) => [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/** A real calendar date written YYYY-MM-DD. */
export function isRealIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * YYMMDD to an ISO date. Day 00 means "the last day of the month" (the GS1 rule for dates known only to the month).
 * The century is the one that puts the year within 49 years before to 50 years after `now`.
 */
export function gs1Date(yymmdd: string, now = new Date()): { iso: string; dayUnspecified: boolean } | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  const thisYear = now.getUTCFullYear();
  let year = thisYear - (thisYear % 100) + yy;
  if (year - thisYear > 50) year -= 100;
  else if (thisYear - year > 49) year += 100;
  if (mm < 1 || mm > 12) return null;
  const last = daysIn(year, mm);
  if (dd > last) return null;
  const day = dd === 0 ? last : dd;
  return { iso: `${year}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`, dayUnspecified: dd === 0 };
}

// ---------- reading a label ----------

export interface Gs1Element {
  ai: string;
  value: string;
}

export interface Gs1Label {
  /** How we knew it was GS1: a symbology identifier, a separator, printed (01)... brackets, or only because every rule held. */
  marker: "symbology" | "separator" | "brackets" | "bare";
  elements: Gs1Element[];
  /** (00) the pallet or carton this label is on. */
  sscc?: string;
  /** (01), else (02): the product. 14 digits; items store their barcode as 8, 12, 13 or 14 digits, and the lookup tolerates the padding. */
  gtin?: string;
  /** (10) */
  lot?: string;
  /** (17), as an ISO date. */
  expiry?: string;
  /** True when the label gave the month only (day 00), so `expiry` is the last day of it. */
  expiryDayUnspecified?: boolean;
  /** (37), else (30): how many of the product are on the label. */
  quantity?: number;
  /** (21) */
  serial?: string;
}

export type Gs1Read = { ok: true; label: Gs1Label } | { ok: false; error: string };

const fail = (error: string): Gs1Read => ({ ok: false, error });

/** Reads elements out of data whose separators are GS characters. */
function readElements(data: string): { ok: true; elements: Gs1Element[] } | { ok: false; error: string } {
  const elements: Gs1Element[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === GS) { i++; continue; }
    const ai = aiAt(data.slice(i));
    if (!ai) return { ok: false, error: `Can't read this label: "${data.slice(i, i + 4)}" isn't a code we know the length of` };
    const spec = specOf(ai)!;
    i += ai.length;
    let value: string;
    if (spec.fixed) {
      value = data.slice(i, i + spec.max);
      if (value.length < spec.max || value.includes(GS)) return { ok: false, error: `${spec.title} (${ai}) should be ${spec.max} characters, and the label is cut short` };
      i += spec.max;
    } else {
      const end = data.indexOf(GS, i);
      value = end === -1 ? data.slice(i) : data.slice(i, end);
      i += value.length;
    }
    if (!value) return { ok: false, error: `${spec.title} (${ai}) is empty` };
    if (!spec.fixed && value.length > spec.max) {
      return { ok: false, error: `${spec.title} (${ai}) is ${value.length} characters long and the most it can be is ${spec.max}. The label may be missing a separator.` };
    }
    if (value.length < spec.min) return { ok: false, error: `${spec.title} (${ai}) is too short` };
    if (spec.type === "N" ? !/^\d+$/.test(value) : !CSET82.test(value)) {
      return { ok: false, error: spec.type === "N" ? `${spec.title} (${ai}) should be digits only` : `${spec.title} (${ai}) has a character a GS1 label can't carry` };
    }
    elements.push({ ai, value });
  }
  return { ok: true, elements };
}

/** The printed form: (01)09506000134352(10)LOT7. A value that contains "(" and ")" is ambiguous here, so brackets are for people. */
function fromBrackets(text: string): { ok: true; data: string } | { ok: false; error: string } {
  const parts = [...text.matchAll(/\((\d{2,4})\)/g)];
  if (!parts.length || parts[0]!.index !== 0) return { ok: false, error: "Can't read this label: it should start with an (AI) such as (01)" };
  let data = "";
  for (let p = 0; p < parts.length; p++) {
    const ai = parts[p]![1]!;
    const spec = specOf(ai);
    if (!spec) return { ok: false, error: `Can't read this label: (${ai}) isn't a code we know the length of` };
    const start = parts[p]!.index! + ai.length + 2;
    const end = p + 1 < parts.length ? parts[p + 1]!.index! : text.length;
    data += ai + text.slice(start, end) + (!spec.fixed && p + 1 < parts.length ? GS : "");
  }
  return { ok: true, data };
}

function interpret(elements: Gs1Element[], marker: Gs1Label["marker"], now: Date): Gs1Read {
  const seen = new Set<string>();
  for (const e of elements) {
    if (seen.has(e.ai)) return fail(`${specOf(e.ai)!.title} (${e.ai}) appears twice on this label`);
    seen.add(e.ai);
    const spec = specOf(e.ai)!;
    if (spec.check && !gs1CheckDigitOk(e.value)) return fail(`${spec.title} (${e.ai}) has a wrong check digit, so it was misread or the label is damaged`);
    if (spec.date && !gs1Date(e.value, now)) return fail(`${spec.title} (${e.ai}) isn't a real date`);
  }
  const get = (ai: string) => elements.find((e) => e.ai === ai)?.value;
  const label: Gs1Label = { marker, elements };
  const sscc = get("00");
  if (sscc) label.sscc = sscc;
  const gtin = get("01") ?? get("02");
  if (gtin) label.gtin = gtin;
  const lot = get("10");
  if (lot) label.lot = lot;
  const serial = get("21");
  if (serial) label.serial = serial;
  const expiry = get("17");
  if (expiry) {
    const d = gs1Date(expiry, now)!;
    label.expiry = d.iso;
    if (d.dayUnspecified) label.expiryDayUnspecified = true;
  }
  if (seen.has("30") && seen.has("37")) return fail("This label gives the count twice (30 and 37)");
  const count = get("37") ?? get("30");
  if (count !== undefined) {
    const n = Number(count);
    if (!Number.isSafeInteger(n) || n < 1) return fail("The count on this label isn't a number of at least 1");
    label.quantity = n;
  }
  return { ok: true, label };
}

/**
 * Reads one scan as a GS1 label. Use `scanKind` to decide whether a scan is a GS1 label at all.
 * `now` only matters for the century of two-digit years.
 */
export function readGs1(raw: string, now = new Date()): Gs1Read {
  let text = raw.trim();
  if (text.length > 120) return fail("That code is too long to be a label we can read");
  let marker: Gs1Label["marker"] = "bare";
  const prefix = SYMBOLOGY_IDS.find((p) => text.startsWith(p));
  if (prefix) {
    text = text.slice(prefix.length);
    marker = "symbology";
  }
  if (text.startsWith("(")) {
    const converted = fromBrackets(text);
    if (!converted.ok) return fail(converted.error);
    const read = readElements(converted.data);
    return read.ok ? interpret(read.elements, marker === "symbology" ? "symbology" : "brackets", now) : fail(read.error);
  }
  if (text.includes(GS) && marker === "bare") marker = "separator";
  if (!text) return fail("That label is empty");
  const read = readElements(text);
  return read.ok ? interpret(read.elements, marker, now) : fail(read.error);
}

/**
 * What a scanned string is:
 *  - `gs1`: a label, and it read cleanly.
 *  - `bad`: it is plainly meant to be a label (it has a GS1 symbology identifier, separators or (AI) brackets) but it
 *    doesn't read: show the reason, don't look the text up as if it were a SKU.
 *  - `bare`: a string of digits that happens to read as a complete label (every length, check digit and date holds).
 *    Only treated as a label if nothing in the system has that exact code, since a SKU or barcode can look like one.
 *  - `plain`: anything else: an ordinary SKU, barcode, location or roll label.
 */
export type ScanKind = { kind: "gs1"; label: Gs1Label } | { kind: "bad"; error: string } | { kind: "bare"; label: Gs1Label } | { kind: "plain" };

export function scanKind(raw: string, now = new Date()): ScanKind {
  const text = raw.trim();
  const marked = SYMBOLOGY_IDS.some((p) => text.startsWith(p)) || text.includes(GS) || /^\(\d{2,4}\)/.test(text);
  const read = readGs1(text, now);
  if (marked) return read.ok ? { kind: "gs1", label: read.label } : { kind: "bad", error: read.error };
  // Unmarked: certain only when the whole string reads and starts with an identifier of a thing (SSCC or GTIN).
  if (read.ok && read.label.elements.length >= 1 && ["00", "01", "02"].includes(read.label.elements[0]!.ai)) {
    return { kind: "bare", label: { ...read.label, marker: "bare" } };
  }
  return { kind: "plain" };
}
