import { deflateSync, inflateSync } from "node:zlib";
import type { PdfImage } from "./pdf.js";

// Logos for documents. Only PNG and JPEG are accepted, small, with every length and checksum checked before anything is used. A PNG
// is DECODED and rewritten as plain pixels (so nothing from the uploaded file reaches the PDF but the pixels); a JPEG is structurally
// validated and embedded as it is. SVG and everything else is refused.

export const MAX_LOGO_BYTES = 300 * 1024;
export const MAX_LOGO_SIDE = 1500;

export type ImageResult = { ok: true; kind: "png" | "jpeg"; contentType: "image/png" | "image/jpeg"; width: number; height: number; pdf: PdfImage } | { ok: false; error: string };
const bad = (error: string): ImageResult => ({ ok: false, error });

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buf: Buffer): ImageResult {
  let pos = 8;
  let ihdr: { w: number; h: number; depth: number; type: number } | null = null;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  let sawIdat = false, idatDone = false, ended = false;
  while (pos < buf.length) {
    if (ended) return bad("This PNG has data after its end. Export it again.");
    if (pos + 12 > buf.length) return bad("This PNG is cut short.");
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (len > buf.length || pos + 12 + len > buf.length) return bad("This PNG is cut short.");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) return bad("This PNG is damaged (a checksum doesn't match).");
    if (!ihdr && type !== "IHDR") return bad("This isn't a valid PNG.");
    if (type === "IHDR") {
      if (ihdr || len !== 13) return bad("This isn't a valid PNG.");
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8]!, type: data[9]! };
      if (data[10] !== 0 || data[11] !== 0) return bad("This isn't a valid PNG.");
      if (data[12] !== 0) return bad("Interlaced PNGs aren't supported. Export it without interlacing.");
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") { if (idatDone) return bad("This isn't a valid PNG."); sawIdat = true; idat.push(data); }
    else if (type === "IEND") ended = true;
    else if ((type.charCodeAt(0) & 0x20) === 0) return bad(`This PNG uses a feature that isn't supported (${type}).`);
    if (type !== "IDAT" && sawIdat) idatDone = true;
    pos += 12 + len;
  }
  if (!ihdr || !ended || !idat.length) return bad("This isn't a valid PNG.");
  const { w, h, depth, type: ct } = ihdr;
  if (w < 1 || h < 1 || w > MAX_LOGO_SIDE || h > MAX_LOGO_SIDE) return bad(`The logo must be between 1 and ${MAX_LOGO_SIDE} pixels each way.`);
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : ct === 6 ? 4 : 0;
  if (!channels) return bad("This isn't a valid PNG.");
  const okDepth = ct === 3 ? [1, 2, 4, 8].includes(depth) : depth === 8;
  if (!okDepth) return bad("Only 8-bit PNGs are supported. Export the logo as an 8-bit PNG.");
  if (ct === 3 && (!plte || plte.length % 3 !== 0 || plte.length === 0 || plte.length / 3 > 1 << depth)) return bad("This PNG's colour table is wrong.");
  const bitsPerPixel = channels * depth;
  const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
  const expected = (rowBytes + 1) * h;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); } catch { return bad("This PNG's image data is damaged or too large."); }
  if (raw.length !== expected) return bad("This PNG's image data is the wrong size.");

  // Undo the row filters.
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const px = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rowBytes + 1)]!;
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    if (f > 4) return bad("This PNG's image data is damaged.");
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? px[dst + x - bpp]! : 0;
      const b = y > 0 ? px[dst - rowBytes + x]! : 0;
      const c = x >= bpp && y > 0 ? px[dst - rowBytes + x - bpp]! : 0;
      let v = raw[src + x]!;
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }

  // To plain pixels on white: grey stays grey, everything else becomes RGB. Transparency is flattened onto white.
  const gray = ct === 0 || ct === 4;
  const out = Buffer.alloc(w * h * (gray ? 1 : 3));
  const over = (c: number, a: number) => Math.round((c * a + 255 * (255 - a)) / 255);
  const key = trns && ct === 0 && trns.length >= 2 ? trns.readUInt16BE(0) : null;
  const keyRgb = trns && ct === 2 && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const row = y * rowBytes;
      if (ct === 3) {
        const bit = x * depth;
        const idx = depth === 8 ? px[row + x]! : (px[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (idx * 3 + 2 >= plte!.length) return bad("This PNG's colour table is wrong.");
        const a = trns && idx < trns.length ? trns[idx]! : 255;
        for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = over(plte![idx * 3 + k]!, a);
      } else if (ct === 0) {
        const g = px[row + x]!;
        out[y * w + x] = key !== null && g === key ? 255 : g;
      } else if (ct === 4) {
        out[y * w + x] = over(px[row + x * 2]!, px[row + x * 2 + 1]!);
      } else if (ct === 2) {
        const r = px[row + x * 3]!, g = px[row + x * 3 + 1]!, b = px[row + x * 3 + 2]!;
        const clear = keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2];
        out[(y * w + x) * 3] = clear ? 255 : r; out[(y * w + x) * 3 + 1] = clear ? 255 : g; out[(y * w + x) * 3 + 2] = clear ? 255 : b;
      } else {
        const a = px[row + x * 4 + 3]!;
        for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = over(px[row + x * 4 + k]!, a);
      }
    }
  }
  return { ok: true, kind: "png", contentType: "image/png", width: w, height: h, pdf: { width: w, height: h, colorSpace: gray ? "DeviceGray" : "DeviceRGB", filter: "FlateDecode", data: deflateSync(out) } };
}

