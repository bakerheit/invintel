import { z } from "zod";

// INV-18: a postal address for the businesses we trade with (and for our own letterhead). Structured, so it can be printed on a
// document and written into an EDI document (N1/N3/N4) without guessing which line is the city. Every field is optional text; a
// record with no address at all is a normal record (older data has none).

const text = (max: number) => z.string().trim().max(max).default("");

export const addressSchema = z.object({
  /** The name of the place, if it differs from the business ("Plant 2 receiving dock"). */
  name: text(100),
  line1: text(55),
  line2: text(55),
  city: text(30),
  /** State or province. For EDI a code ("IL"). */
  region: text(30),
  postal: text(15),
  /** For EDI a two-letter country code ("US"); a few common names are understood. */
  country: text(56),
});
export type Address = z.infer<typeof addressSchema>;
export const BLANK_ADDRESS: Address = { name: "", line1: "", line2: "", city: "", region: "", postal: "", country: "" };

/** An address that may be absent: blank counts as absent, so a half-filled form doesn't create an empty address. */
export const optionalAddressSchema = z.preprocess(
  (v) => (v && typeof v === "object" && isBlankAddress(v as Partial<Address>) ? null : v),
  addressSchema.nullable().optional(),
);

export const isBlankAddress = (a?: Partial<Address> | null): boolean => !a || Object.values(a).every((v) => !String(v ?? "").trim());

/** The lines to print: the place's name, the street lines, "City, ST 12345", the country. Empty lines are left out. */
export function addressLines(a?: Partial<Address> | null): string[] {
  if (!a) return [];
  const cityLine = [[a.city, a.region].filter((x) => x && x.trim()).join(", "), a.postal].filter((x) => x && x.trim()).join(" ");
  return [a.name, a.line1, a.line2, cityLine, a.country].map((l) => (l ?? "").trim()).filter(Boolean);
}

/** One line for a list: "1200 Mill Road, Springfield, IL 62701". */
export const addressOneLine = (a?: Partial<Address> | null) => addressLines(a).filter((l, i, all) => !(i === 0 && a?.name && l === a.name && all.length > 1)).join(", ");

/** Same address, field for field (ignoring surrounding spaces). */
export const sameAddress = (a?: Partial<Address> | null, b?: Partial<Address> | null) => JSON.stringify(addressLines(a)) === JSON.stringify(addressLines(b));
