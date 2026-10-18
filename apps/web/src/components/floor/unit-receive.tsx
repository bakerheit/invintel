import type { Item, Location, UnitsPosted } from "@invintel/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, Printer } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { InspectToggle } from "@/components/floor/inspect-toggle";
import { ItemSummary } from "@/components/floor/item-summary";
import { LocationPicker } from "@/components/floor/location-picker";
import { QtyStepper } from "@/components/floor/qty-stepper";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { resolveLocation } from "@/lib/floor";
import { invalidateOrg, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

/** Receiving rolls or pallets: each one becomes its own labelled unit with its own remaining quantity. */
export function UnitReceive({ item, onReset }: { item: Item; onReset: () => void }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const [step, setStep] = useState<"details" | "destination" | "done">("details");
  const [each, setEach] = useState(1);
  const [count, setCount] = useState(1);
  const [lot, setLot] = useState("");
  const [reference, setReference] = useState("");
  const [inspect, setInspect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<{ posted: UnitsPosted; to: Location } | null>(null);

  const post = async (to: Location) => {
    setBusy(true);
    setError(null);
    try {
      const posted = await api.receiveUnits(orgId, { itemId: item.id, locationId: to.id, quantity: each, count, lot: lot.trim(), reference: reference.trim(), inspect });
      feedback("ok");
      setDone({ posted, to });
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

  if (step === "done" && done) {
    const { units } = done.posted;
    return (
      <ResultPanel title={`Received ${units.length} × ${item.name}`} detail={`${each.toLocaleString()} each, into ${done.to.path}`}>
        <ul className="divide-y rounded-xl border bg-card">
          {units.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-4 py-3">
              <span className="font-mono text-lg font-semibold">{u.code}</span>
              <span className="text-muted-foreground tabular-nums">{u.quantity.toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <Link
          to={`/o/${orgId}/labels?units=${units.map((u) => u.id).join(",")}`}
          className={cn(buttonVariants({ variant: "outline" }), "h-14 w-full text-base")}
        >
          <Printer /> Print these labels
        </Link>
        <Button className="h-16 w-full text-xl" onClick={onReset}>Receive another</Button>
      </ResultPanel>
    );
  }

  if (step === "destination") {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border bg-card p-4 text-lg">
          <span className="font-semibold">{count.toLocaleString()} × {each.toLocaleString()} {item.name}</span>
          {(lot || reference) && <span className="block text-sm text-muted-foreground">{[lot && `Lot ${lot}`, reference].filter(Boolean).join(" · ")}</span>}
        </div>
        <ScanInput label="Scan where they're going" placeholder="Scan location" onScan={onDestination} disabled={busy} error={error} />
        <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
          <ListChecks /> Pick from a list
        </Button>
        <Button variant="ghost" className="h-12 w-full text-base" onClick={() => { setError(null); setStep("details"); }}>
          Back
        </Button>
        <LocationPicker open={picking} onOpenChange={setPicking} locations={locations} title="Put them in" onPick={(l) => { setPicking(false); void post(l); }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ItemSummary item={item} locations={locations} />
      <p className="rounded-xl bg-accent/50 p-3 text-sm">
        This item is tracked by roll or pallet. Each one gets its own label, so it can be found, moved and used up on its own.
      </p>
      <QtyStepper value={each} onChange={setEach} label="Quantity in each (e.g. kg on a roll)" />
      <QtyStepper value={count} onChange={(n) => setCount(Math.min(200, n))} label="How many rolls or pallets?" />
      <div className="space-y-2">
        <label htmlFor="unit-lot" className="text-base font-medium">Lot or batch (optional)</label>
        <Input id="unit-lot" className="h-14 text-lg" value={lot} onChange={(e) => setLot(e.target.value)} maxLength={64} />
      </div>
      <div className="space-y-2">
        <label htmlFor="unit-ref" className="text-base font-medium">PO or delivery note (optional)</label>
        <Input id="unit-ref" className="h-14 text-lg" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
      </div>
      <InspectToggle value={inspect} onChange={setInspect} />
      <Button className="h-16 w-full text-xl" onClick={() => setStep("destination")}>Next: where to?</Button>
      <Button variant="ghost" className="h-12 w-full text-base" onClick={onReset}>Scan a different item</Button>
    </div>
  );
}
