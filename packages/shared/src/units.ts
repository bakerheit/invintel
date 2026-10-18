import { z } from "zod";

/**
 * Units of measure.
 *
 * Every quantity the API stores and sends is a whole number: a count of the item's smallest unit.
 * An item says how to read that number with `unit` (what it is called) and `decimals` (how many
 * of its digits come after the point). Stored 12500 on an item in kg with 3 decimals is 12.500 kg.
 * Items with 0 decimals (the default) read exactly as they always did.
 *
 * Nothing here uses floating point. Text is parsed and printed digit by digit, and conversions are
 * done in BigInt, so a quantity never drifts and the ledger always adds up.
 */

export const MAX_DECIMALS = 4;

export const unitLabelSchema = z
  .string()
  .trim()
  .min(1, "Unit is required")
  .max(16)
  .refine((s) => !/[\p{Cc}]/u.test(s), "Unit can't contain control characters");

export const decimalsSchema = z.number().int().min(0).max(MAX_DECIMALS);

/** A decimal ratio like "12" or "0.4536": how many of the base unit one of the other unit is. */
export const conversionFactorSchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, "Use a number with up to 6 decimals")
  .refine((s) => /[1-9]/.test(s), "Must be more than 0");

/** Another unit an item is bought or counted in, such as a case of 12 each. */
export const altUnitSchema = z.object({ name: unitLabelSchema, factor: conversionFactorSchema });
export type AltUnit = z.infer<typeof altUnitSchema>;
export const MAX_ALT_UNITS = 6;
export const altUnitsSchema = z
  .array(altUnitSchema)
  .max(MAX_ALT_UNITS)
  .refine((u) => new Set(u.map((a) => a.name.toLowerCase())).size === u.length, "Each unit name must be different");

export interface Uom {
  unit: string;
  decimals: number;
}

export const DEFAULT_UOM: Uom = { unit: "ea", decimals: 0 };

/** Common choices for the unit picker. Any text is allowed. */
export const UNIT_PRESETS: { unit: string; decimals: number; label: string }[] = [
  { unit: "ea", decimals: 0, label: "Each (whole items)" },
  { unit: "kg", decimals: 3, label: "Kilograms" },
  { unit: "g", decimals: 0, label: "Grams" },
  { unit: "lb", decimals: 2, label: "Pounds" },
  { unit: "m", decimals: 2, label: "Metres" },
  { unit: "m²", decimals: 2, label: "Square metres" },
  { unit: "L", decimals: 2, label: "Litres" },
  { unit: "ft", decimals: 2, label: "Feet" },
];

/** Older items have no unit fields. Reading them through here gives each / 0 decimals. */
export const uomOf = (x?: { unit?: string | null; decimals?: number | null } | null): Uom => ({
  unit: x?.unit?.trim() || DEFAULT_UOM.unit,
  decimals: Number.isInteger(x?.decimals) && x!.decimals! >= 0 && x!.decimals! <= MAX_DECIMALS ? x!.decimals! : 0,
});

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export interface FormatOptions {
  /**
   * Add the unit: "auto" (default) adds it unless it is plain "ea", true always, false never.
   */
  unit?: "auto" | boolean;
  /** Drop trailing zeros after the point: 12.500 becomes 12.5. */
  trim?: boolean;
  /** Always show a leading + on positive numbers, for changes. */
  sign?: boolean;
  /** Thousands separators. Default true. */
  group?: boolean;
}

/** 12500 on { kg, 3 } -> "12.500 kg". Whole-number items print as before: 1200 -> "1,200". */
export function formatQty(stored: number, uom?: Partial<Uom> | null, opts: FormatOptions = {}): string {
  if (!Number.isFinite(stored)) return "–";
  const { unit, decimals } = uomOf(uom);
  const n = Math.round(stored);
  const negative = n < 0;
  const digits = String(Math.abs(n)).padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  let frac = decimals ? digits.slice(-decimals) : "";
  if (opts.trim) frac = frac.replace(/0+$/, "");
  let text = (opts.group === false ? whole : group(whole)) + (frac ? `.${frac}` : "");
  if (negative && n !== 0) text = `-${text}`;
  else if (opts.sign && n > 0) text = `+${text}`;
  const showUnit = opts.unit === undefined || opts.unit === "auto" ? unit !== DEFAULT_UOM.unit : opts.unit;
  return showUnit ? `${text} ${unit}` : text;
}

