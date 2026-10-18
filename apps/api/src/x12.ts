// INV-14: ANSI X12 at the syntax level. Pure functions, no database, no clock (callers pass `now`).
//
//   buildInterchange(...)   wraps one transaction set in ISA/GS/ST ... SE/GE/IEA with the right counts and control numbers
//   parseX12(text)          reads one interchange, with strict checks of the envelope (counts, matching control numbers)
//   X12Errors               collects every problem in a document so a person sees them all at once, not one at a time
//
// We send and read ONE transaction set per interchange. That is what most small trading partners do and it keeps the
// control numbers simple (ISA13 = GS06, ST02 = 0001). A file with more than one set is refused, not half read.
//
// The standard itself is licensed; the segment layouts here come from public trading-partner guides and are the common
// core, not a full implementation (see docs/reports/INV-14-x12.md for exactly what is and isn't covered).

export const X12_CONTENT_TYPE = "application/edi-x12";
export const MAX_SEGMENTS = 20_000;

export type Segment = string[]; // [segment id, element 1, element 2, ...]

export const ELEM = "*";
export const SEG = "~";
export const SUB = ">";

export type X12Version = "004010" | "005010";

/** Who is on each side of an interchange, from the SENDER's point of view. */
export interface X12Profile {
  senderQual: string;
  senderId: string;
  receiverQual: string;
  receiverId: string;
  version: X12Version;
  /** ISA15: T for test, P for production. Test partners only ever carry T. */
  usage: "T" | "P";
}

/** Gathers problems with a document; mappers return them all together. */
export class X12Errors {
  readonly list: string[] = [];
  add(msg: string) { if (!this.list.includes(msg) && this.list.length < 50) this.list.push(msg); }
  get any() { return this.list.length > 0; }

  /** An identifier (PO number, part number, party id): must be exactly representable, so a delimiter or control character is an error, never silently changed. */
  id(value: string, label: string, max: number, min = 1): string {
    const v = value.trim();
    if (v.length < min) { this.add(`${label} is required`); return v; }
    if (v.length > max) this.add(`${label} "${v.slice(0, 30)}" is longer than the ${max} characters X12 allows`);
    if (/[*~>\x00-\x1f\x7f^]/.test(v)) this.add(`${label} "${v.slice(0, 30)}" contains a character X12 can't carry (* ~ > ^ or a control character)`);
    return v;
  }

  /** Free text (names, descriptions): characters X12 reserves become spaces, whitespace is collapsed, and it is cut to `max` when `cut` (descriptions) or refused when not (names). */
  text(value: string, label: string, max: number, cut = false): string {
    let v = value.replace(/[*~>\x00-\x1f\x7f^]/g, " ").replace(/\s+/g, " ").trim();
    if (v.length > max) {
      if (cut) v = v.slice(0, max).trim();
      else this.add(`${label} is longer than the ${max} characters X12 allows`);
    }
    return v;
  }
}

// ---------- exact decimal arithmetic (no floating point anywhere near money or quantities) ----------

const DEC = /^(\d+)(?:\.(\d+))?$/;
function dec(s: string): { n: bigint; scale: number } | null {
  const m = DEC.exec(s);
  if (!m) return null;
  return { n: BigInt(m[1]! + (m[2] ?? "")), scale: (m[2] ?? "").length };
}

/** qty (decimal text) x unit price in cents -> whole cents, halves round up. */
export function mulCents(qty: string, priceCents: number): number {
  const q = dec(qty);
  if (!q) throw new Error(`Bad quantity "${qty}"`);
  const p = 10n ** BigInt(q.scale);
  return Number((q.n * BigInt(priceCents) * 2n + p) / (2n * p));
}

/** Sum of decimal quantities, as text, keeping the longest number of decimals seen. */
export function sumQty(list: string[]): string {
  let scale = 0;
  const parsed = list.map((s) => { const d = dec(s); if (!d) throw new Error(`Bad quantity "${s}"`); scale = Math.max(scale, d.scale); return d; });
  const total = parsed.reduce((a, d) => a + d.n * 10n ** BigInt(scale - d.scale), 0n);
  const t = total.toString().padStart(scale + 1, "0");
  return scale === 0 ? t : `${t.slice(0, -scale)}.${t.slice(-scale)}`;
}