function readJpeg(buf: Buffer): ImageResult {
  if (buf.length < 4 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return bad("This JPEG is cut short.");
  let pos = 2;
  let size: { w: number; h: number; comps: number } | null = null;
  let sawScan = false;
  while (pos < buf.length - 2 && !sawScan) {
    if (buf[pos] !== 0xff) return bad("This JPEG is damaged.");
    while (buf[pos] === 0xff && pos < buf.length) pos++; // fill bytes
    const marker = buf[pos++]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (pos + 2 > buf.length) return bad("This JPEG is cut short.");
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) return bad("This JPEG is damaged.");
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (len < 8) return bad("This JPEG is damaged.");
      if (buf[pos + 2] !== 8) return bad("Only 8-bit JPEGs are supported.");
      size = { h: buf.readUInt16BE(pos + 3), w: buf.readUInt16BE(pos + 5), comps: buf[pos + 7]! };
    } else if (marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) return bad("This kind of JPEG isn't supported. Save it as a standard (baseline) JPEG.");
    else if (marker === 0xee && buf.toString("latin1", pos + 2, pos + 7) === "Adobe" && buf[pos + 13] === 2) return bad("CMYK JPEGs aren't supported. Save the logo as RGB.");
    if (marker === 0xda) sawScan = true;
    pos += len;
  }
  if (!size || !sawScan) return bad("This isn't a valid JPEG.");
  if (size.comps !== 1 && size.comps !== 3) return bad("Only grey or RGB JPEGs are supported.");
  if (size.w < 1 || size.h < 1 || size.w > MAX_LOGO_SIDE || size.h > MAX_LOGO_SIDE) return bad(`The logo must be between 1 and ${MAX_LOGO_SIDE} pixels each way.`);
  return { ok: true, kind: "jpeg", contentType: "image/jpeg", width: size.w, height: size.h, pdf: { width: size.w, height: size.h, colorSpace: size.comps === 1 ? "DeviceGray" : "DeviceRGB", filter: "DCTDecode", data: Buffer.from(buf) } };
}

/** Reads an uploaded logo. The kind is decided by what the bytes are, not by what the file claims to be. */
export function readImage(buf: Buffer): ImageResult {
  if (!buf.length) return bad("That file is empty.");
  if (buf.length > MAX_LOGO_BYTES) return bad(`The logo is too big (${Math.ceil(buf.length / 1024)} KB). The limit is ${MAX_LOGO_BYTES / 1024} KB.`);
  if (buf.subarray(0, 8).equals(PNG_SIG)) return readPng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return readJpeg(buf);
  return bad("Only PNG and JPEG logos are accepted.");
}
