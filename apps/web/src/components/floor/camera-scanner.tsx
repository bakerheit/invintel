import { Flashlight, FlashlightOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { loadDetector } from "@/lib/scanner";

/** Frames are scaled down to this width before decoding. Smaller is faster; barcodes survive it. */
const MAX_FRAME_WIDTH = 960;
const SCAN_INTERVAL_MS = 100;

class CameraProblem extends Error {}

function explain(error: unknown): string {
  if (error instanceof CameraProblem) return error.message;
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access is blocked. Allow it for this site in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy. Close other apps using it and try again.";
  return "Couldn't start the scanner. You can still type or use a hardware scanner.";
}

async function openCamera(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraProblem("Cameras only work on secure (https) pages. Open Invintel over https, or use a hardware scanner.");
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraProblem("This browser can't use the camera.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    // Some devices reject the constraints outright; any camera will do.
    if ((e as { name?: string }).name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw e;
  }
}

/** In continuous mode the same code isn't reported again for this long, so a label held in view counts once. */
const REPEAT_MS = 2500;

function Viewfinder({ onFound, onClose, continuous }: { onFound: (code: string) => void; onClose: () => void; continuous?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [last, setLast] = useState<{ code: string; count: number } | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let stream: MediaStream | null = null;
    let lastHit = { value: "", at: 0 };
    let count = 0;

    (async () => {
      try {
        // Start the camera and load the decoder at the same time.
        const [cam, detector] = await Promise.all([openCamera(), loadDetector()]);
        if (stopped) {
          cam.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = cam;
        const el = video.current!;
        el.srcObject = cam;
        await el.play();

        const videoTrack = cam.getVideoTracks()[0] ?? null;
        track.current = videoTrack;
        const caps = videoTrack?.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorchAvailable(!!caps?.torch);
        setStatus("scanning");

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const tick = async () => {
          if (stopped) return;
          if (el.readyState >= 2 && el.videoWidth) {
            const scale = Math.min(1, MAX_FRAME_WIDTH / el.videoWidth);
            canvas.width = Math.round(el.videoWidth * scale);
            canvas.height = Math.round(el.videoHeight * scale);
            ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
            const hit = await detector.detect(ctx.getImageData(0, 0, canvas.width, canvas.height)).catch(() => null);
            if (hit && !stopped) {
              if (!continuous) {
                stopped = true;
                onFound(hit.value);
                return;
              }
              const now = Date.now();
              if (hit.value !== lastHit.value || now - lastHit.at > REPEAT_MS) {
                onFound(hit.value);
                setLast({ code: hit.value, count: ++count });
              }
              lastHit = { value: hit.value, at: now };
            }
          }
          timer = window.setTimeout(tick, SCAN_INTERVAL_MS);
        };
        void tick();
      } catch (e) {
        if (!stopped) {
          setError(explain(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      track.current = null;
    };
    // onFound is stable enough for one scan session; restarting the camera on every render would be worse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = async () => {
    const next = !torchOn;
    try {
      await track.current?.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  };

  return (
    <>
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-black sm:aspect-video">
        <video ref={video} playsInline muted className="absolute inset-0 size-full object-cover" />
        {status === "scanning" && (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-[34%] w-[82%] rounded-2xl border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]">
                <div className="absolute inset-x-3 top-0 h-0.5 animate-[scan_1.8s_ease-in-out_infinite] rounded bg-primary shadow-[0_0_8px_var(--primary)] motion-reduce:animate-none" />
              </div>
            </div>
            <p className="absolute inset-x-0 bottom-4 px-3 text-center text-base font-medium text-white drop-shadow">
              {last ? <>Scanned {last.count}: <span className="font-mono">{last.code.length > 28 ? `${last.code.slice(0, 28)}…` : last.code}</span></> : "Point at a barcode"}
            </p>
          </>
        )}
        {status === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
            <LoaderCircle className="size-8 animate-spin" />
            <p>Starting camera…</p>
          </div>
        )}
        {status === "error" && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <TriangleAlert className="size-10 text-destructive" />
            <p className="max-w-xs text-base">{error}</p>
          </div>
        )}
      </div>
      <div className="flex gap-2 p-3">
        {torchAvailable && (
          <Button type="button" variant="outline" className="h-14 flex-1 text-base" aria-pressed={torchOn} onClick={() => void toggleTorch()}>
            {torchOn ? <FlashlightOff /> : <Flashlight />} Light
          </Button>
        )}
        <Button type="button" variant={status === "error" ? "default" : "outline"} className="h-14 flex-1 text-base" onClick={onClose}>
          {status === "error" ? "Close" : continuous ? "Done" : "Cancel"}
        </Button>
      </div>
    </>
  );
}

/** Full-screen-ish camera view that reads one barcode, then closes. With `continuous` it stays open and reports each new code until Done. */
export function CameraScanner({ open, onOpenChange, onScan, continuous }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (code: string) => void;
  continuous?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Scan with the camera</DialogTitle>
        <DialogDescription className="sr-only">Point the camera at a barcode or QR code.</DialogDescription>
        {open && (
          <Viewfinder
            continuous={continuous}
            onClose={() => onOpenChange(false)}
            onFound={(code) => {
              if (!continuous) onOpenChange(false);
              onScan(code);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
