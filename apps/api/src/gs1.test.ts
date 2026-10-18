import { GS, gs1CheckDigitOk, gs1Date, isRealIsoDate, readGs1, scanKind } from "@invintel/shared";
import { describe, expect, it } from "vitest";

/** Appends the GS1 check digit (written out here on its own, so the test doesn't just agree with itself). */
const withCheck = (body: string) => {
  let sum = 0;
  [...body].reverse().forEach((ch, i) => { sum += Number(ch) * (i % 2 === 0 ? 3 : 1); });
  return body + String((10 - (sum % 10)) % 10);
};
const GTIN = withCheck("0950600013435"); // 14 digits
const GTIN2 = withCheck("0614141999996");
const SSCC = withCheck("00614141123456789");
const NOW = new Date("2026-10-18T12:00:00Z");
const read = (s: string) => readGs1(s, NOW);
const label = (s: string) => { const r = read(s); if (!r.ok) throw new Error(r.error); return r.label; };
const error = (s: string) => { const r = read(s); if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.label)}`); return r.error; };

describe("check digits", () => {
  it("accepts good GTINs and SSCCs and refuses a changed digit or a swap", () => {
    // published EAN-13 examples with their real check digits
    expect(gs1CheckDigitOk("4006381333931")).toBe(true);
    expect(gs1CheckDigitOk("5901234123457")).toBe(true);
    expect(gs1CheckDigitOk("4006381333932")).toBe(false);
    expect(gs1CheckDigitOk(GTIN)).toBe(true);
    expect(gs1CheckDigitOk(SSCC)).toBe(true);
    expect(gs1CheckDigitOk(GTIN.slice(0, 12) + GTIN[13]! + GTIN[12]!)).toBe(GTIN[12] === GTIN[13]); // a transposition near the end is caught
    expect(gs1CheckDigitOk(GTIN.slice(0, 5) + String((Number(GTIN[5]) + 1) % 10) + GTIN.slice(6))).toBe(false);
    expect(gs1CheckDigitOk("")).toBe(false);
    expect(gs1CheckDigitOk("12a4")).toBe(false);
    expect(GTIN).toHaveLength(14);
    expect(SSCC).toHaveLength(18);
  });
});

describe("dates", () => {
  it("reads YYMMDD, with day 00 as the last day of the month, and refuses impossible dates", () => {
    expect(gs1Date("261231", NOW)).toEqual({ iso: "2026-12-31", dayUnspecified: false });
    expect(gs1Date("270200", NOW)).toEqual({ iso: "2027-02-28", dayUnspecified: true });
    expect(gs1Date("280200", NOW)).toEqual({ iso: "2028-02-29", dayUnspecified: true }); // leap year
    expect(gs1Date("280229", NOW)?.iso).toBe("2028-02-29");
    for (const bad of ["250229", "261301", "260001", "260230", "260431", "26123", "2612310", "ab1231"]) expect(gs1Date(bad, NOW)).toBeNull();
  });
  it("puts the century within 49 years back and 50 years ahead of today", () => {
    expect(gs1Date("000101", NOW)?.iso).toBe("2000-01-01");
    expect(gs1Date("750101", NOW)?.iso).toBe("2075-01-01");
    expect(gs1Date("760101", NOW)?.iso).toBe("2076-01-01");
    expect(gs1Date("770101", NOW)?.iso).toBe("1977-01-01");
    expect(gs1Date("990101", NOW)?.iso).toBe("1999-01-01");
  });
  it("knows a real calendar date from a made-up one", () => {
    expect(isRealIsoDate("2028-02-29")).toBe(true);
    expect(isRealIsoDate("2027-02-29")).toBe(false);
    expect(isRealIsoDate("2027-13-01")).toBe(false);
    expect(isRealIsoDate("27-01-01")).toBe(false);
  });
});

describe("reading a GS1-128 label", () => {
  it("reads GTIN, expiry, lot and count when the variable-length lot is ended by a separator", () => {
    const l = label(`01${GTIN}17261231` + `10LOT-7/B${GS}3724`);
    expect(l).toMatchObject({ marker: "separator", gtin: GTIN, expiry: "2026-12-31", lot: "LOT-7/B", quantity: 24 });
    expect(l.elements.map((e) => e.ai)).toEqual(["01", "17", "10", "37"]);
    expect(l.expiryDayUnspecified).toBeUndefined();
  });
  it("the same label with the symbology identifier a scanner can put in front, or printed with brackets", () => {
    expect(label(`]C101${GTIN}17261231` + `10LOT7${GS}3724`)).toMatchObject({ marker: "symbology", gtin: GTIN, lot: "LOT7", quantity: 24 });
    expect(label(`(01)${GTIN}(17)261231(10)LOT7(37)24`)).toMatchObject({ marker: "brackets", gtin: GTIN, expiry: "2026-12-31", lot: "LOT7", quantity: 24 });
    expect(label(`]d201${GTIN}`)).toMatchObject({ marker: "symbology", gtin: GTIN });
  });
  it("a month-only expiry (day 00) is the last day of that month and says so", () => {
    expect(label(`01${GTIN}17270200`)).toMatchObject({ expiry: "2027-02-28", expiryDayUnspecified: true });
  });
  it("lot last needs no separator; a lot in the middle without one can't be split, so the digits after it become part of the lot", () => {
    expect(label(`01${GTIN}10ABC123`).lot).toBe("ABC123");
    // The separator was dropped by a scanner: the count is swallowed by the lot. Not guessable from the data alone (the report says so).
    expect(label(`01${GTIN}10ABC1233724`).lot).toBe("ABC1233724");
  });
  it("a pallet label: SSCC alone, and SSCC with the GTIN and count of what is on it", () => {
    expect(label(`00${SSCC}`)).toMatchObject({ sscc: SSCC });
    expect(label(`00${SSCC}02${GTIN2}37${"12"}`)).toMatchObject({ sscc: SSCC, gtin: GTIN2, quantity: 12 });
    expect(label(`00${SSCC}02${GTIN2}37${"12"}`).elements.map((e) => e.ai)).toEqual(["00", "02", "37"]);
  });
  it("count from (30) when (37) isn't there; measures and other known fields are read and left alone", () => {
    expect(label(`01${GTIN}30${"5"}`).quantity).toBe(5);
    const l = label(`01${GTIN}3103001250` + `21SN${GS}9012345`);
    expect(l.elements).toEqual([{ ai: "01", value: GTIN }, { ai: "3103", value: "001250" }, { ai: "21", value: "SN" }, { ai: "90", value: "12345" }]);
    expect(l.serial).toBe("SN");
  });
  it("accepts the whole GS1 character set in a lot, upper and lower case", () => {
    for (const lot of [`aZ09!"%&'()*+`, `,-./:;<=>?_`, "A".repeat(20)]) expect(label(`01${GTIN}10${lot}`).lot).toBe(lot);
  });

  describe("refuses, with a reason, rather than guessing", () => {
    it("a wrong check digit on the GTIN or the SSCC", () => {
      const bad = GTIN.slice(0, 13) + String((Number(GTIN[13]) + 1) % 10);
      expect(error(`01${bad}`)).toMatch(/GTIN \(01\) has a wrong check digit/);
      expect(error(`00${SSCC.slice(0, 17)}${(Number(SSCC[17]) + 3) % 10}`)).toMatch(/SSCC \(00\) has a wrong check digit/);
      expect(error(`02${bad}37${"5"}`)).toMatch(/check digit/);
    });
    it("a date that isn't real", () => {
      expect(error(`01${GTIN}17261301`)).toMatch(/Expiry date \(17\) isn't a real date/);
      expect(error(`01${GTIN}17250229`)).toMatch(/isn't a real date/);
    });
    it("a label cut short, and fields that are too long, empty or not what they should be", () => {
      expect(error(`01${GTIN.slice(0, 9)}`)).toMatch(/GTIN \(01\) should be 14 characters/);
      expect(error(`01${GTIN}1726`)).toMatch(/should be 6 characters/);
      expect(error(`01${GTIN}10${"A".repeat(21)}`)).toMatch(/20.*missing a separator/);
      expect(error(`01${GTIN}10${GS}37${"5"}`)).toMatch(/Batch\/lot \(10\) is empty/);
      expect(error(`01${GTIN}10AB#C`)).toMatch(/character a GS1 label can't carry/);
      expect(error(`01${GTIN}37${"12a"}`)).toMatch(/digits only/);
      expect(error(`01${GTIN}37123456789`)).toMatch(/most it can be is 8/);
      expect(error(`01${GTIN}17261A31`)).toMatch(/digits only/);
    });
    it("an element we don't know the length of, since nothing after it could be read", () => {
      expect(error(`01${GTIN}5555123`)).toMatch(/isn't a code we know the length of/);
      expect(error("(55)123")).toMatch(/isn't a code we know the length of/);
    });
    it("the same field twice, a count given two ways, and a count that isn't a count", () => {
      expect(error(`01${GTIN}10A${GS}10B`)).toMatch(/appears twice/);
      expect(error(`01${GTIN}3012${GS}3712`.replace("3012", "305"))).toMatch(/count twice/);
      expect(error(`01${GTIN}37${"0"}`)).toMatch(/at least 1/);
    });
    it("empty, absurdly long, and a bracket label that doesn't start with an AI", () => {
      expect(error("")).toMatch(/empty/);
      expect(error("x".repeat(200))).toMatch(/too long/);
      expect(error(`(01${GTIN}`)).toMatch(/should start with an \(AI\)/);
    });
    it("a separator inside a fixed-length field", () => {
      expect(error(`01${GTIN.slice(0, 5)}${GS}${GTIN.slice(5)}`)).toMatch(/cut short/);
    });
  });
});

describe("telling a label from an ordinary code", () => {
  it("plain SKUs, EANs, locations and roll labels are not labels", () => {
    for (const code of ["RSC-181212", "LOC-A-01", "ROLL-000123", GTIN.slice(1), "4006381333931", "WIDGET(2)", "12345"]) {
      expect(scanKind(code, NOW).kind, code).toBe("plain");
    }
  });
  it("a code with the symbology identifier, a separator or (AI) brackets is meant to be a label: it reads or it is refused, never looked up as a SKU", () => {
    expect(scanKind(`]C101${GTIN}`, NOW).kind).toBe("gs1");
    expect(scanKind(`01${GTIN}10A${GS}3712`, NOW).kind).toBe("gs1");
    expect(scanKind(`(01)${GTIN}`, NOW).kind).toBe("gs1");
    expect(scanKind("]C1garbage", NOW)).toMatchObject({ kind: "bad" });
    expect(scanKind(`ABC${GS}DEF`, NOW)).toMatchObject({ kind: "bad" });
    expect(scanKind("(01)123", NOW)).toMatchObject({ kind: "bad", error: expect.stringMatching(/GTIN \(01\) should be 14/) });
    expect(scanKind(`(01)${GTIN.slice(0, 13)}${(Number(GTIN[13]) + 1) % 10}`, NOW)).toMatchObject({ kind: "bad", error: expect.stringMatching(/check digit/) });
  });
  it("an unmarked string is a label only when every rule holds and it starts with an SSCC or GTIN; the caller still tries an exact SKU match first", () => {
    expect(scanKind(`01${GTIN}17261231`, NOW)).toMatchObject({ kind: "bare", label: { gtin: GTIN, expiry: "2026-12-31" } });
    expect(scanKind(`00${SSCC}`, NOW).kind).toBe("bare");
    expect(scanKind(`01${GTIN.slice(0, 13)}${(Number(GTIN[13]) + 1) % 10}`, NOW).kind).toBe("plain"); // wrong check digit and no marker: not ours to claim
    expect(scanKind(`01${GTIN}17261399`, NOW).kind).toBe("plain");
  });
});
