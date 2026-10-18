import type { Item, Ncr, StockUnit } from "@invintel/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QtyStepper } from "@/components/floor/qty-stepper";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { invalidateOrg, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

type Target = { kind: "unit"; unit: StockUnit } | { kind: "item"; item: Item };

/** Quality hold: scan a roll or pallet label (or an item and say where and how many), pick why, done. */
export default function QualityFloorPage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const reasons = useQuery({ queryKey: orgKey(orgId, "reasons"), queryFn: () => api.reasons(orgId) });
  const [target, setTarget] = useState<Target | null>(null);
  const [placeId, setPlaceId] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Ncr | null>(null);

  const reset = () => {
    setTarget(null);
    setPlaceId("");
    setQty(1);
    setReason("");
    setError(null);
    setDone(null);
  };
  const pathOf = (id: string) => locations.find((l) => l.id === id)?.path ?? "";

  const onScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.lookup(orgId, code);
      if (r.kind === "unit") {
        if (r.unit.status !== "available") {
          feedback("error");
          setError(`${r.unit.code} is ${r.unit.status === "consumed" ? "used up" : "already on hold"}.`);
        } else {
          feedback("ok");
          setTarget({ kind: "unit", unit: r.unit });
        }
      } else if (r.kind === "item") {
        if (r.item.tracking === "unit") {
          feedback("error");
          setError("This item is tracked by roll or pallet. Scan the label on the roll or pallet itself.");
        } else {
          const holdable = r.item.stock.filter((s) => s.quantity > 0 && locations.find((l) => l.id === s.locationId)?.type !== "quarantine");
          if (!holdable.length) {
            feedback("error");
            setError(`There's no stock of ${r.item.name} to hold.`);
          } else {
            feedback("ok");
            setTarget({ kind: "item", item: r.item });
            if (holdable.length === 1) setPlaceId(holdable[0]!.locationId);
          }
        }
      } else {
        feedback("error");
        setError(r.kind === "none" ? `Nothing matches "${code}".` : "Scan a roll or pallet label, or an item.");
      }
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!target || !reason) return;
    setBusy(true);
    setError(null);
    try {
      const ncr = await api.putOnHold(
        orgId,
        target.kind === "unit" ? { unitId: target.unit.id, reason } : { itemId: target.item.id, locationId: placeId, quantity: qty, reason },
      );
      feedback("ok");
      setDone(ncr);
      void invalidateOrg(qc, orgId);
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const errorBox = error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>;
  const stockHere = target?.kind === "item" ? (target.item.stock.find((s) => s.locationId === placeId)?.quantity ?? 0) : 0;

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Quality hold</h1>

      {done ? (
        <ResultPanel title={`${done.number} on hold`} detail={`${done.unitCode ?? `${done.quantity.toLocaleString()} × ${done.itemName}`}: ${done.reason}. An admin decides what happens next.`}>
          <Button className="h-16 w-full text-xl" onClick={reset}>Hold another</Button>
        </ResultPanel>
      ) : !target ? (
        <ScanInput label="Scan the roll or pallet label, or the item" onScan={onScan} disabled={busy} error={error} />
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border bg-card p-4">
            {target.kind === "unit" ? (
              <>
                <p className="text-xl font-semibold">{target.unit.code}</p>
                <p className="text-base">{target.unit.itemName}{target.unit.lot ? ` · lot ${target.unit.lot}` : ""}</p>
                <p className="text-sm text-muted-foreground">{target.unit.quantity.toLocaleString()} · at {target.unit.locationPath}</p>
              </>
            ) : (
              <>
                <p className="text-xl font-semibold">{target.item.name}</p>
                <p className="text-sm text-muted-foreground">{target.item.sku}</p>
              </>
            )}
            <Button type="button" variant="ghost" className="mt-2 h-11" onClick={reset}>Scan something else</Button>
          </div>

          {target.kind === "item" && (
            <>
              <div className="space-y-2">
                <p className="text-base font-medium">Which stock?</p>
                <div className="grid gap-2">
                  {target.item.stock.filter((s) => s.quantity > 0 && locations.find((l) => l.id === s.locationId)?.type !== "quarantine").map((s) => (
                    <button key={s.locationId} type="button" aria-pressed={placeId === s.locationId} onClick={() => { setPlaceId(s.locationId); setQty((q) => Math.min(q, s.quantity)); }}
                      className={cn("flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 text-left", placeId === s.locationId ? "border-primary bg-accent/60 ring-2 ring-primary" : "hover:bg-muted")}>
                      <span className="text-lg font-medium">{pathOf(s.locationId)}</span>
                      <span className="text-xl font-semibold tabular-nums">{s.quantity.toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              </div>
              {placeId && <QtyStepper value={qty} onChange={setQty} max={stockHere} label={`How many to hold? (${stockHere.toLocaleString()} there)`} />}
            </>
          )}

          <div className="space-y-2">
            <p className="text-base font-medium">Why?</p>
            <div className="grid grid-cols-2 gap-2">
              {(reasons.data?.hold ?? []).map((r) => (
                <button key={r} type="button" aria-pressed={reason === r} onClick={() => setReason(r)}
                  className={cn("min-h-16 rounded-xl border px-3 text-lg font-medium", reason === r ? "border-primary bg-accent/60 ring-2 ring-primary" : "hover:bg-muted")}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {errorBox}
          <Button className="h-16 w-full text-xl" disabled={busy || !reason || (target.kind === "item" && !placeId)} onClick={() => void submit()}>Put on hold</Button>
        </div>
      )}
    </>
  );
}
