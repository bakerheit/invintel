import type { ImportResult } from "@invintel/shared";

/** A spreadsheet cell: quoted if it needs to be. */
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The rows of an import that had problems, with their original cells and a "problem" column on the end,
 * ready to be fixed in a spreadsheet and uploaded again.
 */
export function problemRowsCsv(result: Pick<ImportResult, "headers" | "rows">): string {
  const rows = result.rows.filter((r) => r.status === "error" && r.cells);
  return [[...result.headers, "problem"], ...rows.map((r) => [...r.cells!, r.message])].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
