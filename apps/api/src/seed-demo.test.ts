import { readFileSync } from "node:fs";
import { gs1CheckDigitOk } from "@invintel/shared";
import { describe, expect, it } from "vitest";

// The demo seed is a script that writes to a database when run, so this reads its source: every barcode it gives an item
// must be a real GTIN (right check digit), or a GS1 label made from it would be refused.
describe("demo seed barcodes", () => {
  const source = readFileSync(new URL("./seed-demo.ts", import.meta.url), "utf8");
  const barcodes = [...source.matchAll(/\[((?:\s*"\d{8,14}"\s*,?)+)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"(\d+)"/g)].map((d) => d[1]!));

  it("finds the seed's barcodes (so this test can't pass by finding none)", () => {
    expect(barcodes.length).toBeGreaterThanOrEqual(2);
  });

  it("every one passes the GS1 check digit", () => {
    for (const code of barcodes) expect(gs1CheckDigitOk(code), code).toBe(true);
  });
});
