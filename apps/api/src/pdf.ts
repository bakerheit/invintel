// A tiny PDF writer: text and lines in the two standard fonts (Helvetica, Helvetica-Bold), no images, no dependencies.
// Enough for a purchase order a supplier can read, print or file. Text is written in WinAnsi; characters outside it
// become "?" so a stray symbol never corrupts the file.

const PAGE_W = 595; // A4 in points
const PAGE_H = 842;

const WIN_ANSI_EXTRA: Record<string, number> = { "€": 0x80, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "…": 0x85, "–": 0x96, "—": 0x97 };

function encode(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    let b: number;
    if (code === 0x0a || code === 0x0d || code === 0x09) b = 0x20;
    else if (code >= 0x20 && code <= 0x7e) b = code;
    else if (code >= 0xa0 && code <= 0xff) b = code;
    else b = WIN_ANSI_EXTRA[ch] ?? 0x3f;
    out += b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b);
  }
  return out;
}

export interface TextOptions { size?: number; bold?: boolean; align?: "left" | "right" }

/** Rough Helvetica widths (per 1000 em) for right alignment and wrapping; exact enough for layout, not for typesetting. */
const AVG_W = 0.52;
export const textWidth = (s: string, size: number) => s.length * size * AVG_W;

export class PdfDoc {
  private pages: string[][] = [];
  private current: string[] | null = null;

  addPage() {
    this.current = [];
    this.pages.push(this.current);
    return this.pages.length;
  }

  private ensure() {
    if (!this.current) this.addPage();
    return this.current!;
  }

  /** y counts down from the top of the page, like a form. */
  text(x: number, y: number, s: string, opts: TextOptions = {}) {
    const size = opts.size ?? 10;
    const px = opts.align === "right" ? x - textWidth(s, size) : x;
    this.ensure().push(`BT /${opts.bold ? "F2" : "F1"} ${size} Tf ${px.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Td (${encode(s)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5) {
    this.ensure().push(`${width} w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S`);
  }

  /** Splits text into lines that fit `width` points at `size`. */
  wrap(s: string, width: number, size = 10): string[] {
    const out: string[] = [];
    for (const para of s.split(/\r?\n/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, size) > width && line) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  get pageCount() { return this.pages.length; }

  toBuffer(info: { title?: string; author?: string } = {}): Buffer {
    if (!this.pages.length) this.addPage();
    const objs: string[] = [];
    // 1 catalog, 2 pages, 3 font, 4 bold font, 5 info, then a page and a content stream per page
    const pageIds = this.pages.map((_, i) => 6 + i * 2);
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    objs[5] = `<< /Producer (Invintel) /Title (${encode(info.title ?? "Document")}) /Author (${encode(info.author ?? "")}) >>`;
    this.pages.forEach((ops, i) => {
      const pid = 6 + i * 2;
      const stream = ops.join("\n");
      objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pid + 1} 0 R >>`;
      objs[pid + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = Buffer.byteLength(body, "latin1");
      body += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(body, "latin1");
    body += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    body += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body, "latin1");
  }
}