export const centsToDecimal = (c: number): string => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** "420.00" -> 42000. At most two decimals (a unit price with more would be rounded, so it is refused). */
export function decimalToCents(s: string): number | null {
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const toX12Date = (iso: string) => iso.replace(/-/g, "");
export const fromX12Date = (d: string): string | null => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

// ---------- writing ----------

const pad = (s: string, n: number) => s.padEnd(n, " ");
const num = (n: number, w: number) => String(n).padStart(w, "0");

export const seg = (...els: (string | number)[]): Segment => {
  const out = els.map(String);
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
};

const GROUP_CODE: Record<string, string> = { "850": "PO", "855": "PR", "856": "SH", "810": "IN", "997": "FA" };
export const groupCodeFor = (setId: string) => GROUP_CODE[setId] ?? "";

export function profileProblems(p: X12Profile): string[] {
  const e = new X12Errors();
  for (const [label, q] of [["Sender qualifier", p.senderQual], ["Receiver qualifier", p.receiverQual]] as const) if (!/^[A-Za-z0-9]{2}$/.test(q)) e.add(`${label} must be two letters or digits (like ZZ or 01)`);
  for (const [label, v] of [["Sender id", p.senderId], ["Receiver id", p.receiverId]] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 .&-]{0,14}$/.test(v) || v.trim().length < 2) e.add(`${label} must be 2 to 15 letters, digits, spaces, dots, & or -`);
  }
  if (p.version !== "004010" && p.version !== "005010") e.add("Version must be 004010 or 005010");
  return e.list;
}

/**
 * One transaction set in its envelope. `control` is the interchange control number (1 to 999999999); it is used for ISA13 and GS06 and the
 * set always gets ST02 0001 because there is one set per interchange. Dates and times come from `now` (UTC).
 */
export function buildInterchange(opts: { profile: X12Profile; setId: string; control: number; body: Segment[]; now: Date }): string {
  const { profile: p, setId, control, body, now } = opts;
  const bad = profileProblems(p);
  if (bad.length) throw new Error(bad.join("; "));
  if (!Number.isInteger(control) || control < 1 || control > 999_999_999) throw new Error("Control number out of range");
  const groupCode = groupCodeFor(setId);
  if (!groupCode) throw new Error(`Transaction set ${setId} is not supported`);
  const iso = now.toISOString(); // 2026-10-18T09:30:00.000Z
  const d8 = iso.slice(0, 10).replace(/-/g, "");
  const hm = iso.slice(11, 16).replace(":", "");
  const five = p.version === "005010";
  const isa: Segment = [
    "ISA", "00", pad("", 10), "00", pad("", 10), p.senderQual.toUpperCase(), pad(p.senderId, 15), p.receiverQual.toUpperCase(), pad(p.receiverId, 15),
    d8.slice(2), hm, five ? "^" : "U", five ? "00501" : "00401", num(control, 9), "0", p.usage, SUB,
  ];
  const st: Segment[] = [["ST", setId, "0001"], ...body, ["SE", String(body.length + 2), "0001"]];
  const segments: Segment[] = [
    isa,
    ["GS", groupCode, p.senderId.trim(), p.receiverId.trim(), d8, hm, String(control), "X", p.version],
    ...st,
    ["GE", "1", String(control)],
    ["IEA", "1", num(control, 9)],
  ];
  return segments.map((s) => s.join(ELEM) + SEG).join("\n") + "\n";
}

// ---------- reading ----------

export interface ParsedSet { id: string; control: string; /** ST ... SE inclusive */ segments: Segment[] }
export interface ParsedInterchange {
  senderQual: string; senderId: string; receiverQual: string; receiverId: string; date: string; time: string; control: string; usage: string; versionCode: string;
  group: { code: string; senderApp: string; receiverApp: string; control: string; version: string };
  set: ParsedSet;
}

