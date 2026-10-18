/// <reference types="node" />
import { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
import bwipjs from "bwip-js/node";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it } from "vitest";
import { SCAN_FORMATS } from "./scan-formats";

const require = createRequire(import.meta.url);

// Browsers have ImageData; Node doesn't, and the detector checks its input type.
class TestImageData {
  readonly colorSpace = "srgb";
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}
(globalThis as { ImageData?: unknown }).ImageData ??= TestImageData;
// The detector also returns bounding boxes as DOMRectReadOnly. We only read the text.
(globalThis as { DOMRectReadOnly?: unknown }).DOMRectReadOnly ??= class {
  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly width = 0,
    readonly height = 0,
  ) {}
};
const imageData = (data: Uint8ClampedArray, width: number, height: number) => new TestImageData(data, width, height) as unknown as ImageData;

/** Renders a real barcode image: the same pixels a camera frame would contain. */
async function render(bcid: string, text: string, opts: Record<string, unknown> = {}) {
  // Linear codes need a bar height; 2D codes don't take one.
  const linear = !["qrcode", "datamatrix"].includes(bcid);
  const png = await bwipjs.toBuffer({
    bcid,
    text,
    scale: 4,
    ...(linear ? { height: 14 } : {}),
    paddingwidth: 12,
    paddingheight: 12,
    backgroundcolor: "ffffff",
    ...opts,
  });
  const { data, width, height } = PNG.sync.read(png);
  return imageData(new Uint8ClampedArray(data), width, height);
}

// Same detector class and format list the app uses, so format-name mapping is covered too.
let detector: InstanceType<typeof BarcodeDetector>;
const read = async (image: ImageData) => (await detector.detect(image)).map((r) => ({ text: r.rawValue, format: r.format }));

describe("scan formats", () => {
  beforeAll(async () => {
    // The same wasm binary the app serves, loaded from disk instead of a URL.
    const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    await prepareZXingModule({
      overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer },
      fireImmediately: true,
    });
    detector = new BarcodeDetector({ formats: [...SCAN_FORMATS] });
  });

  const cases: [string, string, string, string][] = [
    ["Code 128 SKU", "code128", "ROLL-KR42", "code_128"],
    ["Code 128 numeric", "code128", "0012345678", "code_128"],
    ["Code 39", "code39", "PAL-4840", "code_39"],
    ["ITF (carton)", "interleaved2of5", "12345678", "itf"],
    ["EAN-13", "ean13", "5901234123457", "ean_13"],
    ["EAN-8", "ean8", "96385074", "ean_8"],
    ["QR code", "qrcode", "CORR1", "qr_code"],
    ["Data Matrix", "datamatrix", "RS", "data_matrix"],
  ];

  it.each(cases)("reads %s", async (_name, bcid, text, format) => {
    const hits = await read(await render(bcid, text));
    expect(hits).toEqual([{ text, format }]);
  });

  it("reads UPC-A, which ZXing reports as 13 digits with a leading zero", async () => {
    // The browser's native detector gives the 12-digit form instead. The server's lookup
    // treats both as the same product (see gtinVariants in @invintel/shared).
    const hits = await read(await render("upca", "036000291452"));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe("0036000291452");
  });

  it("reads a barcode that's small in the frame, as a handheld camera would see it", async () => {
    expect((await read(await render("code128", "ROLL-KR42", { scale: 2 })))[0]?.text).toBe("ROLL-KR42");
  });

  it("ignores formats we didn't ask for", async () => {
    // PDF417 is on driver's licences and boarding passes, not our labels.
    expect(await read(await render("pdf417", "NOT A LABEL"))).toEqual([]);
  });

  it("returns nothing for a blank frame", async () => {
    const blank = imageData(new Uint8ClampedArray(320 * 240 * 4).fill(255), 320, 240);
    expect(await read(blank)).toEqual([]);
  });
});
