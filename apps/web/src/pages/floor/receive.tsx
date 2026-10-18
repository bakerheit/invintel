import { formatQty, uomOf, type Item, type Location, type PostedDocument } from "@invintel/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AddItemLink } from "@/components/floor/add-item-link";
import { ItemSummary } from "@/components/floor/item-summary";
import { InspectToggle } from "@/components/floor/inspect-toggle";
import { UnitReceive } from "@/components/floor/unit-receive";
import { LocationPicker } from "@/components/floor/location-picker";
import { QtyStepper } from "@/components/floor/qty-stepper";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { resolveItem, resolveLocation } from "@/lib/floor";
import { invalidateOrg, useCurrentOrg, useLocations } from "@/lib/org";

type Step = "item" | "details" | "destination" | "done";

/** Receive: scan the item, how many came in, scan where it's going. */
export default function ReceivePage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { data: locations = [] } = useLocations(orgId);

  const [step, setStep] = useState<Step>("item");
  const [item, setItem] = useState<Item | null>(null);
  const [qty, setQty] = useState(1);
  const [reference, setReference] = useState("");
  const [supplierLot, setSupplierLot] = useState("");
  const [inspect, setInspect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<{ doc: PostedDocument; to: Location; qty: number } | null>(null);

  // Where this item usually lives: the location holding the most of it.
  const usual = item?.stock.length
    ? locations.find((l) => l.id === [...item.stock].sort((a, b) => b.quantity - a.quantity)[0]!.locationId)
    : undefined;

  const reset = () => {
    setStep("item");
    setUnknown(null);
    setItem(null);
    setQty(1);
    setReference("");
    setSupplierLot("");
    setInspect(false);
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
      setQty(10 ** uomOf(r.value).decimals);
      setStep("details");
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
    setBusy(true);
    setError(null);
    try {
      const doc = await api.receive(orgId, { itemId: item.id, locationId: to.id, quantity: qty, reference: reference.trim(), supplierLot: supplierLot.trim(), inspect });
      feedback("ok");
      setDone({ doc, to, qty });
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
      toast.success("Receipt undone");
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
      <h1 className="text-3xl font-semibold tracking-tight">Receive</h1>

      {step === "item" && <ScanInput label="Scan what arrived" onScan={onItem} disabled={busy} error={error} errorAction={unknown ? <AddItemLink orgId={orgId} code={unknown} /> : undefined} />}

      {step === "details" && item && item.tracking === "unit" && <UnitReceive item={item} onReset={reset} />}
      {step === "details" && item && item.tracking !== "unit" && (
        <div className="space-y-6">
          <ItemSummary item={item} locations={locations} />
          <QtyStepper value={qty} onChange={setQty} uom={item} label={`How many arrived?${uomOf(item).unit === "ea" ? "" : ` (${uomOf(item).unit})`}`} />
          <div className="space-y-2">
            <label htmlFor="floor-ref" className="text-base font-medium">PO or delivery note (optional)</label>
            <Input id="floor-ref" className="h-14 text-lg" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
          </div>
          <div className="space-y-2">
            <label htmlFor="floor-lot" className="text-base font-medium">Supplier lot (optional)</label>
            <Input id="floor-lot" className="h-14 text-lg" value={supplierLot} onChange={(e) => setSupplierLot(e.target.value)} maxLength={64} />
          </div>
          <InspectToggle value={inspect} onChange={setInspect} />
          <Button className="h-16 w-full text-xl" disabled={qty < 1} onClick={() => { setError(null); setStep("destination"); }}>
            Next: where to?
          </Button>
          <Button variant="ghost" className="h-12 w-full text-base" onClick={reset}>
            Scan a different item
          </Button>
        </div>
      )}

      {step === "destination" && item && (
        <div className="space-y-6">
          <div className="rounded-xl border bg-card p-4 text-lg">
            <span className="font-semibold">{formatQty(qty, item)} × {item.name}</span>
            {reference && <span className="block text-sm text-muted-foreground">{reference}</span>}
          </div>
          {usual && (
            <Button className="h-16 w-full text-xl" onClick={() => void post(usual)} disabled={busy}>
              Put in {usual.path}
            </Button>
          )}
          <ScanInput label={usual ? "Or scan another location" : "Scan where it's going"} placeholder="Scan location" onScan={onDestination} disabled={busy} error={error} />
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
            <ListChecks /> Pick from a list
          </Button>
          <Button variant="ghost" className="h-12 w-full text-base" onClick={() => { setError(null); setStep("details"); }}>
            Back
          </Button>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={locations} title="Put it in" onPick={(l) => { setPicking(false); void post(l); }} />
        </div>
      )}

      {step === "done" && done && item && (
        <ResultPanel title={`Received ${formatQty(done.qty, item)} × ${item.name}`} detail={done.doc.ncrs?.length ? `On quality hold as ${done.doc.ncrs[0]!.number}. Decide it under Quality.` : `Into ${done.to.path}`}>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>}
          <Button className="h-16 w-full text-xl" onClick={reset}>Receive another</Button>
          {!done.doc.ncrs?.length && (
            <Button variant="outline" className="h-14 w-full text-base" onClick={() => void undo()} disabled={busy}>
              <Undo2 /> Undo this receipt
            </Button>
          )}
        </ResultPanel>
      )}
    </>
  );
}
