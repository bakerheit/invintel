// A small PDF writer: text, lines, filled boxes and images (PNG/JPEG logos), in the two standard fonts (Helvetica, Helvetica-Bold),
// no dependencies. Enough for documents a business can email, print or file. Text is written in WinAnsi; characters outside it become "?"
// so a stray symbol never corrupts the file.

export type PaperSize = "a4" | "letter";
const PAPER: Record<PaperSize, { w: number; h: number }> = { a4: { w: 595, h: 842 }, letter: { w: 612, h: 792 } };

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

/** "#RRGGBB" as three 0..1 numbers, or null if it isn't one. */
export function parseColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const rgb = (c: [number, number, number]) => `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)}`;

export interface TextOptions { size?: number; bold?: boolean; align?: "left" | "right" | "center"; color?: string }

// Helvetica advance widths per 1000 em for 0x20..0x7e (from the standard AFM). Bold is a little wider on average.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
export const textWidth = (s: string, size: number, bold = false) => {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x20 && c <= 0x7e ? HELV[c - 0x20]! : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
};

/** An image ready to be placed: raw pixels (Flate) or a JPEG as it is (DCT). Built by image.ts, which checks everything first. */
export interface PdfImage {
  width: number;
  height: number;
  colorSpace: "DeviceRGB" | "DeviceGray";
  filter: "FlateDecode" | "DCTDecode";
  data: Buffer;
}

export class PdfDoc {
  private pages: { ops: string[]; images: Set<number> }[] = [];
  private current: { ops: string[]; images: Set<number> } | null = null;
  private images: PdfImage[] = [];
  readonly width: number;
  readonly height: number;

  constructor(paper: PaperSize = "a4") {
    this.width = PAPER[paper].w;
    this.height = PAPER[paper].h;
  }

  addPage() {
    this.current = { ops: [], images: new Set() };
    this.pages.push(this.current);
    return this.pages.length;
  }

  private ensure() {
    if (!this.current) this.addPage();
    return this.current!;
  }

  /** Runs `draw` on page `index` (0-based) and goes back: for things only known at the end, like "page 2 of 3". */
  onPage(index: number, draw: () => void) {
    const keep = this.current;
    this.current = this.pages[index] ?? this.current;
    try { draw(); } finally { this.current = keep; }
  }

  /** y counts down from the top of the page, like a form. */
  text(x: number, y: number, s: string, opts: TextOptions = {}) {
    const size = opts.size ?? 10;
    const w = textWidth(s, size, opts.bold);
    const px = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    const col = opts.color ? parseColor(opts.color) : null;
    const draw = `BT /${opts.bold ? "F2" : "F1"} ${size} Tf ${px.toFixed(2)} ${(this.height - y).toFixed(2)} Td (${encode(s)}) Tj ET`;
    this.ensure().ops.push(col ? `q ${rgb(col)} rg ${draw} Q` : draw);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color?: string) {
    const col = color ? parseColor(color) : null;
    const draw = `${width} w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`;
    this.ensure().ops.push(col ? `q ${rgb(col)} RG ${draw} Q` : draw);
  }

  /** A filled box. (x, y) is the top left. */
  rect(x: number, y: number, w: number, h: number, fill: string) {
    const col = parseColor(fill);
    if (!col) return;
    this.ensure().ops.push(`q ${rgb(col)} rg ${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q`);
  }

  /** Places an image with its top left at (x, y), scaled to w x h points. */
  image(img: PdfImage, x: number, y: number, w: number, h: number) {
    let idx = this.images.indexOf(img);
    if (idx < 0) { this.images.push(img); idx = this.images.length - 1; }
    const page = this.ensure();
    page.images.add(idx);
    page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} cm /Im${idx + 1} Do Q`);
  }

  /** Splits text into lines that fit `width` points at `size`. A single word wider than the line is broken. */
  wrap(s: string, width: number, size = 10, bold = false): string[] {
    const out: string[] = [];
    const push = (line: string) => out.push(line);
    for (const para of s.split(/\r?\n/)) {
      let line = "";
      for (let word of para.split(/\s+/).filter(Boolean)) {
        while (textWidth(word, size, bold) > width && word.length > 1) {
          let cut = word.length - 1;
          while (cut > 1 && textWidth(word.slice(0, cut), size, bold) > width) cut--;
          if (line) { push(line); line = ""; }
          push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, size, bold) > width && line) { push(line); line = word; } else line = next;
      }
      push(line);
    }
    return out;
  }

  /** `s` cut to fit `width`, with an ellipsis if it had to be shortened. */
  fit(s: string, width: number, size = 10, bold = false): string {
    if (textWidth(s, size, bold) <= width) return s;
    let t = s;
    while (t.length > 1 && textWidth(`${t}…`, size, bold) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  get pageCount() { return this.pages.length; }

  toBuffer(info: { title?: string; author?: string } = {}): Buffer {
    if (!this.pages.length) this.addPage();
    // 1 catalog, 2 pages, 3 font, 4 bold font, 5 info, then a page and a content stream per page, then the images
    const imgBase = 6 + this.pages.length * 2;
    const objs: Buffer[] = [];
    const str = (s: string) => Buffer.from(s, "latin1");
    const pageIds = this.pages.map((_, i) => 6 + i * 2);
    objs[1] = str("<< /Type /Catalog /Pages 2 0 R >>");
    objs[2] = str(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
    objs[3] = str("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    objs[4] = str("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    objs[5] = str(`<< /Producer (Invintel) /Title (${encode(info.title ?? "Document")}) /Author (${encode(info.author ?? "")}) >>`);
    this.pages.forEach((page, i) => {
      const pid = 6 + i * 2;
      const stream = page.ops.join("\n");
      const xobj = page.images.size ? ` /XObject << ${[...page.images].map((n) => `/Im${n + 1} ${imgBase + n} 0 R`).join(" ")} >>` : "";
      objs[pid] = str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> /Contents ${pid + 1} 0 R >>`);
      objs[pid + 1] = str(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    });
    this.images.forEach((im, n) => {
      objs[imgBase + n] = Buffer.concat([
        str(`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.colorSpace} /BitsPerComponent 8 /Filter /${im.filter} /Length ${im.data.length} >>\nstream\n`),
        im.data,
        str("\nendstream"),
      ]);
    });
    const parts: Buffer[] = [str("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
    const offsets: number[] = [];
    let size = parts[0]!.length;
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = size;
      const chunk = Buffer.concat([str(`${id} 0 obj\n`), objs[id]!, str("\nendobj\n")]);
      parts.push(chunk);
      size += chunk.length;
    }
    let tail = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) tail += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    tail += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    parts.push(str(tail));
    return Buffer.concat(parts);
  }
}