/** Reads one interchange. Anything wrong with the envelope (counts, control numbers, structure) is an error; nothing is guessed. */
export function parseX12(input: string): { ok: true; interchange: ParsedInterchange } | { ok: false; errors: string[] } {
  const err = new X12Errors();
  const fail = () => ({ ok: false as const, errors: err.list });
  const text = input.replace(/^﻿/, "").trimStart();
  if (!text.startsWith("ISA")) { err.add("Doesn't start with an ISA segment"); return fail(); }
  if (text.length < 106) { err.add("The ISA segment is shorter than the 106 characters X12 requires"); return fail(); }
  const elem = text[3]!, sub = text[104]!, term = text[105]!;
  if (new Set([elem, sub, term]).size !== 3 || [elem, sub, term].some((c) => /[A-Za-z0-9\s]/.test(c))) { err.add("The ISA segment doesn't declare usable delimiters"); return fail(); }
  const isaEls = text.slice(0, 105).split(elem);
  if (isaEls.length !== 17) { err.add(`The ISA segment has ${isaEls.length - 1} elements, not 16`); return fail(); }
  const [, , , , , sQ, sId, rQ, rId, date, time, , vCode, ctl, , usage] = isaEls as string[];
  if (!/^\d{9}$/.test(ctl!)) err.add("ISA13 (control number) must be 9 digits");
  if (!/^[TP]$/.test(usage!)) err.add(`ISA15 (usage indicator) must be T or P, not "${usage}"`);
  if (sId!.length !== 15 || rId!.length !== 15) err.add("ISA06 and ISA08 must be 15 characters");
  if (err.any) return fail();

  const rest = text.slice(106).split(term);
  const tail = rest.pop() ?? "";
  if (tail.trim() !== "") { err.add("Data after the last segment terminator"); return fail(); }
  if (rest.length > MAX_SEGMENTS) { err.add("Too many segments"); return fail(); }
  const segs: Segment[] = rest.map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, "").split(elem));
  if (segs.some((s) => !/^[A-Z0-9]{2,3}$/.test(s[0]!))) { err.add("A segment has no valid id"); return fail(); }

  const ids = segs.map((s) => s[0]!);
  const iea = ids.lastIndexOf("IEA");
  if (ids[0] !== "GS") err.add("GS must follow ISA");
  if (iea !== segs.length - 1) err.add("The interchange must end with IEA");
  if (ids.filter((x) => x === "ISA").length || ids.filter((x) => x === "IEA").length !== 1) err.add("Only one interchange per file is supported");
  if (ids.filter((x) => x === "GS").length !== 1) err.add("Exactly one functional group per interchange is supported");
  if (ids.filter((x) => x === "ST").length !== 1) err.add("Exactly one transaction set per interchange is supported");
  if (err.any) return fail();

  const gs = segs[0]!, ge = segs[segs.length - 2]!, ieaSeg = segs[segs.length - 1]!;
  const stIdx = ids.indexOf("ST"), seIdx = ids.indexOf("SE");
  if (ge[0] !== "GE") err.add("GE must come before IEA");
  if (stIdx !== 1) err.add("ST must follow GS");
  if (seIdx !== segs.length - 3) err.add("SE must close the transaction set just before GE");
  if (err.any) return fail();
  const st = segs[stIdx]!, se = segs[seIdx]!;
  const count = seIdx - stIdx + 1;
  if (se[1] !== String(count)) err.add(`SE01 says ${se[1]} segments but there are ${count}`);
  if (st[2] !== se[2]) err.add(`ST02 (${st[2]}) and SE02 (${se[2]}) don't match`);
  if (!st[2]) err.add("ST02 is missing");
  if (ge[1] !== "1") err.add(`GE01 says ${ge[1]} sets but there is 1`);
  if (ge[2] !== gs[6]) err.add(`GE02 (${ge[2]}) and GS06 (${gs[6]}) don't match`);
  if (ieaSeg[1] !== "1") err.add(`IEA01 says ${ieaSeg[1]} groups but there is 1`);
  if (ieaSeg[2] !== ctl) err.add(`IEA02 (${ieaSeg[2]}) and ISA13 (${ctl}) don't match`);
  if (!st[1] || !/^\d{3}$/.test(st[1])) err.add("ST01 (transaction set id) is missing or malformed");
  if (err.any) return fail();

  return {
    ok: true,
    interchange: {
      senderQual: sQ!, senderId: sId!.trim(), receiverQual: rQ!, receiverId: rId!.trim(), date: date!, time: time!, control: ctl!, usage: usage!, versionCode: vCode!,
      group: { code: gs[1] ?? "", senderApp: gs[2] ?? "", receiverApp: gs[3] ?? "", control: gs[6] ?? "", version: gs[8] ?? "" },
      set: { id: st[1]!, control: st[2]!, segments: segs.slice(stIdx, seIdx + 1) },
    },
  };
}

/** The first segment with this id (inside `from`), or undefined. */
export const find = (segments: Segment[], id: string, pred?: (s: Segment) => boolean): Segment | undefined => segments.find((s) => s[0] === id && (!pred || pred(s)));
export const findAll = (segments: Segment[], id: string): Segment[] => segments.filter((s) => s[0] === id);
