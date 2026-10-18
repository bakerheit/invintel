import { formatQty, type Item, type Location, type StockUnit } from "@invintel/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, Package } from "lucide-react";
import { useState } from "react";
import { LocationPicker } from "@/components/floor/location-picker";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { resolveLocation } from "@/lib/floor";
import { invalidateOrg, orgKey, useCurrentOrg, useLocations } from "@/lib/org";

export function UnitCard({ unit }: { unit: StockUnit }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Package className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-2xl font-semibold">{unit.code}</p>
        <p className="truncate text-base font-medium">{unit.itemName}</p>
        <p className="text-sm text-muted-foreground">
          {formatQty(unit.quantity, unit.uom)} left{unit.quantity !== unit.initialQuantity ? ` of ${formatQty(unit.initialQuantity, unit.uom, { unit: false })}` : ""}
          {unit.lot ? ` · Lot ${unit.lot}` : ""} · {unit.locationPath}
          {unit.status !== "available" ? ` · ${unit.status}` : ""}
        </p>
      </div>
    </div>
  );
}

/** Scanned an item that's tracked by roll or pallet: choose which one. */
export function UnitPick({ item, onPick, onBack }: { item: Item; onPick: (u: StockUnit) => void; onBack: () => void }) {
  const { id: orgId } = useCurrentOrg();
  const units = useQuery({
    queryKey: orgKey(orgId, "units", item.id, "available"),
    queryFn: () => api.listUnits(orgId, { itemId: item.id, status: "available", limit: 100 }),
  });
  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-accent/50 p-3 text-base">
        {item.name} is tracked by roll or pallet. Scan the label on the one you're moving, or tap it below.
      </p>
      {units.isLoading && <p className="text-muted-foreground">Loading…</p>}
      <ul className="space-y-2">
        {units.data?.units.map((u) => (
          <li key={u.id}>
            <button type="button" onClick={() => onPick(u)} className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border px-4 text-left hover:bg-muted active:bg-muted">
              <span>
                <span className="block font-mono text-lg font-semibold">{u.code}</span>
                <span className="block text-sm text-muted-foreground">{u.locationPath}{u.lot ? ` · Lot ${u.lot}` : ""}</span>
              </span>
              <span className="text-xl font-semibold tabular-nums">{formatQty(u.quantity, u.uom)}</span>
            </button>
          </li>
        ))}
        {units.data && !units.data.units.length && <li className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">None in stock. Receive some first.</li>}
      </ul>
      <Button variant="ghost" className="h-12 w-full text-base" onClick={onBack}>Scan something else</Button>
    </div>
  );
}

/** Move one roll or pallet, with whatever is left on it, to another location. */
export function UnitMove({ unit, onReset }: { unit: StockUnit; onReset: () => void }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<Location | null>(null);

  const post = async (to: Location) => {
    if (to.id === unit.locationId) {
      feedback("error");
      setError("It's already there. Scan a different place.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.moveUnit(orgId, unit.id, { toLocationId: to.id });
      feedback("ok");
      setDone(to);
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

  if (done) {
    return (
      <ResultPanel title={`Moved ${unit.code}`} detail={`${unit.locationPath} → ${done.path}`}>
        <Button className="h-16 w-full text-xl" onClick={onReset}>Move another</Button>
      </ResultPanel>
    );
  }
  return (
    <div className="space-y-6">
      <UnitCard unit={unit} />
      <ScanInput label="Scan the destination" placeholder="Scan location" onScan={onDestination} disabled={busy} error={error} />
      <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
        <ListChecks /> Pick from a list
      </Button>
      <Button variant="ghost" className="h-12 w-full text-base" onClick={onReset}>Scan something else</Button>
      <LocationPicker
        open={picking}
        onOpenChange={setPicking}
        locations={locations.filter((l) => l.id !== unit.locationId)}
        title="Move to"
        onPick={(l) => {
          setPicking(false);
          void post(l);
        }}
      />
    </div>
  );
}
