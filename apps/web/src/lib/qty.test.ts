import { describe, expect, it } from "vitest";
import { qtyText, readQtyEntry } from "./qty";

const resin = { unit: "kg", decimals: 3, altUnits: [{ name: "bag", factor: "25" }] };

describe("readQtyEntry", () => {
  it("reads in the item's own unit", () => {
    expect(readQtyEntry("12.5", { uom: resin })).toEqual({ ok: true, stored: 12500 });
    expect(readQtyEntry("12.5", { uom: resin, entryUnit: "kg" })).toEqual({ ok: true, stored: 12500 });
  });
  it("converts from another unit", () => {
    expect(readQtyEntry("2", { uom: resin, entryUnit: "bag" })).toEqual({ ok: true, stored: 50000 });
    expect(readQtyEntry("0.5", { uom: resin, entryUnit: "bag" })).toEqual({ ok: true, stored: 12500 });
  });
  it("falls back to the item's unit if the chosen one no longer exists", () => {
    expect(readQtyEntry("2", { uom: resin, entryUnit: "pallet" })).toEqual({ ok: true, stored: 2000 });
  });
  it("refuses what it can't hold", () => {
    expect(readQtyEntry("1.2345", { uom: resin })).toEqual({ ok: false, reason: "precision" });
    expect(readQtyEntry("", { uom: resin })).toEqual({ ok: false, reason: "empty" });
    expect(readQtyEntry("-2", { uom: resin })).toEqual({ ok: false, reason: "negative" });
    expect(readQtyEntry("-2", { uom: resin, signed: true })).toEqual({ ok: true, stored: -2000 });
  });
  it("whole-number items stay whole", () => {
    expect(readQtyEntry("12", { uom: {} })).toEqual({ ok: true, stored: 12 });
    expect(readQtyEntry("12.5", { uom: {} })).toEqual({ ok: false, reason: "precision" });
  });
});

describe("qtyText", () => {
  it("shows a stored number as editable text", () => {
    expect(qtyText(12500, resin)).toBe("12.500");
    expect(qtyText(1250750, resin)).toBe("1250.750");
    expect(qtyText(40, {})).toBe("40");
    expect(qtyText(null, resin)).toBe("");
  });
});
