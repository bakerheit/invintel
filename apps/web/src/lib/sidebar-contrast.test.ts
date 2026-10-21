import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, mix, oklchToRgb, type Rgb } from "./contrast";

// The sidebar is light text on a coloured gradient. This reads the real CSS and checks the worst places the text can
// land (the lightest part of the gradient, under the corner highlight, on the selected item) for every colour palette.
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];
const MIN = 4.5; // WCAG AA for normal-size text

const num = (s: string) => Number(s.replace("%", ""));
const oklch = (l: string, c: string, h: string) => oklchToRgb(num(l), num(c), num(h));

const gradients = [...css.matchAll(/--sidebar-gradient:\s*linear-gradient\(160deg,\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\),\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\),\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)\)/g)];
const highlight = Math.max(...[...css.matchAll(/radial-gradient\(circle at 12% 0%, oklch\(1 0 0 \/ ([\d.]+)\)/g)].map((m) => num(m[1]!)));
const mutedAlpha = Math.min(...[...css.matchAll(/\[data-sidebar="sidebar"\] \.text-muted-foreground\s*\{\s*color:\s*oklch\(1 0 0 \/ (\d+)%\)/g)].map((m) => num(m[1]!) / 100));
const accent = css.match(/--sidebar-accent:\s*oklch\((\d) 0 0 \/ (\d+)%\)/);
const accentOver: Rgb = accent && accent[1] === "0" ? BLACK : WHITE;
const accentAlpha = accent ? num(accent[2]!) / 100 : 0;

describe("sidebar text contrast", () => {
  it("found the tokens it checks", () => {
    expect(gradients.length).toBeGreaterThanOrEqual(6);
    expect(Number.isFinite(highlight)).toBe(true);
    expect(Number.isFinite(mutedAlpha)).toBe(true);
    expect(accent).not.toBeNull();
  });

  gradients.forEach((g, index) => {
    const paletteHue = Number(g[6]); // the middle stop carries the palette's own hue
    const name = `palette ${index + 1} (hue ${Math.round(paletteHue)})`;
    it(`${name} keeps sidebar text at ${MIN}:1 or better`, () => {
      const [s1, s2, s3] = [oklch(g[1]!, g[2]!, g[3]!), oklch(g[4]!, g[5]!, g[6]!), oklch(g[7]!, g[8]!, g[9]!)];
      const text = oklchToRgb(0.99, 0.005, paletteHue);
      let worst = Infinity;
      for (const t of [0, 0.15, 0.3, 0.5, 0.75, 1]) {
        const base = t <= 0.5 ? mix(s1, s2, t / 0.5) : mix(s2, s3, (t - 0.5) / 0.5);
        const spots: Rgb[] = [base, mix(base, accentOver, accentAlpha)];
        if (t <= 0.3) {
          const lit = mix(base, WHITE, highlight * (1 - t / 0.45));
          spots.push(lit, mix(lit, accentOver, accentAlpha));
        }
        for (const bg of spots) {
          worst = Math.min(worst, contrast(text, bg), contrast(mix(bg, WHITE, mutedAlpha), bg));
        }
      }
      expect(worst, `${name}: worst contrast ${worst.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN);
    });
  });
});
