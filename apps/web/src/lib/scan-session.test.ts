import type { Item } from "@invintel/shared";
import { describe, expect, it } from "vitest";
import { addScan, canUndo, emptySession, needsQuantity, removeLine, scanPoLine, setQuantity, summarize, undoLast, type PoLine, type Session } from "./scan-session";

const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, sku: id.toUpperCase(), name: `${id} item`, unit: "ea", decimals: 0, ...extra }) as Item;
const kraft = item("kraft");
const medium = item("medium");
const weighed = item("resin", { unit: "kg", decimals: 3 });

const add = (s: Session, it: Item, facts = {}, qty?: number) => {
  const r = addScan(s, it, facts, qty);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("adding scans to the running list", () => {
  it("each scan of a counted item is one more; the same item merges into one line", () => {
    let s = emptySession();
    s = add(s, kraft).session;
    s = add(s, kraft).session;
    s = add(s, medium).session;
    s = add(s, kraft).session;
    expect(s.lines.map((l) => [l.item.id, l.quantity])).toEqual([["kraft", 3], ["medium", 1]]);
    expect(summarize(s)).toEqual({ lines: 2, items: 2 });
  });

  it("a label's count is added instead of one, and lines with a different lot, expiry or pallet stay separate", () => {
    let s = emptySession();
    s = add(s, kraft, { qty: 24, lot: "L1", expiresOn: "2027-01-31", sscc: "A" }).session;
    s = add(s, kraft, { qty: 24, lot: "L1", expiresOn: "2027-01-31", sscc: "B" }).session; // a different pallet of the same lot
    s = add(s, kraft, { qty: 6, lot: "L2" }).session;
    s = add(s, kraft, { lot: "L2" }).session; // a plain barcode scan of the same lot is one more
    expect(s.lines.map((l) => [l.lot, l.sscc, l.quantity])).toEqual([["L1", "A", 24], ["L1", "B", 24], ["L2", "", 7]]);
    expect(summarize(s)).toEqual({ lines: 3, items: 1 });
  });

  it("a pallet scanned twice is refused, the list is unchanged", () => {
    const s = add(emptySession(), kraft, { qty: 24, sscc: "A" }).session;
    const again = addScan(s, medium, { qty: 5, sscc: "A" });
    expect(again).toEqual({ ok: false, error: "That pallet is already on the list." });
  });

  it("items measured with decimals ask for a quantity instead of adding one", () => {
    expect(needsQuantity(kraft)).toBe(false);
    expect(needsQuantity(weighed)).toBe(true);
    expect(needsQuantity(weighed, { qty: 5000 })).toBe(false);
    const r = addScan(emptySession(), weighed);
    expect(r).toEqual({ ok: false, error: "How many resin item? Say a quantity." });
    const typed = add(emptySession(), weighed, {}, 12_500);
    expect(typed.line.quantity).toBe(12_500);
  });

  it("refuses a quantity that isn't a positive whole number", () => {
    for (const bad of [0, -3, 1.5, NaN]) expect(addScan(emptySession(), kraft, {}, bad).ok).toBe(false);
  });

  it("moves keep a separate line per place the stock comes from", () => {
    let s = emptySession();
    s = add(s, kraft, { from: "dock" }).session;
    s = add(s, kraft, { from: "rack" }).session;
    s = add(s, kraft, { from: "dock" }).session;
    expect(s.lines.map((l) => [l.from, l.quantity])).toEqual([["dock", 2], ["rack", 1]]);
  });
});

describe("editing and undoing", () => {
  it("undo last scan steps back one scan at a time, including a merge, and stops at the start", () => {
    let s = emptySession();
    expect(canUndo(s)).toBe(false);
    s = add(s, kraft).session;
    s = add(s, kraft).session;
    s = add(s, medium).session;
    s = undoLast(s);
    expect(s.lines.map((l) => [l.item.id, l.quantity])).toEqual([["kraft", 2]]);
    s = undoLast(s);
    expect(s.lines.map((l) => [l.item.id, l.quantity])).toEqual([["kraft", 1]]);
    s = undoLast(s);
    expect(s.lines).toEqual([]);
    expect(canUndo(s)).toBe(false);
    expect(undoLast(s)).toBe(s);
  });

  it("a person can change a quantity or remove a line; zero removes it", () => {
    let s = add(add(emptySession(), kraft).session, medium).session;
    const key = s.lines[0]!.key;
    s = setQuantity(s, key, 40);
    expect(s.lines[0]!.quantity).toBe(40);
    expect(setQuantity(s, key, 0).lines.map((l) => l.item.id)).toEqual(["medium"]);
    expect(removeLine(s, key).lines.map((l) => l.item.id)).toEqual(["medium"]);
  });

  it("keeps only the last 50 steps of history", () => {
    let s = emptySession();
    for (let i = 0; i < 80; i++) s = add(s, kraft).session;
    expect(s.history.length).toBe(50);
    expect(s.lines[0]!.quantity).toBe(80);
  });
});

describe("scanning against a purchase order", () => {
  const poLines = (): PoLine[] => [
    { item: kraft, ordered: 20, received: 5, quantity: 0, lot: "", expiresOn: "" },
    { item: medium, ordered: 10, received: 0, quantity: 0, lot: "", expiresOn: "" },
  ];
  const scan = (lines: PoLine[], it: Item, facts = {}, qty?: number) => {
    const r = scanPoLine(lines, it, facts, qty);
    if (!r.ok) throw new Error(r.error);
    return r.lines;
  };

  it("each scan adds to the order's line for that item; the lot and expiry from a label go onto it", () => {
    let l = poLines();
    l = scan(l, kraft);
    l = scan(l, kraft, { qty: 12, lot: "LOT-9", expiresOn: "2027-05-31" });
    l = scan(l, kraft, { lot: "LOT-9" });
    expect(l[0]).toMatchObject({ quantity: 14, lot: "LOT-9", expiresOn: "2027-05-31", received: 5, ordered: 20 });
    expect(l[1]!.quantity).toBe(0);
  });

  it("an item that isn't on the order is refused", () => {
    expect(scanPoLine(poLines(), item("other"))).toEqual({ ok: false, error: "other item isn't on this order." });
  });

  it("a second lot or expiry of the same item in one delivery is refused, with what to do instead", () => {
    const l = scan(poLines(), kraft, { qty: 4, lot: "A", expiresOn: "2027-01-31" });
    expect(scanPoLine(l, kraft, { lot: "B" })).toEqual({ ok: false, error: "kraft item already has lot A in this delivery. Receive lot B as a second delivery." });
    expect(scanPoLine(l, kraft, { expiresOn: "2027-02-28" })).toMatchObject({ ok: false, error: expect.stringContaining("expiry 2027-01-31") });
    // the first lot may appear before any quantity was counted on the line, and a plain scan keeps the lot
    expect(scan(scan(poLines(), kraft), kraft, { lot: "A" })[0]!.lot).toBe("A");
    expect(scan(l, kraft)[0]).toMatchObject({ lot: "A", quantity: 5 });
  });

  it("measured items need a typed quantity", () => {
    const lines: PoLine[] = [{ item: weighed, ordered: 100_000, received: 0, quantity: 0, lot: "", expiresOn: "" }];
    expect(scanPoLine(lines, weighed).ok).toBe(false);
    expect(scan(lines, weighed, {}, 2_500)[0]!.quantity).toBe(2_500);
  });
});
