// Colour maths for contrast checks: OKLCH to sRGB, WCAG relative luminance and contrast ratio.
// Used by the sidebar contrast test, which reads the real CSS tokens instead of trusting a screenshot.

export type Rgb = [number, number, number]; // sRGB, 0..1, gamma-encoded

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toGamma = (c: number) => { const v = clamp01(c); return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** OKLCH (L 0..1, C, hue in degrees) to gamma-encoded sRGB, clipped to the gamut. */
export function oklchToRgb(l: number, c: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  return [toGamma(r), toGamma(g), toGamma(bl)];
}

/** Browsers blend and interpolate in gamma-encoded sRGB, so this does too. */
export const mix = (base: Rgb, over: Rgb, alpha: number): Rgb => base.map((v, i) => v * (1 - alpha) + over[i]! * alpha) as Rgb;

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
