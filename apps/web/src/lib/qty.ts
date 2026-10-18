import {
  convertQty,
  formatQty,
  parseQty,
  qtyErrorMessage,
  uomOf,
  type AltUnit,
  type QtyParse,
  type Uom,
} from "@invintel/shared";
import { useMemo, useState } from "react";

export type UomSource = Partial<Uom> & { altUnits?: AltUnit[] | null };

export interface QtyEntryOptions {
  uom: UomSource;
  /** The unit the person is typing in: the item's own unit, or one of its altUnits. */
  entryUnit?: string;
  signed?: boolean;
}

/** Reads typed text into the stored whole number, converting from an alternate unit when one is chosen. */
export function readQtyEntry(text: string, { uom, entryUnit, signed }: QtyEntryOptions): QtyParse {
  const { unit, decimals } = uomOf(uom);
  const alt = entryUnit && entryUnit !== unit ? uom.altUnits?.find((a) => a.name === entryUnit) : undefined;
  return alt ? convertQty(text, alt.factor, decimals, { signed }) : parseQty(text, decimals, { signed });
}

/** A stored number as editable text: no unit, no thousands separators. */
export const qtyText = (stored: number | null | undefined, uom: UomSource) =>
  stored === null || stored === undefined ? "" : formatQty(stored, uom, { unit: false, group: false });

export interface QtyEntry {
  uom: Uom;
  altUnits: AltUnit[];
  text: string;
  setText: (t: string) => void;
  entryUnit: string;
  setEntryUnit: (u: string) => void;
  result: QtyParse;
  /** The whole number to send, or null while the text isn't a valid quantity. */
  stored: number | null;
  /** What to tell the person, once they have typed something. */
  error: string | null;
  signed: boolean;
  /** Put a stored value into the box (and switch back to the item's own unit). */
  set: (stored: number | null) => void;
}

/**
 * State for one quantity box. The text is kept as typed, and parsed against the item's *current*
 * unit and decimals each render, so changing them in a form re-reads what was typed.
 */
export function useQtyEntry(source: UomSource, opts: { initial?: number | null; signed?: boolean } = {}): QtyEntry {
  const uom = uomOf(source);
  const altUnits = source.altUnits ?? [];
  const signed = !!opts.signed;
  const [text, setText] = useState(() => qtyText(opts.initial, source));
  const [picked, setEntryUnit] = useState(uom.unit);
  // If the chosen unit stops existing (unit renamed or removed in the item form), fall back to the item's own.
  const entryUnit = picked === uom.unit || altUnits.some((a) => a.name === picked) ? picked : uom.unit;
  const result = useMemo(
    () => readQtyEntry(text, { uom: { ...uom, altUnits }, entryUnit, signed }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, entryUnit, signed, uom.unit, uom.decimals, JSON.stringify(altUnits)],
  );
  return {
    uom,
    altUnits,
    text,
    setText,
    entryUnit,
    setEntryUnit,
    result,
    stored: result.ok ? result.stored : null,
    error: text.trim() === "" || result.ok ? null : qtyErrorMessage(result.reason, uom),
    signed,
    set: (stored) => {
      setEntryUnit(uom.unit);
      setText(qtyText(stored, source));
    },
  };
}