export type QtyParseError = "empty" | "format" | "precision" | "range" | "negative";
export type QtyParse = { ok: true; stored: number } | { ok: false; reason: QtyParseError };

export interface ParseOptions {
  /** Allow a leading minus, for changes to stock. Default false. */
  signed?: boolean;
}

const QTY_TEXT = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/;

interface Decimal {
  negative: boolean;
  /** All digits as one integer. */
  digits: bigint;
  /** How many of those digits sit after the point. */
  frac: number;
}

function readDecimal(text: string, signed: boolean): { ok: true; value: Decimal } | { ok: false; reason: QtyParseError } {
  const t = text.trim().replace(/\s+/g, "");
  if (!t) return { ok: false, reason: "empty" };
  const m = QTY_TEXT.exec(t);
  if (!m || (!m[2] && !m[3])) return { ok: false, reason: "format" };
  if (m[1] && !signed) return { ok: false, reason: "negative" };
  const whole = (m[2] ?? "0").replace(/,/g, "");
  const fracRaw = m[3] ?? "";
  // Trailing zeros after the point carry no information: "1.500" is 1.5.
  const frac = fracRaw.replace(/0+$/, "");
  return { ok: true, value: { negative: !!m[1], digits: BigInt(whole + frac), frac: frac.length } };
}

const TEN = 10n;
const pow10 = (n: number) => TEN ** BigInt(n);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toStoredInt(numerator: bigint, denominator: bigint, negative: boolean): QtyParse {
  if (numerator % denominator !== 0n) return { ok: false, reason: "precision" };
  const q = numerator / denominator;
  if (q > MAX_SAFE) return { ok: false, reason: "range" };
  return { ok: true, stored: negative && q !== 0n ? -Number(q) : Number(q) };
}

/**
 * Text a person typed -> the whole number to store. Never rounds: "1.2345" for an item with 3
 * decimals is refused, because silently changing a stock figure is worse than asking again.
 */
export function parseQty(text: string, decimals: number, opts: ParseOptions = {}): QtyParse {
  const read = readDecimal(text, !!opts.signed);
  if (!read.ok) return read;
  const { digits, frac, negative } = read.value;
  return toStoredInt(digits * pow10(decimals), pow10(frac), negative);
}

/** parseQty for when you only want the number, or null if it isn't valid. */
export const toStored = (text: string, decimals: number, opts?: ParseOptions): number | null => {
  const r = parseQty(text, decimals, opts);
  return r.ok ? r.stored : null;
};

/**
 * "2" cases where 1 case = "12" each -> 24 stored. Exact: if the answer isn't a whole number of
 * stored units (2.5 cases of 5 with 0 decimals = 12.5) it is refused.
 */
export function convertQty(text: string, factor: string, decimals: number, opts: ParseOptions = {}): QtyParse {
  const read = readDecimal(text, !!opts.signed);
  if (!read.ok) return read;
  const f = readDecimal(factor, false);
  if (!f.ok || f.value.digits === 0n) return { ok: false, reason: "format" };
  const { digits, frac, negative } = read.value;
  return toStoredInt(digits * f.value.digits * pow10(decimals), pow10(frac + f.value.frac), negative);
}

/** What a person should read when parseQty fails. */
export function qtyErrorMessage(reason: QtyParseError, uom?: Partial<Uom> | null): string {
  const { decimals, unit } = uomOf(uom);
  switch (reason) {
    case "empty":
      return "Enter a quantity";
    case "negative":
      return "Quantity can't be negative";
    case "range":
      return "That quantity is too large";
    case "precision":
      return decimals === 0
        ? `${unit} only counts whole numbers`
        : `${unit} goes to ${decimals} decimal place${decimals === 1 ? "" : "s"}`;
    default:
      return "Enter a number like 12 or 12.5";
  }
}

/**
 * What a quantity is worth. `unitCostCents` is the price of ONE display unit (one kg, one metre),
 * so a stored count has to be scaled back by the item's decimals. Rounds to the nearest cent,
 * halves away from zero, and is exact for any realistic figure.
 */
export function lineValueCents(stored: number, unitCostCents: number, decimals = 0): number {
  const product = BigInt(Math.round(stored)) * BigInt(Math.round(unitCostCents));
  const scale = pow10(decimals);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs * 2n + scale) / (scale * 2n);
  return Number(negative ? -rounded : rounded);
}

/** For charts and sums where an approximate number is fine. Never store the result. */
export const storedToNumber = (stored: number, decimals: number) => stored / 10 ** decimals;
