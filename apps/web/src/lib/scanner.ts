import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { SCAN_FORMATS } from "./scan-formats";

export interface ScanResult {
  value: string;
  format: string;
}

export interface ScanDetector {
  /** "native" is the browser's own BarcodeDetector. "wasm" is ZXing compiled to WebAssembly. */
  backend: "native" | "wasm";
  detect(frame: ImageData): Promise<ScanResult | null>;
}

type NativeDetectorCtor = {
  new (options: { formats: string[] }): { detect(source: ImageBitmapSource): Promise<{ rawValue: string; format: string }[]> };
  getSupportedFormats(): Promise<string[]>;
};

/**
 * Setting localStorage["invintel.scanner"] = "wasm" forces the WebAssembly detector, which helps
 * when a device's native detector misbehaves.
 */
const forcedWasm = () => {
  try {
    return localStorage.getItem("invintel.scanner") === "wasm";
  } catch {
    return false;
  }
};

async function createNative(): Promise<ScanDetector | null> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Native || forcedWasm()) return null;
  try {
    const supported = await Native.getSupportedFormats();
    const formats = SCAN_FORMATS.filter((f) => supported.includes(f));
    // A native detector that can't read Code 128 is no use on a plant floor.
    if (!formats.includes("code_128")) return null;
    const detector = new Native({ formats });
    return {
      backend: "native",
      detect: async (frame) => {
        const [hit] = await detector.detect(frame);
        return hit ? { value: hit.rawValue, format: hit.format } : null;
      },
    };
  } catch {
    return null;
  }
}

async function createWasm(): Promise<ScanDetector> {
  // Loaded on demand so the WebAssembly (about 1 MB) only downloads when someone opens the camera.
  const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
  // Serve the binary from our own origin: no CDN, works offline on a plant network.
  await prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  const detector = new BarcodeDetector({ formats: [...SCAN_FORMATS] });
  return {
    backend: "wasm",
    detect: async (frame) => {
      const [hit] = await detector.detect(frame);
      return hit ? { value: hit.rawValue, format: hit.format } : null;
    },
  };
}

let cached: Promise<ScanDetector> | null = null;

/** One detector per page. A failed load is not cached, so reopening the camera retries. */
export function loadDetector(): Promise<ScanDetector> {
  cached ??= (async () => (await createNative()) ?? (await createWasm()))().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}
