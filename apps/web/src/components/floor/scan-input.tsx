import { Camera, Keyboard } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CameraScanner } from "@/components/floor/camera-scanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";

/**
 * A scanner types the code and presses Enter, so this is just a big text field that stays focused.
 * The on-screen keyboard is off by default so it doesn't cover the screen on a handheld; the
 * keyboard button turns it on for typing a code by hand.
 */
export function ScanInput({ label, placeholder = "Scan or type", onScan, disabled, error, errorAction }: {
  label: string;
  placeholder?: string;
  onScan: (code: string) => void;
  disabled?: boolean;
  error?: string | null;
  /** Shown under the error, e.g. a way out of "nothing matches". */
  errorAction?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  // Take focus whenever the prompt changes or work finishes, so the next scan lands here.
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [label, disabled]);

  // If focus is lost to nowhere (a tap on empty space), take it back. Don't steal it from other fields.
  const refocus = () =>
    setTimeout(() => {
      const active = document.activeElement;
      if (!disabled && (!active || active === document.body)) ref.current?.focus();
    }, 60);

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const value = ref.current?.value.trim() ?? "";
        if (!value) return;
        if (ref.current) ref.current.value = "";
        feedback("scan");
        onScan(value);
      }}
    >
      <label htmlFor="floor-scan" className="text-base font-medium">{label}</label>
      <div className="flex gap-2">
        <Input
          id="floor-scan"
          ref={ref}
          autoFocus
          disabled={disabled}
          placeholder={placeholder}
          inputMode={typing ? "text" : "none"}
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onBlur={refocus}
          aria-invalid={!!error}
          className={cn("h-16 flex-1 text-2xl font-mono", error && "border-destructive")}
        />
        <Button
          type="button"
          variant="outline"
          aria-label="Scan with the camera"
          className="h-16 w-16"
          disabled={disabled}
          onClick={() => setCameraOpen(true)}
        >
          <Camera className="size-6" />
        </Button>
        <Button
          type="button"
          variant={typing ? "default" : "outline"}
          aria-pressed={typing}
          aria-label="Use on-screen keyboard"
          className="h-16 w-16"
          onClick={() => {
            setTyping((t) => !t);
            ref.current?.focus();
          }}
        >
          <Keyboard className="size-6" />
        </Button>
      </div>
      <CameraScanner
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onScan={(code) => {
          feedback("scan");
          onScan(code);
        }}
      />
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">
          {error}
        </p>
      )}
      {error && errorAction}
    </form>
  );
}
