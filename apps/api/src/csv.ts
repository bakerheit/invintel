/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, optional BOM. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false; // has this row seen any character?
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      if (started || cell !== "") {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = "";
      started = false;
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell !== "") {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Spreadsheets run cells that start with = + - @ as formulas, so export text gets a leading apostrophe.
 * (Numbers are written through `csvNumber`, which never needs it.)
 */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export const csvNumber = (n: number) => String(n);
