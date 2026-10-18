import { Camera, Plus, X } from "lucide-react";
import { useState } from "react";
import { CameraScanner } from "@/components/floor/camera-scanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { useCurrentOrg } from "@/lib/org";

const MAX = 20;

/**
 * The barcodes printed on a product. Add one by scanning (camera, or a hardware scanner typing
 * into the box) or by typing. Each new code is checked straight away so you hear about a
 * clash while you're holding the product, not after pressing Save.
 */
export function BarcodeField({ value, onChange, selfId, onAdded }: {
  value: string[];
  onChange: (codes: string[]) => void;
  /** The item being edited, so its own barcodes don't count as clashes. */
  selfId?: string;
  /** Called after a code is added. `first` is true when it's the item's first barcode. */
  onAdded?: (code: string, first: boolean) => void;
}) {
  const { id: orgId } = useCurrentOrg();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [camera, setCamera] = useState(false);

  const add = async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    setError(null);
    if (value.some((v) => v.toLowerCase() === code.toLowerCase())) {
      setDraft("");
      return;
    }
    if (value.length >= MAX) {
      setError(`An item can have up to ${MAX} barcodes`);
      return;
    }
    setChecking(true);
    try {
      const found = await api.lookup(orgId, code);
      if (found.kind === "item" && found.item.id !== selfId) {
        feedback("error");
        setError(`Already used by ${found.item.name} (${found.item.sku})`);
        return;
      }
      if (found.kind === "location") {
        feedback("error");
        setError("That's a location label, not a product barcode");
        return;
      }
    } catch {
      // Couldn't check (offline, say). The server checks again on save.
    } finally {
      setChecking(false);
    }
    onChange([...value, code]);
    setDraft("");
    onAdded?.(code, value.length === 0);
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor="barcode-draft">Barcodes</Label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Barcodes on this item">
          {value.map((code) => (
            <li key={code}>
              <Badge variant="secondary" className="h-7 gap-1 pr-1 font-mono text-sm">
                {code}
                <button
                  type="button"
                  aria-label={`Remove barcode ${code}`}
                  onClick={() => onChange(value.filter((v) => v !== code))}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                >
                  <X className="size-3.5" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id="barcode-draft"
          value={draft}
          placeholder="Scan or type a barcode"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!error}
          className="flex-1 font-mono"
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // A scanner types the code and presses Enter. That must add it, not submit the item form.
            if (e.key === "Enter") {
              e.preventDefault();
              void add(draft);
            }
          }}
        />
        <Button type="button" variant="outline" size="icon" aria-label="Scan a barcode with the camera" onClick={() => setCamera(true)}>
          <Camera />
        </Button>
        <Button type="button" variant="outline" disabled={!draft.trim() || checking} onClick={() => void add(draft)}>
          <Plus /> Add
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The code printed on the product or box. Add more than one if it comes in different packs.
        </p>
      )}
      <CameraScanner
        open={camera}
        onOpenChange={setCamera}
        onScan={(code) => {
          feedback("scan");
          void add(code);
        }}
      />
    </div>
  );
}
