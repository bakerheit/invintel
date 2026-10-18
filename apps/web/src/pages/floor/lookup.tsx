import type { LookupResult, StockUnit } from "@invintel/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, PackagePlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router";
import { AddItemLink } from "@/components/floor/add-item-link";
import { ItemSummary } from "@/components/floor/item-summary";
import { UnitCard } from "@/components/floor/unit-move";
import { QtyStepper } from "@/components/floor/qty-stepper";
import { ScanInput } from "@/components/floor/scan-input";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { LOCATION_TYPE_META, withDescendants } from "@/lib/locations";
import { invalidateOrg, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

/** Look up: scan anything and see what it is and where the stock is. Read-only. */
export default function LookupPage() {
  const { id: orgId } = useCurrentOrg();
  const { data: locations = [] } = useLocations(orgId);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);

  const items = useQuery({
    queryKey: orgKey(orgId, "items"),
    queryFn: () => api.listItems(orgId),
    enabled: result?.kind === "location",
  });

  const onScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.lookup(orgId, code);
      setUnknown(r.kind === "none" ? code : null);
      if (r.kind === "none") {
        feedback("error");
        setError(`Nothing matches "${code}"`);
        return;
      }
      feedback("ok");
      setResult(r);
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    setResult(null);
    setError(null);
  };

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Look up</h1>

      {!result && (
        <ScanInput
          label="Scan an item or a location"
          onScan={onScan}
          disabled={busy}
          error={error}
          errorAction={unknown ? <AddItemLink orgId={orgId} code={unknown} /> : undefined}
        />
      )}

      {result?.kind === "item" && (
        <div className="space-y-4">
          <ItemSummary item={result.item} locations={locations} />
          <div className="grid grid-cols-2 gap-2">
            <Link to={`/o/${orgId}/floor/receive?code=${encodeURIComponent(result.item.sku)}`} className={cn(buttonVariants({ variant: "outline" }), "h-16 text-lg")}>
              <PackagePlus /> Receive
            </Link>
            <Link to={`/o/${orgId}/floor/move?code=${encodeURIComponent(result.item.sku)}`} className={cn(buttonVariants({ variant: "outline" }), "h-16 text-lg")}>
              <ArrowLeftRight /> Move
            </Link>
          </div>
          <Button className="h-16 w-full text-xl" onClick={again}>Scan another</Button>
        </div>
      )}

      {result?.kind === "unit" && (
        <UnitLookup unit={result.unit} onChange={(u) => setResult({ kind: "unit", unit: u })} onAgain={again} />
      )}

      {result?.kind === "location" && (
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-xl font-semibold">{result.location.path}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className={LOCATION_TYPE_META[result.location.type].className}>
                {LOCATION_TYPE_META[result.location.type].label}
              </Badge>
              {result.location.code && <span className="font-mono text-sm text-muted-foreground">{result.location.code}</span>}
            </div>
          </div>
          <LocationContents locationId={result.location.id} ids={withDescendants(locations, result.location.id)} items={items.data} loading={items.isLoading} />
          <Button className="h-16 w-full text-xl" onClick={again}>Scan another</Button>
        </div>
      )}
    </>
  );
}

function LocationContents({ locationId, ids, items, loading }: {
  locationId: string;
  ids: string[];
  items?: import("@invintel/shared").Item[];
  loading: boolean;
}) {
  if (loading) return <p className="text-muted-foreground">Loading…</p>;
  const idSet = new Set(ids);
  const rows = (items ?? [])
    .map((i) => ({
      item: i,
      here: i.stock.filter((s) => s.locationId === locationId).reduce((n, s) => n + s.quantity, 0),
      inside: i.stock.filter((s) => s.locationId !== locationId && idSet.has(s.locationId)).reduce((n, s) => n + s.quantity, 0),
    }))
    .filter((r) => r.here + r.inside > 0);
  if (!rows.length) return <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">Nothing stored here.</p>;
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {rows.map(({ item, here, inside }) => (
        <li key={item.id} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3">
          <span className="min-w-0">
            <span className="block truncate text-lg font-medium">{item.name}</span>
            <span className="block font-mono text-xs text-muted-foreground">{item.sku}</span>
          </span>
          <span className="text-right">
            <span className="block text-xl font-semibold tabular-nums">{(here + inside).toLocaleString()}</span>
            {inside > 0 && <span className="block text-xs text-muted-foreground">{here.toLocaleString()} here</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A scanned roll or pallet: what it is, where it is, and a quick way to record using some of it. */
function UnitLookup({ unit, onChange, onAgain }: { unit: StockUnit; onChange: (u: StockUnit) => void; onAgain: () => void }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [take, setTake] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const record = async () => {
    setBusy(true);
    setError(null);
    try {
      const { units } = await api.adjustUnit(orgId, unit.id, { delta: -take, reason: "Used" });
      feedback("ok");
      toast.success(`Took ${take.toLocaleString()} from ${unit.code}`);
      onChange(units[0]!);
      setTake(1);
      void invalidateOrg(qc, orgId);
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usable = unit.status !== "consumed";
  return (
    <div className="space-y-4">
      <UnitCard unit={unit} />
      {usable && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <QtyStepper value={take} onChange={setTake} max={unit.quantity} label="Used some of it?" />
          <Button className="h-14 w-full text-lg" onClick={() => void record()} disabled={busy}>Take {take.toLocaleString()} from this one</Button>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2">
        {usable && (
          <Link to={`/o/${orgId}/floor/move?code=${encodeURIComponent(unit.code)}`} className={cn(buttonVariants({ variant: "outline" }), "h-16 text-lg")}>
            <ArrowLeftRight /> Move this one
          </Link>
        )}
        <Button className="h-16 w-full text-xl" onClick={onAgain}>Scan another</Button>
      </div>
    </div>
  );
}
