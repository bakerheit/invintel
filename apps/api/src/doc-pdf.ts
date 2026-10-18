import { DOC_LABELS, DEFAULT_TITLES, type CompanyProfile, type DocKind, type DocTemplate } from "@invintel/shared";
import { PdfDoc, parseColor, textWidth, type PdfImage } from "./pdf.js";

// INV-17: the layout engine behind every document PDF. A document is described (who it is from and to, facts, a table, totals,
// notes) and drawn with the organization's letterhead and the template in force: title, accent colour, logo, which columns, terms,
// footer, paper size. Long tables continue on further pages with the header repeated and "Page 2 of 3" at the bottom.

export interface DocContext {
  kind: DocKind;
  /** The letterhead. `name` is already resolved (the company name, or the organization's own). */
  company: CompanyProfile & { name: string };
  template: DocTemplate;
  logo: PdfImage | null;
}

export interface DocColumn { key: string; header: string; align: "left" | "right" }

export interface DocSpec {
  number: string;
  /** Small lines under the number, e.g. Issued, Due. */
  meta: [string, string][];
  /** One or two blocks (From/To, Bill to/Ship to). The first line of each is drawn bold. */
  parties: { heading: string; lines: string[] }[];
  /** Label and value pairs: requested date, carrier, tracking. */
  facts: [string, string][];
  /** Every column the document can have; the template picks which are drawn. */
  columns: DocColumn[];
  rows: Record<string, string>[];
  totals: { label: string; value: string; strong?: boolean }[];
  note?: string;
  /** A line asking the reader to do something at an address (the supplier page). */
  link?: { label: string; url: string };
}

const WIDTHS: Record<string, number> = { sku: 82, quantity: 66, unitPrice: 68, amount: 76, ordered: 56, shipped: 64, toDate: 78 };
const GREY = "#666666";
const RULE = "#cccccc";

/** Mixes the accent with white, for the table header band. */
function tint(hex: string, amount: number): string {
  const c = parseColor(hex) ?? [0.2, 0.25, 0.33];
  const m = (v: number) => Math.round((v + (1 - v) * amount) * 255).toString(16).padStart(2, "0");
  return `#${m(c[0])}${m(c[1])}${m(c[2])}`;
}

