import { describe, expect, it } from "vitest";
import { contrast, mix, oklchToRgb, type Rgb } from "./contrast";

describe("contrast maths", () => {
  it("white on black is 21:1 and a colour on itself is 1:1", () => {
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 1);
    expect(contrast([0.3, 0.5, 0.7], [0.3, 0.5, 0.7])).toBeCloseTo(1, 5);
  });
  it("converts known OKLCH values", () => {
    const white = oklchToRgb(1, 0, 0);
    white.forEach((v) => expect(v).toBeCloseTo(1, 2));
    const black = oklchToRgb(0, 0, 0);
    black.forEach((v) => expect(v).toBeCloseTo(0, 2));
    // oklch(0.628 0.2577 29.23) is sRGB red
    const red = oklchToRgb(0.628, 0.2577, 29.23);
    expect(red[0]).toBeCloseTo(1, 1);
    expect(red[1]).toBeLessThan(0.1);
  });
  it("mixes in gamma space", () => {
    const m: Rgb = mix([0, 0, 0], [1, 1, 1], 0.5);
    expect(m[0]).toBeCloseTo(0.5, 5);
  });
});
