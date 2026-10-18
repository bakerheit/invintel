import type { Item, Location, PostedDocument } from "@invintel/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AddItemLink } from "@/components/floor/add-item-link";
import { ItemSummary } from "@/components/floor/item-summary";
import { LocationPicker } from "@/components/floor/location-picker";
import { QtyStepper } from "@/components/floor/qty-stepper";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { resolveItem, resolveLocation } from "@/lib/floor";
import { invalidateOrg, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

type Step = "item" | "details" | "destination" | "done";

/** Move: scan the item, say how many and from where, scan where it's going. */
export default function MovePage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { data: locations = [] } = useLocations(orgId);

  const [step, setStep] = useState<Step>("item");
  const [item, setItem] = useState<Item | null>(null);
  const [from, setFrom] = useState("");
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<{ doc: PostedDocument; to: Location; from: Location; qty: number } | null>(null);

  const nameOf = (id: string) => locations.find((l) => l.id === id)?.path ?? "Unknown";
  const available = item?.stock.find((s) => s.locationId === from)?.quantity ?? 0;

  const reset = () => {
    setStep("item");
    setUnknown(null);
    setItem(null);
    setFrom("");
    setQty(1);
    setError(null);
    setDone(null);
  };

  const onItem = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await resolveItem(orgId, code);
      setUnknown(r.ok ? null : (r.unknownCode ?? null));
      if (!r.ok) {
        feedback("error");
        setError(r.error);
        return;
      }
      setItem(r.value);
      const only = r.value.stock.length === 1 ? r.value.stock[0]! : undefined;
      setFrom(only?.locationId ?? "");
      setQty(1);
      setStep("details");
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Arriving from Look up with an item already chosen.
  const prefilled = useRef(false);
  useEffect(() => {
    const code = params.get("code");
    if (code && !prefilled.current) {
      prefilled.current = true;
      void onItem(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (to: Location) => {
    if (!item) return;
    if (to.id === from) {
      feedback("error");
      setError("That's where it already is. Scan a different place.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const doc = await api.move(orgId, { itemId: item.id, fromLocationId: from, toLocationId: to.id, quantity: qty });
      feedback("ok");
      setDone({ doc, to, from: locations.find((l) => l.id === from)!, qty });
      setStep("done");
      void invalidateOrg(qc, orgId);
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDestination = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await resolveLocation(orgId, code);
      if (!r.ok) {
        feedback("error");
        setError(r.error);
        setBusy(false);
        return;
      }
      setBusy(false);
      await post(r.value);
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!done) return;
    setBusy(true);
    try {
      await api.reverseMovement(orgId, done.doc.movementIds[0]!, {});
      void invalidateOrg(qc, orgId);
      toast.success("Move undone");
      reset();
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Move</h1>

      {step === "item" && <ScanInput label="Scan the item" onScan={onItem} disabled={busy} error={error} errorAction={unknown ? <AddItemLink orgId={orgId} code={unknown} /> : undefined} />}

      {step === "details" && item && (
        <div className="space-y-6">
          <ItemSummary item={item} locations={locations} />
          {item.stock.length === 0 ? (
            <p className="rounded-xl bg-warning-soft p-4 text-base font-medium text-warning">
              There's no stock of this item to move. Receive it first.
            </p>
          ) : (
            <>
              {item.stock.length > 1 && (
                <div className="space-y-2">
                  <p className="text-base font-medium">Take from</p>
                  <div className="grid gap-2">
                    {item.stock.map((s) => (
                      <button
                        key={s.locationId}
                        type="button"
                        onClick={() => {
                          setFrom(s.locationId);
                          setQty((q) => Math.min(q, s.quantity));
                        }}
                        aria-pressed={from === s.locationId}
                        className={cn(
                          "flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 text-left",
                          from === s.locationId ? "border-primary bg-accent/60 ring-2 ring-primary" : "hover:bg-muted",
                        )}
                      >
                        <span className="text-lg font-medium">{nameOf(s.locationId)}</span>
                        <span className="text-xl font-semibold tabular-nums">{s.quantity.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {from && <QtyStepper value={qty} onChange={setQty} max={available} label={`How many? (${available.toLocaleString()} at ${nameOf(from)})`} />}
              <div className="grid gap-2">
                <Button className="h-16 text-xl" disabled={!from || qty < 1} onClick={() => { setError(null); setStep("destination"); }}>
                  Next: where to?
                </Button>
              </div>
            </>
          )}
          <Button variant="ghost" className="h-12 w-full text-base" onClick={reset}>
            Scan a different item
          </Button>
        </div>
      )}

      {step === "destination" && item && (
        <div className="space-y-6">
          <div className="rounded-xl border bg-card p-4 text-lg">
            <span className="font-semibold">{qty.toLocaleString()} × {item.name}</span>
            <span className="block text-sm text-muted-foreground">from {nameOf(from)}</span>
          </div>
          <ScanInput label="Scan the destination" placeholder="Scan location" onScan={onDestination} disabled={busy} error={error} />
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
            <ListChecks /> Pick from a list
          </Button>
          <Button variant="ghost" className="h-12 w-full text-base" onClick={() => { setError(null); setStep("details"); }}>
            Back
          </Button>
          <LocationPicker
            open={picking}
            onOpenChange={setPicking}
            locations={locations.filter((l) => l.id !== from)}
            title="Move to"
            onPick={(l) => {
              setPicking(false);
              void post(l);
            }}
          />
        </div>
      )}

      {step === "done" && done && item && (
        <ResultPanel title={`Moved ${done.qty.toLocaleString()} × ${item.name}`} detail={`${done.from.path} → ${done.to.path}`}>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>}
          <Button className="h-16 w-full text-xl" onClick={reset}>Move another</Button>
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => void undo()} disabled={busy}>
            <Undo2 /> Undo this move
          </Button>
        </ResultPanel>
      )}
    </>
  );
}
