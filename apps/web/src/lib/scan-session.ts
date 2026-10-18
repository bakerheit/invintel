import { uomOf, type Item } from "@invintel/shared";

/**
 * The running list behind the floor's multi-scan screens: scan the place once, then scan items; every scan adds one
 * (or what the label says), the same item and lot merge into one line, and the whole list is posted as one document.
 * Pure functions over plain data, so the rules are tested without a screen.
 */

export interface SessionLine {
  /** Item + lot + expiry + pallet (+ source place for a move): scans that agree on all of it are one line. */
  key: string;
  item: Item;
  /** Stored whole number, as the rest of the app keeps quantities. */
  quantity: number;
  lot: string;
  expiresOn: string;
  sscc: string;
  /** Moves only: where this line is taken from. */
  from: string;
}

/** What a scan can tell us besides which item it is. A GS1 label gives all of it; a plain barcode gives none. */
export interface ScanFacts {
  /** Stored quantity. Only set when the label says how many (and the item counts in whole units). */
  qty?: number;
  lot?: string;
  expiresOn?: string;
  sscc?: string;
  from?: string;
}

export interface Session {
  lines: SessionLine[];
  /** Earlier lists, newest last, so "undo last scan" can step back. */
  history: SessionLine[][];
}

export const emptySession = (): Session => ({ lines: [], history: [] });

const HISTORY = 50;

export const lineKey = (item: Item, f: Pick<ScanFacts, "lot" | "expiresOn" | "sscc" | "from">) =>
  [item.id, f.lot ?? "", f.expiresOn ?? "", f.sscc ?? "", f.from ?? ""].join("|");

/** One scan of a plain barcode is "one more", which only means something for things counted in whole units. */
export const stepOf = (item: Item) => 10 ** uomOf(item).decimals;

/**
 * Items measured in kilos, metres or litres (anything with decimals) can't be "one more" by scanning: the person says how
 * much. Counted items (each, box, case) are one per scan unless a label gave a count.
 */
export const needsQuantity = (item: Item, facts: ScanFacts = {}) => facts.qty === undefined && uomOf(item).decimals > 0;

export type Added = { ok: true; session: Session; line: SessionLine; created: boolean } | { ok: false; error: string };

/**
 * Adds a scan to the list. `quantity` is what to add: the label's count if it has one, else one for counted items, else what
 * the person typed. A pallet (SSCC) that is already on the list is refused: the same label scanned twice is a mistake, not
 * two pallets.
 */
export function addScan(session: Session, item: Item, facts: ScanFacts = {}, quantity?: number): Added {
  const qty = quantity ?? facts.qty ?? (needsQuantity(item) ? undefined : stepOf(item));
  if (qty === undefined || !Number.isSafeInteger(qty) || qty < 1) return { ok: false, error: `How many ${item.name}? Say a quantity.` };
  if (facts.sscc && session.lines.some((l) => l.sscc === facts.sscc)) return { ok: false, error: "That pallet is already on the list." };
  const f = { lot: facts.lot ?? "", expiresOn: facts.expiresOn ?? "", sscc: facts.sscc ?? "", from: facts.from ?? "" };
  const key = lineKey(item, f);
  const at = session.lines.findIndex((l) => l.key === key);
  const history = [...session.history, session.lines].slice(-HISTORY);
  if (at >= 0) {
    const lines = session.lines.map((l, i) => (i === at ? { ...l, quantity: l.quantity + qty } : l));
    return { ok: true, session: { lines, history }, line: lines[at]!, created: false };
  }
  const line: SessionLine = { key, item, quantity: qty, ...f };
  return { ok: true, session: { lines: [...session.lines, line], history }, line, created: true };
}

/** Sets a line's quantity (a person edited it). 0 or less removes the line. */
export function setQuantity(session: Session, key: string, quantity: number): Session {
  const lines = quantity < 1 ? session.lines.filter((l) => l.key !== key) : session.lines.map((l) => (l.key === key ? { ...l, quantity } : l));
  return { lines, history: session.history };
}

export const removeLine = (session: Session, key: string): Session => ({ lines: session.lines.filter((l) => l.key !== key), history: session.history });

export const canUndo = (session: Session) => session.history.length > 0;

/** Steps back one scan. */
export function undoLast(session: Session): Session {
  const previous = session.history[session.history.length - 1];
  return previous ? { lines: previous, history: session.history.slice(0, -1) } : session;
}

export function summarize(session: Session) {
  const items = new Set(session.lines.map((l) => l.item.id));
  return { lines: session.lines.length, items: items.size };
}

// ---------- receiving against a purchase order ----------

export interface PoLine {
  item: Item;
  ordered: number;
  /** Already received on earlier deliveries. */
  received: number;
  /** This delivery, so far. */
  quantity: number;
  lot: string;
  expiresOn: string;
}

export type PoScan = { ok: true; lines: PoLine[]; line: PoLine } | { ok: false; error: string };

/**
 * One scan against an order's lines. An item that isn't on the order is refused (the order can't take it); a second lot of the
 * same item is refused too, since an order line records one lot: that goes on a second receipt.
 */
export function scanPoLine(lines: PoLine[], item: Item, facts: ScanFacts = {}, quantity?: number): PoScan {
  const at = lines.findIndex((l) => l.item.id === item.id);
  if (at < 0) return { ok: false, error: `${item.name} isn't on this order.` };
  const line = lines[at]!;
  const qty = quantity ?? facts.qty ?? (needsQuantity(item) ? undefined : stepOf(item));
  if (qty === undefined || !Number.isSafeInteger(qty) || qty < 1) return { ok: false, error: `How many ${item.name}? Say a quantity.` };
  const lot = facts.lot ?? "";
  if (lot && line.lot && line.quantity > 0 && lot !== line.lot) {
    return { ok: false, error: `${item.name} already has lot ${line.lot} in this delivery. Receive lot ${lot} as a second delivery.` };
  }
  const expiresOn = facts.expiresOn ?? "";
  if (expiresOn && line.expiresOn && line.quantity > 0 && expiresOn !== line.expiresOn) {
    return { ok: false, error: `${item.name} already has expiry ${line.expiresOn} in this delivery. Receive the other date as a second delivery.` };
  }
  const next: PoLine = { ...line, quantity: line.quantity + qty, lot: lot || line.lot, expiresOn: expiresOn || line.expiresOn };
  return { ok: true, lines: lines.map((l, i) => (i === at ? next : l)), line: next };
}
