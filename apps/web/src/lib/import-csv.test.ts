import { describe, expect, it } from "vitest";
import { problemRowsCsv } from "./import-csv";

describe("problemRowsCsv", () => {
  it("keeps the header and original cells and adds the problem", () => {
    const csv = problemRowsCsv({
      headers: ["sku", "name", "price"],
      rows: [
        { line: 2, sku: "A", status: "create", message: "New item, no stock" },
        { line: 3, sku: "B", status: "error", message: 'Unit cost "abc" isn\'t a number', cells: ["B", "Beta, large", "abc"] },
        { line: 4, sku: "C", status: "error", message: 'Said "no"', cells: ["C", "Gamma", ""] },
      ],
    });
    expect(csv).toBe('sku,name,price,problem\r\nB,"Beta, large",abc,"Unit cost ""abc"" isn\'t a number"\r\nC,Gamma,,"Said ""no"""\r\n');
  });
  it("is just the header when nothing went wrong", () => {
    expect(problemRowsCsv({ headers: ["sku"], rows: [] })).toBe("sku,problem\r\n");
  });
});
