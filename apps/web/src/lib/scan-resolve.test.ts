import type { Item, LookupResult } from "@invintel/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn<(orgId: string, code: string) => Promise<LookupResult>>();
vi.mock("@/lib/api", () => ({ api: { lookup: (o: string, c: string) => lookup(o, c) } }));
const { interpretScan } = await import("./scan-resolve");

const withCheck = (body: string) => {
  let sum = 0;
  [...body].reverse().forEach((ch, i) => { sum += Number(ch) * (i % 2 === 0 ? 3 : 1); });
  return body + String((10 - (sum % 10)) % 10);
};
const GTIN = withCheck("0950600013435");
const SSCC = withCheck("00614141123456789");
const GS = "\x1d";
const item = (id: string, extra: Partial<Item> = {}) => ({ id, sku: id.toUpperCase(), name: `${id} item`, unit: "ea", decimals: 0, tracking: "quantity", ...extra }) as Item;
const found = (i: Item): LookupResult => ({ kind: "item", item: i });
const none: LookupResult = { kind: "none" };

beforeEach(() => lookup.mockReset());

describe("interpretScan", () => {
  it("a plain code is looked up as it is: item, location, roll, or nothing", async () => {
    lookup.mockResolvedValueOnce(found(item("kraft")));
    expect(await interpretScan("o", "KRAFT")).toEqual({ kind: "item", item: item("kraft"), facts: {} });
    lookup.mockResolvedValueOnce({ kind: "location", location: { id: "l1" } as never });
    expect((await interpretScan("o", "LOC-1")).kind).toBe("location");
    lookup.mockResolvedValueOnce({ kind: "unit", unit: { code: "R-1" } as never });
    expect((await interpretScan("o", "R-1")).kind).toBe("unit");
    lookup.mockResolvedValueOnce(none);
    expect(await interpretScan("o", "WHAT")).toEqual({ kind: "error", error: 'Nothing matches "WHAT"', unknownCode: "WHAT" });
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("a GS1 label gives the item by its GTIN, plus lot, expiry, count and pallet", async () => {
    lookup.mockResolvedValueOnce(found(item("kraft")));
    const r = await interpretScan("o", `]C100${SSCC}`.replace(`00${SSCC}`, `01${GTIN}17261231` + `10LOT7${GS}3724`));
    expect(lookup).toHaveBeenCalledWith("o", GTIN);
    expect(r).toMatchObject({ kind: "item", item: { id: "kraft" }, facts: { lot: "LOT7", expiresOn: "2026-12-31", qty: 24 } });
    lookup.mockResolvedValueOnce(none); // unmarked digits: nothing has this exact code
    lookup.mockResolvedValueOnce(found(item("kraft")));
    const both = await interpretScan("o", `00${SSCC}02${GTIN}37${"12"}`);
    expect(both).toMatchObject({ kind: "item", facts: { sscc: SSCC, qty: 12 } });
  });

  it("the label's count is not used for items measured with decimals", async () => {
    lookup.mockResolvedValueOnce(found(item("resin", { unit: "kg", decimals: 3 })));
    const r = await interpretScan("o", `]C101${GTIN}37${"5"}`);
    expect(r).toMatchObject({ kind: "item" });
    expect((r as { facts: object }).facts).toEqual({});
  });

  it("a label that is plainly GS1 but doesn't read is refused with the reason and nothing is looked up", async () => {
    const bad = GTIN.slice(0, 13) + String((Number(GTIN[13]) + 1) % 10);
    const r = await interpretScan("o", `]C101${bad}`);
    expect(r).toMatchObject({ kind: "error", error: expect.stringMatching(/check digit/) });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a pallet label with no product is kept as a pallet; a product code nobody has is an error that offers to add it", async () => {
    expect(await interpretScan("o", `]C100${SSCC}`)).toEqual({ kind: "pallet", sscc: SSCC });
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockResolvedValueOnce(none);
    expect(await interpretScan("o", `(01)${GTIN}(10)LOT7`)).toMatchObject({ kind: "error", unknownCode: GTIN, error: expect.stringContaining(GTIN) });
  });

  it("digits that happen to read as a label are looked up as typed first, and only used as a label when nothing has that code", async () => {
    const digits = `01${GTIN}17261231`;
    lookup.mockResolvedValueOnce(found(item("odd-sku")));
    expect(await interpretScan("o", digits)).toMatchObject({ kind: "item", item: { id: "odd-sku" }, facts: {} });
    expect(lookup).toHaveBeenCalledWith("o", digits);
    lookup.mockReset();
    lookup.mockResolvedValueOnce(none); // nothing has this exact code
    lookup.mockResolvedValueOnce(found(item("kraft"))); // the GTIN does
    expect(await interpretScan("o", digits)).toMatchObject({ kind: "item", item: { id: "kraft" }, facts: { expiresOn: "2026-12-31" } });
    expect(lookup.mock.calls.map((c) => c[1])).toEqual([digits, GTIN]);
  });
});