export function renderDocPdf(spec: DocSpec, ctx: DocContext): Buffer {
  const { company, template: t } = ctx;
  const accent = parseColor(t.accent) ? t.accent : "#334155";
  const pdf = new PdfDoc(company.paper);
  const L = 48;
  const R = pdf.width - 48;
  const W = R - L;
  const bottom = pdf.height - 74;
  const title = t.title.trim() || DEFAULT_TITLES[ctx.kind];
  let y = 0;

  const companyBlock = (x: number, top: number, withLogo: boolean): number => {
    let yy = top;
    if (withLogo && t.showLogo && ctx.logo) {
      const maxW = 170, maxH = 58;
      const s = Math.min(maxW / ctx.logo.width, maxH / ctx.logo.height, 1 * 2);
      const w = ctx.logo.width * s, h = ctx.logo.height * s;
      pdf.image(ctx.logo, x, yy, w, h);
      yy += h + 8;
    }
    pdf.text(x, yy + 10, company.name, { size: 12, bold: true });
    yy += 15;
    for (const a of company.addressLines.filter(Boolean)) { pdf.text(x, yy + 10, a, { size: 8.5, color: GREY }); yy += 11; }
    const contact = [company.phone, company.email, company.website].filter(Boolean).join("  ·  ");
    if (contact) for (const l of pdf.wrap(contact, W * 0.56, 8.5).slice(0, 3)) { pdf.text(x, yy + 10, l, { size: 8.5, color: GREY }); yy += 11; }
    if (company.taxId) { pdf.text(x, yy + 10, company.taxId, { size: 8.5, color: GREY }); yy += 11; }
    return yy;
  };

  const firstHeader = () => {
    pdf.addPage();
    pdf.rect(0, 0, pdf.width, 6, accent);
    const leftEnd = companyBlock(L, 30, true);
    // The title sits beside the letterhead: it shrinks to fit the room there, and wraps onto a second line if it still doesn't.
    const room = W * 0.42;
    let size = 20;
    while (size > 12 && textWidth(title, size, true) > room) size -= 1;
    const lines = textWidth(title, size, true) > room ? pdf.wrap(title, room, size, true).slice(0, 2) : [title];
    lines.forEach((l, i) => pdf.text(R, 50 + i * (size + 2), l, { size, bold: true, align: "right", color: accent }));
    const drop = (lines.length - 1) * (size + 2);
    pdf.text(R, 70 + drop, spec.number, { size: 12, bold: true, align: "right" });
    let ry = 84 + drop;
    for (const [k, v] of spec.meta) { pdf.text(R, ry + 8, `${k}  ${v}`, { size: 9, align: "right", color: GREY }); ry += 12; }
    y = Math.max(leftEnd, ry) + 8;
    pdf.line(L, y, R, y, 1, RULE);
    y += 18;
  };
  const nextHeader = () => {
    pdf.addPage();
    pdf.rect(0, 0, pdf.width, 6, accent);
    pdf.text(L, 36, company.name, { size: 10, bold: true });
    pdf.text(R, 36, `${title}  ${spec.number}  (continued)`, { size: 9, align: "right", color: GREY });
    pdf.line(L, 46, R, 46, 0.8, RULE);
    y = 64;
  };

  // ---- columns: the template picks which, the rest of the width goes to the description (or the first column)
  const cols = spec.columns.filter((c) => t.columns.includes(c.key));
  const use = cols.length ? cols : spec.columns;
  const flexKey = use.find((c) => c.key === "description")?.key ?? use[0]!.key;
  const fixed = use.filter((c) => c.key !== flexKey).reduce((s, c) => s + (WIDTHS[c.key] ?? 70), 0);
  const widthOf = (c: DocColumn) => (c.key === flexKey ? Math.max(110, W - fixed) : WIDTHS[c.key] ?? 70);
  const xs: { c: DocColumn; x: number; w: number }[] = [];
  let cx = L;
  for (const c of use) { const w = widthOf(c); xs.push({ c, x: cx, w }); cx += w; }
  const scale = W / (cx - L); // never wider than the page, even with the minimum description width
  if (scale < 1) { let acc = L; for (const e of xs) { e.w *= scale; e.x = acc; acc += e.w; } }

  const tableHead = () => {
    pdf.rect(L, y - 11, W, 20, tint(accent, 0.88));
    for (const { c, x, w } of xs) {
      if (c.align === "right") pdf.text(x + w - 6, y + 2, c.header, { size: 8, bold: true, align: "right", color: accent });
      else pdf.text(x + 6, y + 2, c.header, { size: 8, bold: true, color: accent });
    }
    y += 22;
  };

  const footers = () => {
    const n = pdf.pageCount;
    for (let i = 0; i < n; i++) {
      pdf.onPage(i, () => {
        pdf.line(L, pdf.height - 56, R, pdf.height - 56, 0.5, RULE);
        const foot = t.footer.trim();
        if (foot) pdf.wrap(foot, W - 90, 8).slice(0, 2).forEach((l, k) => pdf.text(L, pdf.height - 44 + k * 10, l, { size: 8, color: GREY }));
        pdf.text(R, pdf.height - 44, `Page ${i + 1} of ${n}`, { size: 8, align: "right", color: GREY });
      });
    }
  };
  const room = (need: number) => { if (y + need > bottom) { nextHeader(); return true; } return false; };

  // ---- page one
  firstHeader();
  const parties = spec.parties.slice(0, 2);
  if (parties.length) {
    const gap = 24;
    const pw = parties.length === 2 ? (W - gap) / 2 : W;
    let tallest = 0;
    parties.forEach((p, i) => {
      const x = L + i * (pw + gap);
      pdf.text(x, y + 6, p.heading.toUpperCase(), { size: 8, bold: true, color: accent });
      let py = y + 22;
      p.lines.filter(Boolean).forEach((line, k) => {
        for (const w of pdf.wrap(line, pw, k === 0 ? 11 : 9.5, k === 0)) { pdf.text(x, py, w, { size: k === 0 ? 11 : 9.5, bold: k === 0 }); py += k === 0 ? 14 : 12; }
      });
      tallest = Math.max(tallest, py - y);
    });
    y += tallest + 8;
  }
  for (const [k, v] of spec.facts.filter(([, v]) => v)) {
    room(14);
    pdf.text(L, y, `${k}:`, { size: 9, bold: true });
    pdf.text(L + textWidth(`${k}: `, 9, true) + 2, y, pdf.fit(v, W - 140, 9), { size: 9 });
    y += 14;
  }
  if (spec.note) {
    y += 2;
    for (const line of pdf.wrap(spec.note, W, 9)) { room(12); pdf.text(L, y, line, { size: 9 }); y += 12; }
  }
  if (spec.link) {
    y += 4;
    room(30);
    pdf.text(L, y, spec.link.label, { size: 9, bold: true });
    pdf.text(L, y + 13, pdf.fit(spec.link.url, W, 9), { size: 9, color: accent });
    y += 28;
  }
  y += 14;

  // ---- the table
  room(60);
  tableHead();
  for (const row of spec.rows) {
    const cells = xs.map(({ c, w }) => (c.key === flexKey ? pdf.wrap(row[c.key] ?? "", w - 12, 9).slice(0, 3) : [pdf.fit(row[c.key] ?? "", w - 12, 9)]));
    const h = Math.max(...cells.map((x) => x.length)) * 11 + 8;
    if (y + h > bottom) { nextHeader(); tableHead(); }
    xs.forEach(({ c, x, w }, i) => {
      cells[i]!.forEach((line, k) => {
        if (c.align === "right") pdf.text(x + w - 6, y + 2 + k * 11, line, { size: 9, align: "right" });
        else pdf.text(x + 6, y + 2 + k * 11, line, { size: 9 });
      });
    });
    pdf.line(L, y + h - 8, R, y + h - 8, 0.4, RULE);
    y += h;
  }

  // ---- totals, terms
  if (spec.totals.length) {
    room(spec.totals.length * 16 + 20);
    y += 8;
    for (const tot of spec.totals) {
      pdf.text(R - 110, y, tot.label, { size: tot.strong ? 10.5 : 9.5, bold: !!tot.strong, align: "right", color: tot.strong ? accent : undefined });
      pdf.text(R - 6, y, tot.value, { size: tot.strong ? 11 : 9.5, bold: !!tot.strong, align: "right" });
      y += tot.strong ? 18 : 15;
    }
  }
  const terms = t.terms.trim();
  if (terms) {
    const lines = pdf.wrap(terms, W, 8.5);
    room(Math.min(lines.length, 3) * 11 + 28);
    y += 16;
    pdf.text(L, y, "TERMS", { size: 8, bold: true, color: accent });
    y += 13;
    for (const line of lines) { if (y > bottom) { nextHeader(); } pdf.text(L, y, line, { size: 8.5, color: GREY }); y += 11; }
  }
  footers();
  return pdf.toBuffer({ title: `${DOC_LABELS[ctx.kind]} ${spec.number}`, author: company.name });
}
